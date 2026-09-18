/**
 * test/equipesImportHttp.test.js
 *
 * Contrato HTTP de POST /api/admin/equipes/importar — a rota grava cadastro
 * que muda número reportado, então quem pode chamá-la importa tanto quanto o
 * que ela faz.
 *
 * Sobe o app real em porta aleatória, no molde do test/routes.test.js. Roda em
 * DATA_MODE=mock: não exercita o caminho de banco (isso é o
 * test/equipesImport.test.js, sobre a função pura), só o portão.
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Env ANTES de importar o app — middleware/auth lê no load, e NODE_ENV=test
// desliga o override do dotenv (senão o .env da VM clobba estas credenciais).
process.env.NODE_ENV   = 'test';
process.env.DATA_MODE  = 'mock';
process.env.JWT_SECRET = 'test-secret-import';
process.env.AUTH_USERS = [
  `admin:${sha256('adminpass')}:admin:GUA|CAC|SJC`,
  `guarapari:${sha256('guapass')}:user:GUA`,
].join(',');

const app = require('../server');

let server, base;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => { if (server) server.close(); });

async function post(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res  = await fetch(base + path, {
    method: 'POST', headers, body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function loginAs(username, password) {
  const { json } = await post('/api/auth/login', { username, password });
  return json.token;
}

const CORPO_OK = {
  dryRun: true, regional: 'GUA', setor: 'DESG', tipoPadrao: 'CS', linhas: [],
};

test('sem token → 401', async () => {
  const { status } = await post('/api/admin/equipes/importar', CORPO_OK);
  assert.equal(status, 401);
});

test('usuário não-admin → 403', async () => {
  // A rota grava whitelist, que decide o que entra no número reportado à EDP.
  // O portão é o router.use('/admin', requireAdmin).
  const token = await loginAs('guarapari', 'guapass');
  const { status } = await post('/api/admin/equipes/importar', CORPO_OK, token);
  assert.equal(status, 403);
});

test('admin com `linhas` ausente → 400, não 500', async () => {
  const token = await loginAs('admin', 'adminpass');
  const { status, json } = await post('/api/admin/equipes/importar',
    { dryRun: true, regional: 'GUA', setor: 'DESG', tipoPadrao: 'CS' }, token);
  assert.equal(status, 400);
  assert.match(json.error, /linhas/);
});

test('admin com `linhas` que não é array → 400', async () => {
  const token = await loginAs('admin', 'adminpass');
  const { status } = await post('/api/admin/equipes/importar',
    { ...CORPO_OK, linhas: 'EBGPR62' }, token);
  assert.equal(status, 400);
});
