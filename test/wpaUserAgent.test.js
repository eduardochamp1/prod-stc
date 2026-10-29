/**
 * test/wpaUserAgent.test.js
 *
 * INCIDENTE 16/10/2026 (backlog P0-10). A EDP passou a responder HTTP 200 com
 * {"Message":"Nenhum dado encontrado."} para o User-Agent padrão do node-fetch
 * (`node-fetch/1.0 (+https://github.com/bitinn/node-fetch)`). Mesmo token, mesma
 * VM, outro UA: 73 sessões em DESG/16-10. Ninguém viu erro — o painel ficou
 * zerado de sexta à noite a domingo.
 *
 * Estes testes garantem que login e wpaFetch NUNCA saem com o UA padrão, e que
 * ninguém volta a importar node-fetch direto nos arquivos que falam com a EDP.
 * Tudo contra um servidor HTTP LOCAL (127.0.0.1) — a suíte não toca a EDP (P1-40).
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');

const UA_NODE_FETCH = 'node-fetch/1.0 (+https://github.com/bitinn/node-fetch)';

const recebidos = [];   // { url, ua, accept }
let server;
let wpa;
let wpaHttp;

before(async () => {
  server = http.createServer((req, res) => {
    recebidos.push({ url: req.url, ua: req.headers['user-agent'], accept: req.headers.accept });
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/identity/signin')) {
      // JWT com exp daqui a 1h — só o payload importa pro wpaService.
      const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64');
      res.end(JSON.stringify({ Token: `h.${payload}.s`, Data: true, Error: null }));
      return;
    }
    res.end(JSON.stringify({ Data: [] }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // Antes do require: WPA_AUTH/WPA_API são lidos no load do módulo.
  process.env.WPA_URL = base;
  process.env.WPA_API_URL = base;
  process.env.WPA_USERNAME = 'teste@local';
  process.env.WPA_PASSWORD = 'senha-de-teste';
  delete process.env.WPA_USER_AGENT;
  wpaHttp = require('../services/wpaHttp');
  wpa = require('../services/wpaService');
  wpa._breakerHydration.done = true;   // sem banco: nada de breaker persistido
});

after(() => new Promise(r => server.close(r)));

test('wpaHttpFetch manda o UA próprio por default', async () => {
  recebidos.length = 0;
  await wpaHttp.wpaHttpFetch(`${process.env.WPA_API_URL}/api/x`);
  assert.equal(recebidos[0].ua, wpaHttp.WPA_USER_AGENT_PADRAO);
  assert.notEqual(recebidos[0].ua, UA_NODE_FETCH);
});

test('WPA_USER_AGENT no .env troca o UA sem deploy', async () => {
  recebidos.length = 0;
  process.env.WPA_USER_AGENT = 'EngelmigWpaMonitor/9.9';
  try {
    await wpaHttp.wpaHttpFetch(`${process.env.WPA_API_URL}/api/x`);
  } finally {
    delete process.env.WPA_USER_AGENT;
  }
  assert.equal(recebidos[0].ua, 'EngelmigWpaMonitor/9.9');
});

test('headers de quem chama são preservados (Headers ou objeto)', async () => {
  const { Headers } = require('node-fetch');
  recebidos.length = 0;
  await wpaHttp.wpaHttpFetch(`${process.env.WPA_API_URL}/api/x`, { headers: new Headers({ Accept: 'application/json' }) });
  assert.equal(recebidos[0].ua, wpaHttp.WPA_USER_AGENT_PADRAO);
  assert.equal(recebidos[0].accept, 'application/json');
});

test('login (/identity/signin) sai com UA diferente do node-fetch', async () => {
  recebidos.length = 0;
  wpa._tokens.delete('es');
  await wpa.login('es');
  const signin = recebidos.find(r => r.url.startsWith('/identity/signin'));
  assert.ok(signin, 'o login chegou ao servidor local');
  assert.equal(signin.ua, wpaHttp.WPA_USER_AGENT_PADRAO);
});

test('wpaFetch (Web API) sai com UA diferente do node-fetch', async () => {
  recebidos.length = 0;
  wpa._tokens.set('es', { token: 'jwt-teste', expireAt: Date.now() + 3600_000 });
  const res = await wpa.wpaFetch('/api/Sessions/all/date?sectorId=DESG&date=10%2F16%2F2026', { method: 'POST' });
  assert.equal(res.status, 200);
  const api = recebidos.find(r => r.url.startsWith('/api/Sessions'));
  assert.ok(api, 'a chamada chegou ao servidor local');
  assert.equal(api.ua, wpaHttp.WPA_USER_AGENT_PADRAO);
});

test('nenhum arquivo que fala com a EDP importa node-fetch direto', () => {
  const raiz = path.join(__dirname, '..');
  for (const f of ['services/wpaService.js', 'routes/index.js']) {
    const src = fs.readFileSync(path.join(raiz, f), 'utf8');
    assert.doesNotMatch(src, /require\(\s*['"]node-fetch['"]\s*\)/,
      `${f} importa node-fetch direto — use services/wpaHttp.js (P0-10)`);
  }
});
