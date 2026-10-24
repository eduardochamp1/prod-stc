/**
 * test/wpaAcesso.test.js
 *
 * 24/10/2026 (spec wpa-acesso-edp.md). A EDP passou a recusar o IP da VM com 403
 * "Web App - Unavailable" / "has blocked your access", e em vários pontos a falha
 * virava lista vazia sem erro — os indicadores recebiam vazio ou zero como real.
 * Estes testes garantem que:
 *   - wpaFetch e login LANÇAM WpaAccessError com o code da tabela R2.2;
 *   - 2xx com lista vazia continua sendo dado válido (R2.5);
 *   - quem sonda status (rejectionService) e o classificador seguem distinguindo
 *     404 de falha transiente, e falha do caminho para tudo;
 *   - a coleta por setor para no primeiro erro de caminho (R3.1/R3.4) e o
 *     monitor de notas não grava ciclo com setor falhando;
 *   - scripts/check-wpa.js sai com 1 no bloqueio de IP e 0 quando a API responde.
 * Tudo contra um servidor HTTP LOCAL (127.0.0.1) — a suíte não toca a EDP (P1-40).
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

// HTML que a VM recebeu da EDP em 24/10/2026 (resumido).
const PAGINA_IP = '<html><head><title>Web App - Unavailable</title></head><body>' +
  '<h1>Error 403 - Forbidden</h1><p>The web app you have attempted to reach has blocked your access.</p></body></html>';

const hits = [];
let modoSignin = 'ok';      // 'ok' | 'bloqueado'
let modoRaiz = 'ok';        // 'ok' | 'bloqueado'
let server;
let wpa;
let erros;

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

before(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url);
    const url = req.url.split('?')[0];
    if (url === '/identity/signin') {
      if (modoSignin === 'bloqueado') { res.writeHead(403, { 'Content-Type': 'text/html' }); return res.end(PAGINA_IP); }
      const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64');
      return json(res, 200, { Token: `h.${payload}.s`, Data: true, Error: null });
    }
    if (url === '/') {
      if (modoRaiz === 'bloqueado') { res.writeHead(403, { 'Content-Type': 'text/html' }); return res.end(PAGINA_IP); }
      res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>ok</html>');
    }
    if (url === '/api/ok') return json(res, 200, { Data: [{ Id: 1 }] });
    if (url === '/api/vazio') return json(res, 200, { Data: [] });
    if (url === '/api/bloqueado') { res.writeHead(403, { 'Content-Type': 'text/html' }); return res.end(PAGINA_IP); }
    if (url === '/api/404') return json(res, 404, { Message: 'não existe' });
    if (url === '/api/500') return json(res, 500, { Message: 'erro interno' });
    if (url === '/api/429') return json(res, 429, { Message: 'calma' });
    if (url === '/api/html200') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>login</html>'); }
    if (url === '/api/texto-json') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('{"Data":[]}'); }
    if (url.startsWith('/api/notes/n404')) return json(res, 404, {});
    if (url.startsWith('/api/notes/n500')) return json(res, 500, {});
    if (url.startsWith('/api/notes/n502')) return json(res, 502, {});
    // monitor de notas: um setor falha, os outros respondem
    if (url === '/api/Teams/Simple' || url.startsWith('/api/Teams/Simple')) return json(res, 200, { Data: [] });
    if (url === '/api/Notes/NotesStatusFilterBySector') {   // setor vai no corpo do POST
      let corpo = '';
      req.on('data', c => { corpo += c; });
      req.on('end', () => (corpo.includes('DEPT') ? json(res, 500, {}) : json(res, 200, { Data: [] })));
      return;
    }
    return json(res, 404, {});
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // Antes do require: WPA_AUTH/WPA_API são lidos no load do módulo.
  process.env.NODE_ENV = 'test';   // check-wpa não pode sobrescrever com o .env real
  process.env.WPA_URL = base;
  process.env.WPA_API_URL = base;
  process.env.WPA_USERNAME = 'teste@local';
  process.env.WPA_PASSWORD = 'senha-de-teste';
  delete process.env.WPA_PROXY;
  delete process.env.WPA_ACCOUNTS_DISABLED;
  erros = require('../services/wpaErros');
  wpa = require('../services/wpaService');
  wpa._breakerHydration.done = true;   // sem banco: nada de breaker persistido
});

after(() => new Promise(r => server.close(r)));

beforeEach(() => { hits.length = 0; modoSignin = 'ok'; modoRaiz = 'ok'; });

async function falha(promessa) {
  try { await promessa; } catch (err) { return err; }
  assert.fail('deveria ter lançado');
}

// ── R2: wpaFetch ──────────────────────────────────────────────────────────────

test('2xx: devolve a Response; lista vazia é dado válido (R2.5)', async () => {
  const ok = await wpa.wpaFetch('/api/ok');
  assert.deepEqual((await ok.json()).Data, [{ Id: 1 }]);
  const vazio = await wpa.wpaFetch('/api/vazio');
  assert.deepEqual((await vazio.json()).Data, []);
});

test('403 com a página de restrição do Azure: WPA_IP_BLOQUEADO, sem retry', async () => {
  const err = await falha(wpa.wpaFetch('/api/bloqueado'));
  assert.equal(err.name, 'WpaAccessError');
  assert.equal(err.code, 'WPA_IP_BLOQUEADO');
  assert.equal(err.status, 403);
  assert.equal(err.path, '/api/bloqueado');
  assert.match(err.message, /blocked your access/);
  assert.doesNotMatch(err.message, /<html|<h1/, 'HTML reduzido a texto');
  assert.equal(hits.filter(h => h === '/api/bloqueado').length, 1, 'não trata como cold-start');
  assert.ok(erros.ehFalhaDeCaminho(err));
});

test('outro status fora de 2xx: WPA_HTTP_<status> (não devolve Response)', async () => {
  assert.equal((await falha(wpa.wpaFetch('/api/404'))).code, 'WPA_HTTP_404');
  assert.equal((await falha(wpa.wpaFetch('/api/500'))).code, 'WPA_HTTP_500');
  const e429 = await falha(wpa.wpaFetch('/api/429'));
  assert.equal(e429.code, 'WPA_HTTP_429');
  assert.equal(e429.status, 429);
  assert.match(e429.message, /calma/, 'corpo resumido na mensagem');
});

test('2xx que não é JSON: WPA_RESPOSTA_INVALIDA; texto que é JSON passa', async () => {
  assert.equal((await falha(wpa.wpaFetch('/api/html200'))).code, 'WPA_RESPOSTA_INVALIDA');
  const r = await wpa.wpaFetch('/api/texto-json');
  assert.deepEqual(await r.json(), { Data: [] });
});

test('mensagem do erro nunca leva token nem senha', async () => {
  const err = await falha(wpa.wpaFetch('/api/429'));
  assert.doesNotMatch(err.message, /Bearer|h\.[A-Za-z0-9=]+\.s|senha-de-teste/);
});

test('rede sem proxy (porta fechada): WPA_REDE', async () => {
  const { wpaHttpFetch } = require('../services/wpaHttp');
  const err = await falha(wpaHttpFetch('http://127.0.0.1:1/api/x'));
  assert.equal(err.code, 'WPA_REDE');
});

// ── R2: login ─────────────────────────────────────────────────────────────────

test('login com IP bloqueado: WPA_IP_BLOQUEADO na 1ª tentativa, sem retry nem breaker', async () => {
  modoSignin = 'bloqueado';
  const err = await falha(wpa.loginAttempt ? wpa.loginAttempt('es') : wpa.login());
  assert.equal(err.code, 'WPA_IP_BLOQUEADO');
  hits.length = 0;
  const err2 = await falha(wpa.login());
  assert.equal(err2.code, 'WPA_IP_BLOQUEADO');
  assert.equal(hits.filter(h => h === '/identity/signin').length, 1, 'falha de caminho não retenta o /signin');
});

// ── R3.2: quem depende do status ──────────────────────────────────────────────

test('rejectionService: 404 e 500 seguem como resposta da sondagem; o resto sobe', async () => {
  const { _tryEndpoint } = require('../services/rejectionService');
  assert.deepEqual(await _tryEndpoint('n404', 'x'), { ok: false, status: 404 });
  assert.deepEqual(await _tryEndpoint('n500', 'x'), { ok: false, status: 500 });
  const err = await falha(_tryEndpoint('n502', 'x'));
  assert.equal(err.code, 'WPA_HTTP_502', '502 não vira "sem 200" com estrutura vazia gravada');
});

test('classificador: 404 → null (definitivo); 5xx/429 → FETCH_FAILED (retenta); caminho → lança', async () => {
  const { _safeJson, _FETCH_FAILED } = require('../services/classifierService');
  assert.equal(await _safeJson('/api/404'), null);
  assert.equal(await _safeJson('/api/500'), _FETCH_FAILED);
  assert.equal(await _safeJson('/api/429'), _FETCH_FAILED, '4xx que não é 404 não grava OUTROS');
  const err = await falha(_safeJson('/api/bloqueado'));
  assert.equal(err.code, 'WPA_IP_BLOQUEADO');
});

// ── R3.1 / R3.4: coleta por setor e monitor de notas ──────────────────────────

test('coleta por setor: falha de caminho para os setores seguintes e não repete', async () => {
  const { _coletarSetores } = require('../services/dataService');
  const tentados = [];
  let dormiu = false;
  const { resultados, report } = await _coletarSetores(['DESG', 'DEPT', 'DESC'], {
    coletar: async (s) => {
      tentados.push(s);
      throw new erros.WpaAccessError('WPA_PROXY_INDISPONIVEL', { host: 'h', path: '/p' });
    },
    desativado: () => false,
    repetirFalhos: true,
    dormir: async () => { dormiu = true; },
  });
  assert.deepEqual(tentados, ['DESG']);
  assert.equal(dormiu, false);
  assert.deepEqual(resultados, []);
  assert.equal(report.caminho, 'WPA_PROXY_INDISPONIVEL');
  assert.deepEqual(report.failed.map(f => [f.sector, f.code]),
    [['DESG', 'WPA_PROXY_INDISPONIVEL'], ['DEPT', 'WPA_PROXY_INDISPONIVEL'], ['DESC', 'WPA_PROXY_INDISPONIVEL']]);
});

test('coleta por setor: erro de endpoint num setor não impede os outros (comportamento de antes)', async () => {
  const { _coletarSetores } = require('../services/dataService');
  const { resultados, report } = await _coletarSetores(['DESG', 'DEPT'], {
    coletar: async (s) => {
      if (s === 'DESG') throw new erros.WpaAccessError('WPA_HTTP_500', { status: 500 });
      return [{ setor: s }];
    },
    desativado: () => false,
  });
  assert.deepEqual(resultados, [[{ setor: 'DEPT' }]]);
  assert.deepEqual(report.failed.map(f => f.code), ['WPA_HTTP_500']);
  assert.equal(report.caminho, undefined);
});

test('monitor de notas: setor falhando derruba o ciclo — nada gravado', async () => {
  const { collectSnapshot } = require('../services/notasMonitor');
  const r = await collectSnapshot();   // DEPT responde 500; grava nada (nem toca o banco)
  assert.equal(r.falhou, true);
  assert.equal(r.inserted, 0);
  assert.ok(r.falhas.some(f => f.sector === 'DEPT' && f.code === 'WPA_HTTP_500'));
});

// ── R5: scripts/check-wpa.js ──────────────────────────────────────────────────

test('check-wpa: sai com 1 e mostra WPA_IP_BLOQUEADO; 0 quando a API responde', async () => {
  const { main } = require('../scripts/check-wpa');
  const linhas = [];
  modoRaiz = 'bloqueado';
  assert.equal(await main(['--proxy', 'none'], l => linhas.push(l)), 1);
  assert.ok(linhas.some(l => /API de dados.*403.*WPA_IP_BLOQUEADO/.test(l)), linhas.join('\n'));
  modoRaiz = 'ok';
  assert.equal(await main(['--proxy', 'none'], () => {}), 0);
});

test('check-wpa: proxy morto → WPA_PROXY_INDISPONIVEL e sai com 1', async () => {
  const { main } = require('../scripts/check-wpa');
  const linhas = [];
  // URL https: o proxy só entra em https (http é só teste local).
  const antes = process.env.WPA_API_URL;
  process.env.WPA_API_URL = 'https://edp-wpa-web-api.azurewebsites.net';
  try {
    assert.equal(await main(['--proxy', 'http://127.0.0.1:1'], l => linhas.push(l)), 1);
  } finally {
    process.env.WPA_API_URL = antes;
    delete process.env.WPA_PROXY;
  }
  assert.ok(linhas.some(l => /NÃO aceita conexão/.test(l)));
  assert.ok(linhas.some(l => /API de dados.*WPA_PROXY_INDISPONIVEL/.test(l)), linhas.join('\n'));
});

// ── Achados da revisão (24/10/2026) ───────────────────────────────────────────

test('página de cold-start (só o título "Web App - Unavailable") NÃO é bloqueio de IP', () => {
  const coldStart = '<html><head><title>Web App - Unavailable</title></head><body><h1>Error 403 - This web app is stopped.</h1></body></html>';
  assert.equal(erros.ehPaginaIpBloqueado(403, coldStart), false, 'cold-start segue com retry');
  assert.equal(erros.ehPaginaIpBloqueado(403, PAGINA_IP), true);
  assert.equal(erros.ehPaginaIpBloqueado(503, PAGINA_IP), false, 'só 403');
});

test('painel na espera pós-falha repete a falha COM o code (senão /api/teams voltava 200 vazio)', async () => {
  wpa._falhaSetor.set('DESG', { ts: Date.now(), msg: 'WPA_PROXY_INDISPONIVEL host=h', name: 'WpaAccessError', code: 'WPA_PROXY_INDISPONIVEL', status: null });
  try {
    const err = await falha(wpa.getTeamsBySector('DESG', { aceitaCache: true }));
    assert.equal(err.esperaPosFalha, true);
    assert.equal(err.code, 'WPA_PROXY_INDISPONIVEL');
    assert.ok(erros.ehFalhaDeCaminho(err));
  } finally {
    wpa._falhaSetor.delete('DESG');
  }
});
