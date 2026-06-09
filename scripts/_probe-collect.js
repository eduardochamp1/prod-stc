/* Smoke test temporário — pipeline completo. */
require('dotenv').config();
const { collectSnapshot } = require('../services/notasMonitor');

(async () => {
  const r = await collectSnapshot();
  console.log(r);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
