/**
 * P2-40 (13/10/2026): dado da EDP interpolado em onclick="fn('${dado}')" quebrava
 * com um apóstrofo (RAMAL D'AGUA). escapeHtml não serve nesse contexto: o
 * navegador decodifica &#39; → ' ANTES de interpretar o JS. escapeJsAttr escapa
 * para JS e depois para HTML. O teste simula o navegador: decodifica as entidades
 * do atributo e avalia o resultado como literal JS.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function extrai(nome) {
  const i = html.indexOf(`function ${nome}(`);
  assert.ok(i >= 0, `${nome} não existe no index.html`);
  const j = html.indexOf('\n    }\n', i) + 7;
  return html.slice(i, j);
}
const ctx = {};
vm.createContext(ctx);
vm.runInContext(extrai('escapeHtml') + '\n' + extrai('escapeJsAttr'), ctx);

const decodificaAtributo = (s) => s
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#39;/g, "'").replace(/&amp;/g, '&');

function viaNavegador(valor) {
  const attr = `fn('${ctx.escapeJsAttr(valor)}')`;      // o que vai no HTML
  const js = decodificaAtributo(attr);                   // o que o navegador entrega ao JS
  let recebido;
  vm.runInNewContext(js, { fn: (x) => { recebido = x; } });
  return recebido;
}

for (const v of [
  'RAMAL BT', "RAMAL D'AGUA", 'TESTE\'X', 'a\b', 'x"y', '<b>&amp;</b>',
  "');alert(1);//", 'linha1\nlinha2', "\');x;//", 'EC-GUA 01', '',
]) {
  test(`ida e volta preserva o valor: ${JSON.stringify(v)}`, () => {
    assert.strictEqual(viaNavegador(v), v);
  });
}

test('texto normal passa intacto (identidade)', () => {
  assert.strictEqual(ctx.escapeJsAttr('ECGPR01'), 'ECGPR01');
});

test('null/undefined viram string vazia', () => {
  assert.strictEqual(viaNavegador(null), '');
  assert.strictEqual(viaNavegador(undefined), '');
});

test('o atributo nunca contém aspas duplas cruas (não fecha o onclick="...")', () => {
  assert.ok(!ctx.escapeJsAttr('a"b').includes('"'));
});

test('onclick com dado de texto não usa mais interpolação crua de campo da EDP', () => {
  assert.ok(!/openNotaDetail\('\$\{idParam\}'/.test(html));
  assert.ok(!/onclick="openLightbox\('\$\{f\.base64\}'\)"/.test(html), 'P3-16: foto não pode ir duas vezes no DOM');
});
