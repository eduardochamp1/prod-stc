/**
 * test/coletaSetorRetry.test.js
 *
 * P2-66 (16/10/2026): a Web API da EDP dava timeout/502 num setor em ~1 de cada
 * 6 ciclos de snapshot no horário comercial, e o setor inteiro sumia do ciclo
 * ("em campo" 104 → 70 → 103). O cron agora repete 1x o setor que falhou,
 * depois dos outros. O navegador NÃO repete (não pode esperar mais 45s).
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { _coletarSetores } = require('../services/dataService');

const SETORES = ['DESG', 'DEPT', 'DESC', 'DSSJ'];
const semDormir = async () => {};

/** coletar() que falha `falhas[setor]` vezes antes de responder. */
function coletor(falhas = {}) {
  const chamadas = [];
  const restam = { ...falhas };
  return {
    chamadas,
    coletar: async (s) => {
      chamadas.push(s);
      if (restam[s] > 0) { restam[s]--; throw new Error(`network timeout at ${s}`); }
      return [{ sigla: `${s}-1` }];
    },
  };
}

test('sem repetirFalhos: setor que falha fica fora e não é repetido (caminho do navegador)', async () => {
  const c = coletor({ DESG: 1 });
  const { resultados, report } = await _coletarSetores(SETORES, {
    coletar: c.coletar, desativado: () => false, dormir: semDormir });
  assert.deepEqual(c.chamadas, SETORES);
  assert.deepEqual(report.ok, ['DEPT', 'DESC', 'DSSJ']);
  assert.deepEqual(report.failed.map(f => f.sector), ['DESG']);
  assert.equal(report.retried, undefined);
  assert.equal(resultados.length, 3);
});

test('repetirFalhos: setor que falha 1x volta na 2ª tentativa, DEPOIS dos outros', async () => {
  const c = coletor({ DESG: 1 });
  let dormiu = 0;
  const { resultados, report } = await _coletarSetores(SETORES, {
    coletar: c.coletar, desativado: () => false, repetirFalhos: true, esperaMs: 7,
    dormir: async (ms) => { dormiu = ms; } });
  assert.deepEqual(c.chamadas, ['DESG', 'DEPT', 'DESC', 'DSSJ', 'DESG']);
  assert.equal(dormiu, 7);
  assert.deepEqual(report.failed, []);
  assert.deepEqual([...report.ok].sort(), [...SETORES].sort());
  assert.deepEqual(report.retried, [{ sector: 'DESG', ok: true, msg1: 'network timeout at DESG' }]);
  // a ordem dos resultados é a dos setores, não a das tentativas
  assert.deepEqual(resultados.map(r => r[0].sigla), SETORES.map(s => `${s}-1`));
});

test('repetirFalhos: só UMA nova tentativa — se falhar de novo, o setor fica em failed', async () => {
  const c = coletor({ DESC: 5 });
  const { report } = await _coletarSetores(SETORES, {
    coletar: c.coletar, desativado: () => false, repetirFalhos: true, dormir: semDormir });
  assert.equal(c.chamadas.filter(s => s === 'DESC').length, 2);
  assert.deepEqual(report.failed.map(f => f.sector), ['DESC']);
  assert.deepEqual(report.retried.map(r => [r.sector, r.ok]), [['DESC', false]]);
});

test('repetirFalhos: sem falha não espera nem repete; desativado não é tentado', async () => {
  const c = coletor();
  let dormiu = false;
  const { report } = await _coletarSetores(SETORES, {
    coletar: c.coletar, desativado: (s) => s === 'DSSJ', repetirFalhos: true,
    dormir: async () => { dormiu = true; } });
  assert.equal(dormiu, false);
  assert.deepEqual(c.chamadas, ['DESG', 'DEPT', 'DESC']);
  assert.deepEqual(report.skipped, ['DSSJ']);
  assert.equal(report.retried, undefined);
});

test('o cron pede a nova tentativa; a rota do navegador não', () => {
  const cron = fs.readFileSync(path.join(__dirname, '..', 'services', 'cronService.js'), 'utf8');
  assert.match(cron, /getTeams\(\{ repetirSetorFalho: true \}, sectorOut\)/);
  const rotas = fs.readFileSync(path.join(__dirname, '..', 'routes', 'index.js'), 'utf8');
  assert.doesNotMatch(rotas, /repetirSetorFalho/);
});
