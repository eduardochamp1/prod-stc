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
const { _resolveLogon, _linkViraNoite } = require('../services/dataService');

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

// ── _linkViraNoite (P1-14 Fase 2: exibir turno vira-noite como 1) ─────────────

const O_BEGIN = '2026-07-29T20:05:00';   // última sessão de ontem
const O_END   = '2026-07-30T01:08:00';
const H_FIRST = '2026-07-30T01:10:00';   // 1º logon de hoje (2 min depois)

test('_linkViraNoite: reconexão vira-noite (gap 2min) linka, início = o de ontem', () => {
  const r = _linkViraNoite(H_FIRST, O_BEGIN, O_END, 60);
  assert.equal(r.linked, true);
  assert.equal(r.sessionBeginReal, O_BEGIN);
  assert.equal(r.ontemEnd, O_END);
});

test('_linkViraNoite: gap acima do limite não linka', () => {
  const tarde = '2026-07-30T02:30:00'; // 82 min após o end de ontem
  assert.equal(_linkViraNoite(tarde, O_BEGIN, O_END, 60).linked, false);
});

test('_linkViraNoite: ontem sem end (sessão aberta) não linka', () => {
  assert.equal(_linkViraNoite(H_FIRST, O_BEGIN, null, 60).linked, false);
});

test('_linkViraNoite: sem sessão de ontem não linka', () => {
  assert.equal(_linkViraNoite(H_FIRST, null, null, 60).linked, false);
});

test('_linkViraNoite: gap negativo (hoje antes do fim de ontem) não linka', () => {
  assert.equal(_linkViraNoite('2026-07-30T01:00:00', O_BEGIN, O_END, 60).linked, false);
});
