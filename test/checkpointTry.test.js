/**
 * test/checkpointTry.test.js
 *
 * `Checkpoints[].Try` já vem no `details/optimized` que nós JÁ baixamos e
 * cacheamos em `note_details` — e o notaProcessor não mapeava.
 *
 * Medição dos outros projetos (21/08/2026): nos CHECKPOINTS o `Try` vai de 1 a
 * 6; em `completeInterruptions` ele vem sempre 0 (2.058 de 2.058 linhas). Ou
 * seja, no checkpoint a tentativa é dado real, e é a mesma tentativa que a
 * análise de deslocamento hoje INFERE por "cada novo event=0 começa uma
 * tentativa" (db/deslocamentosQueries.js). Ter o campo permite conferir a
 * inferência sem gastar rede.
 *
 * Cuidado: `nota.Try` (nível da nota, em `operacional.tentativa`) é outro
 * campo — não confundir.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { processarNota } = require('../services/notaProcessor');

function notaCom(checkpoints) {
  return {
    Id: 'nota-1',
    Number: '104793201',
    Type: 'RL',
    Try: 3,                       // tentativa da NOTA — não é a do checkpoint
    Checkpoints: checkpoints,
  };
}

describe('processarNota — Checkpoints[].Try', () => {
  test('mapeia a tentativa de cada checkpoint', () => {
    const r = processarNota(notaCom([
      { Id: 'cp1', Event: 0, Try: 1, TimeStamp: '2026-08-22T10:00:00' },
      { Id: 'cp2', Event: 1, Try: 1, TimeStamp: '2026-08-22T10:20:00' },
      { Id: 'cp3', Event: 0, Try: 2, TimeStamp: '2026-08-22T14:00:00' },
    ]));
    assert.deepEqual(r.checkpoints.map(c => c.tentativa), [1, 1, 2]);
  });

  test('checkpoint sem Try → null (não inventa 0)', () => {
    // 0 tem significado próprio (é o que completeInterruptions devolve sempre).
    const r = processarNota(notaCom([{ Id: 'cp1', Event: 0, TimeStamp: '2026-08-22T10:00:00' }]));
    assert.equal(r.checkpoints[0].tentativa, null);
  });

  test('Try = 0 é preservado como 0, não virado null', () => {
    const r = processarNota(notaCom([{ Id: 'cp1', Event: 0, Try: 0, TimeStamp: '2026-08-22T10:00:00' }]));
    assert.equal(r.checkpoints[0].tentativa, 0);
  });

  test('a tentativa da NOTA continua separada da do checkpoint', () => {
    const r = processarNota(notaCom([{ Id: 'cp1', Event: 0, Try: 1, TimeStamp: '2026-08-22T10:00:00' }]));
    assert.equal(r.operacional.tentativa, 3, 'nota.Try preservado');
    assert.equal(r.checkpoints[0].tentativa, 1, 'cp.Try é outro');
  });

  test('nota sem checkpoints não quebra', () => {
    const r = processarNota({ Id: 'n', Number: '1', Type: 'RL' });
    assert.deepEqual(r.checkpoints, []);
  });
});
