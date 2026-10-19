/**
 * test/monitorAbaEscondida.test.js
 *
 * 19/10/2026 (backlog P0-11, item 2). A EDP questionou o volume de requisições,
 * e uma aba do Monitor esquecida em segundo plano seguia chamando o /api/teams
 * a cada 5 min — cada chamada podendo virar uma coleta completa na EDP. Agora o
 * timer só atualiza com a aba visível, e ao voltar para ela atualiza na hora se
 * o último ciclo tiver 5 min ou mais. Teste de FONTE (o front não tem runner).
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const I = HTML.indexOf('setInterval(() => {\n        // Aviso vale em QUALQUER aba');
const BLOCO_TIMER = HTML.slice(I, HTML.indexOf('}, 5 * 60 * 1000);', I));
const J = HTML.indexOf("document.addEventListener('visibilitychange'", I);
const BLOCO_VIS = HTML.slice(J, HTML.indexOf('});', J));

test('o timer só chama loadData com a aba visível', () => {
  assert.ok(I > 0);
  assert.match(BLOCO_TIMER, /if \(isRangeToday\(de, ate\) && !document\.hidden\) \{ _monitorUltimoRefresh = Date\.now\(\); loadData\(\); \}/);
});

test('os avisos seguem fora do guard de visibilidade (só banco; contador no <title>)', () => {
  const iAviso = BLOCO_TIMER.indexOf('carregarAvisos()');
  assert.ok(iAviso > 0 && iAviso < BLOCO_TIMER.indexOf('document.hidden'));
});

test('ao voltar para a aba, atualiza se o último ciclo tiver 5 min ou mais, e só no dia de hoje', () => {
  assert.ok(J > I, 'o listener fica logo depois do timer');
  assert.match(BLOCO_VIS, /if \(document\.hidden \|\| Date\.now\(\) - _monitorUltimoRefresh < 5 \* 60 \* 1000\) return;/);
  assert.match(BLOCO_VIS, /if \(isRangeToday\(de, ate\)\) \{ _monitorUltimoRefresh = Date\.now\(\); loadData\(\); \}/);
});

test('continua um único setInterval no app (nenhum timer novo)', () => {
  assert.equal((HTML.match(/setInterval\(/g) || []).length, 1);
});
