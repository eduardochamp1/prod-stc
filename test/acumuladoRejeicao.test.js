/**
 * test/acumuladoRejeicao.test.js
 *
 * Tabela "Acumulado — Perda por Rejeição" da aba Gráficos.
 *
 * Não há harness de frontend (risco H11), mas as duas funções são PURAS —
 * então aqui elas são extraídas do index.html e EXECUTADAS, não conferidas
 * como texto. Mesmo padrão do test/equipesAdminTela.test.js.
 *
 * Spec: docs/handoff/SPEC-acumulado-rejeicao-2026-09-18.md
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/**
 * Extrai uma função do index.html casando as chaves.
 *
 * A lista de parâmetros é pulada casando os PARÊNTESES primeiro. Sem isso, um
 * parâmetro desestruturado — `function f(a, { b, c })` — faz o casamento de
 * chaves começar na chave do destructuring e terminar nela, devolvendo só a
 * assinatura, com um `SyntaxError` que não aponta a causa.
 */
function extrairFuncao(nome) {
  const marca = `function ${nome}(`;
  const ini   = SRC.indexOf(marca);
  assert.ok(ini > -1, `não achei ${marca} no index.html`);

  let paren = 0, fimParams = -1;
  for (let i = ini + marca.length - 1; i < SRC.length; i++) {
    if (SRC[i] === '(') paren++;
    else if (SRC[i] === ')') { paren--; if (paren === 0) { fimParams = i; break; } }
  }
  assert.ok(fimParams > -1, `parênteses não fecharam em ${nome}`);

  const abre = SRC.indexOf('{', fimParams);
  let nivel = 0;
  for (let i = abre; i < SRC.length; i++) {
    if (SRC[i] === '{') nivel++;
    else if (SRC[i] === '}') { nivel--; if (nivel === 0) return SRC.slice(ini, i + 1); }
  }
  throw new Error(`chaves não fecharam em ${nome}`);
}

/**
 * Carrega a função sob demanda, DENTRO de cada teste.
 *
 * Não faça isso no escopo do módulo: enquanto a função não existe no
 * index.html — que é o estado esperado na fase vermelha —, o `assert` do
 * extrairFuncao derruba o ARQUIVO inteiro no load, e os testes que já passavam
 * ficam vermelhos junto, parecendo regressão.
 */
function agrupar(...args) {
  const fn = new Function(
    `${extrairFuncao('_agruparPerdaPorRegional')}; return _agruparPerdaPorRegional;`)();
  return fn(...args);
}

/** Equipe no formato que o _buildEquipeTipoMatrix devolve. */
function eq(team_name, regional, total_exec, total_rej) {
  return { team_name, regional, total_exec, total_rej };
}

test('agrupa equipes de regionais diferentes em grupos distintos', () => {
  const g = agrupar([
    eq('EBGPR62', 'GUA', 100, 10),
    eq('ECACH50', 'CAC', 200, 20),
  ]);

  assert.equal(g.length, 2);
  assert.deepEqual(g.map(x => x.regional), ['CAC', 'GUA'], 'grupos vêm por nome');
});

test('atendidas = executadas + rejeitadas, por equipe e por grupo', () => {
  const [g] = agrupar([eq('EBGPR62', 'GUA', 90, 10)]);

  assert.equal(g.equipes[0].total_atend, 100);
  assert.equal(g.total_exec, 90);
  assert.equal(g.total_rej, 10);
  assert.equal(g.total_atend, 100);
});

test('taxa da equipe é rejeitadas ÷ atendidas', () => {
  const [g] = agrupar([eq('EBGPR62', 'GUA', 75, 25)]);
  assert.equal(g.equipes[0].taxa, 0.25);
});

test('A TAXA DA REGIONAL É PONDERADA — nunca a média das taxas das equipes', () => {
  // Armadilha da §6 do spec. Uma equipe com 1 rejeição em 2 notas (50%) e
  // outra com 10 em 1000 (1%) dão média simples de 25,5% — mas a perda real do
  // grupo é 11 em 1002, ou 1,1%. Média de percentual é um dos jeitos clássicos
  // de um número virar mentira num painel que a EDP audita.
  const [g] = agrupar([
    eq('EPEQUENA', 'GUA',   1,  1),   // 50,0%
    eq('EGRANDE',  'GUA', 990, 10),   //  1,0%
  ]);

  assert.equal(g.total_rej, 11);
  assert.equal(g.total_atend, 1002);
  assert.equal((g.taxa * 100).toFixed(1), '1.1');
  assert.notEqual((g.taxa * 100).toFixed(1), '25.5', 'caiu na média das taxas');
});

test('equipe sem rejeição tem taxa 0, não NaN', () => {
  const [g] = agrupar([eq('EBGPR62', 'GUA', 50, 0)]);
  assert.equal(g.equipes[0].taxa, 0);
  assert.ok(!Number.isNaN(g.taxa));
});

test('equipe sem nenhuma nota não gera divisão por zero', () => {
  const [g] = agrupar([eq('EVAZIA1', 'GUA', 0, 0)]);
  assert.equal(g.equipes[0].taxa, 0);
  assert.equal(g.taxa, 0);
  assert.ok(!Number.isNaN(g.taxa));
});

test('dentro do grupo: taxa desc, empate por volume desc, depois sigla', () => {
  const [g] = agrupar([
    eq('EBAIXA',  'GUA', 95,  5),   // 5,0%
    eq('EALTA',   'GUA', 70, 30),   // 30,0%
    eq('EMEDIA2', 'GUA', 40, 10),   // 20,0% — 50 atendidas
    eq('EMEDIA1', 'GUA', 80, 20),   // 20,0% — 100 atendidas (vem antes)
  ]);

  assert.deepEqual(g.equipes.map(e => e.team_name),
    ['EALTA', 'EMEDIA1', 'EMEDIA2', 'EBAIXA']);
});

test('empate total de taxa E volume resolve por sigla', () => {
  const [g] = agrupar([
    eq('EZZZ', 'GUA', 90, 10),
    eq('EAAA', 'GUA', 90, 10),
  ]);
  assert.deepEqual(g.equipes.map(e => e.team_name), ['EAAA', 'EZZZ']);
});

test('lista vazia devolve [] em vez de estourar', () => {
  assert.deepEqual(agrupar([]), []);
  assert.deepEqual(agrupar(null), []);
  assert.deepEqual(agrupar(undefined), []);
});

test('equipe sem regional cai num grupo próprio, não some', () => {
  // Esconder dado é contra a regra da casa. Se a regional vier vazia, a equipe
  // aparece num grupo "—" em vez de desaparecer da tabela.
  const g = agrupar([eq('ESEMREG', null, 10, 2)]);
  assert.equal(g.length, 1);
  assert.equal(g[0].equipes[0].team_name, 'ESEMREG');
});
