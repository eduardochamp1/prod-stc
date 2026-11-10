/**
 * test/cobertura.test.js
 *
 * 10/11/2026 (backlog P0-16). De 20/10 a 09/11/2026 os dias foram fechados por
 * backfill e ficaram sem rejeições, detalhes, intervalos e saída da nota — três
 * semanas sem ninguém ver. O radar (services/cobertura.js) compara a produção
 * de cada dia fechado com o que deveria existir junto dela. Estes testes travam
 * as regras (com os números reais do incidente) e os ganchos.
 *
 * Nada aqui toca o banco: `medir` recebe um pool falso.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const cobertura = require('../services/cobertura');

// Linhas medidas em produção em 10/11/2026 (scripts/diag-cobertura-derivados.js).
const NORMAL_1310 = { dia: '2026-10-13', producao: 1039, coletas_ao_vivo: 77, rej_snapshot: 359, rej_gravadas: 359,
  concluidas: 1311, concluidas_com_detalhe: 1311, intervalos: 484, saida_nota: 1270, saida_sem_janela: 68, carteira: 127, notas_devolvidas: 133, escala: 679, interrupcoes: 77 };
const BACKFILL_0511 = { dia: '2026-11-05', producao: 1202, coletas_ao_vivo: 0, rej_snapshot: 473, rej_gravadas: 0,
  concluidas: 1172, concluidas_com_detalhe: 0, intervalos: 0, saida_nota: 0, saida_sem_janela: 0, carteira: 0, notas_devolvidas: 0, escala: 621, interrupcoes: 0 };

describe('avaliarDia', () => {
  test('dia normal de coleta ao vivo não tem falta', () => {
    const a = cobertura.avaliarDia(NORMAL_1310);
    assert.deepEqual(a.buracos, []);
    assert.deepEqual(a.avisos, []);
  });

  test('dia fechado só por backfill (05/11/2026): 4 buracos e 3 avisos', () => {
    const a = cobertura.avaliarDia(BACKFILL_0511);
    assert.deepEqual(a.chaves, ['rejeicoes', 'intervalos', 'saida_nota', 'detalhes', 'ao_vivo', 'carteira', 'notas_devolvidas']);
    assert.equal(a.buracos.length, 4);
    assert.equal(a.avisos.length, 3);
    assert.match(a.buracos[0], /0 gravadas de 473/);
    assert.match(a.buracos[3], /0 de 1172 concluídas/);
  });

  test('rejeições: 409 de 477 (28/10) passa; 8 de 444 (19/10) não; poucas rejeitadas não cobram', () => {
    const base = { ...NORMAL_1310 };
    assert.ok(!cobertura.avaliarDia({ ...base, rej_snapshot: 477, rej_gravadas: 409 }).chaves.includes('rejeicoes'));
    assert.ok(cobertura.avaliarDia({ ...base, rej_snapshot: 444, rej_gravadas: 8 }).chaves.includes('rejeicoes'));
    assert.ok(!cobertura.avaliarDia({ ...base, rej_snapshot: 5, rej_gravadas: 0 }).chaves.includes('rejeicoes'));
  });

  test('saída da nota preenchida mas sem avaliação (09/11/2026: 818 de 856 sem_janela) é buraco', () => {
    const a = cobertura.avaliarDia({ ...NORMAL_1310, saida_nota: 856, saida_sem_janela: 818 });
    assert.deepEqual(a.chaves, ['saida_nota']);
    assert.match(a.buracos[0], /818 de 856 sem avaliação/);
  });

  test('dia sem produção não é avaliado', () => {
    const a = cobertura.avaliarDia({ ...BACKFILL_0511, producao: 0 });
    assert.deepEqual(a.chaves, []);
  });
});

describe('diasFechados / medir / resumir', () => {
  test('hoje e o futuro ficam fora', () => {
    assert.deepEqual(cobertura.diasFechados('2026-11-08', '2026-11-12', '2026-11-10'), ['2026-11-08', '2026-11-09']);
  });

  test('medir consulta 1 dia por vez e só os fechados', async () => {
    const vistos = [];
    const pool = { query: async (_sql, params) => { vistos.push(params[0]); return { rows: [{ producao: 1 }] }; } };
    const r = await cobertura.medir(pool, '2026-11-08', '2026-11-10', { hoje: '2026-11-10' });
    assert.deepEqual(vistos, ['2026-11-08', '2026-11-09']);
    assert.deepEqual(r.map(x => x.dia), ['2026-11-08', '2026-11-09']);
  });

  test('resumir guarda só os dias com falta e lista os com buraco', () => {
    const r = cobertura.resumir([NORMAL_1310, BACKFILL_0511], { agora: Date.parse('2026-11-10T08:10:00Z') });
    assert.equal(r.dias_medidos, 2);
    assert.deepEqual(r.dias_com_buraco, ['2026-11-05']);
    assert.equal(r.dias.length, 1);
    assert.equal(r.de, '2026-10-13');
    assert.equal(r.ate, '2026-11-05');
  });

  test('a consulta separa ao vivo de backfill e não chama nada fora do banco', () => {
    assert.match(cobertura.SQL_DIA, /data \? 'isOnline'/);
    assert.ok(!/INSERT|UPDATE|DELETE/i.test(cobertura.SQL_DIA));
  });
});

describe('fonte: ganchos do radar', () => {
  const ler = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

  test('roda depois do fechamento e aparece no /admin/health', () => {
    const SRC = ler('services', 'cronService.js');
    assert.match(SRC, /await _comColeta\('fechamento', \(\) => runFechamento\(\)\); await runRadarCobertura\(\);/);
    assert.match(ler('routes', 'index.js'), /out\.cobertura = \(r && r\.data\) \|\| null;/);
  });

  test('runRadarCobertura não lança sem banco e não roda em mock', async () => {
    const cron = require('../services/cronService');
    const antes = process.env.DATA_MODE;
    try {
      process.env.DATA_MODE = 'mock';
      assert.equal(await cron.runRadarCobertura(), null);
      process.env.DATA_MODE = 'wpa';
      assert.equal(await cron.runRadarCobertura({ alertar: async () => {} }), null);   // sem DATABASE_URL no teste
    } finally {
      if (antes === undefined) delete process.env.DATA_MODE; else process.env.DATA_MODE = antes;
    }
  });
});
