/**
 * test/alertasEscopo.test.js
 *
 * ESCOPO POR REGIONAL do GET /api/alertas/produtividade, de ponta a ponta sem
 * Postgres (lacuna da T6 apontada na revisão de 14/10/2026: antes só havia teste
 * de FONTE dizendo que a rota passa `req.scope.regionals` adiante).
 *
 * Cadeia exercitada, toda REAL exceto o pool:
 *   middleware/auth.applyScope  →  handler da rota (routes/index.js)
 *   →  db/alertasQueries.listarAtivos (SQL real, com inRegionalsSql)
 *   →  pool FALSO que aplica o `regional IN (...)` com os PARÂMETROS recebidos.
 * Se a rota deixasse de passar o escopo, ou a consulta montasse o IN errado, uma
 * conta veria alerta de outra regional — e este teste quebra.
 *
 * Roda num processo próprio (node --test isola por arquivo): o DATA_MODE abaixo
 * precisa estar definido ANTES de carregar as rotas, senão o `sbq()` fica em mock.
 */

'use strict';

process.env.NODE_ENV  = 'test';
process.env.DATA_MODE = 'escopo-test';   // qualquer coisa ≠ 'mock' liga o caminho com banco
process.env.JWT_SECRET = 'test-secret-escopo';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { applyScope } = require('../middleware/auth');
const router = require('../routes/index');
const queries = require('../db/queries');
const pgShim = require('../services/pgShim');

const ALERTAS = [
  { team_name: 'ECGPR53', regional: 'GUA', supervisor: 'A', limite: 4, escala_inicio: '08:00', escala_fim: '17:00',
    meio_turno_em: '2026-10-14T15:30:00Z', disparado_em: '2026-10-14T15:31:00Z', executadas_disparo: 1, executadas_atual: 1, rejeitadas: 0 },
  { team_name: 'ECCAC10', regional: 'CAC', supervisor: 'B', limite: 4, escala_inicio: '08:00', escala_fim: '17:00',
    meio_turno_em: '2026-10-14T15:30:00Z', disparado_em: '2026-10-14T15:32:00Z', executadas_disparo: 2, executadas_atual: 2, rejeitadas: 0 },
  { team_name: 'ECCSJ82', regional: 'SJC', supervisor: 'C', limite: 4, escala_inicio: '08:00', escala_fim: '17:00',
    meio_turno_em: '2026-10-14T15:30:00Z', disparado_em: '2026-10-14T15:33:00Z', executadas_disparo: 0, executadas_atual: 0, rejeitadas: 1 },
];

/** Handler REAL da rota, tirado da pilha do router do Express. */
function handlerDaRota() {
  const camada = router.stack.find(l => l.route && l.route.path === '/alertas/produtividade' && l.route.methods.get);
  assert.ok(camada, 'a rota GET /alertas/produtividade tem de existir');
  return camada.route.stack[0].handle;
}

/** Pool falso: aplica o `regional IN ($2,$3…)` usando os parâmetros que RECEBEU. */
function poolQueFiltra(registro) {
  return {
    async query(sql, params) {
      registro.push({ sql, params });
      const m = sql.match(/regional IN \(([^)]*)\)/);
      assert.ok(m, 'a consulta TEM de filtrar por regional');
      const idx = m[1].split(',').map(p => Number(p.trim().replace('$', '')) - 1);
      const permitidas = new Set(idx.map(i => params[i]));
      return { rows: ALERTAS.filter(a => permitidas.has(a.regional)) };
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

/** Roda applyScope + handler como o Express rodaria. */
async function chamar(regionaisDaConta, query = {}) {
  const req = { user: { username: 'x', role: 'user', regionals: regionaisDaConta }, query };
  const res = resFalso();
  let passou = false;
  applyScope(req, res, () => { passou = true; });
  if (!passou) return res;                       // o middleware já respondeu (401/403)
  await handlerDaRota()(req, res);
  return res;
}

const equipes = (res) => (res.body.alertas || []).map(a => a.equipe).sort();

describe('GET /api/alertas/produtividade — escopo por regional (cadeia real)', () => {
  const orig = {};
  let registro;

  beforeEach(() => {
    registro = [];
    orig.getSetting = queries.getSetting;
    orig.getPool = pgShim._getPool;
    queries.getSetting = async (k) => (k === 'alerta_produtividade' ? { data: { ativo: true } } : null);
    pgShim._getPool = () => poolQueFiltra(registro);
  });
  afterEach(() => {
    queries.getSetting = orig.getSetting;
    pgShim._getPool = orig.getPool;
  });

  test('conta do ES (GUA+CAC) NÃO vê o alerta de SJC', async () => {
    const res = await chamar(['GUA', 'CAC']);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ativo, true);
    assert.deepEqual(equipes(res), ['ECCAC10', 'ECGPR53']);
  });
  test('conta de SJC só vê SJC', async () => {
    assert.deepEqual(equipes(await chamar(['SJC'])), ['ECCSJ82']);
  });
  test('conta com as três regionais vê tudo', async () => {
    assert.deepEqual(equipes(await chamar(['GUA', 'CAC', 'SJC'])), ['ECCAC10', 'ECCSJ82', 'ECGPR53']);
  });
  test('?regionals= estreita dentro do permitido (ES pedindo só GUA)', async () => {
    assert.deepEqual(equipes(await chamar(['GUA', 'CAC'], { regionals: 'GUA' })), ['ECGPR53']);
  });
  test('?regionals= de fora do permitido é RECUSADO (ES pedindo SJC → 403), sem consultar o banco', async () => {
    const res = await chamar(['GUA', 'CAC'], { regionals: 'SJC' });
    assert.equal(res.statusCode, 403);
    assert.equal(registro.length, 0);
  });
  test('?regionals= misturado: o que não é permitido some em silêncio (ES pedindo GUA,SJC → só GUA)', async () => {
    assert.deepEqual(equipes(await chamar(['GUA', 'CAC'], { regionals: 'GUA,SJC' })), ['ECGPR53']);
  });
  test('a consulta recebe as regionais da CONTA como parâmetros (não interpoladas no SQL)', async () => {
    await chamar(['GUA', 'CAC']);
    const q = registro[0];
    assert.deepEqual(q.params.slice(1), ['GUA', 'CAC']);
    assert.doesNotMatch(q.sql, /'GUA'|'CAC'|'SJC'/);
  });
  test('desligado → { ativo:false } e a tabela de alertas NEM é consultada', async () => {
    queries.getSetting = async () => ({ data: { ativo: false } });
    const res = await chamar(['GUA', 'CAC', 'SJC']);
    assert.deepEqual(res.body, { ativo: false, alertas: [] });
    assert.equal(registro.length, 0);
  });
  test('config inválida → tratada como desligada (nunca liga por engano)', async () => {
    queries.getSetting = async () => ({ data: { ativo: true, limite: 0 } });
    const res = await chamar(['GUA']);
    assert.deepEqual(res.body, { ativo: false, alertas: [] });
  });
  test('erro do banco → 500 com mensagem FIXA (não vaza err.message)', async () => {
    pgShim._getPool = () => ({ async query() { throw new Error('senha do banco xyz incorreta'); } });
    const res = await chamar(['GUA']);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: 'Falha ao ler os avisos' });
  });
});
