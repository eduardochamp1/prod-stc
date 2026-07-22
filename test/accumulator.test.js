/**
 * test/accumulator.test.js
 *
 * Trava o comportamento do ACUMULADOR DIÁRIO (_acc) do wpaService — o mecanismo
 * que preserva notas entre snapshots pra os indicadores não caírem quando equipe
 * desloga. É código sensível (já teve o incidente ECCSJ82 de dupla contagem).
 *
 * Foco desta suíte: P3-11 — "andamento" ao vivo NÃO pode reter notas
 * transferidas/canceladas pela EDP no meio do dia, mas TEM que continuar
 * preservando concluídas/rejeitadas (produção + rejeições podadas pela API).
 *
 * Fluxo real (services/wpaService.js:1201-1202): a cada ciclo chama
 * _accRecord(teams) e depois _accApply(teams) no MESMO array.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { _accRecord, _accApply, _acc } = require('../services/wpaService');

// ── helpers ───────────────────────────────────────────────────────────────────
const nota = (id, status) => ({
  id, codigo: id, tipoCode: 'LN', tipoNome: 'LN', status, conclusionDate: null,
});
const eq = (teamName, { bx = [], ex = [], cc = [], rj = [], sessionEnd = null } = {}) => ({
  teamName, regional: 'GUA',
  notasBaixadas: bx, notasExecutadas: ex, notasConcluidas: cc, notasRejeitadas: rj,
  sessionEnd,
});
// Simula 1 ciclo do cron: record + apply sobre o MESMO payload; devolve a equipe.
function ciclo(teams, alvo) {
  _accRecord(teams);
  const out = _accApply(teams);
  return out.find(t => t.teamName === alvo);
}
const ids = (arr) => (arr || []).map(n => n.id).sort();

beforeEach(() => { _acc.notes.clear(); _acc.carteiras.clear(); });

// ── P3-11: nota transferida/cancelada sai de "andamento" ──────────────────────

test('P3-11: nota que some do payload (transferida) NÃO fica presa em andamento', () => {
  ciclo([eq('T', { ex: [nota('X', 'executada')] })], 'T');   // ciclo 1: X em andamento
  // ciclo 2: X sumiu de TODOS os buckets; equipe presente com payload íntegro (tem Y baixada)
  const t = ciclo([eq('T', { bx: [nota('Y', 'baixada')] })], 'T');
  assert.deepEqual(ids(t.notasExecutadas), [], 'X transferida não pode reaparecer em andamento');
});

test('P3-11: andamento reflete o AO VIVO — só as executadas do payload atual', () => {
  ciclo([eq('T', { ex: [nota('X', 'executada'), nota('W', 'executada')] })], 'T');
  // ciclo 2: só W continua em andamento; X saiu
  const t = ciclo([eq('T', { ex: [nota('W', 'executada')] })], 'T');
  assert.deepEqual(ids(t.notasExecutadas), ['W']);
});

// ── Guarda de FALHA DE COLETA — payload vazio ≠ nota transferida ──────────────

test('P3-11: payload VAZIO (provável falha de coleta) preserva andamento acumulado', () => {
  ciclo([eq('T', { ex: [nota('X', 'executada')] })], 'T');
  // ciclo 2: equipe presente mas TODOS os buckets vazios (sessão aberta) = suspeita de erro
  const t = ciclo([eq('T', {})], 'T');
  assert.deepEqual(ids(t.notasExecutadas), ['X'], 'não zera andamento por payload vazio transitório');
});

// ── Produção PERSISTE (o comportamento load-bearing que não pode regredir) ────

test('upgrade executada→concluída: nota concluída persiste mesmo se a fonte podar', () => {
  ciclo([eq('T', { ex: [nota('X', 'executada')] })], 'T');   // X andamento
  ciclo([eq('T', { cc: [nota('X', 'concluida')] })], 'T');   // X concluída (upgrade no _acc)
  // ciclo 3: fonte poda X das concluídas ao vivo; equipe segue com outra concluída Z
  const t = ciclo([eq('T', { cc: [nota('Z', 'concluida')] })], 'T');
  assert.deepEqual(ids(t.notasConcluidas), ['X', 'Z'], 'X permanece concluída (não vira andamento nem some)');
  assert.deepEqual(ids(t.notasExecutadas), [], 'X não volta pra andamento após concluir');
});

test('rejeitada podada pela API é preservada no card ao vivo (via acumulador)', () => {
  ciclo([eq('T', { rj: [nota('X', 'rejeitada')] })], 'T');   // X rejeitada
  // ciclo 2: endpoint rejected podou X; equipe segue presente e íntegra (tem Z concluída)
  const t = ciclo([eq('T', { cc: [nota('Z', 'concluida')] })], 'T');
  assert.deepEqual(ids(t.notasRejeitadas), ['X'], 'rejeição preservada apesar da poda');
});

test('relogin: mesma concluída em 2 ciclos conta 1x (sem dupla contagem, espírito ECCSJ82)', () => {
  ciclo([eq('T', { cc: [nota('A', 'concluida'), nota('B', 'concluida')] })], 'T');
  const t = ciclo([eq('T', { cc: [nota('A', 'concluida'), nota('B', 'concluida')] })], 'T');
  assert.deepEqual(ids(t.notasConcluidas), ['A', 'B']);
});

test('equipe deslogada (sessão encerrada) com payload íntegro não retém andamento', () => {
  ciclo([eq('T', { ex: [nota('X', 'executada')] })], 'T');
  // encerra a sessão; concluiu X (X vai pra concluídas), nada em andamento
  const t = ciclo([eq('T', { cc: [nota('X', 'concluida')], sessionEnd: '2026-07-22T18:00:00' })], 'T');
  assert.deepEqual(ids(t.notasExecutadas), [], 'sessão encerrada não mostra andamento');
  assert.deepEqual(ids(t.notasConcluidas), ['X']);
});
