/**
 * test/breakerHidratacao.test.js  (P2-38)
 *
 * Medido em produção em 22/08/2026, no deploy: `scaletypes DSSJ` falhou às
 * 11:21:17 acusando cooldown da conta `sp` e funcionou às 11:21:41, via `sp2`,
 * sem intervenção.
 *
 * Causa: `_resolveUsableAccount` é SÍNCRONA e decide pulando conta com breaker
 * aberto lendo só o Map em memória; `_hydrateBreaker` é ASSÍNCRONA e era
 * aguardada apenas dentro do `login()`. Ou seja: a decisão de LOGAR esperava a
 * hidratação, mas a de ROTEAR já tinha sido tomada com o Map vazio. Num processo
 * recém-subido a cadeia [sp, sp2] devolvia `sp`, a conta quebrada.
 *
 * O breaker segurava na última linha (nenhum login foi gasto), mas a requisição
 * morria — e em `notes/*` isso cai no `_safeNotes`, que devolve bucket vazio EM
 * SILÊNCIO e entra no snapshot como "equipe sem produção".
 *
 * A correção é hidratar dentro do `wpaFetch`, que é o único ponto de saída de
 * toda chamada de dados, ANTES de resolver a conta.
 */

'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const wpa = require('../services/wpaService');

beforeEach(() => {
  wpa._breaker.clear();
  wpa._breakerHydration.done = false;
  wpa._breakerHydration.promise = null;
});

describe('hidratação do breaker acontece antes do roteamento', () => {
  test('estado começa não-hidratado (pré-condição do teste)', () => {
    assert.equal(wpa._breakerHydration.done, false);
  });

  test('wpaFetch hidrata ANTES de resolver a conta', async () => {
    // Sem credencial no ambiente de teste a chamada estoura no getToken — o que
    // importa é que a hidratação já aconteceu quando isso ocorre.
    await wpa.wpaFetch('/api/qualquer?sectorId=DSSJ').catch(() => {});
    assert.equal(wpa._breakerHydration.done, true, 'wpaFetch deve ter hidratado o breaker');
  });

  test('hidratar é idempotente: segunda chamada não refaz', async () => {
    await wpa.wpaFetch('/api/qualquer?sectorId=DSSJ').catch(() => {});
    const promessa1 = wpa._breakerHydration.promise;
    await wpa.wpaFetch('/api/outra?sectorId=DESG').catch(() => {});
    assert.equal(wpa._breakerHydration.done, true);
    assert.equal(wpa._breakerHydration.promise, promessa1, 'não recriou a promessa');
  });

  test('com breaker já aberto para sp, o roteamento de DSSJ escolhe sp2', () => {
    // Guarda da regressão que o P2-38 descreve: é isso que falhava no boot.
    wpa._openBreaker('sp', 'WPA login (account=sp): Usuário ou senha inválidos');
    assert.equal(wpa._resolveUsableAccount('DSSJ'), 'sp2');
  });
});
