/**
 * test/notaInterrupcoesDetalhe.test.js  (P1-24)
 *
 * `Interruptions[]` já vem no `details/optimized` que nós JÁ chamamos e cujo
 * payload JÁ gravamos em `note_details` — e o notaProcessor tinha ZERO
 * referências ao campo. O cabeçalho do getNoteDetail documentava Checkpoints,
 * Equipments, Seals, Materials, Activities e não mencionava Interruptions:
 * provavelmente nunca notamos.
 *
 * PREMISSA REVISTA (21/08/2026, registrada no backlog): o item nasceu de
 * "DL/LE/RL ficam sem motivo de rejeição", e a medição de cobertura desmentiu
 * isso (DL 1258/1259, LE 1138/1140, RL 563/564 com RejectedAt). O que sobrou é o
 * argumento de CUSTO: o dado já está pago, e usá-lo pouparia 1 request por nota
 * rejeitada na conta compartilhada.
 *
 * Por isso aqui só EXPOMOS o campo. Trocar a fonte do motivo de rejeição mexe na
 * aba Rejeições, e o item exige medir antes — o passo 1 dele é uma consulta local
 * no note_details já cacheado, custo zero, que este mapeamento habilita.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { processarNota } = require('../services/notaProcessor');

describe('processarNota — Interruptions[] deixa de ser descartado', () => {
  test('mapeia instante, tentativa e texto', () => {
    const r = processarNota({
      Id: 'n1', Number: '104793201', Type: 'DL',
      Interruptions: [
        { Date: '2026-08-21T14:43:00', Try: 0, Notes: 'cliente ausente' },
        { Date: '2026-08-21T16:10:00', Try: 0, Notes: 'aguardando suporte' },
      ],
    });
    assert.equal(r.interrupcoes.length, 2);
    assert.equal(r.interrupcoes[0].instante, '2026-08-21T14:43:00Z');
    assert.equal(r.interrupcoes[0].texto, 'cliente ausente');
    assert.equal(r.interrupcoes[1].texto, 'aguardando suporte');
  });

  test('Try = 0 preservado (é o valor que a EDP manda sempre neste campo)', () => {
    const r = processarNota({ Id: 'n', Interruptions: [{ Date: '2026-08-21T10:00:00', Try: 0 }] });
    assert.equal(r.interrupcoes[0].tentativa, 0);
  });

  test('nota sem Interruptions → [] e nada quebra', () => {
    const r = processarNota({ Id: 'n', Number: '1', Type: 'RL' });
    assert.deepEqual(r.interrupcoes, []);
  });

  test('entrada sem Date é descartada', () => {
    const r = processarNota({ Id: 'n', Interruptions: [{ Notes: 'sem data' }, { Date: '2026-08-21T10:00:00' }] });
    assert.equal(r.interrupcoes.length, 1);
  });
});
