#!/usr/bin/env node
/**
 * scripts/backfill-interrupcoes.js
 *
 * Grava em note_interrupcoes o histórico das MD JÁ cacheadas em note_details
 * que tiveram interrupção. Complementa o 2º caminho da coleta (07/10/2026,
 * noteDetailCacher → interrupcaoService.coletarDaNota): MD concluída/rejeitada
 * ANTES do deploy já estava no cache e nunca vai passar por lá de novo.
 *
 * Seleção LOCAL, custo zero: o payload processado guarda `interrupcoes` desde
 * 22/08/2026 (P1-24). Só as notas com esse array não vazio custam 1 GET
 * (completeInterruptions) — é ele que traz a equipe; o payload não traz.
 *
 * Idempotente: upsert pelo Id da interrupção. Pode rodar de novo.
 * A matriz só conta a partir de 07/10/2026 (INICIO_COLETA_INTERR); --desde
 * mais antigo grava, mas não aparece na tela.
 *
 * USO (na VM, dentro de ~/prod-stc):
 *   node -r dotenv/config scripts/backfill-interrupcoes.js --desde 2026-10-07
 *   node -r dotenv/config scripts/backfill-interrupcoes.js --desde 2026-10-07 --dry-run
 */

function arg(nome, padrao = null) {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : padrao;
}

const DESDE = arg('desde', '2026-10-07');
const DRY   = process.argv.includes('--dry-run');

async function main() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(DESDE)) throw new Error('--desde deve ser YYYY-MM-DD');
  const { _getPool } = require('../services/pgShim');
  const pool = _getPool();
  if (!pool) { console.error('Sem pool. Rode com `node -r dotenv/config` na VM.'); process.exit(1); }

  // fetched_at em BRT: a nota concluída no dia D é cacheada no próprio dia D.
  const { rows } = await pool.query(`
    SELECT note_id, numero, sector_id
      FROM note_details
     WHERE tipo = 'MD'
       AND (fetched_at AT TIME ZONE 'America/Sao_Paulo')::date >= $1::date
       AND jsonb_typeof(payload->'interrupcoes') = 'array'
       AND jsonb_array_length(payload->'interrupcoes') > 0
     ORDER BY fetched_at`, [DESDE]);

  console.log(`\nMD cacheadas desde ${DESDE} com interrupção: ${rows.length}${DRY ? ' (dry-run, nada gravado)' : ''}\n`);
  if (DRY || rows.length === 0) { rows.forEach(r => console.log(`  ${r.numero}`)); return; }

  const { coletarDaNota } = require('../services/interrupcaoService');
  let gravadas = 0, falhas = 0;
  // Concorrência 2: a conta EDP é compartilhada (P1-25).
  for (let i = 0; i < rows.length; i += 2) {
    await Promise.all(rows.slice(i, i + 2).map(async r => {
      try {
        const n = await coletarDaNota({ note_id: r.note_id, numero: r.numero, tipo: 'MD', sector_id: r.sector_id });
        gravadas += n;
        console.log(`  ${r.numero}: ${n} interrupção(ões)`);
      } catch (err) {
        falhas++;
        console.log(`  ${r.numero}: FALHOU — ${err.message}`);
      }
    }));
  }
  console.log(`\nGravadas ${gravadas} interrupções de ${rows.length - falhas} notas (${falhas} falhas).`);
  await pool.end().catch(() => {});
}

main().catch(err => { console.error('ERRO:', err.message); process.exit(1); });
