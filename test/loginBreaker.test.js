/**
 * test/loginBreaker.test.js  (P1-20)
 *
 * Trava o circuit breaker de login do WPA, criado após o incidente de 13/08/2026:
 * a EDP rotacionou a senha da conta `sp` (17:45 OK → 18:00 "Usuário ou senha
 * inválidos"); o sistema seguiu pedindo token a cada trigger e, em 5 tentativas
 * espalhadas (snapshot + notas + teams), a EDP BLOQUEOU a conta até 03:30 —
 * coleta parada a noite toda.
 *
 * O breaker faz login() parar de tocar no /signin enquanto a conta está em
 * cooldown por credencial inválida/bloqueio, garantindo ~1 tentativa por janela →
 * a conta nunca chega a 5 → nunca trava. Se estes testes quebrarem, um erro de
 * credencial volta a poder travar a conta na EDP.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

// Sem env de DB/token store — o módulo carrega sem efeito colateral.
const wpa = require('../services/wpaService');

const MSG_INVALIDA = 'WPA login (account=sp): Usuário ou senha inválidos';
const MSG_BLOQUEADA = 'WPA login (account=sp): Seu usuário foi bloqueado após 5 tentativas de acesso. Por favor, aguarde até 03:30 h para um novo login ou entre em contato com seu coordenador';
const MSG_AZURE = 'WPA login falhou (403, account=sp) [Azure cold-start]: Web App - Unavailable';
const MSG_REDE = 'request to https://edp-wpa-po.azurewebsites.net/identity/signin failed, reason: ETIMEDOUT';

beforeEach(() => { wpa._breaker.clear(); });

// ── classificação ─────────────────────────────────────────────────────────────

test('classifica "Usuário ou senha inválidos" como invalid_credential', () => {
  assert.equal(wpa._classifyLoginError(MSG_INVALIDA).kind, 'invalid_credential');
});

test('classifica "bloqueado ... aguarde até 03:30" como account_locked', () => {
  assert.equal(wpa._classifyLoginError(MSG_BLOQUEADA).kind, 'account_locked');
});

test('erro transiente (Azure/rede) NÃO é credencial → other', () => {
  assert.equal(wpa._classifyLoginError(MSG_AZURE).kind, 'other');
  assert.equal(wpa._classifyLoginError(MSG_REDE).kind, 'other');
  assert.equal(wpa._classifyLoginError('').kind, 'other');
  assert.equal(wpa._classifyLoginError(null).kind, 'other');
});

// ── parse do "aguarde até HH:MM" (BRT, próxima ocorrência) ────────────────────

test('_computeUnlockUntil: 18:30 BRT + "até 03:30" → 03:32 BRT do dia seguinte', () => {
  const now = Date.UTC(2026, 7, 13, 21, 30);   // 21:30 UTC = 18:30 BRT
  const until = wpa._computeUnlockUntil(MSG_BLOQUEADA, now);
  const brt = new Date(until - 3 * 3600000);   // volta pra parede BRT
  assert.equal(brt.getUTCHours(), 3, 'hora BRT do desbloqueio');
  assert.equal(brt.getUTCMinutes(), 32, '03:30 + 2min de margem');
  assert.ok(until > now, 'no futuro');
  assert.ok(until - now <= 10 * 3600000, 'menos de 10h à frente (mesma madrugada)');
});

test('_computeUnlockUntil: já passou das 03:30 hoje → agenda pra amanhã', () => {
  const now = Date.UTC(2026, 7, 13, 10, 0);    // 07:00 BRT (já passou 03:30)
  const until = wpa._computeUnlockUntil(MSG_BLOQUEADA, now);
  assert.ok(until - now > 20 * 3600000, 'quase um dia à frente (03:32 de amanhã)');
});

test('_computeUnlockUntil: mensagem sem horário → null', () => {
  assert.equal(wpa._computeUnlockUntil(MSG_INVALIDA), null);
});

// ── abrir / consultar / expirar o breaker ────────────────────────────────────

test('credencial inválida abre breaker longo (~12h por padrão)', () => {
  const now = Date.UTC(2026, 7, 13, 21, 0);
  const opened = wpa._openBreaker('sp', MSG_INVALIDA, now);
  assert.equal(opened.kind, 'invalid_credential');
  const left = wpa._breakerRemaining('sp', now);
  assert.ok(left >= 11.9 * 3600000 && left <= 12.1 * 3600000, `~12h, veio ${left / 3600000}h`);
});

test('bloqueio abre breaker até o horário do desbloqueio', () => {
  const now = Date.UTC(2026, 7, 13, 21, 30);   // 18:30 BRT
  wpa._openBreaker('sp', MSG_BLOQUEADA, now);
  const left = wpa._breakerRemaining('sp', now);
  // 18:32 de margem → ~9h até 03:32
  assert.ok(left >= 8.9 * 3600000 && left <= 9.1 * 3600000, `~9h, veio ${left / 3600000}h`);
});

test('erro transiente NÃO abre o breaker', () => {
  assert.equal(wpa._openBreaker('sp', MSG_AZURE, Date.now()), null);
  assert.equal(wpa._breakerRemaining('sp'), 0);
});

test('breaker expira sozinho depois do until (e limpa a entrada)', () => {
  const now = Date.UTC(2026, 7, 13, 21, 0);
  wpa._openBreaker('sp', MSG_BLOQUEADA, now);
  assert.ok(wpa._breakerRemaining('sp', now) > 0, 'aberto agora');
  const depois = now + 24 * 3600000;           // um dia depois, já desbloqueado
  assert.equal(wpa._breakerRemaining('sp', depois), 0, 'fechado após o until');
  assert.equal(wpa._breaker.has('sp'), false, 'entrada expirada foi removida');
});

// ── isolamento por conta ──────────────────────────────────────────────────────

test('breaker é POR CONTA — travar sp não afeta es', () => {
  const now = Date.UTC(2026, 7, 13, 21, 0);
  wpa._openBreaker('sp', MSG_INVALIDA, now);
  assert.ok(wpa._breakerRemaining('sp', now) > 0, 'sp em cooldown');
  assert.equal(wpa._breakerRemaining('es', now), 0, 'es segue livre');
});

test('_clearBreaker fecha na hora (simula login bem-sucedido / restart)', () => {
  wpa._openBreaker('sp', MSG_INVALIDA, Date.now());
  wpa._clearBreaker('sp');
  assert.equal(wpa._breakerRemaining('sp'), 0);
});

// ── login() honra o breaker sem tocar na rede ─────────────────────────────────

test('login() com breaker aberto rejeita SEM chamar /signin', async () => {
  const now = Date.now();
  wpa._openBreaker('sp', MSG_BLOQUEADA, now);   // abre manualmente
  await assert.rejects(
    () => wpa.login({ account: 'sp' }),
    (err) => {
      assert.equal(err.isBreakerOpen, true, 'marcado como breaker aberto');
      assert.equal(err.breakerKind, 'account_locked');
      assert.match(err.message, /cooldown/i);
      return true;
    },
    'deveria rejeitar de imediato, sem rede'
  );
});
