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

/** Extrai o corpo de uma função do index.html casando as chaves. */
function extrairFuncao(nome) {
  const marca = `function ${nome}(`;
  const ini   = SRC.indexOf(marca);
  assert.ok(ini > -1, `não achei ${marca} no index.html`);
  const abre = SRC.indexOf('{', ini);
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
