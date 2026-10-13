/**
 * test/vendorLinks.test.js
 *
 * P2-49 (13/10/2026): index.html apontava para vendor/roboto/roboto.css, que não
 * existia — 404 sem Content-Type, fonte nunca carregou, e nenhum teste viu.
 * Todo <link rel=stylesheet>/<script src> local do index.html tem que existir,
 * e todo url() de um CSS vendorizado também.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
// Sem comentários HTML: o index.html cita `src="cdn..."` em prosa.
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');

const locais = [];
for (const m of html.matchAll(/<(?:link[^>]+href|script[^>]+src)="([^"#?]+)"/g)) {
  if (!/^(https?:)?\/\//.test(m[1]) && !m[1].startsWith('data:')) locais.push(m[1]);
}

test('index.html referencia ao menos um recurso local', () => {
  assert.ok(locais.length > 0);
});

for (const rel of locais) {
  test(`recurso local existe: ${rel}`, () => {
    assert.ok(fs.existsSync(path.join(PUB, rel)), `${rel} não existe em public/`);
  });
}

test('roboto.css declara 4 pesos e todos os TTF existem', () => {
  const css = fs.readFileSync(path.join(PUB, 'vendor/roboto/roboto.css'), 'utf8');
  const urls = [...css.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1]);
  assert.strictEqual(urls.length, 4);
  for (const u of urls) {
    assert.ok(fs.existsSync(path.join(PUB, 'vendor/roboto', u)), `${u} não existe`);
  }
});
