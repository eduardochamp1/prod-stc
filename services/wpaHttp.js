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

const _nodeFetch = require('node-fetch');
const { medir, origemAtual } = require('./wpaContador');
const { comVaga } = require('./wpaFila');

const WPA_USER_AGENT_PADRAO = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0';

/** Lido a cada chamada: trocar no .env + restart basta, e o teste consegue variar. */
function wpaUserAgent() {
  return process.env.WPA_USER_AGENT || WPA_USER_AGENT_PADRAO;
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
function wpaHttpFetch(url, opts = {}) {
  const prioritaria = origemAtual().startsWith('painel:');
  return comVaga(prioritaria, () => medir(url, opts.method, _nodeFetch(url, {
    ...opts,
    headers: { 'User-Agent': wpaUserAgent(), ..._comoObjeto(opts.headers) },
  })));
}

module.exports = { wpaHttpFetch, wpaUserAgent, WPA_USER_AGENT_PADRAO };
