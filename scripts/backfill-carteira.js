/**
 * scripts/backfill-carteira.js
 *
 * Popula `team_daily_carteira` retroativamente a partir dos snapshots que
 * ainda existem (retenção ~30 dias). Rodar UMA vez após criar a tabela;
 * dali em diante o cron mantém o dia corrente atualizado.
 *
 * Uso:
 *   node scripts/backfill-carteira.js            # últimos 30 dias
 *   node scripts/backfill-carteira.js 2026-06-01 # desde uma data específica
 */

require('dotenv').config();
const { upsertTeamDailyCarteira } = require('../services/dataWriter');
const { dateBRT } = require('../services/timeUtil');

async function _trabalho() {
  const hoje = dateBRT();
  let inicio = process.argv[2];
  if (!inicio || !/^\d{4}-\d{2}-\d{2}$/.test(inicio)) {
    const d = new Date(hoje + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - 30);
    inicio = d.toISOString().slice(0, 10);
  }

  console.log(`[backfill-carteira] ${inicio} → ${hoje}`);
  const cur = new Date(inicio + 'T12:00:00Z');
  const end = new Date(hoje + 'T12:00:00Z');
  let ok = 0, vazio = 0, erro = 0;

  while (cur <= end) {
    const date = cur.toISOString().slice(0, 10);
    try {
      await upsertTeamDailyCarteira(date);
      ok++;
      console.log(`  ${date} ✓`);
    } catch (err) {
      erro++;
      console.error(`  ${date} ✗ ${err.message}`);
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  console.log(`[backfill-carteira] concluído — ${ok} dias ok, ${erro} erros`);
  process.exit(erro > 0 ? 1 : 0);
}


// 28/08/2026 — P2-43. Este script escreve em tabela de onde saem os números
// reportados à EDP, e não tinha NENHUMA guarda contra duas cópias em paralelo.
// O incidente de 09/07/2026 (P0-0) foi ~60 processos node concorrentes
// derrubando o Postgres por OOM; a lição virou advisory lock, mas só no
// backfill-consolidate.js. Agora é compartilhado — ver scripts/_lock.js.
const { comLock } = require('./_lock');
async function main() {
  return comLock('backfill-carteira', { force: process.argv.includes('--force') }, _trabalho);
}
main();
