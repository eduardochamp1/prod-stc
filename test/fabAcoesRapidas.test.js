/**
 * test/fabAcoesRapidas.test.js
 *
 * 28/08/2026 — balão lateral de ações rápidas
 * (docs/handoff/SPEC-balao-acoes-rapidas-2026-08-28.md, §11).
 *
 * O "⚡ Acordar WPA" e os NOVE "↻ Atualizar" (um por aba, e a aba Notas sem
 * nenhum) viraram um bloco `position: fixed` único, irmão dos `.tab-panel`. O
 * "Atualizar" despacha pro loader da aba ativa via `FAB_RECARREGAR[currentTab]`.
 *
 * ⚠️ O repo NÃO tem harness de frontend — a suíte é backend, sem jsdom. Então
 * estes testes leem `public/index.html` como TEXTO. Eles **não provam que o
 * balão abre**; a conferência de clique nas 9 abas foi feita à mão no navegador
 * em 28/08/2026 (num harness isolado servindo o app.css real).
 *
 * O que eles provam é o modo de falha que importa: **adicionar aba nova e
 * esquecer de registrar o loader**. Aí o botão do balão fica mudo naquela aba, e
 * mudo é exatamente o que ninguém percebe até a EDP perguntar.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(RAIZ, 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(RAIZ, 'public', 'css', 'app.css'), 'utf8');

/** Chaves registradas em FAB_RECARREGAR. */
function chavesDoRegistro() {
  const i = HTML.indexOf('const FAB_RECARREGAR = {');
  assert.ok(i > -1, 'FAB_RECARREGAR tem de existir em public/index.html');
  const j = HTML.indexOf('};', i);
  const bloco = HTML.slice(i, j);
  return bloco.match(/^\s{6}([a-z]+):\s*\{/gm).map(l => l.trim().replace(':', '').replace('{', '').trim());
}

/** Abas declaradas no HTML, pelos ids dos botões de aba. */
function abasDoHtml() {
  return [...new Set([...HTML.matchAll(/id="tab-btn-([a-z]+)"/g)].map(m => m[1]))];
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. O teste que importa: aba nova sem loader registrado
// ─────────────────────────────────────────────────────────────────────────────

test('toda aba do HTML tem loader registrado em FAB_RECARREGAR', () => {
  const abas = abasDoHtml();
  const chaves = chavesDoRegistro();
  assert.ok(abas.length >= 9, `esperava ao menos as 9 abas conhecidas, achei ${abas.length}`);

  const semLoader = abas.filter(a => !chaves.includes(a));
  assert.deepEqual(semLoader, [],
    `abas sem entrada em FAB_RECARREGAR: ${semLoader.join(', ')}\n` +
    'Sem isso o "↻ Atualizar" do balão fica MUDO nessas abas. Registre no mesmo commit.');
});

test('FAB_RECARREGAR não registra aba que não existe mais', () => {
  // Aba removida e loader esquecido no mapa: entrada morta que ninguém alcança.
  const abas = abasDoHtml();
  const orfas = chavesDoRegistro().filter(k => !abas.includes(k));
  assert.deepEqual(orfas, [], `chaves sem aba correspondente: ${orfas.join(', ')}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. A migração literal do btn-warm
// ─────────────────────────────────────────────────────────────────────────────

test('id="btn-warm" aparece exatamente uma vez', () => {
  // acordarWpa() mexe no innerHTML e no disabled desse id pra dar feedback.
  // Duplicar o id faz getElementById pegar só o primeiro — o outro botão fica
  // sem feedback nenhum e parece travado.
  const n = HTML.split('id="btn-warm"').length - 1;
  assert.equal(n, 1, `id="btn-warm" aparece ${n}x — HTML inválido e feedback quebrado`);
});

test('acordarWpa() continua falando com o id btn-warm', () => {
  const i = HTML.indexOf('function acordarWpa(');
  assert.ok(i > -1, 'acordarWpa() tem de existir');
  const corpo = HTML.slice(i, i + 2000);
  assert.match(corpo, /getElementById\('btn-warm'\)/,
    'se o id mudar, o feedback do botão quebra em silêncio');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Nenhum "Atualizar" sobrou dentro de aba
// ─────────────────────────────────────────────────────────────────────────────

test('só existe UM botão "↻ Atualizar", o do balão', () => {
  const n = HTML.split('>↻ Atualizar</button>').length - 1;
  assert.equal(n, 1,
    `achei ${n} botões "↻ Atualizar" — o balão substituiu os 8 por aba.\n` +
    'Se voltou um pra dentro de uma aba, o painel volta a ter dois caminhos pro mesmo load.');
});

test('o "↻ Atualizar" que existe é o do balão e chama fabRecarregar()', () => {
  const i = HTML.indexOf('>↻ Atualizar</button>');
  const linha = HTML.slice(HTML.lastIndexOf('<', i), i + 30);
  assert.match(linha, /id="fab-btn-atualizar"/);
  assert.match(linha, /onclick="fabRecarregar\(\)"/);
});

test('o balão fica FORA de todos os .tab-panel', () => {
  // É isso que faz ele aparecer nas 9 abas sem repetir markup. Se cair dentro de
  // um .tab-panel, ele desaparece nas outras 8 — e o bug parece intermitente.
  const iFab = HTML.indexOf('<div class="fab-acoes" id="fab-acoes">');
  assert.ok(iFab > -1, 'o markup do balão tem de existir');

  const paineis = [...HTML.matchAll(/class="tab-panel[^"]*"/g)].map(m => m.index);
  assert.ok(paineis.length >= 8, `esperava vários .tab-panel, achei ${paineis.length}`);
  assert.ok(iFab > Math.max(...paineis),
    'o balão aparece ANTES do último .tab-panel — provavelmente está dentro de um');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Todo loader do registro existe de verdade
// ─────────────────────────────────────────────────────────────────────────────

test('toda fn do registro aponta pra função declarada no arquivo', () => {
  const i = HTML.indexOf('const FAB_RECARREGAR = {');
  const bloco = HTML.slice(i, HTML.indexOf('};', i));
  const nomes = [...bloco.matchAll(/fn:\s*\(\)\s*=>\s*([A-Za-z0-9_]+)\(/g)].map(m => m[1]);
  assert.equal(nomes.length, chavesDoRegistro().length,
    'toda entrada tem de ter uma fn arrow-wrapped');

  const ausentes = nomes.filter(n => !HTML.includes(`function ${n}(`));
  assert.deepEqual(ausentes, [],
    `fn aponta pra função que não existe: ${ausentes.join(', ')}\n` +
    'Arrow-wrapped não estoura no carregamento — só no clique. Por isso o teste.');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. CSS: o painel fechado tem de sumir de verdade
// ─────────────────────────────────────────────────────────────────────────────

test('CSS respeita o atributo hidden do painel', () => {
  // Achado em 28/08/2026 durante a conferência no navegador: `.fab-acoes-painel
  // { display: flex }` GANHA do `[hidden] { display: none }` do navegador —
  // atributo não vence declaração de autor. Sem a regra abaixo o painel fechado
  // renderizava uma lasca com borda e sombra colada na borda direita, sempre.
  assert.match(CSS, /\.fab-acoes-painel\[hidden\]\s*\{\s*display:\s*none/,
    'sem esta regra o painel fechado vaza uma lasca visível na borda direita');
});

test('CSS não deixa padding fixo no painel fechado', () => {
  // Mesmo achado: com box-sizing:border-box, `padding: 12px` fixo não cabe em
  // `max-width: 0` — o painel encolhia até ~26px em vez de zero.
  const i = CSS.indexOf('.fab-acoes-painel {');
  const bloco = CSS.slice(i, CSS.indexOf('}', i));
  assert.match(bloco, /padding:\s*0\s*;/, 'o painel fechado tem de ter padding 0');
  const iAberto = CSS.indexOf('.fab-acoes.aberto .fab-acoes-painel {');
  const blocoAberto = CSS.slice(iAberto, CSS.indexOf('}', iAberto));
  assert.match(blocoAberto, /padding:\s*12px/, 'o padding real entra no estado aberto');
});

test('CSS mantém o balão abaixo dos modais', () => {
  // z-index 900: acima do conteúdo, abaixo de .ms-panel/.mapa-team-dd-panel
  // (1000) e do #login-overlay (9999). Se subir, cobre modal aberto.
  const i = CSS.indexOf('.fab-acoes {');
  const bloco = CSS.slice(i, CSS.indexOf('}', i));
  const m = bloco.match(/z-index:\s*(\d+)/);
  assert.ok(m, '.fab-acoes precisa de z-index explícito');
  assert.ok(Number(m[1]) < 1000,
    `z-index ${m[1]} — tem de ficar abaixo de 1000, que é onde vivem os modais`);
});
