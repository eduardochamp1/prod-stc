/**
 * test/escalaDiaSync.test.js
 *
 * P2-65, 18/10/2026: o sync da escala (`runSyncEscalaDia`) rodava só às 05:20 e
 * nunca apagava nada. Domingo às 15:00, 9 equipes em campo tinham DR gravado e
 * um sync manual trouxe C08 para 8 delas (a EDP lança a convocação durante o
 * dia); e 61 linhas de hoje que a EDP não devolvia mais seguiam "esperadas".
 *
 * Aqui: agenda a cada 30 min (05:20–22:20) e a limpeza das órfãs — só de hoje
 * até o fim do mês, só do setor gravado, nunca com resposta vazia ou erro.
 */

'use strict';

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'cronService.js'), 'utf8');

describe('agendamento (fonte)', () => {
  test('a cada 30 min de 05:20 a 22:20, sem 22:50', () => {
    // 19/10/2026 (P0-11): os jobs passaram a ser agendados por `_agendar(nome, …)`,
    // que marca a origem para o contador de requisições à EDP.
    assert.match(SRC, /_agendar\('escala-dia', '20 5-22 \* \* \*', \(\) => runSyncEscalaDia\(\)/);
    assert.match(SRC, /_agendar\('escala-dia', '50 5-21 \* \* \*', \(\) => runSyncEscalaDia\(\)/);
    assert.ok(!/'20 5 \* \* \*', \(\) => runSyncEscalaDia/.test(SRC), 'o 1x/dia antigo saiu');
  });
  test('os dois jobs entram em _extraCronJobs (stopCron consegue parar)', () => {
    assert.match(SRC, /_extraCronJobs\.push\(escalaDiaJob, escalaDiaMeiaJob\)/);
  });
});

describe('runSyncEscalaDia (comportamento)', () => {
  const cron = require('../services/cronService');
  const wpa = require('../services/wpaService');
  const dbClient = require('../services/dbClient');

  const orig = {};
  let ops;          // tudo que chegou no "banco"
  let respostas;    // sectorId → linhas | Error
  let erroUpsert;

  // Fake do supabase-js/pgShim: grava a cadeia de chamadas de cada operação.
  function fakeClient() {
    return {
      from(tabela) {
        const op = { tabela, filtros: [] };
        const q = {
          upsert(rows, opts) { op.tipo = 'upsert'; op.rows = rows; op.opts = opts; return q; },
          delete(opts) { op.tipo = 'delete'; op.opts = opts; return q; },
          eq(c, v)  { op.filtros.push([c, '=', v]);  return q; },
          gte(c, v) { op.filtros.push([c, '>=', v]); return q; },
          lt(c, v)  { op.filtros.push([c, '<', v]);  return q; },
          then(res, rej) {
            ops.push(op);
            const r = op.tipo === 'upsert'
              ? { error: erroUpsert || null }
              : { error: null, count: 2 };
            return Promise.resolve(r).then(res, rej);
          },
        };
        return q;
      },
    };
  }

  const linha = (sectorId, data, equipe, codigo) => ({
    sectorId, data, equipe, colaboradorCodigo: '1', colaboradorNome: 'X', codigoEscala: codigo,
  });

  beforeEach(() => {
    ops = [];
    erroUpsert = null;
    respostas = {
      DESG: [linha('DESG', '2026-10-18', 'ECGPR53', 'C08')],
      DEPT: [linha('DEPT', '2026-10-18', 'EPGPR31', 'T06')],
      DESC: [],                                  // resposta vazia
      DSSJ: new Error('WPA collaboratorshifts 500'),
    };
    // 18/10/2026 15:11 BRT
    mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-18T18:11:00Z') });
    orig.dataMode = process.env.DATA_MODE;
    delete process.env.DATA_MODE;
    orig.get = wpa.getCollaboratorShifts;
    orig.dis = wpa.isSectorDisabled;
    orig.client = dbClient.getClient;
    wpa.getCollaboratorShifts = async (s) => {
      const r = respostas[s];
      if (r instanceof Error) throw r;
      return r;
    };
    wpa.isSectorDisabled = () => false;
    dbClient.getClient = () => fakeClient();
  });

  afterEach(() => {
    mock.timers.reset();
    if (orig.dataMode === undefined) delete process.env.DATA_MODE;
    else process.env.DATA_MODE = orig.dataMode;
    wpa.getCollaboratorShifts = orig.get;
    wpa.isSectorDisabled = orig.dis;
    dbClient.getClient = orig.client;
  });

  test('cada setor gravado ganha um DELETE das órfãs de hoje até o fim do mês', async () => {
    const r = await cron.runSyncEscalaDia();
    const dels = ops.filter(o => o.tipo === 'delete');
    assert.deepEqual(dels.map(d => d.filtros.find(f => f[0] === 'sector_id')[2]), ['DESG', 'DEPT']);
    const f = dels[0].filtros;
    assert.deepEqual(f.find(x => x[0] === 'data' && x[1] === '>='), ['data', '>=', '2026-10-18'],
      'dias passados não são apagados');
    assert.deepEqual(f.find(x => x[0] === 'data' && x[1] === '<'), ['data', '<', '2026-11-01']);
    assert.equal(r.orfasApagadas, 4);
    assert.equal(r.gravadas, 2);
  });

  test('o DELETE usa o MESMO carimbo que o upsert gravou', async () => {
    await cron.runSyncEscalaDia();
    const up = ops.find(o => o.tipo === 'upsert' && o.rows[0].sector_id === 'DESG');
    const del = ops.find(o => o.tipo === 'delete');
    const carimbo = up.rows[0].updated_at;
    assert.deepEqual(del.filtros.find(x => x[0] === 'updated_at'), ['updated_at', '<', carimbo]);
    const todos = ops.filter(o => o.tipo === 'upsert').flatMap(o => o.rows.map(x => x.updated_at));
    assert.equal(new Set(todos).size, 1, 'um carimbo só por execução');
  });

  test('resposta vazia ou erro da EDP NUNCA apaga a escala do setor', async () => {
    await cron.runSyncEscalaDia();
    const setoresApagados = ops.filter(o => o.tipo === 'delete')
      .map(d => d.filtros.find(f => f[0] === 'sector_id')[2]);
    assert.ok(!setoresApagados.includes('DESC'));
    assert.ok(!setoresApagados.includes('DSSJ'));
  });

  test('upsert com erro → não apaga', async () => {
    erroUpsert = { message: 'timeout' };
    await cron.runSyncEscalaDia();
    assert.equal(ops.filter(o => o.tipo === 'delete').length, 0);
  });

  test('dezembro: o fim do mês vira 01/01 do ano seguinte', async () => {
    mock.timers.setTime(Date.parse('2026-12-31T15:00:00Z'));
    respostas.DESG = [linha('DESG', '2026-12-31', 'ECGPR53', 'C08')];
    await cron.runSyncEscalaDia();
    const del = ops.find(o => o.tipo === 'delete');
    assert.deepEqual(del.filtros.find(x => x[0] === 'data' && x[1] === '<'), ['data', '<', '2027-01-01']);
    assert.deepEqual(del.filtros.find(x => x[0] === 'data' && x[1] === '>='), ['data', '>=', '2026-12-31']);
  });
});
