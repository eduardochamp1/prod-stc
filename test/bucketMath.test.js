/**
 * test/bucketMath.test.js
 * Trava a FONTE ÚNICA da aritmética de carteira (P2-2): prioridade
 * rejeitada > concluída > andamento > atual, canceladas/entradas e a invariante.
 * dataService._buildDiaSummary e dataWriter.upsertTeamDailyCarteira chamam isto —
 * então travar aqui trava os números reportados à EDP nos dois caminhos.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { classifyBuckets } = require('../services/bucketMath');

const S = (...ids) => new Set(ids);
const empty = () => new Set();

// atalho: monta os 5 conjuntos com defaults vazios
function call({ inicial = empty(), atual = empty(), andamento = empty(), concluidas = empty(), rejeitadas = empty() }) {
  return classifyBuckets({ inicial, atual, andamento, concluidas, rejeitadas });
}

describe('classifyBuckets — prioridade rejeitada > concluída > andamento > atual', () => {
  test('nota concluída E rejeitada conta SÓ como rejeitada (não infla produção)', () => {
    const r = call({ inicial: S('A'), concluidas: S('A'), rejeitadas: S('A') });
    assert.equal(r.rejeitadas, 1);
    assert.equal(r.concluidas, 0, 'não pode contar como concluída também');
  });

  test('concluída vence andamento', () => {
    const r = call({ inicial: S('A'), andamento: S('A'), concluidas: S('A') });
    assert.equal(r.concluidas, 1);
    assert.equal(r.andamento, 0);
  });

  test('andamento vence atual', () => {
    const r = call({ inicial: S('A'), atual: S('A'), andamento: S('A') });
    assert.equal(r.andamento, 1);
    assert.equal(r.atual, 0);
  });

  test('caso ECTSJ83: 17 rastreadas, 14 também rejeitadas → 14 rej / 3 conc', () => {
    const rej = Array.from({ length: 14 }, (_, i) => `r${i}`);
    const soConc = ['c1', 'c2', 'c3'];
    const r = call({
      inicial: new Set([...rej, ...soConc]),
      concluidas: new Set([...rej, ...soConc]), // as 14 estão em ambas
      rejeitadas: new Set(rej),
    });
    assert.equal(r.rejeitadas, 14);
    assert.equal(r.concluidas, 3);
  });
});

describe('classifyBuckets — canceladas / entradas / dedup', () => {
  test('cancelada = estava no início e sumiu do último snapshot', () => {
    const r = call({ inicial: S('A', 'B'), atual: S('A') }); // B sumiu
    assert.equal(r.canceladas, 1);
    assert.equal(r.entradas_novas, 0);
  });

  test('entrada nova = apareceu no último mas não estava no início', () => {
    const r = call({ inicial: S('A'), concluidas: S('A', 'B') }); // B entrou
    assert.equal(r.entradas_novas, 1);
    assert.equal(r.canceladas, 0);
  });

  test('mesmo UUID em vários buckets do último snap conta 1x (dedup)', () => {
    const r = call({ inicial: S('A'), atual: S('A'), andamento: S('A'), concluidas: S('A') });
    assert.equal(r.atual + r.andamento + r.concluidas + r.rejeitadas, 1);
  });

  test('conjuntos vazios → tudo zero', () => {
    const r = call({});
    assert.deepEqual(r, {
      inicial: 0, atual: 0, andamento: 0, concluidas: 0, rejeitadas: 0,
      canceladas: 0, entradas_novas: 0,
    });
  });
});

describe('classifyBuckets — invariante de carteira', () => {
  // atual+andamento+concluidas+rejeitadas+canceladas = inicial + entradas_novas
  const cenarios = [
    { nome: 'misto', inicial: S('A', 'B', 'C'), atual: S('A', 'D'), andamento: S('B'), concluidas: S(), rejeitadas: S() },
    { nome: 'tudo concluído', inicial: S('A', 'B'), concluidas: S('A', 'B') },
    { nome: 'com rejeição sobreposta', inicial: S('A', 'B', 'C'), concluidas: S('A', 'B'), rejeitadas: S('B'), atual: S('C') },
    { nome: 'muitas entradas', inicial: S('A'), concluidas: S('A', 'B', 'C', 'D') },
    { nome: 'muitas canceladas', inicial: S('A', 'B', 'C', 'D'), atual: S('A') },
  ];
  for (const c of cenarios) {
    test(`invariante fecha — ${c.nome}`, () => {
      const r = call(c);
      const lhs = r.atual + r.andamento + r.concluidas + r.rejeitadas + r.canceladas;
      const rhs = r.inicial + r.entradas_novas;
      assert.equal(lhs, rhs, `${lhs} !== ${rhs} (${JSON.stringify(r)})`);
    });
  }
});
