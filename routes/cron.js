/**
 * routes/cron.js — endpoints HTTP para disparar o cron por fora (GET autenticado).
 *
 * O agendamento em produção é o node-cron (services/cronService.js), que roda
 * DENTRO do processo PM2 (startCron() no server.js quando DATA_MODE=wpa). Estes
 * endpoints existem para disparo MANUAL/externo (ex.: rodar um tick sob demanda,
 * ou um agendador externo). Originalmente serviam ao Vercel Cron — o Vercel foi
 * aposentado na Fase 4 (22/07/2026); os endpoints ficaram por serem úteis.
 *
 * AUTENTICAÇÃO
 * ────────────
 * Exige "Authorization: Bearer ${CRON_SECRET}" (não usa o JWT de usuário — essas
 * rotas não teriam como obter um sem login interativo).
 *
 * ⚠️ 28/08/2026 (P1-43): o fallback `?secret=...` foi REMOVIDO. Ele não tinha
 * gate de modo — valia em produção — e query string vaza pra log do PM2, log do
 * Fortinet, histórico do navegador e header Referer. Só header agora, em
 * qualquer ambiente. Quem chamava com `?secret=` precisa passar a usar:
 *   curl -H "Authorization: Bearer $CRON_SECRET" .../api/cron/snapshot
 */

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { dateBRT } = require('../services/timeUtil');

const SECRET = (process.env.CRON_SECRET || '').trim();

// Bloqueia boot em produção se CRON_SECRET não estiver definido (string vazia = inseguro)
if (!SECRET && process.env.DATA_MODE === 'wpa') {
  console.error('[CRON] FATAL: CRON_SECRET não configurado! Defina CRON_SECRET no .env antes de iniciar em produção.');
  process.exit(1);
} else if (!SECRET) {
  console.warn('[CRON] AVISO: CRON_SECRET vazio — endpoints /api/cron desprotegidos!');
}

/**
 * Comparação de tempo constante. `timingSafeEqual` LANÇA quando os buffers têm
 * tamanhos diferentes, então o tamanho é checado antes — e checar tamanho não
 * vaza nada útil aqui (o comprimento do secret não é o segredo).
 */
function _secretIguais(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function checkSecret(req, res, next) {
  if (!SECRET) {
    // Chegou aqui apenas em modo não-wpa (mock/dev) sem secret
    console.warn('[CRON] CRON_SECRET não configurado — acesso liberado somente em modo não-wpa');
    return next();
  }
  // 28/08/2026 — P1-43. O `?secret=` era descrito no topo deste arquivo como
  // "fallback de teste", mas não tinha gate de modo: valia igual em produção.
  // Query string vaza pra todo lugar onde existe log de request — `logs/out.log`
  // do PM2, log de acesso do Fortinet, histórico do navegador, header `Referer`
  // — e o `middleware/requestTiming.js` (22/08) loga `req.originalUrl`, ou seja
  // gravava o segredo em disco a cada cron manual lento. Quem lesse a linha
  // ganhava o poder de re-consolidar qualquer data; cruzado com o P2-13
  // (re-consolidação de dia antigo SUBCONTA ~0,8%), isso rebaixa número já
  // reportado à EDP, sem rastro de quem pediu. Agora só header.
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!_secretIguais(token, SECRET)) {
    if (req.query.secret) {
      console.warn('[CRON] ?secret= na URL não é mais aceito (P1-43) — use Authorization: Bearer.');
    }
    return res.status(401).json({
      error: 'Cron secret inválido. Use o header: Authorization: Bearer <CRON_SECRET>',
    });
  }
  next();
}

router.use(checkSecret);

// ── ENDPOINTS ────────────────────────────────────────────────────────────────

/**
 * GET /api/cron/warm
 * Mantém o WPA quente. Faz force-refresh do token + um GET leve em
 * /api/sessions/current. Custo: 2 requests pequenas, 2-5s típico.
 *
 * Idealmente disparado a cada 5 min durante o horário operacional para evitar
 * cold-starts no Azure App Service da EDP.
 */
router.get('/warm', async (_req, res) => {
  try {
    const { forceRefresh, getSessions } = require('../services/wpaService');
    const t0 = Date.now();
    await forceRefresh();
    // Toca a Web API também (App Service separado)
    await getSessions('DESG').catch(() => null);
    res.json({ ok: true, ms: Date.now() - t0 });
  } catch (err) {
    console.error('[CRON warm]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/cron/snapshot
 * Coleta dados ao vivo do WPA e salva no Supabase (snapshots, teams_current,
 * daily_totals). Equivalente ao runSnapshot do cronService.js.
 *
 * Disparado a cada 15 min durante o horário operacional (06:00-20:00 BRT).
 */
router.get('/snapshot', async (_req, res) => {
  try {
    const cronSrv = require('../services/cronService');
    const t0 = Date.now();
    await cronSrv.runSnapshot();
    res.json({ ok: true, ms: Date.now() - t0 });
  } catch (err) {
    console.error('[CRON snapshot]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/cron/consolidate?date=YYYY-MM-DD
 * Consolida daily_totals/team_daily_totals do dia (apenas concluídas).
 * Sem ?date, usa "ontem" — alinhado com o agendamento de 23:30 UTC (= 20:30 BRT)
 * que historicamente fechava o dia operacional corrente.
 */
router.get('/consolidate', async (req, res) => {
  try {
    const cronSrv = require('../services/cronService');
    const t0 = Date.now();
    // Sem ?date usa BRT (America/Sao_Paulo) — evita consolidar "amanhã" depois das 21h UTC
    const date = req.query.date || dateBRT();
    // 28/08/2026 — P1-43. `date` ia CRU pro runConsolidate, que APAGA e reescreve
    // team_daily_totals/team_daily_subcat_totals de {date-1, date} — as tabelas de
    // onde saem os números da EDP. Formato inválido virava erro engolido pelo
    // try/catch interno do runConsolidate, e o wipe podia rodar mesmo assim.
    if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(date)) {
      return res.status(400).json({ ok: false, error: `date inválida: "${date}". Use YYYY-MM-DD.` });
    }
    await cronSrv.runConsolidate(date);
    res.json({ ok: true, ms: Date.now() - t0, date });
  } catch (err) {
    console.error('[CRON consolidate]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
// Exportados p/ teste (P1-43, 28/08/2026).
module.exports._secretIguais = _secretIguais;
module.exports._checkSecret  = checkSecret;
