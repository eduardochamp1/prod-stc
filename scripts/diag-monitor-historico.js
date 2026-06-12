/**
 * Diagnóstico: por que o Monitor histórico mostra números baixos?
 * Compara o que /teams/historico retorna vs o que daily_totals tem agregado.
 *
 * Uso: node scripts/diag-monitor-historico.js <DE> <ATE> [REGIONAL]
 * Ex:  node scripts/diag-monitor-historico.js 2026-05-01 2026-05-22
 */

require('dotenv').config();
const { getClient } = require('../services/dbClient');
const { getTeamsByDateFromSnapshots } = require('../db/queries');

const DE  = process.argv[2];
const ATE = process.argv[3];
const REG = (process.argv[4] || '').toUpperCase();
if (!DE || !ATE) {
  console.error('Uso: node scripts/diag-monitor-historico.js <DE> <ATE> [REGIONAL]');
  process.exit(1);
}

(async () => {
  const sb = getClient();

  console.log(`Diagnóstico: ${DE} → ${ATE} ${REG ? `(${REG})` : '(todas)'}\n`);

  // 1) O que /teams/historico retorna (mesmo que o Monitor consome)
  const regionals = REG ? [REG] : ['GUA', 'CAC', 'SJC'];
  const teams = await getTeamsByDateFromSnapshots(DE, ATE, regionals);
  console.log(`=== /teams/historico ===`);
  console.log(`Total equipes: ${teams.length}`);
  let totalConc = 0, totalExec = 0, totalRej = 0;
  teams.forEach(t => {
    totalConc += (t.notasConcluidas || []).length;
    totalExec += (t.notasExecutadas || []).length;
    totalRej  += (t.notasRejeitadas || []).length;
  });
  console.log(`Soma notasConcluidas (todas equipes): ${totalConc}`);
  console.log(`Soma notasExecutadas (todas equipes): ${totalExec}`);
  console.log(`Soma notasRejeitadas (todas equipes): ${totalRej}`);
  console.log(`Total realizadas (exec + conc): ${totalConc + totalExec}`);

  // 2) Comparação com team_daily_totals (que é o agregado oficial)
  console.log(`\n=== team_daily_totals (agregado oficial) ===`);
  let q = sb.from('team_daily_totals').select('count', { count: 'exact' })
    .gte('date', DE).lte('date', ATE);
  if (REG) q = q.eq('regional', REG);
  const { data: rows, count: tdsCount } = await q;
  const totalTds = (rows || []).reduce((s, r) => s + (r.count || 0), 0);
  console.log(`Total OS em team_daily_totals: ${totalTds}`);
  console.log(`(${tdsCount} linhas no período)`);

  // 3) Diferença
  console.log(`\n=== ANÁLISE ===`);
  console.log(`Realizadas via /historico: ${totalConc + totalExec}`);
  console.log(`Realizadas via team_daily_totals: ${totalTds}`);
  console.log(`Diferença: ${totalTds - (totalConc + totalExec)} (${totalTds > 0 ? Math.round(((totalTds - (totalConc + totalExec)) / totalTds) * 100) : 0}%)`);
  console.log();
  if (totalTds > totalConc + totalExec) {
    console.log(`⚠ Snapshots retornam ${totalConc + totalExec} mas o agregado oficial tem ${totalTds}.`);
    console.log(`  Possível causa: snapshots antigos foram limpos (cron clean-snapshots > 30 dias).`);
    console.log(`  Recomendação: usar team_daily_totals como fonte das OS no monitor histórico.`);
  }

  // 4) Quantos snapshots existem em cada dia do range
  console.log(`\n=== Snapshots por dia ===`);
  let cur = new Date(DE + 'T12:00:00Z');
  const end = new Date(ATE + 'T12:00:00Z');
  while (cur <= end) {
    const d = cur.toISOString().slice(0, 10);
    let q2 = sb.from('snapshots').select('id', { count: 'exact', head: true }).eq('date', d);
    if (REG) q2 = q2.eq('regional', REG);
    const { count } = await q2;
    console.log(`  ${d}: ${count || 0} snapshots`);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
