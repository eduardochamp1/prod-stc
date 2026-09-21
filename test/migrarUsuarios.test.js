/**
 * test/migrarUsuarios.test.js
 *
 * A parte PURA do script de migração: qual linha vira qual, e as recusas.
 *
 * O script copia os HASHES, nunca senhas — elas não existem em lugar nenhum.
 * É o que garante que ninguém perde acesso.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { planejarMigracao } = require('../scripts/migrar-usuarios');

const AUTH = 'jose:scrypt$aa$bb:admin:GUA|CAC|SJC,guarapari:scrypt$cc$dd:user:GUA';

test('monta uma linha por usuário do AUTH_USERS, copiando o hash', () => {
  const p = planejarMigracao(AUTH, 'jose', []);
  assert.deepEqual(p.erros, []);
  assert.equal(p.inserir.length, 2);

  const jose = p.inserir.find(u => u.username === 'jose');
  assert.equal(jose.senha_hash, 'scrypt$aa$bb', 'o hash tem de ir IDÊNTICO');
  assert.equal(jose.regionals, 'GUA|CAC|SJC');
  assert.equal(jose.role, 'admin');
});

test('o --gestor sai com pode_gerenciar; os demais, não', () => {
  const p = planejarMigracao(AUTH, 'jose', []);
  assert.equal(p.inserir.find(u => u.username === 'jose').pode_gerenciar, true);
  assert.equal(p.inserir.find(u => u.username === 'guarapari').pode_gerenciar, false);
});

test('sem --gestor, recusa — senão a tela nasce inútil', () => {
  // Ninguém poderia criar ninguém, e o único caminho de volta seria editar o
  // banco à mão, que é o problema que este trabalho existe pra acabar.
  const p = planejarMigracao(AUTH, null, []);
  assert.ok(p.erros.some(e => /gestor/i.test(e)));
  assert.equal(p.inserir.length, 0);
});

test('--gestor apontando pra quem não está no AUTH_USERS → recusa', () => {
  const p = planejarMigracao(AUTH, 'fantasma', []);
  assert.ok(p.erros.some(e => /fantasma/.test(e)));
  assert.equal(p.inserir.length, 0);
});

test('--gestor apontando pra quem não é admin → recusa', () => {
  const p = planejarMigracao(AUTH, 'guarapari', []);
  assert.ok(p.erros.some(e => /admin/i.test(e)));
  assert.equal(p.inserir.length, 0);
});

test('idempotente: quem já está no banco é pulado, não sobrescrito', () => {
  const p = planejarMigracao(AUTH, 'jose', [{ username: 'jose' }]);
  assert.equal(p.inserir.length, 1);
  assert.equal(p.inserir[0].username, 'guarapari');
  assert.deepEqual(p.pulados, ['jose']);
});

test('AUTH_USERS vazio → recusa em vez de migrar nada em silêncio', () => {
  const p = planejarMigracao('', 'jose', []);
  assert.ok(p.erros.length > 0);
  assert.equal(p.inserir.length, 0);
});

test('nenhuma linha do plano carrega senha em texto puro', () => {
  // Óbvio pela construção (o .env só tem hash), e com teste mesmo assim: é a
  // afirmação que sustenta "ninguém precisa saber a senha de ninguém".
  const p = planejarMigracao(AUTH, 'jose', []);
  const texto = JSON.stringify(p.inserir);
  assert.ok(texto.includes('scrypt$'), 'os hashes têm de estar lá');
  assert.ok(!/senha(?!_hash)/i.test(texto), 'não pode haver campo de senha crua');
});
