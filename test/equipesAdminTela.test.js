/**
 * test/equipesAdminTela.test.js
 *
 * Tela de Equipes Oficiais no Admin. Não há harness de frontend (risco H11),
 * então valem as invariantes estruturais e as funções PURAS, que são extraídas
 * do index.html e executadas — no estilo do test/healthCardErro.test.js.
 *
 * Limite explícito: isto NÃO prova que a tela renderiza.
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
 * assinatura. O sintoma é um `SyntaxError: Unexpected token ';'` no
 * `new Function`, que não diz nada sobre a causa.
 */
function extrairFuncao(nome) {
  const marca = `function ${nome}(`;
  const ini   = SRC.indexOf(marca);
  assert.ok(ini > -1, `não achei ${marca} no index.html`);

  // 1) Fecha a lista de parâmetros.
  let paren = 0, fimParams = -1;
  for (let i = ini + marca.length - 1; i < SRC.length; i++) {
    if (SRC[i] === '(') paren++;
    else if (SRC[i] === ')') { paren--; if (paren === 0) { fimParams = i; break; } }
  }
  assert.ok(fimParams > -1, `parênteses não fecharam em ${nome}`);

  // 2) A partir daí, a primeira chave é a do CORPO.
  const abre = SRC.indexOf('{', fimParams);
  let nivel = 0;
  for (let i = abre; i < SRC.length; i++) {
    if (SRC[i] === '{') nivel++;
    else if (SRC[i] === '}') { nivel--; if (nivel === 0) return SRC.slice(ini, i + 1); }
  }
  throw new Error(`chaves não fecharam em ${nome}`);
}

test('o seletor de setor oferece DSSJ', () => {
  // O banco e o validateEquipe aceitam DSSJ desde 08/06/2026, mas o select só
  // tinha DESG/DEPT/DESC — cadastrar equipe de SJC pela tela não funcionava.
  const i = SRC.indexOf('id="eq-form-setor"');
  assert.ok(i > -1, 'não achei o select de setor');
  const bloco = SRC.slice(i, SRC.indexOf('</select>', i));
  ['DESG', 'DEPT', 'DESC', 'DSSJ'].forEach(s =>
    assert.ok(bloco.includes(`value="${s}"`), `falta a opção ${s}`));
});

test('_setorChanged deriva a regional dos QUATRO setores', () => {
  const fn = new Function(`
    const doc = {};
    const document = { getElementById: (id) => doc[id] };
    ${extrairFuncao('_setorChanged')}
    return (setor) => {
      doc['eq-form-setor'] = { value: setor };
      doc['eq-form-regional'] = { value: null };
      _setorChanged();
      return doc['eq-form-regional'].value;
    };
  `)();

  assert.equal(fn('DESG'), 'GUA');
  assert.equal(fn('DEPT'), 'GUA');
  assert.equal(fn('DESC'), 'CAC');
  assert.equal(fn('DSSJ'), 'SJC', 'DSSJ tem de derivar SJC, não GUA');
});

test('_filtrarEquipes filtra por texto, regional e situação', () => {
  const filtrar = new Function(`${extrairFuncao('_filtrarEquipes')}; return _filtrarEquipes;`)();

  const eqs = [
    { sigla: 'EBGPR62', placa: 'ABC-1234', regional: 'GUA', ativo: true },
    { sigla: 'ECACH50', placa: 'DEF-5678', regional: 'CAC', ativo: true },
    { sigla: 'EMGPR70', placa: null,       regional: 'GUA', ativo: false },
  ];

  // Sem filtro: tudo
  assert.equal(filtrar(eqs, { texto: '', regional: 'ALL', situacao: 'ALL' }).length, 3);

  // Texto casa sigla, sem depender de caixa
  assert.deepEqual(
    filtrar(eqs, { texto: 'gpr', regional: 'ALL', situacao: 'ALL' }).map(e => e.sigla),
    ['EBGPR62', 'EMGPR70']);

  // Texto casa placa
  assert.deepEqual(
    filtrar(eqs, { texto: 'def', regional: 'ALL', situacao: 'ALL' }).map(e => e.sigla),
    ['ECACH50']);

  // Placa nula não quebra
  assert.doesNotThrow(() => filtrar(eqs, { texto: 'zzz', regional: 'ALL', situacao: 'ALL' }));

  // Regional
  assert.equal(filtrar(eqs, { texto: '', regional: 'CAC', situacao: 'ALL' }).length, 1);

  // Situação
  assert.deepEqual(
    filtrar(eqs, { texto: '', regional: 'ALL', situacao: 'INATIVAS' }).map(e => e.sigla),
    ['EMGPR70']);
  assert.equal(filtrar(eqs, { texto: '', regional: 'ALL', situacao: 'ATIVAS' }).length, 2);

  // Combinado
  assert.deepEqual(
    filtrar(eqs, { texto: 'gpr', regional: 'GUA', situacao: 'ATIVAS' }).map(e => e.sigla),
    ['EBGPR62']);
});

// ─────────────────────────────────────────────────────────────────────────────
// Importação — detecção do cabeçalho da planilha
// ─────────────────────────────────────────────────────────────────────────────

/** _detectarCabecalho depende de _CAB_SINONIMOS e _normCabecalho. */
function carregarDetector() {
  const i = SRC.indexOf('const _CAB_SINONIMOS');
  assert.ok(i > -1, 'não achei _CAB_SINONIMOS no index.html');
  const sinonimos = SRC.slice(i, SRC.indexOf('};', i) + 2);
  return new Function(`
    ${sinonimos}
    ${extrairFuncao('_normCabecalho')}
    ${extrairFuncao('_detectarCabecalho')}
    return _detectarCabecalho;
  `)();
}

test('_detectarCabecalho acha a linha de cabeçalho e mapeia as colunas', () => {
  const detectar = carregarDetector();

  // Planilha real tem título e linha em branco antes da tabela.
  const matriz = [
    ['RELAÇÃO DE EQUIPES — SETEMBRO', null, null],
    [null, null, null],
    ['Sigla', 'Tipo', 'Placa'],
    ['EBGPR62', 'BTZERO', 'ABC-1234'],
  ];
  const r = detectar(matriz);

  assert.equal(r.linhaCabecalho, 2, 'índice 0-based da linha de cabeçalho');
  assert.deepEqual(r.mapa, { sigla: 0, tipo: 1, placa: 2 });
});

test('_detectarCabecalho aceita sinônimos e ignora acento e caixa', () => {
  const detectar = carregarDetector();
  const r = detectar([['EQUIPE', 'SERVIÇO', 'VEÍCULO'], ['EBGPR62', 'CS', 'ABC-1234']]);
  assert.deepEqual(r.mapa, { sigla: 0, tipo: 1, placa: 2 });
});

test('_detectarCabecalho devolve mapa vazio quando não acha sigla', () => {
  const detectar = carregarDetector();
  const r = detectar([['Coluna A', 'Coluna B'], ['x', 'y']]);
  assert.equal(r.linhaCabecalho, -1);
  assert.equal(r.mapa.sigla, undefined);
});

test('_detectarCabecalho só olha as 10 primeiras linhas', () => {
  const detectar = carregarDetector();
  const matriz = Array.from({ length: 12 }, () => ['lixo', 'lixo']);
  matriz.push(['Sigla', 'Tipo']);
  assert.equal(detectar(matriz).linhaCabecalho, -1);
});
