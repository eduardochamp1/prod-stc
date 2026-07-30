/**
 * test/logonRelogin.test.js
 *
 * Trava a regra de relogin/logon-de-referência (_resolveLogon), com a guarda de
 * gap adicionada em 29/07/2026. O default (maxGap=0) DEVE preservar o
 * comportamento anterior: qualquer diferença entre o 1º sessionBegin do dia e o
 * atual = relogin, e o logon de referência é o mais antigo.
 *
 * A guarda só age quando RELOGIN_MAX_GAP_HORAS > 0: aí um gap acima do limite
 * vira "sessão nova" (não conta relogin; logon de ref = a sessão atual).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { _resolveLogon } = require('../services/dataService');

const P = '2026-07-29T07:00:00-03:00';   // primeiro login do dia
const A1 = '2026-07-29T08:00:00-03:00';  // relogin 1h depois
const A9 = '2026-07-29T16:00:00-03:00';  // "relogin" 9h depois

// ── default (sem limite) preserva o comportamento antigo ──────────────────────

test('sem primeiro snapshot → usa o atual, não é relogin', () => {
  assert.deepEqual(_resolveLogon(null, A1, 0), { sessionBeginReal: A1, relogouNoDia: false });
});

test('primeiro == atual → não é relogin, ref = o próprio', () => {
  assert.deepEqual(_resolveLogon(P, P, 0), { sessionBeginReal: P, relogouNoDia: false });
});

test('primeiro != atual, default → relogin e ref = o mais antigo', () => {
  assert.deepEqual(_resolveLogon(P, A1, 0), { sessionBeginReal: P, relogouNoDia: true });
});

test('gap grande, default (0) ainda conta como relogin (preserva hoje)', () => {
  assert.deepEqual(_resolveLogon(P, A9, 0), { sessionBeginReal: P, relogouNoDia: true });
});

// ── com limite ativo (a guarda) ───────────────────────────────────────────────

test('gap DENTRO do limite → relogin, ref = mais antigo', () => {
  // 1h de gap, limite 6h → é reconexão
  assert.deepEqual(_resolveLogon(P, A1, 6), { sessionBeginReal: P, relogouNoDia: true });
});

test('gap ACIMA do limite → sessão nova (não relogin, ref = atual)', () => {
  // 9h de gap, limite 6h → turno separado
  assert.deepEqual(_resolveLogon(P, A9, 6), { sessionBeginReal: A9, relogouNoDia: false });
});

test('gap exatamente no limite conta como relogin (<=)', () => {
  const A6 = '2026-07-29T13:00:00-03:00'; // 6h
  assert.deepEqual(_resolveLogon(P, A6, 6), { sessionBeginReal: P, relogouNoDia: true });
});

test('maxGap negativo é tratado como sem limite', () => {
  assert.deepEqual(_resolveLogon(P, A9, -1), { sessionBeginReal: P, relogouNoDia: true });
});
