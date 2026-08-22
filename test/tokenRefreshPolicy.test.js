/**
 * test/tokenRefreshPolicy.test.js
 *
 * O cron de token (campo de minutos "a cada 45") dispara às :00 e :45 — 32 vezes
 * por dia — e chamava
 * `forceRefresh()`, que é `/signin` INCONDICIONAL: ignorava o `exp` que nós
 * mesmos decodificamos do JWT no login.
 *
 * Por que isso é risco e não só desperdício (achado de 22/08/2026, comparando
 * com os outros três projetos que consomem a mesma API):
 *   • a conta `es` (clarissa.alves) é COMPARTILHADA com o projeto GQO, que
 *     apura DESG/DESC/DEPT — os mesmos setores nossos (P1-25);
 *   • o nosso próprio código registra que a WPA invalida o token anterior ao
 *     receber um login novo (ver _loginPromises em wpaService.js);
 *   • o projeto ES mediu vida de token de 51 HORAS em 17/08/2026 (o GQO
 *     documenta "~45 min" — as duas medições dele se contradizem, e só nós
 *     decodificamos o `exp` de verdade).
 * Logo: login só quando o token está perto de vencer. O `exp` decide, não o cron.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const wpa = require('../services/wpaService');

const MARGEM = 30 * 60_000;      // 30 min
const AGORA  = Date.UTC(2026, 7, 22, 12, 0);

describe('_needsTokenRefresh — o exp decide, não o relógio do cron', () => {
  test('sem token em cache → precisa logar', () => {
    assert.equal(wpa._needsTokenRefresh(null, AGORA, MARGEM), true);
    assert.equal(wpa._needsTokenRefresh({}, AGORA, MARGEM), true);
    assert.equal(wpa._needsTokenRefresh({ token: '', expireAt: AGORA + 1e9 }, AGORA, MARGEM), true);
  });

  test('token válido por 51h (medição do ES) → NÃO reloga', () => {
    const cached = { token: 'jwt', expireAt: AGORA + 51 * 3600_000 };
    assert.equal(wpa._needsTokenRefresh(cached, AGORA, MARGEM), false);
  });

  test('token válido por 45min → NÃO reloga (fora da margem de 30min)', () => {
    const cached = { token: 'jwt', expireAt: AGORA + 45 * 60_000 };
    assert.equal(wpa._needsTokenRefresh(cached, AGORA, MARGEM), false);
  });

  test('token vence em 10min → reloga (dentro da margem)', () => {
    const cached = { token: 'jwt', expireAt: AGORA + 10 * 60_000 };
    assert.equal(wpa._needsTokenRefresh(cached, AGORA, MARGEM), true);
  });

  test('token já vencido → reloga', () => {
    const cached = { token: 'jwt', expireAt: AGORA - 1 };
    assert.equal(wpa._needsTokenRefresh(cached, AGORA, MARGEM), true);
  });

  test('exatamente na borda da margem → reloga (conservador)', () => {
    const cached = { token: 'jwt', expireAt: AGORA + MARGEM };
    assert.equal(wpa._needsTokenRefresh(cached, AGORA, MARGEM), true);
  });

  test('expireAt ausente ou não-numérico → reloga (não confia em lixo)', () => {
    assert.equal(wpa._needsTokenRefresh({ token: 'jwt' }, AGORA, MARGEM), true);
    assert.equal(wpa._needsTokenRefresh({ token: 'jwt', expireAt: 'amanhã' }, AGORA, MARGEM), true);
  });
});

// ── guarda de regressão do wrapper que o cron chama ──────────────────────────
// Não há env de credencial nos testes, então uma tentativa real de /signin
// estoura "credenciais ausentes". Isso é o que torna o teste útil: com o
// forceRefresh() antigo (login incondicional) o primeiro caso abaixo FALHARIA.
describe('ensureFreshToken — não toca a rede com token válido', () => {
  test('token válido por 40h → refreshed:false, sem /signin', async () => {
    const exp = Date.now() + 40 * 3600_000;
    wpa._tokens.set('es', { token: 'jwt-vivo', expireAt: exp });
    const r = await wpa.ensureFreshToken('es');
    assert.equal(r.refreshed, false);
    assert.equal(r.expireAt, exp);
    assert.equal(wpa._tokens.get('es').token, 'jwt-vivo', 'token intacto');
    wpa._tokens.delete('es');
  });

  test('token vencido → tenta logar de verdade (aqui: erro de credencial ausente)', async () => {
    wpa._tokens.set('es', { token: 'jwt-velho', expireAt: Date.now() - 1 });
    await assert.rejects(() => wpa.ensureFreshToken('es'), /credenciais ausentes|WPA login/);
    wpa._tokens.delete('es');
  });
});
