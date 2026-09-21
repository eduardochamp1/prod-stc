/**
 * test/usuariosHttp.test.js
 *
 * Contrato HTTP das rotas de usuário. O peso do teste vai AQUI, e não em
 * inspeção de código-fonte, porque o risco é de controle de acesso: cinco
 * itens do backlog já foram furos disso (P0-4, P1-12, P1-18, P1-38, P1-42).
 *
 * Roda em DATA_MODE=mock com um pool fake, então exercita o PORTÃO (quem pode
 * chamar) e a forma das respostas — não o caminho de banco real.
 *
 * Spec: docs/handoff/SPEC-gestao-usuarios-2026-09-21.md §7
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV     = 'test';
process.env.DATA_MODE    = 'mock';
process.env.JWT_SECRET   = 'test-secret-usuarios';
process.env.DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://test:test@localhost:5432/test';

const { hashPassword } = require('../middleware/auth');
const { _cache } = require('../services/usuarios');
const { _setPool } = require('../services/pgShim');

const SENHA_GESTOR = 'senha-gestor';
const SENHA_SIMPLES = 'senha-simples';
const H_GESTOR  = hashPassword(SENHA_GESTOR);
const H_SIMPLES = hashPassword(SENHA_SIMPLES);

process.env.AUTH_USERS = [
  `gestor:${H_GESTOR}:admin:GUA|CAC|SJC`,
  `adminsimples:${H_SIMPLES}:admin:GUA`,
].join(',');

/**
 * Pool fake CIENTE DA TABELA.
 *
 * A primeira versão devolvia as mesmas linhas pra qualquer SELECT, e o teste de
 * vazamento acusou `GET /usuarios/log` — que na verdade estava recebendo linhas
 * de USUÁRIO do próprio mock. Um mock que não distingue a tabela transforma o
 * teste de vazamento em teatro: ele acusaria sempre, ou nunca, por motivo
 * errado.
 */
let _linhas = [];
function setLinhas(rows) { _linhas = rows; }

/** A trilha tem forma própria e NÃO tem coluna de senha. */
const LOG_FAKE = [{
  id: 1, ts: new Date().toISOString(), ator: 'gestor',
  acao: 'criar', alvo: 'fulano', detalhe: { role: 'user' },
}];

_setPool({
  query: async (sql) => {
    if (/^\s*(insert|update|delete)/i.test(sql)) return { rows: [], rowCount: 1 };
    if (/usuarios_log/i.test(sql)) return { rows: LOG_FAKE, rowCount: LOG_FAKE.length };
    return { rows: _linhas, rowCount: _linhas.length };
  },
  on: () => {},
});

function linhaUsuario(over = {}) {
  return {
    username: 'fulano', senha_hash: H_SIMPLES, role: 'user', regionals: 'GUA',
    ativo: true, pode_gerenciar: false,
    criado_em: new Date().toISOString(), criado_por: 'gestor',
    ...over,
  };
}

/** `gestor` tem a permissão; `adminsimples` não. Ambos vêm do .env. */
const LINHA_GESTOR = linhaUsuario({
  username: 'gestor', senha_hash: H_GESTOR, role: 'admin',
  regionals: 'GUA|CAC|SJC', pode_gerenciar: true,
});

const app = require('../server');
let server, base;

before(async () => {
  await new Promise(r => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { if (server) server.close(); });

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
  return json.token;
}

/** As sete rotas, com método e um corpo mínimo. */
const ROTAS = [
  ['GET',  '/api/admin/usuarios',                  null],
  ['POST', '/api/admin/usuarios',                  { username: 'novo_user', role: 'user', regionals: ['GUA'] }],
  ['PUT',  '/api/admin/usuarios/fulano',           { role: 'user' }],
  ['POST', '/api/admin/usuarios/fulano/desativar', {}],
  ['POST', '/api/admin/usuarios/fulano/reativar',  {}],
  ['POST', '/api/admin/usuarios/fulano/senha',     {}],
  ['GET',  '/api/admin/usuarios/log',              null],
];

test('sem token → 401 nas SETE rotas', async () => {
  for (const [metodo, caminho, corpo] of ROTAS) {
    const { status } = await req(metodo, caminho, null, corpo);
    assert.equal(status, 401, `${metodo} ${caminho} devia ser 401`);
  }
});

test('admin SEM pode_gerenciar → 403 nas SETE rotas', async () => {
  // role=admin abre o /admin inteiro, mas NÃO mexe em quem entra. É a
  // separação que o José pediu ("só você, por enquanto").
  _cache.limpar();
  setLinhas([]);                                   // adminsimples sem linha no banco
  const token = await loginAs('adminsimples', SENHA_SIMPLES);
  assert.ok(token, 'esperava login do admin simples');

  for (const [metodo, caminho, corpo] of ROTAS) {
    _cache.limpar();
    setLinhas([]);
    const { status } = await req(metodo, caminho, token, corpo);
    assert.equal(status, 403, `${metodo} ${caminho} devia ser 403 pra admin sem gestão`);
  }
});

test('quem tem pode_gerenciar passa do portão', async () => {
  _cache.limpar();
  setLinhas([LINHA_GESTOR]);
  const token = await loginAs('gestor', SENHA_GESTOR);
  assert.ok(token);

  _cache.limpar();
  setLinhas([LINHA_GESTOR]);
  const { status } = await req('GET', '/api/admin/usuarios', token);
  assert.notEqual(status, 401);
  assert.notEqual(status, 403);
});

test('senha_hash NÃO aparece em nenhuma resposta', async () => {
  // Este código já vazou stack trace (P1-10) e dado de outra regional (P1-38)
  // por caminhos que também pareciam óbvios.
  _cache.limpar();
  setLinhas([LINHA_GESTOR]);
  const token = await loginAs('gestor', SENHA_GESTOR);

  for (const [metodo, caminho, corpo] of ROTAS) {
    _cache.limpar();
    setLinhas([LINHA_GESTOR, linhaUsuario()]);
    const { json } = await req(metodo, caminho, token, corpo);
    const texto = JSON.stringify(json);
    assert.ok(!/senha_hash/.test(texto), `${metodo} ${caminho} vazou senha_hash`);
    assert.ok(!/scrypt\$/.test(texto),   `${metodo} ${caminho} vazou um hash`);
  }
});

test('payload malformado → 400, nunca 500', async () => {
  _cache.limpar();
  setLinhas([LINHA_GESTOR]);
  const token = await loginAs('gestor', SENHA_GESTOR);

  const casos = [
    {},
    { username: 'ok_user' },
    { username: 'AA', role: 'user', regionals: ['GUA'] },
    { username: 'ok_user', role: 'deus', regionals: ['GUA'] },
    { username: 'ok_user', role: 'user', regionals: [] },
    { username: 'ok_user', role: 'user', regionals: ['ALL'] },
    { username: 'ok_user', role: 'user', regionals: ['XYZ'] },
  ];
  for (const corpo of casos) {
    _cache.limpar();
    setLinhas([LINHA_GESTOR]);
    const { status } = await req('POST', '/api/admin/usuarios', token, corpo);
    assert.equal(status, 400, `corpo ${JSON.stringify(corpo)} devolveu ${status}`);
  }
});

test('desativar a si mesmo → 400 com motivo legível', async () => {
  _cache.limpar();
  setLinhas([LINHA_GESTOR]);
  const token = await loginAs('gestor', SENHA_GESTOR);

  _cache.limpar();
  setLinhas([LINHA_GESTOR]);
  const { status, json } = await req(
    'POST', '/api/admin/usuarios/gestor/desativar', token, {});

  assert.equal(status, 400, `esperava 400 ao autodesativar; veio ${status}`);
  assert.ok(json.error, 'a recusa tem de explicar o motivo');
  assert.match(json.error, /si mesmo|pr[óo]prio|emerg[êe]ncia/i);
});

test('a conta do .env não é gerenciável pela tela', async () => {
  // Ela vive no .env e só o José a altera — é o ponto de ser a chave reserva.
  _cache.limpar();
  setLinhas([LINHA_GESTOR]);
  const token = await loginAs('gestor', SENHA_GESTOR);

  for (const caminho of [
    '/api/admin/usuarios/adminsimples',
    '/api/admin/usuarios/adminsimples/desativar',
    '/api/admin/usuarios/adminsimples/senha',
  ]) {
    _cache.limpar();
    setLinhas([LINHA_GESTOR]);
    const metodo = caminho.endsWith('adminsimples') ? 'PUT' : 'POST';
    const { status } = await req(metodo, caminho, token, {});
    assert.equal(status, 400, `${metodo} ${caminho} devia recusar`);
  }
});
