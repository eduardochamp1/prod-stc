/**
 * Inspeciona uma sessão ENCERRADA do /api/Sessions/today pra ver shape dos
 * campos BeginTime, EndTime, CompanyId etc — usado pra implementar suporte
 * a equipes-fantasma com horários reais.
 */
const { login, wpaFetch } = require('../services/wpaService');

(async () => {
  await login();
  for (const sec of ['DESG', 'DESC']) {
    const r = await wpaFetch('/api/Sessions/today?sectorId=' + sec);
    const j = await r.json();
    const arr = Array.isArray(j) ? j : (j.Data || []);
    const closed = arr.filter(s => s.EndTime || s.End);
    const open   = arr.filter(s => !s.EndTime && !s.End);
    console.log('---', sec, 'total=' + arr.length, 'closed=' + closed.length, 'open=' + open.length);
    if (closed[0]) {
      console.log('  shape ENCERRADA (1ª):');
      const s = closed[0];
      console.log('    Id:', s.Id);
      console.log('    Team:', s.Team?.Code || s.Team?.Name, 'CompanyId=' + s.Team?.CompanyId);
      console.log('    BeginTime:', s.BeginTime);
      console.log('    EndTime:', s.EndTime);
      console.log('    SectorId:', s.SectorId, 'Sector.Code:', s.Sector?.Code);
      console.log('    Vehicle.Code:', s.Vehicle?.Code);
      console.log('    Collaborators count:', (s.Collaborators || []).length);
      console.log('    SessionManualEndReason:', s.SessionManualEndReason);
      console.log('    keys:', Object.keys(s).join(', '));
    }
  }
})().catch(e => console.error('ERR', e.message));
