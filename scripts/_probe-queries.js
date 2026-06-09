/* Smoke test temporário — queries de leitura. */
require('dotenv').config();
const q = require('../db/notasQueries');

(async () => {
  console.log('— KPIs todas:', await q.getKpis('todas'));
  console.log('— KPIs oficial:', await q.getKpis('oficial'));
  console.log('— KPIs nova:', await q.getKpis('nova'));
  console.log('— Série 7d (todas):', await q.getSerie(7, 'todas'));
  const pe = await q.getPorEquipe('todas');
  console.log('— Por equipe (top 5):', pe.slice(0, 5));
  console.log('— Total equipes:', pe.length);
  const drill = await q.getNotasDeEquipe(pe[0].equipe);
  console.log(`— Drill-down ${pe[0].equipe} (primeiras 3 notas):`, drill.slice(0, 3));
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
