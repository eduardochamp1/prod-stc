/**
 * test/graficosFiltroTipos.test.js
 *
 * 14/10/2026 — José: "esse filtro [Tipos] não está aplicando em todas as tabelas e
 * gráficos da aba de gráficos". A matriz "EXEC × Rejeitadas" e o "Acumulado — Perda
 * por Rejeição" ignoravam o filtro. Agora as duas usam `_matrizRecortarTipos`.
 *
 * A função é extraída do index.html e EXECUTADA (vm), junto com
 * `_agruparPerdaPorRegional`, pra provar que TOTAL e Acumulado fecham com as
 * colunas visíveis.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// CRLF → LF (P3-21): clone Windows com autocrlf.
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');

function extrai(nome) {
  const i = HTML.indexOf(`function ${nome}(`);
  assert.ok(i >= 0, `${nome} não existe no index.html`);
  const j = HTML.indexOf('\n    }\n', i) + 7;
  return HTML.slice(i, j);
}
const ctx = {};
vm.createContext(ctx);
vm.runInContext(extrai('_matrizRecortarTipos') + '\n' + extrai('_agruparPerdaPorRegional'), ctx);
const recortar = (eqs, tipos, todos = false) => ctx._matrizRecortarTipos(eqs, new Set(tipos), todos);

const eq = (team_name, regional, exec, rej, extra = {}) => {
  const soma = (o) => Object.values(o).reduce((s, v) => s + v, 0);
  return { team_name, regional, exec, rej, interr: {}, total_exec: soma(exec), total_rej: soma(rej),
    total_interr: 0, total_remota: 0, total_ramal: 0, ...extra };
};
const EQS = [
  eq('ECA', 'GUA', { SF: 10, MD: 5, OS: 2 }, { SF: 4, MD: 1 }),
  eq('ECB', 'GUA', { MD: 8 }, { MD: 2 }),                                  // sem SF
  eq('ECC', 'CAC', { SF: 3, II: 6, DD: 2 }, { SF: 1 }, { total_remota: 4, total_ramal: 9 }),
];

describe('_matrizRecortarTipos', () => {
  test('todos os tipos marcados → a MESMA lista, intocada', () => {
    assert.equal(recortar(EQS, ['SF'], true), EQS);
  });
  test('só SF: colunas e TOTAIS recalculados só com SF', () => {
    const r = recortar(EQS, ['SF']);
    const a = r.find(e => e.team_name === 'ECA');
    assert.deepEqual(JSON.parse(JSON.stringify(a.exec)), { SF: 10 });
    assert.deepEqual(JSON.parse(JSON.stringify(a.rej)), { SF: 4 });
    assert.equal(a.total_exec, 10, 'antes era 17 (SF+MD+OS)');
    assert.equal(a.total_rej, 4, 'antes era 5');
  });
  test('equipe sem nada nos tipos marcados SAI da matriz', () => {
    assert.deepEqual(recortar(EQS, ['SF']).map(e => e.team_name), ['ECA', 'ECC']);
  });
  test('tipos que só existem nos dados (OS, VL…) somem quando há filtro', () => {
    const r = recortar(EQS, ['MD']);
    assert.equal('OS' in r.find(e => e.team_name === 'ECA').exec, false);
  });
  test('REMOTAS só com II marcado; RAMAIS só com DD marcado', () => {
    const c1 = recortar(EQS, ['SF']).find(e => e.team_name === 'ECC');
    assert.equal(c1.total_remota, 0);
    assert.equal(c1.total_ramal, 0);
    const c2 = recortar(EQS, ['II', 'DD']).find(e => e.team_name === 'ECC');
    assert.equal(c2.total_remota, 4);
    assert.equal(c2.total_ramal, 9);
  });
  test('reordena pelos totais RECORTADOS (exec + rej desc)', () => {
    const r = recortar(EQS, ['MD']);
    assert.deepEqual(r.map(e => [e.team_name, e.total_exec + e.total_rej]), [['ECB', 10], ['ECA', 6]]);
  });
  test('nenhum tipo marcado → matriz vazia', () => {
    assert.deepEqual([...recortar(EQS, [])], []);
  });
  test('não muta a entrada', () => {
    const copia = JSON.stringify(EQS);
    recortar(EQS, ['SF']);
    assert.equal(JSON.stringify(EQS), copia);
  });
});

describe('aritmética: TOTAL da matriz e Acumulado fecham com as colunas visíveis', () => {
  test('Acumulado recortado = soma das colunas SF da matriz, por regional', () => {
    const r = recortar(EQS, ['SF']);
    const grupos = ctx._agruparPerdaPorRegional(r);
    const gua = grupos.find(g => g.regional === 'GUA');
    const cac = grupos.find(g => g.regional === 'CAC');
    assert.equal(gua.total_exec, 10);
    assert.equal(gua.total_rej, 4);
    assert.equal(cac.total_exec, 3);
    assert.equal(cac.total_rej, 1);
    for (const e of r) {
      const colunas = Object.values(e.exec).reduce((s, v) => s + v, 0);
      assert.equal(e.total_exec, colunas, `${e.team_name}: TOTAL = soma das colunas visíveis`);
    }
  });
});

describe('ligação na aba Gráficos (fonte)', () => {
  test('matriz E Acumulado usam a MESMA lista recortada', () => {
    assert.match(HTML, /const matrizEquipes = _matrizRecortarTipos\(\s*\(matrizData && matrizData\.equipes\) \|\| \[\], tiposVisiveis, todosOsTiposMarcados\);/);
    assert.match(HTML, /const eqs = matrizEquipes;/);
    assert.match(HTML, /_agruparPerdaPorRegional\(matrizEquipes/);
  });
  test('as colunas de tipo da matriz também seguem o filtro', () => {
    assert.match(HTML, /\.filter\(t => todosOsTiposMarcados \|\| tiposVisiveis\.has\(t\)\)/);
  });
  test('o título da matriz mostra os tipos filtrados (texto escapado)', () => {
    assert.match(HTML, /EXEC × Rejeitadas por Equipe\$\{_tiposFiltroLabel\}/);
    assert.match(HTML, /tipos: \$\{escapeHtml\(\[\.\.\.tiposVisiveis\]/);
  });
});
