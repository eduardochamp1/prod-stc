/**
 * test/settingsScope.test.js
 *
 * Trava a correção de segurança de 13/08/2026 em GET/PUT /api/settings/:key.
 *
 * Antes, a rota lia/gravava QUALQUER chave de app_settings só com autenticação —
 * sem checar dono nem role. app_settings é compartilhada e guarda estado
 * operacional protegido por rotas dedicadas (metas_diarias, contador-transgressao,
 * desloc-threshold, snapshot_last_ok, drift_last_*). Pela rota genérica, uma conta
 * comum reabria tudo isso SEM guarda → escalonamento de privilégio + IDOR (ler o
 * monitor-filters de outra conta).
 *
 * Regra: a rota só serve a preferência do PRÓPRIO usuário —
 * `monitor-filters:<username-do-token>`. Qualquer outra chave → 403.
 *
 * Roda em DATA_MODE mock: o guard de escopo dispara ANTES de tocar no banco,
 * então dá pra afirmar o 403 sem Postgres. A chave própria passa o guard e cai no
 * caminho sem-DB (GET → {} 200; PUT → 503), o que já prova que a guarda liberou.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

process.env.NODE_ENV    = 'test';
process.env.DATA_MODE   = 'mock';
process.env.JWT_SECRET  = 'test-secret-settings';
process.env.CRON_SECRET = 'test-cron-secret';
process.env.AUTH_USERS = [
  `admin:${sha256('adminpass')}:admin:GUA|CAC|SJC`,
  `guarapari:${sha256('guapass')}:user:GUA`,
].join(',');

const app = require('../server');

let server, base, tokAdmin, tokGua;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  tokAdmin = await loginAs('admin', 'adminpass');
  tokGua   = await loginAs('guarapari', 'guapass');
});

after(() => { if (server) server.close(); });

async function req(method, path, token, body) {
  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
async function loginAs(username, password) {
  const { json } = await req('POST', '/api/auth/login', null, { username, password });
  return json.token;
}

// ── A chave do PRÓPRIO usuário passa o guard ──────────────────────────────────

test('GET a própria monitor-filters passa o guard (200, sem DB devolve {})', async () => {
  const { status } = await req('GET', '/api/settings/monitor-filters:guarapari', tokGua);
  assert.equal(status, 200, 'a própria chave não pode ser bloqueada');
});

test('PUT na própria monitor-filters passa o guard (chega no DB — 503 em mock)', async () => {
  const { status } = await req('PUT', '/api/settings/monitor-filters:admin', tokAdmin, { regionals: ['GUA'] });
  assert.equal(status, 503, 'passou o guard e caiu no caminho sem-DB (mock)');
});

// ── IDOR: ler/escrever a chave de OUTRA conta é bloqueado ─────────────────────

test('GET a monitor-filters de OUTRO usuário → 403', async () => {
  const { status, json } = await req('GET', '/api/settings/monitor-filters:admin', tokGua);
  assert.equal(status, 403);
  assert.equal(json.code, 'SETTINGS_SCOPE');
});

test('PUT na monitor-filters de OUTRO usuário → 403', async () => {
  const { status } = await req('PUT', '/api/settings/monitor-filters:guarapari', tokAdmin, { x: 1 });
  assert.equal(status, 403);
});

// ── Escalonamento de privilégio: chaves operacionais são inalcançáveis ─────────

test('nem o admin escreve estado operacional pela rota genérica (metas_diarias → 403)', async () => {
  // metas_diarias tem rota dedicada que valida regional por conta; a genérica não.
  const { status } = await req('PUT', '/api/settings/metas_diarias', tokAdmin, { GUA: { x: 999 } });
  assert.equal(status, 403, 'metas só pela rota dedicada, mesmo pra admin');
});

test('conta comum não forja saúde do cron (snapshot_last_ok → 403)', async () => {
  const { status } = await req('PUT', '/api/settings/snapshot_last_ok', tokGua, { at: 'fake' });
  assert.equal(status, 403);
});

test('conta comum não zera o contador de transgressão (→ 403)', async () => {
  const { status } = await req('PUT', '/api/settings/contador-transgressao', tokGua, { GUA: '2026-01-01' });
  assert.equal(status, 403);
});

test('GET de chave operacional arbitrária também é bloqueado', async () => {
  const { status } = await req('GET', '/api/settings/drift_last_repair', tokGua);
  assert.equal(status, 403);
});

// ── Sem token continua 401 (auth antes do guard de escopo) ────────────────────

test('sem token → 401 (não 403): a autenticação vem antes', async () => {
  const { status } = await req('GET', '/api/settings/monitor-filters:guarapari', null);
  assert.equal(status, 401);
});
