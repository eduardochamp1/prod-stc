/**
 * test/notaProcessorHeuristic.test.js
 * Garante que a heurística (notaProcessor.classificarSubCategoria) produz
 * o mesmo sub_code que o classifierService autoritativo, para o subset de
 * casos onde ela é aplicada (cache miss / fallback).
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { classificarSubCategoria } = require('../services/notaProcessor');

describe('notaProcessor.classificarSubCategoria — heurística alinhada ao classifier', () => {
  // ── SF ──
  test('SF/SRED → L0 (Corte Disjuntor)', () => {
    const r = classificarSubCategoria('SF', 'SRED', null, []);
    assert.equal(r.subcatCode, 'L0');
    assert.equal(r.subCategoria, 'Corte Disjuntor');
  });

  test('SF/SREB → L1 (Corte Borne)', () => {
    const r = classificarSubCategoria('SF', 'SREB', null, []);
    assert.equal(r.subcatCode, 'L1');
    assert.equal(r.subCategoria, 'Corte Borne');
  });

  test('SF/code-desconhecido → OUTROS (alinhado com classifier)', () => {
    const r = classificarSubCategoria('SF', 'CREB', null, []);
    assert.equal(r.subcatCode, 'OUTROS', 'heurística DEVE retornar OUTROS, não o code original');
  });

  // ── MD ──
  test('MD/SPEB sem TL11 nos comentários → OBSOLETO', () => {
    const r = classificarSubCategoria('MD', 'SPEB', 'comentário sem nada relevante', []);
    assert.equal(r.subcatCode, 'OBSOLETO');
    assert.equal(r.subCategoria, 'Subs Obsoleto');
  });

  test('MD/SPEB com TL11 nos comentários → TL11', () => {
    const r = classificarSubCategoria('MD', 'SPEB', 'medidor TL11 a substituir', []);
    assert.equal(r.subcatCode, 'TL11');
    assert.equal(r.subCategoria, 'Subs TL11');
  });

  test('MD/SPEB com tl11 (case-insensitive) → TL11', () => {
    const r = classificarSubCategoria('MD', 'SPEB', 'tl11', []);
    assert.equal(r.subcatCode, 'TL11');
  });

  test('MD/code-desconhecido → OUTROS', () => {
    const r = classificarSubCategoria('MD', 'XXXX', null, []);
    assert.equal(r.subcatCode, 'OUTROS');
  });

  // ── DD ──
  test('DD com Activity C93 IsPrimary → C93 com Amount', () => {
    const r = classificarSubCategoria('DD', null, null, [
      { Activity: { Code: 'C93' }, IsPrimary: true, Amount: 35 },
    ]);
    assert.equal(r.subcatCode, 'C93');
    assert.equal(r.subCategoria, 'Subs Ramal');
    assert.equal(r.quantidade, 35);
  });

  test('DD com Activity BTZ013 IsPrimary → BTZ013 com Amount', () => {
    const r = classificarSubCategoria('DD', null, null, [
      { Activity: { Code: 'BTZ013' }, IsPrimary: true, Amount: 4 },
    ]);
    assert.equal(r.subcatCode, 'BTZ013');
    assert.equal(r.subCategoria, 'Substituição CS');
    assert.equal(r.quantidade, 4);
  });

  test('DD com Activities=[] e GroupDescription "RAMAL DE LIGACAO" → C93 (fallback)', () => {
    const r = classificarSubCategoria('DD', null, null, [], 'RAMAL DE LIGACAO - CAPEX');
    assert.equal(r.subcatCode, 'C93', 'fallback para CAPEX RAMAL deve aplicar');
    assert.equal(r.subCategoria, 'Subs Ramal');
    assert.equal(r.quantidade, null, 'sem Activities, quantidade é null');
  });

  test('DD com Activities=[] e GroupDescription que não é RAMAL → OUTROS', () => {
    const r = classificarSubCategoria('DD', null, null, [], 'OUTRA COISA');
    assert.equal(r.subcatCode, 'OUTROS');
  });

  test('DD com Activities=[] e sem GroupDescription → OUTROS', () => {
    const r = classificarSubCategoria('DD', null, null, []);
    assert.equal(r.subcatCode, 'OUTROS');
  });

  test('DD prioriza Activity IsPrimary=true sobre as não-primárias', () => {
    const r = classificarSubCategoria('DD', null, null, [
      { Activity: { Code: 'BTZ013' }, IsPrimary: false, Amount: 1 },
      { Activity: { Code: 'C93' },    IsPrimary: true,  Amount: 50 },
    ]);
    assert.equal(r.subcatCode, 'C93');
    assert.equal(r.quantidade, 50);
  });

  // ── Outros tipos ──
  test('LN, RL, etc. (tipos sem subcat) retornam OUTROS', () => {
    const r = classificarSubCategoria('LN', 'algumcode', null, []);
    assert.equal(r.subcatCode, 'OUTROS');
  });
});
