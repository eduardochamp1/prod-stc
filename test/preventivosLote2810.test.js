/**
 * Preventivos do lote de 28/08 (P3-15, P3-17, P3-18c), feitos em 13/10/2026 (nome do arquivo = lote de origem, 28/08).
 */
'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

// ── P3-17: memoCache não pode envenenar a chave se fn lançar de forma síncrona ──
test('P3-17: fn que lança síncrono rejeita, mas não envenena a chave', async () => {
  const memo = require('../services/memoCache').create({ ttlMs: 60_000, name: 't' });
  let calls = 0;
  const f = memo.wrap(function (x) {
    calls++;
    if (calls === 1) throw new Error('sincrono');   // NÃO é async: lança direto
    return Promise.resolve('ok-' + x);
  }, (x) => String(x));

  await assert.rejects(() => f('a'), /sincrono/);
  assert.strictEqual(memo.stats().inflight, 0, 'in-flight tem que ser limpo');
  assert.strictEqual(await f('a'), 'ok-a', 'a 2ª chamada recomputa em vez de herdar a rejeição');
});

test('P3-17: concorrentes continuam coalescidos (fn roda 1 vez)', async () => {
  const memo = require('../services/memoCache').create({ ttlMs: 60_000, name: 't2' });
  let calls = 0;
  const f = memo.wrap(async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return 7; }, () => 'k');
  const [a, b, c] = await Promise.all([f(), f(), f()]);
  assert.deepStrictEqual([a, b, c], [7, 7, 7]);
  assert.strictEqual(calls, 1);
});

// ── P3-15: _loginTries é podado ────────────────────────────────────────────────
const rotas = require('../routes/index');
beforeEach(() => rotas._loginTries.clear());

test('P3-15: janelas expiradas são podadas quando o Map passa do limite', () => {
  const now = Date.now();
  const velho = now - rotas._LOGIN_WINDOW_MS - 1000;
  for (let i = 0; i <= rotas._LOGIN_PODA_ACIMA; i++) {
    rotas._loginTries.set('velho' + i, { count: 3, first: velho });
  }
  rotas._loginTries.set('ativo', { count: 2, first: now - 1000 });
  rotas._contarErro('novo', now);
  assert.ok(rotas._loginTries.has('ativo'), 'janela ativa NÃO pode ser podada');
  assert.ok(rotas._loginTries.has('novo'));
  assert.ok(!rotas._loginTries.has('velho0'));
  assert.strictEqual(rotas._loginTries.size, 2);
});

test('P3-15: abaixo do limite nada é podado (caminho quente barato)', () => {
  const now = Date.now();
  rotas._loginTries.set('velho', { count: 3, first: now - rotas._LOGIN_WINDOW_MS - 1000 });
  rotas._contarErro('novo', now);
  assert.ok(rotas._loginTries.has('velho'));
});

// ── P3-18c: LOG_LEVEL case-insensitive ─────────────────────────────────────────
function emiteDebug(logLevel) {
  const code = `const l=require(${JSON.stringify(path.join(__dirname, '..', 'services', 'logger.js'))}).forModule('t');l.debug('evt_debug');`;
  const r = spawnSync(process.execPath, ['-e', code], {
    env: { ...process.env, NODE_ENV: 'production', LOG_LEVEL: logLevel },
    encoding: 'utf8',
  });
  return (r.stdout || '') + (r.stderr || '');
}

test('P3-18c: LOG_LEVEL=DEBUG (maiúsculo) liga o debug', () => {
  assert.match(emiteDebug('DEBUG'), /evt_debug/);
});

test('P3-18c: LOG_LEVEL=debug continua funcionando e o default de prod segue em info', () => {
  assert.match(emiteDebug('debug'), /evt_debug/);
  assert.doesNotMatch(emiteDebug(''), /evt_debug/);
});
