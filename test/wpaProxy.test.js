/**
 * test/wpaProxy.test.js
 *
 * 24/10/2026: a EDP passou a recusar as chamadas vindas da VM (IP da Oracle);
 * pela rede da Engelmig funcionam. WPA_PROXY faz SÓ o HTTP para a EDP sair por um
 * proxy CONNECT (relay). Estes testes garantem que:
 *   - sem WPA_PROXY nada muda (chamada direta);
 *   - com WPA_PROXY o túnel pede o host da EDP na 443 e o TLS (SNI) vai por dentro;
 *   - relay fora do ar vira erro WPA_RELAY_INDISPONIVEL, contado como 'relay'
 *     (não 'rede'), para não ser confundido com recusa da EDP.
 * Tudo contra 127.0.0.1 — o proxy falso nunca abre conexão para fora (P1-40).
 */

'use strict';

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');

const HOST_EDP = 'edp-wpa-web-api.azurewebsites.net';

let wpaHttp;
let contador;
let proxy;
let proxyPort;
let modo = 'aceita';      // 'aceita' | 'recusa'
const connects = [];      // { alvo, primeiroByte, temSni }

before(async () => {
  proxy = http.createServer((req, res) => { res.statusCode = 405; res.end(); });
  proxy.on('connect', (req, socket) => {
    if (modo === 'recusa') {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      connects.push({ alvo: req.url });
      return;
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', (chunk) => {
      connects.push({ alvo: req.url, primeiroByte: chunk[0], temSni: chunk.includes(Buffer.from(HOST_EDP)) });
      socket.destroy();   // não há EDP do outro lado: o fetch falha no TLS, de propósito
    });
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  proxyPort = proxy.address().port;
  wpaHttp = require('../services/wpaHttp');
  contador = require('../services/wpaContador');
});

after(() => {
  delete process.env.WPA_PROXY;
  return new Promise(r => proxy.close(r));
});

afterEach(() => {
  delete process.env.WPA_PROXY;
  connects.length = 0;
  modo = 'aceita';
});

test('sem WPA_PROXY: sem agent, chamada direta como antes', () => {
  delete process.env.WPA_PROXY;
  assert.equal(wpaHttp.agenteWpa(), undefined);
  process.env.WPA_PROXY = '   ';
  assert.equal(wpaHttp.agenteWpa(), undefined);
});

test('com WPA_PROXY: CONNECT no host da EDP:443 e TLS com SNI por dentro do túnel', async () => {
  process.env.WPA_PROXY = `http://127.0.0.1:${proxyPort}`;
  await assert.rejects(wpaHttp.wpaHttpFetch(`https://${HOST_EDP}/api/sessions/current?sectorId=DESG`));
  assert.equal(connects.length, 1);
  assert.equal(connects[0].alvo, `${HOST_EDP}:443`);
  assert.equal(connects[0].primeiroByte, 0x16, 'primeiro byte no túnel deve ser um handshake TLS');
  assert.ok(connects[0].temSni, 'ClientHello deve levar o host da EDP no SNI');
});

test('agent é reaproveitado e recriado só quando WPA_PROXY muda', () => {
  process.env.WPA_PROXY = `http://127.0.0.1:${proxyPort}`;
  const a = wpaHttp.agenteWpa();
  assert.equal(wpaHttp.agenteWpa(), a);
  process.env.WPA_PROXY = `http://127.0.0.1:${proxyPort + 1}`;
  assert.notEqual(wpaHttp.agenteWpa(), a);
});

test('proxy recusa (403): erro WPA_RELAY_INDISPONIVEL, contado como relay', async () => {
  modo = 'recusa';
  contador._zerar();
  process.env.WPA_PROXY = `http://127.0.0.1:${proxyPort}`;
  await assert.rejects(
    wpaHttp.wpaHttpFetch(`https://${HOST_EDP}/api/x`),
    (err) => err.code === wpaHttp.RELAY_CODE && /relay WPA indispon/.test(err.message) && /403/.test(err.message),
  );
  assert.equal(contador.resumo().horas[0].porStatus.relay, 1);
});

test('nada escutando na porta do relay: erro WPA_RELAY_INDISPONIVEL, não "timeout"', async () => {
  const livre = await new Promise((r) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); });
  });
  process.env.WPA_PROXY = `http://127.0.0.1:${livre}`;
  await assert.rejects(
    wpaHttp.wpaHttpFetch(`https://${HOST_EDP}/api/x`),
    // wpaService trata /timeout/ na mensagem como timeout (sem retry): relay caído não pode cair ali.
    (err) => err.code === wpaHttp.RELAY_CODE && !/timeout/i.test(err.message),
  );
});

test('URL http (testes locais) nunca passa pelo proxy', async () => {
  const srv = http.createServer((req, res) => res.end('{}'));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  process.env.WPA_PROXY = `http://127.0.0.1:${proxyPort}`;
  try {
    const res = await wpaHttp.wpaHttpFetch(`http://127.0.0.1:${srv.address().port}/api/x`);
    assert.equal(res.status, 200);
    assert.equal(connects.length, 0);
  } finally {
    await new Promise(r => srv.close(r));
  }
});
