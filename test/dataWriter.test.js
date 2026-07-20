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

// ── DEDUP por múltiplas sessões (bug ECCSJ82 08/07/2026) ──────────────────────
// Equipe que reloga no dia gera 1 entrada por sessão em `teams`, e cada sessão
// carrega no payload as MESMAS notas concluídas acumuladas. A mesma nota NÃO
// pode contar 1x por sessão — senão a produção infla (era 18 notas → 143).

test('_aggregate: mesma nota em 3 sessões da equipe conta 1x (não 3x)', () => {
  const sessao = (sb) => ({
    teamName: 'ECCSJ82', regional: 'SJC', sessionBegin: sb,
    // as MESMAS 2 notas aparecem em todas as sessões (payload acumulado)
    notasConcluidas: [
      { id: 'nota-1', tipoCode: 'MD' },
      { id: 'nota-2', tipoCode: 'MD' },
    ],
  });
  const teams = [
    sessao('2026-07-01T06:00:00'),
    sessao('2026-07-01T10:30:00'),
    sessao('2026-07-01T14:15:00'),
  ];
  const rows = _aggregateTeamDailyTotals(teams);
  const md = rows.find(r => r.tipo_code === 'MD' && r.date === '2026-07-01');
  assert.equal(md.count, 2, 'duas notas distintas, contadas 1x cada apesar de 3 sessões');
});

test('_aggregate: nota concluída E rejeitada NÃO conta como produção (rejeitada > concluída)', () => {
  // Decisão 20/07/2026: o WPA mantém a nota em Concluded[] mesmo após a EDP
  // rejeitar. Produção reportada à EDP não pode incluir nota rejeitada.
  const rows = _aggregateTeamDailyTotals([{
    teamName: 'ECTSJ83', regional: 'SJC', sessionBegin: '2026-07-20T07:00:00',
    notasConcluidas: [
      { id: 'a', tipoCode: 'LN' },
      { id: 'b', tipoCode: 'LN' },  // também em rejeitadas → NÃO conta
    ],
    notasRejeitadas: [{ id: 'b', tipoCode: 'LN' }],
  }]);
  const ln = rows.find(r => r.tipo_code === 'LN');
  assert.equal(ln.count, 1, 'só "a" conta; "b" foi rejeitada pela EDP');
});

test('_aggregate: notas distintas entre sessões somam (dedup não apaga legítimas)', () => {
  const teams = [
    { teamName: 'E1', regional: 'GUA', sessionBegin: '2026-07-01T06:00:00',
      notasConcluidas: [{ id: 'a', tipoCode: 'LN' }, { id: 'b', tipoCode: 'LN' }] },
    { teamName: 'E1', regional: 'GUA', sessionBegin: '2026-07-01T13:00:00',
      notasConcluidas: [{ id: 'b', tipoCode: 'LN' }, { id: 'c', tipoCode: 'LN' }] }, // b repete, c nova
  ];
  const rows = _aggregateTeamDailyTotals(teams);
  const ln = rows.find(r => r.tipo_code === 'LN');
  assert.equal(ln.count, 3, 'a, b, c = 3 distintas (b não conta 2x)');
});

test('_aggregate: dedup é por equipe — mesma nota em equipes diferentes conta em cada', () => {
  // Nota transferida entre equipes: conta na produção de ambas (visão individual).
  const teams = [
    { teamName: 'E1', regional: 'GUA', sessionBegin: '2026-07-01T06:00:00',
      notasConcluidas: [{ id: 'x', tipoCode: 'MD' }] },
    { teamName: 'E2', regional: 'GUA', sessionBegin: '2026-07-01T06:00:00',
      notasConcluidas: [{ id: 'x', tipoCode: 'MD' }] },
  ];
  const rows = _aggregateTeamDailyTotals(teams);
  assert.equal(rows.length, 2);
  assert.equal(rows.every(r => r.count === 1), true);
});

test('_aggregate: rows não vazam campo interno _ids', () => {
  const rows = _aggregateTeamDailyTotals([{
    teamName: 'E1', regional: 'GUA', sessionBegin: '2026-07-01T06:00:00',
    notasConcluidas: [{ id: 'a', tipoCode: 'LN' }],
  }]);
  assert.equal('_ids' in rows[0], false, '_ids é auxiliar — não pode ir pro upsert');
  assert.deepEqual(Object.keys(rows[0]).sort(),
    ['count', 'date', 'regional', 'sector_id', 'team_name', 'tipo_code']);
});
