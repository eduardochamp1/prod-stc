/**
 * test/unionSnapshots.test.js
 *
 * Trava _unionTeamsFromSnapshots (P1-13): a consolidação do dia deve UNIR as
 * concluídas/rejeitadas de TODOS os snapshots de cada (equipe, sessão), não só
 * do último — senão subnotifica a produção quando a WPA rotaciona o Concluded[]
 * ou o _acc é perdido num restart.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { _unionTeamsFromSnapshots, _aggregateTeamDailyTotals } = require('../services/dataWriter');

const D = '2026-07-22';
const Dm1 = '2026-07-21';
const nota = (id, tipo = 'LN') => ({ id, codigo: id, tipoCode: tipo });
// snapshot row (ordem DESC por captured_at é responsabilidade do caller)
const snap = (team, ts, { ex = [], cc = [], rj = [], sessionBegin = `${D}T08:00:00` } = {}) => ({
  team_name: team, regional: 'GUA', sector_id: 'DESG',
  captured_at: `${D}T${ts}:00-03:00`,
  data: { sessionBegin, notasExecutadas: ex, notasConcluidas: cc, notasRejeitadas: rj },
});
const concIds = (t) => (t.notasConcluidas || []).map(n => n.id).sort();
const rejIds  = (t) => (t.notasRejeitadas  || []).map(n => n.id).sort();

// ── UNIÃO de concluídas ao longo do dia ───────────────────────────────────────

test('une concluídas de todos os snapshots — recupera a que sumiu do último', () => {
  // DESC: último (17:00) tem só [C]; snapshots anteriores tinham A, B, C.
  const snaps = [
    snap('T', '17:00', { cc: [nota('C')] }),                     // último — WPA rotacionou A e B pra fora
    snap('T', '15:00', { cc: [nota('B'), nota('C')] }),
    snap('T', '13:00', { cc: [nota('A'), nota('B')] }),
  ];
  const teams = _unionTeamsFromSnapshots(snaps, D, Dm1);
  assert.equal(teams.length, 1);
  assert.deepEqual(concIds(teams[0]), ['A', 'B', 'C'], 'união recupera A e B que sumiram do último');
});

test('sem união seria só o último (contraste): produtividade agrega as 3', () => {
  const snaps = [
    snap('T', '17:00', { cc: [nota('C', 'LN')] }),
    snap('T', '13:00', { cc: [nota('A', 'LN'), nota('B', 'LN')] }),
  ];
  const teams = _unionTeamsFromSnapshots(snaps, D, Dm1);
  const total = _aggregateTeamDailyTotals(teams).reduce((s, r) => s + r.count, 0);
  assert.equal(total, 3, 'A, B, C contam como produção (não só C do último snapshot)');
});

// ── executadas vem do MAIS RECENTE (DESC → 1ª ocorrência) ─────────────────────

test('notasExecutadas (andamento) vem do snapshot mais recente', () => {
  const snaps = [
    snap('T', '17:00', { ex: [nota('X')] }),
    snap('T', '13:00', { ex: [nota('Y'), nota('Z')] }),
  ];
  const teams = _unionTeamsFromSnapshots(snaps, D, Dm1);
  assert.deepEqual((teams[0].notasExecutadas || []).map(n => n.id), ['X']);
});

// ── rejeitadas também são unidas ──────────────────────────────────────────────

test('une rejeitadas de todos os snapshots', () => {
  const snaps = [
    snap('T', '17:00', { rj: [nota('R2')] }),
    snap('T', '13:00', { rj: [nota('R1')] }),
  ];
  const teams = _unionTeamsFromSnapshots(snaps, D, Dm1);
  assert.deepEqual(rejIds(teams[0]), ['R1', 'R2']);
});

// ── dedup por UUID + sessões distintas ────────────────────────────────────────

test('dedup por UUID: mesma nota em vários snapshots conta 1x', () => {
  const snaps = [
    snap('T', '17:00', { cc: [nota('A'), nota('A')] }),
    snap('T', '13:00', { cc: [nota('A')] }),
  ];
  const teams = _unionTeamsFromSnapshots(snaps, D, Dm1);
  assert.deepEqual(concIds(teams[0]), ['A']);
});

test('sessões distintas da mesma equipe viram entradas separadas', () => {
  const snaps = [
    snap('T', '17:00', { cc: [nota('B')], sessionBegin: `${D}T13:00:00` }),
    snap('T', '10:00', { cc: [nota('A')], sessionBegin: `${D}T08:00:00` }),
  ];
  const teams = _unionTeamsFromSnapshots(snaps, D, Dm1).sort((a, b) => a.sessionBegin.localeCompare(b.sessionBegin));
  assert.equal(teams.length, 2);
  assert.deepEqual(concIds(teams[0]), ['A']);
  assert.deepEqual(concIds(teams[1]), ['B']);
});

// ── filtro de sessionDate (só date e date-1) ──────────────────────────────────

test('ignora snapshots cuja sessão não é de date nem date-1', () => {
  const snaps = [
    snap('T', '09:00', { cc: [nota('A')], sessionBegin: `${D}T08:00:00` }),      // hoje → entra
    snap('U', '09:00', { cc: [nota('Z')], sessionBegin: '2026-07-10T08:00:00' }), // 12 dias atrás → fora
  ];
  const teams = _unionTeamsFromSnapshots(snaps, D, Dm1);
  assert.equal(teams.length, 1);
  assert.equal(teams[0].teamName, 'T');
});

test('nota sem id/codigo é ignorada na união', () => {
  const snaps = [snap('T', '13:00', { cc: [{ tipoCode: 'LN' }, nota('A')] })];
  const teams = _unionTeamsFromSnapshots(snaps, D, Dm1);
  assert.deepEqual(concIds(teams[0]), ['A']);
});
