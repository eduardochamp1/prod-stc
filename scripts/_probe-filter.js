/* Smoke test temporário — Task 3. */
require('dotenv').config();
const { getNotasDevolvidas }   = require('../services/wpaService');
const { filterEngelmig }       = require('../services/notasMonitor');

(async () => {
  const all = await getNotasDevolvidas();
  const eng = filterEngelmig(all);
  console.log('total:', all.length, 'engelmig:', eng.length);
  const equipesEng = [...new Set(eng.map(n => n.Team.Name))].sort();
  console.log('equipes engelmig:', equipesEng.length);
  console.log(equipesEng);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
