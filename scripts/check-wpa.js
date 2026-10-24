#!/usr/bin/env node
/**
 * scripts/check-wpa.js — o caminho até a EDP está de pé? (24/10/2026, spec
 * wpa-acesso-edp.md, R5)
 *
 * Mostra se WPA_PROXY está definido, se o proxy aceita conexão TCP, e o status de
 * um GET na raiz dos hosts da API de dados (WPA_API_URL) e do login (WPA_URL),
 * pelo MESMO caminho que a aplicação usa (services/wpaHttp.js). Não usa token
 * nem credenciais: só a raiz de cada host.
 *
 * Uso (na raiz do projeto):
 *   node scripts/check-wpa.js
 *   node scripts/check-wpa.js --proxy none                    # ignora o WPA_PROXY do .env
 *   node scripts/check-wpa.js --proxy http://127.0.0.1:3999   # testa outro proxy
 * O --proxy existe porque o .env é carregado como no servidor (override): sem
 * ele, não dá para testar outra configuração sem editar o .env de produção.
 *
 * Saída: 0 quando a API de dados devolveu uma resposta HTTP que não é a página
 * de bloqueio de IP e não houve erro de proxy nem de rede; 1 nos demais casos.
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: process.env.NODE_ENV !== 'test' });

const { wpaHttpFetch, testarPortaProxy } = require('../services/wpaHttp');
const { ehWpaAccessError, ehPaginaIpBloqueado, resumirCorpo } = require('../services/wpaErros');

const TIMEOUT_MS = 20000;

function _argProxy(argv) {
  const i = argv.indexOf('--proxy');
  if (i >= 0) return argv[i + 1] === undefined ? '' : argv[i + 1];
  const igual = argv.find(a => a.startsWith('--proxy='));
  return igual === undefined ? undefined : igual.slice('--proxy='.length);
}

function _raiz(url) {
  try { const u = new URL(url); return `${u.protocol}//${u.host}/`; } catch { return null; }
}

/** GET na raiz, sem seguir redirect (o login responde 302). Nunca lança. */
async function sondar(url) {
  try {
    const res = await wpaHttpFetch(url, { redirect: 'manual', timeout: TIMEOUT_MS });
    const corpo = await res.text();
    if (ehPaginaIpBloqueado(res.status, corpo)) {
      return { status: res.status, code: 'WPA_IP_BLOQUEADO', detalhe: resumirCorpo(corpo) };
    }
    return { status: res.status, code: res.status >= 200 && res.status < 400 ? null : `WPA_HTTP_${res.status}` };
  } catch (err) {
    return { status: err.status ?? null, code: ehWpaAccessError(err) ? err.code : 'WPA_REDE', detalhe: err.message };
  }
}

async function main(argv = process.argv.slice(2), out = console.log) {
  const argProxy = _argProxy(argv);
  if (argProxy !== undefined) process.env.WPA_PROXY = argProxy === 'none' ? '' : argProxy;
  const proxy = (process.env.WPA_PROXY || '').trim();

  out(`WPA_PROXY      : ${proxy ? proxy : '(não definido: chamadas diretas)'}`);
  if (proxy) {
    const t = await testarPortaProxy(proxy, 3000);
    out(`proxy (TCP)    : ${t.ok ? 'aceita conexão' : `NÃO aceita conexão (${t.erro})`} em ${t.endereco}`);
  }

  const alvos = [
    ['API de dados', _raiz(process.env.WPA_API_URL || 'https://edp-wpa-web-api.azurewebsites.net')],
    ['login       ', _raiz(process.env.WPA_URL || 'https://edp-wpa-po.azurewebsites.net')],
  ];
  const resultados = [];
  for (const [nome, url] of alvos) {
    const r = await sondar(url);
    resultados.push(r);
    const status = r.status === null ? '---' : r.status;
    out(`${nome}   : ${status}${r.code ? `  ${r.code}` : ''}  ${url}${r.code && r.detalhe ? `\n                 ${r.detalhe}` : ''}`);
  }

  const api = resultados[0];
  const ok = api.status !== null && api.code !== 'WPA_IP_BLOQUEADO' && !/^WPA_(PROXY_|REDE)/.test(api.code || '');
  out(ok ? 'resultado      : OK, a API de dados responde por este caminho' : 'resultado      : FALHA no caminho até a API de dados');
  return ok ? 0 : 1;
}

if (require.main === module) {
  main().then((codigo) => process.exit(codigo), (err) => { console.error(err); process.exit(1); });
}

module.exports = { main, sondar };
