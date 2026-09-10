#!/usr/bin/env node
/**
 * scripts/backfill-note-details.js
 *
 * Popula `note_details` retroativamente, buscando na EDP o payload das notas
 * que o cron nunca chegou a cachear.
 *
 * ── POR QUE ELE PRECISOU EXISTIR ────────────────────────────────────────────
 * 09/09/2026, primeiro print das regras novas da Medição HE (acordo 30 min e
 * deslocamento pra base): **364 de 403 linhas sem checkpoint** na última nota.
 * As duas regras leem `note_details.payload.checkpoints[]`, e o cron só cacheia
 * **30 notas por ciclo** (`MAX_CACHE_POR_CICLO`) e só as do payload AO VIVO —
 * nota de dia fechado que ficou pra trás não volta sozinha.
 *
 * O José pediu 01/08 em diante: "os outros dias vao ser preenchidos
 * automaticamente daqui pra frente".
 *
 * ── O QUE ELE NÃO FAZ ───────────────────────────────────────────────────────
 * Não reprocessa nota já cacheada. `filtrarNotesNaoCacheadas` corta antes de
 * qualquer chamada à EDP — rodar duas vezes seguidas custa quase nada e não
 * duplica nada (idempotência, `CLAUDE.md`).
 *
 * ⚠️ ESCREVE só com `--apply`. Sem a flag, ele CONTA e não chama a EDP.
 * ⚠️ O TRABALHO POR NOTA é o mesmo do cron — `services/noteDetailCacher.js`.
 *    Não copie o laço pra cá: foi essa duplicação que produziu o P1-47.
 *
 *   node scripts/backfill-note-details.js --de 2026-08-01
 *   node scripts/backfill-note-details.js --de 2026-08-01 --apply
 *   node scripts/backfill-note-details.js --de 2026-08-01 --todas --apply
 *
 * -- --recachear: O CASO QUE O BACKFILL COMUM NAO PEGA ----------------------
 * 10/09/2026. O backfill acima rodou, preencheu 289 notas -- e a lacuna das
 * regras quase nao se mexeu. Motivo: `registradoEm` (de `RegisteredAt2`) so
 * passou a ser gravado em **30/08/2026** (`services/notaProcessor.js`). Os
 * payloads cacheados ANTES disso estao no banco COM os checkpoints e SEM o
 * campo. A nota nao esta faltando: esta VELHA.
 *
 * `--recachear` seleciona exatamente essas -- tem checkpoint, nenhum com
 * `registradoEm`. E o oposto do modo normal (que so olha o que falta), e o
 * unico caminho deste script que SOBRESCREVE payload existente.
 *
 *   node scripts/backfill-note-details.js --de 2026-08-01 --recachear
 *   node scripts/backfill-note-details.js --de 2026-08-01 --recachear --apply
 */

'use strict';

require('dotenv').config();

const { _getPool } = require('../services/pgShim');
const { ultimaNotaDaSessao } = require('../db/heQueries');
const { dateBRT } = require('../services/timeUtil');

function arg(nome, padrao) {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}
const tem = nome => process.argv.includes(`--${nome}`);

const DE      = arg('de', '2026-08-01');
const ATE     = arg('ate', dateBRT());
const APPLY   = tem('apply');
const TODAS   = tem('todas');
const RECACHE = tem('recachear');
const LIMITE  = Number(arg('limite', '100000'));
const CONC    = Math.max(1, Number(arg('conc', '3')));
const PAUSA   = Math.max(0, Number(arg('pausa', '250')));

if (!/^\d{4}-\d{2}-\d{2}$/.test(DE) || !/^\d{4}-\d{2}-\d{2}$/.test(ATE)) {
  console.error('Datas em YYYY-MM-DD. Ex.: --de 2026-08-01 --ate 2026-09-08');
  process.exit(1);
}

/**
 * Candidatas do período: uma linha por (equipe, sessão), o snapshot mais
 * recente dela — o mesmo recorte que `db/heQueries.js` usa pra medir a HE.
 * É de propósito: o conjunto que este script preenche tem de ser exatamente o
 * que a tela precisa ler, senão sobra lacuna ou sobra chamada à EDP.
 */
async function candidatas(pool) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (team_name, session_begin)
            to_char(date, 'YYYY-MM-DD') AS dia,
            upper(btrim(team_name))     AS equipe,
            sector_id, data
       FROM public.snapshots
      WHERE date BETWEEN $1::date AND $2::date
        AND session_begin IS NOT NULL
      ORDER BY team_name, session_begin, captured_at DESC`,
    [DE, ATE]);

  const porId = new Map();          // id → { id, numero, tipo, sectorId, dia }
  const porDia = new Map();         // dia → Set(id)

  for (const r of rows) {
    const setor = r.sector_id || 'DESG';
    const anota = n => {
      if (!n || !n.id) return;
      if (!porId.has(n.id)) {
        porId.set(n.id, {
          id: n.id, numero: n.codigo || null,
          tipo: n.tipoCode || null, sectorId: setor, dia: r.dia,
        });
      }
      if (!porDia.has(r.dia)) porDia.set(r.dia, new Set());
      porDia.get(r.dia).add(n.id);
    };

    if (TODAS) {
      const p = r.data || {};
      [...(p.notasConcluidas || []), ...(p.notasRejeitadas || []),
       ...(p.notasExecutadas || [])].forEach(anota);
    } else {
      const u = ultimaNotaDaSessao(r.data);
      if (u) anota(u.nota);
    }
  }

  return { porId, porDia, sessoes: rows.length };
}

/**
 * Notas cujo payload e ANTERIOR ao `registradoEm` (30/08/2026): tem
 * checkpoint, e nenhum checkpoint traz o campo.
 *
 * O teste roda no Postgres, nao em JS, pra nao trazer milhares de payloads
 * completos pra memoria so pra descartar a maioria.
 */
async function payloadsVelhos(pool, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 500) {
    const { rows } = await pool.query(
      `SELECT note_id::text AS id
         FROM public.note_details
        WHERE note_id = ANY($1::uuid[])
          AND jsonb_typeof(payload->'checkpoints') = 'array'
          AND jsonb_array_length(payload->'checkpoints') > 0
          AND NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements(payload->'checkpoints') cp
                 WHERE cp->>'registradoEm' IS NOT NULL)`,
      [ids.slice(i, i + 500)]);
    out.push(...rows.map(r => r.id));
  }
  return out;
}

/** `.in()` tem limite prático — pergunta em blocos. */
async function faltando(ids) {
  const sq = require('../db/queries');
  const out = [];
  for (let i = 0; i < ids.length; i += 500) {
    out.push(...await sq.filtrarNotesNaoCacheadas(ids.slice(i, i + 500)));
  }
  return out;
}

(async () => {
  const pool = _getPool();
  console.log(`\n=== BACKFILL note_details — ${DE} a ${ATE} ===`);
  console.log(`Escopo: ${RECACHE ? 'RE-CACHE de payload velho' : (TODAS ? 'TODAS as notas da sessão' : 'só a ÚLTIMA nota de cada sessão')}`
    + `  |  ${APPLY ? 'APPLY (escreve)' : 'simulação (não chama a EDP)'}\n`);

  const { porId, porDia, sessoes } = await candidatas(pool);
  const todosIds = [...porId.keys()];
  console.log(`Sessões no período: ${sessoes}`);
  console.log(`Notas candidatas:   ${todosIds.length}`);
  if (!todosIds.length) { console.log('Nada a fazer.'); process.exit(0); }

  // No modo normal, "alvo" = o que falta. No --recachear, "alvo" = o que esta
  // la porem velho. Os dois conjuntos sao disjuntos de proposito: recachear
  // nao deve re-buscar o que ja veio certo.
  const alvo = new Set(RECACHE
    ? await payloadsVelhos(pool, todosIds)
    : await faltando(todosIds));
  if (RECACHE) {
    console.log(`Payload SEM registradoEm (anterior a 30/08): ${alvo.size}`);
  } else {
    console.log(`Ja em note_details: ${todosIds.length - alvo.size}`);
    console.log(`FALTANDO:           ${alvo.size}`);
  }
  console.log('');

  // Por dia — mostra se a lacuna é histórica (resolve com este script) ou de
  // hoje (é o cron correndo atrás, e aí não há o que corrigir).
  const dias = [...porDia.keys()].sort();
  console.log(`  dia          candidatas   ${RECACHE ? 'velhas  ' : 'faltando'}`);
  for (const d of dias) {
    const ids = [...porDia.get(d)];
    const f = ids.filter(i => alvo.has(i)).length;
    if (!f) continue;
    console.log(`  ${d}   ${String(ids.length).padStart(10)} ${String(f).padStart(10)}`
      + (d === dateBRT() ? '   ← HOJE, o cron ainda está pegando' : ''));
  }

  if (!alvo.size) {
    console.log(RECACHE
      ? '\nNenhum payload velho no periodo. As duas regras ja tem o que precisam.'
      : '\nCobertura completa. Nada a buscar.');
    process.exit(0);
  }

  if (!APPLY) {
    console.log(`\nSimulação — nenhuma chamada à EDP foi feita.`);
    console.log(`Pra preencher: acrescente --apply (${alvo.size} chamadas, `
      + `~${Math.ceil(alvo.size / CONC * 0.6 / 60)} min a conc=${CONC}).`);
    process.exit(0);
  }

  const lote = todosIds.filter(i => alvo.has(i)).slice(0, LIMITE).map(i => porId.get(i));
  const { cachearLote } = require('../services/noteDetailCacher');
  const t0 = Date.now();
  const r = await cachearLote(lote, {
    concorrencia: CONC,
    pausaMs: PAUSA,
    onProgresso: p => {
      if (p.feitos % 50 < CONC || p.feitos === p.total) {
        process.stdout.write(`\r  ${p.feitos}/${p.total}  ok=${p.ok} falha=${p.falha}   `);
      }
    },
  });

  const dt = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n\nGravadas ${r.ok} de ${lote.length} (falhas ${r.falha}) em ${dt}s.`);
  // Este número é o que separa "faltava coletar" de "o dado não existe": nota
  // gravada SEM checkpoint nenhum não vai preencher as colunas do acordo, e
  // nenhum backfill vai mudar isso.
  console.log(`Gravadas sem checkpoint algum: ${r.semCp}`
    + (r.semCp ? '  ← essas continuam sem avaliar a regra do acordo' : ''));
  if (r.erros.length) {
    console.log('\nPrimeiras falhas:');
    r.erros.forEach(e => console.log('  ' + e));
  }
  process.exit(0);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
