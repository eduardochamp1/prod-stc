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

// ─────────────────────────────────────────────────────────────────────────────
// Normalização de role — achado do --dry-run em 21/09/2026
// ─────────────────────────────────────────────────────────────────────────────

test('role fora de admin|user vira "user" — o .env real usa gua/cac/sjc/es', () => {
  // O dry-run em produção mostrou role=gua, role=cac, role=sjc, role=es. Isso
  // sempre funcionou porque o sistema só pergunta se o valor é 'admin'. Mas a
  // tabela tem CHECK (role IN ('admin','user')), e gravar assim falharia no
  // meio da migração.
  const AUTH_REAL = [
    'admin:scrypt$a$b:admin:GUA|CAC|SJC',
    'guarapari:scrypt$c$d:gua:GUA',
    'cachoeiro:scrypt$e$f:cac:CAC',
    'engelmig_es:scrypt$g$h:es:GUA|CAC',
  ].join(',');

  const p = planejarMigracao(AUTH_REAL, 'admin', []);
  assert.deepEqual(p.erros, []);

  const porNome = Object.fromEntries(p.inserir.map(u => [u.username, u.role]));
  assert.equal(porNome.admin,       'admin', 'admin continua admin');
  assert.equal(porNome.guarapari,   'user');
  assert.equal(porNome.cachoeiro,   'user');
  assert.equal(porNome.engelmig_es, 'user');
});

test('toda linha do plano tem role aceito pelo CHECK da tabela', () => {
  // A afirmação que impede a migração de morrer no meio.
  const AUTH_ESQUISITO = 'a_user:h:QUALQUER_COISA:GUA,b_user:h:ADMIN:CAC,c_user:h::SJC';
  const p = planejarMigracao('admin:h:admin:GUA,' + AUTH_ESQUISITO, 'admin', []);
  p.inserir.forEach(u =>
    assert.ok(['admin', 'user'].includes(u.role),
      `role "${u.role}" de ${u.username} violaria o CHECK da tabela`));
});

test('role "ADMIN" em maiúscula continua sendo admin', () => {
  const p = planejarMigracao('chefe:h:ADMIN:GUA', 'chefe', []);
  assert.deepEqual(p.erros, [], `esperava aceitar; veio: ${p.erros}`);
  assert.equal(p.inserir[0].role, 'admin');
});

test('o valor original do role é preservado pro relatório do dry-run', () => {
  // Converter em silêncio seria pior que converter.
  const p = planejarMigracao('admin:h:admin:GUA,fulano:h:es:CAC', 'admin', []);
  const fulano = p.inserir.find(u => u.username === 'fulano');
  assert.equal(fulano._roleCruo, 'es');
  assert.equal(fulano.role, 'user');
});
