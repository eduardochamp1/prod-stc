/**
 * test/escalaCatalogo.test.js
 *
 * `GET /api/scaletypes/matches?sectorId={X}` é o catálogo de turnos da EDP:
 * `Code`, `StartTime`, `StartIntervalTime`, `EndIntervalTime`, `EndTime`,
 * `Description`, `WorkDays`, `DaysOff`. Uma chamada por setor, muda quase nunca.
 *
 * Por que importa (achado de 22/08/2026): o comentário em cronService.runSyncEscalas
 * dizia "o WPA não informa o fim do turno" e por isso `_shiftEndFromStart`
 * INFERIA fim = início + 9h — e o cron gravava esse valor inferido em
 * `equipes_oficiais.escala_fim`, tabela de negócio. O WPA informa: é este
 * endpoint. Aqui o inferido passa a ser só fallback.
 *
 * A janela de intervalo (`StartIntervalTime`/`EndIntervalTime`) e
 * `WorkDays`/`DaysOff` ficam disponíveis para o P1-26 (distinguir folga de
 * falta) e o P2-15 (previsto × realizado).
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const wpa = require('../services/wpaService');

describe('_normalizeScaleType — um turno do catálogo', () => {
  test('turno completo', () => {
    const r = wpa._normalizeScaleType({
      Code: 'T07 07:00',
      Description: 'Turno administrativo',
      StartTime: '07:00:00',
      StartIntervalTime: '12:00:00',
      EndIntervalTime: '13:00:00',
      EndTime: '16:00:00',
      WorkDays: 5,
      DaysOff: 2,
    });
    assert.equal(r.codigo, 'T07 07:00');
    assert.equal(r.inicio, '07:00');
    assert.equal(r.intervaloInicio, '12:00');
    assert.equal(r.intervaloFim, '13:00');
    assert.equal(r.fim, '16:00');
    assert.equal(r.descricao, 'Turno administrativo');
    assert.equal(r.diasTrabalho, 5);
    assert.equal(r.diasFolga, 2);
  });

  test('horário em ISO → extrai HH:MM', () => {
    const r = wpa._normalizeScaleType({ Code: 'E22 22:00', StartTime: '2026-08-22T22:00:00', EndTime: '2026-08-23T07:00:00' });
    assert.equal(r.inicio, '22:00');
    assert.equal(r.fim, '07:00');
  });

  test('sentinela 0001-01-01 da EDP vira null, não 00:00', () => {
    // A EDP usa 0001-01-01T00:00:00 como "vazio". Tratar como 00:00 faria o
    // painel dizer que o turno acaba à meia-noite.
    const r = wpa._normalizeScaleType({ Code: 'X', StartTime: '0001-01-01T00:00:00', EndTime: null });
    assert.equal(r.inicio, null);
    assert.equal(r.fim, null);
  });

  test('campos ausentes → null, sem estourar', () => {
    const r = wpa._normalizeScaleType({ Code: 'SO_CODIGO' });
    assert.equal(r.codigo, 'SO_CODIGO');
    assert.equal(r.inicio, null);
    assert.equal(r.fim, null);
    assert.equal(r.diasTrabalho, null);
  });

  test('item nulo → null', () => {
    assert.equal(wpa._normalizeScaleType(null), null);
    assert.equal(wpa._normalizeScaleType({}), null, 'sem Code não serve pra nada');
  });
});

describe('_scaleEndFromCatalog — fim REAL do turno a partir do ShiftType do V2', () => {
  const catalogo = [
    { codigo: 'T07 07:00', inicio: '07:00', fim: '16:00', intervaloInicio: '12:00', intervaloFim: '13:00' },
    { codigo: 'E22', inicio: '22:00', fim: '07:00' },
  ];

  test('ShiftType casa exatamente com o código', () => {
    assert.equal(wpa._scaleEndFromCatalog('T07 07:00', catalogo), '16:00');
  });

  test('ShiftType "E22 22:00" casa com o código curto "E22"', () => {
    // O V2 devolve "E22 22:00"; o catálogo pode trazer só o prefixo.
    assert.equal(wpa._scaleEndFromCatalog('E22 22:00', catalogo), '07:00');
  });

  test('turno fora do catálogo → null (caller cai no inferido +9h)', () => {
    assert.equal(wpa._scaleEndFromCatalog('Z99 03:00', catalogo), null);
  });

  test('catálogo vazio ou ausente → null', () => {
    assert.equal(wpa._scaleEndFromCatalog('T07 07:00', []), null);
    assert.equal(wpa._scaleEndFromCatalog('T07 07:00', null), null);
  });

  test('ShiftType nulo → null', () => {
    assert.equal(wpa._scaleEndFromCatalog(null, catalogo), null);
  });

  test('entrada do catálogo sem fim não é usada como resposta', () => {
    assert.equal(wpa._scaleEndFromCatalog('SEMFIM', [{ codigo: 'SEMFIM', inicio: '06:00', fim: null }]), null);
  });
});
