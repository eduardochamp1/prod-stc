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
// 3 usuários: admin (todas), guarapari (só GUA) e saopaulo (só SJC). Senhas
// conhecidas. `saopaulo` existe pro P1-38: o default de sectorId da rota
// /wpa/nota é 'DESG' (GUA), então só um usuário SEM GUA prova que o default
// não fura o escopo.
process.env.AUTH_USERS = [
  `admin:${sha256('adminpass')}:admin:GUA|CAC|SJC`,
  `guarapari:${sha256('guapass')}:user:GUA`,
  `saopaulo:${sha256('sppass')}:user:SJC`,
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

// ── /metas-diarias (metas diárias da box Produtividade — separadas de /metas) ──

test('metas-diarias: sem token → 401', async () => {
  const { status } = await get('/api/metas-diarias');
  assert.equal(status, 401);
});

test('metas-diarias: admin grava e GET devolve (por regional × card)', async () => {
  const adminTok = await loginAs('admin', 'adminpass');
  await post('/api/metas-diarias', { GUA: { LN: 8, C93: 3 }, SJC: { LN: 5 } }, adminTok);
  const { status, json } = await get('/api/metas-diarias', adminTok);
  assert.equal(status, 200);
  assert.equal(json.GUA.LN, 8);
  assert.equal(json.GUA.C93, 3);
  assert.equal(json.SJC.LN, 5);
});

test('metas-diarias: guarapari só grava a dele; slot de OUTRA regional é ignorado', async () => {
  const guaTok = await loginAs('guarapari', 'guapass');
  // tenta gravar GUA (permitido) e SJC (fora do escopo) — SJC deve ser descartado
  const { status, json } = await post('/api/metas-diarias', { GUA: { L0: 7 }, SJC: { L0: 99 } }, guaTok);
  assert.equal(status, 200);
  assert.deepEqual(json.updated, ['GUA'], `só GUA deve ser aceito — veio ${JSON.stringify(json.updated)}`);
  // e o GET dele não vaza SJC
  const r = await get('/api/metas-diarias', guaTok);
  assert.deepEqual(Object.keys(r.json).sort(), ['GUA']);
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

// ── P2-3: static só do public/ (não vaza a raiz do repo) ─────────────────────

test('P2-3: GET /server.js → 404 (código-fonte não é servido)', async () => {
  const res = await fetch(base + '/server.js');
  assert.equal(res.status, 404, 'server.js não pode ser lido por HTTP');
});

test('P2-3: GET /logs/out.log → 404 (logs não são servidos)', async () => {
  const res = await fetch(base + '/logs/out.log');
  assert.equal(res.status, 404);
});

test('P2-3: GET /services/dataService.js → 404 (services não vazam)', async () => {
  const res = await fetch(base + '/services/dataService.js');
  assert.equal(res.status, 404);
});

test('P2-3: GET / → 200 HTML (painel continua servindo do public/)', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
});

// ── P2-8: CSS extraído pra public/css/app.css ────────────────────────────────

test('P2-8: GET /css/app.css → 200 text/css com as variáveis de tema', async () => {
  const res = await fetch(base + '/css/app.css');
  assert.equal(res.status, 200, 'app.css tem que ser servido do public/');
  assert.match(res.headers.get('content-type') || '', /text\/css/);
  const body = await res.text();
  assert.match(body, /--verde/, 'o CSS extraído deve conter as variáveis de tema');
});

// NOTA: rotas DB-dependentes (/historico/mes, /historico/diario, /metas/calculadas,
// /notas/*, /teams/:teamId) não têm teste de resposta 200 aqui porque o harness
// roda sem Postgres (sq real → fetch failed → 500). O escopo dessas rotas é
// garantido por: (1) applyScope global bloqueando ?regionals fora do token — ver
// teste do 403 acima; (2) as queries agora exigem/aplicam o array de regionais
// (getMonthTotals/getDailyHistory/getMetasCalculadas/getNotasDeEquipe em
// db/queries.js e db/notasQueries.js). Cobertura 200-path fica pro P2-1 (fixtures
// de DB no backlog).

// ── P1-38: /wpa/nota/:noteId ignorava o escopo de regional ────────────────────
// Achado em 25/08/2026 investigando o incidente de SJC. A rota devolve a nota
// COMPLETA (endereço, cliente, colaboradores, checkpoints, e fotos com ?fotos=1)
// e tinha QUATRO portas sem escopo:
//   1. `?sectorId=` era validado só contra a lista de setores válidos
//   2. o cache note_details era lido por UUID puro, sem olhar o sector_id gravado
//   3. getTeamsCurrent({}) resolvia código→UUID varrendo todas as regionais
//   4. searchNoteByNumber consultava a WPA sem escopo
// Basta conhecer o número da OS — que circula em auditoria da EDP e é o que o
// gestor tem na mão. Mesma classe do P0-4 e do P1-12.

test('P1-38: usuário GUA pedindo ?sectorId=DSSJ → 403 (setor fora do escopo)', async () => {
  const t = await loginAs('guarapari', 'guapass');
  const { status, json } = await get(
    '/api/wpa/nota/11111111-2222-3333-4444-555555555555?sectorId=DSSJ', t);
  assert.equal(status, 403, 'DSSJ é SJC; o usuário só tem GUA');
  assert.equal(json.code, 'SECTOR_REGIONAL_MISMATCH');
});

test('P1-38: usuário GUA pedindo ?sectorId=DESC (Cachoeiro) → 403', async () => {
  const t = await loginAs('guarapari', 'guapass');
  const { status } = await get(
    '/api/wpa/nota/11111111-2222-3333-4444-555555555555?sectorId=DESC', t);
  assert.equal(status, 403);
});

test('P1-38: usuário GUA no PRÓPRIO setor não é bloqueado pelo guard', async () => {
  // Não afirma que a nota existe (em mock não existe) — afirma que o 403 de
  // escopo não é disparado. Regressão: um guard cego bloquearia o caso legítimo.
  const t = await loginAs('guarapari', 'guapass');
  const { status } = await get(
    '/api/wpa/nota/11111111-2222-3333-4444-555555555555?sectorId=DESG', t);
  assert.notEqual(status, 403, 'DESG é GUA — o usuário tem escopo');
});

test('P1-38: admin acessa qualquer setor', async () => {
  const t = await loginAs('admin', 'adminpass');
  for (const s of ['DESG', 'DEPT', 'DESC', 'DSSJ']) {
    const { status } = await get(
      `/api/wpa/nota/11111111-2222-3333-4444-555555555555?sectorId=${s}`, t);
    assert.notEqual(status, 403, `admin tem as 3 regionais — ${s} não pode dar 403`);
  }
});

test('P1-38: sectorId inválido continua 400, não 403 (não confundir os erros)', async () => {
  const t = await loginAs('guarapari', 'guapass');
  const { status } = await get(
    '/api/wpa/nota/11111111-2222-3333-4444-555555555555?sectorId=XXXX', t);
  assert.equal(status, 400, 'setor inexistente é entrada inválida, não falta de permissão');
});

test('P1-38: sem ?sectorId, o default NÃO pode furar o escopo', async () => {
  // O default da rota é 'DESG' (GUA). Para um usuário que não tem GUA, cair no
  // default seria exatamente o vazamento que este item fecha.
  const t = await loginAs('saopaulo', 'sppass');
  const { status, json } = await get(
    '/api/wpa/nota/11111111-2222-3333-4444-555555555555', t);
  assert.equal(status, 403, 'usuário só de SJC não pode cair no default DESG');
  assert.equal(json.code, 'SECTOR_REGIONAL_MISMATCH');
});

// ── P1-38 (extensão): /debug/* estava aberto a qualquer usuário autenticado ───
// Mesmo eixo do vazamento acima, achado ao varrer os outros `req.query.sectorId`.
// `router.use('/admin', requireAdmin)` cobria só /admin; as 5 rotas /debug/*
// aceitam ?sectorId= livre e devolvem payload BRUTO da WPA (sessões, carteira,
// notas do dia). Nada no front nem em scripts consome /debug — são ferramentas
// de inspeção manual do dev, e não têm por que estar ao alcance de conta comum.

test('P1-38: /debug/notas exige admin (não-admin → 403)', async () => {
  const t = await loginAs('guarapari', 'guapass');
  const { status } = await get('/api/debug/notas?sectorId=DSSJ', t);
  assert.equal(status, 403, 'conta comum não inspeciona payload bruto de outro setor');
});

test('P1-38: /debug/* inteiro exige admin, não só uma rota', async () => {
  const t = await loginAs('guarapari', 'guapass');
  for (const p of ['/api/debug/historico-notas?sectorId=DSSJ&date=2026-08-25',
                   '/api/debug/historico?sectorId=DSSJ&date=2026-08-25',
                   '/api/debug/preroute?sectorId=DSSJ',
                   '/api/debug/teamsstatus?sectorId=DSSJ']) {
    const { status } = await get(p, t);
    assert.equal(status, 403, `${p} tem que exigir admin`);
  }
});

test('P1-38: admin continua entrando em /debug (o guard não quebra a ferramenta)', async () => {
  const t = await loginAs('admin', 'adminpass');
  const { status } = await get('/api/debug/notas?sectorId=DESG', t);
  assert.notEqual(status, 403, 'admin é justamente quem usa essas rotas');
});

test('P1-38: /debug sem token → 401 (autenticação antes de autorização)', async () => {
  const { status } = await get('/api/debug/notas?sectorId=DESG');
  assert.equal(status, 401);
});

test('P1-38: a suíte NUNCA chama a WPA de verdade (DATA_MODE=mock não toca a rede)', async () => {
  // Regressão de 26/08/2026: rodando estes testes NA VM apareceram
  // `[wpa] getNoteDetail OK ... sector=DSSJ` com token real no meio da suíte —
  // a rota chamava a EDP porque o getNoteDetail não checava MODE. Na máquina de
  // dev passava batido (sem DATABASE_URL não há token em cache). Com token
  // vencido, a suíte dispararia /signin e queimaria uma das 5 tentativas de
  // login da conta na EDP.
  const t = await loginAs('admin', 'adminpass');
  const { status, json } = await get(
    '/api/wpa/nota/11111111-2222-3333-4444-555555555555?sectorId=DSSJ', t);
  assert.equal(status, 404, 'em mock a rota para antes da WPA');
  assert.equal(json.debug?.mode, 'mock');
  assert.match(json.error, /mock/i);
});
