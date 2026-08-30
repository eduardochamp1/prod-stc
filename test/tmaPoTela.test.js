/**
 * test/tmaPoTela.test.js
 *
 * Fase 3 de SPEC-tma-po-reparo-2026-08-30.md — a sub-aba "TMA (PO)".
 *
 * O repo não tem harness de frontend, então aqui valem invariantes estruturais
 * lidas do HTML. Não provam que a tela renderiza — a conferência visual é
 * manual. Provam o que dá pra provar, e que some em refactor:
 *
 *  - a legenda que impede confundir isto com o TMA regulatório;
 *  - que a cobertura aparece na tela (o denominador de tudo);
 *  - que o Atualizar do balão recarrega a sub-aba CERTA;
 *  - que trocar de sub-aba não redispara consulta cara.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** Recorta o corpo de uma função do arquivo, até a próxima declaração. */
function corpoDe(nome, ateNome) {
  const ini = SRC.indexOf(nome);
  const fim = SRC.indexOf(ateNome, ini + 1);
  assert.ok(ini > -1 && fim > ini, `não achei ${nome}`);
  return SRC.slice(ini, fim);
}

// ─────────────────────────────────────────────────────────────────────────────
// A legenda — o que impede a confusão com o TMA regulatório
// ─────────────────────────────────────────────────────────────────────────────

test('a tela diz explicitamente que NÃO é o TMA regulatório', () => {
  // A aba se chama "TMA (PO)" mas mede outra coisa. Sem esta legenda alguém vai
  // comparar com o TMA da EDP e concluir que um dos dois está errado.
  const corpo = corpoDe('function renderTma', 'function switchHistSubtab');
  assert.match(corpo, /Não é o TMA regulatório|NÃO é o TMA regulatório/i);
  assert.match(corpo, /emissão → conclusão/,
    'precisa dizer o que É o TMA regulatório, senão o aviso não ajuda');
});

test('a legenda explica o denominador dos percentuais', () => {
  const corpo = corpoDe('function renderTma', 'function switchHistSubtab');
  assert.match(corpo, /sobre as .*medidas|percentuais acima são sobre/i,
    'com ~28% da base sem RepairTime, omitir o denominador engana');
});

// ─────────────────────────────────────────────────────────────────────────────
// A cobertura tem de estar VISÍVEL, não escondida
// ─────────────────────────────────────────────────────────────────────────────

test('cobertura é um dos cartões, não uma nota de rodapé', () => {
  const corpo = corpoDe('function renderTma', 'function switchHistSubtab');
  const iKpis  = corpo.indexOf('desloc-kpis');
  const iCob   = corpo.indexOf('Cobertura');
  const iGrid  = corpo.indexOf('desloc-grid');
  assert.ok(iCob > iKpis && iCob < iGrid,
    'a cobertura tem de estar no bloco de cartões, acima dos gráficos');
  assert.match(corpo, /sem Horário do Reparo/,
    'o cartão precisa dizer QUANTAS notas ficaram de fora');
});

test('os quatro cartões previstos na spec existem', () => {
  const corpo = corpoDe('function renderTma', 'function switchHistSubtab');
  for (const rotulo of ['Mediana', 'Abaixo do critério', 'Reparo após o fim', 'Cobertura']) {
    assert.ok(corpo.includes(rotulo), `faltou o cartão "${rotulo}"`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// O gráfico só tem sentido com a linha do critério
// ─────────────────────────────────────────────────────────────────────────────

test('a tendência desenha a linha do critério de 10 min', () => {
  const corpo = corpoDe('function _renderTmaTendenciaSVG', 'function renderTma');
  assert.match(corpo, /minimoMin/,
    'sem a régua o leitor não sabe se 6 min é bom ou ruim');
  assert.match(corpo, /stroke-dasharray/, 'a linha do critério é tracejada');
});

test('a tendência não quebra com período vazio', () => {
  const corpo = corpoDe('function _renderTmaTendenciaSVG', 'function renderTma');
  assert.match(corpo, /porDia\.length === 0/, 'precisa tratar série vazia');
  assert.match(corpo, /porDia\.length === 1/,
    'um único dia dividiria por zero no cálculo do x');
});

// ─────────────────────────────────────────────────────────────────────────────
// O balão de ações rápidas
// ─────────────────────────────────────────────────────────────────────────────

test('o Atualizar do balão recarrega a sub-aba ATIVA, não sempre a primeira', () => {
  // `currentTab` vale 'desloc' nas duas sub-abas. Sem esta ramificação, o
  // Atualizar recarregaria o Deslocamento Elevado com a TMA (PO) na tela.
  const corpo = corpoDe('function fabRecarregar', 'document.addEventListener(\'click\'');
  assert.match(corpo, /_deslocSubAtiva === 'tma'/);
  assert.match(corpo, /loadTma\(\)/);
  const iTma = corpo.indexOf('_deslocSubAtiva');
  const iMapa = corpo.indexOf('FAB_RECARREGAR[tab]');
  assert.ok(iTma < iMapa, 'a checagem da sub-aba tem de vir ANTES do mapa por aba');
});

// ─────────────────────────────────────────────────────────────────────────────
// Carregamento preguiçoso
// ─────────────────────────────────────────────────────────────────────────────

test('a TMA (PO) só busca na primeira abertura', () => {
  // A consulta monta o mapa de equipes, que na 1ª vez do dia custa ~25s.
  // Redisparar a cada troca de sub-aba tornaria a navegação insuportável.
  const corpo = corpoDe('function switchDeslocSubtab', 'function switchHistSubtab');
  assert.match(corpo, /_tmaCarregada/);
  assert.match(corpo, /if \(!_tmaCarregada\)/);
  assert.ok(!/loadDeslocamentos\s*\(/.test(corpo),
    'voltar pra sub-aba Elevado não pode redisparar o pipeline dela');
});

// ─────────────────────────────────────────────────────────────────────────────
// Filtros
// ─────────────────────────────────────────────────────────────────────────────

test('a TMA (PO) tem filtro próprio de data e regional — e NÃO de equipe', () => {
  // Equipe entra como ranking, não como filtro de topo: a régua da tela é a
  // distribuição, e filtrar por equipe antes de ver o todo inverte a leitura.
  assert.ok(SRC.includes('id="tma-de-input"'));
  assert.ok(SRC.includes('id="tma-ate-input"'));
  assert.ok(SRC.includes('id="tma-regional-select"'));
  assert.ok(!SRC.includes('id="tma-equipe-select"'));
});

test('o filtro de regional respeita o perfil regional do usuário', () => {
  const corpo = corpoDe('async function initTma', 'async function loadTma');
  assert.match(corpo, /getStoredSession/);
  assert.match(corpo, /disabled = true/,
    'usuário de uma regional não pode trocar o filtro pra ver outra');
});

test('o ranking mostra a contagem junto do percentual', () => {
  // 100% de 3 notas e 100% de 300 notas não são a mesma informação.
  const corpo = corpoDe('function renderTma', 'function switchHistSubtab');
  assert.match(corpo, /\$\{e\.abaixo\}\/\$\{e\.total\}/);
  assert.match(corpo, /piso_ranking/, 'a tela precisa dizer qual é o piso');
  assert.match(corpo, /poucasNotas/, 'quem fica fora do ranking não pode sumir');
});
