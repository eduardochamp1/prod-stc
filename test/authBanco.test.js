/**
 * test/authBanco.test.js
 *
 * O login lendo do banco, a conta de emergência e a revogação imediata.
 *
 * ⚠️ A parte mais sensível do trabalho: é o caminho onde um erro não dá tela
 * feia, dá acesso indevido.
 *
 * Spec: docs/handoff/SPEC-gestao-usuarios-2026-09-21.md §3.3, §3.4, §3.5
 */

'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV     = 'test';
process.env.JWT_SECRET   = 'test-secret-authbanco';
process.env.DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://test:test@localhost:5432/test';

const { hashPassword } = require('../middleware/auth');
const { _cache } = require('../services/usuarios');
const { _setPool } = require('../services/pgShim');

/** Pool fake: devolve as linhas dadas, ou lança se `erro` for true. */
function mockPool(rows, erro) {
  _setPool({
    query: async () => {
      if (erro) throw new Error('banco fora');
      return { rows, rowCount: rows.length };
    },
    on: () => {},
  });
}

const SENHA = 'senha-de-teste';
const HASH  = hashPassword(SENHA);

function linha(over = {}) {
  return {
    username: 'fulano', senha_hash: HASH, role: 'user', regionals: 'GUA',
    ativo: true, pode_gerenciar: false,
    criado_em: new Date().toISOString(), criado_por: 'jose',
    ...over,
  };
}

beforeEach(() => _cache.limpar());

test('getUsers une os do banco com a conta de emergência do .env', async () => {
  process.env.AUTH_USERS = `emergencia:${HASH}:admin:GUA|CAC|SJC`;
  mockPool([linha()]);

  const { getUsers } = require('../middleware/auth');
  const users = await getUsers();

  assert.deepEqual(users.map(u => u.username).sort(), ['emergencia', 'fulano']);
});

test('em colisão de nome, a conta do .env VENCE', async () => {
  // Sem isso, quem gerencia criaria um homônimo da chave reserva e qual das
  // duas responde viraria detalhe de implementação decidindo quem entra.
  const hashOutro = hashPassword('outra-senha');
  process.env.AUTH_USERS = `emergencia:${HASH}:admin:GUA|CAC|SJC`;
  mockPool([linha({ username: 'emergencia', senha_hash: hashOutro, role: 'user' })]);

  const { getUsers } = require('../middleware/auth');
  const users = await getUsers();
  const emerg = users.filter(u => u.username === 'emergencia');

  assert.equal(emerg.length, 1, 'não pode haver duas entradas com o mesmo nome');
  assert.equal(emerg[0].role, 'admin', 'venceu a do banco; deveria ser a do .env');
  assert.equal(emerg[0].passwordHash, HASH);
});

test('login de usuário do banco funciona', async () => {
  process.env.AUTH_USERS = `emergencia:${HASH}:admin:GUA`;
  mockPool([linha()]);

  const { login } = require('../middleware/auth');
  const r = await login('fulano', SENHA);

  assert.ok(r, 'esperava login bem-sucedido');
  assert.equal(r.username, 'fulano');
  assert.deepEqual(r.regionals, ['GUA']);
});

test('usuário DESATIVADO no banco não loga', async () => {
  process.env.AUTH_USERS = `emergencia:${HASH}:admin:GUA`;
  mockPool([linha({ ativo: false })]);

  const { login } = require('../middleware/auth');
  assert.equal(await login('fulano', SENHA), null);
});

test('com o banco FORA, a conta de emergência ainda loga', async () => {
  // É a razão inteira de ela existir. Em 09/07/2026 o Postgres caiu em
  // produção (P0-0, ainda aberto: a VM segue sem swap).
  process.env.AUTH_USERS = `emergencia:${HASH}:admin:GUA|CAC|SJC`;
  mockPool([], true);

  const { login } = require('../middleware/auth');
  const r = await login('emergencia', SENHA);

  assert.ok(r, 'a chave reserva tem de funcionar justamente quando o banco cai');
  assert.equal(r.username, 'emergencia');
});

test('com o banco FORA, usuário do banco NÃO loga (não é fail-open)', async () => {
  process.env.AUTH_USERS = `emergencia:${HASH}:admin:GUA`;
  mockPool([], true);

  const { login } = require('../middleware/auth');
  assert.equal(await login('fulano', SENHA), null);
});

test('senha errada continua não logando', async () => {
  process.env.AUTH_USERS = `emergencia:${HASH}:admin:GUA`;
  mockPool([linha()]);

  const { login } = require('../middleware/auth');
  assert.equal(await login('fulano', 'errada'), null);
});
