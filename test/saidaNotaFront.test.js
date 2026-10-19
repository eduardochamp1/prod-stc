/**
 * test/saidaNotaFront.test.js — a aba "Saída da nota" (P2-70) no index.html.
 *
 * O repo não tem harness de frontend (sem jsdom): estes testes leem o HTML como
 * TEXTO e rodam as funções puras num `vm`. Provam o que costuma quebrar calado:
 * aba sem loader, Ranking pela metade, Carteira perdida na mudança para Gráficos
 * (Q1 da spec) e dado da EDP em onclick sem escape (P2-40).
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const vm     = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');

function extrai(nome) {
  const i = HTML.indexOf(`function ${nome}(`);
  assert.ok(i >= 0, `${nome} não existe no index.html`);
  const j = HTML.indexOf('\n    }\n', i) + 7;
  return HTML.slice(i, j);
}

test('aba Saída da nota existe, tem loader, recarga e regional sincronizada', () => {
  assert.match(HTML, /id="tab-btn-saida" onclick="switchTab\('saida'\)"/);
  assert.match(HTML, /<div class="tab-panel" id="tab-saida">/);
  assert.match(HTML, /if \(tab === 'saida'\)\s+loadSaidaNota\(\);/);
  assert.match(HTML, /saida:\s+'saida-regional-select'/);
  assert.match(HTML, /saida:\s+\{ fn: \(\) => loadSaidaNota\(\)/);
  assert.match(HTML, /'regional-select', 'saida-regional-select'/);
  assert.ok(HTML.includes(`_supPopularSelect('saida-supervisor-select')`));
});

test('Ranking saiu por inteiro (botão, painel, loader e registros)', () => {
  for (const resto of ['tab-btn-ranking', 'id="tab-ranking"', 'loadRanking', 'renderRanking',
    'ranking-regional-select', 'ranking-supervisor-select', 'ranking-mes-input']) {
    assert.ok(!HTML.includes(resto), `sobrou "${resto}"`);
  }
});

test('Aproveitamento da Carteira mudou para Gráficos, com tabela e XLSX (Q1)', () => {
  const graf = HTML.slice(HTML.indexOf('function renderGraficosHTML('));
  assert.match(graf, /id="graf-carteira-wrap"/);
  assert.match(graf, /id="carteira-content"/);
  assert.match(graf, /onclick="downloadCarteiraXLSX\(\)"/);
  assert.match(extrai('loadGraficos'), /loadCarteiraAproveitamento\(de, ate, regionalsCsv, _teamsEf\)/);
  // continua existindo uma única vez
  assert.equal(HTML.split('id="carteira-content"').length - 1, 1);
});

test('id da nota no onclick passa por escapeJsAttr (P2-40)', () => {
  assert.match(HTML, /toggleSaidaDetalhe\(\$\{i\}, '\$\{escapeJsAttr\(o\.notas\[0\]\.note_id\)\}'\)/);
});

test('funções puras: distância, período padrão e recorte de equipes', () => {
  const ctx = { _supEquipes: [
    { sigla: 'ECCIT50', regional: 'GUA' }, { sigla: 'EPCIT30', regional: 'GUA' },
    { sigla: 'ECCSJ80', regional: 'SJC' },
  ], document: { getElementById: (id) => ({ value: ctx._valores[id] }) }, _valores: {} };
  ctx._supSiglasDoSelect = (id) => ctx._sup || null;
  vm.createContext(ctx);
  vm.runInContext([extrai('_saidaDist'), extrai('_saidaPeriodoPadrao'), extrai('_saidaEquipesFiltro'),
    extrai('_saidaPlaca')].join('\n'), ctx);

  assert.equal(ctx._saidaPlaca('TDY1C61'), 'TDY-1C61', 'formato do cadastro do gseq');
  assert.equal(ctx._saidaPlaca('ABC1234'), 'ABC-1234');
  assert.equal(ctx._saidaPlaca(null), '');
  assert.equal(ctx._saidaPlaca('XPTO'), 'XPTO');

  assert.equal(ctx._saidaDist(850), '850 m');
  assert.equal(ctx._saidaDist(1234), '1,2 km');
  assert.equal(ctx._saidaDist(61300), '61 km');
  assert.equal(ctx._saidaDist(null), '—');

  const p = ctx._saidaPeriodoPadrao();
  const dias = (Date.parse(p.ate) - Date.parse(p.de)) / 86400000;
  assert.equal(dias, 6, '7 dias contando os dois extremos');

  ctx._valores['saida-prefixo-select'] = 'ALL';
  assert.equal(ctx._saidaEquipesFiltro(['GUA']), null, 'sem filtro = todas');
  ctx._valores['saida-prefixo-select'] = 'EC';
  assert.deepStrictEqual([...ctx._saidaEquipesFiltro(['GUA'])], ['ECCIT50']);
  ctx._sup = new Set(['EPCIT30']);
  assert.equal(ctx._saidaEquipesFiltro(['GUA']).size, 0, 'conjunto vazio NÃO vira "todas"');
});

test('a tela diz que nota sem rastreador não conta: cobertura no topo e rastreador não configurado', () => {
  const r = extrai('renderSaidaHTML');
  assert.match(r, /Cobertura/);
  assert.match(r, /Rastreador não configurado/);
  assert.match(r, /das avaliadas/);
});
