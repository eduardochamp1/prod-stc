/**
 * test/deslocMapaDia.test.js
 *
 * O passo 2 da aba Deslocamento passou a montar o mapa note_id→equipe DIA A DIA,
 * cacheando cada dia (dia fechado é imutável). Medido em 28/08/2026: era 21,1s
 * numa consulta só, 70% do tempo restante da aba.
 *
 * O cache em si é inofensivo — se errar, o pior caso é lentidão. O que pode mudar
 * NÚMERO é o merge entre dias: antes o `DISTINCT ON ... ORDER BY captured_at DESC`
 * escolhia o vencedor olhando o período inteiro de uma vez. Agora cada dia escolhe
 * o seu e o merge decide entre eles. Se essa regra divergir, uma nota que passou
 * por duas equipes vai pra equipe errada e o ranking muda em silêncio.
 *
 * Regra que tem de valer (definida em 21/08/2026): vence o maior `captured_at`,
 * ou seja, a ÚLTIMA equipe a deter a nota no período.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const desloc = require('../db/deslocamentosQueries');

const linha = (note_id, team_name, ts, regional = 'GUA') =>
  ({ note_id, team_name, regional, sector_id: 'DESG', ts });

// ─────────────────────────────────────────────────────────────────────────────
// A regra de desempate
// ─────────────────────────────────────────────────────────────────────────────

test('nota em dois dias: vence o captured_at mais RECENTE', () => {
  const mapa = desloc._mergeMapasDia([
    [linha('n1', 'EQUIPE-A', 1000)],   // dia 1
    [linha('n1', 'EQUIPE-B', 2000)],   // dia 2 — mais recente
  ]);
  assert.equal(mapa.get('n1').team_name, 'EQUIPE-B');
});

test('a ordem em que os dias chegam não muda o vencedor', () => {
  // Os dias são consultados em lotes concorrentes (CONC_DIAS), então a ordem de
  // chegada não é garantida. O resultado tem de ser o mesmo nas duas ordens —
  // senão o ranking muda entre dois cliques idênticos.
  const dia1 = [linha('n1', 'EQUIPE-A', 1000)];
  const dia2 = [linha('n1', 'EQUIPE-B', 2000)];
  assert.equal(desloc._mergeMapasDia([dia1, dia2]).get('n1').team_name, 'EQUIPE-B');
  assert.equal(desloc._mergeMapasDia([dia2, dia1]).get('n1').team_name, 'EQUIPE-B');
});

test('desempate compara captured_at, NÃO a ordem do dia', () => {
  // Snapshot gravado fora de ordem (backfill, relógio) não pode fazer um dia
  // anterior perder só por ser anterior. A regra é o carimbo, não o calendário.
  const mapa = desloc._mergeMapasDia([
    [linha('n1', 'EQUIPE-A', 9000)],   // dia mais antigo, captured_at maior
    [linha('n1', 'EQUIPE-B', 2000)],
  ]);
  assert.equal(mapa.get('n1').team_name, 'EQUIPE-A');
});

test('empate de captured_at é estável: o primeiro visto permanece', () => {
  const a = desloc._mergeMapasDia([
    [linha('n1', 'EQUIPE-A', 5000)],
    [linha('n1', 'EQUIPE-B', 5000)],
  ]);
  const b = desloc._mergeMapasDia([
    [linha('n1', 'EQUIPE-A', 5000)],
    [linha('n1', 'EQUIPE-B', 5000)],
  ]);
  assert.equal(a.get('n1').team_name, 'EQUIPE-A');
  assert.equal(a.get('n1').team_name, b.get('n1').team_name, 'resultado tem de ser determinístico');
});

// ─────────────────────────────────────────────────────────────────────────────
// Integridade do mapa
// ─────────────────────────────────────────────────────────────────────────────

test('carrega equipe, regional e setor juntos — não mistura de linhas diferentes', () => {
  const mapa = desloc._mergeMapasDia([
    [{ note_id: 'n1', team_name: 'EQ-A', regional: 'GUA', sector_id: 'DESG', ts: 1000 }],
    [{ note_id: 'n1', team_name: 'EQ-B', regional: 'SJC', sector_id: 'DSSJ', ts: 2000 }],
  ]);
  const v = mapa.get('n1');
  assert.deepEqual(v, { team_name: 'EQ-B', regional: 'SJC', sector_id: 'DSSJ' });
});

test('notas distintas de dias distintos coexistem', () => {
  const mapa = desloc._mergeMapasDia([
    [linha('n1', 'EQ-A', 1000), linha('n2', 'EQ-B', 1000)],
    [linha('n3', 'EQ-C', 2000)],
  ]);
  assert.equal(mapa.size, 3);
  assert.equal(mapa.get('n2').team_name, 'EQ-B');
});

test('lixo não derruba o merge nem entra no mapa', () => {
  const mapa = desloc._mergeMapasDia([
    null,
    undefined,
    [null, { note_id: null, ts: 1 }, { note_id: 'n1', ts: NaN }, linha('n2', 'EQ-A', 1000)],
  ]);
  assert.equal(mapa.size, 1);
  assert.equal(mapa.get('n2').team_name, 'EQ-A');
  assert.equal(mapa.has('n1'), false, 'linha sem carimbo válido não pode virar vencedora');
});

test('sem dia nenhum → mapa vazio, não exceção', () => {
  assert.equal(desloc._mergeMapasDia([]).size, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// A chave do cache por dia
// ─────────────────────────────────────────────────────────────────────────────

test('a chave do dia NÃO inclui note_ids', () => {
  // Se incluísse, cada consulta teria chave própria e o cache não serviria pra
  // nenhuma outra — que é o motivo de o mapa diário ser calculado sem o filtro
  // de id. Este teste é a cerca dessa decisão.
  const k = desloc._keyDia('2026-08-01', { regionais: ['GUA'], teams: ['EQ-A'] });
  assert.ok(!/note_id/i.test(k), `chave do dia não deveria falar de nota: ${k}`);
  assert.ok(k.includes('2026-08-01'));
});

test('filtros diferentes → chaves diferentes; mesma coisa em outra ordem → igual', () => {
  const base = desloc._keyDia('2026-08-01', { regionais: ['GUA', 'CAC'] });
  assert.equal(base, desloc._keyDia('2026-08-01', { regionais: ['CAC', 'GUA'] }),
    'ordem do multi-select não pode gerar chave nova (perderia o cache à toa)');
  assert.notEqual(base, desloc._keyDia('2026-08-01', { regionais: ['GUA'] }));
  assert.notEqual(base, desloc._keyDia('2026-08-02', { regionais: ['GUA', 'CAC'] }));
  assert.notEqual(base, desloc._keyDia('2026-08-01', { regionais: ['GUA', 'CAC'], teams: ['EQ-A'] }));
});

// ─────────────────────────────────────────────────────────────────────────────
// O atalho que NÃO pode ser tomado
// ─────────────────────────────────────────────────────────────────────────────

test('o código registra por que não se lê só o último snapshot do dia', () => {
  // Ler só o último snapshot de cada (dia, equipe) cairia de ~170 mil linhas pra
  // ~1.600 — 100× — e está ERRADO: a suíte já prova que nota some de snapshot
  // posterior ("une concluídas de todos os snapshots"). Este teste existe pra
  // que a próxima pessoa (ou IA) encontre o aviso antes de "otimizar".
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'db', 'deslocamentosQueries.js'), 'utf8');
  assert.ok(
    /REJEITADO — ler só o ÚLTIMO snapshot/.test(src),
    'sumiu o comentário que impede o atalho que perde dado',
  );
});
