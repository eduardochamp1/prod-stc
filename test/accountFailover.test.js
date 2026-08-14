/**
 * test/accountFailover.test.js
 *
 * Failover de conta por setor (13/08/2026): SJC (DSSJ) tem cadeia [sp, sp2]. A
 * backup sp2 SÓ é usada quando a primária sp "para de funcionar" — desativada
 * (kill-switch) ou com breaker aberto (credencial inválida / conta bloqueada).
 * Regra do usuário: a backup nunca deve bloquear "por nossa causa" — garantido
 * pelo breaker (P1-20), que faz no máximo 1 tentativa por janela de cooldown.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const wpa = require('../services/wpaService');

beforeEach(() => { wpa._disabledAccounts.clear(); wpa._breaker.clear(); });

const MSG_INVALIDA = 'WPA login (account=sp): Usuário ou senha inválidos';

// ── cadeia por setor ──────────────────────────────────────────────────────────

test('DSSJ tem cadeia [sp, sp2]; ES tem [es]; setor desconhecido → [es]', () => {
  assert.deepEqual(wpa._accountsForSector('DSSJ'), ['sp', 'sp2']);
  assert.deepEqual(wpa._accountsForSector('DESG'), ['es']);
  assert.deepEqual(wpa._accountsForSector('DESC'), ['es']);
  assert.deepEqual(wpa._accountsForSector(null), ['es']);
  assert.deepEqual(wpa._accountsForSector('ZZZZ'), ['es']);
});

// ── resolução da conta usável ─────────────────────────────────────────────────

test('tudo ok → usa a PRIMÁRIA (sp), backup fica dormente', () => {
  assert.equal(wpa._resolveUsableAccount('DSSJ'), 'sp');
});

test('sp DESATIVADA (kill-switch) → failover pra sp2', () => {
  wpa._disabledAccounts.add('sp');
  assert.equal(wpa._resolveUsableAccount('DSSJ'), 'sp2');
});

test('sp com BREAKER aberto (parou de funcionar) → failover pra sp2', () => {
  wpa._openBreaker('sp', MSG_INVALIDA);   // credencial inválida abre o breaker
  assert.ok(wpa._breakerRemaining('sp') > 0, 'sp em cooldown');
  assert.equal(wpa._resolveUsableAccount('DSSJ'), 'sp2');
});

test('sp volta a funcionar (breaker limpo) → prefere sp de novo', () => {
  wpa._openBreaker('sp', MSG_INVALIDA);
  assert.equal(wpa._resolveUsableAccount('DSSJ'), 'sp2');
  wpa._clearBreaker('sp');                // primária recuperou
  assert.equal(wpa._resolveUsableAccount('DSSJ'), 'sp');
});

test('sp2 desativada mas sp ok → segue na primária', () => {
  wpa._disabledAccounts.add('sp2');
  assert.equal(wpa._resolveUsableAccount('DSSJ'), 'sp');
});

test('ambas fora → devolve a última (sp2); erro propaga sem tentar /signin à toa', () => {
  wpa._disabledAccounts.add('sp');
  wpa._disabledAccounts.add('sp2');
  assert.equal(wpa._resolveUsableAccount('DSSJ'), 'sp2');
});

test('ES nunca faz failover — sempre es', () => {
  wpa._openBreaker('es', 'WPA login (account=es): Usuário ou senha inválidos');
  assert.equal(wpa._resolveUsableAccount('DESG'), 'es', 'sem backup, devolve a única');
});

// ── isSectorDisabled com failover ─────────────────────────────────────────────

test('desativar SÓ a primária NÃO desativa o setor (backup cobre)', () => {
  wpa._disabledAccounts.add('sp');
  assert.equal(wpa.isSectorDisabled('DSSJ'), false, 'sp2 ainda serve SJC');
});

test('setor só é desativado quando TODA a cadeia está desativada', () => {
  wpa._disabledAccounts.add('sp');
  wpa._disabledAccounts.add('sp2');
  assert.equal(wpa.isSectorDisabled('DSSJ'), true);
});

test('sem nada desativado → setor ativo', () => {
  assert.equal(wpa.isSectorDisabled('DSSJ'), false);
});
