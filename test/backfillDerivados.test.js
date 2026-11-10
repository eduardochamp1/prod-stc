/**
 * test/backfillDerivados.test.js
 *
 * 10/11/2026 (backlog P0-16). Tela do José (aba Rejeições, Guarapari): zero de
 * 19/10 em diante. Só o snapshot ao vivo classificava rejeições; os dias de
 * 20/10 a 09/11 foram fechados por backfill e ficaram sem linha em
 * `note_rejections` (~5.080 notas), e sem intervalos e saída da nota. Estes
 * testes travam:
 *   - runBackfillDia grava as rejeições do dia, ANTES de consolidar;
 *   - o que já está no banco não é buscado de novo na EDP;
 *   - falha de caminho na classificação derruba o dia (não consolida, não
 *     carimba) e sai marcada como falha de caminho;
 *   - falha de uma nota só não derruba o dia;
 *   - runDerivadosDoDia só roda para dia já fechado;
 *   - recuperação e as duas rotas de backfill chamam os derivados.
 *
 * Nada aqui toca a EDP nem o banco: wpaService, dataWriter, queries, dbClient e
 * rejectionService são fakes.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { dateBRT, instanteBRT } = require('../services/timeUtil');
const { WpaAccessError } = require('../services/wpaErros');

const diaMais = (dia, n) => {
  const d = new Date(dia + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function comFakes({ jaNoBanco = [], fetchRejectionDetails }, fn) {
  const nomes = ['../services/wpaService', '../services/dataWriter', '../db/queries', '../services/dbClient', '../services/rejectionService'];
  const mods = nomes.map(m => require.resolve(m));
  const modCron = require.resolve('../services/cronService');
  const originais = mods.map(m => require.cache[m]);
  const reg = { ordem: [], gravadas: [], buscadas: [], settings: {} };
  const fake = (id, exports) => { require.cache[id] = { id, filename: id, loaded: true, exports }; };
  const dia = diaMais(dateBRT(), -3);
  fake(mods[0], {
    getTeamsByDate: async (setor) => (setor !== 'DESG' ? [] : [{
      teamName: 'EQP1', sigla: 'EQP1', regional: 'GUA', sectorId: 'DESG', sessionBegin: `${dia}T07:00:00`,
      collaborators: [{ code: '123', name: 'Fulano' }],
      notasConcluidas: [], notasExecutadas: [],
      notasRejeitadas: [{ id: 'aaa', codigo: '1001', tipoCode: 'md' }, { id: 'bbb', codigo: '1002', tipoCode: 'sf' }],
    }]),
    isSectorDisabled: () => false,
  });
  fake(mods[1], {
    saveSnapshot: async () => {}, upsertDailyTotals: async () => {}, upsertTeamDailyTotals: async () => {},
    consolidateDay: async (d) => { reg.ordem.push(`consolida:${d}`); },
    cleanOldSnapshots: async () => {}, cleanOldNoteDetails: async () => {},
  });
  fake(mods[2], {
    getSetting: async (k) => (k in reg.settings ? { data: reg.settings[k] } : null),
    setSetting: async (k, v) => { reg.settings[k] = JSON.parse(JSON.stringify(v)); },
  });
  fake(mods[3], {
    getClient: () => ({
      from: (tabela) => ({
        select: () => ({ in: async (_c, ids) => ({ data: tabela === 'note_rejections' ? ids.filter(i => jaNoBanco.includes(i)).map(i => ({ note_id: i })) : [] }) }),
        upsert: async (linhas) => { if (tabela === 'note_rejections') { reg.gravadas.push(...linhas); reg.ordem.push('rejeicoes'); } return { error: null }; },
      }),
    }),
  });
  fake(mods[4], {
    fetchRejectionDetails: async (id, tipo) => {
      reg.buscadas.push(id);
      return fetchRejectionDetails ? fetchRejectionDetails(id, tipo) : { motivo_codes: ['M1'], motivo_textos: ['Motivo'] };
    },
  });
  delete require.cache[modCron];
  const antes = { DATA_MODE: process.env.DATA_MODE, WPA_COLETA: process.env.WPA_COLETA };
  process.env.DATA_MODE = 'wpa';
  delete process.env.WPA_COLETA;
  try {
    return await fn(require('../services/cronService'), reg, dia);
  } finally {
    for (const [k, v] of Object.entries(antes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    mods.forEach((m, i) => { if (originais[i]) require.cache[m] = originais[i]; else delete require.cache[m]; });
    delete require.cache[modCron];
  }
}

describe('runBackfillDia grava as rejeições do dia (P0-16)', () => {
  test('rejeitadas do backfill vão para note_rejections, antes de consolidar', async () => {
    await comFakes({}, async (cron, reg, dia) => {
      const r = await cron.runBackfillDia(dia);
      assert.equal(r.ok, true);
      assert.deepEqual(reg.gravadas.map(l => l.note_id).sort(), ['aaa', 'bbb']);
      const l = reg.gravadas.find(x => x.note_id === 'aaa');
      assert.equal(l.session_date, dia);
      assert.equal(l.team_name, 'EQP1');
      assert.equal(l.tipo, 'MD');
      assert.deepEqual(l.collaborator_codes, ['123']);
      assert.ok(reg.ordem.indexOf('rejeicoes') < reg.ordem.indexOf(`consolida:${dia}`), `ordem: ${reg.ordem}`);
    });
  });

  test('o que já está no banco não é buscado de novo na EDP', async () => {
    await comFakes({ jaNoBanco: ['aaa'] }, async (cron, reg, dia) => {
      await cron.runBackfillDia(dia);
      assert.deepEqual(reg.buscadas, ['bbb']);
      assert.deepEqual(reg.gravadas.map(l => l.note_id), ['bbb']);
    });
  });

  test('falha de caminho na classificação derruba o dia: não consolida nem carimba', async () => {
    const semTunel = async () => { throw new WpaAccessError('WPA_PROXY_INDISPONIVEL', { host: 'x' }); };
    await comFakes({ fetchRejectionDetails: semTunel }, async (cron, reg, dia) => {
      await assert.rejects(cron.runBackfillDia(dia),
        (err) => err.code === 'WPA_PROXY_INDISPONIVEL' && (err.falhas || []).some(f => f.caminho));
      assert.deepEqual(reg.ordem, []);
      assert.ok(!(reg.settings.dias_fechados && reg.settings.dias_fechados.dias[dia]));
    });
  });

  test('falha de uma nota só não derruba o dia', async () => {
    const umaFalha = async (id) => { if (id === 'aaa') throw new Error('500 da EDP'); return { motivo_codes: [], motivo_textos: [] }; };
    await comFakes({ fetchRejectionDetails: umaFalha }, async (cron, reg, dia) => {
      const r = await cron.runBackfillDia(dia);
      assert.equal(r.ok, true);
      assert.deepEqual(reg.gravadas.map(l => l.note_id), ['bbb']);
      assert.ok(reg.ordem.includes(`consolida:${dia}`));
    });
  });
});

describe('runDerivadosDoDia (intervalos + saída da nota)', () => {
  test('dia ainda aberto não roda; mock não roda', async () => {
    const cron = require('../services/cronService');
    const agora = instanteBRT('2026-11-10', 10 * 60);
    const antes = process.env.DATA_MODE;
    try {
      process.env.DATA_MODE = 'wpa';
      assert.deepEqual(await cron.runDerivadosDoDia('2026-11-10', agora), { ok: false, motivo: 'dia_aberto' });
      // D-1 antes das 05h: plantão aberto.
      assert.equal((await cron.runDerivadosDoDia('2026-11-09', instanteBRT('2026-11-10', 3 * 60))).motivo, 'dia_aberto');
      process.env.DATA_MODE = 'mock';
      assert.equal((await cron.runDerivadosDoDia('2026-11-05', agora)).motivo, 'mock');
    } finally {
      if (antes === undefined) delete process.env.DATA_MODE; else process.env.DATA_MODE = antes;
    }
  });
});

describe('fonte: quem chama rejeições e derivados', () => {
  const ler = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

  test('recuperação roda os derivados do dia refeito', () => {
    assert.match(ler('services', 'cronService.js'), /await runDerivadosDoDia\(dia, agora\);/);
  });

  test('as duas rotas de backfill do admin rodam rejeições e derivados', () => {
    const SRC = ler('routes', 'index.js');
    assert.match(SRC, /const derivados = await c\.runDerivadosDoDia\(date\);/);
    assert.match(SRC, /await runClassifyRejections\(teams\)\.catch/);
    assert.match(SRC, /if \(c\) await c\.runDerivadosDoDia\(date\);/);
  });
});
