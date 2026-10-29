/**
 * test/coletorLocal.test.js
 *
 * 29/10/2026 (backlog P0-13). A coleta da EDP roda num executável fora da VM
 * (coletor.js + services/coletorLocal.js) e grava no banco da VM. Estes testes
 * travam:
 *   - quando o coletor chama a EDP: janela, fechamento pendente (1ª coleta do
 *     dia), UMA janela perdida ao ligar, pedido do painel — e nada mais;
 *   - a fila de 1 (nada se sobrepõe);
 *   - a VM com WPA_COLETA=remota: cron só com jobs de banco, botão vira pedido,
 *     painel relê o guardado quando o coletor grava;
 *   - o coletor.env gerado: lista fechada de chaves, banco pelo túnel.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const col = require('../services/coletorLocal');
const BRT = (iso) => Date.parse(iso + '-03:00');

describe('funções puras', () => {
  test('fechamento pendente: a partir das 05h, se o carimbo não é de ontem', () => {
    assert.equal(col.fechamentoPendente(BRT('2026-10-29T04:59:00'), null), false);
    assert.equal(col.fechamentoPendente(BRT('2026-10-29T05:00:00'), null), true);
    assert.equal(col.fechamentoPendente(BRT('2026-10-29T09:00:00'), { date: '2026-10-27' }), true);
    assert.equal(col.fechamentoPendente(BRT('2026-10-29T09:00:00'), { date: '2026-10-28' }), false);
  });

  test('janela pendente: a última de hoje que passou sem coleta', () => {
    const J = [8, 12, 17];
    assert.equal(col.janelaPendente(BRT('2026-10-29T07:00:00'), null, J), null, 'antes das 08h não há');
    assert.equal(col.janelaPendente(BRT('2026-10-29T09:00:00'), null, J), BRT('2026-10-29T08:00:00'));
    assert.equal(col.janelaPendente(BRT('2026-10-29T13:00:00'), BRT('2026-10-29T08:01:00'), J), BRT('2026-10-29T12:00:00'));
    assert.equal(col.janelaPendente(BRT('2026-10-29T13:00:00'), BRT('2026-10-29T12:02:00'), J), null);
    assert.equal(col.janelaPendente(BRT('2026-10-29T18:00:00'), BRT('2026-10-29T08:01:00'), J), BRT('2026-10-29T17:00:00'),
      'perdeu 12h e 17h: roda UMA, não duas');
  });

  test('pedido novo só se mais recente que o atendido', () => {
    assert.equal(col.pedidoNovo(null, null), false);
    assert.equal(col.pedidoNovo({ ts: '2026-10-29T13:00:00Z' }, null), true);
    assert.equal(col.pedidoNovo({ ts: '2026-10-29T13:00:00Z' }, { ts: '2026-10-29T13:00:00Z' }), false);
    assert.equal(col.pedidoNovo({ ts: '2026-10-29T14:00:00Z' }, { ts: '2026-10-29T13:00:00Z' }), true);
  });

  test('fila de 1: tarefas em série, erro não trava a próxima', async () => {
    const fila = col.criarFila();
    const ordem = [];
    const dorme = (ms) => new Promise(r => setTimeout(r, ms));
    await Promise.all([
      fila.rodar('a', async () => { ordem.push('a+'); await dorme(20); ordem.push('a-'); }),
      fila.rodar('b', async () => { ordem.push('b+'); throw new Error('falhou'); }),
      fila.rodar('c', async () => { ordem.push('c+'); }),
    ]);
    assert.deepEqual(ordem, ['a+', 'a-', 'b+', 'c+']);
    assert.equal(fila.ocupada, false);
  });
});

// ── o coletor com dependências falsas ───────────────────────────────────────

function montar({ agora, settings = {} }) {
  const chamadas = [];
  const banco = { ...settings };
  const agendados = {};
  const cronService = {
    JANELAS_COLETA_H: [8, 12, 17], FECHAMENTO_H: 5, FECHAMENTO_SETTING: 'fechamento_ok',
    runJanela: async () => { chamadas.push('janela'); banco.snapshot_last_ok = { ts: new Date(agora.t).toISOString() }; },
    runFechamento: async () => { chamadas.push('fechamento'); banco.fechamento_ok = { date: new Date(agora.t - 86400000 - 3 * 3600000).toISOString().slice(0, 10) }; },
    runSnapshot: async () => { chamadas.push('snapshot'); },
  };
  const queries = {
    getSetting: async (k) => (k in banco ? { data: banco[k] } : null),
    setSetting: async (k, v) => { banco[k] = v; },
  };
  const c = col.iniciarColetor({
    cronService, queries, contador: { comOrigem: (_o, fn) => fn() },
    agendar: (expr, fn) => { agendados[expr] = fn; return { stop() {} }; },
    agora: () => agora.t, host: 'teste',
    setInterval: () => 0, clearInterval: () => {},
  });
  return { c, chamadas, banco, agendados };
}

describe('iniciarColetor', () => {
  test('agenda só as janelas e o fechamento', async () => {
    const { c, agendados } = montar({ agora: { t: BRT('2026-10-29T03:00:00') } });
    await c.inicio;
    assert.deepEqual(Object.keys(agendados).sort(), ['0 5 * * *', '0 8,12,17 * * *']);
  });

  test('ligou às 09h sem fechamento e sem coleta: fecha D-1 e roda UMA janela', async () => {
    const { c, chamadas } = montar({ agora: { t: BRT('2026-10-29T09:00:00') } });
    await c.inicio;
    assert.deepEqual(chamadas, ['fechamento', 'janela']);
  });

  test('ligou às 03h: nada (nem fechamento, nem janela)', async () => {
    const { c, chamadas } = montar({ agora: { t: BRT('2026-10-29T03:00:00') } });
    await c.inicio;
    assert.deepEqual(chamadas, []);
  });

  test('ligou às 13h com fechamento feito e coleta das 12h: nada', async () => {
    const { c, chamadas } = montar({ agora: { t: BRT('2026-10-29T13:00:00') }, settings: {
      fechamento_ok: { date: '2026-10-28' }, snapshot_last_ok: { ts: new Date(BRT('2026-10-29T12:01:00')).toISOString() } } });
    await c.inicio;
    assert.deepEqual(chamadas, []);
  });

  test('janela agendada: 1ª do dia fecha o D-1 antes; as seguintes não', async () => {
    const agora = { t: BRT('2026-10-29T03:00:00') };
    const { c, chamadas, agendados } = montar({ agora });
    await c.inicio;
    agora.t = BRT('2026-10-29T08:00:00');
    await agendados['0 8,12,17 * * *']();
    agora.t = BRT('2026-10-29T12:00:00');
    await agendados['0 8,12,17 * * *']();
    assert.deepEqual(chamadas, ['fechamento', 'janela', 'janela']);
  });

  test('pedido do painel: atende uma vez e marca atendido; batimento sempre', async () => {
    const agora = { t: BRT('2026-10-29T03:00:00') };
    const { c, chamadas, banco } = montar({ agora });
    await c.inicio;
    await c.verificar();
    assert.deepEqual(chamadas, [], 'sem pedido, só banco');
    assert.ok(banco.coletor_vivo && banco.coletor_vivo.host === 'teste');
    banco.coleta_pedido = { ts: '2026-10-29T06:10:00.000Z', por: 'jose' };
    await c.verificar();
    await c.verificar();
    assert.deepEqual(chamadas, ['snapshot']);
    assert.equal(banco.coleta_pedido_atendido.ts, '2026-10-29T06:10:00.000Z');
    assert.equal(banco.coleta_pedido_atendido.ok, true);
  });
});

// ── VM com WPA_COLETA=remota ────────────────────────────────────────────────

describe('VM remota', () => {
  test('cron só com consolidação e drift-sweep (nada de EDP)', () => {
    const agendados = [];
    const modCron = require.resolve('node-cron');
    const original = require.cache[modCron];
    require.cache[modCron] = { id: modCron, filename: modCron, loaded: true,
      exports: { schedule: (expr) => { agendados.push(expr); return { stop() {} }; } } };
    delete require.cache[require.resolve('../services/cronService')];
    const antes = { DATA_MODE: process.env.DATA_MODE, WPA_COLETA: process.env.WPA_COLETA };
    try {
      process.env.DATA_MODE = 'wpa';
      process.env.WPA_COLETA = 'remota';
      require('../services/cronService').startCron();
    } finally {
      for (const [k, v] of Object.entries(antes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      if (original) require.cache[modCron] = original; else delete require.cache[modCron];
      delete require.cache[require.resolve('../services/cronService')];
      global._extraCronJobs = [];
    }
    assert.deepEqual(agendados.sort(), ['0 2 * * *', '50 23 * * *']);
  });

  test('modoColeta: valor desconhecido vira local', () => {
    const c = require('../services/cronService');
    const antes = process.env.WPA_COLETA;
    try {
      process.env.WPA_COLETA = 'REMOTA '; assert.equal(c.modoColeta(), 'remota');
      process.env.WPA_COLETA = 'xyz'; assert.equal(c.modoColeta(), 'local');
      delete process.env.WPA_COLETA; assert.equal(c.modoColeta(), 'local');
    } finally { if (antes === undefined) delete process.env.WPA_COLETA; else process.env.WPA_COLETA = antes; }
  });

  test('painel relê o guardado quando o coletor grava (só olha updated_at a cada 1 min)', async () => {
    const wpa = require('../services/wpaService');
    const { dateBRT } = require('../services/timeUtil');
    const antes = process.env.WPA_COLETA;
    process.env.WPA_COLETA = 'remota';
    try {
      wpa._cacheSetor.clear(); wpa._checadoEm.clear();
      const t0 = Date.now();
      let versao = 'v1', leituras = 0, versoes = 0;
      let linha = { ts: t0 - 1000, dia: dateBRT(t0), valor: [{ teamName: 'EQA' }] };
      const ler = async () => { leituras++; return { data: linha }; };
      const lerVersao = async () => { versoes++; return versao; };
      assert.deepEqual(await wpa._lerGuardadoPainel('DESG', ler, lerVersao, t0), [{ teamName: 'EQA' }]);
      assert.deepEqual(await wpa._lerGuardadoPainel('DESG', ler, lerVersao, t0 + 30_000), [{ teamName: 'EQA' }]);
      assert.equal(versoes, 1, 'dentro de 1 min não olha o banco');
      await wpa._lerGuardadoPainel('DESG', ler, lerVersao, t0 + 61_000);
      assert.equal(leituras, 1, 'mesma versão: não relê o conteúdo');
      versao = 'v2';
      linha = { ts: t0 + 100_000, dia: dateBRT(t0), valor: [{ teamName: 'EQB' }] };
      assert.deepEqual(await wpa._lerGuardadoPainel('DESG', ler, lerVersao, t0 + 125_000), [{ teamName: 'EQB' }]);
      assert.equal(leituras, 2);
    } finally {
      if (antes === undefined) delete process.env.WPA_COLETA; else process.env.WPA_COLETA = antes;
      wpa._cacheSetor.clear(); wpa._checadoEm.clear();
    }
  });

  test('fonte: botão em modo remota grava o pedido e responde 202', () => {
    const ROTAS = fs.readFileSync(path.join(__dirname, '..', 'routes', 'index.js'), 'utf8');
    assert.match(ROTAS, /modoColeta\(\) === 'remota'\) \{[\s\S]{0,300}setSetting\(PEDIDO_SETTING[\s\S]{0,120}status\(202\)/);
  });
});

// ── pacote ──────────────────────────────────────────────────────────────────

describe('coletor.env gerado', () => {
  const { gerarColetorEnv } = require('../scripts/coletor-windows/montar-pacote');
  const ENV = [
    'PORT=3002', 'JWT_SECRET=x', 'WPA_COLETA=remota', 'AUTH_USERS=a:b', 'CRON_SECRET=y', 'DATA_MODE=wpa',
    'WPA_USERNAME=u', 'WPA_PASSWORD=p', 'WPA_PROXY=http://127.0.0.1:3128', 'WPA_ACCOUNTS_DISABLED=sp2',
    'DATABASE_URL=postgresql://wpa:s3nha@localhost:5432/wpa', 'GSEQ_DATABASE_URL=postgresql://g:h@localhost:5432/gseq',
    '# WPA_COMENTADO=1',
  ].join('\n');
  const out = gerarColetorEnv(ENV);

  test('só as chaves da lista; sem proxy, JWT, usuários do painel nem CRON_SECRET', () => {
    for (const k of ['PORT', 'JWT_SECRET', 'AUTH_USERS', 'CRON_SECRET', 'WPA_PROXY', 'WPA_COLETA', 'DATA_MODE', 'WPA_COMENTADO']) {
      assert.doesNotMatch(out, new RegExp(`^${k}=`, 'm'), k);
    }
    for (const k of ['WPA_USERNAME=u', 'WPA_PASSWORD=p', 'WPA_ACCOUNTS_DISABLED=sp2']) assert.match(out, new RegExp(`^${k}\\r?$`, 'm'));
  });

  test('banco reescrito para o túnel 127.0.0.1:15432', () => {
    assert.match(out, /^DATABASE_URL=postgresql:\/\/wpa:s3nha@127\.0\.0\.1:15432\/wpa\r?$/m);
    assert.match(out, /^GSEQ_DATABASE_URL=postgresql:\/\/g:h@127\.0\.0\.1:15432\/gseq\r?$/m);
  });
});
