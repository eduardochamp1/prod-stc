/**
 * test/coletaIncremental.test.js
 *
 * 19/10/2026 (backlog P0-11 itens 3 e 5). A EDP questionou o volume; toda
 * sessão encerrada era rebuscada a cada ciclo até 23h45 (3 requisições por
 * sessão: rejected, executed, collaborators). Estes testes travam:
 *   3a  colaboradores de sessão encerrada: 1 busca, depois memória;
 *   3b  notas de sessão encerrada: congelam SÓ depois da janela, SÓ com as duas
 *       buscas bem-sucedidas, e a janela é DESLIGADA por padrão;
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

describe('janela da sessão encerrada (pura)', () => {
  const T0 = Date.parse('2026-10-19T19:00:00Z');   // 16:00 BRT

  test('desligada (0) nunca congela', () => {
    const r = { vistaEncerradaEm: T0, notas: { buscadoEm: T0 + 10 * 3600_000 } };
    assert.equal(incr.notasCongeladas(r, 0), false);
  });

  test('congela só com busca feita DEPOIS de vista + janela', () => {
    const jan = 60 * 60_000;
    assert.equal(incr.notasCongeladas({ vistaEncerradaEm: T0, notas: { buscadoEm: T0 + jan - 1 } }, jan), false);
    assert.equal(incr.notasCongeladas({ vistaEncerradaEm: T0, notas: { buscadoEm: T0 + jan } }, jan), true);
    assert.equal(incr.notasCongeladas({ vistaEncerradaEm: T0, notas: null }, jan), false);
  });

  test('guardarNotas ignora busca que falhou (null) — congelar [] de falha apagaria produção', () => {
    const r = { vistaEncerradaEm: T0, notas: null };
    incr.guardarNotas(r, [], null, T0);
    assert.equal(r.notas, null);
    incr.guardarNotas(r, null, [{ Id: 'n1' }], T0);
    assert.equal(r.notas, null);
    incr.guardarNotas(r, [], [{ Id: 'n1' }], T0);
    assert.deepEqual(r.notas.exec, [{ Id: 'n1' }]);
  });

  test('lerNotas devolve cópia', () => {
    const r = { notas: null };
    incr.guardarNotas(r, [], [{ Id: 'n1' }], T0);
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

  test('congelaMsDoEnv: vazio/0/lixo = desligado; número = minutos', () => {
    const antes = process.env.WPA_ENCERRADA_CONGELA_MIN;
    for (const v of [undefined, '', '0', 'abc', '-5']) {
      if (v === undefined) delete process.env.WPA_ENCERRADA_CONGELA_MIN; else process.env.WPA_ENCERRADA_CONGELA_MIN = v;
      assert.equal(incr.congelaMsDoEnv(), 0, `valor ${v}`);
    }
    process.env.WPA_ENCERRADA_CONGELA_MIN = '90';
    assert.equal(incr.congelaMsDoEnv(), 90 * 60_000);
    if (antes === undefined) delete process.env.WPA_ENCERRADA_CONGELA_MIN; else process.env.WPA_ENCERRADA_CONGELA_MIN = antes;
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
      return res.end(JSON.stringify({ Data: [{ Id: 'n-exec-1', Number: '111', ExecutionStatus: 4 }] }));
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
  delete process.env.WPA_ENCERRADA_CONGELA_MIN;
  require('../services/wpaContador')._aoFecharHora(() => {});
  wpa = require('../services/wpaService');
  wpa._breakerHydration.done = true;
});

after(() => {
  delete process.env.WPA_ENCERRADA_CONGELA_MIN;
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
  delete process.env.WPA_ENCERRADA_CONGELA_MIN;
});

const coletar = () => wpa.getTeamsBySector('DESG');
const n = (p) => hits.get(p) || 0;
const sessaoFechada = (teams) => teams.find(t => t.id === 's-fechada');

describe('coleta real', () => {
  test('3a: colaboradores da sessão encerrada são buscados UMA vez', async () => {
    await coletar(); await coletar(); await coletar();
    assert.equal(n('/api/collaborators/s-fechada/session'), 1);
  });

  test('3b DESLIGADO (padrão): notas da encerrada rebuscadas a cada ciclo, como antes', async () => {
    await coletar(); await coletar();
    assert.equal(n('/api/notes/executed/s-fechada/session'), 2);
    assert.equal(n('/api/notes/rejected/s-fechada/session'), 2);
  });

  test('3b LIGADO: dentro da janela rebusca; depois da janela, congela e devolve as mesmas notas', async () => {
    process.env.WPA_ENCERRADA_CONGELA_MIN = '60';
    const t1 = sessaoFechada(await coletar());
    assert.equal(n('/api/notes/executed/s-fechada/session'), 1);
    await coletar();   // ainda dentro da janela (vista agora)
    assert.equal(n('/api/notes/executed/s-fechada/session'), 2);

    // Volta o relógio: vista encerrada há 2h, última busca há 1h30 (ainda DENTRO
    // da janela de 60 min). A próxima busca é a primeira pós-janela…
    const reg = incr.memoria.encerradas.get('s-fechada');
    reg.vistaEncerradaEm = Date.now() - 2 * 3600_000;
    reg.notas.buscadoEm  = Date.now() - 90 * 60_000;
    await coletar();
    assert.equal(n('/api/notes/executed/s-fechada/session'), 3, 'a primeira busca pós-janela ainda vai à EDP');
    // …e a partir dela, congela.
    const t4 = sessaoFechada(await coletar());
    const t5 = sessaoFechada(await coletar());
    assert.equal(n('/api/notes/executed/s-fechada/session'), 3, 'congelada: nenhuma busca nova');
    assert.equal(n('/api/notes/rejected/s-fechada/session'), 3);
    assert.deepEqual(t4.notasExecutadas.map(x => x.id), t1.notasExecutadas.map(x => x.id));
    assert.deepEqual(t5.notasExecutadas.map(x => x.id), ['n-exec-1']);
  });

  test('3b LIGADO: busca que FALHOU não congela — continua indo à EDP', async () => {
    process.env.WPA_ENCERRADA_CONGELA_MIN = '60';
    falharExecuted = true;
    await coletar();
    incr.memoria.encerradas.get('s-fechada').vistaEncerradaEm = Date.now() - 2 * 3600_000;
    await coletar();
    await coletar();
    assert.equal(n('/api/notes/executed/s-fechada/session'), 3, 'sem busca bem-sucedida, nada congela');
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
