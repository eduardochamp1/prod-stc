/**
 * Lista TODOS os 121 setores que a conta SP vê e filtra os candidatos pra SJC.
 */
const WPA_AUTH = process.env.WPA_URL     || 'https://edp-wpa-po.azurewebsites.net';
const WPA_API  = process.env.WPA_API_URL || 'https://edp-wpa-web-api.azurewebsites.net';

async function loginSp() {
  const body = new URLSearchParams({
    Username: process.env.WPA_USERNAME_SP || '',
    Password: process.env.WPA_PASSWORD_SP || '',
  });
  const res = await fetch(`${WPA_AUTH}/identity/signin`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Login falhou ${res.status}`);
  const data = await res.json();
  return data.Token;
}

async function call(token, path) {
  try {
    const r = await fetch(`${WPA_API}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) return { status: r.status, html: (await r.text()).slice(0, 80) };
    return { status: r.status, json: await r.json() };
  } catch (e) {
    return { status: 0, error: e.message };
  }
}

(async () => {
  const token = await loginSp();
  console.log('✓ Login OK');

  const setores = await call(token, '/api/Sectors');
  const arr = Array.isArray(setores.json) ? setores.json : (setores.json?.Data || []);
  console.log('\nTotal setores: ' + arr.length);

  // 1. Lista TUDO (sem slice)
  console.log('\n=== TODOS os setores ===');
  arr.forEach(s => {
    console.log('  ' + (s.Code || s.Id || '?').padEnd(12) + ' — ' + (s.Description || s.Name || ''));
  });

  // 2. Filtra por keywords SJC/São José/Paulo/SP
  console.log('\n=== Setores com keyword SJC/SAO JOSE/PAULO/SP ===');
  const keywords = ['SAO JOSE', 'SÃO JOSÉ', 'SJC', 'PAULO', ' SP ', '-SP', 'SP)', 'CCM-SJ'];
  const candidatos = arr.filter(s => {
    const desc = String(s.Description || s.Name || '').toUpperCase();
    const code = String(s.Code || '').toUpperCase();
    return keywords.some(k => desc.includes(k) || code.includes(k.trim()));
  });
  candidatos.forEach(s => {
    console.log('  >>> ' + (s.Code || s.Id).padEnd(12) + ' — ' + (s.Description || s.Name || ''));
  });

  // 3. Tenta Sessions/today em todos os setores que contém "DES" + outros
  // (DES = Desligamento, padrão das regionais operativas)
  console.log('\n=== Sessions/today em setores promissores ===');
  const promissores = arr.filter(s => {
    const code = String(s.Code || '').toUpperCase();
    return code.startsWith('DES') || code.startsWith('DEP') || code.includes('CCM') || code.startsWith('DS') || code.startsWith('DM');
  });
  console.log('Testando ' + promissores.length + ' setores...');
  const comDados = [];
  for (const s of promissores) {
    const code = s.Code;
    const r = await call(token, '/api/Sessions/today?sectorId=' + code);
    if (r.status === 200 && r.json) {
      const sessoes = Array.isArray(r.json) ? r.json : (r.json.Data || []);
      if (sessoes.length > 0) {
        comDados.push({ code, desc: s.Description, total: sessoes.length });
      }
    }
  }
  console.log('\nSetores COM atividade hoje:');
  comDados.sort((a, b) => b.total - a.total).forEach(s => {
    console.log('  ' + s.code.padEnd(12) + ' — ' + s.desc + ' — ' + s.total + ' sessões');
  });
})().catch(e => console.error('ERR:', e.message));
