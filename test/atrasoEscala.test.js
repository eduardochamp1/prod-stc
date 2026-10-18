/**
 * test/atrasoEscala.test.js
 *
 * Tabela "Equipes atrasadas pela escala" da aba Gráficos (18/10/2026).
 * Regras do José: qualquer atraso ≥ 1 min conta; escalada que não logou
 * aparece como "não logou". Ver db/atrasoQueries.js.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { turnoDoDia, avaliarAtraso, agoraParede } = require('../db/atrasoQueries');
const { msParede } = require('../db/heQueries');

const T08 = { codigo: 'T08', inicio_escala: '08:00:00', fim_escala: '17:00:00' };
const turno08 = turnoDoDia('2026-10-18', [T08]);
const NOITE = msParede('2026-10-18T23:00:00');

describe('turnoDoDia', () => {
  test('um código', () => {
    assert.equal(turno08.codigo, 'T08');
    assert.equal(turno08.inicioMs, msParede('2026-10-18T08:00:00'));
    assert.equal(turno08.fimMs, msParede('2026-10-18T17:00:00'));
  });
  test('dois colaboradores com códigos diferentes → o que começa primeiro', () => {
    const t = turnoDoDia('2026-10-18', [T08, { codigo: 'T06', inicio_escala: '06:00', fim_escala: '15:00' }]);
    assert.equal(t.codigo, 'T06');
  });
  test('turno que vira a noite: fim no dia seguinte', () => {
    const t = turnoDoDia('2026-10-18', [{ codigo: 'C17', inicio_escala: '17:00', fim_escala: '02:00' }]);
    assert.equal(t.fimMs, msParede('2026-10-19T02:00:00'));
  });
  test('sem horário (DR, FOL) → null', () => {
    assert.equal(turnoDoDia('2026-10-18', [{ codigo: 'DR', inicio_escala: null, fim_escala: null }]), null);
  });
});

describe('avaliarAtraso', () => {
  test('login no horário → não entra', () => {
    assert.equal(avaliarAtraso(turno08, [{ begin: '2026-10-18T08:00:00' }], NOITE), null);
  });
  test('login antes do início → não entra', () => {
    assert.equal(avaliarAtraso(turno08, [{ begin: '2026-10-18T07:50:00' }], NOITE), null);
  });
  test('08:00:59 é 0 min e não entra; 08:01:00 entra com 1 min', () => {
    assert.equal(avaliarAtraso(turno08, [{ begin: '2026-10-18T08:00:59' }], NOITE), null);
    const r = avaliarAtraso(turno08, [{ begin: '2026-10-18T08:01:00' }], NOITE);
    assert.equal(r.status, 'atrasada');
    assert.equal(r.atrasoMin, 1);
  });
  test('atraso de 1h07: segundos não arredondam pra cima', () => {
    const r = avaliarAtraso(turno08, [{ begin: '2026-10-18T09:07:30' }], NOITE);
    assert.equal(r.atrasoMin, 67);
    assert.equal(r.loginMs, msParede('2026-10-18T09:07:30'));
  });
  test('relogin: vale o PRIMEIRO login', () => {
    const r = avaliarAtraso(turno08, [
      { begin: '2026-10-18T10:00:00' }, { begin: '2026-10-18T08:20:00', end: '2026-10-18T09:00:00' },
    ], NOITE);
    assert.equal(r.atrasoMin, 20);
  });
  test('sem sessão no turno → não logou', () => {
    assert.deepEqual(avaliarAtraso(turno08, [], NOITE), { status: 'nao-logou', loginMs: null, atrasoMin: null });
  });
  test('sessão do turno de ONTEM, já encerrada, não conta como login de hoje', () => {
    const r = avaliarAtraso(turno08, [{ begin: '2026-10-17T08:00:00', end: '2026-10-17T17:00:00' }], NOITE);
    assert.equal(r.status, 'nao-logou');
  });
  test('sessão de ontem que emendou e cobria o início → não é atraso', () => {
    assert.equal(avaliarAtraso(turno08, [{ begin: '2026-10-17T22:00:00', end: null }], NOITE), null);
    assert.equal(avaliarAtraso(turno08, [{ begin: '2026-10-17T22:00:00', end: '2026-10-18T09:00:00' }], NOITE), null);
  });
  test('login depois do FIM do turno não é o login deste turno', () => {
    const r = avaliarAtraso(turno08, [{ begin: '2026-10-18T18:00:00' }], NOITE);
    assert.equal(r.status, 'nao-logou');
  });
  test('turno que ainda não começou não é avaliado', () => {
    assert.equal(avaliarAtraso(turno08, [], msParede('2026-10-18T07:00:00')), null);
  });
  test('hoje: "não logou" só depois de um ciclo de coleta (15 min) do início', () => {
    assert.equal(avaliarAtraso(turno08, [], msParede('2026-10-18T08:14:00')), null);
    assert.equal(avaliarAtraso(turno08, [], msParede('2026-10-18T08:15:00')).status, 'nao-logou');
  });
  test('hoje: login atrasado já em snapshot entra mesmo antes dos 15 min', () => {
    const r = avaliarAtraso(turno08, [{ begin: '2026-10-18T08:05:00' }], msParede('2026-10-18T08:10:00'));
    assert.equal(r.atrasoMin, 5);
  });
  test('turno da noite com login depois da meia-noite', () => {
    const t = turnoDoDia('2026-10-18', [{ codigo: 'C35', inicio_escala: '22:35', fim_escala: '06:00' }]);
    const r = avaliarAtraso(t, [{ begin: '2026-10-19T00:05:00' }], msParede('2026-10-19T08:00:00'));
    assert.equal(r.atrasoMin, 90);
  });
});

describe('agoraParede', () => {
  test('UTC → parede BRT (−3h)', () => {
    assert.equal(agoraParede(new Date('2026-10-18T18:11:00Z')), msParede('2026-10-18T15:11:00'));
    assert.equal(agoraParede(new Date('2026-10-19T02:30:00Z')), msParede('2026-10-18T23:30:00'));
  });
});

describe('rota e tela (fonte)', () => {
  const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'index.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  test('a rota valida a equipe contra a regional do usuário', () => {
    const i = routes.indexOf("router.get('/escala/atrasadas'");
    assert.ok(i > 0);
    assert.match(routes.slice(i, i + 1200), /enforceTeamRegional\(req, res, team\)/);
  });
  test('a aba Gráficos carrega a tabela com os mesmos filtros', () => {
    assert.match(html, /loadAtrasadasGraf\(de, ate, regionalsCsv, tipo, teamQs\)/);
    assert.match(html, /id="graf-atrasadas"/);
  });
});
