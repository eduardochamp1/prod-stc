/**
 * test/alertaSessao.test.js
 *
 * Regras do aviso de sessões do Monitor (15/10/2026). O José questionou o 🔴
 * "app offline" em equipe LOGADA: logada é online; não logada e escalada é
 * atrasada. O bloco "ALERTA DE SESSÃO (regras puras)" do index.html é extraído
 * e executado num `vm` — sem DOM, como em test/alertasFront.test.js.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')
  .replace(/\r\n/g, '\n');
const INI = HTML.indexOf('/* ── ALERTA DE SESSÃO (regras puras)');
const FIM = HTML.indexOf('/* ── fim ALERTA DE SESSÃO');
assert.ok(INI > 0 && FIM > INI, 'bloco ALERTA DE SESSÃO não encontrado no index.html');

const ctx = {};
vm.createContext(ctx);
vm.runInContext(HTML.slice(INI, FIM) + `
  this.api = { _parseHoraEDP, minutosSemComunicacao, classificarSessao,
    siglasLogadasHoje, equipesAtrasadas, fmtMinutos };`, ctx);
const A = ctx.api;

// 15/10/2026 10:00 BRT
const AGORA = Date.parse('2026-10-15T10:00:00-03:00');
const HOJE = '2026-10-15';
const logada = (extra = {}) => ({
  sigla: 'EBGPR65', id: 's1', sessionBegin: '2026-10-15T07:05:00-03:00', sessionEnd: null,
  isOnline: false, v2Presente: true, lastUpdate: '2026-10-15T09:00:00', tipo: 'BTZERO', ...extra,
});
const cls = (t, ref = t.sessionBegin) => A.classificarSessao(t, { agoraMs: AGORA, hoje: HOJE, refLogon: ref });

// ── LastUpdate ──────────────────────────────────────────────────────────────

test('LastUpdate sem fuso é BRT; com fuso é respeitado', () => {
  assert.equal(A._parseHoraEDP('2026-10-15T09:30:00', AGORA), AGORA - 30 * 60000);
  assert.equal(A._parseHoraEDP('2026-10-15T12:30:00Z', AGORA), AGORA - 30 * 60000);
  assert.equal(A._parseHoraEDP('2026-10-15 09:30:00', AGORA), AGORA - 30 * 60000);
  assert.equal(A._parseHoraEDP('2026-10-15T09:30:00.123', AGORA), AGORA - 30 * 60000 + 123);
});

test('LastUpdate no futuro (fuso errado) vira sem dado, nunca "sem comunicação há 3h"', () => {
  // Se a EDP mandasse UTC sem sufixo, 12:30 seria lido como 12:30 BRT: futuro.
  assert.equal(A._parseHoraEDP('2026-10-15T12:30:00', AGORA), null);
});

test('LastUpdate vazio, ilegível ou sentinela 0001-01-01 é sem dado', () => {
  for (const v of [null, '', 'lixo', '0001-01-01T00:00:00']) {
    assert.equal(A._parseHoraEDP(v, AGORA), null, String(v));
  }
});

// ── Sem comunicação ─────────────────────────────────────────────────────────

test('logada e online: em campo, não entra no aviso', () => {
  const c = cls(logada({ isOnline: true }));
  assert.equal(c.semComunicacao, false);
  assert.equal(c.entra, false);
});

test('logada com celular calado há 60 min entra como sem comunicação', () => {
  const c = cls(logada());
  assert.equal(c.semComMin, 60);
  assert.equal(c.semComunicacao, true);
  assert.equal(c.entra, true);
});

test('queda curta (< 30 min) não alerta', () => {
  const c = cls(logada({ lastUpdate: '2026-10-15T09:45:00' }));
  assert.equal(c.semComMin, 15);
  assert.equal(c.entra, false);
});

test('equipe que o V2 não trouxe é sem dado, não sem comunicação', () => {
  const c = cls(logada({ v2Presente: false }));
  assert.equal(c.semComMin, null);
  assert.equal(c.semDado, true);
  assert.equal(c.entra, false);
});

test('snapshot antigo sem v2Presente e sem lastUpdate também é sem dado', () => {
  const t = logada({ lastUpdate: null });
  delete t.v2Presente;
  assert.equal(cls(t).entra, false);
});

test('USO MÚTUO nunca entra por falta de comunicação, mas entra por dia anterior', () => {
  assert.equal(cls(logada({ tipo: 'USO MÚTUO' })).entra, false);
  const ant = cls(logada({ tipo: 'USO MUTUO', sessionBegin: '2026-10-14T07:00:00-03:00' }));
  assert.equal(ant.diaAnterior, true);
  assert.equal(ant.entra, true);
});

test('sessão encerrada nunca entra', () => {
  assert.equal(cls(logada({ sessionEnd: '2026-10-15T09:00:00-03:00' })).entra, false);
});

test('sessão aberta desde ontem entra como dia anterior', () => {
  const c = cls(logada({ isOnline: true }), '2026-10-14T07:00:00-03:00');
  assert.equal(c.diaAnterior, true);
  assert.equal(c.entra, true);
});

// ── Atrasadas ───────────────────────────────────────────────────────────────

const det = (sigla, minutosDesdeInicio, inicio = '07:00') =>
  ({ sigla, regional: 'GUA', tipo: 'COMERCIAL', inicio, codigo: 'T07', minutosDesdeInicio });

test('escalada, turno começou há ≥ 15 min e não logou: atrasada', () => {
  const out = A.equipesAtrasadas([det('ECGPR51', 42)], new Set());
  assert.equal(out.length, 1);
  assert.equal(out[0].atrasoMin, 42);
});

test('dentro da tolerância (coleta de 15 min) ainda não é atrasada', () => {
  assert.equal(A.equipesAtrasadas([det('ECGPR51', 10)], new Set()).length, 0);
  assert.equal(A.equipesAtrasadas([det('ECGPR51', 15)], new Set()).length, 1);
});

test('quem logou hoje não é atrasada — inclusive quem já encerrou', () => {
  const teams = [
    { sigla: 'ECGPR51', sessionBegin: '2026-10-15T07:03:00-03:00', sessionEnd: null },
    { sigla: 'ECGPR53', sessionBegin: '2026-10-15T07:00:00-03:00', sessionEnd: '2026-10-15T09:00:00-03:00' },
    { sigla: 'ECGPR54', sessionBegin: '2026-10-14T07:00:00-03:00', sessionEnd: '2026-10-14T16:00:00-03:00' },
    { sigla: 'ECMRT50', deslogada: true, sessionBegin: '2026-10-14T07:00:00-03:00', sessionEnd: null },
  ];
  const logadas = A.siglasLogadasHoje(teams, HOJE);
  assert.deepEqual([...logadas].sort(), ['ECGPR51', 'ECGPR53']);
  const out = A.equipesAtrasadas(
    ['ECGPR51', 'ECGPR53', 'ECGPR54', 'ECMRT50'].map(s => det(s, 60)), logadas);
  assert.deepEqual([...out.map(e => e.sigla)], ['ECGPR54', 'ECMRT50']);
});

test('atrasadas vêm da mais atrasada pra menos; entrada vazia não quebra', () => {
  const out = A.equipesAtrasadas([det('A', 20), det('B', 90), det('C', 45)], new Set());
  assert.deepEqual([...out.map(e => e.sigla)], ['B', 'C', 'A']);
  assert.equal(A.equipesAtrasadas(null, new Set()).length, 0);
});

test('fmtMinutos', () => {
  assert.equal(A.fmtMinutos(45), '45 min');
  assert.equal(A.fmtMinutos(80), '1h20');
  assert.equal(A.fmtMinutos(1500), '1d1h');
});
