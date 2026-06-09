/* Smoke test temporário — filtro Engelmig por CompanyId + segregação oficial/nova. */
require('dotenv').config();
const { getNotasDevolvidas, getTeamsSimple } = require('../services/wpaService');
const { filterEngelmig, buildTeamCompanyMap } = require('../services/notasMonitor');

(async () => {
  const [teams, notas] = await Promise.all([getTeamsSimple(), getNotasDevolvidas()]);
  console.log('teams (dropdown):', teams.length, '| notas:', notas.length);
  const mapa = buildTeamCompanyMap(teams);
  const eng  = filterEngelmig(notas, mapa);
  const oficiais = eng.filter(n => n._equipe_oficial);
  const novas    = eng.filter(n => !n._equipe_oficial);
  console.log('engelmig total:', eng.length, '| oficiais:', oficiais.length, '| novas (fora whitelist):', novas.length);
  const equipesNovas = [...new Set(novas.map(n => n.Team.Name))].sort();
  console.log('equipes novas (a revisar):', equipesNovas);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
