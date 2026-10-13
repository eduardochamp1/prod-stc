/**
 * test/teamsDeslogadasRota.test.js
 *
 * P1-52 (07/10/2026): `/teams/:teamId` era registrada ANTES de
 * `/teams/deslogadas`, então "deslogadas" virava teamId e a rota respondia 404
 * "Equipe não encontrada." — o modo "Todas" do Monitor não mostrava as deslogadas.
 * Este teste sobe o app real (DATA_MODE=mock) e exige que a rota seja alcançada.
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

process.env.NODE_ENV   = 'test';
process.env.DATA_MODE  = 'mock';
process.env.JWT_SECRET = 'test-secret-deslogadas';
process.env.AUTH_USERS = `admin:${sha256('adminpass')}:admin:GUA|CAC|SJC`;

const app = require('../server');

let server, base, token;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'adminpass' }),
  });
  token = (await res.json()).token;
});

after(() => { if (server) server.close(); });

test('GET /api/teams/deslogadas é alcançada (não vira :teamId)', async () => {
  const res  = await fetch(base + '/api/teams/deslogadas', {
    headers: { Authorization: 'Bearer ' + token },
  });
  const json = await res.json();
  assert.strictEqual(res.status, 200);
  assert.notStrictEqual(json.error, 'Equipe não encontrada.');
  assert.ok(Array.isArray(json.teams));
});
