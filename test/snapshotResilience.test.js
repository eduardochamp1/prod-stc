/**
 * test/snapshotResilience.test.js
 *
 * Trava a resiliência por setor do snapshot (13/08/2026): uma conta que falha ou
 * está desativada NÃO pode derrubar a coleta das outras, nem travar o marcador de
 * saúde do ciclo (snapshot_last_ok). Antes, getTeams lançava no 1º setor com erro
 * e um snapshot ATÉ de GUA/CAC era perdido quando só a conta SP estava fora — e o
 * snapshot_last_ok ficava velho pra sempre, cegando o watchdog (P1-1).
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.DATA_MODE = process.env.DATA_MODE || 'wpa';
const wpa = require('../services/wpaService');
const { _classifySnapshotOutcome } = require('../services/cronService');

beforeEach(() => { wpa._disabledAccounts.clear(); });

// ── desfecho do ciclo (puro) ──────────────────────────────────────────────────

test('coletou equipes → ok (mesmo com um setor falho: sucesso parcial)', () => {
  assert.equal(_classifySnapshotOutcome(140, { ok: ['DESG'], failed: [{ sector: 'DSSJ' }], skipped: [] }), 'ok');
  assert.equal(_classifySnapshotOutcome(140, { ok: ['DESG', 'DSSJ'], failed: [], skipped: [] }), 'ok');
});

test('0 equipes e algum setor FALHOU → error (queda real, vira snapshot_error)', () => {
  assert.equal(_classifySnapshotOutcome(0, { ok: [], failed: [{ sector: 'DSSJ', msg: 'x' }], skipped: [] }), 'error');
});

test('0 equipes e nada falhou → empty (dia vazio / só contas desativadas — NÃO é erro)', () => {
  assert.equal(_classifySnapshotOutcome(0, { ok: [], failed: [], skipped: ['DSSJ'] }), 'empty');
  assert.equal(_classifySnapshotOutcome(0, { ok: [], failed: [], skipped: [] }), 'empty');
  assert.equal(_classifySnapshotOutcome(0, {}), 'empty');
});

// ── setor desativado (via conta) ──────────────────────────────────────────────

test('isSectorDisabled reflete a CADEIA do setor (failover)', () => {
  assert.equal(wpa.isSectorDisabled('DSSJ'), false, 'DSSJ = cadeia [sp, sp2], ativa');
  wpa._disabledAccounts.add('sp');
  assert.equal(wpa.isSectorDisabled('DSSJ'), false, 'só a primária fora — backup sp2 cobre');
  wpa._disabledAccounts.add('sp2');
  assert.equal(wpa.isSectorDisabled('DSSJ'), true, 'toda a cadeia desativada');
  assert.equal(wpa.isSectorDisabled('DESG'), false, 'DESG = conta es, não afetado');
  assert.equal(wpa.isSectorDisabled('DESC'), false);
});

// ── getTeams resiliente: um setor desativado não impede os demais ─────────────
// (modo mock: getTeams devolve mock sem tocar em setor real; o report reflete
// apenas o caminho wpa. Aqui garantimos que a função exposta existe e o report
// tem o formato esperado após uma chamada em modo mock.)

test('getLastSectorReport tem o formato {ok,failed,skipped}', () => {
  const ds = require('../services/dataService');
  const r = ds.getLastSectorReport();
  assert.ok(r && Array.isArray(r.ok) && Array.isArray(r.failed) && Array.isArray(r.skipped),
    'report sempre com os 3 arrays');
});
