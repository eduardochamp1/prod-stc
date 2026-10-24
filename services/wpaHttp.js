/**
 * services/wpaHttp.js
 * Ponto ÚNICO por onde sai todo HTTP para a EDP (login e Web API da WPA).
 *
 * ⚠️ INCIDENTE 16/10/2026 (~21:30 BRT) — backlog P0-10. A EDP passou a devolver
 * HTTP 200 com {"Message":"Nenhum dado encontrado."} para o User-Agent padrão do
 * node-fetch (`node-fetch/1.0 (+https://github.com/bitinn/node-fetch)`). Mesma
 * requisição, mesmo token, mesma VM, com QUALQUER outro User-Agent: 73 sessões
 * em DESG/16-10. Com curl mandando o UA do node-fetch: 0. Não é erro, é
 * "sucesso vazio" — o wpaFetch não viu nada, e o painel ficou dois dias zerado.
 *
 * Por isso nenhum arquivo que fala com a EDP importa `node-fetch` direto: usa
 * este módulo, que põe um User-Agent PRÓPRIO e honesto (identifica o sistema,
 * não imita navegador nem curl). O teste test/wpaUserAgent.test.js falha se
 * alguém voltar a importar node-fetch em wpaService.js ou routes/index.js.
 *
 * 28/10/2026: o default deixou de ser `EngelmigWpaMonitor/1.0` e passou a ser o
 * UA do Edge 156 no Windows, por decisão do José. O WPA_USER_AGENT do .env
 * continua tendo precedência — se a VM tiver o valor antigo lá, é ele que sai.
 */

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const _nodeFetch = require('node-fetch');
const { medir, origemAtual } = require('./wpaContador');
const { comVaga } = require('./wpaFila');
const { WpaAccessError, ehWpaAccessError } = require('./wpaErros');

const WPA_USER_AGENT_PADRAO = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0';

/** Lido a cada chamada: trocar no .env + restart basta, e o teste consegue variar. */
function wpaUserAgent() {
  return process.env.WPA_USER_AGENT || WPA_USER_AGENT_PADRAO;
}

//
// 24/10/2026: a EDP passou a recusar as chamadas vindas da VM (IP de saída da
// Oracle), enquanto as mesmas chamadas pela rede da Engelmig funcionam. Paliativo:
// WPA_PROXY=http://127.0.0.1:3128 faz SÓ o HTTP para a EDP sair por um proxy
// CONNECT (relay na rede da Engelmig, exposto à VM por túnel SSH reverso — ver o
// manual de acesso à WPA). Nada de HTTPS_PROXY global: o proxy só aceita os hosts
// da EDP e quebraria o resto. Vazio = chamada direta, como antes.
//
// Sem dependência nova: o túnel CONNECT é feito com http/tls do próprio Node. O
// TLS continua de ponta a ponta com a EDP; o proxy só repassa bytes.
//
// 24/10/2026 (spec wpa-acesso-edp.md, R2): o código único WPA_RELAY_INDISPONIVEL
// virou três, para saber de que lado está o problema — túnel/proxy parado,
// host não liberado no proxy, ou a máquina do relay sem rota para a EDP (o
// proxy_edp responde 502). Timeout do CONNECT: 10 s.
const PROXY_CONNECT_MS = 10000;

/** Status do CONNECT → code (R2.2). */
function _codigoDoConnect(status) {
  if (status === 502) return 'WPA_PROXY_SEM_ROTA';
  return 'WPA_PROXY_RECUSOU';
}

class WpaProxyAgent extends https.Agent {
  constructor(proxyUrl) {
    super({ keepAlive: true });
    this.proxy = new URL(proxyUrl);
  }

  createConnection(options, cb) {
    const destino = `${options.host}:${options.port || 443}`;
    const req = http.request({
      host: this.proxy.hostname,
      port: this.proxy.port || 80,
      method: 'CONNECT',
      path: destino,
      headers: { Host: destino },
    });
    let respondeu = false;
    const falhar = (code, info) => {
      if (respondeu) return;
      respondeu = true;
      req.destroy();
      cb(new WpaAccessError(code, { host: options.host, ...info }));
    };
    const proxy = `proxy=${this.proxy.host}`;
    // Túnel no ar com o proxy remoto parado: o SSH aceita e fecha → 'socket hang up'
    // no 'error' abaixo → INDISPONIVEL, como o túnel caído.
    req.setTimeout(PROXY_CONNECT_MS, () => falhar('WPA_PROXY_INDISPONIVEL',
      { detalhe: `${proxy} sem resposta ao CONNECT em ${PROXY_CONNECT_MS / 1000}s` }));
    req.once('error', (e) => falhar('WPA_PROXY_INDISPONIVEL', { detalhe: `${proxy} ${e.code || e.message}` }));
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return falhar(_codigoDoConnect(res.statusCode),
          { status: res.statusCode, detalhe: `${proxy} respondeu ${res.statusCode} ao CONNECT ${destino}` });
      }
      respondeu = true;
      req.setTimeout(0);
      cb(null, tls.connect({
        socket,
        servername: options.servername || options.host,
        ca: options.ca,
        rejectUnauthorized: options.rejectUnauthorized !== false,
      }));
    });
    req.end();
  }
}

/**
 * Só abre e fecha uma conexão TCP com o host:porta do proxy (24/10/2026, spec
 * R4/R5) — diz se o túnel está de pé, sem falar com a EDP. Nunca lança.
 * @returns {Promise<{ok:boolean, endereco:string, erro?:string}>}
 */
function testarPortaProxy(proxyUrl, timeoutMs = 3000) {
  let u;
  try { u = new URL(proxyUrl); } catch { return Promise.resolve({ ok: false, endereco: String(proxyUrl), erro: 'URL inválida' }); }
  const endereco = `${u.hostname}:${u.port || 80}`;
  return new Promise((resolve) => {
    const sock = net.connect({ host: u.hostname, port: Number(u.port || 80) });
    const fim = (r) => { sock.destroy(); resolve({ endereco, ...r }); };
    sock.setTimeout(timeoutMs, () => fim({ ok: false, erro: `sem resposta em ${timeoutMs / 1000}s` }));
    sock.once('connect', () => fim({ ok: true }));
    sock.once('error', (e) => fim({ ok: false, erro: e.code || e.message }));
  });
}

let _agente = null;   // { url, agent } — recriado só se WPA_PROXY mudar

/** Lido a cada chamada, como o User-Agent. undefined = sem proxy (direto). */
function agenteWpa() {
  const url = (process.env.WPA_PROXY || '').trim();
  if (!url) return undefined;
  if (!_agente || _agente.url !== url) {
    if (_agente) _agente.agent.destroy();
    _agente = { url, agent: new WpaProxyAgent(url) };
  }
  return _agente.agent;
}

/** Aceita objeto simples ou `Headers` (node-fetch) e devolve objeto simples. */
function _comoObjeto(headers) {
  if (!headers) return {};
  if (typeof headers.entries === 'function' && typeof headers.get === 'function') {
    return Object.fromEntries(headers.entries());
  }
  return { ...headers };
}

/**
 * Mesmo contrato do node-fetch@2. O User-Agent vai ANTES dos headers de quem
 * chama: um diagnóstico pode sobrescrever de propósito (ex.: reproduzir o UA do
 * node-fetch para provar o filtro), o dia a dia nunca sai com o padrão.
 */
//
// 19/10/2026 (P0-11): toda chamada é contada aqui (hora BRT × endpoint × origem)
// — a EDP questionou o volume de requisições e não tínhamos o número. Ver
// services/wpaContador.js.
//
// 19/10/2026 (P0-11 item 4): e passa pela fila global de services/wpaFila.js —
// no máximo WPA_MAX_EM_VOO em voo contra a EDP, o painel na frente. A vaga
// envolve SÓ a chamada: o `medir` e o timeout começam quando ela sai.
/**
 * Rejeição do node-fetch → WpaAccessError (24/10/2026, R2). O node-fetch embrulha
 * o erro do agent num FetchError e só preserva o `code` — o status do CONNECT
 * volta pela mensagem ("status=403"). Sem proxy: DNS/conexão/TLS/timeout viram
 * WPA_REDE; `timeout` e `type` ficam no erro porque o wpaService não retenta
 * timeout (P1-31) e o contador os separa.
 */
function _comoErroWpa(err, url) {
  if (ehWpaAccessError(err)) return err;
  const msg = String((err && err.message) || err).replace(/^request to \S+ failed, reason: /, '');
  const code = err && typeof err.code === 'string' && err.code.startsWith('WPA_') ? err.code : 'WPA_REDE';
  const status = code === 'WPA_REDE' ? null : Number((msg.match(/status=(\d+)/) || [])[1]) || null;
  // Do erro do agent (proxy) só interessa o trecho depois de host/status: "proxy=... respondeu 403 ...".
  const detalhe = code === 'WPA_REDE' ? msg : msg.replace(/^\S+( host=\S+)?( status=\d+)? ?/, '');
  const novo = new WpaAccessError(code, { url, status, detalhe, cause: err });
  if (err && err.type === 'request-timeout') { novo.type = err.type; novo.timeout = true; }
  return novo;
}

//
// 24/10/2026: com WPA_PROXY, URL https sai pelo relay (agent acima). URL http
// (só os testes, contra 127.0.0.1) segue direto. Falha de rede ou de proxy sai
// daqui já como WpaAccessError — o contador registra pelo code.
function wpaHttpFetch(url, opts = {}) {
  const prioritaria = origemAtual().startsWith('painel:');
  const agent = opts.agent || (String(url).startsWith('https:') ? agenteWpa() : undefined);
  return comVaga(prioritaria, () => medir(url, opts.method, _nodeFetch(url, {
    ...opts,
    agent,
    headers: { 'User-Agent': wpaUserAgent(), ..._comoObjeto(opts.headers) },
  }).catch((err) => { throw _comoErroWpa(err, url); })));
}

module.exports = { wpaHttpFetch, wpaUserAgent, agenteWpa, testarPortaProxy, WpaProxyAgent, PROXY_CONNECT_MS, WPA_USER_AGENT_PADRAO };
