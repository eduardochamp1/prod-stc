// test/regionals.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const {
  REGIONAIS_VALIDAS,
  REGIONAIS_NOMES,
  isValidRegional,
  inRegionals,
  inRegionalsSql,
} = require('../services/regionals');

test('REGIONAIS_VALIDAS = Set(GUA, CAC, SJC)', () => {
  assert.deepEqual([...REGIONAIS_VALIDAS].sort(), ['CAC', 'GUA', 'SJC']);
});

test('REGIONAIS_NOMES tem as 3 siglas', () => {
  assert.equal(REGIONAIS_NOMES.GUA, 'Guarapari');
  assert.equal(REGIONAIS_NOMES.CAC, 'Cachoeiro');
  assert.equal(REGIONAIS_NOMES.SJC, 'São José dos Campos');
});

test('isValidRegional: aceita GUA/CAC/SJC (qualquer case)', () => {
  assert.equal(isValidRegional('GUA'), true);
  assert.equal(isValidRegional('gua'), true);
  assert.equal(isValidRegional('CAC'), true);
  assert.equal(isValidRegional('SJC'), true);
});

test('isValidRegional: rejeita ALL/ES/vazio/null', () => {
  assert.equal(isValidRegional('ALL'), false);
  assert.equal(isValidRegional('ES'), false);
  assert.equal(isValidRegional(''), false);
  assert.equal(isValidRegional(null), false);
  assert.equal(isValidRegional(undefined), false);
  assert.equal(isValidRegional('XYZ'), false);
});

function mockQB() {
  const calls = [];
  return { calls, in(col, arr) { calls.push(['in', col, arr]); return this; } };
}

test('inRegionals: chama .in(col, arr)', () => {
  const q = mockQB();
  inRegionals(q, ['GUA']);
  assert.deepEqual(q.calls, [['in', 'regional', ['GUA']]]);
});

test('inRegionals: com múltiplas siglas', () => {
  const q = mockQB();
  inRegionals(q, ['GUA', 'CAC']);
  assert.deepEqual(q.calls, [['in', 'regional', ['GUA', 'CAC']]]);
});

test('inRegionals: coluna customizada', () => {
  const q = mockQB();
  inRegionals(q, ['GUA'], 's.regional');
  assert.deepEqual(q.calls, [['in', 's.regional', ['GUA']]]);
});

test('inRegionals: retorna o builder (chainable)', () => {
  const q = mockQB();
  const r = inRegionals(q, ['GUA']);
  assert.strictEqual(r, q);
});

test('inRegionalsSql: sigla única', () => {
  const params = [];
  const clause = inRegionalsSql(['GUA'], params);
  assert.equal(clause, 'regional IN ($1)');
  assert.deepEqual(params, ['GUA']);
});

test('inRegionalsSql: múltiplas siglas, params vazios', () => {
  const params = [];
  const clause = inRegionalsSql(['GUA', 'CAC'], params);
  assert.equal(clause, 'regional IN ($1,$2)');
  assert.deepEqual(params, ['GUA', 'CAC']);
});

test('inRegionalsSql: respeita offset de params pré-existentes', () => {
  const params = ['2026-01-01', '2026-12-31'];
  const clause = inRegionalsSql(['GUA', 'CAC'], params);
  assert.equal(clause, 'regional IN ($3,$4)');
  assert.deepEqual(params, ['2026-01-01', '2026-12-31', 'GUA', 'CAC']);
});

test('inRegionalsSql: coluna prefixada', () => {
  const params = ['x'];
  const clause = inRegionalsSql(['GUA'], params, 's.regional');
  assert.equal(clause, 's.regional IN ($2)');
});
