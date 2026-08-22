/**
 * test/noteByNumber.test.js
 *
 * `GET /api/search/SearchNotesByNumber?noteNumber={N}` resolve o NÚMERO humano
 * da nota (o que a EDP cita quando questiona algo em auditoria) para o UUID que
 * `details/optimized` e `historic` exigem.
 *
 * Hoje `/api/wpa/nota/:noteId` tenta resolver código não-UUID varrendo
 * `teams_current` — e loga `codigo "X" não encontrado` quando a nota não está
 * no dia corrente, que é justamente o caso de auditoria. Este endpoint é o
 * segundo fallback.
 *
 * `Data` aqui é OBJETO, não lista (ao contrário da maioria dos endpoints).
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const wpa = require('../services/wpaService');

describe('_isNoteNumber — o que pode ir na query string', () => {
  test('números de nota reais', () => {
    assert.equal(wpa._isNoteNumber('76167441'), true);
    assert.equal(wpa._isNoteNumber('104793201'), true);
  });

  test('aceita number além de string', () => {
    assert.equal(wpa._isNoteNumber(76167441), true);
  });

  test('recusa vazio, texto e UUID', () => {
    assert.equal(wpa._isNoteNumber(''), false);
    assert.equal(wpa._isNoteNumber(null), false);
    assert.equal(wpa._isNoteNumber('abc'), false);
    assert.equal(wpa._isNoteNumber('7616-7441'), false);
    assert.equal(wpa._isNoteNumber('92a2f98e-8877-433e-8358-173b94c13a54'), false);
  });

  test('recusa tentativa de sair da rota', () => {
    assert.equal(wpa._isNoteNumber('../../identity/signin'), false);
    assert.equal(wpa._isNoteNumber('123&sectorId=DESG'), false);
    assert.equal(wpa._isNoteNumber('123 456'), false);
  });

  test('recusa curto demais e longo demais', () => {
    assert.equal(wpa._isNoteNumber('12'), false);
    assert.equal(wpa._isNoteNumber('1'.repeat(20)), false);
  });
});

describe('_normalizeSearchNote — Data é OBJETO', () => {
  test('extrai id e equipe', () => {
    const r = wpa._normalizeSearchNote({
      Data: { Id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', Number: '76167441', Team: { Name: 'EBGPR62' }, Type: 'RL' },
    });
    assert.equal(r.id, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    assert.equal(r.equipe, 'EBGPR62');
    assert.equal(r.numero, '76167441');
    assert.equal(r.tipo, 'RL');
  });

  test('Team como string', () => {
    const r = wpa._normalizeSearchNote({ Data: { Id: 'x', Team: 'EESER50' } });
    assert.equal(r.equipe, 'EESER50');
  });

  test('sem Team → equipe null, mas id preservado', () => {
    const r = wpa._normalizeSearchNote({ Data: { Id: 'x' } });
    assert.equal(r.id, 'x');
    assert.equal(r.equipe, null);
  });

  test('Data null / ausente / sem Id → null', () => {
    assert.equal(wpa._normalizeSearchNote({ Data: null }), null);
    assert.equal(wpa._normalizeSearchNote({}), null);
    assert.equal(wpa._normalizeSearchNote(null), null);
    assert.equal(wpa._normalizeSearchNote({ Data: { Number: '123' } }), null, 'sem Id não serve');
  });

  test('Data como lista (se a EDP mudar) → pega o primeiro', () => {
    const r = wpa._normalizeSearchNote({ Data: [{ Id: 'primeiro' }, { Id: 'segundo' }] });
    assert.equal(r.id, 'primeiro');
  });
});
