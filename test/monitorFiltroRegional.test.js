/**
 * test/monitorFiltroRegional.test.js
 *
 * 31/08/2026 — os DOIS defeitos que faziam o filtro de regional mentir.
 *
 * (1) ZERO AO TROCAR DE REGIONAL. `allTeams` vem do backend já filtrado
 *     (`/api/teams?regionals=…`), então NÃO é superconjunto. `selectRegional`
 *     terminava em `renderAll()` sem rebuscar: trocar Guarapari → São José
 *     mandava `_regionalMatch` filtrar dados de GUA por 'SJC', tudo caía, e a
 *     tela dizia "Nenhuma equipe encontrada" até o auto-refresh de 5min.
 *     Reportado em 30/08 como "o portal da EDP mostra 21 equipes do DSSJ e o
 *     painel filtrado em São José mostra 0".
 *
 * (2) DROPDOWN DESSINCRONIZADO. `MultiSelect.init` sempre começa com tudo
 *     marcado e ignora o <select> original, mas `applySavedFilters()` roda
 *     ANTES e pode ter deixado `selectedRegionals` num subconjunto. Resultado:
 *     as três regionais marcadas na tela e os dados de uma só. Reportado em
 *     31/08 como "recarrego a página e vem pré-carregada com alguma regional
 *     filtrada".
 *
 * Os dois são independentes: consertar um não conserta o outro.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** Recorta uma função nomeada do monólito, do `function X(` até o fecho. */
function recortar(nome, marcaFim) {
  const ini = SRC.indexOf(`function ${nome}(`);
  assert.ok(ini > -1, `não achei ${nome} em public/index.html`);
  const alvo = SRC.indexOf(marcaFim, ini);
  assert.ok(alvo > ini, `não achei o fecho de ${nome}`);
  return SRC.slice(ini, alvo + marcaFim.length);
}

const _cobrePeloCache = new Function(
  `${recortar('_cobrePeloCache', '\n    }')}; return _cobrePeloCache;`)();

// ─────────────────────────────────────────────────────────────────────────────
// (1) Quando dá pra filtrar local e quando TEM de rebuscar
// ─────────────────────────────────────────────────────────────────────────────

test('estreitar a seleção é filtro local — não vai à rede', () => {
  assert.equal(_cobrePeloCache(['SJC'], ['GUA', 'CAC', 'SJC']), true);
  assert.equal(_cobrePeloCache(['GUA', 'CAC'], ['GUA', 'CAC', 'SJC']), true);
  assert.equal(_cobrePeloCache(['GUA'], ['GUA']), true, 'mesma seleção');
});

test('TROCAR de regional exige rebuscar — este é o bug de 30/08', () => {
  // O caso exato: a página tinha dados de Guarapari e o usuário marcou São José.
  assert.equal(_cobrePeloCache(['SJC'], ['GUA']), false);
  assert.equal(_cobrePeloCache(['GUA'], ['SJC']), false);
  assert.equal(_cobrePeloCache(['CAC'], ['GUA', 'SJC']), false);
});

test('ALARGAR a seleção exige rebuscar', () => {
  // Sem isto a regional recém-marcada aparece vazia: ninguém buscou os dados
  // dela, e nenhum filtro local inventa equipe que não veio.
  assert.equal(_cobrePeloCache(['GUA', 'SJC'], ['SJC']), false);
  assert.equal(_cobrePeloCache(['GUA', 'CAC', 'SJC'], ['GUA', 'CAC']), false);
});

test('sem busca anterior, rebusca — nunca renderiza contra nada', () => {
  assert.equal(_cobrePeloCache(['SJC'], null), false);
  assert.equal(_cobrePeloCache(['SJC'], []), false);
  assert.equal(_cobrePeloCache(['SJC'], undefined), false);
});

test('seleção vazia rebusca em vez de assumir "todas"', () => {
  // Vazio significa "todas" em `_syncCurrentRegional`, e "todas" quase nunca
  // está contido numa busca anterior. Rebuscar é a resposta segura.
  assert.equal(_cobrePeloCache([], ['GUA']), false);
  assert.equal(_cobrePeloCache(null, ['GUA']), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// (1) A ligação no selectRegional — a função pura não vale nada solta
// ─────────────────────────────────────────────────────────────────────────────

test('selectRegional decide entre renderAll e loadData', () => {
  const corpo = recortar('selectRegional', '\n    }');
  assert.match(corpo, /_cobrePeloCache\(selectedRegionals,\s*_teamsFetchedFor\)/,
    'a decisão tem de usar o que a última busca cobriu');
  assert.match(corpo, /else\s+loadData\(\)/, 'sem cobertura, rebusca');
  assert.doesNotMatch(corpo, /saveFilters\(\);\s*renderAll\(\);\s*\}/,
    'o `renderAll()` seco no fim era exatamente o bug');
});

test('loadData grava o que a resposta cobre, lido ANTES do fetch', () => {
  const ini = SRC.indexOf('const _pedidoPara');
  assert.ok(ini > -1, 'não achei a captura de _pedidoPara');
  const urlIdx = SRC.indexOf('const url = hist', ini);
  const fetchIdx = SRC.indexOf('await Promise.all', ini);
  const gravaIdx = SRC.indexOf('_teamsFetchedFor = _pedidoPara', ini);
  assert.ok(ini < urlIdx && urlIdx < fetchIdx,
    'a captura tem de vir antes da montagem da URL e do fetch');
  assert.ok(gravaIdx > fetchIdx,
    'a gravação tem de vir depois da resposta — senão mente em caso de erro');
  // Cópia, não referência: `selectedRegionals` é reatribuído por selectRegional,
  // e guardar a referência viva faria o cache mentir sobre o payload.
  assert.match(SRC.slice(ini, urlIdx), /\[\.\.\.selectedRegionals\]/);
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) O dropdown que mostrava três marcadas com dados de uma
// ─────────────────────────────────────────────────────────────────────────────

test('o filtro regional do Monitor é sincronizado depois do init', () => {
  const ini = SRC.indexOf("MultiSelect.init('regional-select'");
  assert.ok(ini > -1, 'não achei o init do filtro regional do Monitor');
  const trecho = SRC.slice(ini, ini + 2600);
  assert.match(trecho, /MultiSelect\.setValues\('regional-select',\s*\[\.\.\.selectedRegionals\]\)/,
    'sem isto o balão mostra tudo marcado e os dados vêm de uma regional só');
});

test('o sync roda DEPOIS de applySavedFilters — a ordem é o bug', () => {
  const aplica = SRC.indexOf('await applySavedFilters()');
  const sync = SRC.indexOf("MultiSelect.setValues('regional-select'");
  assert.ok(aplica > -1 && sync > aplica,
    'sincronizar antes de restaurar o filtro salvo não corrige nada');
});

test('o sync não pode derrubar o boot', () => {
  const ini = SRC.indexOf("MultiSelect.setValues('regional-select'");
  const antes = SRC.slice(Math.max(0, ini - 200), ini);
  assert.match(antes, /try\s*\{\s*$/m,
    'filtro é apresentação: falha nele não pode impedir a página de carregar');
});

// ─────────────────────────────────────────────────────────────────────────────
// O Mapa já fazia certo — se ele regredir, o modelo se perde
// ─────────────────────────────────────────────────────────────────────────────

test('o Mapa continua sincronizando o dropdown dele', () => {
  const ini = SRC.indexOf("MultiSelect.init('mapa-regional-select'");
  assert.ok(ini > -1);
  assert.match(SRC.slice(ini, ini + 900),
    /MultiSelect\.setValues\('mapa-regional-select',\s*\[\.\.\.selectedRegionals\]\)/);
});
