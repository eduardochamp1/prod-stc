#!/usr/bin/env node
/**
 * scripts/backfill-osrm.js
 *
 * Popula a tabela `osrm_cache` com TODAS as rotas (origem→destino) dos
 * deslocamentos de equipes num periodo. Roda como processo separado pra
 * nao amarrar o servidor HTTP (que mata workers por timeout em consultas
 * longas tipo "01/05 a 25/05").
 *
 * Reusa `extrairDeslocamentos` e `getRoute` do app — mesma logica de
 * extracao e mesma chave de cache. Quando terminar, abrir Deslocamentos
 * na UI vira instantaneo no periodo coberto.
 *
 * USO:
 *   node scripts/backfill-osrm.js                            # ultimos 30 dias
 *   node scripts/backfill-osrm.js --de=2026-05-01            # de X ate hoje
 *   node scripts/backfill-osrm.js --de=2026-05-01 --ate=2026-05-25
 *   node scripts/backfill-osrm.js --de=2026-05-01 --ate=2026-05-25 --dry-run
 *
 * BACKGROUND (recomendado pra runs longos):
 *   nohup node scripts/backfill-osrm.js --de=2026-05-01 --ate=2026-05-25 \
 *     > /tmp/backfill-osrm.log 2>&1 &
 *   tail -f /tmp/backfill-osrm.log
 *
 * SIGINT (Ctrl+C) eh tratado: termina o par atual e sai limpo.
 */

require('dotenv').config();
const crypto = require('crypto');
const { _getPool } = require('../services/pgShim');
const { getRoute } = require('../services/osrmService');
const { extrairDeslocamentos } = require('../db/deslocamentosQueries');

// ── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (name, def = null) => {
  const a = args.find(x => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const hasFlag = (name) => args.includes(`--${name}`);

const today = new Date().toISOString().slice(0, 10);
const ate = getArg('ate', today);
const de = getArg('de', (() => {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
})());
const dryRun = hasFlag('dry-run');

if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate)) {
  console.error('ERRO: --de e --ate devem ser YYYY-MM-DD');
  process.exit(1);
}
if (de > ate) {
  console.error(`ERRO: --de (${de}) > --ate (${ate})`);
  process.exit(1);
}

// ── Sinais ───────────────────────────────────────────────────────────────────
let stopRequested = false;
process.on('SIGINT', () => {
  if (stopRequested) {
    console.log('\n[!] segundo SIGINT, abortando imediatamente.');
    process.exit(130);
  }
  console.log('\n[!] SIGINT recebido — terminando par atual e saindo limpo. Ctrl+C de novo pra abortar.');
  stopRequested = true;
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function _round(n) { return Math.round(n * 1e5) / 1e5; }
function _cacheKey(oLat, oLng, dLat, dLng) {
  const s = `${_round(oLat)}:${_round(oLng)}:${_round(dLat)}:${_round(dLng)}`;
  return crypto.createHash('md5').update(s).digest('hex');
}
function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}
function nextDay(yyyymmdd) {
  const d = new Date(yyyymmdd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ── Lista dias do periodo ────────────────────────────────────────────────────
function listDays(from, to) {
  const out = [];
  let cur = from;
  while (cur <= to) {
    out.push(cur);
    cur = nextDay(cur);
  }
  return out;
}

// ── Query: notas com checkpoint num dia ──────────────────────────────────────
async function notasComCheckpointNoDia(pool, dia) {
  const sql = `
    SELECT
      nd.note_id,
      nd.payload->'checkpoints' AS checkpoints
    FROM note_details nd
    WHERE nd.payload->'checkpoints' IS NOT NULL
      AND jsonb_array_length(nd.payload->'checkpoints') >= 2
      AND (nd.payload->'checkpoints'->0->>'timestamp')::timestamptz >= $1::date
      AND (nd.payload->'checkpoints'->0->>'timestamp')::timestamptz < ($1::date + interval '1 day')
  `;
  const { rows } = await pool.query(sql, [dia]);
  return rows;
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  const t0 = Date.now();
  console.log(`[backfill-osrm] periodo: ${de} a ${ate}  ${dryRun ? '(DRY-RUN)' : ''}`);
  console.log(`[backfill-osrm] PID: ${process.pid}`);

  const pool = _getPool();
  const dias = listDays(de, ate);
  console.log(`[backfill-osrm] ${dias.length} dia(s) pra processar`);

  // Set de chaves ja vistas nesta execucao (evita re-check do mesmo par
  // no banco varias vezes — o getRoute faz cache check, mas economiza
  // ainda mais um round-trip ao PG por chamada).
  const seenInRun = new Set();

  let totalDias        = 0;
  let totalPares       = 0;          // pares brutos antes de dedup
  let totalParesUnicos = 0;          // depois de dedup por chave
  let totalHits        = 0;          // ja estava no cache (ou degenerado origem=destino)
  let totalMisses      = 0;          // chamada HERE feita e cacheada agora
  let totalFails       = 0;          // chamada falhou

  for (const dia of dias) {
    if (stopRequested) break;
    totalDias++;
    const tDia = Date.now();

    let notas;
    try {
      notas = await notasComCheckpointNoDia(pool, dia);
    } catch (err) {
      console.error(`[${dia}] ERRO query SQL: ${err.message}`);
      continue;
    }

    if (notas.length === 0) {
      console.log(`[${dia}] sem notas com checkpoint — pulando.`);
      continue;
    }

    // Extrai pares de todas as notas
    const pares = [];
    for (const n of notas) {
      const ds = extrairDeslocamentos(n.checkpoints);
      for (const d of ds) pares.push(d);
    }
    totalPares += pares.length;

    // Dedup por chave de cache — varios pares podem ter mesmo md5
    // (mesmas coords arredondadas a ~1m)
    const paresUnicos = new Map();   // key -> {oLat,oLng,dLat,dLng}
    for (const p of pares) {
      const key = _cacheKey(p.origem.lat, p.origem.lng, p.destino.lat, p.destino.lng);
      if (!paresUnicos.has(key) && !seenInRun.has(key)) {
        paresUnicos.set(key, {
          oLat: p.origem.lat,  oLng: p.origem.lng,
          dLat: p.destino.lat, dLng: p.destino.lng,
        });
      }
    }
    const uniqueArr = Array.from(paresUnicos.entries());
    totalParesUnicos += uniqueArr.length;

    console.log(`[${dia}] ${notas.length} notas → ${pares.length} pares → ${uniqueArr.length} unicos novos`);

    if (dryRun) {
      for (const [key] of uniqueArr) seenInRun.add(key);
      continue;
    }

    // Processa cada par. getRoute faz cache check + fetch + write.
    let diaHits = 0, diaMisses = 0, diaFails = 0;
    let i = 0;
    for (const [key, c] of uniqueArr) {
      if (stopRequested) break;
      i++;
      const r = await getRoute(c.oLat, c.oLng, c.dLat, c.dLng);
      seenInRun.add(key);
      if (r) {
        if (r.cached) diaHits++; else diaMisses++;
      } else {
        diaFails++;
      }
      // Progresso a cada 50 pares
      if (i % 50 === 0) {
        const pct = ((i / uniqueArr.length) * 100).toFixed(1);
        process.stdout.write(`[${dia}]   ${i}/${uniqueArr.length} (${pct}%) hits=${diaHits} misses=${diaMisses} fails=${diaFails}\r`);
      }
    }

    totalHits   += diaHits;
    totalMisses += diaMisses;
    totalFails  += diaFails;
    console.log(`[${dia}]   concluido em ${fmtDuration(Date.now() - tDia)} — hits=${diaHits} misses=${diaMisses} fails=${diaFails}`);
  }

  const dt = Date.now() - t0;
  console.log('');
  console.log('─'.repeat(60));
  console.log(`[backfill-osrm] FIM em ${fmtDuration(dt)}`);
  console.log(`  dias processados:    ${totalDias}/${dias.length}`);
  console.log(`  pares brutos:        ${totalPares}`);
  console.log(`  pares unicos:        ${totalParesUnicos}`);
  console.log(`  cache hits:          ${totalHits}   (ja existia / origem=destino)`);
  console.log(`  cache misses:        ${totalMisses}   (novas chamadas HERE feitas)`);
  console.log(`  fails:               ${totalFails}`);
  if (stopRequested) console.log(`  [!] interrompido por sinal`);

  // Conta final no banco pra dar um sanity check
  try {
    const { rows } = await pool.query(
      `SELECT source, count(*)::int AS total FROM osrm_cache GROUP BY source ORDER BY source`
    );
    console.log('');
    console.log('[backfill-osrm] cache no banco agora:');
    for (const r of rows) console.log(`  ${r.source.padEnd(15)} ${r.total}`);
  } catch (_) { /* ignore */ }

  await pool.end().catch(() => {});
  process.exit(stopRequested ? 130 : (totalFails > 0 ? 1 : 0));
})().catch(err => {
  console.error('[backfill-osrm] erro fatal:', err);
  process.exit(2);
});
