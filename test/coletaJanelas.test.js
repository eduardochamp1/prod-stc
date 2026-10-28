/**
 * test/coletaJanelas.test.js
 *
 * 28/10/2026 (backlog P0-12). A EDP só é chamada em horário marcado: janelas às
 * 08h, 12h e 17h, fechamento do D-1 às 05h e o botão do admin (1 a cada 30 min).
 * O painel só lê a coleta guardada. Estes testes travam:
 *   - a agenda: só `janela` e `fechamento` vão à EDP; nada a cada 15 min nem de hora em hora;
 *   - o boot: startCron não agenda coleta nem login com setTimeout;
 *   - o painel: `soGuardado` nunca faz requisição, serve só coleta de HOJE;
 *   - o limite do botão e a próxima janela.
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
let pedidos = 0;
let wpa;
let contador;

before(async () => {
  server = http.createServer((req, res) => { pedidos++; res.end('{}'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.WPA_URL = base;
  process.env.WPA_API_URL = base;
  delete process.env.WPA_ACCOUNTS_DISABLED;
  contador = require('../services/wpaContador');
  contador._aoFecharHora(() => {});
  wpa = require('../services/wpaService');
  wpa._breakerHydration.done = true;
});

after(() => { contador._aoFecharHora(null); return new Promise(r => server.close(r)); });

// ── agenda e boot ─────────────────────────────────────────────────────────────

describe('startCron', () => {
  test('agenda só janela (08,12,17h), fechamento (05h) e os jobs só-banco; boot não coleta', () => {
    const agendados = [];
    const modCron = require.resolve('node-cron');
    const original = require.cache[modCron];
    require.cache[modCron] = { id: modCron, filename: modCron, loaded: true,
      exports: { schedule: (expr) => { agendados.push(expr); return { stop() {} }; } } };
    delete require.cache[require.resolve('../services/cronService')];
    const timers = [];
    const setTimeoutOrig = global.setTimeout;
    const modo = process.env.DATA_MODE;
    try {
      process.env.DATA_MODE = 'wpa';
      global.setTimeout = (...a) => { timers.push(a); return 0; };
      require('../services/cronService').startCron();
    } finally {
      global.setTimeout = setTimeoutOrig;
      process.env.DATA_MODE = modo;
      if (original) require.cache[modCron] = original; else delete require.cache[modCron];
      delete require.cache[require.resolve('../services/cronService')];
      global._extraCronJobs = [];
    }
    assert.deepEqual(agendados.sort(), ['0 2 * * *', '0 5 * * *', '0 8,12,17 * * *', '50 23 * * *'].sort());
    assert.equal(timers.length, 0, 'boot não agenda login nem snapshot');
  });

  test('fonte: consolidação e drift-sweep não chamam a EDP (só banco)', () => {
    const SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'cronService.js'), 'utf8');
    const corpo = (nome) => SRC.slice(SRC.indexOf(`async function ${nome}(`), SRC.indexOf('\n}\n', SRC.indexOf(`async function ${nome}(`)));
    for (const nome of ['runConsolidate', 'runDailyDriftSweep']) {
      assert.doesNotMatch(corpo(nome), /wpaService|getTeams|wpaFetch/, nome);
    }
  });
});

// ── botão do admin e próxima janela ──────────────────────────────────────────

describe('janelas e botão', () => {
  const cron = require('../services/cronService');

  test('próxima janela em BRT', () => {
    const iso = (ms) => new Date(ms).toISOString();
    assert.equal(iso(cron.proximaJanela(Date.parse('2026-10-28T09:00:00Z'))), '2026-10-28T11:00:00.000Z'); // 06h → 08h
    assert.equal(iso(cron.proximaJanela(Date.parse('2026-10-28T11:00:00Z'))), '2026-10-28T15:00:00.000Z'); // 08h → 12h
    assert.equal(iso(cron.proximaJanela(Date.parse('2026-10-28T16:30:00Z'))), '2026-10-28T20:00:00.000Z'); // 13h30 → 17h
    assert.equal(iso(cron.proximaJanela(Date.parse('2026-10-28T21:00:00Z'))), '2026-10-29T11:00:00.000Z'); // 18h → 08h amanhã
  });

  test('1 atualização manual a cada 30 min', () => {
    const estado = { ultima: 0 };
    const t0 = Date.parse('2026-10-28T13:00:00Z');
    assert.deepEqual(cron.reservarAtualizacaoManual(t0, estado), { ok: true });
    const r = cron.reservarAtualizacaoManual(t0 + 29 * 60_000, estado);
    assert.equal(r.ok, false);
    assert.equal(r.liberaEm, t0 + 30 * 60_000);
    assert.equal(estado.ultima, t0, 'recusa não renova a marca');
    assert.deepEqual(cron.reservarAtualizacaoManual(t0 + 30 * 60_000, estado), { ok: true });
  });

  test('fonte: /admin/atualizar-agora e /admin/snapshot passam pelo mesmo limite (e /admin exige admin)', () => {
    const ROTAS = fs.readFileSync(path.join(__dirname, '..', 'routes', 'index.js'), 'utf8');
    assert.match(ROTAS, /router\.use\('\/admin', requireAdmin\)/);
    assert.match(ROTAS, /router\.post\('\/admin\/snapshot', _atualizarAgora\)/);
    assert.match(ROTAS, /router\.post\('\/admin\/atualizar-agora', _atualizarAgora\)/);
    assert.match(ROTAS, /reservarAtualizacaoManual\(\)[\s\S]{0,80}status\(429\)/);
  });
});

// ── painel só lê o guardado ──────────────────────────────────────────────────

describe('painel (soGuardado)', () => {
  const total = () => contador.resumo().total || 0;

  test('sem coleta guardada: [] e nenhuma requisição', async () => {
    wpa._cacheSetor.clear();
    wpa._hidratado.add('DESG');   // não procura no banco
    const antes = pedidos, cAntes = total();
    assert.deepEqual(await wpa.getTeamsBySector('DESG', { soGuardado: true }), []);
    assert.equal(pedidos, antes);
    assert.equal(total(), cAntes);
    assert.equal(wpa.coletaGuardadaEm('DESG'), null);
  });

  test('coleta de hoje, de qualquer idade, é servida em cópia e sem requisição', async () => {
    wpa._cacheSetor.clear();
    const seisHorasAtras = Date.now() - 6 * 3600_000;
    wpa._gravarCacheSetor(wpa._cacheSetor, 'DESG', [{ teamName: 'EQA' }], seisHorasAtras);
    const antes = pedidos;
    const r = await wpa.getTeamsBySector('DESG', { soGuardado: true });
    if (wpa._cacheSetor.get('DESG').dia !== require('../services/timeUtil').dateBRT()) return;   // virou o dia BRT entre as linhas
    assert.deepEqual(r, [{ teamName: 'EQA' }]);
    r[0].teamName = 'mexido';
    assert.deepEqual(await wpa.getTeamsBySector('DESG', { soGuardado: true }), [{ teamName: 'EQA' }]);
    assert.equal(pedidos, antes);
    assert.equal(wpa.coletaGuardadaEm('DESG'), seisHorasAtras);
  });

  test('coleta de ontem não é servida', async () => {
    wpa._cacheSetor.clear();
    wpa._gravarCacheSetor(wpa._cacheSetor, 'DESG', [{ teamName: 'EQA' }], Date.now() - 30 * 3600_000);
    assert.deepEqual(await wpa.getTeamsBySector('DESG', { soGuardado: true }), []);
  });

  test('depois de reiniciar, lê a coleta gravada no banco uma vez só', async () => {
    wpa._cacheSetor.clear();
    wpa._hidratado.delete('DEPT');
    const agora = Date.now();
    const linha = { ts: agora, dia: require('../services/timeUtil').dateBRT(agora), valor: [{ teamName: 'EQB' }] };
    let leituras = 0;
    const ler = async (k) => { leituras++; assert.equal(k, 'painel_coleta_DEPT'); return { data: linha }; };
    assert.deepEqual(await wpa._lerGuardadoPainel('DEPT', ler), [{ teamName: 'EQB' }]);
    await wpa._lerGuardadoPainel('DEPT', ler);
    assert.equal(leituras, 1);
  });

  test('falha ao ler o banco: [] e segue', async () => {
    wpa._cacheSetor.clear();
    wpa._hidratado.delete('DESC');
    assert.deepEqual(await wpa._lerGuardadoPainel('DESC', async () => { throw new Error('pg fora'); }), []);
  });
});
