/**
 * test/regionalTravaEscopo.test.js
 *
 * 16/09/2026 — "o usuário da conta do ES não está conseguindo fazer o filtro de
 * região".
 *
 * A conta `engelmig_es` tem regionals=[GUA,CAC]. `_deriveLegacyRegional` traduz
 * esse par pra string legada 'ES' — mas 'ES' NÃO é <option> de nenhum dropdown:
 * `applyUserPermissions` popula os selects só com ALL/GUA/CAC. As abas
 * Rejeições, Deslocamentos, Gráficos e TMA travavam o dropdown testando
 * `sess.regional !== 'ALL'`, o que pra essa conta dá true. `setValues(['ES'])`
 * não casava nada e caía no fallback "marca tudo" (por isso os NÚMEROS estavam
 * certos), e o `setDisabled(true)` na linha seguinte congelava o filtro.
 *
 * Admin deriva 'ALL' e conta de 1 regional deriva a própria sigla — os dois
 * passavam ilesos. Só a conta de 2 regionais quebrava, e era a única no .env.
 *
 * É a mesma causa do P1-19 (13/08, 5e2c17a), corrigido só na aba Histórico. A
 * correção agora é uma fonte única: `_travarRegionalPorEscopo`, que decide pelo
 * ESCOPO (userRegionals, imutável, do JWT) e nunca pela string legada nem pelo
 * FILTRO corrente.
 *
 * Invariante que estes testes prendem:
 *   trava  ⟺  o usuário tem exatamente 1 regional no token.
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

const REGIONAIS_ATIVAS = ['GUA', 'CAC', 'SJC'];

const _deriveLegacyRegional = new Function(
  'REGIONAIS_ATIVAS',
  `${recortar('_deriveLegacyRegional', '\n    }')}; return _deriveLegacyRegional;`,
)(REGIONAIS_ATIVAS);

const _travarRegionalPorEscopo = new Function(
  'MultiSelect', 'userRegionals', 'selectedRegionals',
  `${recortar('_travarRegionalPorEscopo', '\n    }')}; return _travarRegionalPorEscopo;`,
);

/** Dublê do MultiSelect: grava o que a trava tentou fazer com o dropdown. */
function rodar(userRegionals, selectedRegionals) {
  const efeito = { valores: null, travado: false };
  const stub = {
    setValues: (_id, vals) => { efeito.valores = [...vals]; },
    setDisabled: (_id, flag) => { efeito.travado = !!flag; },
  };
  _travarRegionalPorEscopo(stub, userRegionals, selectedRegionals)('qualquer-regional-select');
  return efeito;
}

// ─────────────────────────────────────────────────────────────────────────────
// A armadilha: por que 'ES' nunca pode governar um dropdown
// ─────────────────────────────────────────────────────────────────────────────

test('a conta de 2 regionais deriva ES — sigla que NÃO existe no dropdown', () => {
  assert.equal(_deriveLegacyRegional(['GUA', 'CAC']), 'ES');
  const opcoesDoSelect = ['ALL', 'GUA', 'CAC'];   // o que applyUserPermissions popula
  assert.ok(!opcoesDoSelect.includes('ES'),
    'se um dia ES virar <option>, esta suíte precisa ser revista');
});

test('admin e conta de 1 regional derivam valores que EXISTEM — por isso não reclamaram', () => {
  assert.equal(_deriveLegacyRegional(['GUA', 'CAC', 'SJC']), 'ALL');
  assert.equal(_deriveLegacyRegional(['GUA']), 'GUA');
  assert.equal(_deriveLegacyRegional(['CAC']), 'CAC');
  assert.equal(_deriveLegacyRegional(['SJC']), 'SJC');
});

// ─────────────────────────────────────────────────────────────────────────────
// A trava: só escopo de 1 regional pode travar
// ─────────────────────────────────────────────────────────────────────────────

test('engelmig_es (GUA|CAC) NÃO pode ficar com o dropdown travado', () => {
  const efeito = rodar(['GUA', 'CAC'], ['GUA', 'CAC']);
  assert.equal(efeito.travado, false, 'este é o bug reportado em 16/09/2026');
  assert.equal(efeito.valores, null, 'seleção completa: não mexe no dropdown');
});

test('engelmig_es com uma regional escolhida em outra aba: reflete, mas DESTRAVA', () => {
  const efeito = rodar(['GUA', 'CAC'], ['GUA']);
  assert.deepEqual(efeito.valores, ['GUA']);
  assert.equal(efeito.travado, false, 'filtro corrente reflete, nunca trava');
});

test('admin nunca trava — nem quando estreitou o filtro em outra aba (P1-19)', () => {
  assert.equal(rodar(REGIONAIS_ATIVAS, [...REGIONAIS_ATIVAS]).travado, false);
  assert.equal(rodar(REGIONAIS_ATIVAS, ['GUA']).travado, false);
  assert.deepEqual(rodar(REGIONAIS_ATIVAS, ['GUA']).valores, ['GUA'],
    'reflete a seleção sem travar');
});

test('conta de 1 regional trava — e trava na sigla certa', () => {
  for (const sigla of REGIONAIS_ATIVAS) {
    const efeito = rodar([sigla], [sigla]);
    assert.equal(efeito.travado, true, `${sigla} deveria travar`);
    assert.deepEqual(efeito.valores, [sigla]);
  }
});

test('a trava nunca escreve sigla que não esteja no escopo do token', () => {
  const perfis = [
    ['GUA', 'CAC', 'SJC'],
    ['GUA', 'CAC'],
    ['GUA'], ['CAC'], ['SJC'],
  ];
  for (const escopo of perfis) {
    for (const sel of [[...escopo], [escopo[0]]]) {
      const { valores } = rodar(escopo, sel);
      if (!valores) continue;
      for (const v of valores) {
        assert.ok(escopo.includes(v),
          `escopo=${escopo} escreveu "${v}" no dropdown — fora do token`);
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Fonte única: nenhuma aba pode voltar a ter cópia própria da trava
// ─────────────────────────────────────────────────────────────────────────────

test('nenhuma aba trava a regional pela string legada sess.regional', () => {
  const linhas = SRC.split('\n');
  const suspeitas = linhas
    .map((l, i) => ({ n: i + 1, l }))
    .filter(({ l }) => /sess\.regional\s*!==\s*'ALL'/.test(l) && !l.trim().startsWith('//'));
  assert.deepEqual(suspeitas, [],
    'trava de dropdown tem de usar _travarRegionalPorEscopo (escopo), não sess.regional');
});

test('setDisabled num select de regional só sai de _travarRegionalPorEscopo ou applyUserPermissions', () => {
  const ini = SRC.indexOf('function _travarRegionalPorEscopo(');
  const fim = SRC.indexOf('\n    }', ini);
  const dentroDoHelper = (pos) => pos > ini && pos < fim;

  // applyUserPermissions trava a sigla única no laço dos 8 selects — legítimo.
  const iniPerm = SRC.indexOf('function applyUserPermissions(');
  const fimPerm = SRC.indexOf('\n    function boot()', iniPerm);
  const dentroDePerm = (pos) => pos > iniPerm && pos < fimPerm;

  const re = /MultiSelect\.setDisabled\(/g;
  let m;
  const foraDeLugar = [];
  while ((m = re.exec(SRC))) {
    const pos = m.index;
    if (dentroDoHelper(pos) || dentroDePerm(pos)) continue;
    const anteriores = SRC.slice(0, pos).split('\n');
    const linha = anteriores[anteriores.length - 1] + SRC.slice(pos, SRC.indexOf('\n', pos));
    if (linha.trim().startsWith('//')) continue;   // doc da API do MultiSelect
    foraDeLugar.push(anteriores.length);
  }
  assert.deepEqual(foraDeLugar, [],
    `setDisabled de regional fora da fonte única (linhas: ${foraDeLugar.join(', ')})`);
});
