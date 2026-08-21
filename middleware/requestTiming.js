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
      path: req.originalUrl ? req.originalUrl.slice(0, 200) : req.path,
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

module.exports = { requestTiming, LIMIAR_MS };
