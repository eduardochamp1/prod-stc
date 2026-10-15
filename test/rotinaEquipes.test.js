/**
 * test/rotinaEquipes.test.js
 *
 * GET /api/rotina/equipes — o "Plano Diário" da aba Rotina (15/10/2026): a
 * rotina de TODAS as equipes do escopo num dia.
 *
 * Cadeia exercitada, toda REAL exceto o pool:
 *   middleware/auth.applyScope → handler da rota → db/rotinaQueries.rotinaEquipes
 *   → pool FALSO que filtra por regional e por `team = ANY(...)` com os
 *   PARÂMETROS recebidos.
 * O que importa: (1) escopo regional — conta do ES não vê SJC, `teams` não
 * amplia; (2) nada de N+1 — o número de consultas não cresce com as equipes;
 * (3) o lote monta a MESMA rotina que a tela de uma equipe.
 */

'use strict';

process.env.NODE_ENV  = 'test';
process.env.DATA_MODE = 'rotina-test';
process.env.JWT_SECRET = 'test-secret-rotina-equipes';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { applyScope } = require('../middleware/auth');
const router = require('../routes/index');
const pgShim = require('../services/pgShim');
const { rotinaEquipe, notasDoDia } = require('../db/rotinaQueries');

const DIA = '2026-09-01';
const cp = (event, hhmm) => ({ event, registradoEm: `${DIA}T${hhmm}:00-03:00` });
const M = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';

const EQUIPES = [
  { sigla: 'ECCAC10', regional: 'CAC', tipo: 'LV' },
  { sigla: 'ECGPR53', regional: 'GUA', tipo: 'LV' },
  { sigla: 'ECCSJ82', regional: 'SJC', tipo: 'LM' },
];

const FONTES = {
  escala: [
    { team: 'ECGPR53', codigo_escala: 'T08', inicio_escala: '08:00:00', fim_escala: '17:00:00' },
    { team: 'ECCAC10', codigo_escala: 'T08', inicio_escala: '08:00:00', fim_escala: '17:00:00' },
    { team: 'ECCSJ82', codigo_escala: 'T08', inicio_escala: '08:00:00', fim_escala: '17:00:00' },
  ],
  sessao: [
    { team: 'ECGPR53', session_begin: `${DIA}T07:50:00`, session_end: `${DIA}T17:10:00` },
    { team: 'ECCAC10', session_begin: `${DIA}T08:00:00`, session_end: `${DIA}T16:00:00` },
    { team: 'ECCSJ82', session_begin: `${DIA}T08:00:00`, session_end: `${DIA}T16:00:00` },
  ],
  snapshot: [
    { team: 'ECGPR53', status: 'concluida', id: UUID_A, numero: '100', tipo: 'MD' },
    { team: 'ECGPR53', status: 'concluida', id: 'nao-e-uuid', numero: '101', tipo: 'MD' },
    { team: 'ECCAC10', status: 'concluida', id: UUID_B, numero: '200', tipo: 'SF' },
    { team: 'ECCSJ82', status: 'concluida', id: UUID_C, numero: '300', tipo: 'MD' },
  ],
  rejeicoes: [{ team: 'ECCAC10', note_id: UUID_B, numero: '200', tipo: 'SF' }],
  interrupcoes: [],
  carteira: [
    { team: 'ECGPR53', carteira_inicial: 5, entradas_novas: 1, atual: 3, andamento: 0, concluidas: 2, rejeitadas: 0, canceladas: 1 },
    { team: 'ECCAC10', carteira_inicial: 4, entradas_novas: 0, atual: 3, andamento: 0, concluidas: 0, rejeitadas: 1, canceladas: 0 },
  ],
  detalhes: [
    { note_id: UUID_A, numero: '100', tipo: 'MD', checkpoints: [cp(0, '08:10'), cp(1, '08:30'), cp(2, '08:35'), cp(3, '09:35')] },
    { note_id: UUID_B, numero: '200', tipo: 'SF', checkpoints: [cp(2, '09:00'), cp(3, '09:20')] },
    { note_id: UUID_C, numero: '300', tipo: 'MD', checkpoints: [cp(2, '10:00'), cp(3, '10:30')] },
  ],
};

/** Pool falso: filtra por regional (IN) e por equipe (ANY) com os parâmetros recebidos. */
function poolFalso(registro) {
  const porTimes = (rows, params) => {
    const arr = params.find(p => Array.isArray(p));
    assert.ok(arr, 'toda consulta por fonte TEM de filtrar por lista de equipes');
    const set = new Set(arr);
    return rows.filter(r => set.has(r.team));
  };
  return {
    async query(sql, params = []) {
      registro.push({ sql, params });
      if (/equipes_oficiais/.test(sql)) {
        const m = sql.match(/regional IN \(([^)]*)\)/);
        assert.ok(m, 'a lista de equipes TEM de filtrar por regional');
        const idx = m[1].split(',').map(p => Number(p.trim().replace('$', '')) - 1);
        const ok = new Set(idx.map(i => params[i]));
        return { rows: EQUIPES.filter(e => ok.has(e.regional)) };
      }
      if (/escala_dia/.test(sql)) return { rows: porTimes(FONTES.escala, params) };
      if (/jsonb_array_elements/.test(sql)) return { rows: porTimes(FONTES.snapshot, params) };
      if (/session_begin IS NOT NULL/.test(sql)) return { rows: porTimes(FONTES.sessao, params) };
      if (/note_rejections/.test(sql)) return { rows: porTimes(FONTES.rejeicoes, params) };
      if (/note_interrupcoes/.test(sql)) return { rows: porTimes(FONTES.interrupcoes, params) };
      if (/team_daily_carteira/.test(sql)) return { rows: porTimes(FONTES.carteira, params) };
      if (/note_details/.test(sql)) {
        const ids = new Set(params[0]);
        return { rows: FONTES.detalhes.filter(d => ids.has(d.note_id)) };
      }
      throw new Error(`consulta inesperada: ${sql.slice(0, 60)}`);
    },
    on() {},
  };
}

function handlerDaRota() {
  const camada = router.stack.find(l => l.route && l.route.path === '/rotina/equipes' && l.route.methods.get);
  assert.ok(camada, 'a rota GET /rotina/equipes tem de existir');
  return camada.route.stack[0].handle;
}

function resFalso() {
  return {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

async function chamar(regionaisDaConta, query = {}) {
  const req = { user: { username: 'x', role: 'user', regionals: regionaisDaConta }, query: { date: DIA, ...query } };
  const res = resFalso();
  let passou = false;
  applyScope(req, res, () => { passou = true; });
  if (!passou) return res;
  await handlerDaRota()(req, res);
  return res;
}

const siglas = res => (res.body.equipes || []).map(e => e.team);

describe('GET /api/rotina/equipes', () => {
  let registro;
  beforeEach(() => {
    registro = [];
    pgShim._setPool(poolFalso(registro));
  });

  test('conta do ES (GUA+CAC) não vê SJC', async () => {
    const res = await chamar(['GUA', 'CAC']);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(siglas(res), ['ECCAC10', 'ECGPR53']);
    assert.deepEqual(res.body.erros, []);
  });

  test('?regionals= de fora do permitido é recusado sem consultar o banco', async () => {
    const res = await chamar(['GUA', 'CAC'], { regionals: 'SJC' });
    assert.equal(res.statusCode, 403);
    assert.equal(registro.length, 0);
  });

  test('teams= recorta, mas nunca amplia o escopo regional', async () => {
    assert.deepEqual(siglas(await chamar(['GUA', 'CAC'], { teams: 'ecgpr53' })), ['ECGPR53']);
    registro.length = 0;
    const fora = await chamar(['GUA', 'CAC'], { teams: 'ECCSJ82' });
    assert.deepEqual(siglas(fora), []);
    assert.equal(registro.length, 1, 'sem equipe no escopo, só a lista de equipes é consultada');
  });

  test('sem N+1: o número de consultas não cresce com as equipes', async () => {
    await chamar(['GUA']);
    const umaEquipe = registro.length;
    registro.length = 0;
    await chamar(['GUA', 'CAC', 'SJC']);
    assert.equal(registro.length, umaEquipe);
    assert.equal(umaEquipe, 8);   // equipes + 6 fontes + note_details
  });

  test('regionais e equipes vão como PARÂMETROS, nunca interpolados', async () => {
    await chamar(['GUA', 'CAC']);
    for (const q of registro) assert.doesNotMatch(q.sql, /'GUA'|'CAC'|'SJC'|ECGPR53|ECCAC10/);
  });

  test('note_details: só checkpoints, só UUIDs, uma consulta pelas notas de todas as equipes', async () => {
    await chamar(['GUA', 'CAC', 'SJC']);
    const det = registro.filter(q => /note_details/.test(q.sql));
    assert.equal(det.length, 1);
    assert.match(det[0].sql, /payload->'checkpoints'/);
    assert.doesNotMatch(det[0].sql, /SELECT[^]*\bpayload\s*,/);
    assert.deepEqual([...det[0].params[0]].sort(), [UUID_A, UUID_B, UUID_C]);
  });

  test('o snapshot não traz o `data` inteiro pro Node', async () => {
    await chamar(['GUA']);
    const snap = registro.find(q => /jsonb_array_elements/.test(q.sql));
    assert.doesNotMatch(snap.sql, /SELECT\s+(s\.)?data\b/);
  });

  test('monta faixas e carteira de cada equipe', async () => {
    const res = await chamar(['GUA', 'CAC']);
    const gua = res.body.equipes.find(e => e.team === 'ECGPR53');
    assert.equal(gua.regional, 'GUA');
    assert.deepEqual(gua.faixas.deslocamento.map(i => [i.ini, i.fim]), [[M('08:10'), M('08:30')]]);
    assert.deepEqual(gua.faixas.servico.map(i => [i.ini, i.fim, i.status]), [[M('08:35'), M('09:35'), 'concluida']]);
    assert.equal(gua.totaisMin.desvio + gua.totaisMin.deslocamento + gua.totaisMin.servico, gua.totaisMin.sessao);
    assert.equal(gua.carteira.executadas, 2);
    assert.equal(gua.carteira.remanejadas, 1);
    assert.equal(gua.carteira.interrompidas, 0);

    const cac = res.body.equipes.find(e => e.team === 'ECCAC10');
    assert.equal(cac.faixas.servico[0].status, 'rejeitada');   // rejeitada > concluída
    assert.equal(cac.carteira.rejeitadas, 1);
  });

  test('o lote monta a MESMA rotina que a tela de uma equipe', async () => {
    const lote = (await chamar(['GUA'])).body.equipes[0];
    const uma = await rotinaEquipe('ECGPR53', DIA);
    const { regional, tipo, ...semMeta } = lote;
    const { erros, ...umaSemErros } = uma;
    assert.deepEqual(semMeta, umaSemErros);
  });

  test('fonte que falha vira aviso, não derruba a lista', async () => {
    const base = poolFalso(registro);
    pgShim._setPool({ ...base, async query(sql, p) {
      if (/note_interrupcoes/.test(sql)) throw new Error('relation does not exist');
      return base.query(sql, p);
    } });
    const res = await chamar(['GUA']);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(siglas(res), ['ECGPR53']);
    assert.match(res.body.erros[0], /^interrupcoes:/);
  });

  test('date inválida → 400', async () => {
    const res = await chamar(['GUA'], { date: '01/09/2026' });
    assert.equal(res.statusCode, 400);
  });
});

test('notasDoDia: primeira lista vence, rejeitada > concluída, interrompida só se nova', () => {
  const m = notasDoDia(
    [{ id: 'a', status: 'concluida', numero: '1' }, { id: 'a', status: 'executada' }, { id: 'b', status: 'executada' }],
    [{ note_id: 'a' }, { note_id: 'c', numero: '3', tipo: 'MD' }],
    [{ note_id: 'b' }, { note_id: 'd', numero: '4' }],
  );
  assert.equal(m.get('a').status, 'rejeitada');
  assert.equal(m.get('a').numero, '1');
  assert.equal(m.get('b').status, 'executada');
  assert.equal(m.get('c').status, 'rejeitada');
  assert.equal(m.get('d').status, 'interrompida');
  assert.equal(m.size, 4);
});
