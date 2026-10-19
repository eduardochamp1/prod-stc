/**
 * test/wpaContador.test.js
 *
 * 19/10/2026 (backlog P0-11). A EDP questionou "diversas requisições" que
 * estariam congestionando a WPA, e nós não tínhamos como dizer quantas saíam
 * daqui: nenhum contador, só ~200 linhas `[WPA]` de log por ciclo, que não são
 * requisições. Estes testes garantem que TODO HTTP para a EDP (que sai por
 * services/wpaHttp.js) é contado por hora BRT, endpoint e origem, e que a
 * origem distingue o painel (requisição do navegador) do cron.
 *
 * Servidor HTTP LOCAL (127.0.0.1) — a suíte não toca a EDP (P1-40).
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const contador = require('../services/wpaContador');
const { wpaHttpFetch } = require('../services/wpaHttp');

let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url.startsWith('/falha')) { res.statusCode = 503; res.end('x'); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end('{}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { contador._aoFecharHora(null); return new Promise(r => server.close(r)); });

// Silencia a linha de log da virada de hora (o teste de retenção vira 50 horas).
beforeEach(() => { contador._zerar(); contador._aoFecharHora(() => {}); });

// ── normalização do endpoint ────────────────────────────────────────────────

test('endpoint: UUID vira {id}, número longo vira {n}, query some', () => {
  assert.equal(
    contador.normalizarEndpoint('https://h/api/notes/rejected/1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed/session'),
    'GET /api/notes/rejected/{id}/session');
  assert.equal(
    contador.normalizarEndpoint('https://h/api/teamsstatus/V2?sectorId=DESG&filterByExhibitionSector=true', 'get'),
    'GET /api/teamsstatus/V2');
  assert.equal(
    contador.normalizarEndpoint('https://h/api/collaboratorshifts/DESG/10/2026', 'GET'),
    'GET /api/collaboratorshifts/DESG/10/2026');
  assert.equal(
    contador.normalizarEndpoint('https://h/api/Notes/045006455506/details/optimized?sectorId=X', 'GET'),
    'GET /api/Notes/{n}/details/optimized');
  assert.equal(contador.normalizarEndpoint('https://h/identity/signin', 'POST'), 'POST /identity/signin');
});

test('endpoint: URL ilegível não lança', () => {
  assert.equal(contador.normalizarEndpoint('lixo', 'GET'), 'GET lixo');
  assert.equal(contador.normalizarEndpoint(undefined), 'GET ?');
});

// ── origem ───────────────────────────────────────────────────────────────────

test('sem contexto, a origem é "interno"', () => {
  assert.equal(contador.origemAtual(), 'interno');
});

test('comOrigem propaga a origem através de await', async () => {
  const vista = await contador.comOrigem('cron:snapshot', async () => {
    await new Promise(r => setTimeout(r, 5));
    return contador.origemAtual();
  });
  assert.equal(vista, 'cron:snapshot');
  assert.equal(contador.origemAtual(), 'interno');
});

test('a cauda sem await herda a origem de quem disparou', async () => {
  let vistaNaCauda;
  let fim;
  const terminou = new Promise(r => { fim = r; });
  contador.comOrigem('cron:snapshot', () => {
    setTimeout(() => { vistaNaCauda = contador.origemAtual(); fim(); }, 5);
  });
  await terminou;
  assert.equal(vistaNaCauda, 'cron:snapshot');
});

test('origemDaRota: ids e números do path viram placeholder', () => {
  assert.equal(contador.origemDaRota('GET', '/teams'), 'painel:GET /teams');
  assert.equal(contador.origemDaRota('GET', '/wpa/nota/1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed'),
    'painel:GET /wpa/nota/{id}');
  assert.equal(contador.origemDaRota('GET', '/teams/12345'), 'painel:GET /teams/{n}');
  // /api/cron é o crontab (CRON_SECRET), não o navegador.
  assert.equal(contador.origemDaRota('GET', '/cron/snapshot'), 'cron-http:GET /cron/snapshot');
  assert.equal(contador.origemDaRota('GET', '/cronograma'), 'painel:GET /cronograma');
});

// ── contagem real através do wpaHttpFetch ──────────────────────────────────

test('wpaHttpFetch conta cada requisição, com origem, status e erros', async () => {
  await contador.comOrigem('painel:GET /teams', async () => {
    await wpaHttpFetch(`${base}/api/notes/executed/1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed/session`);
    await wpaHttpFetch(`${base}/api/notes/executed/2c9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed/session`);
  });
  await wpaHttpFetch(`${base}/falha`, { method: 'POST' });

  const r = contador.resumo();
  assert.equal(r.total, 3);
  const hora = r.horas[0];
  assert.equal(hora.total, 3);
  assert.equal(hora.erros, 1);
  assert.equal(hora.porOrigem['painel:GET /teams'], 2);
  assert.equal(hora.porOrigem['interno'], 1);
  const exec = hora.porEndpoint.find(e => e.endpoint === 'GET /api/notes/executed/{id}/session');
  assert.equal(exec.n, 2);
  const falha = hora.porEndpoint.find(e => e.endpoint === 'POST /falha');
  assert.equal(falha.erros, 1);
});

test('erro de rede também é contado (como erro)', async () => {
  // Porta fechada: o fetch rejeita, mas a requisição SAIU daqui e tem de contar.
  await assert.rejects(wpaHttpFetch('http://127.0.0.1:1/x', { timeout: 2000 }));
  const r = contador.resumo();
  assert.equal(r.total, 1);
  assert.equal(r.horas[0].erros, 1);
});

// ── janela por hora BRT ─────────────────────────────────────────────────────

test('baldes por hora BRT, mais recente primeiro, e retenção limitada', () => {
  const h0 = Date.parse('2026-10-19T12:10:00Z');   // 09:10 BRT
  contador.registrar({ endpoint: 'GET /a', origem: 'interno', ok: true, ms: 10, agora: h0 });
  contador.registrar({ endpoint: 'GET /a', origem: 'interno', ok: true, ms: 30, agora: h0 + 3600_000 });
  contador.registrar({ endpoint: 'GET /a', origem: 'interno', ok: true, ms: 20, agora: h0 + 3600_000 });

  const r = contador.resumo();
  assert.deepEqual(r.horas.map(h => [h.hora, h.total]), [['2026-10-19 10h', 2], ['2026-10-19 09h', 1]]);
  assert.equal(r.horas[0].porEndpoint[0].msMedio, 25);

  // Mais horas do que a retenção: as antigas saem.
  for (let i = 2; i < contador.HORAS_RETIDAS + 5; i++) {
    contador.registrar({ endpoint: 'GET /a', origem: 'interno', ok: true, ms: 1, agora: h0 + i * 3600_000 });
  }
  assert.equal(contador.resumo().horas.length, contador.HORAS_RETIDAS);
});

test('virada de hora entrega o resumo da hora fechada ao callback', () => {
  const fechadas = [];
  contador._aoFecharHora(h => fechadas.push(h));
  const h0 = Date.parse('2026-10-19T12:10:00Z');
  contador.registrar({ endpoint: 'GET /a', origem: 'cron:snapshot', ok: true, ms: 1, agora: h0 });
  contador.registrar({ endpoint: 'GET /a', origem: 'cron:snapshot', ok: true, ms: 1, agora: h0 + 60_000 });
  assert.equal(fechadas.length, 0);
  contador.registrar({ endpoint: 'GET /a', origem: 'cron:snapshot', ok: true, ms: 1, agora: h0 + 3600_000 });
  assert.equal(fechadas.length, 1);
  assert.equal(fechadas[0].hora, '2026-10-19 09h');
  assert.equal(fechadas[0].total, 2);
  assert.equal(fechadas[0].porOrigem['cron:snapshot'], 2);
});

test('registrar nunca lança, nem com entrada vazia', () => {
  assert.doesNotThrow(() => contador.registrar({}));
  assert.doesNotThrow(() => contador.registrar());
});
