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
const tls = require('tls');
const _nodeFetch = require('node-fetch');
const { medir, origemAtual } = require('./wpaContador');
const { comVaga } = require('./wpaFila');

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
const RELAY_CODE = 'WPA_RELAY_INDISPONIVEL';
const RELAY_CONNECT_MS = 15000;

function _erroRelay(proxy, detalhe) {
  const err = new Error(`relay WPA indisponível (${proxy.host}): ${detalhe}`);
  err.code = RELAY_CODE;
  return err;
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
    const falhar = (detalhe) => {
      if (respondeu) return;
      respondeu = true;
      req.destroy();
      cb(_erroRelay(this.proxy, detalhe));
    };
    req.setTimeout(RELAY_CONNECT_MS, () => falhar(`proxy não respondeu ao CONNECT em ${RELAY_CONNECT_MS / 1000}s`));
    req.once('error', (e) => falhar(e.code || e.message));
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return falhar(`proxy respondeu ${res.statusCode} ao CONNECT ${destino}`);
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
//
// 24/10/2026: com WPA_PROXY, URL https sai pelo relay (agent acima). URL http
// (só os testes, contra 127.0.0.1) segue direto.
function wpaHttpFetch(url, opts = {}) {
  const prioritaria = origemAtual().startsWith('painel:');
  const agent = opts.agent || (String(url).startsWith('https:') ? agenteWpa() : undefined);
  return comVaga(prioritaria, () => medir(url, opts.method, _nodeFetch(url, {
    ...opts,
    agent,
    headers: { 'User-Agent': wpaUserAgent(), ..._comoObjeto(opts.headers) },
  })));
}

module.exports = { wpaHttpFetch, wpaUserAgent, agenteWpa, WpaProxyAgent, RELAY_CODE, WPA_USER_AGENT_PADRAO };
