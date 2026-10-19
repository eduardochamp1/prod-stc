/**
 * test/wpaCachePainel.test.js
 *
 * 19/10/2026 (backlog P0-11, item 1). Cada aba aberta no Monitor fazia uma coleta
 * COMPLETA na EDP a cada 5 min (~200–270 requisições), e a EDP questionou o
 * volume. Agora a coleta de cada setor fica guardada 5 min: o navegador
 * reaproveita, o cron sempre coleta fresco e preenche o guardado.
 *
 * O que estes testes travam:
 *   - o cache devolve CÓPIA (os enriquecimentos do dataService alteram os objetos
 *     de equipe no lugar — sem cópia, painel e snapshot se contaminariam);
 *   - `_sessoesTotaisEdp` (não-enumerável, usado pelo P0-10) sobrevive à cópia;
 *   - expira em 5 min e na virada do dia BRT;
 *   - só quem pede (`aceitaCache`) lê; o default continua fresco;
 *   - a fiação: /api/teams pede, o cron não.
 *
 * Servidor HTTP LOCAL (127.0.0.1) — a suíte não toca a EDP (P1-40).
 */

'use strict';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');

let server;
let wpa;
let contador;

before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/identity/signin')) {
      const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64');
      res.end(JSON.stringify({ Token: `h.${payload}.s`, Data: true, Error: null }));
      return;
    }
    res.end(JSON.stringify({ Data: [] }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.WPA_URL = base;
  process.env.WPA_API_URL = base;
  process.env.WPA_USERNAME = 'teste@local';
  process.env.WPA_PASSWORD = 'senha-de-teste';
  delete process.env.WPA_ACCOUNTS_DISABLED;
  delete process.env.WPA_PAINEL_CACHE_MS;
  contador = require('../services/wpaContador');
  contador._aoFecharHora(() => {});
  wpa = require('../services/wpaService');
  wpa._breakerHydration.done = true;   // sem banco: nada de breaker persistido
});

after(() => { contador._aoFecharHora(null); return new Promise(r => server.close(r)); });

// ── leitura/gravação pura ──────────────────────────────────────────────────

describe('cache por setor (funções puras)', () => {
  const T0 = Date.parse('2026-10-19T15:00:00Z');   // 12:00 BRT

  function coleta() {
    const arr = [{ sigla: 'GUA1', notasConcluidas: [{ id: 'a' }] }];
    Object.defineProperty(arr, '_sessoesTotaisEdp', { value: 73 });
    return arr;
  }

  test('vazio → null; dentro de 5 min → cópia; com 5 min → null', () => {
    const m = new Map();
    assert.equal(wpa._lerCacheSetor(m, 'DESG', 300_000, T0), null);
    wpa._gravarCacheSetor(m, 'DESG', coleta(), T0);
    assert.equal(wpa._lerCacheSetor(m, 'DESG', 300_000, T0 + 299_999)[0].sigla, 'GUA1');
    assert.equal(wpa._lerCacheSetor(m, 'DESG', 300_000, T0 + 300_000), null);
  });

  test('TTL 0 desliga o cache', () => {
    const m = new Map();
    wpa._gravarCacheSetor(m, 'DESG', coleta(), T0);
    assert.equal(wpa._lerCacheSetor(m, 'DESG', 0, T0), null);
  });

  test('não atravessa a virada do dia BRT, mesmo dentro dos 5 min', () => {
    const m = new Map();
    const antes = Date.parse('2026-10-20T02:58:00Z');   // 23:58 BRT de 19/10
    wpa._gravarCacheSetor(m, 'DESG', coleta(), antes);
    assert.ok(wpa._lerCacheSetor(m, 'DESG', 300_000, antes + 180_000) === null, '00:01 BRT de 20/10 já é outro dia');
    assert.ok(wpa._lerCacheSetor(m, 'DESG', 300_000, antes + 30_000) !== null, '23:58:30 ainda é o mesmo dia');
  });

  test('devolve CÓPIA: mexer no que saiu não muda o guardado nem o original', () => {
    const m = new Map();
    const original = coleta();
    wpa._gravarCacheSetor(m, 'DESG', original, T0);
    original[0].sigla = 'MEXIDO-PELO-CRON';
    const a = wpa._lerCacheSetor(m, 'DESG', 300_000, T0);
    a[0].notasConcluidas.push({ id: 'b' });
    a[0].sessionBeginReal = 'enriquecido';
    const b = wpa._lerCacheSetor(m, 'DESG', 300_000, T0);
    assert.equal(b[0].sigla, 'GUA1');
    assert.equal(b[0].notasConcluidas.length, 1);
    assert.equal(b[0].sessionBeginReal, undefined);
  });

  test('_sessoesTotaisEdp (P0-10) sobrevive à cópia e segue não-enumerável', () => {
    const m = new Map();
    wpa._gravarCacheSetor(m, 'DESG', coleta(), T0);
    const c = wpa._lerCacheSetor(m, 'DESG', 300_000, T0);
    assert.equal(c._sessoesTotaisEdp, 73);
    assert.ok(!Object.keys(c).includes('_sessoesTotaisEdp'));
    assert.equal(JSON.stringify(c).includes('73'), false);
  });
});

// ── comportamento real, contando as requisições que saem ───────────────────

describe('getTeamsBySector + cache (contra servidor local)', () => {
  test('coleta fresca grava; quem aceita cache lê sem requisição nenhuma', async () => {
    wpa._cacheSetor.clear();
    contador._zerar();
    await wpa.getTeamsBySector('DESG');                       // fresco (o cron)
    const depoisDoCron = contador.resumo().total;
    assert.ok(depoisDoCron > 0, 'a coleta fresca vai à EDP');

    const doCache = await wpa.getTeamsBySector('DESG', { aceitaCache: true });   // o painel
    assert.equal(contador.resumo().total, depoisDoCron, 'o painel não fez requisição');
    assert.equal(doCache._sessoesTotaisEdp, 0);
  });

  test('sem aceitaCache, continua indo à EDP (default inalterado)', async () => {
    wpa._cacheSetor.clear();
    contador._zerar();
    await wpa.getTeamsBySector('DESC');
    const n1 = contador.resumo().total;
    await wpa.getTeamsBySector('DESC');
    assert.ok(contador.resumo().total > n1, 'a segunda coleta fresca também vai à EDP');
  });

  test('cache vazio: quem aceita cache coleta e grava para o próximo', async () => {
    wpa._cacheSetor.clear();
    contador._zerar();
    await wpa.getTeamsBySector('DESG', { aceitaCache: true });
    const n1 = contador.resumo().total;
    assert.ok(n1 > 0);
    await wpa.getTeamsBySector('DESG', { aceitaCache: true });
    assert.equal(contador.resumo().total, n1);
  });

  test('cada chamador do cache recebe o SEU objeto', async () => {
    wpa._cacheSetor.clear();
    await wpa.getTeamsBySector('DEPT');
    const a = await wpa.getTeamsBySector('DEPT', { aceitaCache: true });
    const b = await wpa.getTeamsBySector('DEPT', { aceitaCache: true });
    assert.notEqual(a, b);
  });
});

// ── fiação (fonte) ─────────────────────────────────────────────────────────

describe('fiação: /api/teams pede o cache, o cron não', () => {
  const ler = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  const ROTAS = ler('routes', 'index.js');
  const DATA = ler('services', 'dataService.js');
  const CRON = ler('services', 'cronService.js');

  test('/api/teams passa usarCachePainel: true DEPOIS do ...req.query (query não forja)', () => {
    assert.match(ROTAS, /getTeams\(\{ \.\.\.req\.query, regionals: req\.scope\.regionals, usarCachePainel: true \}/);
  });

  test('getTeams só repassa aceitaCache com o booleano true (string "true" da query não vale)', () => {
    assert.match(DATA, /filters\.usarCachePainel === true/);
    assert.match(DATA, /getTeamsBySector\(s, \{ aceitaCache: usarCache \}\)/);
  });

  test('o snapshot do cron não pede cache', () => {
    assert.match(CRON, /await getTeams\(\{ repetirSetorFalho: true \}, sectorOut\)/);
    assert.doesNotMatch(CRON, /usarCachePainel/);
  });
});
