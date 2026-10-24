/**
 * services/wpaContador.js
 * Conta TODA requisição HTTP que sai daqui para a EDP — por hora BRT, endpoint
 * e origem (painel × cron).
 *
 * ⚠️ POR QUE EXISTE (19/10/2026, backlog P0-11): a EDP questionou "diversas
 * requisições" que estariam congestionando a WPA, e não tínhamos como responder
 * quantas eram nossas. O P0-9 descartou "fomos nós" olhando ~198 linhas `[WPA]`
 * de log por ciclo — mas essas linhas são por SETOR, não por requisição, e o
 * painel aberto no navegador (que faz uma coleta completa a cada 5 min, por aba)
 * nunca entrou na conta. Daqui em diante é número medido, não estimativa.
 *
 * Onde conta: services/wpaHttp.js, o ponto único de saída HTTP para a EDP —
 * login, Web API e /admin/wpa-diag. Retries do wpaFetch contam uma vez cada:
 * é o que a EDP recebe.
 *
 * Origem: AsyncLocalStorage. O server.js marca cada requisição de /api como
 * `painel:<MÉTODO> <rota>`, o cronService marca cada job como `cron:<nome>`, e o
 * que não tem marca (boot, warm do token) fica `interno`. As caudas sem await do
 * snapshot herdam `cron:snapshot` — é delas mesmo.
 *
 * Custo: um Map em memória com no máximo HORAS_RETIDAS baldes. Sem banco, sem
 * rede. Estado de PROCESSO — vale porque o PM2 roda instances=1 (CLAUDE.md,
 * regra 8). Restart zera a memória; o histórico que sobrevive é a linha
 * `wpa_requisicoes_hora` que o log ganha a cada virada de hora.
 *
 * Como ler:
 *   GET /api/admin/wpa-requisicoes                       (memória, últimas 48h)
 *   grep wpa_requisicoes_hora ~/prod-stc/logs/out.log    (histórico, sobrevive a restart)
 */

'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const HORAS_RETIDAS = 48;
const ORIGEM_PADRAO = 'interno';
const TZ = 'America/Sao_Paulo';

const _als = new AsyncLocalStorage();
const _horas = new Map();   // 'YYYY-MM-DD HHh' → { total, erros, porOrigem: Map, porEndpoint: Map }
let _horaCorrente = null;
let _aoFechar = _logarHoraFechada;

const _fmtHora = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
});

function _rotuloHora(ms) {
  const p = Object.fromEntries(_fmtHora.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}h`;
}

const _UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// Número de 5+ dígitos é id (nota, sessão); curto fica, porque mês/ano de
// collaboratorshifts e o V2 do teamsstatus são parte do endpoint.
const _NUM_LONGO_RE = /\/\d{5,}(?=\/|$)/g;

function _template(path) {
  return path.replace(_UUID_RE, '{id}').replace(_NUM_LONGO_RE, '/{n}');
}

/** 'GET /api/notes/rejected/{id}/session' — sem host e sem query. Nunca lança. */
function normalizarEndpoint(url, method) {
  const m = String(method || 'GET').toUpperCase();
  let path;
  try {
    path = new URL(String(url)).pathname;
  } catch {
    path = String(url ?? '?').split('?')[0] || '?';
  }
  return `${m} ${_template(path)}`;
}

/**
 * Origem para uma requisição HTTP nossa. Path relativo a /api. As rotas
 * /api/cron (CRON_SECRET, crontab) não são o painel e ganham prefixo próprio.
 */
function origemDaRota(method, path) {
  const rota = _template(String(path || '/').split('?')[0]).replace(/\/\d+(?=\/|$)/g, '/{n}');
  const prefixo = /^\/cron(\/|$)/.test(rota) ? 'cron-http' : 'painel';
  return `${prefixo}:${String(method || 'GET').toUpperCase()} ${rota}`;
}

/** Roda `fn` com a origem marcada; tudo que ela disparar (com ou sem await) herda. */
function comOrigem(origem, fn) {
  return _als.run({ origem }, fn);
}

function origemAtual() {
  return _als.getStore()?.origem || ORIGEM_PADRAO;
}

function _balde(rotulo) {
  let b = _horas.get(rotulo);
  if (!b) {
    b = { total: 0, erros: 0, porOrigem: new Map(), porStatus: new Map(), porEndpoint: new Map() };
    _horas.set(rotulo, b);
    // Map preserva ordem de inserção: o primeiro é o mais antigo.
    while (_horas.size > HORAS_RETIDAS) _horas.delete(_horas.keys().next().value);
  }
  return b;
}

/**
 * Registra uma requisição. Nunca lança — contador não pode derrubar coleta.
 * @param {{endpoint?:string, origem?:string, ok?:boolean, ms?:number, agora?:number}} r
 */
function registrar(r = {}) {
  try {
    const agora = Number.isFinite(r.agora) ? r.agora : Date.now();
    const rotulo = _rotuloHora(agora);
    if (_horaCorrente && _horaCorrente !== rotulo && _horas.has(_horaCorrente) && _aoFechar) {
      try { _aoFechar(_resumoHora(_horaCorrente, _horas.get(_horaCorrente))); } catch { /* log não derruba */ }
    }
    _horaCorrente = rotulo;

    const b = _balde(rotulo);
    const origem = r.origem || ORIGEM_PADRAO;
    const endpoint = r.endpoint || 'GET ?';
    const erro = r.ok === false;
    b.total++;
    if (erro) b.erros++;
    b.porOrigem.set(origem, (b.porOrigem.get(origem) || 0) + 1);
    // 19/10/2026: código HTTP (ou 'timeout' / 'rede') — no dia em que a EDP recusou 100%
    // das requisições, o contador dizia "erro" sem dizer se era 403 ou timeout.
    const status = r.status !== undefined && r.status !== null ? String(r.status) : (erro ? '?' : 'ok');
    b.porStatus.set(status, (b.porStatus.get(status) || 0) + 1);
    const e = b.porEndpoint.get(endpoint) || { n: 0, erros: 0, msTotal: 0, porStatus: new Map() };
    e.n++;
    if (erro) e.erros++;
    e.porStatus.set(status, (e.porStatus.get(status) || 0) + 1);
    e.msTotal += Number.isFinite(r.ms) ? r.ms : 0;
    b.porEndpoint.set(endpoint, e);
  } catch { /* nunca lança */ }
}

function _resumoHora(hora, b) {
  const porOrigem = Object.fromEntries([...b.porOrigem].sort((x, y) => y[1] - x[1]));
  const porEndpoint = [...b.porEndpoint]
    .map(([endpoint, e]) => ({ endpoint, n: e.n, erros: e.erros, msMedio: Math.round(e.msTotal / e.n),
      porStatus: Object.fromEntries(e.porStatus) }))
    .sort((x, y) => y.n - x.n);
  const porStatus = Object.fromEntries([...b.porStatus].sort((x, y) => y[1] - x[1]));
  return { hora, total: b.total, erros: b.erros, porStatus, porOrigem, porEndpoint };
}

/** Baldes retidos, hora mais recente primeiro. */
function resumo() {
  const horas = [..._horas].reverse().map(([h, b]) => _resumoHora(h, b));
  return {
    desde: horas.length ? horas[horas.length - 1].hora : null,
    total: horas.reduce((s, h) => s + h.total, 0),
    horasRetidas: HORAS_RETIDAS,
    horas,
  };
}

/** Linha de log por hora fechada: o histórico que sobrevive a restart. */
function _logarHoraFechada(h) {
  const log = require('./logger').forModule('wpa');
  log.info('wpa_requisicoes_hora', {
    hora: h.hora,
    total: h.total,
    erros: h.erros,
    porStatus: h.porStatus,
    porOrigem: h.porOrigem,
    top: h.porEndpoint.slice(0, 8).map(e => `${e.endpoint}=${e.n}`),
  });
}

/** Requisição que nem teve resposta HTTP: timeout (node-fetch) ou erro de rede. */
function _statusDoErro(err) {
  if (err && err.type === 'request-timeout') return 'timeout';
  // 24/10/2026: relay do WPA_PROXY fora do ar (services/wpaHttp.js) não é erro da EDP.
  if (err && err.code === 'WPA_RELAY_INDISPONIVEL') return 'relay';
  return 'rede';
}

/** Mede e registra uma chamada de fetch (Promise). Usado pelo wpaHttp. */
function medir(url, method, promessa) {
  const t0 = Date.now();
  const origem = origemAtual();
  const endpoint = normalizarEndpoint(url, method);
  return promessa.then(
    (res) => { registrar({ endpoint, origem, ok: !!res && res.ok !== false, status: res && res.status, ms: Date.now() - t0 }); return res; },
    (err) => { registrar({ endpoint, origem, ok: false, status: _statusDoErro(err), ms: Date.now() - t0 }); throw err; },
  );
}

module.exports = {
  HORAS_RETIDAS,
  normalizarEndpoint,
  origemDaRota,
  comOrigem,
  origemAtual,
  registrar,
  medir,
  resumo,
  _zerar: () => { _horas.clear(); _horaCorrente = null; },
  _aoFecharHora: (fn) => { _aoFechar = fn || _logarHoraFechada; },
};
