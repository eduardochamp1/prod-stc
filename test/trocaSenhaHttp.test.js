/**
 * test/trocaSenhaHttp.test.js
 *
 * Troca de senha: obrigatória no 1º acesso, voluntária depois.
 *
 * ⚠️ O peso vai em HTTP porque o risco é de controle de acesso. O bloqueio é
 * no SERVIDOR: fazer só na tela seria contornável chamando a API direto.
 *
 * Spec: docs/handoff/SPEC-troca-senha-2026-09-22.md §6
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV     = 'test';
process.env.DATA_MODE    = 'mock';
process.env.JWT_SECRET   = 'test-secret-trocasenha';
process.env.DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://test:test@localhost:5432/test';

const { hashPassword } = require('../middleware/auth');
const { _cache } = require('../services/usuarios');
const { _setPool } = require('../services/pgShim');

const SENHA_EMERG = 'senha-emergencia';
const SENHA_PESSOA = 'senha-provisoria-gerada';
const H_EMERG  = hashPassword(SENHA_EMERG);
const H_PESSOA = hashPassword(SENHA_PESSOA);

process.env.AUTH_USERS = `emergencia:${H_EMERG}:admin:GUA|CAC|SJC`;

/** O que o pool fake devolve pra SELECT em `usuarios`. */
let _linhas = [];
/** Guarda o último UPDATE, pra checar o que foi gravado. */
let _ultimoUpdate = null;

_setPool({
  query: async (sql, params) => {
    if (/^\s*update/i.test(sql))  { _ultimoUpdate = { sql, params }; return { rows: [], rowCount: 1 }; }
    if (/^\s*insert/i.test(sql))  { return { rows: [], rowCount: 1 }; }
    if (/usuarios_log/i.test(sql)) return { rows: [], rowCount: 0 };
    return { rows: _linhas, rowCount: _linhas.length };
  },
  on: () => {},
});

function linha(over = {}) {
  return {
    username: 'fulano', senha_hash: H_PESSOA, role: 'user', regionals: 'GUA',
    ativo: true, pode_gerenciar: false, senha_provisoria: true,
    criado_em: new Date().toISOString(), criado_por: 'admin',
    ...over,
  };
}

const app = require('../server');
let server, base;

before(async () => {
  await new Promise(r => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { if (server) server.close(); });
beforeEach(() => { _cache.limpar(); _ultimoUpdate = null; });

async function req(metodo, caminho, token, corpo) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(base + caminho, {
    method: metodo, headers, body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function loginAs(u, p) {
  const { json } = await req('POST', '/api/auth/login', null, { username: u, password: p });
  return json;
}

// ─────────────────────────────────────────────────────────────────────────────
// O bloqueio
// ─────────────────────────────────────────────────────────────────────────────

test('sem token → 401 na rota de troca', async () => {
  const { status } = await req('POST', '/api/auth/senha', null,
    { atual: 'a', nova: 'novasenha' });
  assert.equal(status, 401);
});

test('o login INFORMA que a senha é provisória', async () => {
  // Pro frontend já abrir na tela certa, em vez de tentar carregar o painel e
  // tomar 423 em toda chamada.
  _linhas = [linha()];
  const data = await loginAs('fulano', SENHA_PESSOA);
  assert.equal(data.senha_provisoria, true);
  assert.ok(data.token);
});

test('com senha provisória, rota comum → 423 com code SENHA_PROVISORIA', async () => {
  _linhas = [linha()];
  const { token } = await loginAs('fulano', SENHA_PESSOA);
  _cache.limpar();

  const { status, json } = await req('GET', '/api/metas', token);
  assert.equal(status, 423, `esperava 423; veio ${status}`);
  assert.equal(json.code, 'SENHA_PROVISORIA');
});

test('423, e não 403 — 403 já significa "sem permissão" no painel', async () => {
  // Reusar 403 faria a tela de troca competir com a de acesso negado.
  _linhas = [linha()];
  const { token } = await loginAs('fulano', SENHA_PESSOA);
  _cache.limpar();

  const { status } = await req('GET', '/api/metas', token);
  assert.notEqual(status, 403);
});

test('a rota de troca é a SAÍDA: passa mesmo com senha provisória', async () => {
  _linhas = [linha()];
  const { token } = await loginAs('fulano', SENHA_PESSOA);
  _cache.limpar();

  const { status } = await req('POST', '/api/auth/senha', token,
    { atual: SENHA_PESSOA, nova: 'minhasenhanova' });
  assert.equal(status, 200, 'sem esta saída, a pessoa fica trancada pra sempre');
});

test('sem senha provisória, o painel abre normalmente', async () => {
  _linhas = [linha({ senha_provisoria: false })];
  const { token } = await loginAs('fulano', SENHA_PESSOA);
  _cache.limpar();

  const { status } = await req('GET', '/api/metas', token);
  assert.notEqual(status, 423);
});

// ─────────────────────────────────────────────────────────────────────────────
// A troca
// ─────────────────────────────────────────────────────────────────────────────

test('senha atual incorreta → 400, e NADA é gravado', async () => {
  _linhas = [linha()];
  const { token } = await loginAs('fulano', SENHA_PESSOA);
  _cache.limpar();

  const { status, json } = await req('POST', '/api/auth/senha', token,
    { atual: 'errada', nova: 'minhasenhanova' });

  assert.equal(status, 400);
  assert.match(json.error, /atual/i);
  assert.equal(_ultimoUpdate, null, 'não pode ter gravado nada');
});

test('senha nova curta demais → 400, e NADA é gravado', async () => {
  _linhas = [linha()];
  const { token } = await loginAs('fulano', SENHA_PESSOA);
  _cache.limpar();

  const { status } = await req('POST', '/api/auth/senha', token,
    { atual: SENHA_PESSOA, nova: '1234567' });

  assert.equal(status, 400);
  assert.equal(_ultimoUpdate, null);
});

test('senha nova IGUAL à atual → 400', async () => {
  // Senão a pessoa "troca" pra mesma sequência provisória, a marca some, e
  // nada mudou.
  _linhas = [linha()];
  const { token } = await loginAs('fulano', SENHA_PESSOA);
  _cache.limpar();

  const { status, json } = await req('POST', '/api/auth/senha', token,
    { atual: SENHA_PESSOA, nova: SENHA_PESSOA });

  assert.equal(status, 400);
  assert.match(json.error, /diferente/i);
});

test('troca bem-sucedida limpa a marca de provisória', async () => {
  _linhas = [linha()];
  const { token } = await loginAs('fulano', SENHA_PESSOA);
  _cache.limpar();

  const { status } = await req('POST', '/api/auth/senha', token,
    { atual: SENHA_PESSOA, nova: 'minhasenhanova' });

  assert.equal(status, 200);
  assert.ok(_ultimoUpdate, 'esperava um UPDATE');
  assert.ok(/senha_provisoria/i.test(_ultimoUpdate.sql),
    'o UPDATE tem de mexer em senha_provisoria');
  assert.ok(_ultimoUpdate.params.includes(false),
    'senha_provisoria tem de ir como false');
});

test('a troca é sempre da PRÓPRIA senha — username no corpo é ignorado', async () => {
  // Aceitar username seria um caminho paralelo ao /admin/usuarios/:u/senha,
  // sem a guarda de gestão.
  _linhas = [linha()];
  const { token } = await loginAs('fulano', SENHA_PESSOA);
  _cache.limpar();

  await req('POST', '/api/auth/senha', token,
    { username: 'admin', atual: SENHA_PESSOA, nova: 'minhasenhanova' });

  assert.ok(_ultimoUpdate, 'esperava um UPDATE');
  assert.ok(_ultimoUpdate.params.includes('fulano'),
    'o UPDATE tem de ser do usuário do token, não do corpo');
  assert.ok(!_ultimoUpdate.params.includes('admin'),
    'o username do corpo não pode ter sido usado');
});

test('a senha nova NÃO aparece em nenhuma resposta', async () => {
  _linhas = [linha()];
  const { token } = await loginAs('fulano', SENHA_PESSOA);
  _cache.limpar();

  const { json } = await req('POST', '/api/auth/senha', token,
    { atual: SENHA_PESSOA, nova: 'minhasenhanova' });

  const texto = JSON.stringify(json);
  assert.ok(!texto.includes('minhasenhanova'), 'a senha vazou na resposta');
  assert.ok(!/scrypt\$/.test(texto), 'o hash vazou na resposta');
});

test('a conta de emergência recusa, e explica onde trocar', async () => {
  // Ela vive no .env e não tem linha no banco. Sem esta recusa, a troca
  // gravaria numa linha inexistente e a pessoa acharia que funcionou.
  _linhas = [];
  const { token } = await loginAs('emergencia', SENHA_EMERG);
  _cache.limpar();

  const { status, json } = await req('POST', '/api/auth/senha', token,
    { atual: SENHA_EMERG, nova: 'minhasenhanova' });

  assert.equal(status, 400);
  assert.match(json.error, /\.env/);
});

test('a conta de emergência NUNCA é trancada por senha provisória', async () => {
  // Se o fluxo de troca quebrar, ela continua entrando — é a chave reserva.
  _linhas = [];
  const { token } = await loginAs('emergencia', SENHA_EMERG);
  _cache.limpar();

  const { status } = await req('GET', '/api/metas', token);
  assert.notEqual(status, 423);
});

test('a ação gravada na trilha é aceita pelo CHECK da tabela', () => {
  // O pool fake não valida CHECK, então este teste compara o que a rota grava
  // com o que a migration permite. Sem ele, o INSERT na auditoria violaria a
  // constraint — e como o registrarLog engole o erro pra não derrubar a troca,
  // o REGISTRO SUMIRIA EM SILÊNCIO. Numa trilha de acesso, é o pior defeito
  // possível.
  const fs = require('node:fs');
  const path = require('node:path');
  const leia = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

  const ROTAS = leia('routes/index.js');
  const acoes = [...ROTAS.matchAll(/registrarLog\([^,]+,\s*'([a-z_]+)'/g)].map(m => m[1]);
  assert.ok(acoes.length > 0, 'não achei nenhuma chamada a registrarLog');

  const permitidas = leia('migrations/add_senha_provisoria.sql')
    .match(/acao IN \(([^)]+)\)/);
  assert.ok(permitidas, 'não achei o CHECK na migration');

  acoes.forEach(a => assert.ok(permitidas[1].includes(`'${a}'`),
    `a rota grava "${a}", mas o CHECK da tabela não aceita`));
});
