/**
 * test/equipesImport.test.js
 *
 * `montarPlano` e as regras de validação de equipe oficial.
 *
 * Função pura: sem banco, sem DOM, sem rede. É onde mora toda a decisão da
 * importação em lote — ver docs/handoff/SPEC-import-equipes-2026-09-17.md.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { validateEquipe, MAX_LINHAS } = require('../services/equipesImport');

test('validateEquipe aceita uma equipe completa e válida', () => {
  const erros = validateEquipe({
    sigla: 'EBGPR62', setor: 'DESG', regional: 'GUA',
    tipo: 'BTZERO', placa: 'ABC-1234',
  });
  assert.deepEqual(erros, []);
});

test('validateEquipe recusa sigla curta, setor e regional inválidos', () => {
  const erros = validateEquipe({
    sigla: 'EB', setor: 'XXXX', regional: 'ZZZ', tipo: 'BTZERO',
  });
  assert.equal(erros.length, 3);
  assert.ok(erros.some(e => /sigla/.test(e)));
  assert.ok(erros.some(e => /setor/.test(e)));
  assert.ok(erros.some(e => /regional/.test(e)));
});

test('validateEquipe aceita DSSJ como setor', () => {
  const erros = validateEquipe({
    sigla: 'ESJSP01', setor: 'DSSJ', regional: 'SJC', tipo: 'COMERCIAL',
  });
  assert.deepEqual(erros, []);
});

test('validateEquipe trata placa como opcional', () => {
  assert.deepEqual(validateEquipe({
    sigla: 'EBGPR62', setor: 'DESG', regional: 'GUA', tipo: 'CS',
  }), []);
});

test('MAX_LINHAS é 500', () => {
  assert.equal(MAX_LINHAS, 500);
});
