/**
 * test/reconexaoViraNoite.test.js  (P1-14)
 *
 * Trava a regra "reconexão vira-noite pertence ao dia do início do turno":
 * uma sessão cujo begin cai dentro de RECONEXAO_MAX_GAP_MIN após o end da
 * anterior (mesma equipe) HERDA o dia operacional da anterior, mesmo cruzando a
 * meia-noite. Ver SPEC-reconexao-vira-noite-2026-07-30.md.
 *
 * Caso real (EPGPR30, 29–30/07): turno A 29/07 20:05 → 30/07 01:08 (6 conc) +
 * reconexão B 30/07 01:10 → 04:00 (3 conc), gap 2 min. Toda a noite deve contar
 * em 29/07 (9 conc), zero em 30/07 — consolidando por 29 E por 30 (invariante).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  _effectiveSessionDates, _unionTeamsFromSnapshots, _aggregateTeamDailyTotals,
} = require('../services/dataWriter');

// ── _effectiveSessionDates (função pura) ──────────────────────────────────────

const sess = (teamName, begin, end) => ({ teamName, sessionBegin: begin, sessionEnd: end });
const eff = (map, team, begin) => map.get(`${team}|${begin}`);

const A_BEGIN = '2026-07-29T20:05:22';
const A_END   = '2026-07-30T01:08:36';
const B_BEGIN = '2026-07-30T01:10:37';   // 2 min depois do fim da A
const B_END   = '2026-07-30T04:00:27';

test('1 sessão → dia do próprio begin', () => {
  const m = _effectiveSessionDates([sess('E1', A_BEGIN, A_END)], 60);
  assert.equal(eff(m, 'E1', A_BEGIN), '2026-07-29');
});

test('reconexão vira-noite (gap 2min ≤ 60) herda o dia do turno (EPGPR30)', () => {
  const m = _effectiveSessionDates([sess('E1', A_BEGIN, A_END), sess('E1', B_BEGIN, B_END)], 60);
  assert.equal(eff(m, 'E1', A_BEGIN), '2026-07-29');
  assert.equal(eff(m, 'E1', B_BEGIN), '2026-07-29', 'B herda 29/07');
});

test('gap acima do limite → dia próprio (turno novo)', () => {
  // logoff 05:00, novo logon 20:00 mesmo dia = 15h de gap
  const m = _effectiveSessionDates([
    sess('E1', '2026-07-30T05:00:00', '2026-07-30T05:30:00'),
    sess('E1', '2026-07-30T20:00:00', '2026-07-31T02:00:00'),
  ], 60);
  assert.equal(eff(m, 'E1', '2026-07-30T20:00:00'), '2026-07-30');
});

test('gap logo abaixo/acima do limite (borda 60min)', () => {
  const base = { begin: '2026-07-29T23:30:00', end: '2026-07-29T23:59:00' };
  const dentro = _effectiveSessionDates([
    sess('E1', base.begin, base.end),
    sess('E1', '2026-07-30T00:30:00', '2026-07-30T01:00:00'),   // 31 min → linka
  ], 60);
  assert.equal(eff(dentro, 'E1', '2026-07-30T00:30:00'), '2026-07-29');
  const fora = _effectiveSessionDates([
    sess('E1', base.begin, base.end),
    sess('E1', '2026-07-30T01:05:00', '2026-07-30T02:00:00'),   // 66 min → não linka
  ], 60);
  assert.equal(eff(fora, 'E1', '2026-07-30T01:05:00'), '2026-07-30');
});

test('end ausente ou gap negativo não linka (conservador)', () => {
  const semEnd = _effectiveSessionDates([
    sess('E1', A_BEGIN, null),
    sess('E1', B_BEGIN, B_END),
  ], 60);
  assert.equal(eff(semEnd, 'E1', B_BEGIN), '2026-07-30', 'sem end da anterior → não linka');
});

test('cadeia A→B→C (2 reconexões) herda o dia da A', () => {
  const m = _effectiveSessionDates([
    sess('E1', A_BEGIN, A_END),                                   // 29
    sess('E1', B_BEGIN, B_END),                                   // linka → 29
    sess('E1', '2026-07-30T04:02:00', '2026-07-30T05:00:00'),     // 2 min após B → 29
  ], 60);
  assert.equal(eff(m, 'E1', '2026-07-30T04:02:00'), '2026-07-29');
});

test('equipes distintas não interferem', () => {
  const m = _effectiveSessionDates([
    sess('E1', A_BEGIN, A_END),
    sess('E2', B_BEGIN, B_END),   // outra equipe — não linka com a E1
  ], 60);
  assert.equal(eff(m, 'E2', B_BEGIN), '2026-07-30');
});

// ── Integração: consolidação atribui a noite inteira ao dia do turno ──────────

const nota = (id, cd, tipo) => ({ id, codigo: id, tipoCode: tipo, conclusionDate: cd });
const snap = (capturedISO, begin, end, cc) => ({
  team_name: 'EPGPR30', regional: 'GUA', sector_id: 'DESG',
  captured_at: capturedISO,
  data: { sessionBegin: begin, sessionEnd: end, notasConcluidas: cc, notasExecutadas: [], notasRejeitadas: [] },
});
// A: 6 conc (LN, cd 29/07). B: 3 conc (PO, cd 30/07 madrugada).
const aConc = [1, 2, 3, 4, 5, 6].map(i => nota('a' + i, '2026-07-29T22:00:00', 'LN'));
const bConc = [1, 2, 3].map(i => nota('b' + i, '2026-07-30T02:30:00', 'PO'));
// DESC por captured_at (mais recente primeiro) — a união pega o end do 1º de cada sessão.
const SNAPS = [
  snap('2026-07-30T05:00:00', B_BEGIN, B_END, bConc),   // sessão B, fim 04:00
  snap('2026-07-30T00:30:00', A_BEGIN, A_END, aConc),   // sessão A, fim 01:08 (mais recente de A)
  snap('2026-07-29T22:10:00', A_BEGIN, null, aConc.slice(0, 4)),  // A mais antiga
];
const totalNoDia = (entries, d) =>
  _aggregateTeamDailyTotals(entries).filter(r => r.date === d).reduce((s, r) => s + r.count, 0);

test('consolidateDay(29): a noite inteira (9 conc) cai em 29/07, zero em 30/07', () => {
  const u = _unionTeamsFromSnapshots(SNAPS, '2026-07-29', '2026-07-28');
  assert.equal(totalNoDia(u, '2026-07-29'), 9);
  assert.equal(totalNoDia(u, '2026-07-30'), 0);
});

test('consolidateDay(30): invariante — B foi pra 29, então 30/07 fica zero', () => {
  const u = _unionTeamsFromSnapshots(SNAPS, '2026-07-30', '2026-07-29');
  assert.equal(totalNoDia(u, '2026-07-30'), 0, 'sem dupla contagem: B pertence a 29');
  assert.equal(totalNoDia(u, '2026-07-29'), 9);
});

test('contraste: SEM linkagem (gap 0) a B fica em 30/07 (3 conc)', () => {
  const u = _unionTeamsFromSnapshots(SNAPS, '2026-07-30', '2026-07-29', { reconexaoGapMin: 0 });
  assert.equal(totalNoDia(u, '2026-07-30'), 3);
});
