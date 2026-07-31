/**
 * test/regraExecutadaRejeitada.test.js  (P1-16)
 *
 * A REGRA, na formulação do José em 31/07/2026 — é esta que manda:
 *
 *   "Uma visita de uma equipe a uma nota não pode contar como executada por si
 *    só; a nota deve ser contada como executada quando for finalizada pela
 *    equipe. Se uma equipe vai a uma nota e essa nota é rejeitada, ela deve
 *    contar somente como rejeitada para essa equipe. Nos casos em que uma nota é
 *    rejeitada por uma equipe (e conta como rejeitada para ela) e essa nota for
 *    reprogramada, quando a equipe (seja ela a mesma ou outra) retornar para
 *    executar a nota e ela finalizar a nota 100%, ela vai contar como executada
 *    somente para a equipe que finalizou ela 100%."
 *
 * Supera a regra de 20/07 (exclusão cega por presença nas duas listas) e
 * detalha a de 30/07 (dois eventos independentes).
 *
 * O FURO QUE ISTO TRAVA: a exclusão era casada por dia da SESSÃO. Como a WPA
 * carrega as concluídas ACUMULADAS, a nota concluída e rejeitada na sexta
 * reaparece nas sessões de sábado e segunda; nesses passes a chave era
 * `2026-07-06|ECTSJ80` contra `2026-07-03|ECTSJ80` da rejeição → não casava, a
 * nota voltava a contar como produção e era lançada em 03/07. Como o wipe cobre
 * só {D-1, D}, o valor inflado sobrescrevia o dia já correto. É a origem medida
 * do P0-7 (tabela acima da régua, 4 dos 5 dias em sexta-feira).
 *
 * Se estes testes quebrarem, produção volta a contar visita que terminou em
 * rejeição — número que vai pra EDP.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  _rejIndexByNote, _contaComoExecutada, _aggregateTeamDailyTotals, _notaDate, _sessionDate,
} = require('../services/dataWriter');

const SEX = '2026-07-03';   // sexta
const SEG = '2026-07-06';   // segunda seguinte

// linha de note_rejections como o pg entrega (DATE → objeto Date).
const rejRow = (note_id, team_name, y, m, d) => ({
  note_id, team_name, session_date: new Date(y, m - 1, d), rejection_date: new Date(y, m - 1, d),
});
const nota = (id, cd, tipo = 'SF') => ({ id, codigo: id, tipoCode: tipo, conclusionDate: `${cd}T14:00:00` });
const equipe = (teamName, sessionDay, { cc = [], rej = [] } = {}) => ({
  teamName, regional: 'SJC', sectorId: 'S1',
  sessionBegin: `${sessionDay}T07:30:00`,
  notasConcluidas: cc, notasRejeitadas: rej,
});
const totalDe = (teams, equipeNome, dia) =>
  _aggregateTeamDailyTotals(teams)
    .filter(r => r.team_name === equipeNome && r.date === dia)
    .reduce((s, r) => s + r.count, 0);

// ── _contaComoExecutada: a regra em forma pura ────────────────────────────────

test('nunca rejeitada → conta como executada', () => {
  assert.equal(_contaComoExecutada(undefined, SEX), true);
  assert.equal(_contaComoExecutada([], SEX), true);
});

test('rejeitada no MESMO dia da conclusão → NÃO conta (a visita terminou em rejeição)', () => {
  // Caso "1172 - Pix no WPA": cliente pagou na hora, corte não executado.
  assert.equal(_contaComoExecutada([SEX], SEX), false);
});

test('rejeitada DEPOIS da conclusão → NÃO conta (a EDP recusou o serviço)', () => {
  assert.equal(_contaComoExecutada(['2026-07-05'], SEX), false);
});

test('rejeitada ANTES e concluída depois → conta (nota reprogramada e refeita)', () => {
  assert.equal(_contaComoExecutada(['2026-07-01'], SEX), true);
});

test('várias rejeições: basta UMA no dia da conclusão ou depois pra não contar', () => {
  assert.equal(_contaComoExecutada(['2026-06-20', '2026-07-01', SEX], SEX), false);
  assert.equal(_contaComoExecutada(['2026-06-20', '2026-07-01'], SEX), true);
});

// ── _rejIndexByNote: chaveia por NOTA+EQUIPE, não por sessão ──────────────────

test('índice agrupa por nota+equipe e normaliza Date do pg', () => {
  const idx = _rejIndexByNote([rejRow('X', 'ECTSJ80', 2026, 7, 3)]);
  assert.deepEqual(idx.get('X|ECTSJ80'), [SEX]);
});

test('mesma nota rejeitada por DUAS equipes fica separada', () => {
  const idx = _rejIndexByNote([
    rejRow('X', 'ECTSJ80', 2026, 7, 3),
    rejRow('X', 'ECTSJ81', 2026, 7, 6),
  ]);
  assert.deepEqual(idx.get('X|ECTSJ80'), [SEX]);
  assert.deepEqual(idx.get('X|ECTSJ81'), [SEG]);
});

test('dedup de dia repetido e linhas inválidas ignoradas', () => {
  const idx = _rejIndexByNote([
    rejRow('X', 'E1', 2026, 7, 3),
    rejRow('X', 'E1', 2026, 7, 3),
    { note_id: null, team_name: 'E1', session_date: new Date(2026, 6, 3) },
    { note_id: 'Y', team_name: null, session_date: new Date(2026, 6, 3) },
    null,
  ]);
  assert.equal(idx.get('X|E1').length, 1);
  assert.equal(idx.size, 1);
});

test('rejection_date tem precedência sobre session_date (RejectedAt é o fato)', () => {
  // O coletor VIU a rejeição no dia 6, mas a WPA diz que ela ocorreu no dia 3.
  const idx = _rejIndexByNote([{
    note_id: 'X', team_name: 'E1',
    session_date: new Date(2026, 6, 6), rejection_date: new Date(2026, 6, 3),
  }]);
  assert.deepEqual(idx.get('X|E1'), [SEX], 'usa o dia do fato, não o da coleta');
});

test('sem rejection_date cai pro session_date', () => {
  const idx = _rejIndexByNote([{
    note_id: 'X', team_name: 'E1', session_date: new Date(2026, 6, 3), rejection_date: null,
  }]);
  assert.deepEqual(idx.get('X|E1'), [SEX]);
});

// ── O CASO QUE VAZAVA: nota da sexta carregada na sessão de segunda ───────────

test('nota rejeitada na sexta NÃO volta a contar no passe de segunda', () => {
  // Cenário reproduzido em 31/07/2026 direto nas funções puras.
  const t = equipe('ECTSJ80', SEG, { cc: [nota('X', SEX)] });   // payload de segunda
  const idx = _rejIndexByNote([rejRow('X', 'ECTSJ80', 2026, 7, 3)]);

  // A nota é lançada na SEXTA (dia da conclusão), não na segunda...
  assert.equal(_notaDate(t.notasConcluidas[0], _sessionDate(t), t.sessionBegin), SEX);
  // ...e a rejeição está registrada na sexta → não é produção.
  assert.equal(_contaComoExecutada(idx.get('X|ECTSJ80'), SEX), false,
    'era aqui que a chave por dia-de-sessão falhava e a nota virava produção');

  // Com a rejeição injetada (o que consolidateDay faz), a agregação zera a sexta.
  t.notasRejeitadas.push({ id: 'X' });
  assert.equal(totalDe([t], 'ECTSJ80', SEX), 0);
});

test('visita em andamento não conta — só notasConcluidas é produção', () => {
  const t = equipe('ECTSJ80', SEX, { cc: [] });
  t.notasExecutadas = [nota('X', SEX)];   // em andamento
  assert.equal(totalDe([t], 'ECTSJ80', SEX), 0, 'ir até a nota não é executar');
});

// ── Item 3 da regra: a execução é de quem FINALIZOU 100% ──────────────────────

test('equipe A rejeita, equipe B finaliza → executada só pra B', () => {
  const a = equipe('ECTSJ80', SEX, { cc: [nota('X', SEX)], rej: [{ id: 'X' }] });
  const b = equipe('ECTSJ81', SEG, { cc: [nota('X', SEG)] });
  const idx = _rejIndexByNote([rejRow('X', 'ECTSJ80', 2026, 7, 3)]);

  assert.equal(totalDe([a, b], 'ECTSJ80', SEX), 0, 'A só tem a rejeição');
  assert.equal(_contaComoExecutada(idx.get('X|ECTSJ81'), SEG), true,
    'B não rejeitou nada — a rejeição da A não contamina a B');
  assert.equal(totalDe([a, b], 'ECTSJ81', SEG), 1, 'a execução é da B');
});

test('mesma equipe rejeita na sexta e refaz na segunda → 1 executada na segunda', () => {
  const t1 = equipe('ECTSJ80', SEX, { cc: [nota('X', SEX)], rej: [{ id: 'X' }] });
  const t2 = equipe('ECTSJ80', SEG, { cc: [nota('X', SEG)] });
  const idx = _rejIndexByNote([rejRow('X', 'ECTSJ80', 2026, 7, 3)]);

  assert.equal(totalDe([t1, t2], 'ECTSJ80', SEX), 0);
  assert.equal(_contaComoExecutada(idx.get('X|ECTSJ80'), SEG), true, 'rejeição foi ANTES');
  assert.equal(totalDe([t1, t2], 'ECTSJ80', SEG), 1);
});
