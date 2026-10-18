#!/usr/bin/env node
/**
 * scripts/reparar-notas-agg-sem-snapshot.js
 *
 * P0-10 (incidente 16/10/2026). Com a EDP devolvendo "Nenhum dado encontrado"
 * (filtro de User-Agent), a coleta de notas devolvidas não gravou NENHUM
 * snapshot em 17 e 18/10 (UTC), mas o updateDailyAgg rodou de hora em hora e
 * gravou esses dias em `notas_daily_agg` com pendentes_fim_dia = 0 e a carteira
 * inteira do dia anterior em sairam_no_dia. Número inventado, não medido.
 *
 * O que este script faz, por dia do intervalo (datas UTC, como a coleta grava):
 *   - dia SEM snapshot em notas_snapshots → APAGA as linhas do agregado do dia.
 *     "Sem dado" é a verdade; não há o que reconstruir (a carteira de devolvidas
 *     é estado do momento, a EDP não devolve o passado).
 *   - dia COM snapshot → recalcula pelo próprio updateDailyAgg (idempotente).
 *
 * NÃO precisa de restore dos dumps: o `deleted: 4610` do log de 18/10 02:05 UTC
 * é a retenção de 30 dias do notas_snapshots (`_cleanupOld`), que apaga por idade
 * e roda toda hora — não tem relação com a resposta vazia. Restaurar essas linhas
 * seria desfeito pela próxima retenção.
 *
 * ⚠️ Nunca rode para dia com mais de 29 dias: a retenção já apagou os snapshots
 * dele, e o script trataria o agregado legítimo como "sem snapshot". Por isso o
 * intervalo é obrigatório e limitado.
 *
 * MODO PADRÃO É DRY-RUN.
 *
 *   node scripts/reparar-notas-agg-sem-snapshot.js --desde 2026-10-17 --ate 2026-10-18
 *   node scripts/reparar-notas-agg-sem-snapshot.js --desde 2026-10-17 --ate 2026-10-18 --apply
 */

'use strict';

require('dotenv').config();

const { _getPool } = require('../services/pgShim');
const { comLock }  = require('./_lock');

const APPLY = process.argv.includes('--apply');
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DIAS_MAX_ATRAS = 29;   // retenção do notas_snapshots é 30 dias

function arg(nome) {
  const i = process.argv.indexOf(nome);
  return i > -1 ? process.argv[i + 1] : null;
}

/** Datas ISO de `desde` a `ate`, inclusive. */
function intervalo(desde, ate) {
  const out = [];
  for (let d = new Date(`${desde}T00:00:00Z`); d <= new Date(`${ate}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

async function main() {
  const desde = arg('--desde');
  const ate   = arg('--ate');
  if (!ISO.test(desde || '') || !ISO.test(ate || '') || desde > ate) {
    console.error('uso: --desde YYYY-MM-DD --ate YYYY-MM-DD [--apply]');
    process.exit(1);
  }
  const limite = new Date(Date.now() - DIAS_MAX_ATRAS * 86400_000).toISOString().slice(0, 10);
  if (desde < limite) {
    console.error(`✖ ${desde} é anterior a ${limite}: a retenção de 30 dias já apagou os snapshots — o script apagaria agregado legítimo.`);
    process.exit(1);
  }

  const pool = _getPool();
  try {
    await comLock('reparar-notas-agg', { force: process.argv.includes('--force') }, async () => {
      const { updateDailyAgg } = require('../services/notasMonitor');
      for (const dia of intervalo(desde, ate)) {
        const snaps = await pool.query(
          `SELECT count(DISTINCT snapshot_ts)::int AS n FROM notas_snapshots
            WHERE snapshot_ts >= $1::date AND snapshot_ts < ($1::date + interval '1 day')`, [dia]);
        const agg = await pool.query(
          `SELECT count(*)::int AS linhas, coalesce(sum(pendentes_fim_dia),0)::int AS pendentes,
                  coalesce(sum(entraram_no_dia),0)::int AS entraram, coalesce(sum(sairam_no_dia),0)::int AS sairam
             FROM notas_daily_agg WHERE data = $1::date`, [dia]);
        const n = snaps.rows[0].n;
        const a = agg.rows[0];
        const acao = n === 0 ? 'APAGAR agregado (dia sem snapshot)' : 'RECALCULAR (dia com snapshot)';
        console.log(`${dia}: ${n} snapshot(s) | agregado: ${a.linhas} linhas, pendentes=${a.pendentes} entraram=${a.entraram} sairam=${a.sairam} → ${acao}`);
        if (!APPLY) continue;
        if (n === 0) {
          const r = await pool.query('DELETE FROM notas_daily_agg WHERE data = $1::date', [dia]);
          console.log(`   ✔ ${r.rowCount} linha(s) apagada(s)`);
        } else {
          const linhas = await updateDailyAgg(dia);
          console.log(`   ✔ recalculado: ${linhas} linha(s)`);
        }
      }
      if (!APPLY) console.log('\n── DRY-RUN. Nada foi escrito. Use --apply pra valer.\n');
    });
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('✖', err.message);
  process.exit(1);
});
