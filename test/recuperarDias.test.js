/**
 * test/recuperarDias.test.js
 *
 * 09/11/2026 (backlog P0-14). O relay ficou caído de 08/11 19h a 09/11 23h e os
 * dias sem fechamento só voltaram com backfill manual. Agora cada dia fechado é
 * carimbado em `dias_fechados`, e o que ficar sem carimbo é refeito nas janelas
 * e no fechamento. Estes testes travam:
 *   - quais dias são pendentes (ordem crescente, D-1 só depois das 05h BRT);
 *   - a 1ª execução não rebusca o passado na EDP (semeia até D-2);
 *   - no máximo WPA_RECUPERA_MAX_DIAS por rodada, o mais antigo primeiro;
 *   - dia com 0 equipes ou com falha não é carimbado; falha para a rodada;
 *   - WPA_COLETA=remota e o 0 nas variáveis não chamam a EDP.
 *
 * Nada aqui toca a EDP nem o banco: wpaService, dataWriter e queries são fakes.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { instanteBRT, dateBRT } = require('../services/timeUtil');

const diaMais = (dia, n) => {
  const d = new Date(dia + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

describe('diasPendentes / diaFechavel (puras)', () => {
  const cron = require('../services/cronService');
  const as10h = instanteBRT('2026-11-10', 10 * 60);
  const as03h = instanteBRT('2026-11-10', 3 * 60);

  test('sem carimbo nenhum: os 7 dias anteriores, do mais antigo ao mais novo', () => {
    assert.deepEqual(cron.diasPendentes(as10h, {}, 7),
      ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09']);
  });

  test('dia carimbado sai; hoje nunca entra', () => {
    const fechados = { '2026-11-07': 'x', '2026-11-09': 'x' };
    assert.deepEqual(cron.diasPendentes(as10h, fechados, 3), ['2026-11-08']);
    assert.ok(!cron.diasPendentes(as10h, {}, 7).includes('2026-11-10'));
  });

  test('antes das 05h BRT o D-1 ainda não é pendente (plantão aberto)', () => {
    assert.deepEqual(cron.diasPendentes(as03h, {}, 2), ['2026-11-08']);
    assert.equal(cron.diaFechavel('2026-11-09', as03h), false);
    assert.equal(cron.diaFechavel('2026-11-09', instanteBRT('2026-11-10', 5 * 60)), true);
    assert.equal(cron.diaFechavel('2026-11-10', as10h), false);
    assert.equal(cron.diaFechavel('2026-11-08', as03h), true);
  });
});

describe('runRecuperarDias', () => {
  // Carrega um cronService novo com wpaService, dataWriter e queries falsos.
  async function comFakes({ settings = {}, getTeamsByDate, env = {} }, fn) {
    const mods = ['../services/wpaService', '../services/dataWriter', '../db/queries'].map(m => require.resolve(m));
    const modCron = require.resolve('../services/cronService');
    const originais = mods.map(m => require.cache[m]);
    const reg = { backfills: [], consolidados: [], settings: { ...settings } };
    const fake = (id, exports) => { require.cache[id] = { id, filename: id, loaded: true, exports }; };
    fake(mods[0], {
      getTeamsByDate: async (setor, dia) => {
        if (setor === 'DESG') reg.backfills.push(dia);
        return getTeamsByDate ? getTeamsByDate(setor, dia) : [{ teamName: `${setor}-1`, notasConcluidas: [], notasExecutadas: [] }];
      },
      isSectorDisabled: () => false,
    });
    fake(mods[1], {
      saveSnapshot: async () => {}, upsertDailyTotals: async () => {}, upsertTeamDailyTotals: async () => {},
      consolidateDay: async (d) => { reg.consolidados.push(d); },
      cleanOldSnapshots: async () => {}, cleanOldNoteDetails: async () => {},
    });
    fake(mods[2], {
      getSetting: async (k) => (k in reg.settings ? { data: reg.settings[k] } : null),
      setSetting: async (k, v) => { reg.settings[k] = JSON.parse(JSON.stringify(v)); },
    });
    delete require.cache[modCron];
    const antes = {};
    const envTeste = { DATA_MODE: 'wpa', WPA_COLETA: undefined, WPA_RECUPERA_JANELA_DIAS: undefined, WPA_RECUPERA_MAX_DIAS: undefined, ...env };
    for (const [k, v] of Object.entries(envTeste)) {
      antes[k] = process.env[k];
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    try {
      return await fn(require('../services/cronService'), reg);
    } finally {
      for (const [k, v] of Object.entries(antes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      mods.forEach((m, i) => { if (originais[i]) require.cache[m] = originais[i]; else delete require.cache[m]; });
      delete require.cache[modCron];
    }
  }

  // Relógio real: runBackfillDia carimba com Date.now(). Os dias testados são
  // sempre ≤ D-2, fecháveis a qualquer hora, então o teste não depende da hora.
  const hoje = dateBRT();
  const todosFechados = (menos = []) => {
    const dias = {};
    for (let n = 1; n <= 7; n++) { const d = diaMais(hoje, -n); if (!menos.includes(d)) dias[d] = 'x'; }
    return { dias_fechados: { dias, desde: 'x' } };
  };

  test('1ª execução: semeia até D-2 e não rebusca o passado na EDP', async () => {
    await comFakes({ settings: { fechamento_ok: { date: diaMais(hoje, -1) } } }, async (cron, reg) => {
      const tentados = await cron.runRecuperarDias();
      assert.deepEqual(tentados, []);
      assert.deepEqual(reg.backfills, []);
      const dias = Object.keys(reg.settings.dias_fechados.dias).sort();
      assert.deepEqual(dias, [7, 6, 5, 4, 3, 2, 1].map(n => diaMais(hoje, -n)));
    });
  });

  test('refaz só 1 dia por rodada, o mais antigo, consolida D+1 e carimba', async () => {
    const d5 = diaMais(hoje, -5), d3 = diaMais(hoje, -3);
    await comFakes({ settings: todosFechados([d5, d3]) }, async (cron, reg) => {
      const tentados = await cron.runRecuperarDias();
      assert.deepEqual(tentados, [d5]);
      assert.deepEqual(reg.backfills, [d5]);
      assert.equal(reg.consolidados[reg.consolidados.length - 1], diaMais(d5, 1));   // régua de D+1 (P1-54)
      assert.ok(reg.settings.dias_fechados.dias[d5]);
      assert.ok(!reg.settings.dias_fechados.dias[d3]);
      // a rodada seguinte pega o próximo
      assert.deepEqual(await cron.runRecuperarDias(), [d3]);
      assert.deepEqual(await cron.runRecuperarDias(), []);
    });
  });

  test('WPA_RECUPERA_MAX_DIAS=2 refaz dois, em ordem crescente', async () => {
    const d5 = diaMais(hoje, -5), d3 = diaMais(hoje, -3), d2 = diaMais(hoje, -2);
    await comFakes({ settings: todosFechados([d2, d5, d3]), env: { WPA_RECUPERA_MAX_DIAS: '2' } }, async (cron, reg) => {
      assert.deepEqual(await cron.runRecuperarDias(), [d5, d3]);
      assert.deepEqual(reg.backfills, [d5, d3]);
    });
  });

  test('dia com 0 equipes (EDP "Nenhum dado encontrado") não é carimbado', async () => {
    const d4 = diaMais(hoje, -4);
    await comFakes({ settings: todosFechados([d4]), getTeamsByDate: async () => [] }, async (cron, reg) => {
      assert.deepEqual(await cron.runRecuperarDias(), [d4]);
      assert.ok(!reg.settings.dias_fechados.dias[d4]);
      assert.deepEqual(reg.consolidados, []);
    });
  });

  test('setor falhando: nada carimbado e a rodada para no primeiro dia', async () => {
    const d4 = diaMais(hoje, -4), d2 = diaMais(hoje, -2);
    const falha = async () => { const e = new Error('proxy fora'); e.code = 'WPA_PROXY_INDISPONIVEL'; throw e; };
    await comFakes({ settings: todosFechados([d4, d2]), getTeamsByDate: falha, env: { WPA_RECUPERA_MAX_DIAS: '5' } }, async (cron, reg) => {
      assert.deepEqual(await cron.runRecuperarDias(), [d4]);
      assert.deepEqual(reg.backfills, [d4]);
      assert.ok(!reg.settings.dias_fechados.dias[d4]);
    });
  });

  test('`exceto` tira o dia que o chamador acabou de tentar', async () => {
    const d4 = diaMais(hoje, -4);
    await comFakes({ settings: todosFechados([d4]) }, async (cron, reg) => {
      assert.deepEqual(await cron.runRecuperarDias({ exceto: [d4] }), []);
      assert.deepEqual(reg.backfills, []);
    });
  });

  test('WPA_COLETA=remota, mock e 0 nas variáveis não chamam a EDP', async () => {
    const d4 = diaMais(hoje, -4);
    for (const env of [{ WPA_COLETA: 'remota' }, { DATA_MODE: 'mock' }, { WPA_RECUPERA_MAX_DIAS: '0' }, { WPA_RECUPERA_JANELA_DIAS: '0' }]) {
      await comFakes({ settings: todosFechados([d4]), env }, async (cron, reg) => {
        assert.deepEqual(await cron.runRecuperarDias(), []);
        assert.deepEqual(reg.backfills, []);
      });
    }
  });

  test('backfill manual de dia já fechável carimba; o de hoje não', async () => {
    const d3 = diaMais(hoje, -3);
    await comFakes({ settings: {} }, async (cron, reg) => {
      await cron.runBackfillDia(d3);
      assert.ok(reg.settings.dias_fechados.dias[d3]);
      await cron.runBackfillDia(hoje);
      assert.ok(!reg.settings.dias_fechados.dias[hoje]);
    });
  });
});
