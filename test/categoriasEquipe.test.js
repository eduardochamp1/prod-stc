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

// ─────────────────────────────────────────────────────────────────────────────
// O backend usa o catálogo — nada de ternário sobrevivendo
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('node:fs');
const path = require('node:path');

const QUERIES = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'queries.js'), 'utf8');

test('db/queries.js não tem mais startsWith de prefixo solto', () => {
  // Era a duplicação que este trabalho eliminou. Se voltar, o catálogo deixou
  // de ser único sem ninguém perceber.
  assert.ok(!/startsWith\(['"]E[CPTB]['"]\)/.test(QUERIES),
    'voltou um startsWith de prefixo hard-coded em db/queries.js');
});

test('db/queries.js importa o catálogo', () => {
  assert.ok(QUERIES.includes("require('../services/categoriasEquipe')"),
    'db/queries.js tem de ler do módulo, não reimplementar');
});

test('_buildEquipeTipoMatrix classifica ET e EB', () => {
  const { _buildEquipeTipoMatrix } = require('../db/queries');
  const { equipes } = _buildEquipeTipoMatrix([
    { team_name: 'ETGPR15', regional: 'GUA', sector_id: 'DESG', tipo_code: 'DL', count: 5 },
    { team_name: 'EBGPR62', regional: 'GUA', sector_id: 'DESG', tipo_code: 'LN', count: 3 },
  ], [], 'TODAS');

  const porNome = Object.fromEntries(equipes.map(e => [e.team_name, e.tipo_equipe]));
  assert.equal(porNome.ETGPR15, 'MOTO');
  assert.equal(porNome.EBGPR62, 'BT_ZERO');
});

test('_buildEquipeTipoMatrix filtra por DUAS categorias', () => {
  // O ganho concreto do filtro multi: antes, pedir duas devolvia todas.
  const { _buildEquipeTipoMatrix } = require('../db/queries');
  const rows = [
    { team_name: 'ECGPR53', regional: 'GUA', sector_id: 'DESG', tipo_code: 'LN', count: 1 },
    { team_name: 'EPGPR01', regional: 'GUA', sector_id: 'DESG', tipo_code: 'LN', count: 1 },
    { team_name: 'ETGPR15', regional: 'GUA', sector_id: 'DESG', tipo_code: 'LN', count: 1 },
  ];
  const { equipes } = _buildEquipeTipoMatrix(rows, [], 'COMERCIAL,MOTO');

  assert.deepEqual(equipes.map(e => e.team_name).sort(), ['ECGPR53', 'ETGPR15']);
});

test('_buildEquipeTipoMatrix com TODAS continua devolvendo tudo', () => {
  const { _buildEquipeTipoMatrix } = require('../db/queries');
  const rows = [
    { team_name: 'ECGPR53', regional: 'GUA', sector_id: 'DESG', tipo_code: 'LN', count: 1 },
    { team_name: 'EPGPR01', regional: 'GUA', sector_id: 'DESG', tipo_code: 'LN', count: 1 },
  ];
  const { equipes } = _buildEquipeTipoMatrix(rows, [], 'TODAS');
  assert.equal(equipes.length, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// As duas cópias não podem divergir
// ─────────────────────────────────────────────────────────────────────────────

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** Extrai e executa o literal do catálogo que vive no index.html. */
function catalogoDoFront() {
  const marca = 'const CATEGORIAS_EQUIPE = [';
  const ini = SRC.indexOf(marca);
  assert.ok(ini > -1, `não achei "${marca}" no index.html`);
  const fim = SRC.indexOf('];', ini);
  assert.ok(fim > -1, 'o literal do catálogo não fechou');
  const literal = SRC.slice(ini + marca.length - 1, fim + 1);
  return new Function(`return ${literal};`)();
}

test('o catálogo do front tem as MESMAS entradas do backend, na mesma ordem', () => {
  // Duas cópias existem porque são dois runtimes e o projeto não tem bundler.
  // Este teste é o que impede as duas de divergirem em silêncio: acrescentar
  // uma categoria de um lado só deixa a suíte vermelha antes do push.
  const front = catalogoDoFront();

  assert.equal(front.length, CATEGORIAS.length,
    `front tem ${front.length} categorias e o backend tem ${CATEGORIAS.length}`);

  CATEGORIAS.forEach((back, i) => {
    ['prefixo', 'chave', 'rotulo', 'badge', 'cssBarra'].forEach(campo => {
      assert.equal(front[i][campo], back[campo],
        `categoria ${i} (${back.chave}): campo "${campo}" difere — ` +
        `front="${front[i][campo]}" backend="${back[campo]}"`);
    });
  });
});

test('o front também conhece o OPERACIONAL, com os mesmos rótulo e badge', () => {
  const i = SRC.indexOf('const CATEGORIA_OPERACIONAL');
  assert.ok(i > -1, 'não achei CATEGORIA_OPERACIONAL no index.html');
  const fim = SRC.indexOf('};', i);
  const literal = SRC.slice(SRC.indexOf('{', i), fim + 1);
  const front = new Function(`return ${literal};`)();

  ['chave', 'rotulo', 'badge', 'cssBarra'].forEach(campo =>
    assert.equal(front[campo], OPERACIONAL[campo], `campo "${campo}" difere`));
});
