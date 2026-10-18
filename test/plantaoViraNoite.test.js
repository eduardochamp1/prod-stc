/**
 * test/plantaoViraNoite.test.js  (P2-68, 18/10/2026)
 *
 * Depois das 00:00 BRT o Monitor mostrava "0 em campo" e acusava o plantão
 * noturno (escala 16:00–20:00) de "atrasado +8h": a coleta ao vivo pedia
 * `Sessions/all/date` só com a data de HOJE, e ele não devolve sessão que começou
 * ontem. O teamsstatus/V2 listava as equipes (18/10 00:14 BRT: DESG 0 sessões /
 * 8 entradas V2; DESC 0/10; DSSJ 0/7). Já era assim em 15/10 e 16/10.
 *
 * Correção: equipe no V2 sem sessão de hoje ("órfã") → consulta o dia em que a
 * sessão dela começou → as sessões ABERTAS entram no Monitor, marcadas
 * `sessaoDiaAnterior`. SÓ exibição: fora do `_acc`, do snapshot e dos totais.
 * O que esta suíte trava, em ordem de risco para os números reportados à EDP:
 *   1. nada marcado chega ao snapshot nem ao team_daily_totals;
 *   2. as concluídas do plantão de ontem não entram no `_acc` de hoje;
 *   3. a consulta extra só acontece quando há órfã, e falha nela não derruba o setor.
 */

'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const wpa = require('../services/wpaService');
const { _semSessaoDiaAnterior } = require('../services/cronService');
const { _aggregateTeamDailyTotals } = require('../services/dataWriter');

const HOJE = '2026-10-18';
const ENG = wpa.ENGELMIG_COMPANY_ID;

const sessao = (id, team, begin, extra = {}) => ({
  Id: id, BeginTime: begin, EndTime: null,
  Team: { Id: `t-${team}`, Name: team, CompanyId: ENG }, ...extra,
});
const v2 = (team, begin, extra = {}) => ({
  Session: { Team: { Id: `t-${team}`, Name: team }, BeginTime: begin }, ...extra,
});

// ── 1. Órfãs do V2 ────────────────────────────────────────────────────────────

describe('_orfasV2', () => {
  test('equipe no V2 sem sessão de hoje é órfã, com o dia em que a sessão começou', () => {
    const r = wpa._orfasV2([v2('EPGPR33', '2026-10-17T16:03:00')], [], HOJE);
    assert.deepEqual(r, [{ id: 't-EPGPR33', nome: 'EPGPR33', dia: '2026-10-17' }]);
  });

  test('equipe com sessão de hoje NÃO é órfã — inclusive de outra empresa', () => {
    // O V2 não traz CompanyId: a comparação é com TODAS as sessões de hoje.
    const outra = sessao('s9', 'PPGPR03', '2026-10-18T06:00:00');
    outra.Team.CompanyId = 'outra-empresa';
    const r = wpa._orfasV2(
      [v2('PPGPR03', '2026-10-18T06:00:00'), v2('EPGPR30', '2026-10-18T07:00:00')],
      [outra, sessao('s1', 'EPGPR30', '2026-10-18T07:00:00')], HOJE);
    assert.deepEqual(r, []);
  });

  test('casa por nome quando o Id não vem', () => {
    const item = { Session: { Team: { Name: 'EPGPR30' }, BeginTime: '2026-10-17T19:53:00' } };
    const hoje = { Id: 's1', BeginTime: '2026-10-18T07:00:00', Team: { Name: 'EPGPR30' } };
    assert.deepEqual(wpa._orfasV2([item], [hoje], HOJE), []);
  });

  test('sem BeginTime usa o SessionBegin; sem data legível assume ontem', () => {
    const r = wpa._orfasV2([
      { Session: { Team: { Id: 't-A', Name: 'A' } }, SessionBegin: '2026-10-16T20:00:00' },
      { Session: { Team: { Id: 't-B', Name: 'B' } } },
      // re-checkin hoje numa sessão física antiga: a data de hoje não serve
      { Session: { Team: { Id: 't-C', Name: 'C' } }, SessionBegin: '2026-10-18T00:10:00' },
    ], [], HOJE);
    assert.deepEqual(r.map(o => o.dia), ['2026-10-16', '2026-10-17', '2026-10-17']);
  });

  test('sessão mais velha que o limite não é procurada', () => {
    // ETGPR22 do print de 18/10 está aberta desde 13/10 (5 dias): dentro do limite.
    const r = wpa._orfasV2([
      v2('ETGPR22', '2026-10-13T07:46:00'),
      v2('VELHA', '2026-10-01T07:00:00'),
    ], [], HOJE);
    assert.deepEqual(r.map(o => o.nome), ['ETGPR22']);
  });

  test('item do V2 sem equipe identificável é ignorado', () => {
    assert.deepEqual(wpa._orfasV2([{}, { Session: {} }, null], [], HOJE), []);
  });
});

// ── 2. Quais sessões de dia anterior entram ──────────────────────────────────

describe('_sessoesAbertasDasOrfas', () => {
  const orfas = [{ id: 't-EPGPR33', nome: 'EPGPR33', dia: '2026-10-17' }];

  test('entra só a sessão ABERTA, de antes de hoje, de equipe órfã', () => {
    const r = wpa._sessoesAbertasDasOrfas([
      sessao('a', 'EPGPR33', '2026-10-17T16:03:00'),                                   // entra
      sessao('b', 'EPGPR33', '2026-10-17T07:00:00', { EndTime: '2026-10-17T15:00:00' }), // encerrada
      sessao('c', 'OUTRA',   '2026-10-17T16:00:00'),                                   // não é órfã
      sessao('d', 'EPGPR33', '2026-10-18T00:30:00'),                                   // é de hoje
      sessao('e', 'EPGPR33', null),                                                    // sem início
    ], orfas, [], HOJE);
    assert.deepEqual(r.map(s => s.Id), ['a']);
  });

  test('sessão que já veio na resposta de hoje não entra de novo (dedup por Id)', () => {
    const s = sessao('a', 'EPGPR33', '2026-10-17T16:03:00');
    assert.deepEqual(wpa._sessoesAbertasDasOrfas([s, { ...s }], orfas, [s], HOJE), []);
    assert.equal(wpa._sessoesAbertasDasOrfas([s, { ...s }], orfas, [], HOJE).length, 1);
  });
});

// ── 3. Custo e falha da consulta extra ────────────────────────────────────────

describe('_buscarSessoesAbertasAnteriores', () => {
  const silencio = fn => async (...a) => {
    const { log, warn } = console;
    console.log = () => {}; console.warn = () => {};
    try { return await fn(...a); } finally { console.log = log; console.warn = warn; }
  };

  test('sem órfã no V2 não faz nenhuma consulta (horário sem plantão noturno)', silencio(async () => {
    let chamadas = 0;
    const r = await wpa._buscarSessoesAbertasAnteriores('DESG',
      [sessao('s1', 'EPGPR30', '2026-10-18T07:00:00')],
      [v2('EPGPR30', '2026-10-18T07:00:00')], HOJE,
      async () => { chamadas++; return []; });
    assert.equal(chamadas, 0);
    assert.deepEqual(r, []);
  }));

  test('uma consulta por dia distinto, os mais recentes, no máximo 3', silencio(async () => {
    const pedidos = [];
    await wpa._buscarSessoesAbertasAnteriores('DESG', [], [
      v2('A', '2026-10-17T16:00:00'), v2('B', '2026-10-17T20:00:00'),
      v2('C', '2026-10-16T16:00:00'), v2('D', '2026-10-15T16:00:00'),
      v2('E', '2026-10-13T07:46:00'),
    ], HOJE, async (setor, dia) => { pedidos.push(`${setor} ${dia}`); return []; });
    assert.deepEqual(pedidos, ['DESG 2026-10-17', 'DESG 2026-10-16', 'DESG 2026-10-15']);
  }));

  test('devolve as abertas do plantão de ontem', silencio(async () => {
    const r = await wpa._buscarSessoesAbertasAnteriores('DESG', [],
      [v2('EPGPR33', '2026-10-17T16:03:00')], HOJE,
      async () => [
        sessao('a', 'EPGPR33', '2026-10-17T16:03:00'),
        sessao('b', 'EPGPR33', '2026-10-17T07:00:00', { EndTime: '2026-10-17T15:00:00' }),
      ]);
    assert.deepEqual(r.map(s => s.Id), ['a']);
  }));

  test('falha na consulta extra NÃO lança: o setor segue com as sessões de hoje', silencio(async () => {
    const r = await wpa._buscarSessoesAbertasAnteriores('DESG', [],
      [v2('EPGPR33', '2026-10-17T16:03:00')], HOJE,
      async () => { throw new Error('WPA sessions/date 500'); });
    assert.deepEqual(r, []);
  }));
});

// ── 4. Acumulador: o plantão de ontem não vira produção de hoje ───────────────

describe('_accAplicarDoDia', () => {
  beforeEach(() => { wpa._acc.notes.clear(); wpa._acc.carteiras.clear(); });

  const nota = id => ({ id, codigo: id, tipoCode: 'LN', tipoNome: 'LN', status: 'concluida' });
  const eq = (extra) => ({
    teamName: 'EPGPR33', regional: 'GUA', sessionEnd: null,
    notasBaixadas: [], notasExecutadas: [], notasConcluidas: [], notasRejeitadas: [], ...extra,
  });

  test('concluídas da sessão de ontem não entram no _acc', () => {
    const ontem = eq({ sessaoDiaAnterior: true, notasConcluidas: [nota('N1')] });
    const out = wpa._accAplicarDoDia([ontem]);
    assert.equal(wpa._acc.notes.size, 0);
    assert.equal(wpa._acc.carteiras.size, 0);
    assert.equal(out.length, 1);
    assert.strictEqual(out[0], ontem, 'passa intacta, sem carteiraInicialCount do dia');
  });

  test('a sessão de HOJE da mesma sigla não recebe as concluídas do plantão de ontem', () => {
    // Plantão de ontem ainda aberto + a equipe já relogou hoje (sessão nova).
    wpa._accAplicarDoDia([eq({ sessaoDiaAnterior: true, notasConcluidas: [nota('N1')] })]);
    const out = wpa._accAplicarDoDia([
      eq({ sessaoDiaAnterior: true, notasConcluidas: [nota('N1')] }),
      eq({ notasConcluidas: [nota('N2')] }),
    ]);
    const deHoje = out.find(t => !t.sessaoDiaAnterior);
    assert.deepEqual(deHoje.notasConcluidas.map(n => n.id), ['N2']);
    assert.deepEqual([...wpa._acc.notes.keys()], ['N2']);
  });

  test('sem sessão de dia anterior, é o mesmo que _accRecord + _accApply', () => {
    const t = eq({ notasConcluidas: [nota('N2')] });
    const out = wpa._accAplicarDoDia([t]);
    assert.equal(out.length, 1);
    assert.equal(out[0].carteiraInicialCount, 1);
    assert.deepEqual([...wpa._acc.notes.keys()], ['N2']);
  });
});

// ── 5. Snapshot e totais: nada marcado é persistido ──────────────────────────

describe('_semSessaoDiaAnterior (runSnapshot)', () => {
  test('tira as sessões de dia anterior e mantém o resto, ghosts inclusive', () => {
    const r = _semSessaoDiaAnterior([
      { teamName: 'A', sessaoDiaAnterior: true },
      { teamName: 'B', sessaoDiaAnterior: false },
      { teamName: 'C' },
      { teamName: 'D', _ghostFromAcc: true },
    ]);
    assert.deepEqual(r.map(t => t.teamName), ['B', 'C', 'D']);
  });

  test('a linha de ONTEM no team_daily_totals não é reescrita pela visão parcial', () => {
    // Sem o filtro, a sessão de ontem coletada à 00:30 geraria a linha
    // (2026-10-17, EPGPR33, LN) com a contagem de UMA sessão só, e o upsert
    // intraday sobrescreveria o valor consolidado do dia 17 (família do P2-13).
    const coletadas = [
      { teamName: 'EPGPR33', regional: 'GUA', sectorId: 'DESG', sessaoDiaAnterior: true,
        sessionBegin: '2026-10-17T16:03:00',
        notasConcluidas: [{ id: 'N1', tipoCode: 'LN' }], notasRejeitadas: [] },
      { teamName: 'EPGPR30', regional: 'GUA', sectorId: 'DESG',
        sessionBegin: '2026-10-18T07:00:00',
        notasConcluidas: [{ id: 'N2', tipoCode: 'LN' }], notasRejeitadas: [] },
    ];
    const rows = _aggregateTeamDailyTotals(_semSessaoDiaAnterior(coletadas));
    assert.deepEqual(rows.map(r => `${r.date}|${r.team_name}|${r.count}`), ['2026-10-18|EPGPR30|1']);
  });
});
