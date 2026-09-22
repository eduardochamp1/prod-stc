/**
 * test/trocaSenhaTela.test.js
 *
 * A tela de troca de senha. Sem harness de frontend (risco H11), então valem
 * as invariantes estruturais e a função pura, extraída e executada.
 *
 * Spec: docs/handoff/SPEC-troca-senha-2026-09-22.md §5.4
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('o overlay de troca existe, com os três campos', () => {
  ['senha-atual', 'senha-nova', 'senha-conf'].forEach(id =>
    assert.ok(SRC.includes(`id="${id}"`), `falta o campo ${id}`));
  assert.ok(SRC.includes('id="senha-overlay"'));
});

test('os campos de senha são type="password"', () => {
  // Óbvio, e com teste: um `type="text"` aqui expõe a senha na tela de quem
  // está ao lado, e é o tipo de coisa que passa despercebida num monólito.
  const i = SRC.indexOf('id="senha-overlay"');
  const bloco = SRC.slice(i, SRC.indexOf('</div>', SRC.indexOf('btn-senha-cancelar')));
  ['senha-atual', 'senha-nova', 'senha-conf'].forEach(id => {
    const j = bloco.indexOf(`id="${id}"`);
    assert.ok(j > -1, `falta ${id}`);
    const inicio = bloco.lastIndexOf('<input', j);
    assert.ok(/type="password"/.test(bloco.slice(inicio, j)),
      `${id} não é type="password"`);
  });
});

test('o login abre a troca quando a senha é provisória', () => {
  assert.ok(/if \(data\.senha_provisoria\)\s*\{\s*abrirTrocaSenha\(true\)/.test(SRC),
    'sem isto o painel tentaria carregar e tomaria 423 em toda chamada');
});

test('há um acesso VOLUNTÁRIO à troca, separado do botão de sair', () => {
  // É o "ou mudar a senha só" do pedido. Separado de propósito: um clique
  // errado ou desloga sem querer, ou abre troca quando a pessoa só queria sair.
  assert.ok(SRC.includes('abrirTrocaSenha(false)'));
  assert.ok(SRC.includes('id="btn-trocar-senha"'));
});

test('quando obrigatória, não há como cancelar', () => {
  // O servidor tranca de qualquer forma; um botão que não leva a lugar nenhum
  // só frustra.
  const i = SRC.indexOf('function fecharTrocaSenha(');
  assert.ok(i > -1, 'não achei fecharTrocaSenha');
  const bloco = SRC.slice(i, i + 300);
  assert.ok(/_senhaObrigatoria\)\s*return/.test(bloco),
    'fecharTrocaSenha tem de recusar quando é obrigatória');
});

test('a confirmação da nova senha é conferida antes de chamar a API', () => {
  // O servidor não tem como saber que a pessoa digitou errado duas vezes o que
  // queria digitar.
  const i = SRC.indexOf('async function doTrocarSenha(');
  assert.ok(i > -1);
  const bloco = SRC.slice(i, i + 900);
  assert.ok(/nova !== conf/.test(bloco), 'falta conferir a repetição');
});

test('a tela avisa o mínimo de 8 caracteres', () => {
  assert.ok(/m[íi]nimo 8/i.test(SRC),
    'sem isso a pessoa descobre o limite por tentativa e erro');
});
