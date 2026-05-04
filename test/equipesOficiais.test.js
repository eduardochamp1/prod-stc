/**
 * test/equipesOficiais.test.js
 * Garante que a whitelist permanece consistente:
 *   - sem duplicatas (fail-fast no startup)
 *   - lookup case-insensitive
 *   - filterOficiais remove não-listadas
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const oficiais = require('../services/equipesOficiais');

describe('equipesOficiais — whitelist', () => {
  test('carrega sem erros (validação fail-fast passa)', () => {
    assert.ok(oficiais.OFICIAIS_GUA.length > 0);
    assert.ok(oficiais.OFICIAIS_CAC.length > 0);
  });

  test('não há siglas duplicadas entre GUA e CAC', () => {
    const gua = new Set(oficiais.OFICIAIS_GUA.map(e => e.sigla));
    const cac = new Set(oficiais.OFICIAIS_CAC.map(e => e.sigla));
    const dup = [...gua].filter(s => cac.has(s));
    assert.deepEqual(dup, [], `duplicatas entre GUA/CAC: ${dup.join(',')}`);
  });

  test('siglas únicas dentro de cada regional', () => {
    const seen = new Set();
    for (const e of oficiais.OFICIAIS_GUA) {
      assert.ok(!seen.has(e.sigla), `GUA duplicada: ${e.sigla}`);
      seen.add(e.sigla);
    }
    seen.clear();
    for (const e of oficiais.OFICIAIS_CAC) {
      assert.ok(!seen.has(e.sigla), `CAC duplicada: ${e.sigla}`);
      seen.add(e.sigla);
    }
  });

  test('cada equipe tem sigla, tipo e placa', () => {
    for (const list of [oficiais.OFICIAIS_GUA, oficiais.OFICIAIS_CAC]) {
      for (const e of list) {
        assert.ok(e.sigla, `equipe sem sigla: ${JSON.stringify(e)}`);
        assert.ok(e.tipo,  `${e.sigla} sem tipo`);
        assert.ok(e.placa, `${e.sigla} sem placa`);
      }
    }
  });
});

describe('equipesOficiais — isOficial / filterOficiais', () => {
  test('isOficial reconhece sigla cadastrada (case-insensitive + trim)', () => {
    const algumaGua = oficiais.OFICIAIS_GUA[0].sigla;
    assert.equal(oficiais.isOficial(algumaGua), true);
    assert.equal(oficiais.isOficial(algumaGua.toLowerCase()), true);
    assert.equal(oficiais.isOficial(`  ${algumaGua}  `), true);
  });

  test('isOficial retorna false para sigla não cadastrada', () => {
    assert.equal(oficiais.isOficial('XXXX99'), false);
    assert.equal(oficiais.isOficial(''), false);
    assert.equal(oficiais.isOficial(null), false);
    assert.equal(oficiais.isOficial(undefined), false);
  });

  test('isOficial respeita filtro por regional', () => {
    const sigGua = oficiais.OFICIAIS_GUA[0].sigla;
    const sigCac = oficiais.OFICIAIS_CAC[0].sigla;
    assert.equal(oficiais.isOficial(sigGua, 'GUA'), true);
    assert.equal(oficiais.isOficial(sigGua, 'CAC'), false);
    assert.equal(oficiais.isOficial(sigCac, 'CAC'), true);
    assert.equal(oficiais.isOficial(sigCac, 'GUA'), false);
  });

  test('getRegional retorna a regional correta', () => {
    const sigGua = oficiais.OFICIAIS_GUA[0].sigla;
    const sigCac = oficiais.OFICIAIS_CAC[0].sigla;
    assert.equal(oficiais.getRegional(sigGua), 'GUA');
    assert.equal(oficiais.getRegional(sigCac), 'CAC');
    assert.equal(oficiais.getRegional('XXXX99'), null);
  });

  test('filterOficiais remove equipes fora da whitelist', () => {
    const sigGua = oficiais.OFICIAIS_GUA[0].sigla;
    const sigCac = oficiais.OFICIAIS_CAC[0].sigla;
    const arr = [
      { sigla: sigGua, total: 10 },
      { sigla: 'XXXX99', total: 99 },     // fora da whitelist
      { sigla: sigCac, total: 5 },
      { sigla: 'invalido', total: 1 },
    ];
    const filtered = oficiais.filterOficiais(arr, 'sigla');
    assert.equal(filtered.length, 2);
    assert.deepEqual(filtered.map(e => e.sigla).sort(), [sigGua, sigCac].sort());
  });

  test('filterOficiais com regional restringe a essa regional só', () => {
    const sigGua = oficiais.OFICIAIS_GUA[0].sigla;
    const sigCac = oficiais.OFICIAIS_CAC[0].sigla;
    const arr = [{ sigla: sigGua }, { sigla: sigCac }];
    assert.equal(oficiais.filterOficiais(arr, 'sigla', 'GUA').length, 1);
    assert.equal(oficiais.filterOficiais(arr, 'sigla', 'CAC').length, 1);
  });
});
