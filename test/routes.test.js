/**
 * test/routes.test.js
 *
 * Testes de CONTRATO de rota (primeiro do projeto — adianta P2-1 do backlog).
 * Sobe o app real em porta aleatória e bate com fetch nativo do Node.
 *
 * Cobre especificamente:
 *   - Login: credencial errada → 401; correta → 200 com regionals[] (v=2)
 *   - Auth: rota protegida sem token → 401
 *   - P0-5: POST /metas com user NÃO-admin regional NÃO pode devolver 403
 *     "NO_REGIONAL" (era o bug — lia req.user.regional singular).
 *
 * Não depende de Postgres: roda em DATA_MODE mock. Rotas que precisam de DB
 * não são exercitadas aqui (ficam pra fixtures do P2-1 completo).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ── Env de teste ANTES de importar o app (middleware/auth lê no load) ─────────
// NODE_ENV=test desliga o override:true do dotenv em server.js — sem isso o .env
// de produção da VM sobrescreve estas credenciais e todo teste de rota dá 401.
process.env.NODE_ENV    = 'test';
process.env.DATA_MODE   = 'mock';
process.env.JWT_SECRET  = 'test-secret-routes';
process.env.CRON_SECRET = 'test-cron-secret';
// 2 usuários: admin (todas) e guarapari (só GUA). Senhas conhecidas.
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

after(() => {
  if (server) server.close();
});

// helper
async function post(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(base + path, {
    method: 'POST', headers, body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
async function get(path, token) {
  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(base + path, { headers });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
async function loginAs(username, password) {
  const { json } = await post('/api/auth/login', { username, password });
  return json.token;
}

// ── LOGIN ─────────────────────────────────────────────────────────────────────

test('POST /api/auth/login: credencial errada → 401', async () => {
  const { status } = await post('/api/auth/login', { username: 'admin', password: 'errada' });
  assert.equal(status, 401);
});

test('POST /api/auth/login: admin correto → 200 com regionals[] e v=2', async () => {
  const { status, json } = await post('/api/auth/login', { username: 'admin', password: 'adminpass' });
  assert.equal(status, 200);
  assert.equal(json.v, 2);
  assert.deepEqual(json.regionals, ['GUA', 'CAC', 'SJC']);
  assert.equal(typeof json.token, 'string');
});

test('POST /api/auth/login: user regional correto → 200 com só sua regional', async () => {
  const { status, json } = await post('/api/auth/login', { username: 'guarapari', password: 'guapass' });
  assert.equal(status, 200);
  assert.deepEqual(json.regionals, ['GUA']);
});

// ── AUTH GUARD ──────────────────────────────────────────────────────────────

test('GET /api/metas sem token → 401', async () => {
  const { status } = await get('/api/metas');
  assert.equal(status, 401);
});

// ── P0-5: POST /metas para não-admin NÃO pode dar 403 NO_REGIONAL ─────────────

test('P0-5: POST /api/metas com user regional NÃO retorna 403 NO_REGIONAL', async () => {
  const token = await loginAs('guarapari', 'guapass');
  assert.ok(token, 'login guarapari deve retornar token');
  // Envia meta pra própria regional (GUA). Antes do fix, o handler lia
  // req.user.regional (singular, undefined no v=2) e devolvia 403 NO_REGIONAL
  // pra QUALQUER não-admin. Agora deve aceitar (ou falhar por DB, mas nunca
  // por "conta sem regional vinculada").
  const { status, json } = await post('/api/metas', { GUA: { LN: 10 } }, token);
  assert.notEqual(json.code, 'NO_REGIONAL',
    'não pode devolver NO_REGIONAL — bug P0-5 estaria de volta');
  assert.notEqual(status, 403,
    `não pode ser 403 (status=${status}, body=${JSON.stringify(json)})`);
});

test('P0-5: POST /api/metas de não-admin com slot de OUTRA regional é filtrado', async () => {
  const token = await loginAs('guarapari', 'guapass');
  // guarapari (só GUA) tenta setar meta de SJC — deve ser rejeitado por
  // "nenhum slot editável" (400), NÃO aceito silenciosamente.
  const { status, json } = await post('/api/metas', { SJC: { LN: 99 } }, token);
  assert.notEqual(json.code, 'NO_REGIONAL');
  // 400 (nenhum slot permitido) é o comportamento correto aqui.
  assert.equal(status, 400, `esperado 400, veio ${status}: ${JSON.stringify(json)}`);
});

// ── P1-4: SSRF no /api/wpa/probe ──────────────────────────────────────────────
// O path é validado ANTES de chamar wpaFetch, então testamos o 400 sem precisar
// de token WPA (o handler rejeita path malicioso na porta de entrada).

async function getRaw(path, token) {
  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(base + path, { headers });
  return res.status;
}

test('P1-4: /api/wpa/probe rejeita path com host embutido (SSRF) → 400', async () => {
  const token = await loginAs('admin', 'adminpass');
  const malicioso = encodeURIComponent('.attacker.com/steal');
  const status = await getRaw(`/api/wpa/probe?path=${malicioso}`, token);
  assert.equal(status, 400, 'path com host deve ser rejeitado antes de tocar a WPA');
});

test('P1-4: /api/wpa/probe rejeita path que não começa com /api/ → 400', async () => {
  const token = await loginAs('admin', 'adminpass');
  const status = await getRaw('/api/wpa/probe?path=' + encodeURIComponent('//evil.com/'), token);
  assert.equal(status, 400);
});

// ── P1-5: rate limit no /auth/login ───────────────────────────────────────────

test('P1-5: 429 após 10 tentativas erradas seguidas (mesmo IP+user)', async () => {
  // 10 tentativas erradas → contador chega no teto; a 11ª deve ser 429.
  for (let i = 0; i < 10; i++) {
    const { status } = await post('/api/auth/login', { username: 'ratelimit-victim', password: 'errada' });
    assert.equal(status, 401, `tentativa ${i + 1} deveria ser 401`);
  }
  const { status, json } = await post('/api/auth/login', { username: 'ratelimit-victim', password: 'errada' });
  assert.equal(status, 429, 'a 11ª tentativa deve ser bloqueada');
  assert.equal(json.code, 'RATE_LIMITED');
});

test('P1-5: login OK zera o contador de tentativas', async () => {
  // 3 erradas, depois 1 certa (zera), depois erradas de novo não devem estourar
  for (let i = 0; i < 3; i++) {
    await post('/api/auth/login', { username: 'admin', password: 'errada' });
  }
  const ok = await post('/api/auth/login', { username: 'admin', password: 'adminpass' });
  assert.equal(ok.status, 200);
  // Após sucesso, novas tentativas erradas recomeçam do zero (não 429 imediato)
  const { status } = await post('/api/auth/login', { username: 'admin', password: 'errada' });
  assert.equal(status, 401);
});

// ── VAZAMENTO REGIONAL (14/07/2026) ───────────────────────────────────────────
// Rotas que ignoravam req.scope.regionals e devolviam dados de TODAS as
// regionais a qualquer user logado (GET /metas, /metas/calculadas, /historico/mes,
// /historico/diario, família /notas/*, /teams/:teamId). O escopo agora é sempre
// aplicado. Em DATA_MODE=mock estas rotas caem no branch !sq, que recorta pelo
// req.scope.regionals — suficiente pra travar a regra contra regressão.

test('vazamento: guarapari pedindo ?regionals=SJC é bloqueado (403) pelo applyScope', async () => {
  const token = await loginAs('guarapari', 'guapass');
  // guarapari só tem GUA — pedir SJC zera a interseção → 403. Fecha o bypass
  // antigo do /notas/* que lia ?regionais cru sem intersectar com o token.
  const { status } = await get('/api/metas?regionals=SJC', token);
  assert.equal(status, 403, `esperado 403, veio ${status}`);
});

test('vazamento: GET /metas de guarapari devolve SÓ a regional dele (não CAC/SJC)', async () => {
  const adminTok = await loginAs('admin', 'adminpass');
  // admin popula as 3 regionais (mock: _metasMemory)
  await post('/api/metas', { GUA: { LN: 10 }, CAC: { LN: 20 }, SJC: { LN: 30 } }, adminTok);

  const guaTok = await loginAs('guarapari', 'guapass');
  const { status, json } = await get('/api/metas', guaTok);
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(json).sort(), ['GUA'],
    `guarapari não pode ver metas de outras regionais — veio ${JSON.stringify(Object.keys(json))}`);
});

test('vazamento: GET /metas de admin devolve todas as regionais', async () => {
  const adminTok = await loginAs('admin', 'adminpass');
  await post('/api/metas', { GUA: { LN: 10 }, CAC: { LN: 20 }, SJC: { LN: 30 } }, adminTok);
  const { status, json } = await get('/api/metas', adminTok);
  assert.equal(status, 200);
  assert.ok(['GUA', 'CAC', 'SJC'].every(r => r in json),
    `admin deve ver as 3 regionais — veio ${JSON.stringify(Object.keys(json))}`);
});

test('vazamento: admin ?regionals=SJC recorta a resposta só pra SJC', async () => {
  const adminTok = await loginAs('admin', 'adminpass');
  await post('/api/metas', { GUA: { LN: 10 }, CAC: { LN: 20 }, SJC: { LN: 30 } }, adminTok);
  const { status, json } = await get('/api/metas?regionals=SJC', adminTok);
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(json).sort(), ['SJC'],
    `escopo explícito deve recortar — veio ${JSON.stringify(Object.keys(json))}`);
});

// ── /teams: contrato de auth + escopo (P2-1) ─────────────────────────────────
// Fecha os bullets literais do P2-1 pra /teams. O 200-path depende de DB (mock
// não tem), então travamos só o contrato de segurança — que roda ANTES do
// handler tocar o banco (authMiddleware → applyScope).

test('P2-1: GET /api/teams sem token → 401', async () => {
  const { status } = await get('/api/teams');
  assert.equal(status, 401);
});

test('P2-1: GET /api/teams?regionals=SJC com token GUA → 403 (applyScope)', async () => {
  const token = await loginAs('guarapari', 'guapass');
  const { status } = await get('/api/teams?regionals=SJC', token);
  assert.equal(status, 403, `guarapari não pode pedir SJC — veio ${status}`);
});

// ── /health: JSON válido (P1-2 / P2-1) ────────────────────────────────────────
// Robusto pros 2 ambientes: sem Postgres (dev/Windows) devolve 503 db:error;
// com Postgres (VM) devolve 200 db:ok. Nos dois casos o CONTRATO do JSON é o
// mesmo — é isso que travamos (nunca HTML/placebo, bug P1-2).

test('P2-1: GET /health → JSON válido com shape esperado (200 ou 503)', async () => {
  const { status, json } = await get('/health');
  assert.ok(status === 200 || status === 503, `status inesperado: ${status}`);
  assert.equal(typeof json.ok, 'boolean', 'ok deve ser boolean');
  assert.equal(typeof json.ts, 'string', 'ts deve ser string ISO');
  assert.ok(json.db === 'ok' || json.db === 'error', `db deve ser ok|error — veio ${json.db}`);
  // Invariante firme: status espelha ok (handler faz res.status(ok?200:503)).
  assert.equal(status === 200, json.ok === true, 'status deve espelhar json.ok');
  // db:error SEMPRE implica não-ok (o contrário não vale: db:ok + snapshot velho
  // também é não-ok — por isso não afirmamos o bicondicional com db).
  if (json.db === 'error') assert.equal(json.ok, false, 'db:error tem que ser ok:false');
});

// NOTA: rotas DB-dependentes (/historico/mes, /historico/diario, /metas/calculadas,
// /notas/*, /teams/:teamId) não têm teste de resposta 200 aqui porque o harness
// roda sem Postgres (sq real → fetch failed → 500). O escopo dessas rotas é
// garantido por: (1) applyScope global bloqueando ?regionals fora do token — ver
// teste do 403 acima; (2) as queries agora exigem/aplicam o array de regionais
// (getMonthTotals/getDailyHistory/getMetasCalculadas/getNotasDeEquipe em
// db/queries.js e db/notasQueries.js). Cobertura 200-path fica pro P2-1 (fixtures
// de DB no backlog).
