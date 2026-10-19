/**
 * test/saidaNotaEscopo.test.js
 *
 * Rotas da aba "Saída da nota" (P2-70) com a cadeia REAL exceto o pool:
 *   middleware/auth.applyScope → handler (routes/index.js) → db/saidaNotaQueries
 *   → pool FALSO que aplica o `regional IN (...)` com os PARÂMETROS recebidos.
 * Se a rota deixasse de passar o escopo, uma conta veria a equipe de outra
 * regional — e este teste quebra (lição do P1-12). Mesmo padrão de
 * test/alertasEscopo.test.js. E, à parte, a montagem pura do painel.
 */

'use strict';

process.env.NODE_ENV  = 'test';
process.env.DATA_MODE = 'escopo-test';
process.env.JWT_SECRET = 'test-secret-escopo';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { applyScope } = require('../middleware/auth');
const router = require('../routes/index');
const queries = require('../db/queries');
const pgShim = require('../services/pgShim');
const { montarPainel } = require('../services/saidaNotaPainel');

const ID_GUA = '11111111-0000-0000-0000-000000000000';
const ID_SJC = '22222222-0000-0000-0000-000000000000';
const LINHAS = [
  { note_id: ID_GUA, equipe: 'ECGPR53', regional: 'GUA', status: 'saiu', numero: '1', tipo: 'MD',
    min_fora: 30, dist_max_m: 2000, km: 4, ocorrencia_id: 'ECGPR53|x', inicio: new Date(0), fim: new Date(1) },
  { note_id: ID_SJC, equipe: 'ECCSJ82', regional: 'SJC', status: 'saiu', numero: '2', tipo: 'MD',
    min_fora: 20, dist_max_m: 1000, km: 2, ocorrencia_id: 'ECCSJ82|y', inicio: new Date(0), fim: new Date(1) },
];

function handler(path) {
  const camada = router.stack.find(l => l.route && l.route.path === path && l.route.methods.get);
  assert.ok(camada, `a rota GET ${path} tem de existir`);
  return camada.route.stack[0].handle;
}

function poolQueFiltra(registro) {
  return {
    async query(sql, params) {
      registro.push({ sql, params });
      const m = sql.match(/regional IN \(([^)]*)\)/);
      assert.ok(m, 'toda consulta da tela TEM de filtrar por regional');
      const permitidas = new Set(m[1].split(',').map(p => params[Number(p.trim().replace('$', '')) - 1]));
      const vis = LINHAS.filter(l => permitidas.has(l.regional));
      if (/GROUP BY equipe, regional, status/.test(sql)) {
        return { rows: vis.map(l => ({ equipe: l.equipe, regional: l.regional, status: l.status, n: 1, placas: [] })) };
      }
      if (/unnest\(veiculos_junto\)/.test(sql)) return { rows: [] };
      if (/WHERE ocorrencia_id/.test(sql)) return { rows: [] };
      if (/note_id = \$1::uuid/.test(sql)) return { rows: vis.filter(l => l.note_id === params[0]) };
      return { rows: vis };
    },
  };
}

function resFalso() {
  return {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

async function chamar(path, regionaisDaConta, { query = {}, params = {} } = {}) {
  const req = { user: { username: 'x', role: 'user', regionals: regionaisDaConta }, query, params };
  const res = resFalso();
  let passou = false;
  applyScope(req, res, () => { passou = true; });
  if (!passou) return res;
  await handler(path)(req, res);
  return res;
}

describe('GET /api/saida-nota — escopo por regional (cadeia real)', () => {
  const orig = {};
  let registro;
  beforeEach(() => {
    registro = [];
    orig.getSetting = queries.getSetting;
    orig.getPool = pgShim._getPool;
    queries.getSetting = async () => null;
    pgShim._getPool = () => poolQueFiltra(registro);
  });
  afterEach(() => {
    queries.getSetting = orig.getSetting;
    pgShim._getPool = orig.getPool;
  });

  test('conta do ES não vê a ocorrência de SJC — em nenhuma das 3 consultas', async () => {
    const res = await chamar('/saida-nota', ['GUA', 'CAC'], { query: { de: '2026-10-11', ate: '2026-10-17' } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.ocorrencias.map(o => o.equipe), ['ECGPR53']);
    assert.deepEqual(res.body.cobertura.map(c => c.equipe), ['ECGPR53']);
    assert.equal(registro.length, 3);
    for (const q of registro) assert.doesNotMatch(q.sql, /'GUA'|'CAC'|'SJC'/);
  });

  test('regra em vigor e parâmetros vêm na resposta', async () => {
    const res = await chamar('/saida-nota', ['SJC'], { query: { de: '2026-10-11', ate: '2026-10-17' } });
    assert.equal(res.body.regra.raioM, 500);
    assert.equal(typeof res.body.gseqConfigurado, 'boolean');
  });

  test('período inválido ou maior que 93 dias → 400 sem tocar o banco', async () => {
    assert.equal((await chamar('/saida-nota', ['GUA'], { query: { de: '2026-10-17', ate: '2026-10-11' } })).statusCode, 400);
    assert.equal((await chamar('/saida-nota', ['GUA'], { query: { de: '2026-01-01', ate: '2026-10-11' } })).statusCode, 400);
    assert.equal(registro.length, 0);
  });

  test('detalhe de nota de outra regional responde 404 (não confirma a existência)', async () => {
    const res = await chamar('/saida-nota/nota/:noteId', ['GUA', 'CAC'], { params: { noteId: ID_SJC } });
    assert.equal(res.statusCode, 404);
    const ok = await chamar('/saida-nota/nota/:noteId', ['SJC'], { params: { noteId: ID_SJC } });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.body.equipe, 'ECCSJ82');
  });

  test('id de nota malformado → 400', async () => {
    const res = await chamar('/saida-nota/nota/:noteId', ['GUA'], { params: { noteId: "x' OR 1=1" } });
    assert.equal(res.statusCode, 400);
  });

  test('erro do banco → 500 com mensagem fixa (não vaza err.message)', async () => {
    pgShim._getPool = () => ({ query: async () => { throw new Error('senha=segredo'); } });
    const res = await chamar('/saida-nota', ['GUA'], { query: { de: '2026-10-11', ate: '2026-10-17' } });
    assert.equal(res.statusCode, 500);
    assert.doesNotMatch(JSON.stringify(res.body), /segredo/);
  });
});

describe('montarPainel (puro)', () => {
  const c = (equipe, status, n, regional = 'GUA') => ({ equipe, regional, status, n, placas: ['TDY1C64'] });

  test('KPIs: cobertura sobre concluídas, taxa sobre avaliadas, notas juntas = 1 ocorrência', () => {
    const p = montarPainel(
      [c('A', 'ok', 8), c('A', 'saiu', 2), c('B', 'sem_placa', 10), c('B', 'longe_do_local', 1)],
      [
        { note_id: '1', equipe: 'A', regional: 'GUA', status: 'saiu', ocorrencia_id: 'A|t', min_fora: 30, dist_max_m: 900, inicio: 1, fim: 9 },
        { note_id: '2', equipe: 'A', regional: 'GUA', status: 'saiu', ocorrencia_id: 'A|t', min_fora: 25, dist_max_m: 1200, inicio: 2, fim: 8 },
        { note_id: '3', equipe: 'B', regional: 'GUA', status: 'longe_do_local', ocorrencia_id: 'B|t', dist_max_m: 61000, inicio: 1, fim: 2 },
      ], []);
    assert.equal(p.kpis.concluidas, 21);
    assert.equal(p.kpis.avaliadas, 10);
    assert.equal(p.kpis.pctAvaliadas, 47.6);
    assert.equal(p.kpis.notasSaiu, 2);
    assert.equal(p.kpis.ocorrenciasSaiu, 1);
    assert.equal(p.kpis.pctSaiu, 20);
    assert.equal(p.kpis.ocorrenciasLonge, 1);
    const oc = p.ocorrencias.find(o => o.status === 'saiu');
    assert.equal(oc.notas.length, 2);
    assert.equal(oc.minFora, 30);
    assert.equal(oc.distMaxM, 1200);
  });

  test('cobertura: quem tem mais nota fora da conta vem primeiro, com a sugestão de placa', () => {
    const p = montarPainel([c('A', 'ok', 10), c('B', 'sem_placa', 12)], [],
      [{ equipe: 'B', placa: 'TTR8D24', n: 9 }, { equipe: 'B', placa: 'XYZ1A23', n: 2 }]);
    assert.equal(p.cobertura[0].equipe, 'B');
    assert.equal(p.cobertura[0].foraDaConta, 12);
    assert.deepEqual(p.cobertura[0].sugestao, { placa: 'TTR8D24', notas: 9, pct: 75 });
    assert.equal(p.cobertura[1].pctAvaliadas, 100);
  });

  test('sem nada no período: zeros, sem divisão por zero', () => {
    const p = montarPainel([], [], []);
    assert.equal(p.kpis.concluidas, 0);
    assert.equal(p.kpis.pctAvaliadas, 0);
    assert.equal(p.kpis.pctSaiu, 0);
  });
});
