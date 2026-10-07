'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizarNome, validarNome, supervisorVigente, linhaHistorico,
} = require('../services/supervisores');

test('normalizarNome: caixa e espaços, acento preservado', () => {
  assert.equal(normalizarNome('  joão   da  silva '), 'JOÃO DA SILVA');
  assert.equal(normalizarNome(null), '');
  // Acento NÃO é removido: fundir duas pessoas some calado.
  assert.notEqual(normalizarNome('joão'), normalizarNome('joao'));
});

test('validarNome', () => {
  assert.deepEqual(validarNome('Maria Souza'), []);
  assert.deepEqual(validarNome("D'ÁVILA-LIMA JR."), []);
  assert.equal(validarNome('').length, 1);
  assert.equal(validarNome('ab').length, 1);
  assert.equal(validarNome('x'.repeat(81)).length, 1);
  // Sigla de equipe colada no campo errado.
  assert.equal(validarNome('ECGPR51').length, 1);
});

const HIST = [
  { sigla: 'ECGPR51', desde: '2026-10-07', supervisor_id: 1 },
  { sigla: 'ECGPR51', desde: '2026-11-01', supervisor_id: 2 },
  { sigla: 'ECGPR51', desde: '2026-12-01', supervisor_id: null },
  { sigla: 'EPCIT30', desde: '2026-10-07', supervisor_id: 3 },
];

test('supervisorVigente: cada dia é do supervisor vigente NAQUELE dia', () => {
  assert.equal(supervisorVigente(HIST, 'ECGPR51', '2026-10-07'), 1);
  assert.equal(supervisorVigente(HIST, 'ECGPR51', '2026-10-31'), 1);
  assert.equal(supervisorVigente(HIST, 'ECGPR51', '2026-11-01'), 2);
  assert.equal(supervisorVigente(HIST, 'ecgpr51 ', '2026-11-15'), 2);
});

test('supervisorVigente: antes do 1º vínculo e após desvínculo → null', () => {
  // Não inventa que o supervisor atual já valia antes de ser registrado.
  assert.equal(supervisorVigente(HIST, 'ECGPR51', '2026-10-06'), null);
  assert.equal(supervisorVigente(HIST, 'ECGPR51', '2026-12-15'), null);
  assert.equal(supervisorVigente(HIST, 'SEMHIST', '2026-10-07'), null);
});

test('supervisorVigente: ordem do array não importa; desde como timestamp', () => {
  const rev = [...HIST].reverse().map(h => ({ ...h, desde: h.desde + 'T00:00:00.000Z' }));
  assert.equal(supervisorVigente(rev, 'ECGPR51', '2026-11-20'), 2);
});

test('linhaHistorico: sem mudança não gera vigência nova', () => {
  assert.equal(linhaHistorico({ sigla: 'X', idAtual: 1, idNovo: 1, hojeISO: '2026-10-07' }), null);
  assert.equal(linhaHistorico({ sigla: 'X', idAtual: '1', idNovo: 1, hojeISO: '2026-10-07' }), null);
  assert.equal(linhaHistorico({ sigla: 'X', idAtual: null, idNovo: null, hojeISO: '2026-10-07' }), null);
  assert.equal(linhaHistorico({ sigla: 'X', idAtual: undefined, idNovo: null, hojeISO: '2026-10-07' }), null);
});

test('linhaHistorico: troca e desvínculo', () => {
  const l = linhaHistorico({ sigla: 'ecgpr51', idAtual: 1, idNovo: 2, hojeISO: '2026-10-07', usuario: 'admin' });
  assert.equal(l.sigla, 'ECGPR51');
  assert.equal(l.desde, '2026-10-07');
  assert.equal(l.supervisor_id, 2);
  assert.equal(l.registrado_por, 'admin');
  const d = linhaHistorico({ sigla: 'X', idAtual: 2, idNovo: null, hojeISO: '2026-10-07' });
  assert.equal(d.supervisor_id, null);
});
