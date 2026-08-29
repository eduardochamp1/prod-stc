/**
 * test/deslocSubabas.test.js
 *
 * 28/08/2026 — a aba Deslocamentos ganhou sub-abas. A tela que ocupava a aba
 * inteira virou a primeira ("Deslocamento Elevado"), SEM alteração nenhuma
 * dentro dela; a segunda ("TMA") entra depois, com spec própria.
 *
 * O risco desta mudança é ser um movimento de markup num arquivo de 8,6 mil
 * linhas (risco H11 do backlog): se um `<div>` fechar no lugar errado, metade do
 * painel some — e o repo não tem harness de frontend pra pegar isso.
 *
 * Então aqui valem as invariantes estruturais que dá pra provar lendo o HTML,
 * no estilo do resto da suíte. Limite explícito: isto NÃO prova que a tela
 * renderiza. A conferência visual das duas sub-abas é manual, no navegador.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC   = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const CSS   = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');

/** Recorta o painel da aba, do id de abertura até a abertura do painel seguinte. */
function painelDesloc() {
  const ini = SRC.indexOf('<div class="tab-panel" id="tab-desloc">');
  const fim = SRC.indexOf('<div class="tab-panel" id="tab-notas">');
  assert.ok(ini > -1 && fim > ini, 'não achei os limites do painel de deslocamentos');
  return SRC.slice(ini, fim);
}

// ─────────────────────────────────────────────────────────────────────────────
// Estrutura
// ─────────────────────────────────────────────────────────────────────────────

test('as duas sub-abas existem, uma vez cada', () => {
  for (const id of ['desloc-subtab-elevado', 'desloc-subtab-tma',
                    'desloc-sub-elevado', 'desloc-sub-tma']) {
    const n = (SRC.match(new RegExp(`id="${id}"`, 'g')) || []).length;
    assert.equal(n, 1, `id="${id}" deveria aparecer 1 vez, apareceu ${n}`);
  }
});

test('a tela de hoje ficou DENTRO da sub-aba Deslocamento Elevado', () => {
  // Esta é a invariante do movimento: os filtros e o conteúdo que existiam na
  // aba têm de estar dentro do painel da primeira sub-aba, não soltos.
  const p = painelDesloc();
  const iElevado = p.indexOf('id="desloc-sub-elevado"');
  const iFechaEl = p.indexOf('/#desloc-sub-elevado');
  const iFiltros = p.indexOf('id="desloc-de-input"');
  const iConteudo = p.indexOf('id="desloc-content"');

  assert.ok(iElevado > -1 && iFechaEl > iElevado, 'painel da 1ª sub-aba não fecha');
  assert.ok(iFiltros > iElevado && iFiltros < iFechaEl,
    'a barra de filtros escapou da sub-aba Deslocamento Elevado');
  assert.ok(iConteudo > iElevado && iConteudo < iFechaEl,
    '#desloc-content escapou da sub-aba Deslocamento Elevado');
});

test('a barra de sub-abas vem ANTES do conteúdo, como no desenho', () => {
  const p = painelDesloc();
  assert.ok(p.indexOf('desloc-subtabs') < p.indexOf('id="desloc-sub-elevado"'),
    'a barra de sub-abas tem de vir acima dos painéis');
  assert.ok(p.indexOf('desloc-subtabs') < p.indexOf('filter-bar'),
    'a barra de sub-abas tem de vir acima da barra de filtros');
});

test('a TMA nasce escondida e a Elevado nasce ativa', () => {
  const p = painelDesloc();
  assert.match(p, /id="desloc-sub-tma"[^>]*style="display:none"/,
    'o painel da TMA tem de começar escondido');
  assert.match(p, /class="desloc-subtab-btn active" id="desloc-subtab-elevado"/,
    'a sub-aba Deslocamento Elevado tem de começar ativa');
});

// ─────────────────────────────────────────────────────────────────────────────
// Comportamento
// ─────────────────────────────────────────────────────────────────────────────

test('trocar de sub-aba NÃO recarrega os deslocamentos', () => {
  // Decisão de projeto: o conteúdo continua montado no DOM, só escondido.
  // Recarregar custaria o pipeline inteiro — ~25s na 1ª carga do dia (medido em
  // 28/08). Trocar de aba tem de ser instantâneo; quem recarrega é o Atualizar.
  const ini = SRC.indexOf('function switchDeslocSubtab');
  const fim = SRC.indexOf('function switchHistSubtab');
  assert.ok(ini > -1 && fim > ini, 'não achei switchDeslocSubtab');
  const corpo = SRC.slice(ini, fim);
  assert.ok(!/loadDeslocamentos\s*\(/.test(corpo),
    'switchDeslocSubtab voltou a chamar loadDeslocamentos — troca de aba ficaria lenta');
  assert.match(corpo, /display\s*=\s*'none'/, 'deveria esconder o painel inativo');
});

test('os dois botões chamam o switch com a chave do painel que existe', () => {
  const p = painelDesloc();
  for (const chave of ['elevado', 'tma']) {
    assert.ok(p.includes(`switchDeslocSubtab('${chave}')`),
      `o botão de '${chave}' não chama switchDeslocSubtab`);
    assert.ok(SRC.includes(`id="desloc-sub-${chave}"`),
      `switchDeslocSubtab('${chave}') aponta pra painel que não existe`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CSS
// ─────────────────────────────────────────────────────────────────────────────

test('o CSS das sub-abas cobre as novas classes sem duplicar regra', () => {
  // As regras do Histórico foram ESTENDIDAS (seletor com vírgula) em vez de
  // copiadas — se alguém duplicar o bloco, as duas cópias divergem com o tempo.
  assert.match(CSS, /\.hist-subtabs,\s*\n\s*\.desloc-subtabs \{/);
  assert.match(CSS, /\.hist-subtab-btn,\s*\n\s*\.desloc-subtab-btn \{/);
  assert.match(CSS, /\.hist-subtab-btn\.active,\s*\n\s*\.desloc-subtab-btn\.active \{/);
  assert.equal((CSS.match(/\.desloc-subtabs \{/g) || []).length, 1,
    'bloco .desloc-subtabs duplicado');
});

test('os comentários do CSS continuam balanceados', () => {
  // Um `*/` perdido engole as regras seguintes em silêncio — quase aconteceu
  // ao editar este bloco em 28/08.
  const abre  = (CSS.match(/\/\*/g) || []).length;
  const fecha = (CSS.match(/\*\//g) || []).length;
  assert.equal(abre, fecha, `comentários CSS desbalanceados: ${abre} abre, ${fecha} fecha`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Não quebrou o que já existia
// ─────────────────────────────────────────────────────────────────────────────

test('as sub-abas do Histórico seguem intactas', () => {
  assert.ok(SRC.includes("switchHistSubtab('sessoes')"));
  assert.ok(SRC.includes("switchHistSubtab('subcats')"));
  assert.equal((SRC.match(/id="hist-subtab-sessoes"/g) || []).length, 1);
});

test('a aba Deslocamentos continua registrada no balão de ações rápidas', () => {
  // O balão despacha o Atualizar por currentTab; a sub-aba não muda currentTab,
  // então o registro tem de continuar existindo e apontando pro mesmo loader.
  assert.match(SRC, /desloc:\s*\{\s*fn:\s*\(\)\s*=>\s*loadDeslocamentos\(\)/);
});
