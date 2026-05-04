/**
 * routes/cron.js — endpoints para Vercel Cron Jobs
 *
 * Vercel é serverless e node-cron (cronService.js) NÃO executa em produção.
 * Estes endpoints são disparados pelo agendador nativo da Vercel via HTTP GET
 * (ver vercel.json → "crons").
 *
 * AUTENTICAÇÃO
 * ────────────
 * Vercel envia automaticamente "Authorization: Bearer ${CRON_SECRET}" em cada
 * chamada de cron. Validamos esse header — não usa o JWT de usuário (que essas
 * rotas não teriam como obter sem login interativo).
 *
 * Se rodando local sem o header, aceita também ?secret=... como fallback de teste.
 */

const express = require('express');
const router  = express.Router();
const { dateBRT } = require('../services/timeUtil');

const SECRET = (process.env.CRON_SECRET || '').trim();

// Bloqueia boot em produção se CRON_SECRET não estiver definido (string vazia = inseguro)
if (!SECRET && process.env.DATA_MODE === 'wpa') {
  console.error('[CRON] FATAL: CRON_SECRET não configurado! Defina CRON_SECRET no .env antes de iniciar em produção.');
  process.exit(1);
} else if (!SECRET) {
  console.warn('[CRON] AVISO: CRON_SECRET vazio — endpoints /api/cron desprotegidos!');
}

function checkSecret(req, res, next) {
  if (!SECRET) {
    // Chegou aqui apenas em modo não-wpa (mock/dev) sem secret
    console.warn('[CRON] CRON_SECRET não configurado — acesso liberado somente em modo não-wpa');
    return next();
  }
  const auth   = req.headers.authorization || '';
  const token  = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const fromQs = req.query.secret || '';
  if (token !== SECRET && fromQs !== SECRET) {
    return res.status(401).json({ error: 'Cron secret inválido' });
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
    await cronSrv.runConsolidate(date);
    res.json({ ok: true, ms: Date.now() - t0, date });
  } catch (err) {
    console.error('[CRON consolidate]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
