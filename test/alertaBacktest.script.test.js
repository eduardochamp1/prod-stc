/**
 * test/alertaBacktest.script.test.js
 *
 * A orquestração de scripts/backtest-alerta-produtividade.js com um POOL FALSO:
 * não tenho Postgres local, então é o jeito de provar que as consultas certas são
 * feitas, que é SOMENTE LEITURA, e que a saída diz o que o José precisa ler.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const S = require('../scripts/backtest-alerta-produtividade');
const { dateBRTMinusDays, instanteBRT } = require('../services/timeUtil');

const ONTEM = dateBRTMinusDays(1);
const em = (h, m = 0) => new Date(instanteBRT(ONTEM, h * 60 + m));

function poolFalso({ equipes, snaps, intervalos, intervalosFalha = false }) {
  const consultas = [];
  return {
    consultas,
    async query(sql, params) {
      consultas.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (/FROM public\.equipes_oficiais/.test(sql)) return { rows: equipes };
      if (/FROM public\.snapshots/.test(sql)) return { rows: params[0] === ONTEM ? snaps : [] };
      if (/FROM public\.sessao_intervalo/.test(sql)) {
        if (intervalosFalha) throw new Error('relation "sessao_intervalo" does not exist');
        return { rows: params[0] === ONTEM ? (intervalos || []) : [] };
      }
      throw new Error('consulta inesperada: ' + sql.slice(0, 60));
    },
  };
}

const equipes = [
  { sigla: 'ECGPR53', regional: 'GUA', escala_inicio: '08:00:00', escala_fim: '17:00:00' },
  { sigla: 'ECGPR54', regional: 'GUA', escala_inicio: '08:00:00', escala_fim: '17:00:00' },
  { sigla: 'ETGPR16', regional: 'GUA', escala_inicio: null, escala_fim: null },
  { sigla: 'OPXYZ01', regional: 'GUA', escala_inicio: '08:00:00', escala_fim: '17:00:00' },
];
const snaps = [
  { team_name: 'ECGPR53', captured_at: em(9), session_end: null, conc: ['a'], rej: [] },                       // 1 → alertaria
  { team_name: 'ECGPR54', captured_at: em(9), session_end: null, conc: ['a', 'b', 'c', 'd', 'e'], rej: [] },   // 5 → não
  { team_name: 'ETGPR16', captured_at: em(9), session_end: null, conc: [], rej: [] },                           // sem escala
  { team_name: 'OPXYZ01', captured_at: em(9), session_end: null, conc: [], rej: [] },                           // categoria fora
  { team_name: 'FORA999', captured_at: em(9), session_end: null, conc: [], rej: [] },                           // fora da whitelist
];
const args = (o = {}) => ({ dias: 3, limite: null, categorias: null, semRefeicao: false, erros: [], ...o });

async function rodar(pool, a = args()) {
  const saida = [];
  const resumo = await S.executar({ pool, args: a, escrever: (s) => saida.push(s) });
  return { resumo, texto: saida.join('\n') };
}

describe('lerArgs', () => {
  test('padrões e flags', () => {
    const a = S.lerArgs([]);
    assert.equal(a.dias, 30);
    assert.equal(a.limite, null);
    assert.equal(a.semRefeicao, false);
    assert.deepEqual(a.erros, []);
    const b = S.lerArgs(['--dias=14', '--limite=3', '--categorias=comercial, moto', '--sem-refeicao']);
    assert.equal(b.dias, 14);
    assert.equal(b.limite, 3);
    assert.deepEqual(b.categorias, ['COMERCIAL', 'MOTO']);
    assert.equal(b.semRefeicao, true);
  });
  test('rejeita lixo, --dias fora de 1..120 e argumento desconhecido', () => {
    assert.equal(S.lerArgs(['--dias=0']).erros.length, 1);
    assert.equal(S.lerArgs(['--dias=500']).erros.length, 1);
    assert.equal(S.lerArgs(['--xpto']).erros.length, 1);
  });
});

describe('executar (pool falso)', () => {
  test('é SOMENTE LEITURA: só SELECT, nunca INSERT/UPDATE/DELETE/DDL', async () => {
    const pool = poolFalso({ equipes, snaps });
    await rodar(pool);
    assert.ok(pool.consultas.length >= 3);
    for (const c of pool.consultas) {
      assert.match(c.sql, /^\s*SELECT\b/i, c.sql.slice(0, 40));
      assert.doesNotMatch(c.sql, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\b/i);
    }
  });
  test('1 consulta de snapshots POR DIA (o jsonb é pesado), hoje fica de fora', async () => {
    const pool = poolFalso({ equipes, snaps });
    await rodar(pool, args({ dias: 3 }));
    const dias = pool.consultas.filter(c => /FROM public\.snapshots/.test(c.sql)).map(c => c.params[0]);
    assert.equal(dias.length, 3);
    assert.deepEqual(dias, [dateBRTMinusDays(3), dateBRTMinusDays(2), dateBRTMinusDays(1)]);
    assert.ok(!dias.includes(dateBRTMinusDays(0)));
  });
  test('extrai só os ids no servidor (jsonb_path_query_array), nunca o jsonb inteiro', async () => {
    const pool = poolFalso({ equipes, snaps });
    await rodar(pool);
    const sql = pool.consultas.find(c => /FROM public\.snapshots/.test(c.sql)).sql;
    assert.match(sql, /jsonb_path_query_array\(data, '\$\.notasConcluidas\[\*\]\.id'\)/);
    assert.match(sql, /jsonb_path_query_array\(data, '\$\.notasRejeitadas\[\*\]\.id'\)/);
    // Tirando as duas chamadas de função, a lista do SELECT não pode ter `data` cru.
    const listaSelect = sql.replace(/jsonb_path_query_array\(data,/g, '').split(' FROM ')[0];
    assert.doesNotMatch(listaSelect, /\bdata\b/);
  });
  test('refeição lida com AT TIME ZONE UTC (desfaz o Z errado do P1-48)', async () => {
    const pool = poolFalso({ equipes, snaps });
    await rodar(pool);
    const sql = pool.consultas.find(c => /sessao_intervalo/.test(c.sql)).sql;
    assert.match(sql, /inicio AT TIME ZONE 'UTC'/);
    assert.match(sql, /fim\s+AT TIME ZONE 'UTC'/);
  });
  test('resultado: avalia só quem está no escopo e conta as ignoradas à parte', async () => {
    const { resumo } = await rodar(poolFalso({ equipes, snaps }), args({ dias: 1 }));
    assert.equal(resumo.total.avaliadas, 2, 'ECGPR53 e ECGPR54');
    assert.equal(resumo.total.alertariam, 1, 'só a ECGPR53 (1 executada)');
    assert.deepEqual(resumo.ignoradas.sem_escala.equipes, ['ETGPR16']);
    assert.equal(resumo.ignoradas.categoria_fora, undefined, 'Operacional nem aparece (ruído)');
  });
  test('--limite muda o resultado (e se fosse 6?)', async () => {
    const { resumo } = await rodar(poolFalso({ equipes, snaps }), args({ dias: 1, limite: 6 }));
    assert.equal(resumo.total.alertariam, 2, 'agora a ECGPR54 (5) também alertaria');
  });
  test('--categorias restringe o escopo', async () => {
    const { resumo } = await rodar(poolFalso({ equipes, snaps }), args({ dias: 1, categorias: ['MOTO'] }));
    assert.equal(resumo.total.avaliadas, 0);
  });
  test('o texto traz a regra, os limites conhecidos, o resumo e o veredito', async () => {
    const { texto } = await rodar(poolFalso({ equipes, snaps }), args({ dias: 1 }));
    assert.match(texto, /SOMENTE LEITURA/);
    assert.match(texto, /< 4 executadas/);
    assert.match(texto, /Limites conhecidos/);
    assert.match(texto, /RESUMO/);
    assert.match(texto, /Ignoradas/);
    assert.match(texto, /sem_escala/);
    assert.match(texto, /VEREDITO/);
  });
  test('sessao_intervalo AUSENTE: segue SEM o adiamento e DIZ que é um teto', async () => {
    const { texto } = await rodar(poolFalso({ equipes, snaps, intervalosFalha: true }));
    assert.match(texto, /NÃO considerada/);
    assert.match(texto, /indisponível/);
    assert.match(texto, /TETO de alertas/);
  });
  test('--sem-refeicao não consulta sessao_intervalo e avisa que é teto', async () => {
    const pool = poolFalso({ equipes, snaps });
    const { texto } = await rodar(pool, args({ semRefeicao: true }));
    assert.equal(pool.consultas.filter(c => /sessao_intervalo/.test(c.sql)).length, 0);
    assert.match(texto, /TETO de alertas/);
  });
  test('dia sem coleta de intervalos é avisado (almoço desconhecido ≠ ninguém almoçou)', async () => {
    const { texto } = await rodar(poolFalso({ equipes, snaps, intervalos: [] }));
    assert.match(texto, /sem coleta de intervalos/);
  });
  test('parâmetro inválido aborta com mensagem clara', async () => {
    await assert.rejects(() => S.executar({ pool: poolFalso({ equipes, snaps }), args: args({ categorias: ['XPTO'] }), escrever() {} }),
      /parâmetros inválidos/);
  });
  test('o almoço de uma equipe adia o alerta (ponta a ponta com sessao_intervalo)', async () => {
    const intervalos = [{ equipe: 'ECGPR53', motivo: '15 - Horário de Refeição', inicio: `${ONTEM}T12:00:00`, fim: `${ONTEM}T13:00:00` }];
    const { resumo } = await rodar(poolFalso({ equipes, snaps, intervalos }), args({ dias: 1 }));
    assert.equal(resumo.total.alertariam, 1, 'adiou, mas alerta às 13:00');
  });
});
