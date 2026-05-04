/**
 * routes/index.js
 * Rotas da API do WPA Monitor.
 */

const express = require('express');
const { getTeams, getTeamDetail, getSummary } = require('../services/dataService');
const { login: wpaLogin, wpaFetch, getTokenStatus, getNoteDetail } = require('../services/wpaService');
const { dateBRT } = require('../services/timeUtil');

// ── VALIDADORES DE PARAMS ─────────────────────────────────────────────────────
const _RE_YYYYMM    = /^\d{4}-(0[1-9]|1[0-2])$/;
const _RE_YYYYMMDD  = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const _RE_UUID      = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Valida `?m=YYYY-MM`. Se inválido, retorna 400 e devolve null. */
function _parseYearMonth(req, res) {
  const raw = req.query.m;
  if (raw !== undefined && !_RE_YYYYMM.test(raw)) {
    res.status(400).json({ error: `Parâmetro m inválido: "${raw}". Use YYYY-MM.` });
    return null;
  }
  return raw || new Date().toISOString().slice(0, 7);
}
const { login: authLogin, authMiddleware }    = require('../middleware/auth');

const router = express.Router();

const MODE = (process.env.DATA_MODE || 'mock').toLowerCase();

// ── AUTH ─────────────────────────────────────────────────────────────────────
// POST /api/auth/login  — única rota pública
router.post('/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'username e password obrigatórios' });

  const result = authLogin(username, password);
  if (!result)
    return res.status(401).json({ error: 'Usuário ou senha incorretos' });

  res.json({
    token:    result.token,
    username: result.username,
    role:     result.role,
    regional: result.regional,
    exp:      result.exp,
  });
});

// Protege TODAS as rotas abaixo com JWT
router.use(authMiddleware);

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

// Cron: carregamento lazy — em modo supabase (Vercel) node-cron não está disponível
function cron() {
  try { return require('../services/cronService'); }
  catch (err) {
    console.warn('[CRON] cronService indisponível (esperado em Vercel/supabase):', err.message);
    return null;
  }
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

// GET /api/teams/historico?de=YYYY-MM-DD&ate=YYYY-MM-DD&regional=GUA
// Retorna equipes de um período via snapshots (Supabase)
router.get('/teams/historico', async (req, res) => {
  const { de, ate, regional } = req.query;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!de || !dateRe.test(de) || !ate || !dateRe.test(ate)) {
    return res.status(400).json({ error: 'Parâmetros de e ate obrigatórios no formato YYYY-MM-DD' });
  }
  try {
    const sq    = sbq();
    const teams = sq ? await sq.getTeamsByDateFromSnapshots(de, ate, regional) : [];
    res.json({ teams, count: teams.length, de, ate, mode: MODE });
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

// ── KPIs do dia (acumulador persistente, sobrevive a logoff) ──────────────────

// GET /api/totais/subcat?de=YYYY-MM-DD&ate=YYYY-MM-DD&regional=GUA
// Compat retrô: aceita ?date= (single-day) caso ?de/?ate não venham.
// Resposta: { de, ate, totais: { GUA:{...}, CAC:{...}, ALL:{...} }, quantidades:{...} }
// Usado pelo frontend p/ produtividade acumulada — inclui equipes que deslogaram no dia.
router.get('/totais/subcat', async (req, res) => {
  try {
    const sq = sbq();
    const today = dateBRT();
    const de  = req.query.de  || req.query.date || today;
    const ate = req.query.ate || req.query.date || de;
    const regional = req.query.regional || 'ALL';
    if (!sq) return res.json({ de, ate, totais: { ALL: {}, GUA: {}, CAC: {} }, quantidades: { ALL: {}, GUA: {}, CAC: {} } });
    const result = await sq.getDailySubcatTotals(de, ate, regional);
    res.json({ de, ate, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/totais/dia?de=YYYY-MM-DD&ate=YYYY-MM-DD
// Compat retrô: aceita ?date= (single-day) caso ?de/?ate não venham.
// Resposta: { de, ate, totais: { ALL, GUA, CAC } }
router.get('/totais/dia', async (req, res) => {
  try {
    const sq = sbq();
    const today = dateBRT();
    const de  = req.query.de  || req.query.date || today;
    const ate = req.query.ate || req.query.date || de;
    if (!sq) return res.json({ de, ate, totais: { ALL: 0, GUA: 0, CAC: 0 } });
    const totais = await sq.getRealizadasDoDia(de, ate);
    res.json({ de, ate, totais });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/export/historico?de=YYYY-MM-DD&ate=YYYY-MM-DD&regional=ALL
// Retorna dados brutos de todas as tabelas de histórico para exportação XLSX.
// Máximo de 93 dias por requisição.
router.get('/export/historico', async (req, res) => {
  try {
    const sq = sbq();
    const today = dateBRT();
    const firstOfMonth = today.slice(0, 8) + '01';
    const de       = req.query.de       || firstOfMonth;
    const ate      = req.query.ate      || today;
    const regional = req.query.regional || 'ALL';

    const MAX_DAYS = 93;
    const diffMs = new Date(ate + 'T12:00:00Z') - new Date(de + 'T12:00:00Z');
    if (diffMs > MAX_DAYS * 86400 * 1000) {
      return res.status(400).json({ error: `Período máximo para exportação: ${MAX_DAYS} dias.` });
    }
    if (!sq) return res.json({ daily_subcat: [], team_subcat: [], team_totais: [], daily_totais: [], de, ate });
    const data = await sq.getExportData(de, ate, regional);
    res.json({ ...data, de, ate, regional });
  } catch (err) {
    console.error('[export/historico]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/performance/equipes?de=YYYY-MM-DD&ate=YYYY-MM-DD&regional=ALL&tipo=TODAS
// tipo: TODAS | COMERCIAL (EC*) | PLANTAO (EP*)
router.get('/performance/equipes', async (req, res) => {
  try {
    const sq = sbq();
    const today = dateBRT();
    const de       = req.query.de       || today;
    const ate      = req.query.ate      || de;
    const regional = req.query.regional || 'ALL';
    const tipo     = req.query.tipo     || 'TODAS';
    if (!sq) return res.json({ equipes: [], de, ate });
    const result = await sq.getPerformanceEquipes(de, ate, regional, tipo);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── APP SETTINGS (preferências compartilhadas) ────────────────────────────────

// GET /api/settings/:key  → retorna { data, updated_at } ou {} se não existe
router.get('/settings/:key', async (req, res) => {
  try {
    const sq = sbq();
    if (!sq) return res.json({});
    const row = await sq.getSetting(req.params.key);
    res.json(row || {});
  } catch (err) {
    console.error('[API] getSetting:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings/:key  body: { ... } qualquer JSON
router.put('/settings/:key', async (req, res) => {
  try {
    const sq = sbq();
    if (!sq) return res.status(503).json({ error: 'supabase indisponível' });
    await sq.setSetting(req.params.key, req.body || {});
    res.json({ ok: true });
  } catch (err) {
    console.error('[API] setSetting:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── HISTÓRICO ─────────────────────────────────────────────────────────────────

// GET /api/historico/mes?m=2026-04
router.get('/historico/mes', async (req, res) => {
  try {
    const sq = sbq();
    const ym = _parseYearMonth(req, res); if (!ym) return;
    if (!sq) return res.json({ mes: ym, totais: { GUA: {}, CAC: {} } });
    const totais = await sq.getMonthTotals(ym);
    res.json({ mes: ym, totais });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/historico/sessoes?de=2026-04-01&ate=2026-04-30&team=EPGUI30&regional=CAC
// Histórico de sessões com colaboradores, horários e notas por tipo (fonte: snapshots)
router.get('/historico/sessoes', async (req, res) => {
  try {
    const sq = sbq();
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    let de  = req.query.de;
    let ate = req.query.ate;
    // Fallback: se vier ?m=YYYY-MM (retrocompatibilidade), converte para de/ate
    if (!de || !ate) {
      const ym = _parseYearMonth(req, res); if (!ym) return;
      de  = `${ym}-01`;
      const [year, month] = ym.split('-').map(Number);
      const ny = month === 12 ? year + 1 : year;
      const nm = month === 12 ? 1 : month + 1;
      const last = new Date(`${ny}-${String(nm).padStart(2, '0')}-01`);
      last.setDate(last.getDate() - 1);
      ate = last.toISOString().slice(0, 10);
    }
    if (!dateRe.test(de) || !dateRe.test(ate))
      return res.status(400).json({ error: 'Formato inválido. Use YYYY-MM-DD' });
    if (!sq) return res.json({ dias: [] });
    const dias = await sq.getTeamSessionHistory(de, ate, req.query.team || null, req.query.regional || null);
    res.json({ de, ate, dias });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/historico/diario?m=2026-04
router.get('/historico/diario', async (req, res) => {
  try {
    const sq = sbq();
    const ym = _parseYearMonth(req, res); if (!ym) return;
    if (!sq) return res.json({ mes: ym, dias: [] });
    const dias = await sq.getDailyHistory(ym);
    res.json({ mes: ym, dias });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/historico/subcats/mes?m=2026-04&regional=GUA
// Totais do mês agregados por sub_code (TL11, OBSOLETO, L0, L1, C93, BTZ013, OUTROS).
// Resposta: { mes, totais: { GUA: { 'MD/TL11': {count, quantidade}, ... }, CAC: {...} } }
router.get('/historico/subcats/mes', async (req, res) => {
  try {
    const sq = sbq();
    const ym = _parseYearMonth(req, res); if (!ym) return;
    const regional = req.query.regional || null;
    if (!sq) return res.json({ mes: ym, totais: { GUA: {}, CAC: {} } });
    const totais = await sq.getSubcatMonthTotals(ym, regional);
    res.json({ mes: ym, regional, totais });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/historico/subcats/diario?m=2026-04&regional=GUA
// Histórico diário por sub_code (matriz dia × subcategoria por regional).
// Resposta: { mes, regional, dias: [{ date, GUA: { 'MD/TL11': {...}, ... }, CAC: {...} }] }
router.get('/historico/subcats/diario', async (req, res) => {
  try {
    const sq = sbq();
    const ym = _parseYearMonth(req, res); if (!ym) return;
    const regional = req.query.regional || null;
    if (!sq) return res.json({ mes: ym, dias: [] });
    const dias = await sq.getSubcatDailyHistory(ym, regional);
    res.json({ mes: ym, regional, dias });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/historico/subcats/ranking?m=2026-04&regional=GUA&tipo=DD&subCode=C93
// Ranking de equipes por (tipo + sub_code) no mês. Filtros opcionais.
// Resposta: { mes, ranking: [{ team_name, regional, count, quantidade, ... }] }
router.get('/historico/subcats/ranking', async (req, res) => {
  try {
    const sq = sbq();
    const ym = _parseYearMonth(req, res); if (!ym) return;
    const regional = req.query.regional || null;
    const tipo     = req.query.tipo     || null;
    const subCode  = req.query.subCode  || null;
    if (!sq) return res.json({ mes: ym, ranking: [] });
    const ranking = await sq.getSubcatTeamRanking(ym, regional, tipo, subCode);
    res.json({ mes: ym, regional, tipo, subCode, ranking });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── METAS CALCULADAS ──────────────────────────────────────────────────────────

// GET /api/metas/calculadas?m=2026-04
// Retorna metas mensais com meta diária, semanal e progresso até hoje
router.get('/metas/calculadas', async (req, res) => {
  try {
    const sq = sbq();
    const ym = _parseYearMonth(req, res); if (!ym) return;
    if (!sq) return res.json({ mes: ym, regionais: {} });
    const resultado = await sq.getMetasCalculadas(ym);
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── RANKING E HISTÓRICO DE EQUIPES ────────────────────────────────────────────

// GET /api/ranking/equipes?m=2026-04&regional=GUA
// Ranking de equipes por total de notas concluídas no mês
router.get('/ranking/equipes', async (req, res) => {
  try {
    const sq       = sbq();
    const ym       = _parseYearMonth(req, res); if (!ym) return;
    const regional = req.query.regional || null;
    if (!sq) return res.json({ mes: ym, ranking: [] });
    const ranking = await sq.getTeamRanking(ym, regional);
    res.json({ mes: ym, regional: regional || 'ALL', ranking });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/historico/equipes?m=2026-04&team=EPICO30
// Histórico diário de uma equipe (ou todas as equipes do mês)
router.get('/historico/equipes', async (req, res) => {
  try {
    const sq   = sbq();
    const ym   = _parseYearMonth(req, res); if (!ym) return;
    const team = req.query.team || null;
    if (!sq) return res.json({ mes: ym, dias: [] });
    const dias = await sq.getTeamDailyHistory(ym, team);
    res.json({ mes: ym, team: team || 'ALL', dias });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── WPA PROXY / DEBUG ─────────────────────────────────────────────────────────

router.post('/wpa/login', async (req, res) => {
  try {
    const result = await wpaLogin();
    res.json({ ok: true, userId: result.userId });
  } catch (err) {
    res.status(401).json({ ok: false, error: err.message });
  }
});

// GET /api/wpa/token-status — estado atual do token em memória
router.get('/wpa/token-status', (req, res) => {
  res.json({ ...getTokenStatus(), ts: new Date().toISOString() });
});

/**
 * Heurística de fallback (best-effort) para classificar subcategoria a partir
 * dos campos JÁ presentes no payload de /details/optimized — SEM fazer chamadas
 * adicionais ao WPA. Usada apenas quando o cache (note_subcategorias) não tem
 * a nota. A fonte autoritativa é services/classifierService.js, populado pelo
 * cron e pelos scripts de backfill.
 *
 * Limitações conhecidas vs classifier:
 *   MD: classifier usa /api/notepriorities → SubProject (TL11/OBSOLETO).
 *       Aqui só temos Comments — checagem por substring "TL11" é menos confiável.
 *   SF: classifier consulta /api/notes/sfdl ou /sfrl que devolvem Code SRED/SREB.
 *       Aqui só temos o Code top-level de details/optimized — pode não bater.
 *   DD: aqui não temos GroupDescription (vem só de /api/notes/dd), então o
 *       fallback "RAMAL DE LIGACAO - CAPEX → C93" do classifier não roda.
 *       Activities[] segue a mesma estrutura aninhada (a.Activity.Code, a.Amount).
 *
 * Sub_codes canônicos (mesmos do classifier): TL11, OBSOLETO, L0, L1, C93,
 * BTZ013, ou null/code-original quando indeterminado.
 */
// Heurística e processamento de payload da OS extraídos para services/notaProcessor.js
const { processarNota, classificarSubCategoria } = require('../services/notaProcessor');

// GET /api/wpa/nota/:noteId — detalhes completos de uma OS pelo UUID (Data.Id)
// Endpoint WPA confirmado: GET /api/Notes/{noteId}/details/optimized?sectorId=DESG
// Retorna os dados da nota sem imagens Base64 (pesadas) a menos que ?fotos=1 seja passado.
// Requer também ?sectorId= (ex: DESG, DEPT, DESC) para que a API WPA retorne corretamente.
router.get('/wpa/nota/:noteId', async (req, res) => {
  const noteIdOriginal = req.params.noteId;
  let noteId           = noteIdOriginal;
  const sectorId       = req.query.sectorId || 'DESG';
  const incluirFotos   = req.query.fotos === '1';

  // Sanitização: aceita apenas UUID OU alfanumérico/hífen até 64 chars (número
  // de OS curto). Qualquer outra coisa pode ser tentativa de log injection ou
  // bug de cliente — rejeita 400 sem chegar a logar o input.
  if (!noteId || noteId.length > 64 || !/^[a-zA-Z0-9-]+$/.test(noteId)) {
    return res.status(400).json({ error: 'noteId inválido. Use UUID ou número de OS.' });
  }

  // Validação de sectorId (só aceita os 3 conhecidos)
  if (!['DESG', 'DEPT', 'DESC'].includes(sectorId)) {
    return res.status(400).json({ error: `sectorId inválido: ${sectorId}` });
  }

  // Tolerância: se chegar número de OS em vez de UUID (cache antigo do front
  // ou notas históricas sem UUID mapeado), tenta resolver via teams_current.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(noteId);
  let resolvedFromCodigo = false;
  if (!isUuid) {
    console.log(`[wpa/nota] não-UUID recebido: "${noteId}" (sectorId=${sectorId}) — tentando resolver via teams_current`);
    try {
      const sq = sbq();
      if (sq) {
        const all = await sq.getTeamsFromSupabase({});
        outer: for (const t of all) {
          for (const k of ['notasConcluidas','notasExecutadas','notasBaixadas','notasRejeitadas']) {
            for (const n of (t[k] || [])) {
              if (n.codigo === noteId && n.id) {
                noteId = n.id;
                resolvedFromCodigo = true;
                console.log(`[wpa/nota] resolvido: ${noteIdOriginal} → ${noteId} (team ${t.teamName})`);
                break outer;
              }
            }
          }
        }
        if (!resolvedFromCodigo) {
          console.warn(`[wpa/nota] codigo "${noteIdOriginal}" não encontrado em teams_current`);
        }
      }
    } catch (e) {
      console.warn('[wpa/nota] resolve por codigo falhou:', e.message);
    }
  }

  try {
    // ── 1) Cache-first ────────────────────────────────────────────────────
    // O cron de snapshot popula `note_details` com OS concluídas/rejeitadas.
    // Quando há cache, leitura é instantânea (~100ms) e funciona até quando o
    // ambiente não consegue falar com a WPA (Vercel + IP block da EDP).
    // Pula o cache se ?fotos=1 (cache não tem fotos em base64).
    if (MODE !== 'mock' && !incluirFotos) {
      try {
        const sq = sbq();
        if (sq) {
          const cached = await sq.getNoteDetailCache(noteId);
          if (cached?.payload) {
            console.log(`[wpa/nota] cache hit noteId=${noteId} fetched=${cached.fetched_at}`);
            return res.json({ ...cached.payload, _source: 'cache', _cachedAt: cached.fetched_at });
          }
        }
      } catch (e) { console.warn('[wpa/nota] cache lookup falhou:', e.message); }
    }

    // ── 2) Cache miss → busca ao vivo na WPA ─────────────────────────────
    const nota = await getNoteDetail(noteId, sectorId);
    if (!nota) {
      console.warn(`[wpa/nota] WPA retornou payload vazio — noteId=${noteId} sectorId=${sectorId} resolvedFromCodigo=${resolvedFromCodigo}`);
      return res.status(404).json({
        error: `Nota não encontrada na API WPA (payload vazio)`,
        debug: { noteIdOriginal, noteIdUsed: noteId, sectorId, resolvedFromCodigo, wpaStatus: 200, wpaBody: '(empty Data)' },
      });
    }

    // ── 3) Resolve subcategoria (cache do classificador → fallback heurístico)
    let subcat = { subCategoria: null, subcatCode: null, quantidade: null };
    if (MODE !== 'mock') {
      try {
        const { getSubcategoriasByIds } = require('../db/subcategoriasQueries');
        const cachedClass = await getSubcategoriasByIds([nota.Id]);
        const c = cachedClass[nota.Id];
        if (c) subcat = { subCategoria: c.sub_categoria, subcatCode: c.sub_code, quantidade: c.quantidade };
      } catch {}
    }
    if (!subcat.subCategoria) {
      const groupDesc = nota.GroupDescription || nota.Group?.Description || '';
      const fb = classificarSubCategoria(nota.Type, nota.Code, nota.Comments, nota.Activities, groupDesc);
      subcat = { subCategoria: fb.subCategoria, subcatCode: fb.subcatCode, quantidade: fb.quantidade };
    }

    // ── 4) Processa payload e responde ───────────────────────────────────
    const processed = processarNota(nota, { incluirFotos, subcat });

    // ── 5) Popula cache (somente versão sem fotos) ───────────────────────
    if (MODE !== 'mock' && !incluirFotos) {
      try {
        const sq = sbq();
        if (sq) await sq.setNoteDetailCache(nota.Id, nota.Number, nota.Type, sectorId, processed);
      } catch (e) { console.warn('[wpa/nota] cache save falhou:', e.message); }
    }

    res.json({ ...processed, _source: 'live' });
  } catch (err) {
    // Se getNoteDetail lançou erro estruturado (status WPA real), propaga p/ UI
    // poder discriminar 401 (token race) de 404 real ou 5xx (timeout / upstream).
    if (err.wpaStatus !== undefined) {
      console.warn(`[wpa/nota] WPA falhou — noteId=${noteId} sectorId=${sectorId} wpaStatus=${err.wpaStatus} elapsed=${err.wpaElapsed}ms body=${(err.wpaBody||'').slice(0,200)}`);
      // Mapeia status WPA → status HTTP da nossa rota (mantém 404 p/ compat com UI atual)
      const httpStatus = err.wpaStatus === 401 ? 401
                       : err.wpaStatus === 0   ? 502  // erro de rede/timeout
                       : err.wpaStatus >= 500  ? 502
                       : 404;                          // 404, 403, etc → bucket de "não disponível"
      return res.status(httpStatus).json({
        error: `WPA retornou ${err.wpaStatus || 'erro de rede'}`,
        debug: {
          noteIdOriginal, noteIdUsed: noteId, sectorId, resolvedFromCodigo,
          wpaStatus:  err.wpaStatus,
          wpaBody:    err.wpaBody,
          wpaElapsed: err.wpaElapsed,
          wpaPath:    err.wpaPath,
        },
      });
    }
    // Erro inesperado no nosso processamento (não vindo do WPA)
    console.error(`[NOTA-DETAIL] ${noteId}:`, err.message);
    res.status(500).json({ error: err.message, stack: err.stack?.split('\n').slice(0,3).join(' | ') });
  }
});

// POST /api/notas/subcategorias
// Body: { ids: ["uuid1", "uuid2", ...] }
// Retorna: { subcats: { [uuid]: { sub_code, sub_categoria, code, code_text, quantidade, tipo } } }
// Lê APENAS do cache persistente (Supabase). Resposta instantânea.
// Notas ainda não classificadas vêm como ausentes do mapa — caem em "OUTROS" no front.
router.post('/notas/subcategorias', async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) return res.json({ subcats: {} });

  // Em modo mock: nada de Supabase
  if (MODE === 'mock') return res.json({ subcats: {} });

  try {
    const { getSubcategoriasByIds } = require('../db/subcategoriasQueries');
    const subcats = await getSubcategoriasByIds(ids);
    res.json({ subcats });
  } catch (err) {
    console.error('[SUBCAT] erro lendo cache:', err.message);
    res.status(500).json({ error: err.message });
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

// GET /api/debug/historico-notas?sectorId=DESG&date=2026-04-01
// Inspeciona estrutura bruta das notas históricas (Status vs ExecutionStatus)
router.get('/debug/historico-notas', async (req, res) => {
  const { wpaFetch: wf } = require('../services/wpaService');
  const sectorId = req.query.sectorId || 'DESG';
  const date     = req.query.date     || '2026-04-01';
  const [y, m, d] = date.split('-');
  const wpaDate  = `${parseInt(m)}/${parseInt(d)}/${y}`;

  try {
    const raw  = await wf(`/api/notes/execution?sectorId=${sectorId}&date=${encodeURIComponent(wpaDate)}`);
    const data = await raw.json();
    const notas = data.Data?.Notes || data.Data || [];

    // Conta por Status e ExecutionStatus para descobrir qual campo usar
    const byStatus     = {};
    const byExecStatus = {};
    notas.forEach(n => {
      const s = n.Status          ?? 'undefined';
      const e = n.ExecutionStatus ?? 'undefined';
      byStatus[s]     = (byStatus[s]     || 0) + 1;
      byExecStatus[e] = (byExecStatus[e] || 0) + 1;
    });

    res.json({
      httpStatus:    raw.status,
      total:         notas.length,
      topLevelKeys:  data.Data ? Object.keys(data.Data) : Object.keys(data),
      notaKeys:      notas[0] ? Object.keys(notas[0]) : [],
      byStatus,
      byExecStatus,
      amostra: notas.slice(0, 5).map(n => ({
        Status:          n.Status,
        ExecutionStatus: n.ExecutionStatus,
        Type:            n.Type,
        TeamName:        n.Team?.Name,
        TeamId:          n.Team?.Id,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/debug/historico?sectorId=DESG&date=2026-04-01
// Inspeciona sessões históricas brutas sem filtro de empresa
router.get('/debug/historico', async (req, res) => {
  const { wpaFetch: wf } = require('../services/wpaService');
  const sectorId = req.query.sectorId || 'DESG';
  const date     = req.query.date     || '2026-04-01';
  const [y, m, d] = date.split('-');
  const wpaDate  = `${parseInt(m)}/${parseInt(d)}/${y}`;

  try {
    const raw  = await wf(`/api/Sessions/all/date?sectorId=${sectorId}&date=${encodeURIComponent(wpaDate)}`, { method: 'POST' });
    const data = await raw.json();
    const sessions = data.Data || [];

    res.json({
      status:        raw.status,
      total:         sessions.length,
      // Mostra os 3 primeiros com foco nos campos de empresa/equipe
      amostra: sessions.slice(0, 3).map(s => ({
        sessionId:   s.Id,
        teamName:    s.Team?.Name,
        teamId:      s.Team?.Id,
        companyId:   s.Team?.CompanyId,
        companyName: s.Team?.Company?.Name,
        sectorId:    s.SectorId || s.Sector?.Code,
        beginTime:   s.BeginTime,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/debug/preroute?sectorId=DESG  — inspeciona estrutura bruta do endpoint de carteira
router.get('/debug/preroute', async (req, res) => {
  const { wpaFetch: wf } = require('../services/wpaService');
  const sectorId = req.query.sectorId || 'DESG';
  try {
    const raw  = await wf(`/api/route/preroute?sectorId=${sectorId}`);
    const data = await raw.json();
    // Devolve estrutura bruta + amostra do primeiro item para inspeção
    const firstItem = Array.isArray(data.Data) ? data.Data[0] : data;
    res.json({
      status:    raw.status,
      topKeys:   Object.keys(data),
      dataType:  Array.isArray(data.Data) ? 'array' : typeof data.Data,
      dataLen:   Array.isArray(data.Data) ? data.Data.length : null,
      firstItem,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/debug/teamsstatus?sectorId=DESC&team=ECCIT55&raw=1
// Inspeciona teamsstatus/V2 cruzado com sessions/current (filtro Engelmig).
// raw=1  → devolve os 3 primeiros itens sem filtro (inspecionar estrutura)
// raw=0  → resumo filtrado por Engelmig via sessions/current (default)
router.get('/debug/teamsstatus', async (req, res) => {
  const { wpaFetch: wf } = require('../services/wpaService');
  const ENGELMIG_ID = '92a2f98e-8877-433e-8358-173b94c13a54';
  const sectorId   = req.query.sectorId || 'DESC';
  const teamFilter = (req.query.team || '').toLowerCase();
  const rawMode    = req.query.raw === '1';

  try {
    // Sempre busca V2; sessions/current só é chamado no modo filtrado
    const [rawV2, rawSess] = await Promise.all([
      wf(`/api/teamsstatus/V2?sectorId=${sectorId}&filterByExhibitionSector=true`),
      rawMode ? Promise.resolve(null) : wf(`/api/sessions/current?sectorId=${sectorId}`),
    ]);

    const bodyV2 = await rawV2.json();
    const list   = Array.isArray(bodyV2) ? bodyV2 : (bodyV2.Data || []);

    // ── Modo raw: estrutura bruta sem filtro ────────────────────────────────
    if (rawMode) {
      return res.json({
        sectorId,
        httpStatus: rawV2.status,
        totalItems: list.length,
        topLevelKeys: list[0] ? Object.keys(list[0]) : [],
        sessionKeys:  list[0]?.Session ? Object.keys(list[0].Session) : [],
        teamKeys:     list[0]?.Session?.Team ? Object.keys(list[0].Session.Team) : [],
        collaboratorKeys: list[0]?.Session?.Collaborators?.[0]
          ? Object.keys(list[0].Session.Collaborators[0]) : [],
        noteKeys: list[0]?.Concluded?.[0] ? Object.keys(list[0].Concluded[0]) : [],
        first3: list.slice(0, 3),
      });
    }

    // ── Modo filtrado: usa sessions/current para obter IDs Engelmig ─────────
    const sessBody = await rawSess.json();
    const sessions = sessBody.Data || [];

    const engelmigSessions = sessions.filter(s => s.Team?.CompanyId === ENGELMIG_ID);

    // Conjunto de team IDs Engelmig (CompanyId só existe em sessions/current)
    const engelmigIds = new Set(
      engelmigSessions.map(s => s.Team?.Id).filter(Boolean)
    );

    // Índice V2 por team ID e por nome (fallback)
    const v2ByTeamId   = new Map();
    const v2ByTeamName = new Map();
    list.forEach(item => {
      const id   = item.Session?.Team?.Id || item.Session?.TeamId;
      const nome = (item.Session?.Team?.Name || '').trim();
      if (id)   v2ByTeamId.set(id, item);
      if (nome) v2ByTeamName.set(nome, item);
    });

    // Diagnóstico de cruzamento — mostra equipes Engelmig que não acharam V2
    const diagSess = engelmigSessions.map(s => {
      const id   = s.Team?.Id;
      const nome = (s.Team?.Name || '').trim();
      const foundById   = id   ? v2ByTeamId.has(id)     : false;
      const foundByName = nome ? v2ByTeamName.has(nome)  : false;
      return { teamName: nome, teamId: id, foundById, foundByName };
    });

    // Filtra V2 pelos IDs Engelmig
    let items = [...engelmigIds]
      .map(id => v2ByTeamId.get(id))
      .filter(Boolean);

    // Filtro opcional por nome de equipe
    if (teamFilter) {
      items = items.filter(i =>
        (i.Session?.Team?.Name || '').toLowerCase().includes(teamFilter)
      );
    }

    const STATUS_V2 = { 1: 'baixada', 2: 'baixada', 3: 'executada', 6: 'executada', 7: 'executada', 4: 'concluida', 5: 'concluida', 9: 'concluida' };

    const resumo = items.map(item => {
      const s = item.Session || {};

      // Classifica Downloaded[] por ExecutionStatus para mostrar divisão real
      const downloaded = item.Downloaded || [];
      const baixadasN  = downloaded.filter(n => (STATUS_V2[n.ExecutionStatus] || 'baixada') === 'baixada').length;
      const execN      = downloaded.filter(n => STATUS_V2[n.ExecutionStatus] === 'executada').length;

      return {
        teamName:      s.Team?.Name || '?',
        sectorId:      s.SectorId  || '?',
        isOnline:      item.IsOnline,
        status:        item.Status,
        concluded:     (item.Concluded || []).length,
        // Downloaded subdividido por ExecutionStatus
        downloaded:    downloaded.length,
        downloaded_baixadas:  baixadasN,
        downloaded_executadas: execN,
        executed:      (item.Executed  || []).length,
        assigned:      (item.Assigned  || []).length,
        rejected:      (item.Rejected  || []).length,
        carteiraCount: baixadasN + execN + (item.Executed || []).length,
        sampleConcluded:  (item.Concluded  || []).slice(0, 3),
        sampleDownloaded: (item.Downloaded || []).slice(0, 2),
      };
    });

    res.json({
      sectorId,
      httpStatus:        rawV2.status,
      totalItemsV2:      list.length,
      totalSessions:     sessions.length,
      engelmigSessions:  engelmigSessions.length,
      engelmigItems:     items.length,
      // Diagnóstico: equipes Engelmig em sessions/current e se acharam par no V2
      diagSessVsV2: diagSess,
      // Nomes de todas as equipes presentes no V2 (para detectar mismatch de nome/ID)
      v2TeamNames: [...v2ByTeamName.keys()],
      resumo,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PRODUÇÃO POR EQUIPE ───────────────────────────────────────────────────────

// GET /api/equipes/producao?de=2026-04-01&ate=2026-04-30&regional=GUA&team=EPICO30
router.get('/equipes/producao', async (req, res) => {
  try {
    const sq = sbq();
    if (!sq) return res.json({ equipes: [], tipos: [] });
    const resultado = await sq.getTeamProducao(req.query);
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN ─────────────────────────────────────────────────────────────────────

// GET /api/admin/wpa-diag — diagnóstico ZERO-retry: descobre por que WPA falha em produção.
// Usar quando o /admin/warm sempre falha — esse endpoint mostra o que tá realmente acontecendo.
router.get('/admin/wpa-diag', async (_req, res) => {
  const fetch = require('node-fetch');
  const out = { env: {}, login: null, sessions: null, runtime: {} };

  // 1) Quais envs estão setadas (sem expor valores)
  out.env = {
    WPA_URL:       process.env.WPA_URL       ? '✓ ' + process.env.WPA_URL : '✗ não configurado (usará default)',
    WPA_API_URL:   process.env.WPA_API_URL   ? '✓ ' + process.env.WPA_API_URL : '✗ não configurado (usará default)',
    WPA_USERNAME:  process.env.WPA_USERNAME  ? '✓ setado (' + process.env.WPA_USERNAME.length + ' chars)' : '✗ NÃO CONFIGURADO',
    WPA_PASSWORD:  process.env.WPA_PASSWORD  ? '✓ setado (' + process.env.WPA_PASSWORD.length + ' chars)' : '✗ NÃO CONFIGURADO',
    DATA_MODE:     process.env.DATA_MODE     || '(undefined → mock)',
    VERCEL:        process.env.VERCEL        ? '✓ rodando no Vercel' : '✗ rodando local',
    VERCEL_REGION: process.env.VERCEL_REGION || 'desconhecida',
  };

  out.runtime = {
    nodeVersion: process.version,
    platform:    process.platform,
    now:         new Date().toISOString(),
  };

  // 2) Tenta UMA vez login (sem retry) — assim vemos o erro real e cru
  const WPA_AUTH = process.env.WPA_URL || 'https://edp-wpa-po.azurewebsites.net';
  const t0 = Date.now();
  try {
    const body = new URLSearchParams({
      Username: process.env.WPA_USERNAME || '',
      Password: process.env.WPA_PASSWORD || '',
    });
    const r = await fetch(`${WPA_AUTH}/identity/signin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: body.toString(),
    });
    const txt = await r.text();
    out.login = {
      url:           `${WPA_AUTH}/identity/signin`,
      httpStatus:    r.status,
      httpStatusText: r.statusText,
      contentType:   r.headers.get('content-type') || '(sem)',
      ms:            Date.now() - t0,
      bodyPreview:   txt.slice(0, 500),
      isHtml:        /^<!DOCTYPE|<html/i.test(txt.trim()),
      hasToken:      /Token/i.test(txt),
    };
  } catch (err) {
    out.login = {
      url:    `${WPA_AUTH}/identity/signin`,
      ms:     Date.now() - t0,
      error:  err.message,
      errorCode: err.code,
      errorName: err.name,
    };
  }

  // 3) Tenta UMA vez chamar a Web API (sessions/current) — só se login deu token
  if (out.login?.hasToken) {
    try {
      const tokenMatch = out.login.bodyPreview.match(/"Token":"([^"]+)"/);
      const token = tokenMatch?.[1];
      if (token) {
        const WPA_API = process.env.WPA_API_URL || 'https://edp-wpa-web-api.azurewebsites.net';
        const t1 = Date.now();
        const r2 = await fetch(`${WPA_API}/api/sessions/current?sectorId=DESG`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        });
        const txt2 = await r2.text();
        out.sessions = {
          url:         `${WPA_API}/api/sessions/current?sectorId=DESG`,
          httpStatus:  r2.status,
          ms:          Date.now() - t1,
          contentType: r2.headers.get('content-type') || '(sem)',
          bodyPreview: txt2.slice(0, 300),
          isHtml:      /^<!DOCTYPE|<html/i.test(txt2.trim()),
        };
      }
    } catch (err) {
      out.sessions = { error: err.message };
    }
  }

  res.json(out);
});

// POST /api/admin/warm — acorda o WPA (force-refresh do token + ping leve na Web API)
// Útil quando o Azure App Service hiberna e usuários começam a ver 502 cold-start.
router.post('/admin/warm', async (_req, res) => {
  const t0 = Date.now(); // captura antes do try para que catch também tenha acesso
  try {
    const { forceRefresh, getSessions } = require('../services/wpaService');
    // aggressive=true → backoff de até ~48s no login; tempo de espera aceitável
    // já que usuário/auto-recovery sabem que estão acordando o WPA.
    await forceRefresh({ aggressive: true });
    await getSessions('DESG').catch(() => null);
    res.json({ ok: true, ms: Date.now() - t0 });
  } catch (err) {
    console.error('[ADMIN warm]', err.message);
    res.status(500).json({ ok: false, error: err.message, ms: Date.now() - t0 });
  }
});

router.post('/admin/snapshot', async (req, res) => {
  try {
    const c = cron();
    if (!c) return res.status(503).json({ ok: false, error: 'cronService indisponível neste ambiente (Vercel/supabase)' });
    await c.runSnapshot();
    res.json({ ok: true, ts: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/backfill?date=YYYY-MM-DD
// Busca dados históricos do WPA e salva no Supabase como se o cron tivesse rodado naquele dia
router.post('/admin/backfill', async (req, res) => {
  const date = req.query.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Parâmetro date obrigatório no formato YYYY-MM-DD' });
  }
  try {
    const { getTeamsByDate }                                          = require('../services/wpaService');
    const { saveSnapshot, upsertDailyTotals, upsertTeamDailyTotals } = require('../services/supabasePush');

    const SETORES = ['DESG', 'DEPT', 'DESC'];
    console.log(`[BACKFILL] Iniciando para ${date}...`);

    const resultados = await Promise.all(
      SETORES.map(s => getTeamsByDate(s, date).catch(err => {
        console.warn(`[BACKFILL] Setor ${s} falhou: ${err.message}`);
        return [];
      }))
    );
    const teams = resultados.flat();

    if (teams.length === 0) {
      return res.json({ ok: false, msg: 'Nenhuma equipe encontrada para essa data', date });
    }

    await saveSnapshot(teams, date);
    await upsertDailyTotals(teams, date);
    await upsertTeamDailyTotals(teams, date);

    // Classifica subcategorias (incluindo Amount de C93/BTZ013) ANTES de consolidar,
    // para que upsertSubcatTotals dentro de runConsolidate encontre os dados corretos.
    const { runClassifyNewNotes } = require('../services/cronService');
    const allNotasBackfill = [...teams];
    console.log(`[BACKFILL] Classificando subcategorias para ${date}...`);
    await runClassifyNewNotes(allNotasBackfill).catch(err =>
      console.warn(`[BACKFILL] runClassifyNewNotes falhou (não crítico): ${err.message}`)
    );

    // Consolida ao final para garantir apenas concluídas nos totais históricos
    const c = cron();
    if (c) await c.runConsolidate(date);

    console.log(`[BACKFILL] Concluído: ${teams.length} equipes para ${date}`);
    res.json({
      ok:     true,
      date,
      teams:  teams.length,
      concluidas: teams.reduce((s, t) => s + (t.notasConcluidas || []).length, 0),
      executadas: teams.reduce((s, t) => s + (t.notasExecutadas || []).length, 0),
    });
  } catch (err) {
    console.error('[BACKFILL] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/backfill/range?de=YYYY-MM-DD&ate=YYYY-MM-DD
// Backfill de múltiplos dias sequencialmente (um dia por vez para não sobrecarregar a API)
router.post('/admin/backfill/range', async (req, res) => {
  const { de, ate } = req.query;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!de || !dateRe.test(de) || !ate || !dateRe.test(ate)) {
    return res.status(400).json({ error: 'Parâmetros de e ate obrigatórios no formato YYYY-MM-DD' });
  }
  if (de > ate) {
    return res.status(400).json({ error: 'de não pode ser maior que ate' });
  }

  // Gera lista de datas no intervalo
  const datas = [];
  const cur = new Date(de + 'T12:00:00Z');
  const end = new Date(ate + 'T12:00:00Z');
  while (cur <= end) {
    datas.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  if (datas.length > 30) {
    return res.status(400).json({ error: 'Intervalo máximo de 30 dias por chamada' });
  }

  const { getTeamsByDate }                                          = require('../services/wpaService');
  const { saveSnapshot, upsertDailyTotals, upsertTeamDailyTotals } = require('../services/supabasePush');
  const SETORES = ['DESG', 'DEPT', 'DESC'];

  const resultados = [];
  console.log(`[BACKFILL-RANGE] Iniciando ${datas.length} dias: ${de} → ${ate}`);

  for (const date of datas) {
    try {
      const chunks = await Promise.all(
        SETORES.map(s => getTeamsByDate(s, date).catch(err => {
          console.warn(`[BACKFILL-RANGE] ${date}/${s} falhou: ${err.message}`);
          return [];
        }))
      );
      const teams = chunks.flat();

      if (teams.length === 0) {
        resultados.push({ date, ok: false, msg: 'Nenhuma equipe encontrada' });
        continue;
      }

      await saveSnapshot(teams, date);
      await upsertDailyTotals(teams, date);
      await upsertTeamDailyTotals(teams, date);

      // Classifica subcategorias (Amount de C93/BTZ013) antes de consolidar
      const { runClassifyNewNotes } = require('../services/cronService');
      await runClassifyNewNotes(teams).catch(err =>
        console.warn(`[BACKFILL-RANGE] ${date}: runClassifyNewNotes falhou: ${err.message}`)
      );

      const c = cron();
      if (c) await c.runConsolidate(date);

      const concluidas = teams.reduce((s, t) => s + (t.notasConcluidas || []).length, 0);
      console.log(`[BACKFILL-RANGE] ${date}: ${teams.length} equipes, ${concluidas} concluídas`);
      resultados.push({ date, ok: true, teams: teams.length, concluidas });
    } catch (err) {
      console.error(`[BACKFILL-RANGE] ${date} erro:`, err.message);
      resultados.push({ date, ok: false, error: err.message });
    }
  }

  const totalConcluidas = resultados.filter(r => r.ok).reduce((s, r) => s + (r.concluidas || 0), 0);
  const diasOk          = resultados.filter(r => r.ok).length;
  console.log(`[BACKFILL-RANGE] Concluído: ${diasOk}/${datas.length} dias, ${totalConcluidas} notas totais`);
  res.json({ ok: true, de, ate, dias: datas.length, diasOk, totalConcluidas, resultados });
});

router.post('/admin/consolidar', async (req, res) => {
  try {
    const c    = cron();
    if (!c) return res.status(503).json({ ok: false, error: 'cronService indisponível neste ambiente (Vercel/supabase)' });
    const date = req.query.date || dateBRT();
    await c.runConsolidate(date);
    res.json({ ok: true, date });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
