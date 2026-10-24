/**
 * test/wpaProxy.test.js
 *
 * 24/10/2026: a EDP passou a recusar as chamadas vindas da VM (IP da Oracle);
 * pela rede da Engelmig funcionam. WPA_PROXY faz SÓ o HTTP para a EDP sair por um
 * proxy CONNECT (relay). Estes testes garantem que:
 *   - sem WPA_PROXY nada muda (chamada direta);
 *   - com WPA_PROXY o túnel pede o host da EDP na 443 e o TLS (SNI) vai por dentro;
 *   - relay com problema vira WpaAccessError com code próprio (spec
 *     wpa-acesso-edp.md, R2.2), contado pelo code (não 'rede'), para não ser
 *     confundido com recusa da EDP:
 *       nada escutando / fecha sem responder → WPA_PROXY_INDISPONIVEL
 *       403 no CONNECT (host não liberado)    → WPA_PROXY_RECUSOU
 *       502 no CONNECT (relay sem rota p/ EDP) → WPA_PROXY_SEM_ROTA
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
let modo = 'aceita';      // 'aceita' | 'recusa' | 'sem-rota' | 'fecha' | 'outro'
const connects = [];      // { alvo, primeiroByte, temSni }

before(async () => {
  proxy = http.createServer((req, res) => { res.statusCode = 405; res.end(); });
  proxy.on('connect', (req, socket) => {
    if (modo !== 'aceita') {
      connects.push({ alvo: req.url });
      if (modo === 'fecha') return socket.destroy();   // túnel SSH no ar, proxy remoto parado
      const linha = { recusa: '403 Forbidden', 'sem-rota': '502 Bad Gateway', outro: '407 Proxy Authentication Required' }[modo];
      socket.end(`HTTP/1.1 ${linha}\r\n\r\n`);
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

async function falhaCom(m) {
  modo = m;
  process.env.WPA_PROXY = `http://127.0.0.1:${proxyPort}`;
  try {
    await wpaHttp.wpaHttpFetch(`https://${HOST_EDP}/api/x`);
  } catch (err) { return err; }
  assert.fail('deveria ter falhado');
}

test('proxy recusa (403): WPA_PROXY_RECUSOU com status 403, contado pelo code', async () => {
  contador._zerar();
  const err = await falhaCom('recusa');
  assert.equal(err.name, 'WpaAccessError');
  assert.equal(err.code, 'WPA_PROXY_RECUSOU');
  assert.equal(err.status, 403);
  assert.equal(err.host, HOST_EDP);
  assert.equal(err.path, '/api/x');
  assert.equal(contador.resumo().horas[0].porStatus.WPA_PROXY_RECUSOU, 1);
});

test('proxy sem rota para a EDP (502): WPA_PROXY_SEM_ROTA', async () => {
  const err = await falhaCom('sem-rota');
  assert.equal(err.code, 'WPA_PROXY_SEM_ROTA');
  assert.equal(err.status, 502);
});

test('outro status no CONNECT (407): WPA_PROXY_RECUSOU', async () => {
  const err = await falhaCom('outro');
  assert.equal(err.code, 'WPA_PROXY_RECUSOU');
  assert.equal(err.status, 407);
});

test('túnel no ar com o proxy remoto parado (fecha sem responder): WPA_PROXY_INDISPONIVEL', async () => {
  const err = await falhaCom('fecha');
  assert.equal(err.code, 'WPA_PROXY_INDISPONIVEL');
});

test('nada escutando na porta do proxy: WPA_PROXY_INDISPONIVEL, não "timeout"', async () => {
  const livre = await new Promise((r) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); });
  });
  process.env.WPA_PROXY = `http://127.0.0.1:${livre}`;
  await assert.rejects(
    wpaHttp.wpaHttpFetch(`https://${HOST_EDP}/api/x`),
    // wpaService trata /timeout/ na mensagem como timeout (sem retry): proxy caído não pode cair ali.
    (err) => err.code === 'WPA_PROXY_INDISPONIVEL' && /ECONNREFUSED/.test(err.message) && !/timeout/i.test(err.message),
  );
});

test('testarPortaProxy: aceita quando há proxy, recusa quando não há', async () => {
  const ok = await wpaHttp.testarPortaProxy(`http://127.0.0.1:${proxyPort}`, 1000);
  assert.equal(ok.ok, true);
  const livre = await new Promise((r) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); });
  });
  const nao = await wpaHttp.testarPortaProxy(`http://127.0.0.1:${livre}`, 1000);
  assert.equal(nao.ok, false);
  assert.equal(nao.erro, 'ECONNREFUSED');
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
