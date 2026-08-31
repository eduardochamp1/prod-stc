/**
 * test/tmaRankingFaixa.test.js
 *
 * 31/08/2026 — o ranking "Equipes — casos graves" da aba TMA (PO) passou a
 * seguir a faixa selecionada, e a mostrar top 15 em vez de top 20.
 *
 * Pedido do José: "vamos arrumar essa tabela, de forma a mostrar as top 15,
 * isso respeitando os filtros dessa página". Regional e equipe já filtravam
 * antes de agregar; a FAIXA não — ela era drill-down só da tabela de baixo.
 * Com a tela inteira filtrada em "negativo", o ranking seguia respondendo
 * "quem tem mais casos graves?", que é outra pergunta.
 *
 * O risco desta mudança é o denominador. "12 de 48 (25%)" só quer dizer algo
 * se 48 continuar sendo o total MEDIDO da equipe no período — trocar por
 * "12 de 12" faria toda linha virar 100% e o ranking perder a ordenação.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { rankingNaFaixa, rotuloDasFaixas } = require('../db/poReparoQueries');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const eq = (equipe, total, graves) =>
  ({ equipe, regional: 'GUA', total, graves, graves_pct: +(100 * graves / total).toFixed(1) });
const caso = (id, nome) => ({ note_id: id, _eq: nome });
const nomeDe = r => r._eq;

// ─────────────────────────────────────────────────────────────────────────────
// Contagem e ordenação
// ─────────────────────────────────────────────────────────────────────────────

test('ordena pela contagem na faixa, não pelos casos graves', () => {
  // A tem mais graves; B tem mais casos na faixa. Com faixa marcada, B lidera.
  const out = rankingNaFaixa(
    [eq('A', 100, 50), eq('B', 100, 10)],
    [caso(1, 'B'), caso(2, 'B'), caso(3, 'B'), caso(4, 'A')],
    nomeDe);
  assert.deepEqual(out.map(e => e.equipe), ['B', 'A']);
  assert.equal(out[0].na_faixa, 3);
  assert.equal(out[1].na_faixa, 1);
});

test('o denominador continua sendo o total medido da equipe', () => {
  // Se `total` virasse a contagem da faixa, toda linha daria 100% e o ranking
  // perderia a ordenação por proporção.
  const out = rankingNaFaixa([eq('A', 48, 30)], [caso(1, 'A'), caso(2, 'A')], nomeDe);
  assert.equal(out[0].total, 48, 'total tem de sobreviver intacto');
  assert.equal(out[0].na_faixa, 2);
  assert.equal(out[0].na_faixa_pct, 4.2, '2 de 48');
});

test('empate na contagem desempata pelo percentual', () => {
  // Duas equipes com 3 casos: quem tem menos notas no total está pior.
  const out = rankingNaFaixa(
    [eq('GRANDE', 300, 5), eq('PEQUENA', 30, 5)],
    [caso(1, 'GRANDE'), caso(2, 'GRANDE'), caso(3, 'GRANDE'),
     caso(4, 'PEQUENA'), caso(5, 'PEQUENA'), caso(6, 'PEQUENA')],
    nomeDe);
  assert.deepEqual(out.map(e => e.equipe), ['PEQUENA', 'GRANDE']);
});

test('equipe sem caso na faixa fica com 0 e NÃO some', () => {
  // Sumir aqui tiraria a equipe do "de N equipes" e a contagem pararia de
  // fechar. Quem corta em > 0 é o front.
  const out = rankingNaFaixa([eq('A', 10, 5), eq('B', 10, 5)], [caso(1, 'A')], nomeDe);
  assert.equal(out.length, 2);
  const b = out.find(e => e.equipe === 'B');
  assert.equal(b.na_faixa, 0);
  assert.equal(b.na_faixa_pct, 0);
});

test('caso sem equipe resolvida é ignorado, não vira equipe fantasma', () => {
  const out = rankingNaFaixa([eq('A', 10, 5)], [caso(1, null), caso(2, 'A')], nomeDe);
  assert.equal(out.length, 1);
  assert.equal(out[0].na_faixa, 1);
});

test('os campos originais sobrevivem — o front ainda lê graves sem faixa', () => {
  const out = rankingNaFaixa([eq('A', 10, 7)], [caso(1, 'A')], nomeDe);
  assert.equal(out[0].graves, 7);
  assert.equal(out[0].regional, 'GUA');
});

test('entradas vazias não quebram', () => {
  assert.deepEqual(rankingNaFaixa([], [], nomeDe), []);
  assert.deepEqual(rankingNaFaixa(null, null, nomeDe), []);
  assert.equal(rankingNaFaixa([eq('A', 10, 5)], null, nomeDe)[0].na_faixa, 0);
});

test('divisão por zero não vira NaN no percentual', () => {
  // total 0 não deveria existir (equipe só entra no agregado com nota), mas um
  // NaN no ranking apareceria na tela como "NaN%" pro gestor.
  const out = rankingNaFaixa([{ equipe: 'A', total: 0, graves: 0 }], [caso(1, 'A')], nomeDe);
  assert.equal(out[0].na_faixa_pct, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Rótulo — é o que impede o título de mentir sobre o que a barra mede
// ─────────────────────────────────────────────────────────────────────────────

test('rótulo concorda em número com a quantidade de faixas', () => {
  assert.equal(rotuloDasFaixas(['0_2']), 'na faixa 0 a 2 min');
  assert.equal(rotuloDasFaixas(['0_2', '2_5']), 'nas faixas 0 a 2 min + 2 a 5 min');
});

test('rótulo usa o texto que a tela mostra na distribuição', () => {
  assert.equal(rotuloDasFaixas(['negativo']), 'na faixa negativo (reparo DEPOIS)');
  assert.equal(rotuloDasFaixas(['60_mais']), 'na faixa 60 min ou mais');
});

test('chave desconhecida aparece em vez de sumir do título', () => {
  // Título estranho é problema menor que título que omite parte do recorte.
  assert.equal(rotuloDasFaixas(['xpto']), 'na faixa xpto');
});

test('sem faixa, sem rótulo', () => {
  assert.equal(rotuloDasFaixas([]), null);
  assert.equal(rotuloDasFaixas(null), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// A ligação no front — a função pura não vale nada solta
// ─────────────────────────────────────────────────────────────────────────────

function blocoRanking() {
  const ini = SRC.indexOf('const rkFaixa');
  assert.ok(ini > -1, 'não achei o bloco do ranking em public/index.html');
  const fim = SRC.indexOf('const totalGravesEq', ini);
  assert.ok(fim > ini);
  return SRC.slice(ini, fim);
}

test('o corte é 15 e vem de uma constante só', () => {
  const bloco = blocoRanking();
  assert.match(SRC, /const TOP_EQUIPES = 15;/);
  assert.match(bloco, /slice\(0,\s*TOP_EQUIPES\)/, 'sem número solto no slice');
  assert.doesNotMatch(bloco, /slice\(0,\s*20\)/);
  // O rodapé tem de usar a MESMA constante — "20 primeiras" mostrando 15 foi
  // exatamente o tipo de desencontro que gerou este pedido.
  const rodape = SRC.slice(SRC.indexOf('const totalGravesEq'), SRC.indexOf('const totalGravesEq') + 700);
  assert.match(rodape, /comGraves\.length > TOP_EQUIPES/);
  assert.match(rodape, /as \$\{TOP_EQUIPES\} primeiras/);
});

test('a barra e o número usam a métrica do ranking, não graves fixo', () => {
  const bloco = blocoRanking();
  assert.match(bloco, /rkVal\(e\)\s*\/\s*maxG/, 'a largura da barra segue a métrica');
  assert.match(bloco, /\$\{rkVal\(e\)\}/, 'o número mostrado também');
  assert.match(bloco, /\$\{rkPct\(e\)\}/);
  assert.match(bloco, /d\.ranking\s*&&\s*d\.ranking\.por === 'faixa'/,
    'quem decide é o backend — ele conta sobre a base inteira, não sobre as 1.000 da tabela');
});

// ─────────────────────────────────────────────────────────────────────────────
// Layout da barra — reportado em 31/08 como "as barras estão desconfiguradas"
// ─────────────────────────────────────────────────────────────────────────────

const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');

function regraCSS(seletor) {
  const i = CSS.indexOf(seletor + ' {');
  assert.ok(i > -1, `não achei a regra ${seletor}`);
  return CSS.slice(i, CSS.indexOf('}', i));
}

test('a coluna do rótulo encolhe até o conteúdo — a sobra vai pra barra', () => {
  // Era `1.2fr 2fr 110px`, calibrado pro painel estreito da distribuição. No
  // painel de largura cheia do ranking isso virava ~500px de vazio antes da
  // barra começar.
  //
  // `minmax(140px, 230px)` foi a 1ª tentativa e NÃO resolveu: minmax ocupa a
  // faixa inteira quando há espaço sobrando, então a coluna ia pros 230px de
  // qualquer jeito. Só `fit-content()` encolhe até o rótulo mais largo.
  const r = regraCSS('.desloc-bar-row');
  assert.match(r, /grid-template-columns:\s*fit-content\(\s*\d+px\s*\)\s+1fr\s+\d+px/,
    'a 1ª coluna tem de encolher ao conteúdo e a do meio absorver a sobra');
  assert.doesNotMatch(r, /1\.2fr\s+2fr/);
  assert.doesNotMatch(r, /grid-template-columns:\s*minmax/,
    'minmax reserva o teto inteiro — foi exatamente o que não funcionou');
});

test('o trilho e o hover não são brancos sobre fundo claro', () => {
  // O painel é --cinza1 (#f5f5f3). `rgba(255,255,255,.06)` não pintava nada e
  // a barra ficava boiando sem trilho — parte do "desconfiguradas".
  assert.doesNotMatch(regraCSS('.desloc-bar-track'), /rgba\(\s*255\s*,\s*255\s*,\s*255/);
  assert.doesNotMatch(regraCSS('.desloc-bar-row:hover'), /rgba\(\s*255\s*,\s*255\s*,\s*255/);
});

test('o título acompanha a métrica', () => {
  assert.match(SRC, /<h3>Equipes — \$\{rkNome\}/,
    'título fixo "casos graves" mentiria quando o ranking segue a faixa');
  assert.match(blocoRanking(), /rkFaixa\s*\?\s*`casos \$\{d\.ranking\.rotulo\}`\s*:\s*'casos graves'/);
});
