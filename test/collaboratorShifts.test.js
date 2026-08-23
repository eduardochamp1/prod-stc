/**
 * test/collaboratorShifts.test.js
 *
 * `GET /api/collaboratorshifts/{setor}/{mes}/{ano}` — a escala CADASTRADA do mês,
 * em três níveis: equipe → colaboradores → escalas por dia. É o dado que falta
 * para o P1-26 (hoje "equipe não logou" acusa quem está de folga) e o P2-24
 * (não existe cadastro de escala por dia).
 *
 * Armadilhas que os três outros projetos documentam e que este normalizador
 * absorve: `Collaborators` vem ora LISTA ora DICT ÚNICO (igual teamsstatus/V2), e
 * o mesmo vale para `Scale`. E o ano estava HARDCODED em 2026 no legado deles
 * (`.../{mes}/2026`) — aqui o ano é parâmetro, senão vira bug em 01/01/2027.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const wpa = require('../services/wpaService');

describe('_normalizeCollaboratorShifts — três níveis, achatados em linhas', () => {
  test('caso completo: 1 equipe, 2 colaboradores, 2 dias cada', () => {
    const r = wpa._normalizeCollaboratorShifts({
      Data: [{
        Name: 'EBGPR62',
        Collaborators: [
          { Name: 'JOAO DA SILVA', Code: '111', Scale: [
            { Date: '2026-08-22', ScaleCategoryName: 'T07 07:00' },
            { Date: '2026-08-23', ScaleCategoryName: 'FOL' },
          ]},
          { Name: 'MARIA SOUZA', Code: '222', Scale: [
            { Date: '2026-08-22', ScaleCategoryName: 'T07 07:00' },
            { Date: '2026-08-23', ScaleCategoryName: 'T07 07:00' },
          ]},
        ],
      }],
    }, 'DESG');

    assert.equal(r.length, 4);
    assert.deepEqual(r[0], {
      sectorId: 'DESG', equipe: 'EBGPR62',
      colaboradorCodigo: '111', colaboradorNome: 'JOAO DA SILVA',
      data: '2026-08-22', codigoEscala: 'T07 07:00',
    });
    assert.equal(r[1].codigoEscala, 'FOL');
    assert.equal(r[3].colaboradorCodigo, '222');
  });

  test('Collaborators como DICT ÚNICO em vez de lista', () => {
    const r = wpa._normalizeCollaboratorShifts({
      Data: [{
        Name: 'EESER50',
        Collaborators: { Name: 'SOZINHO', Code: '333', Scale: [{ Date: '2026-08-22', ScaleCategoryName: 'T08 08:00' }] },
      }],
    }, 'DEPT');
    assert.equal(r.length, 1);
    assert.equal(r[0].colaboradorCodigo, '333');
    assert.equal(r[0].equipe, 'EESER50');
  });

  test('Scale como DICT ÚNICO em vez de lista', () => {
    const r = wpa._normalizeCollaboratorShifts({
      Data: [{ Name: 'X', Collaborators: [{ Code: '444', Name: 'N', Scale: { Date: '2026-08-22', ScaleCategoryName: 'DR' } }] }],
    }, 'DESC');
    assert.equal(r.length, 1);
    assert.equal(r[0].codigoEscala, 'DR');
  });

  test('Data como objeto único (uma equipe só)', () => {
    const r = wpa._normalizeCollaboratorShifts({
      Data: { Name: 'UNICA', Collaborators: [{ Code: '5', Name: 'N', Scale: [{ Date: '2026-08-22', ScaleCategoryName: 'T07' }] }] },
    }, 'DESG');
    assert.equal(r.length, 1);
    assert.equal(r[0].equipe, 'UNICA');
  });

  test('Date em ISO com hora → só a data', () => {
    const r = wpa._normalizeCollaboratorShifts({
      Data: [{ Name: 'X', Collaborators: [{ Code: '1', Name: 'N', Scale: [{ Date: '2026-08-22T00:00:00', ScaleCategoryName: 'T07' }] }] }],
    }, 'DESG');
    assert.equal(r[0].data, '2026-08-22');
  });

  test('sentinela 0001-01-01 é descartada, não vira linha', () => {
    const r = wpa._normalizeCollaboratorShifts({
      Data: [{ Name: 'X', Collaborators: [{ Code: '1', Name: 'N', Scale: [
        { Date: '0001-01-01T00:00:00', ScaleCategoryName: 'T07' },
        { Date: '2026-08-22', ScaleCategoryName: 'T07' },
      ] }] }],
    }, 'DESG');
    assert.equal(r.length, 1, 'só a linha com data real');
    assert.equal(r[0].data, '2026-08-22');
  });

  test('linha sem data ou sem código de escala é descartada', () => {
    const r = wpa._normalizeCollaboratorShifts({
      Data: [{ Name: 'X', Collaborators: [{ Code: '1', Name: 'N', Scale: [
        { Date: '2026-08-22' },                        // sem código
        { ScaleCategoryName: 'T07' },                  // sem data
        { Date: '2026-08-24', ScaleCategoryName: 'T07' },
      ] }] }],
    }, 'DESG');
    assert.equal(r.length, 1);
    assert.equal(r[0].data, '2026-08-24');
  });

  test('equipe sem nome é descartada (não dá pra atribuir)', () => {
    const r = wpa._normalizeCollaboratorShifts({
      Data: [{ Collaborators: [{ Code: '1', Name: 'N', Scale: [{ Date: '2026-08-22', ScaleCategoryName: 'T07' }] }] }],
    }, 'DESG');
    assert.deepEqual(r, []);
  });

  test('payload vazio / null → []', () => {
    assert.deepEqual(wpa._normalizeCollaboratorShifts({ Data: [] }, 'DESG'), []);
    assert.deepEqual(wpa._normalizeCollaboratorShifts({ Data: null }, 'DESG'), []);
    assert.deepEqual(wpa._normalizeCollaboratorShifts(null, 'DESG'), []);
  });

  test('colaborador sem Scale não gera linha e não quebra', () => {
    const r = wpa._normalizeCollaboratorShifts({
      Data: [{ Name: 'X', Collaborators: [{ Code: '1', Name: 'N' }] }],
    }, 'DESG');
    assert.deepEqual(r, []);
  });
});
