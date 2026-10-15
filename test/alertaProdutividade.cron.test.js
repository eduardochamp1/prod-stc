/**
 * test/alertaProdutividade.cron.test.js
 *
 * O FIO entre o ciclo do cron e o avaliador (T5). Duas camadas:
 *   1. de FONTE: o gancho está no lugar certo do runSnapshot (depois do upsert de
 *      team_daily_totals, sem await, com .catch, só equipes reais);
 *   2. de COMPORTAMENTO: `runAlertaProdutividade` com as dependências reais
 *      trocadas por falsas — prova que DESLIGADO não toca na WPA nem escreve.
 */

'use strict';

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'cronService.js'), 'utf8');

describe('gancho no runSnapshot (fonte)', () => {
  const iUpsert = SRC.indexOf('await upsertTeamDailyTotals(allTeams);');
  const iGancho = SRC.indexOf('runAlertaProdutividade(teams).catch(');
  const iSalvo  = SRC.indexOf("log.info('snapshot_saved'");

  test('existe, vem DEPOIS do upsert de team_daily_totals e ANTES do snapshot_saved', () => {
    assert.ok(iUpsert > 0 && iGancho > 0 && iSalvo > 0);
    assert.ok(iUpsert < iGancho, 'precisa ler os totais já gravados neste ciclo');
    assert.ok(iGancho < iSalvo);
  });
  test('NÃO é aguardado (não pode atrasar nem derrubar o snapshot) e tem .catch', () => {
    assert.ok(!/await\s+runAlertaProdutividade/.test(SRC));
    assert.match(SRC, /runAlertaProdutividade\(teams\)\.catch\(err =>\s*\n?\s*log\.error\('alerta_produtividade_failed'/);
  });
  test('recebe `teams` (reais), NÃO `allTeams` (que inclui as fantasmas do _acc)', () => {
    assert.ok(!/runAlertaProdutividade\(allTeams\)/.test(SRC));
  });
  test('é exportada', () => {
    assert.match(SRC, /module\.exports = \{[\s\S]*runAlertaProdutividade,/);
  });
  test('os require pesados são PREGUIÇOSOS (dentro da função), não no topo do cron', () => {
    const topo = SRC.slice(0, SRC.indexOf('let tokenJob'));
    assert.ok(!/alertasQueries|alertaProdutividade/.test(topo));
  });
});

describe('runAlertaProdutividade (comportamento)', () => {
  const cron = require('../services/cronService');
  const queries = require('../db/queries');
  const alertasQ = require('../db/alertasQueries');
  const wpa = require('../services/wpaService');
  const oficiais = require('../services/equipesOficiais');
  const writer = require('../services/dataWriter');

  const orig = {};
  const chamadas = [];
  let config;

  const equipe = (nome) => ({
    teamName: nome, sigla: nome, sectorId: 'DESG', regional: 'GUA', id: `s-${nome}`,
    sessionBegin: '2026-10-14T08:00:00.00', sessionEnd: null, notasRejeitadas: [],
  });

  beforeEach(() => {
    chamadas.length = 0;
    config = { data: { ativo: false } };
    // 14/10/2026 13:00 BRT
    mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-14T16:00:00Z') });
    orig.getSetting = queries.getSetting;
    orig.getMeta = oficiais.getMeta;
    orig.sessionDate = writer._sessionDate;
    orig.breaks = wpa.getSessionBreaks;
    orig.q = {};
    for (const k of ['estadoDoDia', 'executadasPorEquipe', 'historicoSupervisores', 'abrir', 'atualizar', 'resolver']) {
      orig.q[k] = alertasQ[k];
      alertasQ[k] = async (...a) => {
        chamadas.push(k);
        if (k === 'executadasPorEquipe') return { ECGPR53: 1 };
        if (k === 'estadoDoDia') return [];
        if (k === 'historicoSupervisores') return { historico: [], nomes: {} };
        if (k === 'abrir') { chamadas.push({ abrir: a }); return true; }
        return undefined;
      };
    }
    queries.getSetting = async () => config;
    oficiais.getMeta = (s) => ({ sigla: s, regional: 'GUA', escala_inicio: '08:00:00', escala_fim: '17:00:00' });
    writer._sessionDate = (t) => String(t.sessionBegin).slice(0, 10);
    wpa.getSessionBreaks = async (sid) => { chamadas.push(`breaks:${sid}`); return []; };
  });

  afterEach(() => {
    mock.timers.reset();
    queries.getSetting = orig.getSetting;
    oficiais.getMeta = orig.getMeta;
    writer._sessionDate = orig.sessionDate;
    wpa.getSessionBreaks = orig.breaks;
    for (const k of Object.keys(orig.q)) alertasQ[k] = orig.q[k];
  });

  test('DESLIGADO: nenhuma leitura de totais, nenhuma chamada à WPA, nenhuma escrita', async () => {
    const r = await cron.runAlertaProdutividade([equipe('ECGPR53')]);
    assert.equal(r.ativo, false);
    assert.deepEqual(chamadas, []);
  });
  test('config ausente (null) → também desligado', async () => {
    config = null;
    const r = await cron.runAlertaProdutividade([equipe('ECGPR53')]);
    assert.equal(r.ativo, false);
    assert.deepEqual(chamadas, []);
  });
  test('config inválida → desligado, sem escrever', async () => {
    config = { data: { ativo: true, limite: 0 } };
    const r = await cron.runAlertaProdutividade([equipe('ECGPR53')]);
    assert.equal(r.ativo, false);
    assert.deepEqual(chamadas, []);
  });
  test('LIGADO: equipe abaixo do limite abre o alerta (e só então consulta a refeição)', async () => {
    config = { data: { ativo: true, limite: 4, categorias: ['COMERCIAL'], tolerancia_refeicao_min: 60 } };
    const r = await cron.runAlertaProdutividade([equipe('ECGPR53')]);
    assert.equal(r.ativo, true);
    assert.equal(r.abertos, 1);
    assert.ok(chamadas.includes('breaks:s-ECGPR53'));
    const abrir = chamadas.find(c => c && c.abrir);
    assert.equal(abrir.abrir[0], null, 'o pool é o padrão do pgShim');
    assert.equal(abrir.abrir[1].team_name, 'ECGPR53');
    assert.equal(abrir.abrir[1].data, '2026-10-14');
  });
  test('DATA_MODE=mock não faz nada', async () => {
    const antes = process.env.DATA_MODE;
    process.env.DATA_MODE = 'mock';
    try {
      assert.equal(await cron.runAlertaProdutividade([equipe('ECGPR53')]), null);
      assert.deepEqual(chamadas, []);
    } finally {
      if (antes === undefined) delete process.env.DATA_MODE; else process.env.DATA_MODE = antes;
    }
  });
});
