/**
 * Probe pra validar credencial SP da EDP e descobrir sectorId da regional SJC.
 *
 * EDP usa DUAS URLs:
 *   AUTH: https://edp-wpa-po.azurewebsites.net/identity/signin
 *   API:  https://edp-wpa-web-api.azurewebsites.net/...
 *
 * Pré-requisito no .env:
 *   WPA_USERNAME_SP=...
 *   WPA_PASSWORD_SP=...
 */
const WPA_AUTH = process.env.WPA_URL     || 'https://edp-wpa-po.azurewebsites.net';
const WPA_API  = process.env.WPA_API_URL || 'https://edp-wpa-web-api.azurewebsites.net';

async function loginSp() {
  const user = process.env.WPA_USERNAME_SP || '';
  const pass = process.env.WPA_PASSWORD_SP || '';
  if (!user || !pass) {
    throw new Error('WPA_USERNAME_SP / WPA_PASSWORD_SP nao definidos no .env');
  }
  const body = new URLSearchParams({ Username: user, Password: pass });
  const res = await fetch(`${WPA_AUTH}/identity/signin`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Login SP falhou ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.Token) {
    throw new Error('Token nao retornado: ' + JSON.stringify(data).slice(0, 200));
  }
  console.log('✓ Login SP OK — userId=' + (data.UserId || data.UserIdId));
  return data.Token;
}

async function call(token, path) {
  try {
    const r = await fetch(`${WPA_API}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) {
      return { status: r.status, html: (await r.text()).slice(0, 80) };
    }
    return { status: r.status, json: await r.json() };
  } catch (e) {
    return { status: 0, error: e.message };
  }
}

(async () => {
  const token = await loginSp();

  // Lista setores que a conta SP consegue ver
  console.log('\n=== Setores disponiveis pra conta SP ===');
  const setores = await call(token, '/api/Sectors');
  if (setores.json) {
    const arr = Array.isArray(setores.json) ? setores.json : (setores.json.Data || []);
    console.log('Total setores: ' + arr.length);
    arr.slice(0, 40).forEach(s => {
      console.log('  ' + (s.Code || s.Id) + ' — ' + (s.Description || s.Name || ''));
    });
  } else {
    console.log('Sectors HTTP', setores.status, setores.html || setores.error);
  }

  // Tenta sectorIds candidatos pra SJC + alguns ES pra comparar (devem dar 0 ou nao-autorizado)
  console.log('\n=== Probe sectorIds — Sessions/today ===');
  const candidatos = [
    'DESJ', 'DESJC', 'DESSJ', 'SJC',
    'DESP', 'DEPP', 'DEVL', 'DEJC',
    'DETB', 'DEMG', 'DESAB',
    'DESG', 'DESC',  // ES — comparação (devem dar 403 ou 0)
  ];
  for (const sec of candidatos) {
    const r = await call(token, '/api/Sessions/today?sectorId=' + sec);
    if (r.status === 200 && r.json) {
      const arr = Array.isArray(r.json) ? r.json : (r.json.Data || []);
      const closed = arr.filter(s => s.EndTime).length;
      const open = arr.length - closed;
      console.log('  ' + sec.padEnd(6) + ' HTTP 200 — total=' + arr.length + ' (abertas=' + open + ', encerradas=' + closed + ')');
    } else {
      console.log('  ' + sec.padEnd(6) + ' HTTP ' + r.status + (r.html ? ' [' + r.html.slice(0, 40) + ']' : ''));
    }
  }
})().catch(e => console.error('ERR:', e.message));
