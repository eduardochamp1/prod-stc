/**
 * test/caminhoEdp.test.js
 *
 * 09/11/2026 (backlog P0-15). O relay ficou caído de 08/11 19h a 09/11 23h; o
 * painel só dizia "Sem coleta hoje", ninguém foi avisado e, com o túnel de volta,
 * a coleta só viria na janela seguinte. Estes testes travam:
 *   - a falha de caminho abre 1 vez (com `desde` fixo) e fecha no 1º ciclo ok;
 *   - o alerta sai só nas transições (caiu / voltou), nunca a cada janela;
 *   - o vigia só tenta com falha em aberto, porta do túnel aceitando e 30 min
 *     desde a última tentativa — e nunca sem falha registrada;
 *   - o /health no modelo de janelas (não mais "snapshot < 30 min");
 *   - o payload do Teams e que erro de rede não derruba nada.
 *
 * Nada aqui toca a EDP, o banco nem a rede (NODE_ENV=test não persiste).
 */

'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const caminho = require('../services/caminhoEdp');
const { instanteBRT } = require('../services/timeUtil');

const T0 = instanteBRT('2026-11-09', 8 * 60);   // 09/11 08:00 BRT

describe('falha de caminho: abre, mantém `desde`, fecha', () => {
  beforeEach(() => caminho._reset());

  test('1ª falha abre e avisa; as seguintes só atualizam ts', async () => {
    const avisos = [];
    const alertar = async (t) => { avisos.push(t); };
    assert.equal(caminho.falhaAtual(), null);
    await caminho.registrarFalha('snapshot', 'WPA_PROXY_INDISPONIVEL', { agora: T0, alertar });
    await caminho.registrarFalha('snapshot', 'WPA_PROXY_INDISPONIVEL', { agora: T0 + 4 * 3600_000, alertar });
    const f = caminho.falhaAtual();
    assert.equal(f.code, 'WPA_PROXY_INDISPONIVEL');
    assert.equal(f.desde, new Date(T0).toISOString());
    assert.equal(f.ts, new Date(T0 + 4 * 3600_000).toISOString());
    assert.equal(avisos.length, 1);
    assert.match(avisos[0], /parada desde 08:00/);
    assert.match(avisos[0], /túnel até a EDP fora do ar/);
  });

  test('ciclo ok fecha a falha e avisa 1 vez; ok sem falha não avisa', async () => {
    const avisos = [];
    const alertar = async (t) => { avisos.push(t); };
    assert.equal(await caminho.registrarOk({ agora: T0, alertar }), false);
    await caminho.registrarFalha('fechamento', 'WPA_PROXY_SEM_ROTA', { agora: T0, alertar });
    assert.equal(await caminho.registrarOk({ agora: T0 + 3600_000, alertar }), true);
    assert.equal(caminho.falhaAtual(), null);
    assert.equal(await caminho.registrarOk({ agora: T0 + 7200_000, alertar }), false);
    assert.equal(avisos.length, 2);
    assert.match(avisos[1], /voltou às 09:00 \(estava parada desde 08:00 de 09\/11\)/);
  });

  test('falhaAtual devolve cópia', async () => {
    await caminho.registrarFalha('snapshot', 'WPA_IP_BLOQUEADO', { agora: T0, alertar: async () => {} });
    caminho.falhaAtual().code = 'x';
    assert.equal(caminho.falhaAtual().code, 'WPA_IP_BLOQUEADO');
  });
});

describe('vigia do túnel', () => {
  beforeEach(() => caminho._reset());

  test('deveTentar: só com falha, porta ok e 30 min desde a última', () => {
    const falha = { code: 'WPA_PROXY_INDISPONIVEL', desde: 'x' };
    assert.equal(caminho.deveTentar({ falha: null, portaOk: true, agora: T0, ultimaTentativa: 0 }), false);
    assert.equal(caminho.deveTentar({ falha, portaOk: false, agora: T0, ultimaTentativa: 0 }), false);
    assert.equal(caminho.deveTentar({ falha, portaOk: true, agora: T0, ultimaTentativa: 0 }), true);
    assert.equal(caminho.deveTentar({ falha, portaOk: true, agora: T0 + 29 * 60_000, ultimaTentativa: T0 }), false);
    assert.equal(caminho.deveTentar({ falha, portaOk: true, agora: T0 + 30 * 60_000, ultimaTentativa: T0 }), true);
  });

  test('sem falha registrada o vigia nem testa a porta', async () => {
    let testes = 0, rodadas = 0;
    const v = caminho.iniciarVigia({ intervaloMs: 0, testarPorta: async () => { testes++; return { ok: true }; }, rodar: async () => { rodadas++; } });
    assert.equal(await v.passo(), false);
    assert.equal(testes, 0);
    assert.equal(rodadas, 0);
  });

  test('túnel caído não roda; quando volta roda 1 vez e espera 30 min para repetir', async () => {
    await caminho.registrarFalha('snapshot', 'WPA_PROXY_INDISPONIVEL', { agora: T0, alertar: async () => {} });
    let porta = false, rodadas = 0, agora = T0 + 60_000;
    const v = caminho.iniciarVigia({
      intervaloMs: 0, agoraFn: () => agora,
      testarPorta: async () => ({ ok: porta }),
      rodar: async () => { rodadas++; },   // a coleta falhou de novo: a falha segue aberta
    });
    assert.equal(await v.passo(), false);
    porta = true;
    assert.equal(await v.passo(), true);
    agora += 60_000;
    assert.equal(await v.passo(), false);          // 1 min depois: ainda não
    agora += 30 * 60_000;
    assert.equal(await v.passo(), true);           // 30 min depois: tenta de novo
    assert.equal(rodadas, 2);
  });

  test('dentro dos 30 min da última tentativa nem testa o túnel', async () => {
    await caminho.registrarFalha('snapshot', 'WPA_PROXY_INDISPONIVEL', { agora: T0, alertar: async () => {} });
    let testes = 0, agora = T0 + 60_000;
    const v = caminho.iniciarVigia({ intervaloMs: 0, agoraFn: () => agora, testarPorta: async () => { testes++; return { ok: true }; }, rodar: async () => {} });
    assert.equal(await v.passo(), true);
    agora += 10 * 60_000;
    assert.equal(await v.passo(), false);
    assert.equal(testes, 1);
  });

  test('coleta pulada (rodar devolve false) não consome a tentativa de 30 min', async () => {
    await caminho.registrarFalha('snapshot', 'WPA_PROXY_INDISPONIVEL', { agora: T0, alertar: async () => {} });
    let pulada = true, rodadas = 0, agora = T0 + 60_000;
    const v = caminho.iniciarVigia({
      intervaloMs: 0, agoraFn: () => agora, testarPorta: async () => ({ ok: true }),
      rodar: async () => { if (pulada) return false; rodadas++; },
    });
    assert.equal(await v.passo(), false);
    pulada = false; agora += 60_000;
    assert.equal(await v.passo(), true);           // 1 min depois, sem esperar 30
    assert.equal(rodadas, 1);
    const SRC = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'cronService.js'), 'utf8');
    assert.match(SRC, /_comColeta\('tunel-voltou', \(\) => \{ rodou = true; return runTunelVoltou\(\); \}\);\s+return rodou;/);
  });

  test('o vigia do cron testa a porta e depois um CONNECT pelo relay', () => {
    const SRC = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'cronService.js'), 'utf8');
    assert.match(SRC, /porta\.ok \? testarConnectProxy\(proxy, destino, 5000\) : porta/);
  });

  test('coleta que deu certo fecha a falha e o vigia para de agir', async () => {
    await caminho.registrarFalha('snapshot', 'WPA_PROXY_INDISPONIVEL', { agora: T0, alertar: async () => {} });
    let rodadas = 0;
    const v = caminho.iniciarVigia({
      intervaloMs: 0, agoraFn: () => T0 + 60_000,
      testarPorta: async () => ({ ok: true }),
      rodar: async () => { rodadas++; await caminho.registrarOk({ alertar: async () => {} }); },
    });
    assert.equal(await v.passo(), true);
    assert.equal(await v.passo(), false);
    assert.equal(rodadas, 1);
  });

  test('erro na coleta não escapa do passo', async () => {
    await caminho.registrarFalha('snapshot', 'WPA_PROXY_INDISPONIVEL', { agora: T0, alertar: async () => {} });
    const v = caminho.iniciarVigia({ intervaloMs: 0, testarPorta: async () => ({ ok: true }), rodar: async () => { throw new Error('boom'); } });
    assert.equal(await v.passo(), false);
  });
});

describe('/health no modelo de janelas', () => {
  const janelasH = [8, 12, 17];
  const dia = '2026-11-09';
  const em = (h, m = 0) => instanteBRT(dia, h * 60 + m);

  test('antes da 1ª janela (e até 45 min depois dela) está ok sem snapshot de hoje', () => {
    const ontem = em(17) - 86400000;
    assert.equal(caminho.avaliarSaude({ agora: em(7), ultimoSnapshotMs: ontem, janelasH }).ok, true);
    assert.equal(caminho.avaliarSaude({ agora: em(8, 30), ultimoSnapshotMs: ontem, janelasH }).ok, true);
  });

  test('janela passou há 45 min sem snapshot → degradado, dizendo qual', () => {
    const r = caminho.avaliarSaude({ agora: em(8, 46), ultimoSnapshotMs: em(17) - 86400000, janelasH });
    assert.equal(r.ok, false);
    assert.match(r.reason, /janela das 8h não coletou/);
  });

  test('snapshot da janela das 12h vale até a das 17h — 15h30 não é degradado', () => {
    assert.equal(caminho.avaliarSaude({ agora: em(15, 30), ultimoSnapshotMs: em(12, 3), janelasH }).ok, true);
    assert.equal(caminho.avaliarSaude({ agora: em(18), ultimoSnapshotMs: em(12, 3), janelasH }).ok, false);
  });

  test('falha de caminho em aberto → degradado com o motivo', () => {
    const falha = { code: 'WPA_PROXY_INDISPONIVEL', desde: new Date(em(5)).toISOString() };
    const r = caminho.avaliarSaude({ agora: em(6), ultimoSnapshotMs: em(5), janelasH, falha });
    assert.equal(r.ok, false);
    assert.match(r.reason, /parada desde 05:00: túnel até a EDP fora do ar/);
  });

  test('sem nenhum snapshot depois de uma janela → degradado', () => {
    assert.equal(caminho.avaliarSaude({ agora: em(13), ultimoSnapshotMs: null, janelasH }).ok, false);
  });
});

describe('alerta no Teams', () => {
  test('sem webhook não chama nada', async () => {
    let chamadas = 0;
    assert.equal(await caminho.alertarTeams('x', { webhook: '', fetchFn: async () => { chamadas++; } }), false);
    assert.equal(chamadas, 0);
  });

  test('manda texto e cartão adaptável; resposta ruim e erro de rede não lançam', async () => {
    const vistos = [];
    const ok = await caminho.alertarTeams('coleta parada', {
      webhook: 'http://127.0.0.1:9/hook',
      fetchFn: async (url, opts) => { vistos.push({ url, corpo: JSON.parse(opts.body), metodo: opts.method }); return { ok: true }; },
    });
    assert.equal(ok, true);
    assert.equal(vistos[0].metodo, 'POST');
    assert.equal(vistos[0].corpo.text, 'coleta parada');
    assert.equal(vistos[0].corpo.attachments[0].content.body[0].text, 'coleta parada');
    assert.equal(await caminho.alertarTeams('x', { webhook: 'http://127.0.0.1:9/h', fetchFn: async () => ({ ok: false, status: 400 }) }), false);
    assert.equal(await caminho.alertarTeams('x', { webhook: 'http://127.0.0.1:9/h', fetchFn: async () => { throw new Error('ECONNREFUSED'); } }), false);
  });
});

describe('fonte: os ganchos no cron, na rota e no painel', () => {
  const fs = require('fs');
  const path = require('path');
  const ler = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

  test('cron registra falha e ok; janela e fechamento passam por _comColeta', () => {
    const SRC = ler('services', 'cronService.js');
    assert.match(SRC, /caminhoEdp\.registrarFalha\('snapshot', sectorReport\.caminho\)/);
    assert.match(SRC, /caminhoEdp\.registrarFalha\('fechamento', err\.code\)/);
    assert.equal((SRC.match(/caminhoEdp\.registrarOk\(/g) || []).length, 2);
    assert.match(SRC, /_comColeta\('janela', \(\) => runJanela\(\)\)/);
    assert.match(SRC, /_comColeta\('fechamento', \(\) => runFechamento\(\)\)/);
  });

  test('_comColeta pula quem chega com outra coleta em curso', async () => {
    const cron = require('../services/cronService');
    const ordem = [];
    let soltar;
    const a = cron._comColeta('janela', () => new Promise(r => { soltar = () => { ordem.push('janela'); r(); }; }));
    await cron._comColeta('tunel-voltou', async () => { ordem.push('tunel'); });
    soltar();
    await a;
    await cron._comColeta('fechamento', async () => { ordem.push('fechamento'); });
    assert.deepEqual(ordem, ['janela', 'fechamento']);
  });

  test('rota devolve coleta_em.falha e o painel mostra o motivo', () => {
    assert.match(ler('routes', 'index.js'), /coletaEm\.falha = falha/);
    const HTML = ler('public', 'index.html');
    assert.match(HTML, /renderColetaCaminho\(res\.coleta_em\)/);
    assert.match(HTML, /Túnel até a EDP fora do ar/);
  });
});
