/**
 * test/tokenInvalido.test.js
 *
 * A EDP NÃO sinaliza token vencido só com 401/403: na maioria dos endpoints de
 * dados a resposta é **500** com corpo
 * `{"ExceptionMessage": "Token is invalid! -> Bearer eyJhbG…"}`.
 * (Medido pelo projeto GQO/ES legado; registrado em 22/08/2026.)
 *
 * Isso importa porque o nosso wpaFetch propaga "500 com JSON" sem retry e sem
 * renovar o token, e `_safeNotes` engole a exceção devolvendo bucket vazio —
 * ou seja: token morto virava "equipe sem rejeitadas e sem executadas", gravado
 * no snapshot como se fosse realidade. Mesma classe de falha do timeout curto
 * de 21/08/2026, por outra porta.
 *
 * Se estes testes quebrarem, a perda silenciosa de produção volta.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const wpa = require('../services/wpaService');

const BODY_TOKEN_MORTO = JSON.stringify({
  ExceptionMessage: 'Token is invalid! -> Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc',
});
const HTML_COLD_START = '<html><body>Web App - Unavailable</body></html>';

describe('_isTokenInvalidBody — reconhece o 500 de token morto da EDP', () => {
  test('500 + "Token is invalid!" → token morto', () => {
    assert.equal(wpa._isTokenInvalidBody(500, BODY_TOKEN_MORTO), true);
  });

  test('401 → token morto (o caso que a documentação previa)', () => {
    assert.equal(wpa._isTokenInvalidBody(401, ''), true);
  });

  test('403 + "Token is invalid!" → token morto', () => {
    assert.equal(wpa._isTokenInvalidBody(403, BODY_TOKEN_MORTO), true);
  });

  test('403 com HTML de cold-start do Azure NÃO é token morto', () => {
    // Cold-start é tratado antes, com retry. Confundir os dois faria o sistema
    // relogar a cada hibernação do App Service — queimando a conta compartilhada.
    assert.equal(wpa._isTokenInvalidBody(403, HTML_COLD_START), false);
  });

  test('500 de erro de negócio (sem a assinatura) NÃO é token morto', () => {
    assert.equal(wpa._isTokenInvalidBody(500, JSON.stringify({ Error: 'falha ao consultar' })), false);
  });

  test('500 com corpo vazio NÃO é token morto', () => {
    assert.equal(wpa._isTokenInvalidBody(500, ''), false);
  });

  test('200 nunca é token morto', () => {
    assert.equal(wpa._isTokenInvalidBody(200, BODY_TOKEN_MORTO), false);
  });

  test('404 nunca é token morto', () => {
    assert.equal(wpa._isTokenInvalidBody(404, ''), false);
  });
});

describe('_invalidateToken — descarta o token para forçar login novo', () => {
  test('remove o token em memória da conta', () => {
    wpa._tokens.set('es', { token: 'jwt-velho', expireAt: Date.now() + 40 * 3600_000 });
    wpa._invalidateToken('es');
    assert.equal(wpa._tokens.has('es'), false);
  });

  test('não mexe nas outras contas', () => {
    wpa._tokens.set('es', { token: 'a', expireAt: Date.now() + 1000 });
    wpa._tokens.set('sp', { token: 'b', expireAt: Date.now() + 1000 });
    wpa._invalidateToken('es');
    assert.equal(wpa._tokens.has('sp'), true, 'sp preservada');
    wpa._tokens.delete('sp');
  });

  test('conta sem token não quebra', () => {
    assert.doesNotThrow(() => wpa._invalidateToken('conta-que-nao-existe'));
  });
});
