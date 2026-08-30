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

test('os quatro cartões existem, e o % abaixo não sumiu junto', () => {
  const corpo = corpoDe('function renderTma', 'function switchHistSubtab');
  for (const rotulo of ['Casos graves', 'Reparo após o fim', 'Mediana', 'Cobertura']) {
    assert.ok(corpo.includes(`desloc-kpi-label">${rotulo}`), `faltou o cartão "${rotulo}"`);
  }
  // Os 66,6% deixaram de ser manchete, mas continuam na tela como contexto —
  // tirar seria perder a régua que o José escolheu no enquadramento.
  assert.match(corpo, /\$\{r\.abaixo_pct\}% abaixo/,
    'o % abaixo do critério não pode desaparecer, só sair do destaque');
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

test('a tendência não quebra com período vazio nem com uma semana só', () => {
  const corpo = corpoDe('function _renderTmaTendenciaSVG', 'function renderTma');
  assert.match(corpo, /serie\.length === 0/, 'precisa tratar série vazia');
  assert.match(corpo, /serie\.length === 1/,
    'uma única semana dividiria por zero no cálculo do x');
});

test('a tendência diz a DIREÇÃO em texto, não só desenha a linha', () => {
  // A versão diária desenhava a curva e deixava a leitura implícita — ninguém
  // extraía dali se melhorou ou piorou. Agora a variação da 1ª à última semana
  // vem escrita, com seta.
  const corpo = corpoDe('function _renderTmaTendenciaSVG', 'function renderTma');
  assert.match(corpo, /Da 1ª à última semana/);
  assert.match(corpo, /'↑'|'↓'/, 'precisa indicar a direção');
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

test('o ranking é por CONTAGEM de casos graves, não por percentual', () => {
  // 30/08/2026 — a 1ª versão ranqueava por % e empatava todas as equipes entre
  // 62% e 98%: uma parede vermelha que não priorizava nada. "54 casos" é uma
  // tarefa; "98,2%" não é. O percentual continua visível, mas ao lado.
  const corpo = corpoDe('function renderTma', 'function switchHistSubtab');
  assert.match(corpo, /e\.graves \/ maxG/, 'a barra tem de ser proporcional à CONTAGEM');
  assert.match(corpo, /\$\{e\.graves_pct\}%/, 'o percentual continua visível, como contexto');
  assert.match(corpo, /de \$\{e\.total\}/, 'sem o denominador, 54 casos não se lê');
});

test('os cartões lideram pelo acionável, não pelos 66%', () => {
  // "66,6% abaixo" descreve, mas não prioriza: com dois terços violando, a tela
  // dizia "está tudo errado". O 1º cartão passou a ser o subconjunto
  // indefensável (negativos + menos de 2 min).
  const corpo = corpoDe('function renderTma', 'function switchHistSubtab');
  // Busca pelo RÓTULO renderizado, não pelo texto solto: 'Mediana' também
  // aparece dentro da variável corMediana, bem antes dos cartões.
  const iGraves  = corpo.indexOf('desloc-kpi-label\">Casos graves');
  const iMediana = corpo.indexOf('desloc-kpi-label\">Mediana');
  assert.ok(iGraves > -1 && iGraves < iMediana,
    'o cartão de casos graves tem de vir antes do de mediana');
  assert.match(corpo, /r\.grave_min/, 'o cartão precisa dizer qual é o corte');
});

test('a distribuição tem uma barra empilhada que faz o olho somar', () => {
  // Sete faixas soltas quebravam as ruins em quatro barras e as boas em três —
  // a maior barra da tela era verde e a primeira leitura saía invertida.
  const corpo = corpoDe('function renderTma', 'function switchHistSubtab');
  assert.match(corpo, /_renderTmaGruposSVG\(d\.grupos/);
  const grupos = corpoDe('function _renderTmaGruposSVG', 'function renderTma');
  assert.match(grupos, /position:absolute/, 'os segmentos ficam lado a lado numa barra só');
});

test('a tendência é SEMANAL na TMA e continua DIÁRIA na aba vizinha', () => {
  // Em 30/08 um replace de string trocou o título da aba errada: "Tendência
  // diária" existe nas duas, e String.replace pega só a primeira ocorrência.
  const tma = corpoDe('function renderTma', 'function switchHistSubtab');
  assert.match(tma, /Tendência semanal/);
  assert.match(tma, /_renderTmaTendenciaSVG\(d\.porSemana/);
  assert.ok(!/Tendência diária/.test(tma), 'a TMA não pode dizer "diária"');

  const elevado = corpoDe('function renderDeslocamentos', 'function _renderDeslocTendenciaSVG');
  assert.match(elevado, /Tendência diária/, 'a aba Elevado continua diária — não renomear');
});
