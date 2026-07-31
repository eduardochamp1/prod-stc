/**
 * test/rejIndex.test.js  (P1-15)
 *
 * Trava o bug encontrado em 31/07/2026: o enriquecimento de rejeições no
 * consolidateDay montava a chave do índice com `${r.session_date}` direto, e o
 * driver `pg` devolve DATE como objeto `Date`. A chave saía
 *   "Wed Jul 01 2026 00:00:00 GMT+0000|ECTSJ80"
 * enquanto a busca usava `_sessionDate(team)`, que é string:
 *   "2026-07-01|ECTSJ80"
 * As chaves NUNCA casavam → o enriquecimento era código morto e nenhuma
 * rejeição persistida era reaplicada. Consequência: nota rejeitada cujo payload
 * a WPA já havia limpado voltava a contar como PRODUÇÃO.
 *
 * Medido em L0 / 13 equipes SJC (conclusão em 01→25/07/2026): das 734 notas
 * concluídas-e-rejeitadas, 509 escaparam — painel 1.732 contra 1.223 corretas.
 * Validado no portal da EDP (notas 030009946354 e 030009957459, motivo
 * "1172 - Pix no WPA": cliente pagou, corte não executado → é rejeição).
 *
 * Se estes testes quebrarem, a produção volta a contar nota rejeitada.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { _rejIndexByTeamDate, _ymdDate, _sessionDate } = require('../services/dataWriter');

// Como o pg entrega uma coluna DATE: objeto Date à meia-noite LOCAL.
const pgDate = (y, m, d) => new Date(y, m - 1, d);

test('_ymdDate: Date do pg → YYYY-MM-DD (getters locais, sem escorregar o dia)', () => {
  assert.equal(_ymdDate(pgDate(2026, 7, 1)), '2026-07-01');
  assert.equal(_ymdDate(pgDate(2026, 12, 31)), '2026-12-31');
  assert.equal(_ymdDate(pgDate(2026, 1, 5)), '2026-01-05');
});

test('_ymdDate: string passa direto (recortada em 10)', () => {
  assert.equal(_ymdDate('2026-07-01'), '2026-07-01');
  assert.equal(_ymdDate('2026-07-01T00:00:00Z'), '2026-07-01');
});

test('_ymdDate: nulo → string vazia (não quebra)', () => {
  assert.equal(_ymdDate(null), '');
  assert.equal(_ymdDate(undefined), '');
});

// ── O CERNE: a chave do índice tem de casar com a do lookup ───────────────────

test('chave do índice casa com _sessionDate (regressão do bug)', () => {
  const rejRows = [
    { note_id: 'a', team_name: 'ECTSJ80', session_date: pgDate(2026, 7, 1) },
    { note_id: 'b', team_name: 'ECTSJ80', session_date: pgDate(2026, 7, 1) },
  ];
  const idx = _rejIndexByTeamDate(rejRows);

  // do lado do time, a data vem de _sessionDate(sessionBegin) → string
  const team = { teamName: 'ECTSJ80', sessionBegin: '2026-07-01T08:00:00' };
  const chave = `${_sessionDate(team)}|${team.teamName}`;

  const set = idx.get(chave);
  assert.ok(set, `índice deveria ter a chave "${chave}" — chaves: ${[...idx.keys()]}`);
  assert.deepEqual([...set].sort(), ['a', 'b']);
});

test('a versão ANTIGA (template com Date) não casaria — contraste', () => {
  const r = { note_id: 'a', team_name: 'ECTSJ80', session_date: pgDate(2026, 7, 1) };
  const chaveAntiga = `${r.session_date}|${r.team_name}`;         // bug
  const chaveCerta  = `${_ymdDate(r.session_date)}|${r.team_name}`;
  assert.notEqual(chaveAntiga, chaveCerta);
  assert.ok(!chaveAntiga.startsWith('2026-07-01'), 'a chave antiga não era ISO');
});

test('separa por equipe e por dia', () => {
  const idx = _rejIndexByTeamDate([
    { note_id: 'a', team_name: 'ECTSJ80', session_date: pgDate(2026, 7, 1) },
    { note_id: 'b', team_name: 'ECTSJ81', session_date: pgDate(2026, 7, 1) },
    { note_id: 'c', team_name: 'ECTSJ80', session_date: pgDate(2026, 7, 2) },
  ]);
  assert.deepEqual([...idx.get('2026-07-01|ECTSJ80')], ['a']);
  assert.deepEqual([...idx.get('2026-07-01|ECTSJ81')], ['b']);
  assert.deepEqual([...idx.get('2026-07-02|ECTSJ80')], ['c']);
});

test('dedup de note_id repetido (re-rejeição) e linhas inválidas ignoradas', () => {
  const idx = _rejIndexByTeamDate([
    { note_id: 'a', team_name: 'E1', session_date: pgDate(2026, 7, 1) },
    { note_id: 'a', team_name: 'E1', session_date: pgDate(2026, 7, 1) },
    { note_id: null, team_name: 'E1', session_date: pgDate(2026, 7, 1) },
    null,
  ]);
  assert.equal(idx.get('2026-07-01|E1').size, 1);
});

test('entrada vazia → índice vazio (sem crash)', () => {
  assert.equal(_rejIndexByTeamDate([]).size, 0);
  assert.equal(_rejIndexByTeamDate(null).size, 0);
});
