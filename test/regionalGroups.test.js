/**
 * test/regionalGroups.test.js
 *
 * Cobre o helper services/regionalGroups.js — fundamental pra segurança:
 * se o `expandRegional` ou `applyRegional` quebrar, usuários veem dados
 * de outras regionais.
 */

const { test } = require('node:test');
const assert   = require('node:assert');
const {
  GROUPS,
  expandRegional,
  applyRegional,
  regionalMatches,
  regionalSqlClause,
  getValidRegionals,
} = require('../services/regionalGroups');

// ── expandRegional ──────────────────────────────────────────────────────────

test('expandRegional: ALL → null (sem filtro)', () => {
  assert.equal(expandRegional('ALL'), null);
  assert.equal(expandRegional('all'), null);
});

test('expandRegional: vazio/null/undefined → null', () => {
  assert.equal(expandRegional(''), null);
  assert.equal(expandRegional(null), null);
  assert.equal(expandRegional(undefined), null);
});

test('expandRegional: GUA → [GUA]', () => {
  assert.deepEqual(expandRegional('GUA'), ['GUA']);
  assert.deepEqual(expandRegional('gua'), ['GUA']);
});

test('expandRegional: CAC → [CAC]', () => {
  assert.deepEqual(expandRegional('CAC'), ['CAC']);
});

test('expandRegional: SJC → [SJC]', () => {
  assert.deepEqual(expandRegional('SJC'), ['SJC']);
});

test('expandRegional: ES → [GUA, CAC] (grupo)', () => {
  assert.deepEqual(expandRegional('ES'), ['GUA', 'CAC']);
  assert.deepEqual(expandRegional('es'), ['GUA', 'CAC']);
});

test('expandRegional: retorna CÓPIA do array (não dá pra mutar o GROUPS)', () => {
  const a = expandRegional('ES');
  a.push('SJC');
  // Lê de novo — deve continuar com 2 elementos
  assert.deepEqual(expandRegional('ES'), ['GUA', 'CAC']);
});

test('expandRegional: valor desconhecido vira lista de 1 (compatibilidade)', () => {
  assert.deepEqual(expandRegional('XYZ'), ['XYZ']);
});

// ── applyRegional (query builder) ───────────────────────────────────────────

function mockQB() {
  const calls = [];
  return {
    calls,
    eq(col, val) { calls.push(['eq', col, val]); return this; },
    in(col, arr) { calls.push(['in', col, arr]); return this; },
  };
}

test('applyRegional: ALL não chama nada', () => {
  const q = mockQB();
  applyRegional(q, 'ALL');
  assert.equal(q.calls.length, 0);
});

test('applyRegional: null/vazio não chama nada', () => {
  const q = mockQB();
  applyRegional(q, null);
  applyRegional(q, '');
  assert.equal(q.calls.length, 0);
});

test('applyRegional: sigla única chama eq', () => {
  const q = mockQB();
  applyRegional(q, 'GUA');
  assert.deepEqual(q.calls, [['eq', 'regional', 'GUA']]);
});

test('applyRegional: grupo ES chama in com lista', () => {
  const q = mockQB();
  applyRegional(q, 'ES');
  assert.deepEqual(q.calls, [['in', 'regional', ['GUA', 'CAC']]]);
});

test('applyRegional: coluna customizada', () => {
  const q = mockQB();
  applyRegional(q, 'ES', 's.regional');
  assert.deepEqual(q.calls, [['in', 's.regional', ['GUA', 'CAC']]]);
});

test('applyRegional: chainable (retorna o builder)', () => {
  const q = mockQB();
  const r = applyRegional(q, 'GUA');
  assert.strictEqual(r, q);
});

// ── regionalSqlClause (raw SQL) ─────────────────────────────────────────────

test('regionalSqlClause: ALL → null, params intactos', () => {
  const params = ['x'];
  const clause = regionalSqlClause('ALL', params);
  assert.equal(clause, null);
  assert.deepEqual(params, ['x']);
});

test('regionalSqlClause: sigla única gera "regional = $N"', () => {
  const params = [];
  const clause = regionalSqlClause('GUA', params);
  assert.equal(clause, 'regional = $1');
  assert.deepEqual(params, ['GUA']);
});

test('regionalSqlClause: respeita params pré-existentes (offset correto)', () => {
  const params = ['2026-01-01', '2026-12-31']; // 2 params já
  const clause = regionalSqlClause('GUA', params);
  assert.equal(clause, 'regional = $3');
  assert.deepEqual(params, ['2026-01-01', '2026-12-31', 'GUA']);
});

test('regionalSqlClause: grupo ES gera "regional IN ($N, $N+1)"', () => {
  const params = [];
  const clause = regionalSqlClause('ES', params);
  assert.equal(clause, 'regional IN ($1, $2)');
  assert.deepEqual(params, ['GUA', 'CAC']);
});

test('regionalSqlClause: coluna prefixada (s.regional)', () => {
  const params = ['2026-01-01'];
  const clause = regionalSqlClause('ES', params, 's.regional');
  assert.equal(clause, 's.regional IN ($2, $3)');
  assert.deepEqual(params, ['2026-01-01', 'GUA', 'CAC']);
});

// ── regionalMatches (filtro em memória) ─────────────────────────────────────

test('regionalMatches: ALL sempre passa', () => {
  assert.equal(regionalMatches('ALL', 'GUA'), true);
  assert.equal(regionalMatches('ALL', 'SJC'), true);
  assert.equal(regionalMatches(null, 'GUA'), true);
});

test('regionalMatches: GUA só casa com GUA', () => {
  assert.equal(regionalMatches('GUA', 'GUA'), true);
  assert.equal(regionalMatches('GUA', 'CAC'), false);
  assert.equal(regionalMatches('GUA', 'SJC'), false);
});

test('regionalMatches: ES casa com GUA e CAC (não SJC)', () => {
  assert.equal(regionalMatches('ES', 'GUA'), true);
  assert.equal(regionalMatches('ES', 'CAC'), true);
  assert.equal(regionalMatches('ES', 'SJC'), false);
});

test('regionalMatches: lower-case em row é normalizado', () => {
  assert.equal(regionalMatches('ES', 'gua'), true);
});

// ── getValidRegionals ───────────────────────────────────────────────────────

test('getValidRegionals: inclui ALL + 3 siglas reais + 1 grupo', () => {
  const all = getValidRegionals();
  assert.ok(all.includes('ALL'));
  assert.ok(all.includes('GUA'));
  assert.ok(all.includes('CAC'));
  assert.ok(all.includes('SJC'));
  assert.ok(all.includes('ES'));
});

// ── GROUPS exposto ──────────────────────────────────────────────────────────

test('GROUPS.ES é exatamente [GUA, CAC]', () => {
  assert.deepEqual(GROUPS.ES, ['GUA', 'CAC']);
});
