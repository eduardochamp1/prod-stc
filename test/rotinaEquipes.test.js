/**
 * test/rotinaEquipes.test.js
 *
 * O carregador da aba Rotina (db/rotinaQueries._carregarLote via rotinaEquipe)
 * com um pool FALSO que filtra por `team = ANY(...)` com os PARÂMETROS
 * recebidos. Nasceu para o "Plano Diário" (15/10/2026), que saiu da tela no
 * mesmo dia ("ficou confusa"); o carregador em lote ficou — é o mesmo da tela
 * de uma equipe.
 */

'use strict';

process.env.NODE_ENV  = 'test';
process.env.DATA_MODE = 'rotina-test';
process.env.JWT_SECRET = 'test-secret-rotina-equipes';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

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
  // sessao_intervalo, já como sai do SQL (to_char da parede, sem fuso).
  desvios: [
    { team: 'ECGPR53', session_id: 'S1', motivo: '15 - Horário de Refeição', responsavel: 'Equipe',
      inicio: `${DIA}T12:00:00`, fim: `${DIA}T13:00:00` },
  ],
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
      if (/sessao_intervalo/.test(sql)) return { rows: porTimes(FONTES.desvios, params) };
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

describe('carregador da rotina (rotinaEquipe)', () => {
  let registro;
  beforeEach(() => {
    registro = [];
    pgShim._setPool(poolFalso(registro));
  });

  test('número fixo de consultas, equipe e dia como PARÂMETROS', async () => {
    await rotinaEquipe('ECGPR53', DIA);
    assert.equal(registro.length, 8);   // 7 fontes + note_details
    for (const c of registro) assert.doesNotMatch(c.sql, /ECGPR53|2026-09-01/);
  });

  test('note_details: só checkpoints, só UUIDs', async () => {
    await rotinaEquipe('ECGPR53', DIA);
    const det = registro.filter(c => /note_details/.test(c.sql));
    assert.equal(det.length, 1);
    assert.match(det[0].sql, /payload->'checkpoints'/);
    assert.doesNotMatch(det[0].sql, /SELECT[^]*\bpayload\s*,/);
    assert.deepEqual([...det[0].params[0]], [UUID_A]);   // 'nao-e-uuid' fica fora
  });

  test('o snapshot não traz o `data` inteiro pro Node', async () => {
    await rotinaEquipe('ECGPR53', DIA);
    const snap = registro.find(c => /jsonb_array_elements/.test(c.sql));
    assert.doesNotMatch(snap.sql, /SELECT\s+(s\.)?data\b/);
  });

  test('monta faixas, desvio apontado e carteira', async () => {
    const gua = await rotinaEquipe('ECGPR53', DIA);
    assert.deepEqual(gua.faixas.deslocamento.map(i => [i.ini, i.fim]), [[M('08:10'), M('08:30')]]);
    assert.deepEqual(gua.faixas.servico.map(i => [i.ini, i.fim, i.status]), [[M('08:35'), M('09:35'), 'concluida']]);
    // Desvio = parada APONTADA (sessao_intervalo), não o buraco entre apontamentos.
    assert.deepEqual(gua.faixas.desvio.map(i => [i.ini, i.fim, i.motivo]),
      [[M('12:00'), M('13:00'), '15 - Horário de Refeição']]);
    assert.equal(gua.carteira.executadas, 2);
    assert.equal(gua.carteira.remanejadas, 1);
    assert.equal(gua.carteira.interrompidas, 0);

    const cac = await rotinaEquipe('ECCAC10', DIA);
    assert.equal(cac.faixas.servico[0].status, 'rejeitada');   // rejeitada > concluída
    assert.equal(cac.carteira.rejeitadas, 1);
  });

  test('fonte que falha vira aviso, não derruba a tela', async () => {
    const base = poolFalso(registro);
    pgShim._setPool({ ...base, async query(sql, p) {
      if (/note_interrupcoes/.test(sql)) throw new Error('relation does not exist');
      return base.query(sql, p);
    } });
    const r = await rotinaEquipe('ECGPR53', DIA);
    assert.ok(r.faixas);
    assert.match(r.erros[0], /^interrupcoes:/);
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
