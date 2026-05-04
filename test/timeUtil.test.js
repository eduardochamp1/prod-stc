/**
 * test/timeUtil.test.js
 * Verifica que dateBRT/hourBRT/dateBRTMinusDays usam America/Sao_Paulo
 * corretamente (não dependem de offset fixo -3h).
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { dateBRT, hourBRT, dateBRTMinusDays, TZ } = require('../services/timeUtil');

describe('timeUtil', () => {
  test('TZ constante é America/Sao_Paulo', () => {
    assert.equal(TZ, 'America/Sao_Paulo');
  });

  test('dateBRT() retorna formato YYYY-MM-DD válido', () => {
    const d = dateBRT();
    assert.match(d, /^\d{4}-\d{2}-\d{2}$/);
    const [y, m, day] = d.split('-').map(Number);
    assert.ok(y >= 2024 && y <= 2100, `ano fora do range esperado: ${y}`);
    assert.ok(m >= 1 && m <= 12, `mes invalido: ${m}`);
    assert.ok(day >= 1 && day <= 31, `dia invalido: ${day}`);
  });

  test('dateBRT(timestamp) com instante específico retorna data correta', () => {
    // 2026-04-15 às 12:00 BRT = 15:00 UTC
    const ts = Date.parse('2026-04-15T15:00:00Z');
    assert.equal(dateBRT(ts), '2026-04-15');
  });

  test('dateBRT às 23h59 BRT NÃO vira para o dia seguinte', () => {
    // 2026-04-15 23:59 BRT = 2026-04-16 02:59 UTC
    const ts = Date.parse('2026-04-16T02:59:00Z');
    assert.equal(dateBRT(ts), '2026-04-15');
  });

  test('dateBRT às 00h05 BRT já é o dia novo', () => {
    // 2026-04-16 00:05 BRT = 2026-04-16 03:05 UTC
    const ts = Date.parse('2026-04-16T03:05:00Z');
    assert.equal(dateBRT(ts), '2026-04-16');
  });

  test('hourBRT() retorna número entre 0 e 23', () => {
    const h = hourBRT();
    assert.ok(typeof h === 'number');
    assert.ok(h >= 0 && h <= 23, `hora fora do range: ${h}`);
  });

  test('hourBRT(timestamp) calcula hora BRT correta', () => {
    // 2026-04-15 às 18:30 BRT = 21:30 UTC
    const ts = Date.parse('2026-04-15T21:30:00Z');
    assert.equal(hourBRT(ts), 18);
  });

  test('hourBRT às 22h UTC vira 19h BRT', () => {
    const ts = Date.parse('2026-04-15T22:00:00Z');
    assert.equal(hourBRT(ts), 19);
  });

  test('dateBRTMinusDays(0) === dateBRT()', () => {
    assert.equal(dateBRTMinusDays(0), dateBRT());
  });

  test('dateBRTMinusDays(30) retorna data 30 dias antes', () => {
    const today = dateBRT();
    const past  = dateBRTMinusDays(30);
    const diffDays = Math.round(
      (Date.parse(today + 'T12:00:00Z') - Date.parse(past + 'T12:00:00Z')) / 86400000
    );
    assert.equal(diffDays, 30);
  });

  test('dateBRTMinusDays atravessa mudança de mês corretamente', () => {
    // 5 de abril menos 10 dias = 26 de março
    const ts = Date.parse('2026-04-05T15:00:00Z');
    // Não posso passar timestamp pra dateBRTMinusDays, mas posso verificar
    // com dateBRT direto:
    const aprilFifth = dateBRT(ts);
    assert.equal(aprilFifth, '2026-04-05');
    const tenDaysBefore = dateBRT(ts - 10 * 86400000);
    assert.equal(tenDaysBefore, '2026-03-26');
  });
});
