/**
 * middleware/requestTiming.js
 *
 * Loga requisições LENTAS. Uma linha por request acima do limiar, com método,
 * rota, status e duração.
 *
 * POR QUE EXISTE (21/08/2026): o usuário reportou "algumas páginas estão lentas
 * ou não carregam tudo" e nós não tínhamos NENHUMA medida de latência por rota —
 * só o log do PM2, que não registra duração. Sem isso, a única forma de achar a
 * página lenta era palpite, e palpite já custou três rodadas de investigação
 * errada neste mesmo dia. A revisão paralela de 20/08 já havia apontado a lacuna
 * de observabilidade (backlog P2-30 e a nota sobre não saber, depois do fato, que
 * uma coleta veio incompleta).
 *
 * Custo: um `Date.now()` na entrada e um listener de 'finish'. Irrelevante.
 *
 * Configuração:
 *   SLOW_REQUEST_MS  limiar em ms (default 1500). 0 desliga o middleware.
 *
 * Como usar o resultado:
 *   pm2 logs wpa-monitor --lines 500 | grep slow_request
 */

const log = require('../services/logger').forModule('http');

const LIMIAR_MS = (() => {
  const raw = process.env.SLOW_REQUEST_MS;
  if (raw === undefined) return 1500;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 1500;
})();

// Parâmetros cujo VALOR nunca deve ir pro log. `secret` é o do /api/cron
// (P1-43): ele viajava na query string e este middleware gravava `originalUrl`
// inteira em disco a cada cron manual lento — ou seja, a observabilidade que eu
// adicionei em 22/08 virou um vazamento de credencial. Os outros entram por
// precaução, pra ninguém repetir o padrão.
const PARAMS_SENSIVEIS = ['secret', 'token', 'password', 'senha', 'apikey', 'api_key'];

/** Troca o valor de parâmetro sensível por `***`. Nunca lança. */
function _redigirUrl(url) {
  const u = String(url || '');
  if (!u.includes('?')) return u;
  try {
    const [base, qs] = u.split('?');
    const partes = qs.split('&').map(par => {
      const i = par.indexOf('=');
      const chave = i === -1 ? par : par.slice(0, i);
      return PARAMS_SENSIVEIS.includes(chave.toLowerCase()) ? `${chave}=***` : par;
    });
    return `${base}?${partes.join('&')}`;
  } catch {
    // Se der qualquer coisa errada, é mais seguro logar só o caminho.
    return u.split('?')[0];
  }
}

function requestTiming(req, res, next) {
  if (LIMIAR_MS === 0) return next();

  const t0 = Date.now();
  let registrado = false;

  const registrar = () => {
    if (registrado) return;          // 'finish' e 'close' podem ambos disparar
    registrado = true;
    const ms = Date.now() - t0;
    if (ms < LIMIAR_MS) return;
    log.warn('slow_request', {
      method: req.method,
      // req.route só existe depois do match; originalUrl mantém a querystring,
      // que costuma ser o que explica a lentidão (range de datas, regionais).
      path: req.originalUrl ? _redigirUrl(req.originalUrl).slice(0, 200) : req.path,
      status: res.statusCode,
      ms,
      // Quem pediu ajuda a separar "gestor abriu o mês inteiro" de cron.
      user: (req.user && (req.user.username || req.user.sub)) || null,
    });
  };

  res.on('finish', registrar);
  res.on('close', registrar);        // cliente desistiu no meio
  next();
}

module.exports = { requestTiming, LIMIAR_MS, _redigirUrl };
