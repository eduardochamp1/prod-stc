#!/usr/bin/env node
/**
 * scripts/backfill-consolidate.js — Runner OFICIAL de (re)consolidação diária.
 *
 * Reprocessa `consolidateDay(date)` para um intervalo de datas, 1 dia por vez,
 * com pausa entre eles. É o jeito CANÔNICO e SEGURO de refazer os agregados
 * (team_daily_totals / team_daily_subcat_totals) do histórico — recuperação de
 * incidente, backfill de métrica nova, ou correção pontual.
 *
 * ⚠️ POR QUE ESTE SCRIPT EXISTE (incidente 09/07/2026 — P0-0):
 *   Um backfill foi improvisado como `for d in $(seq 0 60); do node -e ... &`,
 *   ou seja ~60 processos node EM PARALELO, cada um abrindo um pool pg (~10
 *   conexões). Numa VM de 3.8GB SEM SWAP isso estourou memória/conexões e
 *   derrubou o Postgres (OOM). Produção ficou `db:error` até o auto-restart.
 *   Este script mata esse pé-de-cabra de DUAS formas:
 *     1) É single-process e sequencial POR DESIGN (loop com pausa).
 *     2) Pega um ADVISORY LOCK do Postgres no início — se outra cópia já está
 *        rodando, RECUSA (a não ser com --force). O lock solta sozinho se o
 *        processo morrer (é por sessão), então não trava pra sempre.
 *   NUNCA rode isto em N cópias paralelas. Se precisar acelerar, aumente a
 *   pausa e rode 1 só; a VM não tem folga de memória pra concorrência.
 *
 * USO (na VM):
 *   # DRY-RUN (padrão) — só mede antes/depois por dia, NÃO grava:
 *   node scripts/backfill-consolidate.js 2026-07-01 2026-07-19
 *   node scripts/backfill-consolidate.js 2026-07-19            # 1 dia
 *
 *   # APLICAR de verdade (wipe + reagrega cada dia):
 *   node scripts/backfill-consolidate.js 2026-07-01 2026-07-19 --apply
 *
 *   # Opções:
 *   --pause=MS   pausa entre dias no modo --apply (default 800ms)
 *   --force      ignora o advisory lock (PERIGOSO — só se tiver CERTEZA que
 *                não há outra cópia rodando; anula a proteção anti-OOM)
 *
 * Nota: NÃO reprocessa a carteira por equipe (scripts/backfill-carteira.js) nem
 * subcategorias cruas do WPA (scripts/backfill-subcategorias.js) — só a
 * consolidação dos totais. Rode aqueles separadamente se precisar, sempre 1 por vez.
 */

require('dotenv').config();
const { consolidateDay, _addDays } = require('../services/dataWriter');
const { getClient } = require('../services/dbClient');
const { _getPool } = require('../services/pgShim');

// Chave fixa do advisory lock (arbitrária, mas estável entre execuções). Cabe
// em int4. Só ESTE script a usa — dois `backfill-consolidate` disputam a mesma.
const LOCK_KEY = 429153001;
const DEFAULT_PAUSE_MS = 800;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Helpers puros (exportados pra teste) ─────────────────────────────────────

/** Gera datas YYYY-MM-DD de `de` até `ate` (inclusive), crescente. */
function rangeDatas(de, ate) {
  const out = [];
  const d = new Date(de + 'T12:00:00Z');
  const fim = new Date(ate + 'T12:00:00Z');
  while (d <= fim) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/**
 * Faz o parse de argv (sem os 2 primeiros). Retorna
 * { datas, de, ate, apply, force, pauseMs, error }. `error` != null => uso inválido.
 */
function parseArgs(argv) {
  const flags = argv.filter(a => a.startsWith('--'));
  const datasArg = argv.filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const apply = flags.includes('--apply');
  const force = flags.includes('--force');
  const pauseFlag = flags.find(f => f.startsWith('--pause='));
  let pauseMs = DEFAULT_PAUSE_MS;
  if (pauseFlag) {
    const n = parseInt(pauseFlag.split('=')[1], 10);
    if (!Number.isFinite(n) || n < 0) return { error: `--pause inválido: ${pauseFlag}` };
    pauseMs = n;
  }
  if (datasArg.length === 0) {
    return { error: 'informe ao menos uma data YYYY-MM-DD (e opcionalmente a data-fim)' };
  }
  const de = datasArg[0];
  const ate = datasArg[1] || datasArg[0];
  if (ate < de) return { error: `data-fim (${ate}) é anterior à data-início (${de})` };
  return { datas: rangeDatas(de, ate), de, ate, apply, force, pauseMs, error: null };
}

// ── DB helpers ───────────────────────────────────────────────────────────────

/** Soma de count gravada em team_daily_totals para o dia (recorte igual ao "depois"). */
async function currentCount(date) {
  const sb = getClient();
  const { data, error } = await sb.from('team_daily_totals').select('count').eq('date', date);
  if (error) throw error;
  return (data || []).reduce((s, r) => s + (Number(r.count) || 0), 0);
}

/**
 * Tenta pegar o advisory lock. Retorna o client dedicado que o segura (pra
 * soltar no fim) ou null se não conseguiu. Lock é por SESSÃO → solta sozinho se
 * o processo morrer (não trava o próximo run após um crash).
 */
async function acquireLock() {
  const client = await _getPool().connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
    if (rows[0] && rows[0].ok) return client;
    client.release();
    return null;
  } catch (e) {
    client.release();
    throw e;
  }
}

async function releaseLock(client) {
  if (!client) return;
  try { await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); } catch (_) { /* ignore */ }
  client.release();
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(`✖ ${parsed.error}`);
    console.error('Uso: node scripts/backfill-consolidate.js <data> [<data-fim>] [--apply] [--pause=MS] [--force]');
    process.exit(1);
  }
  const { datas, de, ate, apply, force, pauseMs } = parsed;

  // Advisory lock: impede 2 cópias concorrentes (proteção anti-OOM do P0-0).
  let lockClient = await acquireLock();
  if (!lockClient) {
    if (!force) {
      console.error('✖ Outro backfill-consolidate já está rodando (advisory lock ocupado).');
      console.error('  Espere ele terminar. Rodar em paralelo foi o que derrubou o Postgres em 09/07.');
      console.error('  Se tem CERTEZA que não há outra cópia (ex.: sobrou de um crash), use --force.');
      process.exit(1);
    }
    console.warn('⚠️  --force: seguindo SEM advisory lock. Garanta que NÃO há outra cópia rodando.');
  }

  try {
    console.log(`\n${apply ? '⚙️  APLICANDO' : '🔍 DRY-RUN (não grava)'} — ${datas.length} dia(s): ${de} → ${ate}` +
      `${apply ? ` · pausa ${pauseMs}ms` : ''}\n`);
    console.log('data'.padEnd(12), 'antes'.padStart(8), 'depois'.padStart(8), 'diff'.padStart(8), 'equipes'.padStart(8));
    console.log('-'.repeat(52));

    let totAntes = 0, totDepois = 0, erros = 0;
    for (const date of datas) {
      try {
        const antes = await currentCount(date);
        // dry-run calcula o "depois" sem gravar. consolidateDay gera linhas de
        // vários notaDate (D-2..D); pra comparar com o `antes` (só date), filtra
        // as linhas por r.date === date. Somar dry.newCount inflaria (P1-13).
        //
        // RÉGUA = passe de D+1, não de D (31/07/2026). consolidateDay(D) apaga
        // {D-1,D} e é o passe de D+1 que reescreve D — vendo as sessões que só
        // aparecem nos snapshots de D+1. A régua de D subconta ~5% e foi o que
        // gerou o P0-6 (auto-reparo apagando produção legítima) e, aqui, uma
        // previsão de queda que o apply não confirmou (previu −847 em julho,
        // real −88). Igual a detectDrift.
        const dry = await consolidateDay(_addDays(date, 1), { dryRun: true });
        const depois = dry ? (dry.rows || []).filter(r => r.date === date).reduce((s, r) => s + r.count, 0) : 0;
        const equipes = dry ? dry.teams : 0;
        const diff = depois - antes;
        totAntes += antes; totDepois += depois;
        const flag = diff !== 0 ? (diff < 0 ? ' ⬇' : ' ⬆') : '';
        console.log(
          date.padEnd(12),
          String(antes).padStart(8),
          String(depois).padStart(8),
          String(diff).padStart(8) + flag,
          String(equipes).padStart(8),
        );

        if (apply) {
          await consolidateDay(date);   // grava de verdade (wipe + reagrega)
          await sleep(pauseMs);         // gentil com o Postgres (single-process)
        }
      } catch (err) {
        erros++;
        console.error(`  ✖ ${date}: ${err.message}`);
      }
    }

    console.log('-'.repeat(52));
    console.log('TOTAL'.padEnd(12), String(totAntes).padStart(8), String(totDepois).padStart(8),
      String(totDepois - totAntes).padStart(8));
    console.log(`\n${apply ? '✅ Aplicado' : 'ℹ️  Dry-run — rode com --apply pra gravar'}` +
      `${erros ? ` · ${erros} dia(s) com erro` : ''}.\n`);

    if (apply) {
      // O ÚLTIMO dia do intervalo fica com o valor do passe de ELE MESMO (régua
      // de D), que subconta — porque nenhum passe de D+1 rodou depois pra
      // reescrevê-lo. Todos os outros dias do intervalo foram selados pelo passe
      // do dia seguinte. Descoberto em 31/07/2026 no apply de julho.
      console.log(`⚠️  ${ate} é o último dia do intervalo e ficou com a régua de D (subconta).`);
      console.log(`   Quem sela um dia é o passe do dia SEGUINTE. Opções:`);
      console.log(`     • se ${ate} é hoje: o cron das 00:15 sela sozinho, nada a fazer;`);
      console.log(`     • se ${ate} é passado: rode o intervalo com 1 dia extra no fim.`);
      console.log(`   Confira o resultado com: node scripts/verify-consolidacao.js ${de} ${ate}\n`);
    }
  } finally {
    await releaseLock(lockClient);
    try { const p = _getPool && _getPool(); if (p && p.end) await p.end(); } catch (_) { /* ignore */ }
  }
}

// Roda só quando executado direto (node scripts/backfill-consolidate.js). Quando
// requerido por um teste, exporta os helpers puros sem tocar em banco.
if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { rangeDatas, parseArgs, LOCK_KEY, DEFAULT_PAUSE_MS };
