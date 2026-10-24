/**
 * services/wpaErros.js
 * Erro ÚNICO para falha de acesso à EDP (login e Web API da WPA).
 *
 * ⚠️ POR QUE EXISTE (24/10/2026, spec wpa-acesso-edp.md): a EDP passou a recusar
 * o IP da VM com 403 "Web App - Unavailable" / "has blocked your access", e o
 * relay (WPA_PROXY) pode estar fora do ar. Em vários pontos a falha virava lista
 * vazia sem erro, e os indicadores recebiam vazio ou zero como se fosse real.
 * Agora toda falha de acesso é um WpaAccessError com `code` identificável, e
 * quem chama decide — nunca "dado vazio".
 *
 * Códigos:
 *   WPA_PROXY_INDISPONIVEL  proxy recusou a conexão, fechou antes de responder ao CONNECT ou não respondeu em 10 s
 *   WPA_PROXY_RECUSOU       proxy respondeu ao CONNECT com 403 (host não liberado) ou outro status ≠ 200/502
 *   WPA_PROXY_SEM_ROTA      proxy respondeu 502: a máquina do relay não alcança a EDP (VPN caída)
 *   WPA_IP_BLOQUEADO        403 com a página de restrição de IP do Azure App Service
 *   WPA_HTTP_<status>       qualquer outro status fora de 2xx (ex.: WPA_HTTP_404)
 *   WPA_RESPOSTA_INVALIDA   2xx que deveria ser JSON e não é
 *   WPA_REDE                DNS, conexão, TLS ou timeout sem proxy no caminho
 *
 * A mensagem leva code, host, caminho, status e até 300 caracteres do corpo (HTML
 * reduzido a texto). NUNCA leva header Authorization, token ou senha.
 */

'use strict';

/** Falhas do CAMINHO até a EDP (não da resposta dela): repetir a chamada não muda nada no ciclo. */
const CODIGOS_CAMINHO = new Set([
  'WPA_PROXY_INDISPONIVEL', 'WPA_PROXY_RECUSOU', 'WPA_PROXY_SEM_ROTA', 'WPA_IP_BLOQUEADO',
]);

const LIMITE_CORPO = 300;

/** HTML → texto corrido, cortado em 300 caracteres. Texto puro passa só pelo corte. */
function resumirCorpo(corpo) {
  if (!corpo) return '';
  let t = String(corpo);
  if (/<[a-z!/]/i.test(t)) {
    t = t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ');
  }
  return t.replace(/\s+/g, ' ').trim().slice(0, LIMITE_CORPO);
}

/**
 * Página de restrição de IP do Azure App Service (vista em 24/10/2026 a partir da
 * VM): título "Web App - Unavailable" + "has blocked your access".
 *
 * Só o "blocked your access" decide. A spec pedia "Web App - Unavailable" OU
 * "blocked your access", mas o título sozinho é também a página de COLD-START
 * (403/503, docs/handoff/API-WPA-EDP.md §1 — "o retry resolve"): casar só pelo
 * título transformava hibernação de segundos em WPA_IP_BLOQUEADO sem retry, e o
 * ciclo inteiro parava. A página real de bloqueio tem as duas marcas.
 */
function ehPaginaIpBloqueado(status, corpo) {
  return status === 403 && /blocked your access/i.test(String(corpo || ''));
}

function _hostDe(url) {
  try { return new URL(String(url)).host; } catch { return null; }
}

function _caminhoDe(url) {
  try { const u = new URL(String(url)); return u.pathname; } catch { return String(url || '').split('?')[0] || null; }
}

class WpaAccessError extends Error {
  /**
   * @param {string} code
   * @param {{ url?:string, host?:string, path?:string, status?:number|null, corpo?:string, detalhe?:string, cause?:Error }} [info]
   */
  constructor(code, info = {}) {
    const host = info.host || _hostDe(info.url);
    const path = info.path || _caminhoDe(info.url);
    const status = Number.isFinite(info.status) ? info.status : null;
    const corpo = resumirCorpo(info.corpo);
    const partes = [code, host ? `host=${host}` : null, path ? `path=${path}` : null,
      status !== null ? `status=${status}` : null, info.detalhe || null, corpo ? `corpo="${corpo}"` : null];
    super(partes.filter(Boolean).join(' '));
    this.name = 'WpaAccessError';
    this.code = code;
    this.status = status;
    this.host = host;
    this.path = path;
    if (info.cause) this.cause = info.cause;
  }
}

function ehWpaAccessError(err) {
  return Boolean(err && err.name === 'WpaAccessError' && typeof err.code === 'string');
}

/** true quando o problema é o caminho até a EDP (proxy, bloqueio de IP), não a resposta de um endpoint. */
function ehFalhaDeCaminho(err) {
  return ehWpaAccessError(err) && CODIGOS_CAMINHO.has(err.code);
}

/** WpaAccessError para uma resposta HTTP fora de 2xx (o corpo já lido). */
function erroDeResposta(url, status, corpo) {
  const code = ehPaginaIpBloqueado(status, corpo) ? 'WPA_IP_BLOQUEADO' : `WPA_HTTP_${status}`;
  return new WpaAccessError(code, { url, status, corpo });
}

module.exports = {
  WpaAccessError,
  ehWpaAccessError,
  ehFalhaDeCaminho,
  ehPaginaIpBloqueado,
  erroDeResposta,
  resumirCorpo,
  CODIGOS_CAMINHO,
};
