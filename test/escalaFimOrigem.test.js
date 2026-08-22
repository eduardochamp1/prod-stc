/**
 * test/escalaFimOrigem.test.js
 *
 * Por que este arquivo existe (22/08/2026): depois de subir o P2-33 — fim do
 * turno vindo de `scaletypes/matches` em vez de inferido como início+9h — não
 * havia como saber, olhando o log de produção, se o fim tinha vindo do catálogo
 * ou do fallback. O `runSyncEscalas` só loga quando o valor MUDA, e os 5 turnos
 * que as nossas equipes usam (T06/T07/T08/E07/E08) coincidem com início+9h.
 * Resultado: silêncio total no log — e eu interpretei esse silêncio como
 * casamento quebrado entre o `ShiftType` ("T07 07:00") e o `codigo` ("T07"),
 * quando na verdade estava funcionando. Levou três rodadas de query em produção
 * pra descobrir isso.
 *
 * `_escalaFimComOrigem` devolve a PROCEDÊNCIA junto do valor, pra que a pergunta
 * "o catálogo está sendo usado?" se responda pelo log, não por arqueologia.
 *
 * Medição que dá contexto aos casos abaixo: dos 164 turnos com fim no catálogo,
 * 64 (39%) NÃO são início+9h — mas nenhum deles está em uso hoje.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const wpa = require('../services/wpaService');

// Espelha o catálogo real (medido em produção 22/08/2026).
const CATALOGO = [
  { codigo: 'T07', inicio: '07:00', fim: '16:00' },   // coincide com +9h
  { codigo: 'C70', inicio: '07:00', fim: '16:48' },   // desmente o +9h
  { codigo: 'E71', inicio: '07:00', fim: '11:00' },   // desmente forte
  { codigo: 'X99', inicio: '07:00', fim: null    },   // catalogado sem fim
];

describe('_escalaFimComOrigem — devolve o valor E a procedência', () => {
  test('turno no catálogo cujo fim DESMENTE o palpite → origem catalogo, e o palpite fica visível', () => {
    const r = wpa._escalaFimComOrigem('C70 07:00', CATALOGO);
    assert.equal(r.origem, 'catalogo');
    assert.equal(r.fim, '16:48');
    assert.equal(r.inferido, '16:00', 'o +9h continua exposto pra dar pra comparar');
  });

  test('turno no catálogo que COINCIDE com o palpite → origem catalogo, fim igual ao inferido', () => {
    // É o caso de 100% das equipes hoje. O caller usa fim===inferido pra NÃO
    // poluir o log com divergência que não existe.
    const r = wpa._escalaFimComOrigem('T07 07:00', CATALOGO);
    assert.equal(r.origem, 'catalogo');
    assert.equal(r.fim, '16:00');
    assert.equal(r.fim, r.inferido);
  });

  test('turno FORA do catálogo → origem inferido, cai no +9h', () => {
    const r = wpa._escalaFimComOrigem('Z88 08:00', CATALOGO);
    assert.equal(r.origem, 'inferido');
    assert.equal(r.fim, '17:00');
    assert.equal(r.inferido, '17:00');
  });

  test('turno catalogado SEM fim → origem inferido (entrada existe, mas não serve)', () => {
    const r = wpa._escalaFimComOrigem('X99 07:00', CATALOGO);
    assert.equal(r.origem, 'inferido');
    assert.equal(r.fim, '16:00');
  });

  test('catálogo vazio ou ausente → origem inferido', () => {
    assert.equal(wpa._escalaFimComOrigem('T07 07:00', []).origem, 'inferido');
    assert.equal(wpa._escalaFimComOrigem('T07 07:00', null).origem, 'inferido');
    assert.equal(wpa._escalaFimComOrigem('T07 07:00', []).fim, '16:00');
  });

  test('sem ShiftType → origem sem-turno, e nada é inventado', () => {
    for (const v of [null, undefined, '']) {
      const r = wpa._escalaFimComOrigem(v, CATALOGO);
      assert.equal(r.origem, 'sem-turno', `valor ${JSON.stringify(v)}`);
      assert.equal(r.fim, null);
      assert.equal(r.inferido, null);
    }
  });

  test('ShiftType sem horário parseável e fora do catálogo → fim null, origem inferido', () => {
    const r = wpa._escalaFimComOrigem('TURNO_ESTRANHO', CATALOGO);
    assert.equal(r.origem, 'inferido');
    assert.equal(r.fim, null, 'não inventa horário');
  });

  test('ShiftType sem horário mas COM entrada no catálogo → o catálogo salva', () => {
    const r = wpa._escalaFimComOrigem('C70', CATALOGO);
    assert.equal(r.origem, 'catalogo');
    assert.equal(r.fim, '16:48');
    assert.equal(r.inferido, null, 'sem horário no ShiftType não há palpite a fazer');
  });
});
