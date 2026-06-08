/**
 * Valida o wpaService refatorado pra multi-conta.
 * 1. Login em ambas contas (es, sp) via os fluxos do app
 * 2. Confirma que sectorId routing escolhe a conta certa
 * 3. Faz uma chamada real pra cada conta
 */
const wpa = require('../services/wpaService');

(async () => {
  console.log('=== Login ES (default) ===');
  const tokenEs = await wpa.getToken();
  console.log('Token ES len:', tokenEs?.length, ' status:', JSON.stringify(wpa.getTokenStatus('es')));

  console.log('\n=== Login SP ===');
  try {
    const tokenSp = await wpa.getToken('sp');
    console.log('Token SP len:', tokenSp?.length, ' status:', JSON.stringify(wpa.getTokenStatus('sp')));
  } catch (e) {
    console.error('ERR SP:', e.message);
    return;
  }

  // Routing: chamadas por sectorId devem usar token correto
  console.log('\n=== Fetch DESG (deve usar ES) ===');
  const r1 = await wpa.wpaFetch('/api/Sessions/today?sectorId=DESG');
  const j1 = await r1.json();
  const arr1 = Array.isArray(j1) ? j1 : (j1.Data || []);
  console.log('DESG status:', r1.status, 'sessoes:', arr1.length);

  console.log('\n=== Fetch DSSJ (deve usar SP) ===');
  const r2 = await wpa.wpaFetch('/api/Sessions/today?sectorId=DSSJ');
  const j2 = await r2.json();
  const arr2 = Array.isArray(j2) ? j2 : (j2.Data || []);
  console.log('DSSJ status:', r2.status, 'sessoes:', arr2.length);
  if (arr2.length > 0) {
    const sample = arr2[0];
    console.log('  Amostra:', sample.Team?.Code || sample.Team?.Name, 'CompanyId=', sample.Team?.CompanyId);
  }
})().catch(e => console.error('ERR:', e.message, e.stack));
