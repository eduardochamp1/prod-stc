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

  test('DD com Activities=[] e sem Code → OUTROS', () => {
    const r = classificarSubCategoria('DD', null, null, []);
    assert.equal(r.subcatCode, 'OUTROS');
  });

  test('DD com Activities=[] e Code arbitrário diferente → OUTROS', () => {
    const r = classificarSubCategoria('DD', 'XYZ999', null, []);
    assert.equal(r.subcatCode, 'OUTROS', 'só C93 e BTZ013 viram subcat — outros codes são OUTROS');
  });

  // GroupDescription regex foi REMOVIDO intencionalmente — texto livre é frágil.
  // Notas DD são classificadas apenas por Activities[] e Code (campos determinísticos).
  test('DD com Activities=[] mas com GroupDescription "RAMAL" → OUTROS (regex removido)', () => {
    const r = classificarSubCategoria('DD', null, null, [], 'SUBSTITUIR RAMAL LIGAÇÃO');
    assert.equal(r.subcatCode, 'OUTROS', 'GroupDescription não é mais usada — só Activities + Code');
  });

  test('DD prioriza Activity IsPrimary=true sobre as não-primárias', () => {
    const r = classificarSubCategoria('DD', null, null, [
      { Activity: { Code: 'BTZ013' }, IsPrimary: false, Amount: 1 },
      { Activity: { Code: 'C93' },    IsPrimary: true,  Amount: 50 },
    ]);
    assert.equal(r.subcatCode, 'C93');
    assert.equal(r.quantidade, 50);
  });

  // ── Fallbacks reforçados (camadas 2 e 3 do classifier DD) ──
  test('DD sem Activity mas com code top-level "C93" → C93', () => {
    const r = classificarSubCategoria('DD', 'C93', null, []);
    assert.equal(r.subcatCode, 'C93');
    assert.equal(r.subCategoria, 'Subs Ramal');
  });

  test('DD sem Activity mas com code top-level "BTZ013" → BTZ013', () => {
    const r = classificarSubCategoria('DD', 'BTZ013', null, []);
    assert.equal(r.subcatCode, 'BTZ013');
    assert.equal(r.subCategoria, 'Substituição CS');
  });

  test('DD com Code C93 prevalece sobre GroupDescription "OUTRO TEXTO"', () => {
    // mesmo com texto enganoso, Code C93 é determinístico
    const r = classificarSubCategoria('DD', 'C93', null, [], 'TEXTO ALEATORIO QUE NAO IMPORTA');
    assert.equal(r.subcatCode, 'C93');
  });

  // ── Fallback de GroupDescription ANCORADA (camada 3) — para notas CAPEX ──
  // Notas CAPEX vêm sem Code e sem Activities. GroupDescription é o único sinal,
  // mas usamos regex ancorada no INÍCIO pra evitar falsos positivos.

  test('DD CAPEX: "RAMAL DE LIGACAO - CAPEX" → C93 (ancora no inicio)', () => {
    const r = classificarSubCategoria('DD', null, null, [], 'RAMAL DE LIGACAO - CAPEX');
    assert.equal(r.subcatCode, 'C93');
    assert.equal(r.subCategoria, 'Subs Ramal');
  });

  test('DD CAPEX: "RAMAL DE LIGAÇÃO - CAPEX" (com acento) → C93', () => {
    // Normalização NFD remove acento na regex
    const r = classificarSubCategoria('DD', null, null, [], 'RAMAL DE LIGAÇÃO - CAPEX');
    assert.equal(r.subcatCode, 'C93');
  });

  test('DD CAPEX: "CAIXA SECCIONADORA - CAPEX" → BTZ013', () => {
    const r = classificarSubCategoria('DD', null, null, [], 'CAIXA SECCIONADORA - CAPEX');
    assert.equal(r.subcatCode, 'BTZ013');
  });

  test('DD OPEX: "PODA DE ARVORES - OPEX" continua OUTROS (regex ancorada nao matcha)', () => {
    const r = classificarSubCategoria('DD', null, null, [], 'PODA DE ARVORES - OPEX');
    assert.equal(r.subcatCode, 'OUTROS');
  });

  test('DD: "PODA NA RUA DO RAMAL" continua OUTROS (RAMAL no meio nao conta)', () => {
    // Antes da ancora, regex /RAMAL/ pegaria isso. Agora /^RAMAL DE LIGAC/ nao.
    const r = classificarSubCategoria('DD', null, null, [], 'PODA NA RUA DO RAMAL DE OURO');
    assert.equal(r.subcatCode, 'OUTROS');
  });

  test('DD: "MANUT. CIRC. PRIMARIO - MT - OPEX" continua OUTROS', () => {
    const r = classificarSubCategoria('DD', null, null, [], 'MANUT. CIRC. PRIMARIO - MT - OPEX');
    assert.equal(r.subcatCode, 'OUTROS');
  });

  // ── Outros tipos ──
  test('LN, RL, etc. (tipos sem subcat) retornam OUTROS', () => {
    const r = classificarSubCategoria('LN', 'algumcode', null, []);
    assert.equal(r.subcatCode, 'OUTROS');
  });
});
