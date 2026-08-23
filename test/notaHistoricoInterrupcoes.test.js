/**
 * test/notaHistoricoInterrupcoes.test.js
 *
 * Três endpoints da API WPA que os outros projetos da empresa usam e nós não
 * tínhamos (P1-23, P1-33, P2-15). Aqui estão só os NORMALIZADORES — a decisão de
 * usar qualquer um deles como fonte de número está travada por medição, e os
 * próprios itens do backlog exigem isso ("medir a diferença ANTES de mudar
 * qualquer coisa", "mexe em número reportável à EDP → medir, validar no portal,
 * revisar com o José").
 *
 * P1-23  GET /api/Notes/{id}/historic              janela de posse da nota
 * P1-33  GET /api/Notes/{id}/completeInterruptions interrupções + motivo
 * P2-15  GET /api/sessions/{id}/break              intervalos da sessão
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const wpa = require('../services/wpaService');

describe('_normalizeNoteHistoric — janela de posse por equipe (P1-23)', () => {
  test('duas janelas, a última ainda vigente', () => {
    const r = wpa._normalizeNoteHistoric({
      Data: [
        { Team: { Name: 'EBGPR62' }, CreatedAt: '2026-08-20T08:00:00', RemovedAt: '2026-08-20T17:00:00' },
        { Team: { Name: 'ECGPR54' }, CreatedAt: '2026-08-21T08:00:00', RemovedAt: null },
      ],
    });
    assert.equal(r.length, 2);
    assert.equal(r[0].equipe, 'EBGPR62');
    assert.equal(r[0].ate, '2026-08-20T17:00:00Z');
    assert.equal(r[1].ate, null, 'RemovedAt nulo = posse ainda vigente, não data máxima');
  });

  test('Team como string', () => {
    const r = wpa._normalizeNoteHistoric({ Data: [{ Team: 'EESER50', CreatedAt: '2026-08-20T08:00:00' }] });
    assert.equal(r[0].equipe, 'EESER50');
  });

  test('entrada sem equipe é descartada', () => {
    const r = wpa._normalizeNoteHistoric({ Data: [{ CreatedAt: '2026-08-20T08:00:00' }] });
    assert.deepEqual(r, []);
  });

  test('Data objeto único, vazio e null', () => {
    assert.equal(wpa._normalizeNoteHistoric({ Data: { Team: { Name: 'X' }, CreatedAt: '2026-08-20T08:00:00' } }).length, 1);
    assert.deepEqual(wpa._normalizeNoteHistoric({ Data: [] }), []);
    assert.deepEqual(wpa._normalizeNoteHistoric(null), []);
  });

  test('sentinela 0001-01-01 em CreatedAt vira null, não data do ano 1', () => {
    const r = wpa._normalizeNoteHistoric({ Data: [{ Team: { Name: 'X' }, CreatedAt: '0001-01-01T00:00:00' }] });
    assert.equal(r[0].de, null);
  });
});

describe('_normalizeNoteInterruptions — interrupções da execução (P1-33)', () => {
  test('campos completos', () => {
    const r = wpa._normalizeNoteInterruptions({
      Data: [{
        Id: 'int-1', TeamName: 'EBGPR62', Date: '2026-08-21T14:43:00', Try: 0,
        Notes: 'cliente ausente, retornar amanhã',
        Reason: 'SUSPENSO PARA OUTROS SERVIÇOS', RejectionReasonId: '0101|0031',
      }],
    });
    assert.equal(r.length, 1);
    assert.equal(r[0].id, 'int-1');
    assert.equal(r[0].equipe, 'EBGPR62');
    assert.equal(r[0].instante, '2026-08-21T14:43:00Z');
    assert.equal(r[0].motivo, 'SUSPENSO PARA OUTROS SERVIÇOS');
    assert.equal(r[0].motivoId, '0101|0031');
    assert.equal(r[0].texto, 'cliente ausente, retornar amanhã');
  });

  test('Try vem sempre 0 e é preservado como 0 — NÃO serve de chave de tentativa', () => {
    // Medido pelos outros projetos em 21/08/2026: 2.058 de 2.058 linhas com
    // Try=0, enquanto os checkpoints usam 1 a 6. Quem tentar casar interrupção
    // com ciclo de execução por este campo desliga a verificação em silêncio.
    const r = wpa._normalizeNoteInterruptions({ Data: [{ Id: 'i', Date: '2026-08-21T10:00:00', Try: 0 }] });
    assert.equal(r[0].tentativa, 0);
  });

  test('sem Id é descartada (o Id é metade da chave composta que o P0-8 precisa)', () => {
    const r = wpa._normalizeNoteInterruptions({ Data: [{ Date: '2026-08-21T10:00:00' }] });
    assert.deepEqual(r, []);
  });

  test('vazio / null → []', () => {
    assert.deepEqual(wpa._normalizeNoteInterruptions({ Data: [] }), []);
    assert.deepEqual(wpa._normalizeNoteInterruptions(null), []);
  });
});

describe('_normalizeSessionBreaks — intervalos da sessão (P2-15)', () => {
  test('intervalo fechado', () => {
    const r = wpa._normalizeSessionBreaks({
      Data: [{
        SessionBreakReason: { Text: '15 - Horário de Refeição', Responsible: 'SUPERVISOR X' },
        StartTime: '2026-08-22T12:00:00', EndTime: '2026-08-22T13:00:00',
      }],
    });
    assert.equal(r.length, 1);
    assert.equal(r[0].motivo, '15 - Horário de Refeição');
    assert.equal(r[0].responsavel, 'SUPERVISOR X');
    assert.equal(r[0].inicio, '2026-08-22T12:00:00Z');
    assert.equal(r[0].fim, '2026-08-22T13:00:00Z');
  });

  test('EndTime nulo é intervalo EM ABERTO — estado válido, não erro', () => {
    const r = wpa._normalizeSessionBreaks({
      Data: [{ SessionBreakReason: { Text: '46 - Aguardando Callback' }, StartTime: '2026-08-22T15:00:00', EndTime: null }],
    });
    assert.equal(r[0].fim, null);
    assert.equal(r[0].emAberto, true);
  });

  test('intervalo fechado não é marcado como em aberto', () => {
    const r = wpa._normalizeSessionBreaks({
      Data: [{ SessionBreakReason: { Text: 'x' }, StartTime: '2026-08-22T12:00:00', EndTime: '2026-08-22T13:00:00' }],
    });
    assert.equal(r[0].emAberto, false);
  });

  test('sem StartTime é descartado (não dá pra posicionar no tempo)', () => {
    const r = wpa._normalizeSessionBreaks({ Data: [{ SessionBreakReason: { Text: 'x' } }] });
    assert.deepEqual(r, []);
  });

  test('sessão sem parada devolve [] — resposta normal da API, não falha', () => {
    assert.deepEqual(wpa._normalizeSessionBreaks({ Data: [] }), []);
    assert.deepEqual(wpa._normalizeSessionBreaks(null), []);
  });
});
