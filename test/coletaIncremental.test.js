/**
 * test/coletaIncremental.test.js
 *
 * 19/10/2026 (backlog P0-11 itens 3 e 5). A EDP questionou o volume; toda
 * sessão encerrada era rebuscada a cada ciclo até 23h45 (3 requisições por
 * sessão: rejected, executed, collaborators). Estes testes travam:
 *   3a  colaboradores de sessão encerrada: 1 busca, depois memória;
 *   3b  notas de sessão encerrada: rebuscadas de hora em hora (todo ciclo a partir
 *       das 23h BRT), memória só com as duas buscas bem-sucedidas, e falha usa a
 *       última busca boa em vez de [];
 *   5   sinal do V2 em modo sombra: mede `pularia`/`divergiu` sem deixar de
 *       buscar nada.
 * Coleta real contra servidor LOCAL (127.0.0.1) — a suíte não toca a EDP (P1-40).
 */

'use strict';

const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const incr = require('../services/coletaIncremental');

// ── funções puras ──────────────────────────────────────────────────────────

describe('rebusca espaçada da sessão encerrada (pura)', () => {
  const MEIO_DIA = Date.parse('2026-10-19T15:00:00Z');   // 12:00 BRT
  const H = 60 * 60_000;
  const reg = (buscadoEm) => ({ vistaEncerradaEm: buscadoEm, notas: { rej: [], exec: [], buscadoEm } });

  test('sem memória, ou com rebusca 0, sempre busca', () => {
    assert.equal(incr.servirDaMemoria({ notas: null }, H, MEIO_DIA), false);
    assert.equal(incr.servirDaMemoria(reg(MEIO_DIA), 0, MEIO_DIA), false);
  });

  test('serve da memória nos ciclos de :15, :30 e :45 e rebusca no de +60 (com folga de 5 min)', () => {
    const r = reg(MEIO_DIA);
    for (const min of [15, 30, 45]) assert.equal(incr.servirDaMemoria(r, H, MEIO_DIA + min * 60_000), true, `+${min}`);
    assert.equal(incr.servirDaMemoria(r, H, MEIO_DIA + 55 * 60_000), false, '+55 já rebusca');
    // O ciclo de +60 que cai 2 s ANTES do horário da última busca ainda rebusca.
    assert.equal(incr.servirDaMemoria(r, H, MEIO_DIA + H - 2000), false);
  });

  test('a partir das 23h BRT, rebusca em todo ciclo (o fechamento do dia sai fresco)', () => {
    const as2259 = Date.parse('2026-10-20T01:59:00Z');   // 22:59 BRT
    const as2300 = Date.parse('2026-10-20T02:00:00Z');   // 23:00 BRT
    assert.equal(incr.servirDaMemoria(reg(as2259 - 60_000), H, as2259), true);
    assert.equal(incr.servirDaMemoria(reg(as2300 - 60_000), H, as2300), false);
    assert.equal(incr.HORA_REBUSCA_OBRIGATORIA, 23);
  });

  test('guardarNotas ignora busca que falhou (null) — guardar [] de falha seria apagar produção', () => {
    const r = { vistaEncerradaEm: MEIO_DIA, notas: null };
    incr.guardarNotas(r, [], null, MEIO_DIA);
    assert.equal(r.notas, null);
    incr.guardarNotas(r, null, [{ Id: 'n1' }], MEIO_DIA);
    assert.equal(r.notas, null);
    incr.guardarNotas(r, [], [{ Id: 'n1' }], MEIO_DIA);
    assert.deepEqual(r.notas.exec, [{ Id: 'n1' }]);
  });

  test('lerNotas devolve cópia', () => {
    const r = { notas: null };
    incr.guardarNotas(r, [], [{ Id: 'n1' }], MEIO_DIA);
    incr.lerNotas(r).exec.push({ Id: 'x' });
    assert.equal(incr.lerNotas(r).exec.length, 1);
  });

  test('a memória zera na virada do dia BRT', () => {
    const m = incr.criarMemoria();
    incr.registroEncerrada(m, 's1', Date.parse('2026-10-20T02:50:00Z'));   // 23:50 BRT
    assert.equal(m.encerradas.size, 1);
    m.garantirDia(Date.parse('2026-10-20T03:10:00Z'));                      // 00:10 BRT
    assert.equal(m.encerradas.size, 0);
  });

  test('rebuscaMsDoEnv: vazio/lixo = 60 min; 0 = todo ciclo; número = minutos', () => {
    const antes = process.env.WPA_ENCERRADA_REBUSCA_MIN;
    for (const v of [undefined, '', 'abc', '-5']) {
      if (v === undefined) delete process.env.WPA_ENCERRADA_REBUSCA_MIN; else process.env.WPA_ENCERRADA_REBUSCA_MIN = v;
      assert.equal(incr.rebuscaMsDoEnv(), H, `valor ${v}`);
    }
    process.env.WPA_ENCERRADA_REBUSCA_MIN = '0';
    assert.equal(incr.rebuscaMsDoEnv(), 0);
    process.env.WPA_ENCERRADA_REBUSCA_MIN = '30';
    assert.equal(incr.rebuscaMsDoEnv(), 30 * 60_000);
    if (antes === undefined) delete process.env.WPA_ENCERRADA_REBUSCA_MIN; else process.env.WPA_ENCERRADA_REBUSCA_MIN = antes;
  });
});

describe('modo sombra do V2 (pura)', () => {
  const T0 = Date.parse('2026-10-19T15:00:00Z');
  const v2 = (extra = {}) => ({ LastUpdate: 'a', LastStatusUpdate: 'b', Status: 'Trabalhando', Concluded: [], Downloaded: [{ Id: 'd1', ExecutionStatus: 1 }], ...extra });

  test('1ª vez = nova; V2 diferente = v2-mudou; igual com notas iguais = pularia', () => {
    const m = incr.criarMemoria();
    const n = incr.assinaturaNotas([], [{ Id: 'e1' }]);
    assert.equal(incr.registrarSombra(m, 's', incr.assinaturaV2(v2()), n, {}, T0), 'nova');
    assert.equal(incr.registrarSombra(m, 's', incr.assinaturaV2(v2({ LastUpdate: 'z' })), n, {}, T0), 'v2-mudou');
    assert.equal(incr.registrarSombra(m, 's', incr.assinaturaV2(v2({ LastUpdate: 'z' })), n, {}, T0), 'pularia');
    assert.equal(m.contSombra.pularia, 1);
    assert.equal(m.contSombra.divergiu, 0);
  });

  test('V2 igual mas notas mudaram = divergiu (o que pular perderia), com exemplo', () => {
    const m = incr.criarMemoria();
    const s2 = incr.assinaturaV2(v2());
    incr.registrarSombra(m, 's', s2, incr.assinaturaNotas([], []), {}, T0);
    assert.equal(incr.registrarSombra(m, 's', s2, incr.assinaturaNotas([], [{ Id: 'e9' }]), { teamName: 'GUA1' }, T0), 'divergiu');
    assert.equal(m.contSombra.divergiu, 1);
    assert.equal(m.contSombra.exemplos[0].teamName, 'GUA1');
  });

  test('a assinatura do V2 enxerga mudança de ExecutionStatus na carteira', () => {
    assert.notEqual(incr.assinaturaV2(v2()), incr.assinaturaV2(v2({ Downloaded: [{ Id: 'd1', ExecutionStatus: 3 }] })));
  });
});

// ── coleta real (getTeamsBySector) contra servidor local ───────────────────

const ENGELMIG = '92a2f98e-8877-433e-8358-173b94c13a54';
let server;
let wpa;
let hits;            // path (sem query) → contagem
let executedS2 = [];
let falharExecuted = false;
let executedFechada;
// Relógio do coletaIncremental (a rebusca depende da hora BRT). 12:00 BRT por padrão.
let relogioTeste;
const avancar = (min) => { relogioTeste += min * 60_000; };

before(async () => {
  server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    hits.set(p, (hits.get(p) || 0) + 1);
    res.setHeader('Content-Type', 'application/json');
    if (p.startsWith('/identity/signin')) {
      const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64');
      return res.end(JSON.stringify({ Token: `h.${payload}.s`, Data: true, Error: null }));
    }
    if (p === '/api/Sessions/all/date') {
      return res.end(JSON.stringify({ Data: [
        { Id: 's-fechada', BeginTime: '2026-10-19T07:00:00', EndTime: '2026-10-19T16:00:00', Team: { Id: 't1', Name: 'GUA1', CompanyId: ENGELMIG } },
        { Id: 's-aberta',  BeginTime: '2026-10-19T07:00:00', EndTime: null,                  Team: { Id: 't2', Name: 'GUA2', CompanyId: ENGELMIG } },
      ] }));
    }
    if (p === '/api/teamsstatus/V2') {
      return res.end(JSON.stringify({ Data: [
        { Session: { Id: 's-aberta', Team: { Id: 't2', Name: 'GUA2' } }, LastUpdate: 'x', LastStatusUpdate: 'y', Concluded: [], Downloaded: [] },
      ] }));
    }
    if (p === '/api/notes/executed/s-fechada/session') {
      if (falharExecuted) { res.statusCode = 500; return res.end('{"Message":"erro"}'); }
      return res.end(JSON.stringify({ Data: executedFechada }));
    }
    if (p === '/api/notes/executed/s-aberta/session') return res.end(JSON.stringify({ Data: executedS2 }));
    res.end(JSON.stringify({ Data: [] }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.WPA_URL = base;
  process.env.WPA_API_URL = base;
  process.env.WPA_USERNAME = 'teste@local';
  process.env.WPA_PASSWORD = 'senha-de-teste';
  delete process.env.WPA_ACCOUNTS_DISABLED;
  delete process.env.WPA_ENCERRADA_REBUSCA_MIN;
  require('../services/wpaContador')._aoFecharHora(() => {});
  wpa = require('../services/wpaService');
  wpa._breakerHydration.done = true;
});

after(() => {
  incr.relogio.agora = () => Date.now();
  delete process.env.WPA_ENCERRADA_REBUSCA_MIN;
  require('../services/wpaContador')._aoFecharHora(null);
  return new Promise(r => server.close(r));
});

beforeEach(() => {
  hits = new Map();
  incr.memoria.encerradas.clear();
  incr.memoria.sombra.clear();
  incr.memoria.contSombra = { comparadas: 0, pularia: 0, divergiu: 0, exemplos: [] };
  executedS2 = [];
  falharExecuted = false;
  executedFechada = [{ Id: 'n-exec-1', Number: '111', ExecutionStatus: 4 }];
  relogioTeste = Date.parse('2026-10-19T15:00:00Z');
  incr.relogio.agora = () => relogioTeste;
  delete process.env.WPA_ENCERRADA_REBUSCA_MIN;
});

const coletar = () => wpa.getTeamsBySector('DESG');
const n = (p) => hits.get(p) || 0;
const sessaoFechada = (teams) => teams.find(t => t.id === 's-fechada');

describe('coleta real', () => {
  test('3a: colaboradores da sessão encerrada são buscados UMA vez', async () => {
    await coletar(); await coletar(); await coletar();
    assert.equal(n('/api/collaborators/s-fechada/session'), 1);
  });

  test('3b padrão (60 min): busca 1×, serve da memória em :15/:30/:45 e rebusca em +60', async () => {
    await coletar();
    for (let k = 0; k < 3; k++) { avancar(15); await coletar(); }
    assert.equal(n('/api/notes/executed/s-fechada/session'), 1, 'só a 1ª busca dentro da hora');
    assert.equal(n('/api/notes/rejected/s-fechada/session'), 1);
    avancar(15);
    await coletar();
    assert.equal(n('/api/notes/executed/s-fechada/session'), 2, 'rebusca na hora seguinte');
  });

  test('3b: nota que chega depois aparece na rebusca seguinte (nada se perde, só atrasa)', async () => {
    const t1 = sessaoFechada(await coletar());
    assert.deepEqual(t1.notasExecutadas.map(x => x.id), ['n-exec-1']);
    executedFechada = [{ Id: 'n-exec-1', Number: '111', ExecutionStatus: 4 }, { Id: 'n-tardia', Number: '333', ExecutionStatus: 4 }];
    avancar(30);
    assert.equal(sessaoFechada(await coletar()).notasExecutadas.length, 1, 'ainda da memória');
    avancar(30);
    assert.deepEqual(sessaoFechada(await coletar()).notasExecutadas.map(x => x.id).sort(), ['n-exec-1', 'n-tardia']);
  });

  test('3b: a partir das 23h BRT, rebusca em todo ciclo', async () => {
    relogioTeste = Date.parse('2026-10-20T02:05:00Z');   // 23:05 BRT de 19/10
    await coletar(); avancar(15); await coletar(); avancar(15); await coletar();
    assert.equal(n('/api/notes/executed/s-fechada/session'), 3);
  });

  test('3b: WPA_ENCERRADA_REBUSCA_MIN=0 volta ao comportamento antigo (todo ciclo)', async () => {
    process.env.WPA_ENCERRADA_REBUSCA_MIN = '0';
    await coletar(); avancar(15); await coletar();
    assert.equal(n('/api/notes/executed/s-fechada/session'), 2);
  });

  test('3b: rebusca que FALHA usa a última bem-sucedida (não vira []), e tenta de novo no ciclo seguinte', async () => {
    await coletar();
    avancar(60);
    falharExecuted = true;
    const t = sessaoFechada(await coletar());
    assert.deepEqual(t.notasExecutadas.map(x => x.id), ['n-exec-1'], 'vazio de falha não é "sem produção"');
    falharExecuted = false;
    avancar(15);
    await coletar();
    assert.equal(n('/api/notes/executed/s-fechada/session'), 3, 'a falha não conta como busca: tenta no ciclo seguinte');
  });

  // 24/10/2026 (spec wpa-acesso-edp.md, R3.2): era "sem memória, falha segue
  // virando []" — o bucket vazio ia pro snapshot como sessão sem produção. Agora a
  // falha sobe e o setor fica de fora do ciclo; a memória continua sem notas.
  test('3b: sem memória, falha derruba o setor no ciclo (não vira [])', async () => {
    falharExecuted = true;
    await assert.rejects(coletar(), (err) => err.code === 'WPA_HTTP_500');
    assert.equal(incr.memoria.encerradas.get('s-fechada').notas, null);
  });

  test('5 sombra: nada deixa de ser buscado; mede pularia e divergiu', async () => {
    await coletar();
    await coletar();                       // V2 igual, notas iguais → pularia
    executedS2 = [{ Id: 'n-nova', Number: '222', ExecutionStatus: 4 }];
    await coletar();                       // V2 igual (cache 3 min), notas mudaram → divergiu
    assert.equal(n('/api/notes/executed/s-aberta/session'), 3, 'a sessão ativa é buscada todo ciclo');
    const e = incr.estado();
    assert.equal(e.sombraV2.pularia, 1);
    assert.equal(e.sombraV2.divergiu, 1);
    assert.equal(e.sombraV2.exemplos[0].teamName, 'GUA2');
  });
});
