/**
 * Probe pra descobrir endpoint que retorna sessões encerradas/historicas do WPA.
 * /api/Sessions/all/online só retorna ativas — precisamos das que ja deslogaram hoje.
 */
const { login, wpaFetch } = require('../services/wpaService');

const CANDIDATOS = [
  '/api/Sessions/all?sectorId=DESG',
  '/api/Sessions/all/closed?sectorId=DESG',
  '/api/Sessions/all/today?sectorId=DESG',
  '/api/Sessions/all/offline?sectorId=DESG',
  '/api/Sessions/today?sectorId=DESG',
  '/api/Sessions/closed?sectorId=DESG',
  '/api/Sessions/history?sectorId=DESG',
  '/api/Sessions?sectorId=DESG',
  '/api/Sessions/all/finished?sectorId=DESG',
  '/api/Sessions/all/ended?sectorId=DESG',
  '/api/Sessions/byDate/2026-06-08?sectorId=DESG',
];

(async () => {
  await login();
  for (const path of CANDIDATOS) {
    try {
      const r = await wpaFetch(path);
      const ct = r.headers.get('content-type') || '';
      const isJson = ct.includes('json');
      let info = '';
      if (isJson) {
        const j = await r.json();
        const arr = Array.isArray(j) ? j : (j.Data || []);
        info = `array.length=${arr.length}`;
        if (arr[0]) {
          const k = Object.keys(arr[0]);
          info += ' k=' + k.slice(0, 5).join(',');
          // Pega exemplo de session encerrada (EndTime != null)
          const closed = arr.find(s => s.EndTime || s.End);
          if (closed) info += ' [FOUND closed example]';
        }
      } else {
        info = 'HTML';
      }
      console.log(r.status, path, '→', info);
    } catch (e) {
      console.log('ERR', path, '→', e.message);
    }
  }
})().catch(e => console.error('FATAL', e.message));
