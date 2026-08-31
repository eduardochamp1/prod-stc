/**
 * test/tmaRankingEquipes.test.js
 *
 * O ranking "Equipes — casos abaixo de 10 min" da aba TMA (PO), e o layout das
 * barras que ele compartilha com a distribuição.
 *
 * ── COMO A REGRA CHEGOU AQUI (31/08/2026, na ordem) ─────────────────────────
 * 1. Ranking contava GRAVES (< 2 min) e não seguia filtro de faixa nenhum.
 * 2. Pedido "top 15 respeitando os filtros da página" → passou a seguir a
 *    faixa marcada.
 * 3. Com "10 a 30 min" marcada, ele passou a ranquear as equipes pelos casos
 *    CERTOS delas — 10 a 30 min está ACIMA do critério. Ranquear acerto não
 *    prioriza nada.
 * 4. Decisão final: o ranking NÃO segue a faixa. Conta sempre os casos abaixo
 *    do critério (< 10 min), que é a regra da operação desde o primeiro dia.
 *    Os 2 minutos eram recorte interno e deixavam a maior parte do problema
 *    fora do ranking. A faixa voltou a ser drill-down só da tabela.
 *
 * Este arquivo existe pra que o passo 2 não seja reintroduzido por parecer
 * "mais coerente com os filtros" — ele foi tentado e desfeito com motivo.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { agregarPoReparo, MINIMO_SEG, GRAVE_SEG } = require('../db/poReparoQueries');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');

let _id = 0;
const nota = (equipe, delta_seg) =>
  ({ note_id: `n${++_id}`, team_name: equipe, regional: 'GUA',
     repair_time: '2026-08-31T10:00:00Z', delta_seg });
const mapa = rows => new Map(rows.map(r => [r.note_id, { team_name: r.team_name, regional: r.regional }]));
const rank = rows => agregarPoReparo(rows, mapa(rows)).porEquipe;

// ─────────────────────────────────────────────────────────────────────────────
// A métrica
// ─────────────────────────────────────────────────────────────────────────────

test('ordena por casos ABAIXO DO CRITÉRIO, não por graves', () => {
  // A tem mais graves; B tem mais casos abaixo de 10 min. B lidera.
  const rows = [
    ...Array.from({ length: 5 }, () => nota('A', 60)),      // 5 graves, 5 abaixo
    ...Array.from({ length: 9 }, () => nota('B', 500)),     // 0 graves, 9 abaixo
  ];
  const out = rank(rows);
  assert.deepEqual(out.map(e => e.equipe), ['B', 'A']);
  assert.equal(out[0].abaixo, 9);
  assert.equal(out[0].graves, 0, 'B não tem nenhum grave e mesmo assim lidera');
});

test('caso ACIMA do critério não entra na contagem', () => {
  // 10 a 30 min é acerto. Foi ranquear isso que motivou a mudança.
  const rows = [nota('A', 1200), nota('A', 300), nota('B', 1800)];
  const out = rank(rows);
  assert.equal(out.find(e => e.equipe === 'A').abaixo, 1);
  assert.equal(out.find(e => e.equipe === 'B').abaixo, 0);
});

test('o percentual desempata — 8 de 8 é pior que 8 de 200', () => {
  const rows = [
    ...Array.from({ length: 8 }, () => nota('POUCAS', 60)),
    ...Array.from({ length: 8 }, () => nota('MUITAS', 60)),
    ...Array.from({ length: 100 }, () => nota('MUITAS', 1200)),
  ];
  assert.deepEqual(rank(rows).map(e => e.equipe), ['POUCAS', 'MUITAS']);
});

test('o denominador é o total medido da equipe, todas as faixas', () => {
  const rows = [nota('A', 60), nota('A', 1200), nota('A', 1800)];
  const e = rank(rows)[0];
  assert.equal(e.abaixo, 1);
  assert.equal(e.total, 3, 'sem o total, "1 caso" não se lê');
  assert.equal(e.abaixo_pct, 33.3);
});

test('o critério vem da constante, não de um 600 solto', () => {
  // Se MINIMO_SEG mudar, ranking e cartões têm de mudar juntos.
  const rows = [nota('A', MINIMO_SEG - 1), nota('A', MINIMO_SEG)];
  const e = rank(rows)[0];
  assert.equal(e.abaixo, 1, 'a fronteira é exclusiva: exatamente 10 min está OK');
  assert.ok(GRAVE_SEG < MINIMO_SEG, 'graves seguem sendo um subconjunto de abaixo');
});

// ─────────────────────────────────────────────────────────────────────────────
// O ranking NÃO pode voltar a seguir a faixa
// ─────────────────────────────────────────────────────────────────────────────

test('o agregado não expõe mais métrica por faixa', () => {
  const rows = [nota('A', 60)];
  const ag = agregarPoReparo(rows, mapa(rows));
  assert.equal(ag.ranking, undefined, '`ranking.por` era o interruptor do passo 2');
  assert.equal(ag.porEquipe.length, 1);
  assert.equal(ag.porEquipe[0].na_faixa, undefined);
});

test('o front lê abaixo direto, sem indireção de faixa', () => {
  const ini = SRC.indexOf('const TOP_EQUIPES');
  assert.ok(ini > -1, 'não achei o bloco do ranking');
  const bloco = SRC.slice(ini, SRC.indexOf('const totalAbaixoEq', ini));
  assert.match(bloco, /e\.abaixo > 0/, 'a lista é de quem tem caso abaixo do critério');
  assert.match(bloco, /e\.abaixo \/ maxG/, 'a barra é proporcional à contagem');
  for (const morto of [/rkFaixa/, /rkVal/, /na_faixa/, /d\.ranking/]) {
    assert.doesNotMatch(bloco, morto, 'sobra do ranking-segue-a-faixa, que foi desfeito');
  }
});

test('o título diz o critério e sai da constante do backend', () => {
  // Título fixo "casos graves" mentiria sobre o que a barra mede agora.
  assert.match(SRC, /<h3>Equipes — casos abaixo de \$\{r\.minimo_min\} min/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Corte da lista
// ─────────────────────────────────────────────────────────────────────────────

test('o corte é 20 e vem de uma constante só', () => {
  assert.match(SRC, /const TOP_EQUIPES = 20;/);
  const ini = SRC.indexOf('const TOP_EQUIPES');
  const bloco = SRC.slice(ini, ini + 2000);
  assert.match(bloco, /slice\(0,\s*TOP_EQUIPES\)/, 'sem número solto no slice');
  // O rodapé tem de usar a MESMA constante — "20 primeiras" mostrando 15 foi
  // um desencontro real desta tela.
  assert.match(bloco, /comAbaixo\.length > TOP_EQUIPES/);
  assert.match(bloco, /as \$\{TOP_EQUIPES\} primeiras/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Layout da barra — reportado como "as barras estão desconfiguradas"
// ─────────────────────────────────────────────────────────────────────────────

function regraCSS(seletor) {
  const i = CSS.indexOf(seletor + ' {');
  assert.ok(i > -1, `não achei a regra ${seletor}`);
  return CSS.slice(i, CSS.indexOf('}', i));
}

test('todas as barras da tela partem da MESMA origem', () => {
  // Barra só se compara a partir de uma origem comum. Três tentativas erradas:
  //   `1.2fr 2fr 110px`  — calibrado pro painel estreito; no de largura cheia
  //                        virava ~500px de vazio antes da barra.
  //   `minmax(140,230)`  — reserva o teto inteiro quando há espaço sobrando.
  //   `fit-content(230)` — media o rótulo mais largo de CADA lista, então a
  //                        distribuição e o ranking ganhavam eixos diferentes.
  const r = regraCSS('.desloc-bar-row');
  assert.match(r, /grid-template-columns:\s*\d+px\s+1fr\s+\d+px/,
    'a 1ª coluna tem de ser fixa — é o eixo comum de todas as listas');
  for (const proibido of [/1\.2fr\s+2fr/, /minmax/, /fit-content/]) {
    assert.doesNotMatch(r, proibido, 'coluna elástica dá um eixo por painel');
  }
});

test('o trilho e o hover não são brancos sobre fundo claro', () => {
  // O painel é --cinza1 (#f5f5f3). `rgba(255,255,255,.06)` não pintava nada e
  // a barra ficava boiando sem trilho.
  assert.doesNotMatch(regraCSS('.desloc-bar-track'), /rgba\(\s*255\s*,\s*255\s*,\s*255/);
  assert.doesNotMatch(regraCSS('.desloc-bar-row:hover'), /rgba\(\s*255\s*,\s*255\s*,\s*255/);
});
