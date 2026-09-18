/**
 * test/categoriasEquipe.test.js
 *
 * Catálogo de categorias de equipe (derivadas do PREFIXO da sigla) e o filtro
 * multi que a API passou a aceitar.
 *
 * ⚠️ Não confundir com `equipes_oficiais.tipo` — o tipo operacional do
 * cadastro (BTZERO, CS, CORTE L0…), editável no Admin. É outra dimensão. Por
 * isso a chave do prefixo EB aqui é `BT_ZERO`, com underline.
 *
 * Spec: docs/handoff/SPEC-categorias-equipe-2026-09-18.md
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const {
  CATEGORIAS, OPERACIONAL,
  categoriaDaSigla, prefixoDaCategoria, filtroDeCategorias,
} = require('../services/categoriasEquipe');

// ─────────────────────────────────────────────────────────────────────────────
// categoriaDaSigla — o prefixo manda
// ─────────────────────────────────────────────────────────────────────────────

test('classifica os quatro prefixos conhecidos', () => {
  assert.equal(categoriaDaSigla('ECGPR53'), 'COMERCIAL');
  assert.equal(categoriaDaSigla('EPGPR01'), 'PLANTAO');
  assert.equal(categoriaDaSigla('ETGPR15'), 'MOTO');
  assert.equal(categoriaDaSigla('EBGPR62'), 'BT_ZERO');
});

test('prefixo desconhecido cai em OPERACIONAL', () => {
  assert.equal(categoriaDaSigla('EXGPR99'), 'OPERACIONAL');
  assert.equal(categoriaDaSigla('ZZZZ01'),  'OPERACIONAL');
});

test('a comparação ignora a caixa', () => {
  assert.equal(categoriaDaSigla('etgpr15'), 'MOTO');
  assert.equal(categoriaDaSigla('eBgPr62'), 'BT_ZERO');
});

test('sigla vazia, null ou undefined não estoura', () => {
  assert.equal(categoriaDaSigla(''),        'OPERACIONAL');
  assert.equal(categoriaDaSigla(null),      'OPERACIONAL');
  assert.equal(categoriaDaSigla(undefined), 'OPERACIONAL');
});

// ─────────────────────────────────────────────────────────────────────────────
// prefixoDaCategoria — o caminho inverso
// ─────────────────────────────────────────────────────────────────────────────

test('devolve o prefixo de cada categoria nomeada', () => {
  assert.equal(prefixoDaCategoria('COMERCIAL'), 'EC');
  assert.equal(prefixoDaCategoria('PLANTAO'),   'EP');
  assert.equal(prefixoDaCategoria('MOTO'),      'ET');
  assert.equal(prefixoDaCategoria('BT_ZERO'),   'EB');
});

test('OPERACIONAL não tem prefixo próprio — é o complemento', () => {
  assert.equal(prefixoDaCategoria('OPERACIONAL'), null);
});

test('chave desconhecida devolve null', () => {
  assert.equal(prefixoDaCategoria('INVENTADA'), null);
  assert.equal(prefixoDaCategoria(null),        null);
});

// ─────────────────────────────────────────────────────────────────────────────
// O catálogo em si
// ─────────────────────────────────────────────────────────────────────────────

test('o catálogo tem os cinco campos em toda entrada', () => {
  CATEGORIAS.forEach(c => {
    ['prefixo', 'chave', 'rotulo', 'badge', 'cssBarra'].forEach(campo =>
      assert.ok(c[campo], `categoria ${c.chave} sem o campo ${campo}`));
  });
  assert.ok(OPERACIONAL.chave && OPERACIONAL.badge && OPERACIONAL.cssBarra);
});

test('as chaves que viajam na URL não mudaram', () => {
  // ?tipo=COMERCIAL está em link e favorito de gente. Renomear quebra sem ganho.
  const chaves = CATEGORIAS.map(c => c.chave);
  assert.ok(chaves.includes('COMERCIAL'));
  assert.ok(chaves.includes('PLANTAO'));
});

// ─────────────────────────────────────────────────────────────────────────────
// filtroDeCategorias — o multi que a API passou a aceitar
// ─────────────────────────────────────────────────────────────────────────────

test('duas categorias: aceita as duas, recusa as outras', () => {
  const passa = filtroDeCategorias(['COMERCIAL', 'MOTO']);
  assert.equal(passa('ECGPR53'), true);
  assert.equal(passa('ETGPR15'), true);
  assert.equal(passa('EPGPR01'), false);
  assert.equal(passa('EBGPR62'), false);
});

test('aceita CSV além de array — é o que vem na query string', () => {
  const passa = filtroDeCategorias('COMERCIAL, MOTO');
  assert.equal(passa('ECGPR53'), true);
  assert.equal(passa('EPGPR01'), false);
});

test('TODAS, vazio, null e undefined não filtram nada', () => {
  [['TODAS'], 'TODAS', [], '', null, undefined].forEach(entrada => {
    const passa = filtroDeCategorias(entrada);
    assert.equal(passa('ECGPR53'), true, `entrada ${JSON.stringify(entrada)}`);
    assert.equal(passa('EXGPR99'), true, `entrada ${JSON.stringify(entrada)}`);
  });
});

test('TODAS vence quando vem junto de outra', () => {
  const passa = filtroDeCategorias(['COMERCIAL', 'TODAS']);
  assert.equal(passa('EPGPR01'), true);
});

test('OPERACIONAL aceita só o que NÃO casa com prefixo do catálogo', () => {
  // Sem esta opção, equipe de prefixo novo ficaria inalcançável por filtro:
  // visível só em "Todas". Este projeto já tem histórico demais de dado que
  // some sem avisar (P1-39, P2-19).
  const passa = filtroDeCategorias(['OPERACIONAL']);
  assert.equal(passa('EXGPR99'), true);
  assert.equal(passa('ECGPR53'), false);
  assert.equal(passa('ETGPR15'), false);
});

test('chave inventada não deixa passar tudo por engano', () => {
  const passa = filtroDeCategorias(['NAOEXISTE']);
  assert.equal(passa('ECGPR53'), false);
  assert.equal(passa('EXGPR99'), false);
});
