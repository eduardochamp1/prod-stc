/**
 * test/dataWriter.test.js
 *
 * Trava a REGRA DE NEGÓCIO mais crítica do sistema (P0-3 do backlog): como cada
 * nota é atribuída a um dia (_notaDate/_sessionDate) e como notasConcluidas
 * viram rows de team_daily_totals (_aggregateTeamDailyTotals). São os números
 * reportados à EDP — bug aqui distorce produtividade silenciosamente.
 *
 * Funções PURAS (sem DB) — testadas diretamente.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  _sessionDate, _notaDate, _aggregateTeamDailyTotals,
} = require('../services/dataWriter');

// ── _sessionDate ──────────────────────────────────────────────────────────────

test('_sessionDate: extrai YYYY-MM-DD do sessionBegin', () => {
  assert.equal(_sessionDate({ sessionBegin: '2026-04-26T10:59:03.96' }), '2026-04-26');
});

test('_sessionDate: sem sessionBegin → null (equipe descartada)', () => {
  assert.equal(_sessionDate({}), null);
  assert.equal(_sessionDate({ sessionBegin: null }), null);
  assert.equal(_sessionDate(null), null);
});

test('_sessionDate: formato inesperado → null', () => {
  assert.equal(_sessionDate({ sessionBegin: 'ontem' }), null);
});

// ── _notaDate ───────────────────────────────────────────────────────────────
// Regra: nota pertence ao DIA DA SESSÃO. Exceção: conclusionDate ANTERIOR
// ao sessionDate → conta no dia da conclusão (nota "veio do passado").

test('_notaDate: sem conclusionDate → dia da sessão (vira-noite)', () => {
  assert.equal(_notaDate({}, '2026-05-22', '2026-05-22T07:00:00'), '2026-05-22');
});

test('_notaDate: conclusionDate no MESMO dia da sessão → dia da sessão', () => {
  assert.equal(
    _notaDate({ conclusionDate: '2026-05-22T14:00:00' }, '2026-05-22', '2026-05-22T07:00:00'),
    '2026-05-22'
  );
});

test('_notaDate: conclusionDate ANTERIOR ao sessionDate → dia da conclusão', () => {
  // Caso real ETGPR15/ETPIU15 (22/05 logou com notas concluídas em 21/05)
  assert.equal(
    _notaDate({ conclusionDate: '2026-05-21T15:30:00' }, '2026-05-22', '2026-05-22T07:00:00'),
    '2026-05-21'
  );
});

test('_notaDate: conclusionDate POSTERIOR ao sessionDate → mantém sessão (vira-noite)', () => {
  // Equipe logou 22/05 07h, virou a noite, concluiu 23/05 02h → conta em 22/05
  assert.equal(
    _notaDate({ conclusionDate: '2026-05-23T02:00:00' }, '2026-05-22', '2026-05-22T07:00:00'),
    '2026-05-22'
  );
});

test('_notaDate: conclusionDate malformado → dia da sessão (fallback seguro)', () => {
  assert.equal(
    _notaDate({ conclusionDate: 'invalido' }, '2026-05-22', '2026-05-22T07:00:00'),
    '2026-05-22'
  );
});

// ── _aggregateTeamDailyTotals ─────────────────────────────────────────────────
// Conta SÓ notasConcluidas, agrupa por (date, team, tipo_code).

test('_aggregate: conta só notasConcluidas por tipo', () => {
  const teams = [{
    teamName: 'EPGPR31', regional: 'GUA', sectorId: 'DESG',
    sessionBegin: '2026-05-22T07:00:00',
    notasConcluidas: [
      { id: 'a', tipoCode: 'LN' },
      { id: 'b', tipoCode: 'LN' },
      { id: 'c', tipoCode: 'MD' },
    ],
    notasExecutadas: [{ id: 'x', tipoCode: 'LN' }], // NÃO deve contar
  }];
  const rows = _aggregateTeamDailyTotals(teams);
  const byTipo = Object.fromEntries(rows.map(r => [r.tipo_code, r.count]));
  assert.equal(byTipo.LN, 2);
  assert.equal(byTipo.MD, 1);
  assert.equal(rows.every(r => r.team_name === 'EPGPR31' && r.regional === 'GUA'), true);
});

test('_aggregate: equipe sem sessionBegin é ignorada', () => {
  const rows = _aggregateTeamDailyTotals([
    { teamName: 'SEM_SESSAO', notasConcluidas: [{ id: 'a', tipoCode: 'LN' }] },
  ]);
  assert.equal(rows.length, 0);
});

test('_aggregate: nota sem tipoCode é ignorada', () => {
  const rows = _aggregateTeamDailyTotals([{
    teamName: 'E1', regional: 'GUA', sessionBegin: '2026-05-22T07:00:00',
    notasConcluidas: [{ id: 'a' }], // sem tipoCode
  }]);
  assert.equal(rows.length, 0);
});

test('_aggregate: nota com conclusionDate de ontem cai no dia anterior', () => {
  const rows = _aggregateTeamDailyTotals([{
    teamName: 'ETGPR15', regional: 'GUA', sessionBegin: '2026-05-22T07:55:00',
    notasConcluidas: [
      { id: 'a', tipoCode: 'MD', conclusionDate: '2026-05-21T15:00:00' }, // ontem
      { id: 'b', tipoCode: 'MD', conclusionDate: '2026-05-22T09:00:00' }, // hoje
    ],
  }]);
  const byDate = Object.fromEntries(rows.map(r => [r.date, r.count]));
  assert.equal(byDate['2026-05-21'], 1);
  assert.equal(byDate['2026-05-22'], 1);
});

test('_aggregate: aceita sigla como fallback de teamName', () => {
  const rows = _aggregateTeamDailyTotals([{
    sigla: 'E9', regional: 'CAC', sessionBegin: '2026-05-22T07:00:00',
    notasConcluidas: [{ id: 'a', tipoCode: 'LN' }],
  }]);
  assert.equal(rows[0].team_name, 'E9');
});

test('_aggregate: array vazio → []', () => {
  assert.deepEqual(_aggregateTeamDailyTotals([]), []);
});
