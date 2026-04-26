/**
 * routes/index.js
 * Rotas da API do WPA Monitor.
 */

const express = require('express');
const { getTeams, getTeamDetail, getSummary } = require('../services/dataService');
const { login, wpaFetch }                     = require('../services/wpaService');

const router = express.Router();

const MODE = (process.env.DATA_MODE || 'mock').toLowerCase();

// Supabase: carregado para todos os modos que não sejam mock
let _sbq = null;
function sbq() {
  if (_sbq) return _sbq;
  if (MODE === 'mock') return null;
  try {
    _sbq = require('../db/supabaseQueries');
    return _sbq;
  } catch (err) {
    console.warn('[SBQ] Módulo indisponível:', err.message);
    return null;
  }
}

// Fallback em memória para metas (apenas no modo mock)
let _metasMemory = { GUA: {}, CAC: {} };

// Cron: carregamento lazy
function cron() {
  try { return require('../services/cronService'); } catch { return null; }
}

// ── DADOS DO MONITOR ──────────────────────────────────────────────────────────

// GET /api/teams?regional=GUA&sectorId=DESG
router.get('/teams', async (req, res) => {
  try {
    let teams;
    if (MODE === 'supabase') {
      // Vercel: lê último snapshot do Supabase
      teams = await sbq().getTeamsFromSupabase(req.query);
    } else {
      // wpa / mock: dados ao vivo da API WPA ou mock
      teams = await getTeams(req.query);
    }
    res.json({ teams, count: teams.length, mode: MODE });
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
    status:   'ok',
    version:  '1.1.0',
    mode:     process.env.DATA_MODE || 'mock',
    supabase: process.env.SUPABASE_SERVICE_KEY ? 'configurado ✓' : 'não configurado',
    webhook:  process.env.WEBHOOK_SECRET ? 'configurado ✓' : 'não configurado',
    ts:       new Date().toISOString(),
  });
});

// ── METAS ─────────────────────────────────────────────────────────────────────

// GET /api/metas
router.get('/metas', async (req, res) => {
  try {
    const sq    = sbq();
    const metas = sq ? await sq.getMetas() : _metasMemory;
    res.json(metas);
  } catch (err) {
    console.error('[API] getMetas:', err.message);
    res.json(_metasMemory);
  }
});

// POST /api/metas
router.post('/metas', async (req, res) => {
  try {
    const sq = sbq();
    if (sq) {
      await sq.setMetas(req.body);
      const metas = await sq.getMetas();
      res.json({ ok: true, metas });
    } else {
      _metasMemory = req.body;
      res.json({ ok: true, metas: _metasMemory });
    }
  } catch (err) {
    console.error('[API] setMetas:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── HISTÓRICO ─────────────────────────────────────────────────────────────────

// GET /api/historico/mes?m=2026-04
router.get('/historico/mes', async (req, res) => {
  try {
    const sq = sbq();
    const ym = req.query.m || new Date().toISOString().slice(0, 7);
    if (!sq) return res.json({ mes: ym, totais: { GUA: {}, CAC: {} } });
    const totais = await sq.getMonthTotals(ym);
    res.json({ mes: ym, totais });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/historico/diario?m=2026-04
router.get('/historico/diario', async (req, res) => {
  try {
    const sq = sbq();
    const ym = req.query.m || new Date().toISOString().slice(0, 7);
    if (!sq) return res.json({ mes: ym, dias: [] });
    const dias = await sq.getDailyHistory(ym);
    res.json({ mes: ym, dias });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── WPA PROXY / DEBUG ─────────────────────────────────────────────────────────

router.post('/wpa/login', async (req, res) => {
  try {
    const result = await login();
    res.json({ ok: true, userId: result.userId });
  } catch (err) {
    res.status(401).json({ ok: false, error: err.message });
  }
});

router.get('/wpa/probe', async (req, res) => {
  const path = req.query.path || '/api/sessions/current?sectorId=DESG';
  try {
    const wpaRes      = await wpaFetch(path);
    const contentType = wpaRes.headers.get('content-type') || '';
    const text        = await wpaRes.text();
    let firstNote = null;
    try {
      const json = JSON.parse(text);
      firstNote = json?.Data?.Notes?.[0] || json?.Data?.[0] || null;
    } catch {}
    res.json({ status: wpaRes.status, contentType, preview: text.slice(0, 500), firstNote });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DEBUG ─────────────────────────────────────────────────────────────────────

// GET /api/debug/notas?sectorId=DESG
router.get('/debug/notas', async (req, res) => {
  const { wpaFetch: wf } = require('../services/wpaService');
  const ENGELMIG_ID = '92a2f98e-8877-433e-8358-173b94c13a54';
  const sectorId = req.query.sectorId || 'DESG';

  try {
    const [rSess, rNotas] = await Promise.all([
      wf(`/api/sessions/current?sectorId=${sectorId}`).then(r => r.json()),
      wf(`/api/notes/execution?sectorId=${sectorId}`).then(r => r.json()),
    ]);

    const sessions = rSess.Data || [];
    const notas    = rNotas.Data?.Notes || [];

    const engSessions = sessions.filter(s => s.Team?.CompanyId === ENGELMIG_ID);

    const notasPorNome = {};
    const notasPorId   = {};
    notas.forEach(n => {
      const nome = (n.Team?.Name || '').trim();
      const id   = n.Team?.Id || n.TeamId;
      if (nome) { notasPorNome[nome] = (notasPorNome[nome] || []); notasPorNome[nome].push(n); }
      if (id)   { notasPorId[id]     = (notasPorId[id]     || []); notasPorId[id].push(n); }
    });

    const nomesNasNotas = Object.keys(notasPorNome);

    const porEquipe = engSessions.map(s => {
      const nome   = (s.Team?.Name || '').trim();
      const teamId = s.Team?.Id;
      const nEqNome = notasPorNome[nome] || [];
      const nEqId   = teamId ? (notasPorId[teamId] || []) : [];
      const nEq = nEqNome.length > 0 ? nEqNome : nEqId;

      const conc  = nEq.filter(n => n.Status === 4 || n.Status === 9);
      const tipos = [...new Set(conc.map(n => n.Type))];
      return {
        equipe:       nome,
        teamId:       teamId || null,
        casamentoPor: nEqNome.length > 0 ? 'nome' : (nEqId.length > 0 ? 'id' : 'nenhum'),
        total:        nEq.length,
        concluidas:   conc.length,
        tipos,
        statusCounts: nEq.reduce((acc, n) => { acc[n.Status] = (acc[n.Status]||0)+1; return acc; }, {}),
      };
    });

    res.json({
      sectorId,
      totalSessoes:       sessions.length,
      sessoesEngelmig:    engSessions.length,
      totalNotas:         notas.length,
      resumo: {
        equipesComNotas:  porEquipe.filter(e => e.total > 0).length,
        equipesSemNotas:  porEquipe.filter(e => e.total === 0).length,
        totalConcluidas:  porEquipe.reduce((s, e) => s + e.concluidas, 0),
      },
      nomesNasNotas:          nomesNasNotas.slice(0, 30),
      amostNomesEngelmig:     engSessions.slice(0, 5).map(s => s.Team?.Name),
      porEquipe,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN ─────────────────────────────────────────────────────────────────────

router.post('/admin/snapshot', async (req, res) => {
  try {
    const c = cron();
    if (c) await c.runSnapshot();
    res.json({ ok: true, ts: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/consolidar', async (req, res) => {
  try {
    const c    = cron();
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    if (c) await c.runConsolidate(date);
    res.json({ ok: true, date });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
