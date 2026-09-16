/**
 * test/multiSelectEscopo.test.js
 *
 * 16/09/2026 (P1-50) — trocar de conta sem recarregar deixava os dropdowns de
 * regional com a regional da conta ANTERIOR.
 *
 * Reportado enquanto se conferia o P1-49: logado como `cachoeiro` (escopo CAC),
 * as abas Rejeições, Deslocamentos, TMA, Notas e Gráficos mostravam "Guarapari"
 * e ficavam presas em "Carregando…" — a consulta saía com `regionals=GUA`, o
 * applyScope intersectava com ['CAC'], dava vazio e devolvia 403. Não era
 * vazamento: o `<select>` estava correto e o backend recusava.
 *
 * Causa: em applyUserPermissions a guarda do bloco de sincronia era
 * `window.MultiSelect`, que é SEMPRE undefined — `const MultiSelect` no topo de
 * um <script> não vira propriedade do window (só `var` vira), e nada nunca
 * atribuiu window.MultiSelect. O bloco era código morto: o `<select>` era podado
 * pro escopo certo, mas o componente seguia com os itens que leu no init.
 *
 * O Monitor escapava porque init() re-chama MultiSelect.init a cada login e o
 * init com instância existente cai em refresh(). As outras abas têm flags
 * _*MultiInited que não são resetadas no login.
 *
 * O mesmo erro já tinha sido corrigido DUAS vezes — f1a3ada (08/06, Monitor) e
 * b591dc3 (09/06, Notas) — e voltou em fbedb26 (11/06). Daí o teste-guarda.
 *
 * Aqui o componente roda de verdade, sobre um DOM mínimo de mentira: o que se
 * observa é o que ele renderizou (rótulo do botão e itens do painel), não a
 * estrutura do arquivo.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// ── DOM de mentira: o mínimo que o MultiSelect toca ──────────────────────────

class FakeEl {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.style = {};
    this.className = '';
    this.innerHTML = '';
    this.textContent = '';
    this.disabled = false;
    this._attrs = {};
    this._filhos = [];
    this._porSeletor = new Map();   // querySelector estável: mesmo nó a cada chamada
    this.classList = {
      _set: new Set(),
      add: (c) => this.classList._set.add(c),
      remove: (c) => this.classList._set.delete(c),
      contains: (c) => this.classList._set.has(c),
      toggle: (c, on) => (on ? this.classList._set.add(c) : this.classList._set.delete(c)),
    };
    this.parentNode = { insertBefore: () => {} };
    this.nextSibling = null;
  }
  setAttribute(k, v) { this._attrs[k] = v; }
  getAttribute(k) { return this._attrs[k]; }
  appendChild(el) { this._filhos.push(el); return el; }
  contains() { return false; }
  querySelector(sel) {
    if (!this._porSeletor.has(sel)) this._porSeletor.set(sel, new FakeEl());
    return this._porSeletor.get(sel);
  }
  querySelectorAll() { return []; }
}

/** <select> de mentira: `options` é a fonte de verdade, como no DOM real. */
class FakeSelect extends FakeEl {
  constructor(opcoes) {
    super('select');
    this.setOptions(opcoes);
  }
  /** Equivale ao `el.innerHTML = opts` que applyUserPermissions faz. */
  setOptions(opcoes) {
    this.options = opcoes.map(([value, label]) => ({ value, textContent: label }));
  }
  querySelector(sel) {
    const m = /^option\[value="([^"]+)"\]$/.exec(sel);
    if (m) return this.options.find(o => o.value === m[1]) || null;
    return super.querySelector(sel);
  }
}

/** Carrega o MultiSelect REAL do index.html sobre o DOM de mentira. */
function carregarMultiSelect(registro) {
  const ini = SRC.indexOf('const MultiSelect = (function () {');
  assert.ok(ini > -1, 'não achei a IIFE do MultiSelect');
  const marca = 'return { init, refresh, getValues, setAll, setValues, setDisabled };';
  const iFim = SRC.indexOf(marca, ini);
  assert.ok(iFim > ini, 'não achei o return da IIFE');
  const fim = SRC.indexOf('})();', iFim);
  assert.ok(fim > iFim, 'não achei o fecho da IIFE');
  const codigo = SRC.slice(ini, fim + '})();'.length);

  const document = {
    getElementById: (id) => registro[id] || null,
    createElement: (tag) => new FakeEl(tag),
    addEventListener: () => {},
  };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  return new Function('document', 'escapeHtml', `${codigo}; return MultiSelect;`)(document, escapeHtml);
}

// init() insere o wrap via sel.parentNode.insertBefore — captura ele ali.
const _insertBefore = function (wrap) { this._wrap = wrap; };

/** Versão de montar() que captura o wrap inserido. */
function montarCapturando(opcoes, opts = {}) {
  const registro = {};
  const sel = new FakeSelect(opcoes);
  sel.parentNode = { insertBefore: _insertBefore };
  registro.alvo = sel;
  const MultiSelect = carregarMultiSelect(registro);
  MultiSelect.init('alvo', opts);
  const wrap = sel.parentNode._wrap;
  assert.ok(wrap, 'init deveria ter inserido o wrap');
  const btn = wrap._filhos[0];
  const panel = wrap._filhos[1];
  return {
    MultiSelect, sel, btn, panel,
    rotulo: () => btn.querySelector('.ms-label').textContent,
    itens: () => panel.innerHTML,
    /** Só as siglas das linhas de item (sem a linha "Todas …" do topo). */
    siglas: () => [...panel.innerHTML.matchAll(/data-val="([^"]+)"/g)].map(m => m[1]),
    travado: () => btn.disabled,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// O guarda: o erro que voltou três vezes
// ─────────────────────────────────────────────────────────────────────────────

test('ninguém acessa MultiSelect pelo window — ele é const de escopo de script', () => {
  const linhas = SRC.split('\n')
    .map((l, i) => ({ n: i + 1, l }))
    .filter(({ l }) => /window\.MultiSelect/.test(l) && !l.trim().startsWith('//'));
  assert.deepEqual(linhas.map(x => x.n), [],
    'window.MultiSelect é SEMPRE undefined (const de topo de <script> não vai pro window). '
    + 'Use `typeof MultiSelect !== "undefined"`. Já quebrou em 08/06, 09/06 e 16/09.');
});

test('a sincronia em applyUserPermissions é alcançável', () => {
  const ini = SRC.indexOf('function applyUserPermissions(');
  const fim = SRC.indexOf('\n    function boot()', ini);
  const corpo = SRC.slice(ini, fim);
  assert.match(corpo, /typeof MultiSelect !== 'undefined' && MultiSelect\.getValues/);
  assert.match(corpo, /MultiSelect\.refresh\(id\)/,
    'sem o refresh, o componente fica com os itens da conta anterior');
});

// ─────────────────────────────────────────────────────────────────────────────
// O componente, rodando: a troca de conta
// ─────────────────────────────────────────────────────────────────────────────

test('refresh() troca os ITENS pelas siglas do escopo novo', () => {
  // Isto o refresh() SEMPRE fez certo — o defeito de 16/09 é que ninguém o
  // chamava. Fica pinado porque é a metade da correção que depende dele.
  const d = montarCapturando([['ALL', 'Todas (Guarapari)'], ['GUA', 'Guarapari']]);
  assert.deepEqual(d.siglas(), ['GUA']);

  // Login como cachoeiro: applyUserPermissions repopula o <select> e dá refresh.
  d.sel.setOptions([['ALL', 'Todas (Cachoeiro)'], ['CAC', 'Cachoeiro']]);
  d.MultiSelect.refresh('alvo');
  assert.deepEqual(d.siglas(), ['CAC']);
});

test('depois de trocar de conta, o painel não menciona a regional anterior', () => {
  // O invariante que o usuário enxerga. Falhava mesmo com os itens corretos,
  // porque a linha "Todas …" do topo do painel usa o allLabel, que não era
  // recalculado: o painel do `cachoeiro` continuava escrito "Todas (Guarapari)".
  const d = montarCapturando([['ALL', 'Todas (Guarapari)'], ['GUA', 'Guarapari']]);
  d.sel.setOptions([['ALL', 'Todas (Cachoeiro)'], ['CAC', 'Cachoeiro']]);
  d.MultiSelect.refresh('alvo');

  assert.match(d.itens(), /Cachoeiro/);
  assert.ok(!/Guarapari/.test(d.itens()),
    'este é o bug de 16/09: cachoeiro enxergava Guarapari no dropdown');
});

test('trocar de conta troca o RÓTULO "todas"', () => {
  const d = montarCapturando([['ALL', 'Todas (Guarapari)'], ['GUA', 'Guarapari']]);
  assert.equal(d.rotulo(), 'Todas (Guarapari)');

  d.sel.setOptions([['ALL', 'Todas (Cachoeiro)'], ['CAC', 'Cachoeiro']]);
  d.MultiSelect.refresh('alvo');

  assert.equal(d.rotulo(), 'Todas (Cachoeiro)',
    'os itens trocavam e o rótulo não — o botão seguia dizendo Guarapari');
});

test('rótulo fixado pelo call-site tem precedência e o refresh não o derruba', () => {
  // Monitor, Ranking e Histórico passam allLabel: 'Todas as Regionais'.
  const d = montarCapturando(
    [['ALL', 'Todas (Guarapari)'], ['GUA', 'Guarapari']],
    { allLabel: 'Todas as Regionais' },
  );
  assert.equal(d.rotulo(), 'Todas as Regionais');

  d.sel.setOptions([['ALL', 'Todas (Cachoeiro)'], ['CAC', 'Cachoeiro']]);
  d.MultiSelect.refresh('alvo');
  assert.equal(d.rotulo(), 'Todas as Regionais', 'o call-site manda');
});

test('select sem ALL (dropdown de equipe) mantém o rótulo ao ser repopulado', () => {
  // Os selects de equipe são repopulados sem <option value="ALL">; recalcular
  // ali cegamente faria o rótulo virar o genérico "Todas".
  const d = montarCapturando([['ALL', 'Todas as equipes'], ['E1', 'ECMSU50']]);
  assert.equal(d.rotulo(), 'Todas as equipes');

  d.sel.setOptions([['E1', 'ECMSU50'], ['E2', 'ECCIT90']]);
  d.MultiSelect.refresh('alvo');
  assert.equal(d.rotulo(), 'Todas as equipes');
});

test('depois do refresh, setValues casa a sigla nova em vez de cair no fallback', () => {
  // Era este o encadeamento que prendia a conta de 1 regional na regional
  // errada: _travarRegionalPorEscopo chamava setValues(['CAC']) sobre os itens
  // velhos, nada casava, o fallback marcava TUDO (= GUA) e então travava.
  const d = montarCapturando([['ALL', 'Todas (Guarapari)'], ['GUA', 'Guarapari']]);
  d.sel.setOptions([['ALL', 'Todas (Cachoeiro)'], ['CAC', 'Cachoeiro']]);
  d.MultiSelect.refresh('alvo');

  d.MultiSelect.setValues('alvo', ['CAC']);
  assert.equal(d.rotulo(), 'Todas (Cachoeiro)', 'CAC é a única do escopo → "todas"');
  assert.ok(!/Guarapari/.test(d.itens()));
});

test('sem o refresh, o fallback do setValues marca a regional ERRADA', () => {
  // Prova de que o refresh é o que corrige — sem ele o defeito reaparece.
  const d = montarCapturando([['ALL', 'Todas (Guarapari)'], ['GUA', 'Guarapari']]);
  d.sel.setOptions([['ALL', 'Todas (Cachoeiro)'], ['CAC', 'Cachoeiro']]);
  // (refresh propositalmente NÃO chamado)
  d.MultiSelect.setValues('alvo', ['CAC']);
  assert.match(d.itens(), /Guarapari/,
    'sem refresh o componente segue oferecendo a regional da conta anterior');
});
