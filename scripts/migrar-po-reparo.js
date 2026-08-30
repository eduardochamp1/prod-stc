#!/usr/bin/env node
/**
 * scripts/migrar-po-reparo.js
 *
 * Fase 1 de docs/handoff/SPEC-tma-po-reparo-2026-08-30.md.
 *
 * Cria `note_po_reparo` e faz o backfill das notas PO já cacheadas: para cada
 * uma, busca o "Horário do Reparo" (`/api/notes/po`) e o checkpoint
 * "Finalizando Trabalho" (evento 4, `RegisteredAt2`), e grava o delta.
 *
 * ⚠️ SÃO 2 REQUESTS POR NOTA, e não dá pra economizar: o `RegisteredAt2` não
 * está no cache antigo. O `notaProcessor` passou a guardá-lo em 30/08/2026, mas
 * só para notas buscadas DEPOIS disso — as antigas guardaram só o `timestamp`
 * derivado de `cp.TimeStamp`, que é o relógio do aparelho no envio e mede errado.
 *
 * Em 30/08/2026 eram 8.402 notas PO → ~16.800 chamadas, ~4,7h a 1 nota/s.
 * RODE EM BACKGROUND. A conta da EDP trava por falha de LOGIN, não por volume de
 * leitura, mas o throttle existe pra não competir com o cron.
 *
 * Tudo idempotente: pode rodar de novo, retomar de onde parou, sem duplicar.
 *
 * USO (na VM):
 *   node -r dotenv/config scripts/migrar-po-reparo.js --dry-run
 *   nohup node -r dotenv/config scripts/migrar-po-reparo.js > /tmp/po-backfill.log 2>&1 &
 *   tail -f /tmp/po-backfill.log
 *
 *   Retomar depois de interromper (pula o que já tem linha):
 *   node -r dotenv/config scripts/migrar-po-reparo.js
 *
 *   Reprocessar tudo, inclusive o já gravado:
 *   node -r dotenv/config scripts/migrar-po-reparo.js --refazer
 *
 * Reverter: DROP TABLE IF EXISTS public.note_po_reparo;
 *           (o `note_details` não é tocado em momento nenhum)
 */

const flag = n => process.argv.includes(`--${n}`);
function arg(nome, padrao) {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : padrao;
}

const DRY     = flag('dry-run');
const REFAZER = flag('refazer');
const PAUSA   = Math.max(parseInt(arg('pausa', '150'), 10) || 150, 0);
const LIMITE  = parseInt(arg('limite', '0'), 10) || 0;   // 0 = todas

const dormir = ms => new Promise(r => setTimeout(r, ms));

const DDL = `
  CREATE TABLE IF NOT EXISTS public.note_po_reparo (
    note_id           uuid PRIMARY KEY,
    numero            text,
    sector_id         text,
    team_id           uuid,
    repair_time       timestamptz,
    has_repair        boolean,
    finalizando_em    timestamptz,
    delta_seg         integer,
    prediction_repair timestamptz,
    confirmation_date timestamptz,
    classe            text,
    causa             text,
    clima             text,
    atualizado_em     timestamptz NOT NULL DEFAULT now()
  )`;

async function main() {
  const { _getPool } = require('../services/pgShim');
  const pool = _getPool();
  if (!pool) { console.error('Sem pool. Rode com `node -r dotenv/config` na VM.'); process.exit(1); }

  const { getNotePoExecution, getNoteDetail } = require('../services/wpaService');
  const { montarLinhaReparo, upsertPoReparo, faixaDoDelta } = require('../db/poReparoQueries');

  console.log('\n=== backfill note_po_reparo ===\n');

  const { rows: est } = await pool.query(
    `SELECT count(*)::int AS total FROM public.note_details WHERE tipo = 'PO'`);
  console.log(`notas PO no cache: ${est[0].total}`);

  if (DRY) {
    console.log('\n--dry-run. O que seria feito:');
    console.log(`  1. ${DDL.trim().split('\n')[0].trim()} …`);
    console.log(`  2. backfill de até ${LIMITE || est[0].total} notas, 2 requests cada`);
    console.log(`  3. estimativa: ~${Math.round((LIMITE || est[0].total) * (PAUSA + 900) / 3600000 * 10) / 10}h`);
    console.log('\nNada foi alterado.');
    await pool.end();
    return;
  }

  await pool.query(DDL);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_note_po_reparo_finalizando
                      ON public.note_po_reparo (finalizando_em)`);
  console.log('✅ tabela e índice prontos');

  // Retomada: por padrão pula quem já tem linha. `--refazer` reprocessa tudo.
  const filtroFeitas = REFAZER ? '' :
    `AND NOT EXISTS (SELECT 1 FROM public.note_po_reparo r WHERE r.note_id = nd.note_id)`;
  const { rows: notas } = await pool.query(
    `SELECT nd.note_id, nd.numero, nd.sector_id
       FROM public.note_details nd
      WHERE nd.tipo = 'PO' ${filtroFeitas}
      ORDER BY nd.fetched_at DESC
      ${LIMITE ? `LIMIT ${LIMITE}` : ''}`);

  console.log(`a processar: ${notas.length}${REFAZER ? ' (--refazer)' : ' (pulando as já gravadas)'}\n`);
  if (notas.length === 0) { console.log('nada a fazer.'); await pool.end(); return; }

  const conta = { ok: 0, medidas: 0, semReparo: 0, semEvento4: 0, erro: 0 };
  const faixas = { negativo: 0, abaixo: 0, ok: 0, nao_medido: 0 };
  const t0 = Date.now();

  for (let i = 0; i < notas.length; i++) {
    const n = notas[i];
    try {
      const poExec = await getNotePoExecution(n.note_id);
      const det    = await getNoteDetail(n.note_id, n.sector_id || 'DESG');

      // Os checkpoints crus da API viram a forma que montarLinhaReparo espera.
      // `RegisteredAt2` (com o 2) — ver a nota de fuso em db/poReparoQueries.js.
      const cps = (det && Array.isArray(det.Checkpoints) ? det.Checkpoints : [])
        .map(cp => ({ event: cp.Event, registradoEm: cp.RegisteredAt2 || null }));

      const linha = montarLinhaReparo(poExec, cps);
      await upsertPoReparo(n.note_id, n, linha);

      conta.ok++;
      if (linha.delta_seg != null) conta.medidas++;
      if (!linha.repair_time)     conta.semReparo++;
      if (!linha.finalizando_em)  conta.semEvento4++;
      faixas[faixaDoDelta(linha.delta_seg)]++;
    } catch (err) {
      conta.erro++;
      // Uma nota problemática não pode derrubar o backfill inteiro — a próxima
      // execução pega ela de novo, porque a retomada é por ausência de linha.
      if (conta.erro <= 10) console.warn(`  ⚠ ${n.numero}: ${err.message}`);
    }
    if ((i + 1) % 100 === 0) {
      const seg = Math.round((Date.now() - t0) / 1000);
      const restam = Math.round(seg / (i + 1) * (notas.length - i - 1) / 60);
      console.log(`  ${i + 1}/${notas.length}  (${seg}s, faltam ~${restam}min)  `
        + `medidas=${conta.medidas} semReparo=${conta.semReparo} erro=${conta.erro}`);
    }
    if (PAUSA) await dormir(PAUSA);
  }

  console.log(`\n── RESULTADO ──`);
  console.log(`  gravadas:            ${conta.ok}`);
  console.log(`  MEDIDAS:             ${conta.medidas}`);
  console.log(`  sem Horário Reparo:  ${conta.semReparo}`);
  console.log(`  sem evento 4:        ${conta.semEvento4}`);
  console.log(`  erros:               ${conta.erro}   ← rode de novo pra pegar estas`);
  console.log(`\n  negativo ${faixas.negativo}   abaixo de 10min ${faixas.abaixo}   `
    + `ok ${faixas.ok}   não medido ${faixas.nao_medido}`);
  console.log(`\n  tempo: ${Math.round((Date.now() - t0) / 60000)}min\n`);

  await pool.end();
}

main().catch(err => { console.error('ERRO:', err.message); process.exit(1); });
