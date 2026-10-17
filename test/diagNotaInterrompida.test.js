/**
 * test/diagNotaInterrompida.test.js
 *
 * --setor do scripts/diag-nota-interrompida.js (16/10/2026): Guarapari tem
 * DESG e DEPT e a equipe é transferida entre eles — o diagnóstico tem que
 * olhar os dois numa execução só, não exigir rodar duas vezes.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { resolverSetores } = require('../scripts/diag-nota-interrompida');

test('GUA expande para DESG e DEPT', () => {
  assert.deepEqual(resolverSetores('GUA'), ['DESG', 'DEPT']);
  assert.deepEqual(resolverSetores('gua'), ['DESG', 'DEPT']);
});

test('CAC e SJC são 1:1', () => {
  assert.deepEqual(resolverSetores('CAC'), ['DESC']);
  assert.deepEqual(resolverSetores('SJC'), ['DSSJ']);
});

test('setor avulso e lista, sem repetir', () => {
  assert.deepEqual(resolverSetores('DEPT'), ['DEPT']);
  assert.deepEqual(resolverSetores('DESG,DESC'), ['DESG', 'DESC']);
  assert.deepEqual(resolverSetores('GUA,DESG'), ['DESG', 'DEPT']);
});

test('valor inválido falha alto, não cai num setor default', () => {
  assert.throws(() => resolverSetores('XYZ'), /inválido/);
  assert.throws(() => resolverSetores(''), /vazio/);
});
