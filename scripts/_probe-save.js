/* Smoke test temporário — persistir snapshot. */
require('dotenv').config();
const { getNotasDevolvidas, getTeamsSimple } = require('../services/wpaService');
const { filterEngelmig, buildTeamCompanyMap, saveSnapshot } = require('../services/notasMonitor');

(async () => {
  const [teams, notas] = await Promise.all([getTeamsSimple(), getNotasDevolvidas()]);
  const eng = filterEngelmig(notas, buildTeamCompanyMap(teams));
  const ts  = new Date().toISOString();
  const n   = await saveSnapshot(eng, ts);
  console.log('inseridos:', n, 'em ts:', ts);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
