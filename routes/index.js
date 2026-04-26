/**
 * routes/index.js
 * Rotas da API do WPA Monitor.
 */

const express = require('express');
const { getTeams, getTeamDetail, getSummary } = require('../services/dataService');
const { login, wpaFetch }                     = require('../services/wpaService');
const { getMetas, setMetas, getMonthTotals, getDailyHistory } = require('../db/queries');
const { runSnapshot, runConsolidate }          = require('../services/cronService');

const router = express.Router();

// ── DADOS DO MONITOR ──────────────────────────────────────────────────────────

// GET /api/teams?regional=GUA&sectorId=DESG
router.get('/teams', async (req, res) => {
  try {
    const teams = await getTeams(req.query);
    res.json({ teams, count: teams.length, mode: process.env.DATA_MODE || 'mock' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/teams/:teamId
router.get('/teams/:teamId', async (req, res) => {
  try {
    const team = await getTeamDetail(req.params.teamId);
    if (!team) return res.status(404).json({ error: 'Equipe não encontrada.' });
    res.json(team);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/summary
router.get('/summary', async (req, res) => {
  try {
    const summary = await getSummary();
    res.json({ summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/status
router.get('/status', (req, res) => {
  res.json({
    status: 'ok',
    mode:   process.env.DATA_MODE || 'mock',
    wpaUrl: process.env.WPA_URL   || 'https://edp-wpa-po.azurewebsites.net',
    ts:     new Date().toISOString(),
  });
});

// ── METAS (banco de dados) ────────────────────────────────────────────────────

// GET /api/metas → { GUA: { LN: 50 }, CAC: { RL: 100 } }
router.get('/metas', async (req, res) => {
  try {
    const metas = await getMetas();
    res.json(metas);
  } catch (err) {
    console.error('[API] Erro ao buscar metas:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/metas  body: { GUA: { LN: 50 }, CAC: { RL: 100 } }
router.post('/metas', async (req, res) => {
  try {
    await setMetas(req.body);
    const metas = await getMetas();
    res.json({ ok: true, metas });
  } catch (err) {
    console.error('[API] Erro ao salvar metas:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── HISTÓRICO (banco de dados) ────────────────────────────────────────────────

// GET /api/historico/mes?m=2026-04 → totais mensais por regional/tipo
router.get('/historico/mes', async (req, res) => {
  try {
    const ym = req.query.m || new Date().toISOString().slice(0, 7);
    const totais = await getMonthTotals(ym);
    res.json({ mes: ym, totais });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/historico/diario?m=2026-04 → histórico dia a dia para gráfico
router.get('/historico/diario', async (req, res) => {
  try {
    const ym = req.query.m || new Date().toISOString().slice(0, 7);
    const rows = await getDailyHistory(ym);
    res.json({ mes: ym, dias: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── WPA PROXY / DEBUG ─────────────────────────────────────────────────────────

// POST /api/wpa/login — testa login e retorna info do token
router.post('/wpa/login', async (req, res) => {
  try {
    const result = await login();
    res.json({ ok: true, userId: result.userId });
  } catch (err) {
    res.status(401).json({ ok: false, error: err.message });
  }
});

// GET /api/wpa/probe?path=/api/sessions/current?sectorId=DESG
router.get('/wpa/probe', async (req, res) => {
  const path = req.query.path || '/api/sessions/current?sectorId=DESG';
  try {
    const wpaRes     = await wpaFetch(path);
    const contentType = wpaRes.headers.get('content-type') || '';
    const text        = await wpaRes.text();
    res.json({
      status: wpaRes.status,
      contentType,
      preview:  text.slice(0, 500),
      isJson:   contentType.includes('json'),
      isHtml:   contentType.includes('html'),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/snapshot — força snapshot manual (útil pra testar)
router.post('/admin/snapshot', async (req, res) => {
  try {
    await runSnapshot();
    res.json({ ok: true, ts: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/consolidar?date=2026-04-26 — consolida daily_totals
router.post('/admin/consolidar', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    await runConsolidate(date);
    res.json({ ok: true, date });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
