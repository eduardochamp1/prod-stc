/**
 * test/alertaBacktest.test.js
 *
 * Núcleo PURO do backtest do alerta de produtividade (T8): reconstrói o estado de
 * uma equipe no meio do turno a partir de snapshots, simula os ciclos de 15 min
 * com a MESMA `avaliarEquipe` do alerta real (nunca uma cópia da regra) e resume
 * por dia e categoria. O I/O fica no script e não é testado aqui.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const B = require('../services/alertaBacktest');
const { instanteBRT } = require('../services/timeUtil');

const hm = (h, m = 0) => h * 60 + m;
const DIA = '2026-10-14';
const CFG = { ativo: true, limite: 4, categorias: ['COMERCIAL', 'PLANTAO', 'MOTO', 'BT_ZERO'], tolerancia_refeicao_min: 60 };
const em = (h, m = 0) => instanteBRT(DIA, hm(h, m));
const snap = (h, m, conc, rej = [], sessionEnd = null) => ({ capturedAtMs: em(h, m), sessionEnd, conc, rej });

describe('ciclosDoDia', () => {
  test('primeiro ciclo no/depois do meio, de 15 em 15, até antes do fim', () => {
    assert.deepEqual(B.ciclosDoDia(hm(12, 30), hm(13, 30)), [hm(12, 30), hm(12, 45), hm(13, 0), hm(13, 15)]);
  });
  test('meio fora da grade sobe pro próximo quarto de hora', () => {
    assert.equal(B.ciclosDoDia(hm(12, 31), hm(17))[0], hm(12, 45));
    assert.equal(B.ciclosDoDia(hm(12, 46), hm(17))[0], hm(13, 0));
  });
  test('turno inválido → nenhum ciclo', () => {
    assert.deepEqual(B.ciclosDoDia(hm(17), hm(8)), []);
  });
});

describe('estadoEm — reconstrói o estado no instante', () => {
  const snaps = [snap(9, 0, ['a']), snap(11, 0, ['a', 'b', 'c'], ['c']), snap(14, 0, ['a', 'b', 'c', 'd', 'e'], ['c'])];

  test('usa o ÚLTIMO snapshot até o instante, não o futuro', () => {
    const e = B.estadoEm(snaps, em(12, 30));
    assert.equal(e.executadas, 2, 'a,b,c menos a rejeitada c');
    assert.equal(e.rejeitadas, 1);
  });
  test('rejeitada > concluída: a nota que está nas duas conta só como rejeitada', () => {
    const e = B.estadoEm([snap(10, 0, ['x', 'y'], ['x', 'y'])], em(12));
    assert.equal(e.executadas, 0);
    assert.equal(e.rejeitadas, 2);
  });
  test('UNIÃO por id entre snapshots (relogin não conta a mesma nota 2×)', () => {
    const e = B.estadoEm([snap(9, 0, ['a', 'b']), snap(10, 0, ['b', 'c'])], em(12));
    assert.equal(e.executadas, 3);
  });
  test('nenhum snapshot até o instante → null (equipe ainda não tinha logado)', () => {
    assert.equal(B.estadoEm(snaps, em(8, 0)), null);
    assert.equal(B.estadoEm([], em(12)), null);
  });
  test('sessão aberta lida do ÚLTIMO snapshot até o instante', () => {
    assert.equal(B.estadoEm([snap(9, 0, ['a'])], em(12)).sessaoAberta, true);
    assert.equal(B.estadoEm([snap(9, 0, ['a']), snap(11, 0, ['a'], [], '2026-10-14T11:00:00')], em(12)).sessaoAberta, false);
    assert.equal(B.estadoEm([snap(9, 0, ['a'], [], '')], em(12)).sessaoAberta, true, 'string vazia = aberta');
  });
  test('tolera ids nulos/ausentes sem estourar', () => {
    const e = B.estadoEm([{ capturedAtMs: em(9), sessionEnd: null, conc: null, rej: undefined }], em(12));
    assert.equal(e.executadas, 0);
  });
});

describe('emRefeicaoEm — intervalo cobrindo o instante (hora de parede BRT)', () => {
  const ints = [{ motivo: '15 - Horário de Refeição', inicio: '2026-10-14T12:00:00', fim: '2026-10-14T13:00:00' }];
  test('dentro do intervalo → true; antes e depois → false', () => {
    assert.equal(B.emRefeicaoEm(ints, '2026-10-14T12:30:00'), true);
    assert.equal(B.emRefeicaoEm(ints, '2026-10-14T11:59:59'), false);
    assert.equal(B.emRefeicaoEm(ints, '2026-10-14T13:00:00'), false, 'o fim é exclusivo');
  });
  test('sem fim (em aberto) cobre tudo dali em diante', () => {
    assert.equal(B.emRefeicaoEm([{ motivo: 'Refeição', inicio: '2026-10-14T12:00:00', fim: null }], '2026-10-14T16:00:00'), true);
  });
  test('outro motivo não conta; lista vazia/nula → false', () => {
    assert.equal(B.emRefeicaoEm([{ motivo: 'Callback', inicio: '2026-10-14T12:00:00', fim: null }], '2026-10-14T12:30:00'), false);
    assert.equal(B.emRefeicaoEm([], '2026-10-14T12:30:00'), false);
    assert.equal(B.emRefeicaoEm(null, '2026-10-14T12:30:00'), false);
  });
  test('paradeBRT formata o instante como hora de parede BRT', () => {
    assert.equal(B.paredeBRT(em(12, 30)), '2026-10-14T12:30:00');
  });
});

describe('simularEquipeDia', () => {
  const base = (o = {}) => ({
    data: DIA, categoria: 'COMERCIAL', escala: { inicio: '08:00', fim: '17:00' },
    config: CFG, comRefeicao: true, intervalos: [], snaps: [], ...o,
  });

  test('abaixo do limite no meio do turno → alertaria no 1º ciclo', () => {
    const r = B.simularEquipeDia(base({ snaps: [snap(9, 0, ['a', 'b'])] }));
    assert.equal(r.resultado, 'alertaria');
    assert.equal(r.cicloMin, hm(12, 30));
    assert.equal(r.executadasNoCiclo, 2);
  });
  test('já no limite no meio do turno → não alertaria', () => {
    const r = B.simularEquipeDia(base({ snaps: [snap(9, 0, ['a', 'b', 'c', 'd'])] }));
    assert.equal(r.resultado, 'nao_alertaria');
    assert.equal(r.executadasNoMeio, 4);
  });
  test('em refeição no 1º ciclo adia e alerta no primeiro ciclo FORA do almoço', () => {
    const r = B.simularEquipeDia(base({
      snaps: [snap(9, 0, ['a'])],
      intervalos: [{ motivo: 'Horário de Refeição', inicio: `${DIA}T12:00:00`, fim: `${DIA}T13:00:00` }],
    }));
    assert.equal(r.resultado, 'alertaria');
    assert.equal(r.cicloMin, hm(13, 0));
  });
  test('sem o adiamento (--sem-refeicao) alerta no 1º ciclo mesmo almoçando', () => {
    const r = B.simularEquipeDia(base({
      comRefeicao: false, snaps: [snap(9, 0, ['a'])],
      intervalos: [{ motivo: 'Horário de Refeição', inicio: `${DIA}T12:00:00`, fim: `${DIA}T13:00:00` }],
    }));
    assert.equal(r.cicloMin, hm(12, 30));
  });
  test('chega ao limite DEPOIS do disparo → alertaria e "resolveu depois"', () => {
    const r = B.simularEquipeDia(base({ snaps: [snap(9, 0, ['a']), snap(15, 0, ['a', 'b', 'c', 'd', 'e'])] }));
    assert.equal(r.resultado, 'alertaria');
    assert.equal(r.resolveuDepois, true);
    assert.equal(r.executadasFimDia, 5);
  });
  test('nunca chega ao limite → alertaria e NÃO resolve', () => {
    const r = B.simularEquipeDia(base({ snaps: [snap(9, 0, ['a']), snap(15, 0, ['a', 'b'])] }));
    assert.equal(r.resolveuDepois, false);
  });
  test('sem escala e vira-noite → ignorada, com o motivo', () => {
    assert.deepEqual(
      (({ resultado, motivo }) => ({ resultado, motivo }))(B.simularEquipeDia(base({ escala: { inicio: null, fim: null }, snaps: [snap(9, 0, [])] }))),
      { resultado: 'ignorada', motivo: 'sem_escala' });
    assert.equal(B.simularEquipeDia(base({ escala: { inicio: '22:00', fim: '07:00' }, snaps: [snap(9, 0, [])] })).motivo, 'vira_noite');
  });
  test('categoria fora da config → ignorada (nem entra na conta)', () => {
    const r = B.simularEquipeDia(base({ categoria: 'OPERACIONAL', snaps: [snap(9, 0, [])] }));
    assert.equal(r.resultado, 'ignorada');
    assert.equal(r.motivo, 'categoria_fora');
  });
  test('equipe sem snapshot até o meio do turno → ignorada (não logou ainda)', () => {
    const r = B.simularEquipeDia(base({ snaps: [snap(14, 0, ['a'])] }));
    assert.equal(r.resultado, 'ignorada');
    assert.equal(r.motivo, 'sem_sessao_no_meio');
  });
  test('sessão já encerrada no meio do turno → ignorada', () => {
    const r = B.simularEquipeDia(base({ snaps: [snap(9, 0, ['a'], [], `${DIA}T11:00:00`)] }));
    assert.equal(r.resultado, 'ignorada');
    assert.equal(r.motivo, 'sem_sessao_no_meio');
  });
  test('usa a MESMA regra do alerta real: limite configurável muda o resultado', () => {
    const snaps = [snap(9, 0, ['a', 'b', 'c', 'd', 'e'])];
    assert.equal(B.simularEquipeDia(base({ snaps })).resultado, 'nao_alertaria');
    assert.equal(B.simularEquipeDia(base({ snaps, config: { ...CFG, limite: 6 } })).resultado, 'alertaria');
  });
});

describe('resumir', () => {
  const r = (data, categoria, resultado, extra = {}) => ({ data, categoria, resultado, executadasNoMeio: 0, ...extra });

  test('agrega por dia e categoria; % = alertaria / avaliadas (ignoradas ficam fora)', () => {
    const s = B.resumir([
      r('2026-10-13', 'COMERCIAL', 'alertaria'), r('2026-10-13', 'COMERCIAL', 'nao_alertaria'),
      r('2026-10-13', 'COMERCIAL', 'nao_alertaria'), r('2026-10-13', 'COMERCIAL', 'nao_alertaria'),
      r('2026-10-13', 'MOTO', 'alertaria'),
      r('2026-10-13', 'MOTO', 'ignorada', { motivo: 'sem_escala', equipe: 'ETX' }),
    ]);
    const com = s.porDiaCategoria.find(x => x.data === '2026-10-13' && x.categoria === 'COMERCIAL');
    assert.equal(com.avaliadas, 4);
    assert.equal(com.alertariam, 1);
    assert.equal(com.pct, 25);
    const moto = s.porDiaCategoria.find(x => x.categoria === 'MOTO');
    assert.equal(moto.avaliadas, 1, 'a ignorada não entra no denominador');
    assert.equal(moto.pct, 100);
  });
  test('total, média diária e distribuição de executadas no meio', () => {
    const s = B.resumir([
      r('d1', 'COMERCIAL', 'alertaria', { executadasNoMeio: 0 }), r('d1', 'COMERCIAL', 'nao_alertaria', { executadasNoMeio: 7 }),
      r('d2', 'COMERCIAL', 'alertaria', { executadasNoMeio: 2 }), r('d2', 'COMERCIAL', 'nao_alertaria', { executadasNoMeio: 9 }),
    ]);
    assert.equal(s.total.avaliadas, 4);
    assert.equal(s.total.alertariam, 2);
    assert.equal(s.total.pct, 50);
    assert.equal(s.mediaPctDiaria, 50);
    assert.deepEqual(s.distribuicao, { 0: 1, 1: 0, 2: 1, 3: 0, '4+': 2 });
  });
  test('ignoradas são contadas à parte por motivo, com as equipes', () => {
    const s = B.resumir([
      r('d1', 'COMERCIAL', 'ignorada', { motivo: 'sem_escala', equipe: 'ECA' }),
      r('d1', 'COMERCIAL', 'ignorada', { motivo: 'sem_escala', equipe: 'ECB' }),
      r('d2', 'COMERCIAL', 'ignorada', { motivo: 'sem_escala', equipe: 'ECA' }),
      r('d1', 'MOTO', 'ignorada', { motivo: 'vira_noite', equipe: 'ETC' }),
    ]);
    assert.deepEqual(s.ignoradas.sem_escala, { ocorrencias: 3, equipes: ['ECA', 'ECB'] });
    assert.deepEqual(s.ignoradas.vira_noite, { ocorrencias: 1, equipes: ['ETC'] });
  });
  test('"resolveu depois" é contado só entre os que alertariam', () => {
    const s = B.resumir([
      r('d1', 'COMERCIAL', 'alertaria', { resolveuDepois: true }),
      r('d1', 'COMERCIAL', 'alertaria', { resolveuDepois: false }),
      r('d1', 'COMERCIAL', 'nao_alertaria', { resolveuDepois: false }),
    ]);
    assert.equal(s.total.resolveramDepois, 1);
  });
  test('entrada vazia não estoura e não divide por zero', () => {
    const s = B.resumir([]);
    assert.equal(s.total.avaliadas, 0);
    assert.equal(s.total.pct, 0);
    assert.equal(s.mediaPctDiaria, 0);
  });
});

describe('veredito — ajuda a ler, não decide por você', () => {
  test('faixas: < 10% ok, 10–25% atenção, >= 25% NÃO ligar', () => {
    assert.match(B.veredito(4), /razo/i);
    assert.match(B.veredito(15), /aten/i);
    assert.match(B.veredito(25), /N[ÃA]O LIGAR/);
    assert.match(B.veredito(60), /N[ÃA]O LIGAR/);
  });
  test('sem dados → avisa em vez de dar veredito', () => {
    assert.match(B.veredito(null), /sem dados/i);
  });
});

describe('montarSnapsPorEquipe — linhas do banco → snapshots da simulação', () => {
  test('agrupa por equipe, ordena por captured_at e normaliza os ids', () => {
    const rows = [
      { team_name: 'ECGPR53', captured_at: new Date(em(11)), session_end: null, conc: ['a', 'b'], rej: ['b'] },
      { team_name: 'ECGPR53', captured_at: new Date(em(9)), session_end: null, conc: ['a'], rej: null },
      { team_name: 'ETGPR16', captured_at: new Date(em(10)).toISOString(), session_end: '', conc: [], rej: [] },
    ];
    const m = B.montarSnapsPorEquipe(rows);
    assert.deepEqual([...m.keys()].sort(), ['ECGPR53', 'ETGPR16']);
    const a = m.get('ECGPR53');
    assert.deepEqual(a.map(s => s.capturedAtMs), [em(9), em(11)], 'ordenado');
    assert.deepEqual(a[1].conc, ['a', 'b']);
    assert.deepEqual(a[0].rej, [], 'null vira lista vazia');
    assert.equal(m.get('ETGPR16')[0].capturedAtMs, em(10), 'aceita ISO string');
  });
});
