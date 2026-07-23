/**
 * test/backfillConsolidate.test.js
 * Trava o parse de argumentos e a geração de datas do runner oficial de
 * consolidação (P0-0 #4). O `main`/DB não roda (guard require.main no script).
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { rangeDatas, parseArgs, DEFAULT_PAUSE_MS } = require('../scripts/backfill-consolidate');

describe('rangeDatas', () => {
  test('1 dia', () => {
    assert.deepEqual(rangeDatas('2026-07-19', '2026-07-19'), ['2026-07-19']);
  });
  test('vários dias, crescente', () => {
    assert.deepEqual(rangeDatas('2026-07-01', '2026-07-03'),
      ['2026-07-01', '2026-07-02', '2026-07-03']);
  });
  test('atravessa virada de mês', () => {
    assert.deepEqual(rangeDatas('2026-06-29', '2026-07-02'),
      ['2026-06-29', '2026-06-30', '2026-07-01', '2026-07-02']);
  });
});

describe('parseArgs', () => {
  test('sem data → erro', () => {
    const r = parseArgs(['--apply']);
    assert.match(r.error, /ao menos uma data/);
  });

  test('1 data → de=ate, dry-run por padrão, pausa default', () => {
    const r = parseArgs(['2026-07-19']);
    assert.equal(r.error, null);
    assert.equal(r.de, '2026-07-19');
    assert.equal(r.ate, '2026-07-19');
    assert.deepEqual(r.datas, ['2026-07-19']);
    assert.equal(r.apply, false);
    assert.equal(r.force, false);
    assert.equal(r.pauseMs, DEFAULT_PAUSE_MS);
  });

  test('range + --apply', () => {
    const r = parseArgs(['2026-07-01', '2026-07-03', '--apply']);
    assert.equal(r.apply, true);
    assert.equal(r.datas.length, 3);
  });

  test('--force e --pause=2000 respeitados', () => {
    const r = parseArgs(['2026-07-19', '--force', '--pause=2000']);
    assert.equal(r.force, true);
    assert.equal(r.pauseMs, 2000);
  });

  test('--pause inválido → erro', () => {
    assert.match(parseArgs(['2026-07-19', '--pause=abc']).error, /pause inválido/);
    assert.match(parseArgs(['2026-07-19', '--pause=-5']).error, /pause inválido/);
  });

  test('data-fim anterior à início → erro', () => {
    assert.match(parseArgs(['2026-07-19', '2026-07-01']).error, /anterior/);
  });

  test('ordem das flags não importa', () => {
    const r = parseArgs(['--apply', '2026-07-01', '--pause=500', '2026-07-02']);
    assert.equal(r.apply, true);
    assert.equal(r.pauseMs, 500);
    assert.deepEqual(r.datas, ['2026-07-01', '2026-07-02']);
  });
});
