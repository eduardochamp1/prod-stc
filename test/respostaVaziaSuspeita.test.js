/**
 * test/respostaVaziaSuspeita.test.js
 *
 * INCIDENTE 16/10/2026 (backlog P0-10). A EDP respondeu 200 com
 * {"Message":"Nenhum dado encontrado."} em TODOS os setores. Nada "falhava":
 *   - o snapshot logava `snapshot_skipped_empty` (info) a cada 15 min;
 *   - a coleta de notas seguia e o updateDailyAgg gravava 17 e 18/10 com
 *     pendentes 0 e a carteira inteira como "saiu".
 * Estes testes garantem que zero em todos os setores vira FALHA, não verdade.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { _classifySnapshotOutcome } = require('../services/cronService');
const { _coletarSetores } = require('../services/dataService');
const { _coletaNotasSuspeita } = require('../services/notasMonitor');

const SETORES = ['DESG', 'DEPT', 'DESC', 'DSSJ'];
const TODOS_VAZIOS = { ok: SETORES, failed: [], skipped: [], semSessoes: SETORES };

// ── snapshot: desfecho do ciclo ───────────────────────────────────────────────

test('0 sessões em todos os setores, em expediente → suspeito (não "dia vazio")', () => {
  assert.equal(_classifySnapshotOutcome(0, TODOS_VAZIOS, 10), 'suspeito');
  assert.equal(_classifySnapshotOutcome(0, TODOS_VAZIOS, 7), 'suspeito');
  assert.equal(_classifySnapshotOutcome(0, TODOS_VAZIOS, 18), 'suspeito');
});

test('fora do expediente, zero sessões continua "empty"', () => {
  assert.equal(_classifySnapshotOutcome(0, TODOS_VAZIOS, 6), 'empty');
  assert.equal(_classifySnapshotOutcome(0, TODOS_VAZIOS, 19), 'empty');
});

test('basta UM setor com sessões (de qualquer empresa) para não ser suspeito', () => {
  const r = { ok: SETORES, failed: [], skipped: [], semSessoes: ['DESG', 'DEPT', 'DESC'] };
  assert.equal(_classifySnapshotOutcome(0, r, 10), 'empty');
});

test('setor desativado não conta, os ativos vazios bastam', () => {
  const r = { ok: ['DESG', 'DEPT', 'DESC'], failed: [], skipped: ['DSSJ'], semSessoes: ['DESG', 'DEPT', 'DESC'] };
  assert.equal(_classifySnapshotOutcome(0, r, 10), 'suspeito');
});

test('sem setor coletado (só desativados) não é suspeito', () => {
  assert.equal(_classifySnapshotOutcome(0, { ok: [], failed: [], skipped: SETORES, semSessoes: [] }, 10), 'empty');
});

test('equipes coletadas → ok; falha de setor → error (regras antigas intactas)', () => {
  assert.equal(_classifySnapshotOutcome(140, TODOS_VAZIOS, 10), 'ok');
  assert.equal(_classifySnapshotOutcome(0, { ...TODOS_VAZIOS, failed: [{ sector: 'DSSJ' }] }, 10), 'error');
  assert.equal(_classifySnapshotOutcome(0, TODOS_VAZIOS), 'empty', 'sem hora → comportamento antigo');
});

// ── report por setor: quem veio com zero sessões da EDP ───────────────────────

test('_coletarSetores lista em semSessoes o setor que a EDP devolveu com 0 sessões', async () => {
  const comTotal = (n) => Object.defineProperty([], '_sessoesTotaisEdp', { value: n });
  const total = { DESG: 0, DEPT: 12, DESC: 0, DSSJ: 40 };
  const { report } = await _coletarSetores(SETORES, {
    coletar: async (s) => comTotal(total[s]),
    desativado: () => false,
  });
  assert.deepEqual(report.semSessoes, ['DESG', 'DESC']);
});

test('setor sem a marcação (ex.: mock) não entra em semSessoes', async () => {
  const { report } = await _coletarSetores(['DESG'], { coletar: async () => [], desativado: () => false });
  assert.deepEqual(report.semSessoes, []);
});

// ── notas devolvidas ──────────────────────────────────────────────────────────

test('notas: zero em todos os setores consultados → suspeito (não agrega, não limpa)', () => {
  assert.equal(_coletaNotasSuspeita(4, 0), true);
  assert.equal(_coletaNotasSuspeita(3, 0), true);
});

test('notas: com qualquer nota, ou sem setor consultado, segue normal', () => {
  assert.equal(_coletaNotasSuspeita(4, 4610), false);
  assert.equal(_coletaNotasSuspeita(4, 1), false);
  assert.equal(_coletaNotasSuspeita(0, 0), false);
});
