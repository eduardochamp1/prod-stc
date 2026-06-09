/* Smoke test temporário — agregação diária. */
require('dotenv').config();
const { updateDailyAgg } = require('../services/notasMonitor');

(async () => {
  const today = new Date().toISOString().slice(0, 10);
  const n = await updateDailyAgg(today);
  console.log('linhas agregadas:', n, '(data:', today, ')');
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
