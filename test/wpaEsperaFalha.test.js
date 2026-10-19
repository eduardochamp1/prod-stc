/**
 * test/wpaEsperaFalha.test.js
 *
 * 19/10/2026 (backlog P0-11). No dia em que a EDP passou a recusar 100% das
 * nossas requisições, cada aba do painel tentava a coleta de novo a cada
 * atualização — 972 recusadas numa hora só do painel. Agora, depois de uma
 * falha de setor, o painel espera antes de tentar aquele setor de novo; o cron
 * (fresco) segue tentando e limpa a marca quando a EDP volta.
 * Servidor LOCAL (127.0.0.1) — a suíte não toca a EDP (P1-40).
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

let server;
let wpa;
let bloquear = false;
let dados = 0;   // requisições à Web API (fora o login)

before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/identity/signin')) {
      const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64');
      return res.end(JSON.stringify({ Token: `h.${payload}.s`, Data: true, Error: null }));
    }
    dados++;
    if (bloquear) { res.statusCode = 403; return res.end('{"Message":"blocked"}'); }
    res.end(JSON.stringify({ Data: [] }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.WPA_URL = base;
  process.env.WPA_API_URL = base;
  process.env.WPA_USERNAME = 'teste@local';
  process.env.WPA_PASSWORD = 'senha-de-teste';
  delete process.env.WPA_ACCOUNTS_DISABLED;
  delete process.env.WPA_PAINEL_ESPERA_FALHA_MS;
  require('../services/wpaContador')._aoFecharHora(() => {});
  wpa = require('../services/wpaService');
  wpa._breakerHydration.done = true;
});

after(() => { require('../services/wpaContador')._aoFecharHora(null); return new Promise(r => server.close(r)); });

beforeEach(() => { wpa._cacheSetor.clear(); wpa._falhaSetor.clear(); bloquear = false; dados = 0; });

test('pura: dentro da espera devolve a falha; depois dela, null; espera 0 desliga', () => {
  const m = new Map([['DESG', { ts: 1_000_000, msg: 'WPA sessions/date 403' }]]);
  assert.equal(wpa._falhaRecente(m, 'DESG', 300_000, 1_000_000 + 299_999).msg, 'WPA sessions/date 403');
  assert.equal(wpa._falhaRecente(m, 'DESG', 300_000, 1_000_000 + 300_000), null);
  assert.equal(wpa._falhaRecente(m, 'DESG', 0, 1_000_000), null);
  assert.equal(wpa._falhaRecente(m, 'DESC', 300_000, 1_000_000), null);
});

test('depois de falha, o painel responde a falha SEM ir à EDP', async () => {
  bloquear = true;
  await assert.rejects(wpa.getTeamsBySector('DESG', { aceitaCache: true }), /403/);
  const depoisDaFalha = dados;
  assert.ok(depoisDaFalha > 0);
  for (let i = 0; i < 5; i++) {
    await assert.rejects(wpa.getTeamsBySector('DESG', { aceitaCache: true }), (err) => {
      assert.equal(err.esperaPosFalha, true);
      assert.match(err.message, /403/);
      assert.match(err.message, /painel aguarda \d+s/);
      return true;
    });
  }
  assert.equal(dados, depoisDaFalha, '5 atualizações do painel, zero requisição');
});

test('o cron (fresco) não espera: tenta, e o sucesso limpa a marca', async () => {
  bloquear = true;
  await assert.rejects(wpa.getTeamsBySector('DESG', { aceitaCache: true }));
  const n1 = dados;
  await assert.rejects(wpa.getTeamsBySector('DESG'), /403/);
  assert.ok(dados > n1, 'o cron foi à EDP');
  bloquear = false;
  await wpa.getTeamsBySector('DESG');
  assert.equal(wpa._falhaSetor.has('DESG'), false);
  const n2 = dados;
  await wpa.getTeamsBySector('DESG', { aceitaCache: true });   // agora do cache de sucesso
  assert.equal(dados, n2);
});

test('passada a espera, o painel volta a tentar', async () => {
  bloquear = true;
  await assert.rejects(wpa.getTeamsBySector('DESG', { aceitaCache: true }));
  wpa._falhaSetor.get('DESG').ts -= 5 * 60_000;   // a falha foi há 5 min
  const n1 = dados;
  await assert.rejects(wpa.getTeamsBySector('DESG', { aceitaCache: true }), /403/);
  assert.ok(dados > n1);
});

test('a espera é por setor: falha em DESG não segura DESC', async () => {
  bloquear = true;
  await assert.rejects(wpa.getTeamsBySector('DESG', { aceitaCache: true }));
  bloquear = false;
  const teams = await wpa.getTeamsBySector('DESC', { aceitaCache: true });
  assert.ok(Array.isArray(teams));
});
