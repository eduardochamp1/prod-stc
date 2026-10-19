/**
 * test/killSwitchTotal.test.js
 *
 * 19/10/2026 (backlog P0-11). A EDP passou a recusar 100% das nossas
 * requisições depois de reclamar do volume, e desativar as contas
 * (WPA_ACCOUNTS_DISABLED) não parava tudo: o wpaFetch usava o token já
 * guardado, e os retries do cron (retry-outros, retry-rejeicoes) seguiam batendo
 * na EDP. Agora conta desativada não envia NADA.
 *
 * O módulo aponta para um servidor LOCAL ANTES de carregar (WPA_API é lido no
 * load): se o kill-switch falhar, a requisição cai aqui e o teste acusa — nunca
 * na EDP de verdade (P1-40).
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

let server;
let recebidas = 0;
let wpa;

before(async () => {
  server = http.createServer((req, res) => { recebidas++; res.setHeader('Content-Type', 'application/json'); res.end('{}'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.WPA_URL = base;
  process.env.WPA_API_URL = base;
  process.env.WPA_USERNAME = 'teste@local';
  process.env.WPA_PASSWORD = 'senha-de-teste';
  require('../services/wpaContador')._aoFecharHora(() => {});
  wpa = require('../services/wpaService');
  wpa._breakerHydration.done = true;
});

after(() => { require('../services/wpaContador')._aoFecharHora(null); return new Promise(r => server.close(r)); });

beforeEach(() => { recebidas = 0; wpa._disabledAccounts.clear(); });

test('conta desativada: wpaFetch NÃO envia requisição, nem com token guardado', async () => {
  // Token válido em memória: antes, isto bastava para a requisição sair.
  wpa._tokens.set('es', { token: 'tok-guardado', expireAt: Date.now() + 3600_000 });
  wpa._disabledAccounts.add('es');
  for (const p of ['/api/Notes/x/details/optimized?sectorId=DESG', '/api/notes/dd?noteId=x', '/api/qualquer']) {
    await assert.rejects(() => wpa.wpaFetch(p), (err) => {
      assert.equal(err.isAccountDisabled, true);
      assert.match(err.message, /não enviado/);
      return true;
    });
  }
  await assert.rejects(() => wpa.wpaFetch('/api/x', { account: 'es' }), /DESATIVADA/);
  assert.equal(recebidas, 0, 'nada chegou ao servidor');
  wpa._tokens.delete('es');
});

test('controle: conta ATIVA com token guardado envia normalmente', async () => {
  wpa._tokens.set('es', { token: 'tok-guardado', expireAt: Date.now() + 3600_000 });
  const r = await wpa.wpaFetch('/api/qualquer');
  assert.equal(r.ok, true);
  assert.equal(recebidas, 1);
  wpa._tokens.delete('es');
});

test('desativar só a primária de SJC cai na backup — o setor não é barrado', () => {
  wpa._disabledAccounts.add('sp');
  assert.equal(wpa._resolveUsableAccount('DSSJ'), 'sp2');
  assert.equal(wpa.isAccountDisabled(wpa._resolveUsableAccount('DSSJ')), false);
});
