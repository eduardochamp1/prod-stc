/**
 * test/monitorFunilDiag.test.js
 *
 * 31/08/2026 — caixa-preta do funil de exibição do Monitor.
 *
 * ORIGEM: em 30/08 o painel filtrado em São José dos Campos mostrou "0 equipes
 * em campo" enquanto 8 das 10 equipes de SJC tinham sessão ABERTA gravada em
 * `snapshots` e o backend as devolvia. No dia seguinte o mesmo caminho entregou
 * 127 de 127 sem descartar nada. É intermitente — e quatro hipóteses foram
 * levantadas e refutadas antes de aceitar isso.
 *
 * O diagnóstico é código que só roda quando algo já deu errado, então ele é
 * justamente o tipo de código que ninguém percebe estar quebrado. Por isso os
 * testes aqui são de COMPORTAMENTO, não de string: o `getVisible` real é
 * recortado do HTML e executado contra stubs.
 *
 * Limite explícito: isto prova a contagem e a blindagem do diagnóstico. NÃO
 * prova que a tela renderiza — conferência visual segue manual.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** Recorta `_monDiagRegistrar` + `getVisible` do monólito. */
function recortarFonte() {
  const ini = SRC.indexOf('function _monDiagRegistrar(');
  assert.ok(ini > -1, 'não achei _monDiagRegistrar em public/index.html');
  const marcaFim = SRC.indexOf('return out;', ini);
  assert.ok(marcaFim > ini, 'não achei o `return out;` do getVisible');
  const fim = SRC.indexOf('\n    }', marcaFim);
  assert.ok(fim > marcaFim, 'não achei o fechamento do getVisible');
  return SRC.slice(ini, fim + '\n    }'.length);
}

const FONTE = recortarFonte();

/**
 * Monta um `getVisible` isolado. `ctx` sobrescreve os padrões — tudo que o
 * código real lê do escopo do <script> entra por aqui.
 */
function montar(ctx = {}) {
  const avisos = [];
  const base = {
    _monitorScope: 'ativas',
    _deslogadas: null,
    allTeams: [],
    _monEquipesSelecionadas: () => null,
    _regionalMatch: () => true,
    currentFilter: '',
    selectedRegionals: [],
    _lastColeta: null,
    _teamsLoading: false,
    window: {},
    console: { warn: (...a) => avisos.push(a) },
  };
  const full = { ...base, ...ctx };
  const factory = new Function('ctx', `
    const { _monitorScope, _deslogadas, allTeams, _monEquipesSelecionadas,
            _regionalMatch, currentFilter, selectedRegionals, _lastColeta,
            _teamsLoading, window, console } = ctx;
    ${FONTE}
    return getVisible;
  `);
  return { getVisible: factory(full), ctx: full, avisos };
}

const eq = (sigla, regional, colabs = []) =>
  ({ sigla, teamName: sigla, regional, collaborators: colabs });

const ultimo = w => w.__monDiag[w.__monDiag.length - 1];

// ─────────────────────────────────────────────────────────────────────────────
// O resultado do filtro não muda — o diagnóstico só conta
// ─────────────────────────────────────────────────────────────────────────────

test('sem filtro ativo, todas passam e nada é debitado', () => {
  const { getVisible, ctx } = montar({ allTeams: [eq('A', 'GUA'), eq('B', 'SJC')] });
  assert.deepEqual(getVisible().map(t => t.sigla), ['A', 'B']);
  assert.deepEqual(ultimo(ctx.window).cortes, { regional: 0, equipe: 0, busca: 0 });
  assert.equal(ultimo(ctx.window).recebidas, 2);
  assert.equal(ultimo(ctx.window).visiveis, 2);
});

test('getVisible devolve as equipes, não o diagnóstico', () => {
  const { getVisible } = montar({ allTeams: [eq('A', 'GUA')] });
  const out = getVisible();
  assert.ok(Array.isArray(out));
  assert.equal(out[0].sigla, 'A');
});

// ─────────────────────────────────────────────────────────────────────────────
// Cada corte é debitado do filtro certo — é isso que o próximo incidente lê
// ─────────────────────────────────────────────────────────────────────────────

test('corte por regional é debitado em cortes.regional', () => {
  const { getVisible, ctx } = montar({
    allTeams: [eq('A', 'GUA'), eq('B', 'SJC'), eq('C', 'SJC')],
    _regionalMatch: r => r === 'SJC',
  });
  assert.deepEqual(getVisible().map(t => t.sigla), ['B', 'C']);
  assert.equal(ultimo(ctx.window).cortes.regional, 1);
});

test('corte pelo filtro de equipes é debitado em cortes.equipe', () => {
  const { getVisible, ctx } = montar({
    allTeams: [eq('A', 'GUA'), eq('B', 'GUA')],
    _monEquipesSelecionadas: () => new Set(['A']),
  });
  assert.deepEqual(getVisible().map(t => t.sigla), ['A']);
  assert.equal(ultimo(ctx.window).cortes.equipe, 1);
  assert.equal(ultimo(ctx.window).filtroEquipes, 1);
});

test('corte pela busca é debitado em cortes.busca, e casa por colaborador', () => {
  const { getVisible, ctx } = montar({
    allTeams: [eq('EPMRT30', 'GUA'), eq('ECMSJ81', 'SJC', [{ nome: 'Mariana' }])],
    currentFilter: 'mari',
  });
  assert.deepEqual(getVisible().map(t => t.sigla), ['ECMSJ81'], 'casa pelo nome do colaborador');
  assert.equal(ultimo(ctx.window).cortes.busca, 1);
});

test('equipe barrada por dois filtros conta só no primeiro', () => {
  // O curto-circuito é deliberado: interessa saber ONDE a equipe caiu primeiro,
  // não em quantos predicados ela falharia.
  const { getVisible, ctx } = montar({
    allTeams: [eq('A', 'GUA')],
    _regionalMatch: () => false,
    _monEquipesSelecionadas: () => new Set(['ZZZ']),
  });
  assert.equal(getVisible().length, 0);
  assert.deepEqual(ultimo(ctx.window).cortes, { regional: 1, equipe: 0, busca: 0 });
});

// ─────────────────────────────────────────────────────────────────────────────
// As duas assinaturas de falha, que confundi durante todo o dia 31/08
// ─────────────────────────────────────────────────────────────────────────────

test('"funil zerou" dispara quando chegou gente e nada passou', () => {
  const { getVisible, avisos } = montar({
    allTeams: [eq('A', 'SJC'), eq('B', 'SJC')],
    _regionalMatch: () => false,
  });
  getVisible();
  assert.equal(avisos.length, 1);
  assert.match(String(avisos[0][0]), /funil zerou/);
});

test('"nenhuma equipe recebida" é aviso DIFERENTE — coleta, não funil', () => {
  const { getVisible, avisos } = montar({ allTeams: [] });
  getVisible();
  assert.equal(avisos.length, 1);
  assert.match(String(avisos[0][0]), /nenhuma equipe recebida/);
});

test('pool vazio durante o fetch não vira aviso', () => {
  // Sem isso, todo carregamento normal cospe um falso alarme e o aviso de
  // verdade some no meio do ruído.
  const { getVisible, avisos } = montar({ allTeams: [], _teamsLoading: true });
  getVisible();
  assert.equal(avisos.length, 0);
});

test('render saudável não avisa nada', () => {
  const { getVisible, avisos } = montar({ allTeams: [eq('A', 'GUA')] });
  getVisible();
  assert.equal(avisos.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Contexto capturado — é o que decide o próximo incidente
// ─────────────────────────────────────────────────────────────────────────────

test('o registro carrega o estado que distingue as hipóteses', () => {
  const { getVisible, ctx } = montar({
    allTeams: [eq('A', 'SJC')],
    selectedRegionals: ['SJC'],
    currentFilter: 'xyz',
    _monitorScope: 'todas',
    _deslogadas: [],
    _lastColeta: { degradado: true, regionais: { SJC: { status: 'timeout' }, GUA: { status: 'ok' } } },
  });
  getVisible();
  const r = ultimo(ctx.window);
  assert.deepEqual(r.selectedRegionals, ['SJC']);
  assert.equal(r.busca, 'xyz');
  assert.equal(r.escopo, 'todas');
  assert.equal(r.coleta.degradado, true);
  assert.deepEqual(r.coleta.regionais, { SJC: 'timeout', GUA: 'ok' });
  assert.match(r.hora, /^\d{2}:\d{2}:\d{2}$/);
});

test('selectedRegionals é copiado, não referenciado', () => {
  // Guardar a referência viva faria todo registro antigo mostrar o filtro
  // ATUAL — a caixa-preta mentiria exatamente na pergunta que ela existe pra
  // responder ("qual era o filtro quando zerou?").
  const regs = ['SJC'];
  const { getVisible, ctx } = montar({ allTeams: [eq('A', 'SJC')], selectedRegionals: regs });
  getVisible();
  regs.push('GUA');
  assert.deepEqual(ultimo(ctx.window).selectedRegionals, ['SJC']);
});

test('escopo "todas" soma as deslogadas ao pool', () => {
  const { getVisible, ctx } = montar({
    _monitorScope: 'todas',
    allTeams: [eq('A', 'GUA')],
    _deslogadas: [eq('B', 'GUA')],
  });
  assert.equal(getVisible().length, 2);
  assert.equal(ultimo(ctx.window).recebidas, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// Blindagem — diagnóstico não pode derrubar o painel
// ─────────────────────────────────────────────────────────────────────────────

test('o buffer para em 20 registros', () => {
  const { getVisible, ctx } = montar({ allTeams: [eq('A', 'GUA')] });
  for (let i = 0; i < 25; i++) getVisible();
  assert.equal(ctx.window.__monDiag.length, 20);
});

test('diagnóstico que explode não impede o render', () => {
  // Mesma regra do filtro de equipes (incidente 30/07/2026): nada que seja
  // apresentação ou instrumentação pode zerar a tela.
  const windowRuim = Object.defineProperty({}, '__monDiag', {
    get() { throw new Error('storage inacessível'); },
    configurable: true,
  });
  const { getVisible, avisos } = montar({ allTeams: [eq('A', 'GUA')], window: windowRuim });
  assert.deepEqual(getVisible().map(t => t.sigla), ['A'], 'a lista tem de sair mesmo assim');
  assert.match(String(avisos[0][0]), /diag falhou/);
});

test('console indisponível também não derruba o render', () => {
  const { getVisible } = montar({
    allTeams: [eq('A', 'GUA')],
    _regionalMatch: () => false,
    console: { warn() { throw new Error('sem console'); } },
  });
  assert.deepEqual(getVisible(), []);
});
