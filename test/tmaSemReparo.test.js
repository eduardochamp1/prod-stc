/**
 * test/tmaSemReparo.test.js
 *
 * 31/08/2026 — quadro "Sem Horário do Reparo", ao lado do ranking de equipes.
 *
 * PONTO CEGO QUE ISTO FECHA: nota sem Horário do Reparo não tem delta, então
 * não entra em `medidas` — e `porEquipe` é montado SÓ a partir de `medidas`.
 * A equipe que nunca preenche o campo não aparecia no ranking nem como boa nem
 * como ruim: ela simplesmente não existia na tela. O cartão de cobertura dizia
 * quantas notas eram, mas nunca de quem.
 *
 * A soma tem de fechar por construção — se `sem_repair_time` do cartão e a
 * soma da tabela discordarem, um dos dois está mentindo, e é o tipo de número
 * que a EDP questiona.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { agregarPoReparo } = require('../db/poReparoQueries');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** Linha de `note_po_reparo`. `repair_time: null` = o campo que falta. */
let _id = 0;
const linha = (team_name, repair_time, delta_seg = 600, regional = 'GUA') =>
  ({ note_id: `n${++_id}`, team_name, regional, repair_time, delta_seg });

/** O mapa que `resumoPoReparo` monta a partir das próprias linhas. */
const mapa = rows => new Map(
  rows.filter(r => r.team_name).map(r => [r.note_id, { team_name: r.team_name, regional: r.regional }]));

const agregar = rows => agregarPoReparo(rows, mapa(rows));

// ─────────────────────────────────────────────────────────────────────────────
// Contagem
// ─────────────────────────────────────────────────────────────────────────────

test('conta por equipe as notas sem o campo, com o total como denominador', () => {
  const rows = [
    linha('A', null, null), linha('A', null, null), linha('A', '2026-08-31T10:00:00Z'),
    linha('B', '2026-08-31T10:00:00Z'),
  ];
  const out = agregar(rows).semReparoPorEquipe;
  assert.equal(out.length, 1, 'B preencheu tudo — não entra na fila de cobrança');
  assert.equal(out[0].equipe, 'A');
  assert.equal(out[0].sem, 2);
  assert.equal(out[0].total, 3, 'o denominador é o total de notas da equipe no período');
  assert.equal(out[0].pct, 66.7);
});

test('equipe que preencheu tudo NÃO aparece', () => {
  const rows = [linha('A', '2026-08-31T10:00:00Z'), linha('B', '2026-08-31T10:00:00Z')];
  assert.deepEqual(agregar(rows).semReparoPorEquipe, []);
});

test('ordena pela contagem; o percentual desempata', () => {
  // 8 de 8 é pior que 8 de 200 — mas quem tem 9 vem antes dos dois, porque a
  // tabela é fila de cobrança, não índice de qualidade.
  const rows = [];
  for (let i = 0; i < 9; i++) rows.push(linha('NOVE', null, null));
  for (let i = 0; i < 8; i++) rows.push(linha('TODAS8', null, null));
  for (let i = 0; i < 8; i++) rows.push(linha('OITO_DE_MUITAS', null, null));
  for (let i = 0; i < 100; i++) rows.push(linha('OITO_DE_MUITAS', '2026-08-31T10:00:00Z'));
  const out = agregar(rows).semReparoPorEquipe;
  assert.deepEqual(out.map(e => e.equipe), ['NOVE', 'TODAS8', 'OITO_DE_MUITAS']);
  assert.equal(out[1].pct, 100);
});

// ─────────────────────────────────────────────────────────────────────────────
// A aritmética que a EDP pode conferir
// ─────────────────────────────────────────────────────────────────────────────

test('a soma da tabela fecha com o cartão de cobertura', () => {
  const rows = [
    linha('A', null, null), linha('A', null, null),
    linha('B', null, null),
    linha('C', '2026-08-31T10:00:00Z'),
    linha(null, null, null),           // nota sem equipe resolvida
  ];
  const ag = agregar(rows);
  const somaTabela = ag.semReparoPorEquipe.reduce((s, e) => s + e.sem, 0);
  assert.equal(somaTabela + ag.semReparoSemEquipe, ag.cobertura.sem_repair_time,
    'se estes dois discordam, um dos números da tela está mentindo');
  assert.equal(ag.semReparoSemEquipe, 1);
});

test('nota sem equipe não vira equipe fantasma na tabela', () => {
  const rows = [linha(null, null, null), linha('A', null, null)];
  const ag = agregar(rows);
  assert.deepEqual(ag.semReparoPorEquipe.map(e => e.equipe), ['A']);
  assert.equal(ag.semReparoSemEquipe, 1);
});

test('a equipe que SÓ tem nota sem horário aparece aqui — some do ranking', () => {
  // Este é o ponto cego inteiro num teste: sem delta, a equipe não entra em
  // `medidas`, logo não existe em `porEquipe`. Se ela também não aparecesse
  // aqui, não apareceria em lugar nenhum.
  const rows = [linha('INVISIVEL', null, null), linha('OUTRA', '2026-08-31T10:00:00Z', 900)];
  const ag = agregar(rows);
  assert.equal(ag.porEquipe.some(e => e.equipe === 'INVISIVEL'), false,
    'confirma a premissa: ela realmente não está no ranking');
  assert.equal(ag.semReparoPorEquipe[0].equipe, 'INVISIVEL');
});

test('período sem nenhuma falta devolve lista vazia, não erro', () => {
  const ag = agregar([linha('A', '2026-08-31T10:00:00Z')]);
  assert.deepEqual(ag.semReparoPorEquipe, []);
  assert.equal(ag.semReparoSemEquipe, 0);
});

test('nenhuma linha não quebra', () => {
  const ag = agregarPoReparo([], new Map());
  assert.deepEqual(ag.semReparoPorEquipe, []);
  assert.equal(ag.semReparoSemEquipe, 0);
  assert.equal(ag.cobertura.sem_repair_time, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// A tela
// ─────────────────────────────────────────────────────────────────────────────

test('o quadro fica ao LADO do ranking, não embaixo', () => {
  // O pedido foi "uma tabela ao lado da tabela de barras, já que ela está bem
  // grande" — empilhar embaixo não resolveria o aproveitamento da largura.
  const i = SRC.indexOf('desloc-grid-larga');
  assert.ok(i > -1, 'não achei o grid de duas colunas do ranking');
  const bloco = SRC.slice(i, i + 1400);
  assert.match(bloco, /Equipes — \$\{rkNome\}/);
  assert.match(bloco, /Sem Horário do Reparo/);
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
  assert.match(CSS, /\.desloc-grid-larga\s*\{\s*grid-template-columns:\s*[\d.]+fr\s+[\d.]+fr/,
    'o ranking precisa da coluna maior — são barras, não texto');
  const mq = CSS.indexOf('@media (max-width: 980px)');
  assert.ok(mq > -1, 'não achei o breakpoint de 980px');
  assert.match(CSS.slice(mq, mq + 300), /\.desloc-grid-larga\s*\{\s*grid-template-columns:\s*1fr/,
    'em tela estreita as duas colunas têm de empilhar');
});

test('sem faltas, a tela diz isso em vez de mostrar tabela vazia', () => {
  assert.match(SRC, /Todas as notas do período têm\s*\n?\s*Horário do Reparo preenchido/);
});

test('as notas sem equipe aparecem no rodapé — não somem da conta', () => {
  assert.match(SRC, /semReparoSemEquipe/);
  assert.match(SRC, /sem equipe identificada/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Filtro "sem Horário do Reparo" no detalhamento (31/08/2026)
//
// Pedido: "colocar um filtro para filtrarmos somente as notas sem apontamento
// de horário de reparo, para conferir as notas, equipe e dias na tabela".
// ─────────────────────────────────────────────────────────────────────────────

const {
  casoVisivel, cmpCasos, FAIXA_SEM_HORARIO, rotuloDasFaixas,
} = require('../db/poReparoQueries');

const SEM = FAIXA_SEM_HORARIO.chave;
const semHorario = { repair_time: null, delta_seg: null };
const medida = seg => ({ repair_time: '2026-08-31T10:00:00Z', delta_seg: seg });

test('sem filtro, a nota sem horário NÃO entra na tabela', () => {
  // Ela não tem diferença: apareceria entre os "piores" como se fosse desvio.
  assert.equal(casoVisivel(semHorario, null), false);
});

test('marcando o filtro, ela entra — é o pedido inteiro', () => {
  assert.equal(casoVisivel(semHorario, new Set([SEM])), true);
});

test('marcando OUTRA faixa, ela não entra de carona', () => {
  assert.equal(casoVisivel(semHorario, new Set(['0_2'])), false);
});

test('o filtro combina com faixas de verdade', () => {
  const f = new Set([SEM, '0_2']);
  assert.equal(casoVisivel(semHorario, f), true);
  assert.equal(casoVisivel(medida(60), f), true, '60s cai em 0 a 2 min');
  assert.equal(casoVisivel(medida(1200), f), false, '20 min não foi pedido');
});

test('o padrão continua sendo "abaixo do critério"', () => {
  assert.equal(casoVisivel(medida(300), null), true, '5 min está abaixo de 10');
  assert.equal(casoVisivel(medida(900), null), false, '15 min não');
  assert.equal(casoVisivel(medida(-60), null), true, 'negativo é o pior caso');
});

test('nota com horário mas sem delta continua fora', () => {
  // Ex.: sem o checkpoint Finalizando Trabalho. Não é o caso deste filtro.
  assert.equal(casoVisivel({ repair_time: '2026-08-31T10:00:00Z', delta_seg: null }, new Set([SEM])), false);
});

test('as sem horário vão pro FIM, não pro meio como desvio zero', () => {
  // `Number(null)` é 0: sem tratar, elas cairiam entre -1min e +1min, no meio
  // exato da lista de piores.
  const ordenado = [medida(600), semHorario, medida(-120), medida(60)].sort(cmpCasos);
  assert.deepEqual(ordenado.map(x => x.delta_seg), [-120, 60, 600, null]);
});

test('entre as sem horário, a mais recente primeiro', () => {
  const a = { repair_time: null, delta_seg: null, finalizando_em: '2026-08-10T08:00:00Z' };
  const b = { repair_time: null, delta_seg: null, finalizando_em: '2026-08-29T08:00:00Z' };
  assert.deepEqual([a, b].sort(cmpCasos).map(x => x.finalizando_em),
    ['2026-08-29T08:00:00Z', '2026-08-10T08:00:00Z']);
});

test('o rótulo não diz "na faixa sem Horário do Reparo"', () => {
  // Ausência de apontamento não é faixa — sozinha, dispensa o prefixo.
  assert.equal(rotuloDasFaixas([SEM]), 'sem Horário do Reparo');
  // Misturada, entra na enumeração normalmente.
  assert.equal(rotuloDasFaixas(['0_2', SEM]), 'nas faixas 0 a 2 min + sem Horário do Reparo');
});

test('a opção existe no filtro da tela', () => {
  assert.match(SRC, /<option value="sem_horario">sem Horário do Reparo<\/option>/);
});

test('a coluna Diferença mostra "—", nunca "0 min"', () => {
  // "0 min" seria número inventado: a diferença é desconhecida, não nula.
  assert.match(SRC, /x\.delta_min == null \? '—' : `\$\{x\.delta_min\} min`/);
});

test('o cabeçalho do detalhamento traduz a chave nova', () => {
  // Sem isto o título mostraria a chave crua "sem_horario".
  assert.match(SRC, /k === 'sem_horario'\s*\n?\s*\? 'sem Horário do Reparo'/);
});
