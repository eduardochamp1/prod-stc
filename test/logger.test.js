/**
 * test/logger.test.js
 * Verifica formato JSON em prod e texto em dev, plus filtragem por nível.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Captura writes ao stdout/stderr
function captureStreams(fn) {
  const out = [];
  const err = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  const origLog    = console.log;
  const origError  = console.error;

  process.stdout.write = (chunk, ...rest) => {
    out.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  process.stderr.write = (chunk, ...rest) => {
    err.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  console.log   = (...args) => out.push(args.join(' ') + '\n');
  console.error = (...args) => err.push(args.join(' ') + '\n');

  try { fn(); }
  finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
    console.log = origLog;
    console.error = origError;
  }
  return { out: out.join(''), err: err.join('') };
}

// Recarrega o logger com env vars específicas
function loadLogger(env = {}) {
  const orig = { ...process.env };
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../services/logger')];
  const logger = require('../services/logger');
  // Restaura env
  for (const k of Object.keys(env)) {
    if (orig[k] === undefined) delete process.env[k];
    else process.env[k] = orig[k];
  }
  return logger;
}

describe('logger — modo produção (JSON)', () => {
  test('emite uma linha JSON válida com campos obrigatórios', () => {
    const logger = loadLogger({ NODE_ENV: 'production', LOG_LEVEL: 'debug' });
    const log = logger.forModule('test');
    const { out } = captureStreams(() => log.info('hello', { x: 1 }));
    const lines = out.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const obj = JSON.parse(lines[0]);
    assert.equal(obj.level, 'info');
    assert.equal(obj.module, 'test');
    assert.equal(obj.event, 'hello');
    assert.equal(obj.x, 1);
    assert.ok(obj.ts && /^\d{4}-/.test(obj.ts));
  });

  test('error vai pra stderr, info pra stdout', () => {
    const logger = loadLogger({ NODE_ENV: 'production', LOG_LEVEL: 'debug' });
    const log = logger.forModule('m');
    const { out, err } = captureStreams(() => {
      log.info('a');
      log.error('b', { code: 500 });
    });
    assert.ok(out.includes('"event":"a"'));
    assert.ok(err.includes('"event":"b"'));
    assert.ok(err.includes('"code":500'));
    assert.ok(!out.includes('"event":"b"'));
  });

  test('respeita LOG_LEVEL filtrando debug em info', () => {
    const logger = loadLogger({ NODE_ENV: 'production', LOG_LEVEL: 'info' });
    const log = logger.forModule('m');
    const { out } = captureStreams(() => {
      log.debug('hidden');
      log.info('shown');
    });
    assert.ok(!out.includes('hidden'));
    assert.ok(out.includes('shown'));
  });

  test('IS_PROD true com NODE_ENV=production', () => {
    const logger = loadLogger({ NODE_ENV: 'production' });
    assert.equal(logger.IS_PROD, true);
  });

  test('IS_PROD true com VERCEL=1', () => {
    const logger = loadLogger({ VERCEL: '1', NODE_ENV: 'development' });
    assert.equal(logger.IS_PROD, true);
  });
});

describe('logger — modo dev (texto)', () => {
  test('formato dev tem timestamp + nível + módulo + evento', () => {
    delete process.env.VERCEL;
    const logger = loadLogger({ NODE_ENV: 'development', LOG_LEVEL: 'debug' });
    const log = logger.forModule('mod');
    const { out } = captureStreams(() => log.info('event_x', { foo: 'bar' }));
    // texto livre (com cores ANSI)
    assert.ok(out.includes('event_x'));
    assert.ok(out.includes('mod'));
    assert.ok(out.includes('foo=bar'));
  });

  test('IS_PROD false em dev', () => {
    delete process.env.VERCEL;
    const logger = loadLogger({ NODE_ENV: 'development' });
    assert.equal(logger.IS_PROD, false);
  });
});

describe('logger — formato dos pares chave=valor', () => {
  test('null vira "null", undefined é omitido, objects viram JSON', () => {
    const logger = loadLogger({ NODE_ENV: 'production', LOG_LEVEL: 'debug' });
    const log = logger.forModule('t');
    const { out } = captureStreams(() => log.info('e', {
      a: null, b: undefined, c: { nested: 1 }, d: 'plain',
    }));
    const obj = JSON.parse(out.trim());
    assert.equal(obj.a, null);
    assert.equal(obj.b, undefined);  // pulou-se no spread
    assert.deepEqual(obj.c, { nested: 1 });
    assert.equal(obj.d, 'plain');
  });
});
