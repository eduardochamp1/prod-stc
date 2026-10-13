/**
 * P2-45 (13/10/2026): falha do OSRM não era memorizada — os mesmos pares eram
 * re-tentados a cada carga da aba, cada um pagando o throttle (71s de piso no
 * incidente P1-45). O cache negativo distingue NoRoute (estável, TTL longo) de
 * falha de infra (TTL curto, para não congelar par bom depois de um soluço).
 */
'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const osrm = require('../services/osrmService');

beforeEach(() => osrm._negCache.clear());

test('par que falhou por NoRoute fica bloqueado antes do TTL e libera depois', () => {
  const t0 = 1_000_000;
  osrm._negCacheSet('k1', 'noroute', t0);
  assert.strictEqual(osrm._negCacheHas('k1', t0 + 1000), true);
  assert.strictEqual(osrm._negCacheHas('k1', t0 + osrm.NEG_TTL_NOROUTE_MS - 1), true);
  assert.strictEqual(osrm._negCacheHas('k1', t0 + osrm.NEG_TTL_NOROUTE_MS), false);
});

test('falha de infra (HTTP/rede) tem TTL curto — re-tenta depois, não antes', () => {
  const t0 = 2_000_000;
  osrm._negCacheSet('k2', 'infra', t0);
  assert.strictEqual(osrm._negCacheHas('k2', t0 + osrm.NEG_TTL_INFRA_MS - 1), true);
  assert.strictEqual(osrm._negCacheHas('k2', t0 + osrm.NEG_TTL_INFRA_MS), false);
  assert.ok(osrm.NEG_TTL_INFRA_MS < osrm.NEG_TTL_NOROUTE_MS);
});

test('queda total do proxy não deixa resíduo: expira sozinha e some do mapa', () => {
  const t0 = 3_000_000;
  for (let i = 0; i < 100; i++) osrm._negCacheSet('p' + i, 'infra', t0);
  for (let i = 0; i < 100; i++) assert.strictEqual(osrm._negCacheHas('p' + i, t0 + osrm.NEG_TTL_INFRA_MS), false);
  assert.strictEqual(osrm._negCache.size, 0);
});

test('chave desconhecida não está bloqueada', () => {
  assert.strictEqual(osrm._negCacheHas('nunca-falhou'), false);
});
