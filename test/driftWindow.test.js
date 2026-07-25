/**
 * test/driftWindow.test.js
 *
 * Trava a ASSIMETRIA DE JANELA da consolidação (descoberta em 25/07/2026).
 *
 * `consolidateDay(X)` monta equipes com sessão em {X-1, X} mas WIPA {X-1, X}.
 * Consequência: quem grava o valor COMPLETO de um dia D é o passe de **D+1** —
 * a janela dele inclui as sessões da manhã seguinte, que carregam notas
 * concluídas em D por equipe que relogou (via _notaDate: conclusionDate < sessDate
 * → a nota volta pro dia da conclusão).
 *
 * O passe centrado em D NÃO vê essas sessões. Usá-lo como régua do detectDrift
 * subcontava ~6% e o auto-reparo "corrigia" a tabela pra baixo, APAGANDO produção
 * legítima: o 07-22 perdeu 172 OS (1161 → 989) num sweep das 02:00, e o 07-13
 * media 850 pela régua de D contra 903 reais (as 21 equipes com gap batiam 1:1
 * com o passe de D+1). Ver scripts/diag-drift-team.js e detectDrift.
 *
 * Se algum destes testes quebrar, o auto-reparo voltou a comer produção.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  _addDays, _unionTeamsFromSnapshots, _aggregateTeamDailyTotals,
} = require('../services/dataWriter');

const D    = '2026-07-13';
const Dm1  = '2026-07-12';
const Dp1  = '2026-07-14';

// snapshot row; `sessionBegin` define a que dia a SESSÃO pertence.
const snap = (team, day, ts, { cc = [], sessionBegin } = {}) => ({
  team_name: team, regional: 'GUA', sector_id: 'DESG',
  captured_at: `${day}T${ts}:00-03:00`,
  data: { sessionBegin: sessionBegin || `${day}T08:00:00`, notasExecutadas: [], notasConcluidas: cc },
});
// nota concluída em `cd` (conclusionDate), tipo LN.
const nota = (id, cd) => ({ id, codigo: id, tipoCode: 'LN', conclusionDate: `${cd}T22:40:00` });

const totalFor = (teams, date) =>
  _aggregateTeamDailyTotals(teams).filter(r => r.date === date).reduce((s, r) => s + r.count, 0);

// ── _addDays (helper puro) ────────────────────────────────────────────────────

test('_addDays soma e subtrai dias sem escorregar de fuso', () => {
  assert.equal(_addDays('2026-07-13', 1), '2026-07-14');
  assert.equal(_addDays('2026-07-13', -1), '2026-07-12');
  assert.equal(_addDays('2026-07-31', 1), '2026-08-01', 'vira o mês');
  assert.equal(_addDays('2026-01-01', -1), '2025-12-31', 'vira o ano');
  assert.equal(_addDays('2026-02-28', 1), '2026-03-01', 'fev/2026 não é bissexto');
  assert.equal(_addDays('2026-07-13', 0), '2026-07-13');
});

// ── O CASO CENTRAL: nota de D transmitida só na sessão de D+1 ─────────────────

test('nota concluída em D e carregada em sessão de D+1 é atribuída a D', () => {
  // Equipe relogou na manhã de D+1 ainda carregando a nota que concluiu 22:40 de D.
  const snaps = [snap('ECCSJ80', Dp1, '08:15', { cc: [nota('N1', D)] })];
  const teams = _unionTeamsFromSnapshots(snaps, Dp1, D);   // passe centrado em D+1
  const rows = _aggregateTeamDailyTotals(teams);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, D, '_notaDate joga a nota de volta pro dia da conclusão');
  assert.equal(rows[0].count, 1);
});

test('o passe de D NÃO vê a sessão de D+1 — subconta a produção de D', () => {
  const snaps = [snap('ECCSJ80', Dp1, '08:15', { cc: [nota('N1', D)] })];
  // Régua ERRADA (a que o detectAtDrift usava até 25/07): janela {D-1, D}.
  const teamsD = _unionTeamsFromSnapshots(snaps, D, Dm1);
  assert.equal(teamsD.length, 0, 'sessão de D+1 é filtrada fora da janela de D');
  assert.equal(totalFor(teamsD, D), 0, 'produção de D some pela régua de D');
});

test('passe de D+1 >= passe de D para a produção de D (invariante da régua)', () => {
  // Cenário realista tipo ECCSJ80 (07-13): 2 notas fecharam durante a sessão de D
  // e 11 só apareceram na sessão da manhã de D+1 → gravado 13, régua de D vê 2.
  const naSessaoDeD = Array.from({ length: 2 }, (_, i) => nota(`dia-${i}`, D));
  const naSessaoDeDp1 = Array.from({ length: 11 }, (_, i) => nota(`tarde-${i}`, D));
  const snaps = [
    snap('ECCSJ80', Dp1, '08:15', { cc: naSessaoDeDp1 }),
    snap('ECCSJ80', D,   '17:00', { cc: naSessaoDeD }),
  ];

  const porPasseDeD   = totalFor(_unionTeamsFromSnapshots(snaps, D,   Dm1), D);
  const porPasseDeDp1 = totalFor(_unionTeamsFromSnapshots(snaps, Dp1, D),   D);

  assert.equal(porPasseDeD, 2, 'régua de D só enxerga o que fechou dentro da sessão de D');
  assert.equal(porPasseDeDp1, 13, 'régua de D+1 (a que grava) enxerga as 13');
  assert.ok(porPasseDeDp1 >= porPasseDeD,
    'INVARIANTE: a régua do write-path nunca conta MENOS que a régua de D — ' +
    'se inverter, o auto-reparo volta a apagar produção');
});

// ── dedup preservado na janela de D+1 (não pode inflar) ───────────────────────

test('mesma nota em sessão de D e de D+1 conta 1x (dedup por UUID)', () => {
  // A WPA carrega concluídas acumuladas: a mesma OS aparece nas duas sessões.
  // Sem dedup a janela mais larga inflaria — o que tornaria o fix um over-count.
  const snaps = [
    snap('ECMFL50', Dp1, '08:15', { cc: [nota('MESMA', D)] }),
    snap('ECMFL50', D,   '17:00', { cc: [nota('MESMA', D)] }),
  ];
  const teams = _unionTeamsFromSnapshots(snaps, Dp1, D);
  assert.equal(totalFor(teams, D), 1, 'contada uma única vez, não duas');
});

test('nota concluída em D+1 na sessão de D+1 NÃO vaza pra D', () => {
  const snaps = [snap('ECGPR53', Dp1, '10:00', { cc: [nota('HOJE', Dp1)] })];
  const teams = _unionTeamsFromSnapshots(snaps, Dp1, D);
  assert.equal(totalFor(teams, D), 0, 'produção de D+1 fica em D+1');
  assert.equal(totalFor(teams, Dp1), 1);
});
