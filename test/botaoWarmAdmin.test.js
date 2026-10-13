/**
 * P3-20 (13/10/2026): o botão "⚡ Acordar WPA" (#btn-warm) chama POST /admin/warm,
 * que é requireAdmin. Para não-admin o clique era 403 garantido. O front tem que
 * escondê-lo no mesmo lugar em que esconde o botão Admin.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('btn-warm é escondido para quem não é admin', () => {
  assert.match(html, /showOrHide\('btn-warm',\s*isAdmin\)/);
});

test('o botão e a rota continuam existindo (o teste acima não pode ficar órfão)', () => {
  assert.match(html, /id="btn-warm"/);
  assert.match(html, /\/admin\/warm/);
});
