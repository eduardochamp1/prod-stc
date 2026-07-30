/**
 * test/deslogadas.test.js
 *
 * Trava _reconstruirDeslogada: reconstrói a última sessão de uma equipe
 * deslogada (não logou hoje) pro modo "Todas" do Monitor. Ver
 * SPEC-monitor-deslogadas-2026-07-29.
 *
 * Invariantes: id estável 'deslog:SIGLA'; flag deslogada; ultimaSessaoDate;
 * notas concluídas/rejeitadas vêm da UNIÃO; andamento/placa/colaboradores/sessão
 * do último snapshot; metrics pré-calculadas (o front não filtra por range).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { _reconstruirDeslogada } = require('../db/queries');

const nota = (id) => ({ id, codigo: id, tipoCode: 'LN' });

// resultado da UNIÃO (dataWriter._unionTeamsFromSnapshots)
const unido = {
  teamName: 'ECGPR53', regional: 'GUA', sectorId: 'DESG',
  sessionBegin: '2026-07-20T07:30:00-03:00',
  notasConcluidas: [nota('a'), nota('b'), nota('c')],   // 3 concluídas (fiel)
  notasRejeitadas: [nota('r')],                          // 1 rejeitada
};
// snapshot MAIS RECENTE do último dia (estado final)
const ultimoData = {
  vehiclePlate: 'PQR-4521',
  collaborators: [{ nome: 'João' }, { nome: 'Maria' }],
  sessionBegin: '2026-07-20T13:00:00-03:00',   // relogou — begin da última sessão
  sessionEnd: '2026-07-20T17:05:00-03:00',
  notasExecutadas: [nota('x')],                 // 1 em andamento no fim
  notasBaixadas: [nota('a'), nota('b'), nota('c'), nota('r'), nota('x'), nota('p')], // 6 baixadas
  tipo: 'PRODUÇÃO',
};
const meta = { tipo: 'PRODUÇÃO', placa: 'ZZZ-0000', regional: 'GUA', escala_inicio: '07:30:00', escala_fim: '17:00:00' };

test('id estável e flags', () => {
  const d = _reconstruirDeslogada(unido, ultimoData, meta, '2026-07-20');
  assert.equal(d.id, 'deslog:ECGPR53');
  assert.equal(d.deslogada, true);
  assert.equal(d.isOnline, false);
  assert.equal(d.ultimaSessaoDate, '2026-07-20');
  assert.equal(d.date, '2026-07-20');
});

test('notas concluídas/rejeitadas vêm da UNIÃO (fiéis)', () => {
  const d = _reconstruirDeslogada(unido, ultimoData, meta, '2026-07-20');
  assert.equal(d.notasConcluidas.length, 3);
  assert.equal(d.notasRejeitadas.length, 1);
});

test('andamento/placa/colaboradores/sessão vêm do último snapshot', () => {
  const d = _reconstruirDeslogada(unido, ultimoData, meta, '2026-07-20');
  assert.equal(d.notasExecutadas.length, 1);
  assert.equal(d.vehiclePlate, 'PQR-4521');           // do snapshot, não do meta
  assert.equal(d.collaborators.length, 2);
  assert.equal(d.sessionEnd, '2026-07-20T17:05:00-03:00');
  assert.equal(d.sessionBeginReal, '2026-07-20T07:30:00-03:00'); // 1o da união
});

test('metrics pré-calculadas (exec/reje da união, carteira reconstruída)', () => {
  const d = _reconstruirDeslogada(unido, ultimoData, meta, '2026-07-20');
  assert.equal(d.metrics.executadas, 3);
  assert.equal(d.metrics.rejeitadas, 1);
  assert.equal(d.metrics.andamento, 1);
  assert.equal(d.metrics.inicial, 6);                 // baixadas do dia
  assert.equal(d.metrics.atual, 6 - 3 - 1 - 1);       // = 1 pendente
});

test('atual nunca fica negativo', () => {
  const u2 = { ...unido, notasConcluidas: [nota('a'), nota('b'), nota('c'), nota('d'), nota('e')] };
  const last = { ...ultimoData, notasBaixadas: [nota('a')] }; // inicial 1 < executadas 5
  const d = _reconstruirDeslogada(u2, last, meta, '2026-07-20');
  assert.equal(d.metrics.atual, 0);
});

test('placa cai pro meta quando o snapshot não tem', () => {
  const last = { ...ultimoData, vehiclePlate: null };
  const d = _reconstruirDeslogada(unido, last, meta, '2026-07-20');
  assert.equal(d.vehiclePlate, 'ZZZ-0000');
});
