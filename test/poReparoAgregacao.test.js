/**
 * test/poReparoAgregacao.test.js
 *
 * Fase 2 de SPEC-tma-po-reparo-2026-08-30.md — a agregação que a sub-aba
 * "TMA (PO)" consome.
 *
 * O que estes testes protegem, em ordem de gravidade:
 *
 * 1. O DENOMINADOR. Os percentuais são sobre as notas MEDIDAS, nunca sobre o
 *    total. Com 28,2% da base sem `RepairTime`, trocar o denominador levaria
 *    "67% abaixo do critério" para "48%" — e a tela diria que a operação está
 *    bem melhor do que está.
 * 2. O PISO DO RANKING. Equipe com 3 notas ruins viraria 100% de violação e
 *    lideraria sem significar nada. E não pode sumir em silêncio: some com
 *    ressalva, em `poucasNotas`.
 * 3. AS FRONTEIRAS DAS FAIXAS. Buraco ou sobreposição faria o histograma não
 *    fechar com o total, e ninguém perceberia olhando a tela.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  agregarPoReparo, setoresDasRegionais, FAIXAS, PISO_RANKING, MINIMO_SEG,
} = require('../db/poReparoQueries');

/** Linha de note_po_reparo, só com o que a agregação lê. */
const linha = (note_id, delta_seg, extra = {}) => ({
  note_id,
  delta_seg,
  numero: 'N' + note_id,
  repair_time: delta_seg == null ? null : '2026-08-29T20:18:45+00:00',
  finalizando_em: '2026-08-29T20:25:47.000Z',
  has_repair: true,
  ...extra,
});

const mapaCom = pares =>
  new Map(pares.map(([id, team_name]) => [id, { team_name, regional: 'GUA' }]));

// ─────────────────────────────────────────────────────────────────────────────
// O denominador
// ─────────────────────────────────────────────────────────────────────────────

test('os percentuais são sobre as MEDIDAS, nunca sobre o total', () => {
  // 2 medidas e 8 sem dado. Com o total no denominador, "50% abaixo" viraria
  // "10% abaixo" e a tela diria que está quase tudo bem.
  const rows = [
    linha('a', 300), linha('b', 900),
    ...Array.from({ length: 8 }, (_, i) => linha('x' + i, null, { repair_time: null })),
  ];
  const ag = agregarPoReparo(rows, null);
  assert.equal(ag.cobertura.total, 10);
  assert.equal(ag.cobertura.medidas, 2);
  assert.equal(ag.cobertura.cobertura_pct, 20);
  assert.equal(ag.cobertura.sem_repair_time, 8);
  assert.equal(ag.resumo.abaixo, 1);
  assert.equal(ag.resumo.abaixo_pct, 50, 'metade DAS MEDIDAS, não do total');
});

test('nota sem delta não é violação nem cumprimento — é ausência de dado', () => {
  const ag = agregarPoReparo([linha('a', null, { repair_time: null })], null);
  assert.equal(ag.resumo.abaixo, 0);
  assert.equal(ag.resumo.abaixo_pct, 0);
  assert.equal(ag.faixas.reduce((s, f) => s + f.quantidade, 0), 0,
    'não medida não pode cair em faixa nenhuma');
  assert.equal(ag.cobertura.sem_repair_time, 1);
});

test('has_repair=false é contado à parte de "sem RepairTime"', () => {
  const ag = agregarPoReparo(
    [linha('a', null, { repair_time: null, has_repair: false })], null);
  assert.equal(ag.cobertura.has_repair_false, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// Faixas
// ─────────────────────────────────────────────────────────────────────────────

test('as faixas somam exatamente as medidas — sem buraco nem sobreposição', () => {
  // Duas por faixa, batendo nas divisas exatas dos dois lados.
  const valores = [-1, 0, 119, 120, 299, 300, 599, 600, 1799, 1800, 3599, 3600];
  const rows = valores.map((v, i) => linha('n' + i, v));
  const ag = agregarPoReparo(rows, null);

  assert.equal(ag.faixas.reduce((s, f) => s + f.quantidade, 0), valores.length);
  const q = Object.fromEntries(ag.faixas.map(f => [f.chave, f.quantidade]));
  assert.equal(q.negativo, 1, 'só o -1');
  assert.equal(q['0_2'],   2, '0 e 119');
  assert.equal(q['2_5'],   2, '120 e 299');
  assert.equal(q['5_10'],  2, '300 e 599');
  assert.equal(q['10_30'], 2, '600 e 1799');
  assert.equal(q['30_60'], 2, '1800 e 3599');
  assert.equal(q['60_mais'], 1, 'só o 3600');
});

test('zero é "abaixo", não "negativo"', () => {
  const ag = agregarPoReparo([linha('a', 0)], null);
  assert.equal(ag.resumo.negativos, 0);
  assert.equal(ag.resumo.abaixo, 1);
});

test('10 minutos exatos CUMPRE o critério', () => {
  const ag = agregarPoReparo([linha('a', MINIMO_SEG)], null);
  assert.equal(ag.resumo.abaixo, 0, '600s é o mínimo aceitável, não violação');
  assert.equal(ag.resumo.minimo_min, 10);
});

// ─────────────────────────────────────────────────────────────────────────────
// Série diária
// ─────────────────────────────────────────────────────────────────────────────

test('a série diária agrupa por dia do Finalizando Trabalho', () => {
  const rows = [
    linha('a', 300, { finalizando_em: '2026-08-01T12:00:00.000Z' }),
    linha('b', 900, { finalizando_em: '2026-08-01T18:00:00.000Z' }),
    linha('c', 120, { finalizando_em: '2026-08-03T10:00:00.000Z' }),
  ];
  const ag = agregarPoReparo(rows, null);
  assert.equal(ag.porDia.length, 2);
  assert.equal(ag.porDia[0].data, '2026-08-01');
  assert.equal(ag.porDia[0].total, 2);
  assert.equal(ag.porDia[0].abaixo_pct, 50);
  assert.equal(ag.porDia[1].data, '2026-08-03');
  assert.ok(ag.porDia[0].data < ag.porDia[1].data, 'em ordem cronológica');
});

// ─────────────────────────────────────────────────────────────────────────────
// Ranking e piso
// ─────────────────────────────────────────────────────────────────────────────

test('no ranking por PERCENTUAL o piso vale — e quem fica fora não some', () => {
  // 30/08 — o piso migrou pro `porEquipePct`. O ranking principal virou por
  // CONTAGEM, e lá o piso não faz falta: equipe com 3 notas não tem 12 casos.
  const rows = [
    ...Array.from({ length: PISO_RANKING }, (_, i) => linha('g' + i, 300)),
    linha('p0', 60), linha('p1', 60), linha('p2', 60),
  ];
  const mapa = mapaCom([
    ...Array.from({ length: PISO_RANKING }, (_, i) => ['g' + i, 'EQ-GRANDE']),
    ['p0', 'EQ-PEQUENA'], ['p1', 'EQ-PEQUENA'], ['p2', 'EQ-PEQUENA'],
  ]);
  const ag = agregarPoReparo(rows, mapa);

  assert.deepEqual(ag.porEquipePct.map(e => e.equipe), ['EQ-GRANDE']);
  assert.deepEqual(ag.poucasNotas.map(e => e.equipe), ['EQ-PEQUENA'],
    'sumir em silêncio seria pior que aparecer com ressalva');
  assert.equal(ag.poucasNotas[0].total, 3, 'a contagem aparece junto');
  assert.equal(ag.piso_ranking, PISO_RANKING);
});

test('o ranking por percentual ordena por % abaixo, não por mediana', () => {
  const rows = [
    ...Array.from({ length: 10 }, (_, i) => linha('a' + i, i < 5 ? 60 : 3000)),  // 50%
    ...Array.from({ length: 10 }, (_, i) => linha('b' + i, 599)),                // 100%
  ];
  const mapa = mapaCom([
    ...Array.from({ length: 10 }, (_, i) => ['a' + i, 'EQ-A']),
    ...Array.from({ length: 10 }, (_, i) => ['b' + i, 'EQ-B']),
  ]);
  const ag = agregarPoReparo(rows, mapa);
  assert.equal(ag.porEquipePct[0].equipe, 'EQ-B', '100% abaixo lidera, mesmo com mediana maior');
  assert.equal(ag.porEquipePct[0].abaixo_pct, 100);
  assert.equal(ag.porEquipePct[1].abaixo_pct, 50);
});

test('sem mapa de equipe o indicador continua saindo — só o ranking fica vazio', () => {
  // O ranking depende de uma consulta acessória (o mapa de snapshots). Se ela
  // falhar, o número principal NÃO pode sumir junto.
  const ag = agregarPoReparo([linha('a', 300), linha('b', 900)], null);
  assert.equal(ag.resumo.abaixo, 1);
  assert.deepEqual(ag.porEquipe, []);
  assert.deepEqual(ag.poucasNotas, []);
});

test('nota sem equipe no mapa conta no indicador, mas não vira equipe fantasma', () => {
  const ag = agregarPoReparo(
    [linha('a', 300), linha('semequipe', 900)], mapaCom([['a', 'EQ-A']]));
  assert.equal(ag.cobertura.medidas, 2, 'as duas contam no indicador');
  assert.equal(ag.porEquipe.length, 1, 'só a equipe conhecida aparece');
  assert.equal(ag.porEquipe[0].equipe, 'EQ-A');
});

// ─────────────────────────────────────────────────────────────────────────────
// Regional → setor
// ─────────────────────────────────────────────────────────────────────────────

test('GUA cobre DESG e DEPT — esquecer o DEPT some com notas', () => {
  assert.deepEqual(setoresDasRegionais(['GUA']).sort(), ['DEPT', 'DESG']);
  assert.deepEqual(setoresDasRegionais(['CAC']), ['DESC']);
  assert.deepEqual(setoresDasRegionais(['SJC']), ['DSSJ']);
  assert.deepEqual(setoresDasRegionais(['GUA', 'SJC']).sort(), ['DEPT', 'DESG', 'DSSJ']);
});

test('sem regional → null (sem filtro), não array vazio (que filtraria tudo fora)', () => {
  assert.equal(setoresDasRegionais(null), null);
  assert.equal(setoresDasRegionais([]), null);
  assert.equal(setoresDasRegionais(['INEXISTENTE']), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Borda
// ─────────────────────────────────────────────────────────────────────────────

test('caso vazio não quebra nem divide por zero', () => {
  const ag = agregarPoReparo([], null);
  assert.equal(ag.cobertura.total, 0);
  assert.equal(ag.cobertura.cobertura_pct, 0);
  assert.equal(ag.resumo.mediana_min, null);
  assert.equal(ag.resumo.abaixo_pct, 0);
  assert.equal(ag.faixas.length, FAIXAS.length, 'as faixas aparecem zeradas, não somem');
  assert.deepEqual(ag.porDia, []);
});

test('entrada inválida não derruba a agregação', () => {
  assert.equal(agregarPoReparo(null, null).cobertura.total, 0);
  assert.equal(agregarPoReparo(undefined, null).cobertura.total, 0);
});

test('os números da base completa reproduzem o veredito de 30/08', () => {
  // Amostra sintética com as proporções medidas: 66,6% abaixo de 10 min.
  const rows = [
    ...Array.from({ length: 422 },  (_, i) => linha('neg' + i, -600)),
    ...Array.from({ length: 1733 }, (_, i) => linha('z' + i, 60)),
    ...Array.from({ length: 655 },  (_, i) => linha('c' + i, 200)),
    ...Array.from({ length: 1207 }, (_, i) => linha('d' + i, 450)),
    ...Array.from({ length: 1883 }, (_, i) => linha('e' + i, 1200)),
    ...Array.from({ length: 95 },   (_, i) => linha('f' + i, 2400)),
    ...Array.from({ length: 39 },   (_, i) => linha('g' + i, 4000)),
  ];
  const ag = agregarPoReparo(rows, null);
  assert.equal(ag.cobertura.medidas, 6034);
  assert.equal(ag.resumo.abaixo, 4017);
  assert.equal(ag.resumo.abaixo_pct, 66.6);
  assert.equal(ag.resumo.negativos, 422);
});

// ═════════════════════════════════════════════════════════════════════════════
// Redesenho de 30/08 — casos graves, grupos e série semanal
// ═════════════════════════════════════════════════════════════════════════════

const { GRAVE_SEG, inicioDaSemana } = require('../db/poReparoQueries');

test('"grave" é reparo a menos de 2 min do fim, ou depois dele', () => {
  const ag = agregarPoReparo([
    linha('neg', -60), linha('zero', 0), linha('quase', 119),
    linha('limite', 120), linha('cinza', 400), linha('ok', 900),
  ], null);
  assert.equal(GRAVE_SEG, 120);
  assert.equal(ag.resumo.graves, 3, '-60, 0 e 119 — o 120 já sai');
  assert.equal(ag.resumo.negativos, 1, 'negativo é subconjunto de grave, não outra coisa');
  assert.equal(ag.resumo.abaixo, 5, 'grave continua contando como abaixo do critério');
});

test('os três grupos somam as medidas e não se sobrepõem', () => {
  const ag = agregarPoReparo([
    linha('a', -60), linha('b', 60), linha('c', 400), linha('d', 900), linha('e', 3000),
  ], null);
  const soma = ag.grupos.reduce((s, g) => s + g.quantidade, 0);
  assert.equal(soma, ag.cobertura.medidas);
  const q = Object.fromEntries(ag.grupos.map(g => [g.chave, g.quantidade]));
  assert.equal(q.graves, 2);
  assert.equal(q.cinzenta, 1, 'entre 2 e 10 min');
  assert.equal(q.ok, 2);
});

test('a semana começa na segunda-feira', () => {
  assert.equal(inicioDaSemana('2026-08-03T12:00:00Z'), '2026-08-03', 'segunda');
  assert.equal(inicioDaSemana('2026-08-09T12:00:00Z'), '2026-08-03', 'domingo cai na semana anterior');
  assert.equal(inicioDaSemana('2026-08-10T00:00:00Z'), '2026-08-10', 'segunda seguinte');
  assert.equal(inicioDaSemana('lixo'), null);
});

test('a série semanal agrupa e não inventa semana vazia', () => {
  // Preencher semana sem nota com zero puxaria a curva pra baixo como se o
  // apontamento tivesse piorado — num indicador que é razão, zero é mentira.
  const ag = agregarPoReparo([
    linha('a', 60,  { finalizando_em: '2026-08-03T12:00:00Z' }),
    linha('b', 900, { finalizando_em: '2026-08-05T12:00:00Z' }),
    linha('c', 300, { finalizando_em: '2026-08-17T12:00:00Z' }),   // pula a semana do 10
  ], null);
  assert.equal(ag.porSemana.length, 2, 'a semana sem nota não aparece');
  assert.deepEqual(ag.porSemana.map(s => s.semana), ['2026-08-03', '2026-08-17']);
  assert.equal(ag.porSemana[0].total, 2);
  assert.equal(ag.porSemana[0].graves_pct, 50);
});

test('o ranking por equipe ordena por CONTAGEM de graves', () => {
  // Equipe grande com muitos casos vem antes de equipe pequena com 100%.
  const rows = [
    ...Array.from({ length: 40 }, (_, i) => linha('g' + i, i < 12 ? 30 : 900)),  // 12 graves
    ...Array.from({ length: 4 },  (_, i) => linha('p' + i, 30)),                 // 4 graves, 100%
  ];
  const mapa = new Map([
    ...Array.from({ length: 40 }, (_, i) => ['g' + i, { team_name: 'EQ-GRANDE', regional: 'GUA' }]),
    ...Array.from({ length: 4 },  (_, i) => ['p' + i, { team_name: 'EQ-PEQUENA', regional: 'GUA' }]),
  ]);
  const ag = agregarPoReparo(rows, mapa);
  assert.equal(ag.porEquipe[0].equipe, 'EQ-GRANDE');
  assert.equal(ag.porEquipe[0].graves, 12);
  assert.equal(ag.porEquipe[1].equipe, 'EQ-PEQUENA');
  assert.equal(ag.porEquipe[1].graves_pct, 100,
    'a pequena tem 100% mas 4 casos — vem depois, e o % continua visível');
  // O ranking por CONTAGEM não precisa de piso: equipe com 4 notas não consegue
  // ter 12 casos. O piso segue valendo pro ranking por percentual.
  assert.equal(ag.porEquipe.length, 2, 'ninguém é excluído do ranking por contagem');
  assert.equal(ag.porEquipePct.length, 1, 'no ranking por % o piso corta a pequena');
});

// ═════════════════════════════════════════════════════════════════════════════
// Filtro de faixa (desvio) — 30/08
// ═════════════════════════════════════════════════════════════════════════════

const { faixaFinaDoDelta } = require('../db/poReparoQueries');

test('a faixa fina classifica nas mesmas fronteiras do histograma', () => {
  assert.equal(faixaFinaDoDelta(-1),   'negativo');
  assert.equal(faixaFinaDoDelta(0),    '0_2');
  assert.equal(faixaFinaDoDelta(119),  '0_2');
  assert.equal(faixaFinaDoDelta(120),  '2_5');
  assert.equal(faixaFinaDoDelta(599),  '5_10');
  assert.equal(faixaFinaDoDelta(600),  '10_30');
  assert.equal(faixaFinaDoDelta(3600), '60_mais');
});

test('nota não medida não pertence a faixa nenhuma', () => {
  // Forçá-la numa faria a soma do histograma parar de fechar com as medidas.
  assert.equal(faixaFinaDoDelta(null), null);
  assert.equal(faixaFinaDoDelta(undefined), null);
  assert.equal(faixaFinaDoDelta('abc'), null);
});

test('toda faixa do histograma tem chave classificável — sem órfã', () => {
  // Se alguém acrescentar uma faixa em FAIXAS e esquecer de cobrir o intervalo,
  // o filtro da tela ofereceria uma opção que nunca casa com nota nenhuma.
  const amostras = [-1000, -1, 0, 60, 200, 450, 900, 2000, 5000];
  const chaves = new Set(amostras.map(faixaFinaDoDelta));
  for (const f of FAIXAS) {
    assert.ok(chaves.has(f.chave) || f.chave === '30_60',
      `nenhuma amostra cai na faixa ${f.chave}`);
  }
  assert.equal(faixaFinaDoDelta(2000), '30_60');
});
