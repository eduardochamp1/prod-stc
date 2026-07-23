/**
 * test/reclassifyJobStore.test.js
 * Trava a reconciliação de boot do job de reclassificação (P2-10): job que
 * estava 'running' quando o processo caiu vira 'interrupted'; estados terminais
 * passam intactos. reconcileOnBoot testado com load/save injetados (sem banco).
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { reconcileBootState, reconcileOnBoot } = require('../services/reclassifyJobStore');

const NOW = '2026-07-22T23:00:00.000Z';

describe('reconcileBootState (pura)', () => {
  test('null → null', () => {
    assert.equal(reconcileBootState(null, NOW), null);
  });

  test("'running' → 'interrupted' com finished_at e error preenchidos", () => {
    const job = { id: 'r1', status: 'running', processed: 40, total: 100, finished_at: null, error: null };
    const r = reconcileBootState(job, NOW);
    assert.equal(r.status, 'interrupted');
    assert.equal(r.finished_at, NOW);
    assert.match(r.error, /reiniciou/i);
    assert.equal(r.processed, 40, 'preserva o progresso parcial');
    assert.equal(r.total, 100);
  });

  test("'running' preserva finished_at/error já existentes", () => {
    const job = { id: 'r1', status: 'running', finished_at: '2026-07-22T10:00:00Z', error: 'x' };
    const r = reconcileBootState(job, NOW);
    assert.equal(r.status, 'interrupted');
    assert.equal(r.finished_at, '2026-07-22T10:00:00Z');
    assert.equal(r.error, 'x');
  });

  test("'done' passa inalterado", () => {
    const job = { id: 'r1', status: 'done', processed: 100 };
    assert.deepEqual(reconcileBootState(job, NOW), job);
  });

  test("'error' passa inalterado", () => {
    const job = { id: 'r1', status: 'error', error: 'boom' };
    assert.deepEqual(reconcileBootState(job, NOW), job);
  });

  test("'interrupted' é idempotente", () => {
    const job = { id: 'r1', status: 'interrupted' };
    assert.deepEqual(reconcileBootState(job, NOW), job);
  });
});

describe('reconcileOnBoot (load/save injetados)', () => {
  test("job 'running' → salva 'interrupted' e retorna interrupted", async () => {
    const saved = [];
    const r = await reconcileOnBoot({
      load: async () => ({ id: 'r9', status: 'running', processed: 5, total: 9 }),
      save: async (j) => saved.push(j),
      nowIso: NOW,
    });
    assert.equal(r.status, 'interrupted');
    assert.equal(saved.length, 1, 'persistiu 1 vez');
    assert.equal(saved[0].status, 'interrupted');
  });

  test("job 'done' → NÃO regrava, retorna intacto", async () => {
    const saved = [];
    const r = await reconcileOnBoot({
      load: async () => ({ id: 'r9', status: 'done' }),
      save: async (j) => saved.push(j),
      nowIso: NOW,
    });
    assert.equal(r.status, 'done');
    assert.equal(saved.length, 0, 'não deve regravar estado terminal');
  });

  test('sem job persistido (null) → não grava, retorna null', async () => {
    const saved = [];
    const r = await reconcileOnBoot({
      load: async () => null,
      save: async (j) => saved.push(j),
      nowIso: NOW,
    });
    assert.equal(r, null);
    assert.equal(saved.length, 0);
  });
});
