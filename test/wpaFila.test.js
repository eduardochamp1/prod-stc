/**
 * test/wpaFila.test.js
 *
 * 19/10/2026 (backlog P0-11 item 4 / P2-30). A EDP questionou o volume e o
 * "congestionamento"; o snapshot sozinho fazia até 16 requisições em voo por
 * setor, e as caudas somavam por cima. Agora há um limite GLOBAL em voo, com
 * o painel passando na frente. Estes testes travam: o limite é respeitado, a
 * vaga é devolvida em erro, o painel fura a fila, 0 = sem limite, e o
 * wpaHttpFetch real passa pela fila (contra servidor LOCAL — P1-40).
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { criarFila, MAX_PADRAO } = require('../services/wpaFila');

const dormir = (ms) => new Promise(r => setTimeout(r, ms));

test('nunca passa do máximo em voo', async () => {
  const fila = criarFila(3);
  let agora = 0, pico = 0;
  const tarefa = () => fila.comVaga(false, async () => {
    agora++; pico = Math.max(pico, agora);
    await dormir(5);
    agora--;
  });
  await Promise.all(Array.from({ length: 20 }, tarefa));
  assert.equal(pico, 3);
  assert.equal(fila.estado().picoEmVoo, 3);
  assert.equal(fila.estado().emVoo, 0);
  assert.equal(fila.estado().naFila, 0);
});

test('erro devolve a vaga (a fila não entope)', async () => {
  const fila = criarFila(1);
  await assert.rejects(fila.comVaga(false, async () => { throw new Error('rede'); }));
  const r = await fila.comVaga(false, async () => 'ok');
  assert.equal(r, 'ok');
  assert.equal(fila.estado().emVoo, 0);
});

test('prioritária (painel) passa na frente de quem já esperava', async () => {
  const fila = criarFila(1);
  const ordem = [];
  let soltar;
  const ocupando = fila.comVaga(false, () => new Promise(r => { soltar = r; }));
  const n1 = fila.comVaga(false, async () => { ordem.push('cron-1'); });
  const n2 = fila.comVaga(false, async () => { ordem.push('cron-2'); });
  const p1 = fila.comVaga(true, async () => { ordem.push('painel'); });
  await dormir(1);
  soltar();
  await Promise.all([ocupando, n1, n2, p1]);
  assert.deepEqual(ordem, ['painel', 'cron-1', 'cron-2']);
});

test('max 0 = sem limite (comportamento de antes)', async () => {
  const fila = criarFila(0);
  let agora = 0, pico = 0;
  await Promise.all(Array.from({ length: 10 }, () => fila.comVaga(false, async () => {
    agora++; pico = Math.max(pico, agora); await dormir(5); agora--;
  })));
  assert.equal(pico, 10);
});

test('default é 6', () => {
  assert.equal(MAX_PADRAO, 6);
});

// ── o wpaHttpFetch real passa pela fila ─────────────────────────────────────

let server;
let base;
let emVooNoServidor = 0;
let picoNoServidor = 0;

before(async () => {
  server = http.createServer((req, res) => {
    emVooNoServidor++; picoNoServidor = Math.max(picoNoServidor, emVooNoServidor);
    setTimeout(() => { emVooNoServidor--; res.end('{}'); }, 20);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise(r => server.close(r)));

test('wpaHttpFetch: a EDP (servidor local) nunca vê mais que o limite ao mesmo tempo', async () => {
  delete process.env.WPA_MAX_EM_VOO;   // default 6, lido no load do módulo
  const contador = require('../services/wpaContador');
  contador._aoFecharHora(() => {});
  const { wpaHttpFetch } = require('../services/wpaHttp');
  await Promise.all(Array.from({ length: 30 }, (_, i) => wpaHttpFetch(`${base}/api/x/${i}`).then(r => r.text())));
  assert.equal(picoNoServidor, 6);
  contador._aoFecharHora(null);
});
