/**
 * routes/index.js
 * Rotas da API do WPA Monitor.
 */

const express = require('express');
const { getTeams, getTeamDetail, getSummary } = require('../services/dataService');
const { login: wpaLogin, wpaFetch, getTokenStatus, getNoteDetail,
        searchNoteByNumber, _isNoteNumber, REGIONAL_MAP } = require('../services/wpaService');
const { dateBRT } = require('../services/timeUtil');
const { inRegionals } = require('../services/regionals');

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

/**
 * Valida um intervalo `de`/`ate`: data real e ordem correta. Responde 400 e
 * devolve false quando inválido.
 *
 * 28/08/2026 — P1-41. O regex `^\d{4}-\d{2}-\d{2}$` que já existia nas rotas
 * valida só o FORMATO: `9999-99-99` passa, e chega no Postgres como data
 * inválida (erro 500 opaco). Intervalo invertido (`ate` < `de`) passava também,
 * devolvendo lista vazia como se não houvesse produção.
 *
 * ⚠️ NÃO tem teto de dias, e isso é deliberado — a auditoria de 28/08 propôs 45
 * dias, mas a medição na VM mostrou que o teto não resolve e atrapalha:
 *   - a taxa real é 6.200–7.800 linhas/dia (não os 3.360 estimados), então 45
 *     dias seriam ~353k linhas, ACIMA do teto de 200k do `_selectAll` — as duas
 *     correções se contradiriam;
 *   - um teto que funcionasse (≤24 dias) quebraria a consulta MENSAL, que é a
 *     mais usada no painel.
 * O que resolveu foi reduzir no SQL: `getTeamSessionHistory` passou a usar
 * DISTINCT ON e a consulta mensal de julho caiu de 243.113 linhas para ~4.340.
 * Com isso o intervalo largo deixou de ser um problema de volume. Ver o item
 * P1-41 em docs/handoff/AUDIT-2026-08-28.md.
 */
function _checkJanela(req, res, de, ate) {
  const d0 = Date.parse(`${de}T00:00:00Z`);
  const d1 = Date.parse(`${ate}T00:00:00Z`);
  if (!Number.isFinite(d0) || !Number.isFinite(d1)) {
    res.status(400).json({ error: `Data inválida: de=${de} ate=${ate}` });
    return false;
  }
  if (d1 < d0) {
    res.status(400).json({
      error: `Intervalo invertido: "ate" (${ate}) é anterior a "de" (${de}).`,
    });
    return false;
  }
  return true;
}

const { login: authLogin, authMiddleware, requireAdmin, compatRegionalParam, applyScope } = require('../middleware/auth');

const router = express.Router();

const MODE = (process.env.DATA_MODE || 'mock').toLowerCase();

// ── AUTH ─────────────────────────────────────────────────────────────────────
// Rate limit em memória pro /auth/login (P1-5). Sem dependência externa.
// Chave = IP+username. Janela deslizante: máx N tentativas ERRADAS em JANELA.
// Login OK zera o contador. Bloqueio devolve 429 com Retry-After.
// Motivo: painel escuta na rede interna (172.25.x); sem throttle, brute force
// ilimitado contra as 5 contas. Cluster mode = 1 instância, então o Map em
// memória cobre todo o tráfego (documentado em ecosystem.config.js).
const _loginTries = new Map();   // chave → { count, first }
const LOGIN_MAX = 10;            // tentativas erradas
const LOGIN_WINDOW_MS = 5 * 60 * 1000;  // por 5 min

// 28/08/2026 — P1-42. `x-forwarded-for` é enviado PELO CLIENTE, tinha precedência
// sobre o IP real e não era validado em lugar nenhum (não existe
// `app.set('trust proxy', ...)` no server.js). Isso deixava o P1-5 sem efeito:
// trocando o header a cada request, cada tentativa caía num balde novo que sempre
// começava em `count: 1` — o teto de 10 nunca era alcançado.
//
// O IP do socket não é falsificável por quem fala HTTP com a gente. O painel
// escuta na rede interna e não tem proxy reverso na frente; se um dia tiver, o
// certo é `app.set('trust proxy', 1)` no server.js e voltar a ler o XFF por essa
// via — NUNCA confiar no header cru.
function _loginKey(req, username) {
  const ip = req.socket?.remoteAddress || 'unknown';
  return `${ip}|${username || '?'}`;
}

// Balde secundário: só o username. Fecha o caso de origem distribuída — o IP
// muda, o alvo não. Teto mais alto que o por-IP porque aqui trafega o login
// legítimo de todo mundo que usa aquela conta.
const LOGIN_MAX_USER = 30;
function _loginKeyUser(username) { return `user|${username || '?'}`; }

/**
 * Estado de um balde: se está estourado e quantos segundos faltam.
 * FUNÇÃO PURA (recebe o registro, não o Map) — testável sem HTTP.
 */
function _baldeEstourado(rec, teto, now, janelaMs) {
  if (!rec) return { estourado: false, retryS: 0 };
  if (now - rec.first >= janelaMs) return { estourado: false, retryS: 0 };
  if (rec.count < teto) return { estourado: false, retryS: 0 };
  return { estourado: true, retryS: Math.ceil((janelaMs - (now - rec.first)) / 1000) };
}

/** Registra uma tentativa ERRADA num balde (reinicia a janela se expirou). */
function _contarErro(chave, now) {
  const rec = _loginTries.get(chave);
  if (!rec || now - rec.first >= LOGIN_WINDOW_MS) {
    _loginTries.set(chave, { count: 1, first: now });
  } else {
    rec.count += 1;
  }
}

// POST /api/auth/login  — única rota pública
router.post('/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'username e password obrigatórios' });

  // P1-42: DOIS baldes. Por (IP do socket + username) e por username sozinho.
  // Qualquer um estourado devolve 429 — o primeiro fecha brute force de uma
  // origem, o segundo fecha origem distribuída contra a mesma conta.
  const key     = _loginKey(req, username);
  const keyUser = _loginKeyUser(username);
  const now = Date.now();

  const porIp   = _baldeEstourado(_loginTries.get(key),     LOGIN_MAX,      now, LOGIN_WINDOW_MS);
  const porUser = _baldeEstourado(_loginTries.get(keyUser), LOGIN_MAX_USER, now, LOGIN_WINDOW_MS);
  if (porIp.estourado || porUser.estourado) {
    const retryS = Math.max(porIp.retryS, porUser.retryS);
    res.set('Retry-After', String(retryS));
    return res.status(429).json({
      error: `Muitas tentativas. Tente novamente em ${retryS}s.`,
      code: 'RATE_LIMITED',
    });
  }

  const result = authLogin(username, password);
  if (!result) {
    _contarErro(key, now);
    _contarErro(keyUser, now);
    return res.status(401).json({ error: 'Usuário ou senha incorretos' });
  }

  // Sucesso → zera os DOIS contadores.
  _loginTries.delete(key);
  _loginTries.delete(keyUser);
  res.json({
    token:     result.token,
    v:         result.v,
    username:  result.username,
    role:      result.role,
    regionals: result.regionals,
    exp:       result.exp,
  });
});

// Protege TODAS as rotas abaixo com JWT
router.use(authMiddleware);

// Compat: aceita ?regional=XX legado e normaliza pra req.scope.regionals
router.use(compatRegionalParam);
// Popula req.scope.regionals (sempre array não-vazio) com escopo do user
router.use(applyScope);

// Todas as rotas /admin/* exigem role=admin (defesa em profundidade — frontend
// também esconde botões pra não-admin, mas a API rejeita por sua conta).
router.use('/admin', requireAdmin);

// /debug/* também (P1-38, 25/08/2026). São 5 rotas de inspeção que aceitam
// ?sectorId= livre e devolvem payload BRUTO da WPA (sessões, carteira, notas do
// dia) — qualquer conta autenticada lia o de outra regional, o mesmo vazamento
// que o guard de /wpa/nota fecha. Nada no frontend nem em scripts consome
// /debug: são ferramentas manuais do dev, e admin é quem as usa.
router.use('/debug', requireAdmin);

// Nenhuma rota /debug toca a WPA em modo mock (26/08/2026). Todas as 5 chamam
// wpaFetch direto, sem checar MODE — então a suíte de testes ia à EDP de
// verdade. Fica DEPOIS do requireAdmin de propósito: 403 por permissão continua
// tendo precedência sobre 404 por modo, e os testes de autorização seguem
// exercitando o guard real. Mesmo motivo do bloco em /wpa/nota.
router.use('/debug', (req, res, next) => {
  if (MODE === 'mock') {
    return res.status(404).json({
      error: 'rotas /debug não operam em DATA_MODE=mock (não tocam a WPA).',
      mode: MODE,
    });
  }
  next();
});

// db/queries (leitura do Postgres): carregado em todos os modos que não sejam
// mock. (O nome sbq é legado — antes "supabase queries"; hoje é o pg shim.)
let _sbq = null;
function sbq() {
  if (_sbq) return _sbq;
  if (MODE === 'mock') return null;
  try {
    _sbq = require('../db/queries');
    return _sbq;
  } catch (err) {
    console.warn('[SBQ] Módulo indisponível:', err.message);
    return null;
  }
}

// Fallback em memória para metas (apenas no modo mock)
let _metasMemory = { GUA: {}, CAC: {} };

// Recorta o fallback em memória pelo escopo do usuário (fix vazamento 14/07/2026).
function _scopeMetasMemory(req) {
  const scope = (req.scope && Array.isArray(req.scope.regionals)) ? req.scope.regionals : null;
  if (!scope) return _metasMemory;
  const out = {};
  scope.forEach(r => { out[r] = _metasMemory[r] || {}; });
  return out;
}

// ── METAS DIÁRIAS (produtividade — box do Monitor) ────────────────────────────
// Separadas da tabela `metas` (aquela alimenta os Gráficos, mensal). Estas são a
// meta DIÁRIA por card de produtividade, por regional, pra evidência de execução
// (23/07/2026). Vivem em app_settings key 'metas_diarias' → { reg: { key: val } }.
// Fallback em memória p/ modo mock (testes), espelhando _metasMemory.
let _metasDiariasMemory = {};
function _scopeMetasDiarias(all, regionals) {
  const src = all || {};
  if (!Array.isArray(regionals) || regionals.length === 0) return src;
  const out = {};
  for (const r of regionals) if (src[r]) out[r] = src[r];
  return out;
}

// Cron: carregamento lazy (mantém o require tolerante a falha de carga).
function cron() {
  try { return require('../services/cronService'); }
  catch (err) {
    console.warn('[CRON] cronService indisponível:', err.message);
    return null;
  }
}

// ── DADOS DO MONITOR ──────────────────────────────────────────────────────────

// GET /api/teams?regional=GUA&sectorId=DESG
router.get('/teams', async (req, res) => {
  try {
    // wpa / mock: dados ao vivo da API WPA ou mock. O caminho Supabase (Vercel)
    // foi removido na Fase 4 — ver specs/aposentar-vercel-supabase-remote.md.
    // `out` recebe o report POR SETOR desta chamada (P1-30). Sem ele, um setor
    // que falha some do painel sem aviso: a resposta vinha 200 com lista vazia,
    // igualzinho a um domingo (P1-39, incidente 24-25/08/2026).
    const outColeta = {};
    const teams = await getTeams({ ...req.query, regionals: req.scope.regionals }, outColeta);

    // ── Summary do dia (UUID-aware, deduplicado, com canceladas) ──────────
    // Compara PRIMEIRO e ÚLTIMO snapshot do dia de cada equipe pra detectar:
    //   - inicial: tudo que entrou no dia
    //   - atual/andamento/concluidas/rejeitadas: estado no último snap
    //   - canceladas: estavam no inicial mas sumiram (EDP cancelou/transferiu)
    // Aritmética fecha por construção: inicial = atual+andamento+conc+rej+canc.
    let diaSummary = null;
    let carteiraInicialDedup = null;
    try {
      const dataServiceLazy = require('../services/dataService');
      // Filtra o summary pelo escopo de regional do user. Sem isso, summary
      // global vazaria contagens de outras regionais que o user não pode ver.
      //
      // 25/08/2026: aqui passava-se a lista de SIGLAS que `getTeams` acabou de
      // devolver. Setor cuja coleta ao vivo falha não devolve equipe nenhuma —
      // e lista vazia virava "sem filtro", servindo o banco inteiro rotulado
      // como a regional do filtro. Ver comentário em dataService._buildDiaSummary.
      // req.scope.regionals é garantido não-vazio pelo applyScope (403 se for).
      if (typeof dataServiceLazy._buildDiaSummary === 'function') {
        diaSummary = await dataServiceLazy._buildDiaSummary(req.scope.regionals);
      }
      // Fallback / retrocompat: campo legado carteira_inicial_dedup continua presente
      // (frontend antigo pode ainda usar). Novos campos vão em diaSummary.
      if (diaSummary && typeof diaSummary.inicial === 'number') {
        carteiraInicialDedup = diaSummary.inicial;
      } else if (typeof dataServiceLazy._carteiraInicialDedupTotal === 'function') {
        carteiraInicialDedup = dataServiceLazy._carteiraInicialDedupTotal(teams);
      }
    } catch (_) { /* ignora — fallback usa soma simples no frontend */ }

    // Strip dos UUIDs dos teams antes de enviar — só serviram pro cálculo
    // server-side. Sem isso, payload cresce ~150KB com lista de UUIDs por equipe.
    for (const t of teams) {
      if (t && t._carteiraInicialUUIDs) delete t._carteiraInicialUUIDs;
    }

    // ── Estado da COLETA por regional (P1-39) ─────────────────────────────
    // Aditivo: front antigo ignora. `degradado` existe pra o front decidir num
    // if só, sem varrer o mapa. Nunca deixa a rota cair — se isto falhar, o
    // painel volta ao comportamento de antes (mostrar o que tem), e não a 500.
    let coleta = null;
    try {
      const { buildColetaStatus } = require('../services/dataService');
      let sectorLastOk = null;
      const sqColeta = sbq();   // null em modo mock
      if (sqColeta) {
        try {
          const row = await sqColeta.getSetting('sector_last_ok');
          sectorLastOk = row && row.data;
        } catch (_) { /* sem carimbo → `desde` fica null, não inventa horário */ }
      }
      coleta = buildColetaStatus(outColeta.report, sectorLastOk, req.scope.regionals);
    } catch (_) { /* estado da coleta é observabilidade, não pode derrubar /teams */ }

    res.json({
      teams,
      count: teams.length,
      mode: MODE,
      coleta,   // { degradado, regionais: { SJC: {status, setores, parcial, desde, msg} } }
      summary: {
        carteira_inicial_dedup: carteiraInicialDedup,
        dia: diaSummary,  // { inicial, atual, andamento, concluidas, rejeitadas, canceladas }
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper: bloqueia request com `team=` se a equipe não pertence à regional
// do usuário (não-admin). Defesa pra endpoints que aceitam team direto sem
// filtro de regional explícito (ex: /mapa/equipe). Cache em memória pra
// não consultar a cada request.
const _equipeRegionalCache = { map: null, fetchedAt: 0 };
async function _resolveTeamRegional(sigla) {
  // Cache de 60s — equipes oficiais mudam raramente
  if (!_equipeRegionalCache.map || (Date.now() - _equipeRegionalCache.fetchedAt) > 60000) {
    try {
      const sb = require('../services/dbClient').getClient();
      const { data } = await sb.from('equipes_oficiais').select('sigla, regional');
      const m = new Map();
      (data || []).forEach(e => m.set(e.sigla, e.regional));
      _equipeRegionalCache.map = m;
      _equipeRegionalCache.fetchedAt = Date.now();
    } catch (e) {
      return null;
    }
  }
  return _equipeRegionalCache.map.get(sigla) || null;
}

/**
 * Verifica se a equipe (`team`) pertence à regional do usuário logado.
 * Retorna `true` quando ok (deixa passar), `false` quando bloqueia
 * (e responde 403 direto).
 *
 * Admin (regional=ALL) sempre passa. Quando team é vazio/ALL/null, passa
 * (não-admin já tem o filtro por regional aplicado pelo authMiddleware).
 */
/**
 * O SETOR pedido pertence a alguma regional do escopo do usuário? FUNÇÃO PURA.
 *
 * P1-38 (25/08/2026). Irmã do `enforceTeamRegional` (P0-4), mas para o eixo
 * SETOR — que é como `/wpa/nota/:noteId` endereça a EDP. Lá o `?sectorId=` era
 * validado só contra a lista de setores existentes, nunca contra o escopo: um
 * usuário de GUA passava `?sectorId=DSSJ` e lia a nota inteira de SJC.
 *
 * Setor desconhecido devolve false de propósito — quem valida a EXISTÊNCIA do
 * setor é o 400 da rota, que roda antes. Aqui, na dúvida, nega.
 */
function _setorNoEscopo(sectorId, regionals) {
  if (!Array.isArray(regionals) || regionals.length === 0) return false;
  const reg = REGIONAL_MAP[sectorId];
  return Boolean(reg) && regionals.includes(reg);
}

async function enforceTeamRegional(req, res, team) {
  if (!team || team === 'ALL') return true;
  // JWT v=2 usa req.user.regionals (array de siglas reais). NÃO existe mais
  // req.user.regional (singular) — a checagem antiga `!req.user.regional`
  // dava early-return sempre-true e desativava esta guarda silenciosamente
  // (bug P0-4, corrigido 08/07/2026). Ver docs/handoff/BACKLOG.md.
  const userRegs = req.user && req.user.regionals;
  if (!Array.isArray(userRegs) || userRegs.length === 0) return true;  // sem escopo → applyScope já cuidou
  // Múltiplas siglas (CSV) — bloqueia se QUALQUER uma não for da(s) regional(is)
  const teams = String(team).split(',').map(s => s.trim()).filter(Boolean);
  for (const t of teams) {
    const reg = await _resolveTeamRegional(t);
    // Bloqueia em 2 casos:
    //   1. Sigla desconhecida (não está em equipes_oficiais) — defesa contra
    //      sigla "fantasma" ou typo intencional pra burlar o filtro
    //   2. Sigla pertence a uma regional fora do escopo do usuário
    if (!reg || !userRegs.includes(reg)) {
      res.status(403).json({
        error: reg
          ? `Acesso negado: equipe ${t} não pertence à(s) regional(is) do seu usuário (${userRegs.join(', ')}).`
          : `Acesso negado: equipe ${t} não está cadastrada ou não pertence à sua regional.`,
        code: 'TEAM_REGIONAL_MISMATCH',
      });
      return false;
    }
  }
  return true;
}

// GET /api/equipes
// Lista de equipes oficiais ativas — pública pra qualquer usuário logado,
// filtrada automaticamente pela regional do user (não-admin só vê suas).
// Usada pra popular dropdowns de filtros nas abas de Rejeições, Deslocamentos,
// Gráficos e Mapa. Substituiu /admin/equipes nesses pontos quando role-based
// virou requireAdmin (admin/equipes ficou só pra CRUD).
router.get('/equipes', async (req, res) => {
  try {
    const sq = sbq();
    if (!sq) return res.status(503).json({ error: 'Supabase indisponível' });
    const sb = require('../services/dbClient').getClient();
    let q = sb
      .from('equipes_oficiais')
      .select('sigla, regional, tipo, ativo')
      .eq('ativo', true)
      .order('regional')
      .order('sigla');
    // Não-admin → só sua(s) regional(is). Expande grupos (ES → GUA,CAC).
    // Defesa em profundidade — middleware já força regional na query.
    if (req.scope && req.scope.regionals) {
      q = inRegionals(q, req.scope.regionals);
    }
    const { data, error } = await q;
    if (error) throw error;
    res.json({ equipes: data || [], count: (data || []).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/teams/historico?de=YYYY-MM-DD&ate=YYYY-MM-DD&regional=GUA
// Retorna equipes de um período via snapshots (Supabase)
router.get('/teams/historico', async (req, res) => {
  const { de, ate } = req.query;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!de || !dateRe.test(de) || !ate || !dateRe.test(ate)) {
    return res.status(400).json({ error: 'Parâmetros de e ate obrigatórios no formato YYYY-MM-DD' });
  }
  try {
    const sq    = sbq();
    const teams = sq ? await sq.getTeamsByDateFromSnapshots(de, ate, req.scope.regionals) : [];
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
    // Escopo regional (fix vazamento 14/07/2026): getTeamDetail varre TODOS os
    // setores e casava por id/sigla/nome sem checar regional — um user GUA podia
    // ler o detalhe (notas + colaboradores) de equipe SJC só sabendo a sigla.
    // 404 (não 403) pra não revelar a existência de equipe fora do escopo.
    const userRegs = req.user && req.user.regionals;
    const teamReg  = String(team.regional || '').toUpperCase();
    if (Array.isArray(userRegs) && userRegs.length && teamReg && !userRegs.includes(teamReg)) {
      return res.status(404).json({ error: 'Equipe não encontrada.' });
    }
    res.json(team);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/summary
router.get('/summary', async (req, res) => {
  try {
    const summary = await getSummary({ ...req.query, regionals: req.scope.regionals });
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
    // Escopo regional: user só vê metas das suas regionais (fix 14/07/2026).
    const metas = sq ? await sq.getMetas(req.scope.regionals) : _scopeMetasMemory(req);
    res.json(metas);
  } catch (err) {
    console.error('[API] getMetas:', err.message);
    res.json(_scopeMetasMemory(req));
  }
});

// POST /api/metas — admin edita todas; gua/cac/sjc só editam a sua regional.
// Authorização: authMiddleware ja garante login. Aqui filtramos por role/regional.
router.post('/metas', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Não autenticado', code: 'NO_TOKEN' });
    }

    const isAdmin = req.user.role === 'admin';
    const incoming = req.body || {};

    // Filtragem por role (JWT v=2 usa req.user.regionals — array de siglas reais).
    //   - admin: aceita o body inteiro (todas regionais)
    //   - não-admin: só aceita os slots das regionais do seu escopo
    // Bug P0-5 (corrigido 08/07/2026): lia req.user.regional (singular, não
    // existe no v=2) → 403 pra QUALQUER não-admin. Ver docs/handoff/BACKLOG.md.
    let payload;
    if (isAdmin) {
      payload = incoming;
    } else {
      const allowed = req.user.regionals;
      if (!Array.isArray(allowed) || allowed.length === 0) {
        return res.status(403).json({ error: 'Conta sem regional vinculada', code: 'NO_REGIONAL' });
      }
      // Pega apenas os slots que o user pode editar
      payload = {};
      for (const r of allowed) {
        if (incoming[r] !== undefined) payload[r] = incoming[r];
      }
      if (Object.keys(payload).length === 0) {
        return res.status(400).json({
          error: `Body deve conter pelo menos um dos slots: ${allowed.join(', ')}`,
        });
      }
    }

    const sq = sbq();
    if (sq) {
      await sq.setMetas(payload);
      // Resposta escopada (fix 14/07/2026): não-admin recebe de volta só as suas
      // regionais — antes getMetas() devolvia todas no corpo do POST.
      const metas = await sq.getMetas(isAdmin ? null : req.scope.regionals);
      res.json({ ok: true, metas, updated: Object.keys(payload) });
    } else {
      // Modo mock: mescla pra não apagar outras regionais
      _metasMemory = { ..._metasMemory, ...payload };
      res.json({ ok: true, metas: isAdmin ? _metasMemory : _scopeMetasMemory(req), updated: Object.keys(payload) });
    }
  } catch (err) {
    console.error('[API] setMetas:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/metas-diarias — metas diárias por card de produtividade, por regional.
// Escopada às regionais do user. Fonte: app_settings 'metas_diarias'.
router.get('/metas-diarias', async (req, res) => {
  try {
    const sq = sbq();
    const all = sq ? ((await sq.getSetting('metas_diarias'))?.data || {}) : _metasDiariasMemory;
    res.json(_scopeMetasDiarias(all, req.scope.regionals));
  } catch (err) {
    console.error('[API] getMetasDiarias:', err.message);
    res.json(_scopeMetasDiarias(_metasDiariasMemory, req.scope.regionals));
  }
});

// POST /api/metas-diarias — admin edita todas; regional edita só a sua. Mescla
// no blob existente (não apaga outras regionais). Mesma regra de role do /metas.
router.post('/metas-diarias', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Não autenticado', code: 'NO_TOKEN' });
    const isAdmin = req.user.role === 'admin';
    const incoming = req.body || {};

    let allowedRegs;
    if (isAdmin) {
      allowedRegs = Object.keys(incoming);
    } else {
      const allowed = req.user.regionals;
      if (!Array.isArray(allowed) || allowed.length === 0) {
        return res.status(403).json({ error: 'Conta sem regional vinculada', code: 'NO_REGIONAL' });
      }
      allowedRegs = allowed.filter(r => incoming[r] !== undefined);
      if (allowedRegs.length === 0) {
        return res.status(400).json({ error: `Body deve conter pelo menos um dos slots: ${allowed.join(', ')}` });
      }
    }

    const sq = sbq();
    if (sq) {
      const cur = (await sq.getSetting('metas_diarias'))?.data || {};
      for (const r of allowedRegs) cur[r] = incoming[r];
      await sq.setSetting('metas_diarias', cur);
      res.json({ ok: true, metas: _scopeMetasDiarias(cur, isAdmin ? Object.keys(cur) : req.scope.regionals), updated: allowedRegs });
    } else {
      for (const r of allowedRegs) _metasDiariasMemory[r] = incoming[r];
      res.json({ ok: true, metas: _scopeMetasDiarias(_metasDiariasMemory, isAdmin ? Object.keys(_metasDiariasMemory) : req.scope.regionals), updated: allowedRegs });
    }
  } catch (err) {
    console.error('[API] setMetasDiarias:', err.message);
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
    const team     = req.query.team     || null;   // sigla específica ou null/ALL
    if (!(await enforceTeamRegional(req, res, team))) return;
    if (!sq) {
      const empty = { ALL: {} };
      req.scope.regionals.forEach(r => { empty[r] = {}; });
      return res.json({ de, ate, totais: empty, quantidades: { ...empty } });
    }
    const result = await sq.getDailySubcatTotals(de, ate, req.scope.regionals, team);
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
    if (!sq) {
      const totais = { ALL: 0 };
      req.scope.regionals.forEach(r => { totais[r] = 0; });
      return res.json({ de, ate, totais });
    }
    const totais = await sq.getRealizadasDoDia(de, ate, req.scope.regionals);
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

    const MAX_DAYS = 93;
    const diffMs = new Date(ate + 'T12:00:00Z') - new Date(de + 'T12:00:00Z');
    if (diffMs > MAX_DAYS * 86400 * 1000) {
      return res.status(400).json({ error: `Período máximo para exportação: ${MAX_DAYS} dias.` });
    }
    if (!sq) return res.json({ daily_subcat: [], team_subcat: [], team_totais: [], daily_totais: [], de, ate });
    const data = await sq.getExportData(de, ate, req.scope.regionals);
    res.json({ ...data, de, ate, regionals: req.scope.regionals });
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
    const tipo     = req.query.tipo     || 'TODAS';
    const team     = req.query.team     || null;
    if (!(await enforceTeamRegional(req, res, team))) return;
    if (!sq) return res.json({ equipes: [], de, ate });
    const result = await sq.getPerformanceEquipes(de, ate, req.scope.regionals, tipo, team);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/performance/equipes-matriz?de=&ate=&regionals=&tipo=&team=
// Matriz EQUIPE × TIPO com EXEC (concluídas) + REJE (rejeitadas cruas). Alimenta
// a tabela "Notas Atendidas por Tipo" da aba Gráficos. Mesmos filtros/escopo da
// /performance/equipes.
router.get('/performance/equipes-matriz', async (req, res) => {
  try {
    const sq = sbq();
    const today = dateBRT();
    const de       = req.query.de       || today;
    const ate      = req.query.ate      || de;
    const tipo     = req.query.tipo     || 'TODAS';
    const team     = req.query.team     || null;
    if (!(await enforceTeamRegional(req, res, team))) return;
    if (!sq) return res.json({ equipes: [], tipos: [], de, ate });
    const result = await sq.getEquipeTipoMatrix(de, ate, req.scope.regionals, tipo, team);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/teams/deslogadas?regionals=
// Última sessão das equipes do roster que NÃO logaram hoje (modo "Todas" do
// Monitor). Read-only sobre snapshots; não afeta KPI/produção.
router.get('/teams/deslogadas', async (req, res) => {
  try {
    const sq = sbq();
    if (!sq) return res.json({ teams: [], date: dateBRT() });
    const result = await sq.getDeslogadasUltimaSessao(req.scope.regionals);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── APP SETTINGS (preferências do PRÓPRIO usuário) ────────────────────────────
//
// ⚠️ SEGURANÇA (13/08/2026): esta rota gravava/lia QUALQUER chave de app_settings
// só com autenticação — sem checar dono nem role. app_settings é uma tabela
// COMPARTILHADA que guarda estado operacional protegido por rotas dedicadas:
//   metas_diarias        (PUT /metas/diarias valida regional por conta)
//   contador-transgressao (PUT /contador-transgressao é requireAdmin)
//   desloc-threshold      (PUT /deslocamentos/threshold é requireAdmin)
//   snapshot_last_ok / snapshot_error / subcat_error / drift_last_* (só o cron)
// Pela rota genérica, uma conta comum reabria todas essas SEM guarda —
// escalonamento de privilégio (sobrescrever metas de todas as regionais, forjar
// saúde do cron) + IDOR (ler/escrever o monitor-filters de outro usuário).
//
// Correção: a rota só serve a preferência do PRÓPRIO usuário — a chave
// `monitor-filters:<username-do-token>`. O front nunca usou outra. Qualquer chave
// fora desse padrão → 403. Estado operacional continua só nas rotas dedicadas.
// Ver test/settingsScope.test.js.
function _ownSettingsKey(req) {
  const username = req.user && req.user.username;
  return username ? `monitor-filters:${username}` : null;
}
function _assertOwnSettingsKey(req, res) {
  const own = _ownSettingsKey(req);
  if (!own || req.params.key !== own) {
    res.status(403).json({ error: 'forbidden_settings_key', code: 'SETTINGS_SCOPE' });
    return false;
  }
  return true;
}

// GET /api/settings/:key  → só a chave do próprio usuário. { data, updated_at } ou {}
router.get('/settings/:key', async (req, res) => {
  if (!_assertOwnSettingsKey(req, res)) return;
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

// PUT /api/settings/:key  body: { ... } — só a chave do próprio usuário
router.put('/settings/:key', async (req, res) => {
  if (!_assertOwnSettingsKey(req, res)) return;
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

// ── CONTADOR DE DIAS SEM TRANSGRESSÃO ──────────────────────────────────────────
// "Dias sem acidentes" pra transgressões de nota. Registro manual: admin seta
// a data de início (= última transgressão ou marco da campanha) por regional.
// Contador = dias de (data_inicio) até ONTEM (hoje ainda está correndo).
const _CONTADOR_KEY = 'contador-transgressao';

function _ontemBRT() {
  // dateBRT() retorna hoje em BRT 'YYYY-MM-DD'. Ontem = -1 dia.
  const hoje = dateBRT();
  const d = new Date(hoje + 'T12:00:00Z');  // meio-dia UTC evita edge de fuso
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function _diasEntre(inicio, fim) {
  if (!inicio) return null;
  const a = new Date(inicio + 'T12:00:00Z');
  const b = new Date(fim    + 'T12:00:00Z');
  if (isNaN(a) || isNaN(b)) return null;
  const dias = Math.floor((b - a) / 86400000);
  return dias >= 0 ? dias : 0;   // se início no futuro, mostra 0
}

// GET /api/contador-transgressao — público (logado). Retorna dias calculados.
router.get('/contador-transgressao', async (req, res) => {
  try {
    const sq = sbq();
    const ontem = _ontemBRT();
    let cfg = { GUA: null, CAC: null, SJC: null };
    if (sq) {
      const row = await sq.getSetting(_CONTADOR_KEY);
      if (row && row.data) cfg = { ...cfg, ...row.data };
    }
    const out = {};
    for (const reg of ['GUA', 'CAC', 'SJC']) {
      const inicio = cfg[reg] || null;
      out[reg] = { inicio, dias: _diasEntre(inicio, ontem), ate: ontem };
    }
    res.json(out);
  } catch (err) {
    console.error('[contador-transgressao GET]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/contador-transgressao — só admin. Body: { GUA: 'YYYY-MM-DD', CAC: 'YYYY-MM-DD' }
router.put('/contador-transgressao', requireAdmin, async (req, res) => {
  try {
    const sq = sbq();
    if (!sq) return res.status(503).json({ error: 'supabase indisponível' });
    const body = req.body || {};
    const cfg = {};
    for (const reg of ['GUA', 'CAC', 'SJC']) {
      const v = body[reg];
      if (v === null || v === '' || v === undefined) { cfg[reg] = null; continue; }
      if (!_RE_YYYYMMDD.test(String(v))) {
        return res.status(400).json({ error: `data ${reg} inválida (use YYYY-MM-DD)` });
      }
      cfg[reg] = String(v);
    }
    await sq.setSetting(_CONTADOR_KEY, cfg);
    // Retorna já com os dias recalculados
    const ontem = _ontemBRT();
    const out = {};
    for (const reg of ['GUA', 'CAC', 'SJC']) {
      out[reg] = { inicio: cfg[reg], dias: _diasEntre(cfg[reg], ontem), ate: ontem };
    }
    res.json({ ok: true, ...out });
  } catch (err) {
    console.error('[contador-transgressao PUT]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── HISTÓRICO ─────────────────────────────────────────────────────────────────

// GET /api/historico/mes?m=2026-04
router.get('/historico/mes', async (req, res) => {
  try {
    const sq = sbq();
    const ym = _parseYearMonth(req, res); if (!ym) return;
    if (!sq) {
      const empty = {};
      req.scope.regionals.forEach(r => { empty[r] = {}; });
      return res.json({ mes: ym, totais: empty });
    }
    const totais = await sq.getMonthTotals(ym, req.scope.regionals);
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
    if (!_checkJanela(req, res, de, ate)) return;   // P1-41 — data real e ordem
    if (!(await enforceTeamRegional(req, res, req.query.team))) return;
    if (!sq) return res.json({ dias: [] });
    const dias = await sq.getTeamSessionHistory(de, ate, req.query.team || null, req.scope.regionals);
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
    const dias = await sq.getDailyHistory(ym, req.scope.regionals);
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
    if (!sq) {
      const empty = {};
      req.scope.regionals.forEach(r => { empty[r] = {}; });
      return res.json({ mes: ym, totais: empty });
    }
    const totais = await sq.getSubcatMonthTotals(ym, req.scope.regionals);
    res.json({ mes: ym, regionals: req.scope.regionals, totais });
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
    if (!sq) return res.json({ mes: ym, dias: [] });
    const dias = await sq.getSubcatDailyHistory(ym, req.scope.regionals);
    res.json({ mes: ym, regionals: req.scope.regionals, dias });
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
    const tipo     = req.query.tipo     || null;
    const subCode  = req.query.subCode  || null;
    if (!sq) return res.json({ mes: ym, ranking: [] });
    const ranking = await sq.getSubcatTeamRanking(ym, req.scope.regionals, tipo, subCode);
    res.json({ mes: ym, regionals: req.scope.regionals, tipo, subCode, ranking });
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
    const resultado = await sq.getMetasCalculadas(ym, req.scope.regionals);
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
    if (!sq) return res.json({ mes: ym, ranking: [] });
    const ranking = await sq.getTeamRanking(ym, req.scope.regionals);
    res.json({ mes: ym, regionals: req.scope.regionals, ranking });
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
    if (!(await enforceTeamRegional(req, res, team))) return;
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
const { processarNota, classificarSubCategoria, fixCachedPayloadTz } = require('../services/notaProcessor');

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

  // Validação de sectorId. DSSJ adicionado 08/06/2026 (regional SJC / EDP SP).
  if (!['DESG', 'DEPT', 'DESC', 'DSSJ'].includes(sectorId)) {
    return res.status(400).json({ error: `sectorId inválido: ${sectorId}` });
  }

  // ── ESCOPO DE REGIONAL (P1-38, 25/08/2026) ────────────────────────────────
  // Esta rota devolve a nota COMPLETA (endereço, cliente, colaboradores,
  // checkpoints, e fotos com ?fotos=1). Até aqui o `sectorId` era conferido só
  // contra a lista de setores EXISTENTES — nunca contra o escopo do usuário.
  // Um user de GUA passando ?sectorId=DSSJ lia qualquer nota de SJC; bastava o
  // número da OS, que circula em auditoria da EDP. Mesma classe do P0-4/P1-12.
  // Nota: o default 'DESG' também passava aqui, então quem não tem GUA furava o
  // escopo sem sequer informar o parâmetro.
  if (!_setorNoEscopo(sectorId, req.scope.regionals)) {
    return res.status(403).json({
      error: `Acesso negado: o setor ${sectorId} não pertence à(s) regional(is) do seu usuário `
           + `(${req.scope.regionals.join(', ')}).`,
      code: 'SECTOR_REGIONAL_MISMATCH',
    });
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
        // P1-38: era getTeamsCurrent({}) — `{}` cai no ramo "sem filtro" de
        // db/queries.js e varria as equipes de TODAS as regionais pra resolver
        // o código. O escopo do setor já foi validado acima; aqui fecha o eixo
        // da equipe, pra um código de outra regional não virar UUID válido.
        const all = await sq.getTeamsCurrent({ regionals: req.scope.regionals });
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

  // Segundo fallback (22/08/2026): a nota pode simplesmente não estar em
  // teams_current — nota antiga, de equipe que não é do setor pedido, ou
  // justamente a que a EDP questiona em auditoria citando o número. O endpoint
  // search/SearchNotesByNumber da WPA resolve número → UUID. 1 request, e só
  // depois de o caminho barato (banco) ter falhado.
  if (!isUuid && !resolvedFromCodigo && _isNoteNumber(noteId)) {
    try {
      const achada = await searchNoteByNumber(noteId);
      if (achada?.id) {
        // P1-38: este fallback pergunta à WPA e ela responde sobre QUALQUER
        // equipe, inclusive de regional fora do escopo. A busca é por número de
        // OS — exatamente o dado que circula em auditoria. Se a equipe dona não
        // é do escopo, tratamos como não encontrada: 404, não 403, pra não
        // confirmar a existência da nota a quem não pode vê-la.
        const regNota = achada.equipe ? await _resolveTeamRegional(achada.equipe) : null;
        if (regNota && req.scope.regionals.includes(regNota)) {
          noteId = achada.id;
          resolvedFromCodigo = true;
          console.log(`[wpa/nota] resolvido via SearchNotesByNumber: ${noteIdOriginal} → ${noteId}`
            + ` (equipe ${achada.equipe || '?'})`);
        } else {
          console.warn(`[wpa/nota] nota "${noteIdOriginal}" pertence a ${achada.equipe || '?'}`
            + ` (regional ${regNota || 'desconhecida'}) — fora do escopo ${req.scope.regionals.join(',')}`);
          return res.status(404).json({ error: 'Nota não encontrada.' });
        }
      } else {
        console.warn(`[wpa/nota] SearchNotesByNumber não achou a nota "${noteIdOriginal}"`);
      }
    } catch (e) {
      console.warn('[wpa/nota] SearchNotesByNumber falhou:', e.message);
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
          // P1-38: o cache é indexado por UUID puro. Sem esta checagem, um UUID
          // de outra regional era servido daqui SEM sequer tocar a WPA — o
          // `?sectorId=` legítimo passava no guard de cima e o cache entregava a
          // nota de outro setor. `sector_id` é gravado pelo próprio
          // setNoteDetailCache, então é a procedência real do payload.
          // Cache antigo sem sector_id (gravado antes desta coluna existir) não
          // é servido às cegas: cai no fetch ao vivo, que já é escopado.
          if (cached?.payload && !_setorNoEscopo(cached.sector_id, req.scope.regionals)) {
            console.warn(`[wpa/nota] cache de ${noteId} é do setor ${cached.sector_id || '?'}`
              + ` — fora do escopo ${req.scope.regionals.join(',')}; ignorando o cache`);
          } else if (cached?.payload) {
            console.log(`[wpa/nota] cache hit noteId=${noteId} fetched=${cached.fetched_at}`);
            // Corrige timestamps gravados antes do fix de TZ (08/06/2026) — caches
            // antigos têm ISO sem 'Z' nos campos de data, o front interpreta como
            // local time e mostra horários 3h adiantados.
            const payloadFixed = fixCachedPayloadTz({ ...cached.payload });
            return res.json({ ...payloadFixed, _source: 'cache', _cachedAt: cached.fetched_at });
          }
        }
      } catch (e) { console.warn('[wpa/nota] cache lookup falhou:', e.message); }
    }

    // ── 2) Cache miss → busca ao vivo na WPA ─────────────────────────────
    // ⚠️ 26/08/2026: esta chamada NÃO checava MODE, então `DATA_MODE=mock` não
    // impedia nada — a rota ia à EDP de verdade. Descoberto rodando os testes do
    // P1-38 NA VM: apareceram `getNoteDetail OK ... sector=DSSJ` com token real
    // no meio da suíte. Na máquina de dev passava batido (sem DATABASE_URL não
    // há token em cache). Pior: com token vencido, o wpaFetch dispararia
    // /signin e a SUÍTE DE TESTES queimaria uma das 5 tentativas de login da
    // conta na EDP — o mesmo recurso que o P1-20/P1-29 protegem.
    // Modo mock não toca a rede. Ponto.
    if (MODE === 'mock') {
      return res.status(404).json({
        error: 'Detalhe de nota não disponível em DATA_MODE=mock (a rota não chama a WPA aqui).',
        debug: { noteIdOriginal, noteIdUsed: noteId, sectorId, mode: MODE },
      });
    }
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
      const fb = classificarSubCategoria(nota.Type, nota.Code, nota.Comments, nota.Activities, groupDesc, nota.Address);
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
    // Erro inesperado no nosso processamento (não vindo do WPA).
    // Stack completo vai pro log do servidor; cliente recebe só msg genérica
    // (P1-10: não vazar estrutura interna — nomes de arquivo/linha — ao browser).
    console.error(`[NOTA-DETAIL] ${noteId}:`, err.stack || err.message);
    res.status(500).json({ error: 'Erro ao processar a nota.' });
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

// Valida que um path de proxy WPA é interno e seguro (P1-4: SSRF).
// wpaFetch concatena `${WPA_API}${path}` — sem validação, `?path=.attacker.com/`
// faz o destino virar host controlado pelo atacante, COM o Bearer token da EDP
// anexado (credencial de terceiro). Exige começar com '/api/' e proíbe
// caracteres que permitam trocar de host (`.` de subdomínio via '//', '@', '\').
function _wpaPathSeguro(p) {
  if (typeof p !== 'string' || !p.startsWith('/api/')) return false;
  // Rejeita tentativas de sair do host: '//' (protocol-relative), '@' (userinfo),
  // '\' (bypass), e espaço/controle.
  if (/[\\@\s]|\/\//.test(p)) return false;
  return true;
}

router.get('/wpa/probe', async (req, res) => {
  const path = req.query.path || '/api/sessions/current?sectorId=DESG';
  if (!_wpaPathSeguro(path)) {
    return res.status(400).json({ error: 'path inválido (deve começar com /api/ e não conter host)' });
  }
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
    if (!(await enforceTeamRegional(req, res, req.query.team))) return;
    if (!sq) return res.json({ equipes: [], tipos: [] });
    const resultado = await sq.getTeamProducao({ ...req.query, regionals: req.scope.regionals });
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN ─────────────────────────────────────────────────────────────────────

// GET /api/admin/health — saúde operacional consolidada do sistema
//
// Responde em < 2s e agrega:
//  - whitelist: tamanho por regional
//  - teams_logged_today: equipes oficiais que logaram hoje (por regional)
//  - teams_missing_today: equipes oficiais que NÃO logaram (com tipo/placa)
//  - last_snapshot: idade do snapshot mais recente em teams_current
//  - subcat_error: último erro de classificação registrado (ou null)
//  - token: status do JWT WPA
//  - metas_configured: se metas estão preenchidas para GUA e CAC
router.get('/admin/health', async (_req, res) => {
  try {
    const sq = sbq();
    const { getOficiais, isOficial, isFromSupabase } = require('../services/equipesOficiais');
    const { dateBRT } = require('../services/timeUtil');

    const today    = dateBRT();
    const oficGua  = getOficiais('GUA');
    const oficCac  = getOficiais('CAC');
    const oficSjc  = getOficiais('SJC');

    // Estado base — sempre respondido mesmo se Supabase off
    const out = {
      ok:    true,
      ts:    new Date().toISOString(),
      today,
      whitelist: {
        total:  oficGua.length + oficCac.length + oficSjc.length,
        gua:    oficGua.length,
        cac:    oficCac.length,
        sjc:    oficSjc.length,
        source: isFromSupabase() ? 'supabase' : 'fallback',
      },
      teams_logged_today:  null,
      teams_missing_today: null,
      last_snapshot:       null,
      subcat_error:        null,
      snapshot_last_ok:    null,
      snapshot_error:      null,
      snapshot_stale_min:  null,
      token:               null,
      metas_configured:    null,
    };

    if (!sq) {
      out.ok = false;
      out.error = 'Supabase indisponível';
      return res.json(out);
    }

    // Token WPA (best-effort — não quebra se falhar)
    try {
      out.token = getTokenStatus();
    } catch (e) { out.token = { error: e.message }; }

    // teams_current → quem está logado agora (whitelist apenas)
    try {
      const teams = await sq.getTeamsCurrent({});
      const loggedSiglas = new Set(
        teams
          .map(t => (t.sigla || t.teamName || '').toUpperCase().trim())
          .filter(s => s && isOficial(s))
      );

      const byRegional = { GUA: 0, CAC: 0, SJC: 0 };
      for (const t of teams) {
        const s = (t.sigla || t.teamName || '').toUpperCase().trim();
        if (!isOficial(s)) continue;
        if (t.regional && byRegional[t.regional] !== undefined) byRegional[t.regional]++;
      }

      // Diff: oficiais ausentes hoje, CRUZADO COM A ESCALA (P1-26, 22/08/2026).
      //
      // Antes daqui este bloco iterava a whitelist inteira e marcava como
      // faltante quem não estava em teams_current — sem olhar escala. Equipe de
      // folga, férias ou afastamento aparecia como "não logou" TODO DIA, e um
      // alerta que grita todo dia é um alerta que ninguém lê.
      //
      // Direção do erro, deliberada (ver services/escalaDia.js): só sai da lista
      // quem tem evidência POSITIVA de folga na escala. Sem escala carregada, ou
      // sem linha para a equipe no dia, ela CONTINUA sendo reportada — suprimir
      // por falta de dado esconderia ausência real.
      const { classificarDia, getEscalaDoDia } = require('../services/escalaDia');

      let escalaHoje = null;
      try {
        escalaHoje = await getEscalaDoDia(dateBRT());
      } catch (e) {
        console.warn('[admin/health] escala do dia indisponível:', e.message);
      }

      const missing  = [];
      const emFolga  = [];

      const avaliar = (e, regional) => {
        if (loggedSiglas.has(e.sigla.toUpperCase())) return;
        const base = { sigla: e.sigla, regional, tipo: e.tipo, placa: e.placa };

        // Sem escala legível: comportamento antigo, e o motivo fica explícito
        // pra ninguém achar que o cruzamento rodou.
        if (!escalaHoje) {
          missing.push({ ...base, escala: 'indisponivel' });
          return;
        }

        const cls = classificarDia(escalaHoje.get(e.sigla.toUpperCase()));
        if (cls.escalada) {
          missing.push({ ...base, escala: cls.motivo, codigosEscala: cls.codigos });
        } else {
          emFolga.push({ ...base, codigosEscala: cls.codigos });
        }
      };

      for (const e of oficGua) avaliar(e, 'GUA');
      for (const e of oficCac) avaliar(e, 'CAC');

      out.teams_logged_today  = { total: loggedSiglas.size, byRegional };
      // `lista` mantém sigla/regional/tipo/placa — o front (public/index.html)
      // monta a tabela com esses 4 campos. Os campos novos são aditivos.
      out.teams_missing_today = {
        total: missing.length,
        lista: missing,
        escala_fonte: escalaHoje ? 'escala_dia' : 'indisponivel',
      };
      // Quem não logou PORQUE está de folga. Fica visível de propósito: some do
      // alerta, não do relatório.
      out.teams_em_folga_today = { total: emFolga.length, lista: emFolga };

      // Idade do último snapshot — pega o updated_at mais recente
      if (teams.length > 0) {
        // teams_current.updated_at vem nos rows mas não no .data — refazemos query rápida
        const { data: ages } = await require('../services/dbClient').getClient()
          .from('teams_current')
          .select('updated_at')
          .order('updated_at', { ascending: false })
          .limit(1);
        if (ages && ages[0]) {
          const latest = new Date(ages[0].updated_at);
          out.last_snapshot = {
            ts:        latest.toISOString(),
            ageMinutes: Math.round((Date.now() - latest.getTime()) / 60000),
          };
        }
      }
    } catch (e) {
      out.teams_logged_today = { error: e.message };
    }

    // Último erro de classificação (auto-recovery)
    try {
      const setting = await sq.getSetting('subcat_error');
      if (setting && setting.data && setting.data.message) {
        out.subcat_error = setting.data;  // { message, ts }
      } else {
        out.subcat_error = null;          // sem erro pendente
      }
    } catch (e) { out.subcat_error = { error: e.message }; }

    // Saúde do ciclo de snapshot (P1-3): último OK + último erro + minutos
    // desde o último sucesso. Watchdog (P1-1) usa snapshot_stale_min pra alertar.
    try {
      const okS  = await sq.getSetting('snapshot_last_ok');
      const errS = await sq.getSetting('snapshot_error');
      const lastOk = okS && okS.data && okS.data.ts ? okS.data.ts : null;
      out.snapshot_last_ok = lastOk ? okS.data : null;
      out.snapshot_error   = (errS && errS.data && errS.data.message) ? errS.data : null;
      out.snapshot_stale_min = lastOk
        ? Math.round((Date.now() - new Date(lastOk).getTime()) / 60000)
        : null;
    } catch (e) { out.snapshot_last_ok = { error: e.message }; }

    // Metas configuradas
    try {
      const metas = await sq.getMetas();
      out.metas_configured = {
        gua: metas.GUA && Object.keys(metas.GUA).length > 0,
        cac: metas.CAC && Object.keys(metas.CAC).length > 0,
      };
    } catch (e) { out.metas_configured = { error: e.message }; }

    res.json(out);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── EQUIPES OFICIAIS — CRUD da whitelist editável ────────────────────────────
//
// A whitelist está em equipes_oficiais (Supabase, migration 006). O serviço
// services/equipesOficiais.js mantém cache em memória de 60s. Após cada
// mutação aqui, chamamos forceRefresh() para garantir que o próximo lookup
// reflita a mudança imediatamente.

const _RE_SIGLA  = /^[A-Z0-9]{4,12}$/i;
const _RE_TIPO   = /^[A-Z0-9 ÁÉÍÓÚÃÕÇ-]{1,30}$/i;  // tipo é livre (operacional)
const _RE_PLACA  = /^[A-Z0-9 -]{4,16}$/i;
const _RE_REG    = /^(GUA|CAC|SJC)$/;                // SJC adicionado 08/06/2026
const _RE_SETOR  = /^(DESG|DEPT|DESC|DSSJ)$/;        // DSSJ = CSD São José

function _validateEquipe(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return ['body inválido'];
  if (!_RE_SIGLA.test(body.sigla || ''))      errors.push('sigla inválida (4-12 alfanuméricos)');
  if (!_RE_SETOR.test(body.setor || ''))      errors.push('setor deve ser DESG, DEPT, DESC ou DSSJ');
  if (!_RE_REG.test(body.regional || ''))     errors.push('regional deve ser GUA, CAC ou SJC');
  if (!_RE_TIPO.test(body.tipo || ''))        errors.push('tipo inválido (alfanumérico, máx 30)');
  // placa é opcional agora
  if (body.placa && !_RE_PLACA.test(body.placa)) errors.push('placa inválida');
  // Escala opcional: aceita "HH:MM" ou "HH:MM:SS"
  const _re_time = /^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
  if (body.escala_inicio && !_re_time.test(String(body.escala_inicio))) errors.push('escala_inicio inválido (use HH:MM)');
  if (body.escala_fim    && !_re_time.test(String(body.escala_fim)))    errors.push('escala_fim inválido (use HH:MM)');
  return errors;
}

// GET /api/admin/equipes — lista todas (incluindo inativas)
router.get('/admin/equipes', async (_req, res) => {
  try {
    const sq = sbq();
    if (!sq) return res.status(503).json({ error: 'Supabase indisponível' });
    const sb = require('../services/dbClient').getClient();
    const { data, error } = await sb
      .from('equipes_oficiais')
      .select('sigla, regional, tipo, placa, ativo, escala_inicio, escala_fim, created_at, updated_at')
      .order('regional')
      .order('sigla');
    if (error) throw error;
    // Normaliza escala pra string "HH:MM" — pg retorna TIME como "HH:MM:SS",
    // mas a UI espera "HH:MM" (input type="time"). Conversão consistente.
    (data || []).forEach(e => {
      if (e.escala_inicio) e.escala_inicio = String(e.escala_inicio).slice(0, 5);
      if (e.escala_fim)    e.escala_fim    = String(e.escala_fim).slice(0, 5);
    });
    res.json({ equipes: data || [], count: (data || []).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/equipes — cria nova equipe oficial
router.post('/admin/equipes', async (req, res) => {
  const errors = _validateEquipe(req.body);
  if (errors.length > 0) return res.status(400).json({ error: errors.join('; ') });

  try {
    const sb = require('../services/dbClient').getClient();
    const sigla = req.body.sigla.toUpperCase().trim();
    const { error } = await sb
      .from('equipes_oficiais')
      .insert({
        sigla,
        setor:    req.body.setor,
        regional: req.body.regional,
        tipo:     req.body.tipo.toUpperCase(),
        placa:    req.body.placa ? req.body.placa.toUpperCase().trim() : null,
        escala_inicio: req.body.escala_inicio || null,
        escala_fim:    req.body.escala_fim    || null,
        ativo:    true,
      });
    if (error) {
      if (/duplicate|unique/i.test(error.message)) {
        return res.status(409).json({ error: `Sigla "${sigla}" já existe.` });
      }
      throw error;
    }

    // Invalida cache do whitelist em memória
    const { forceRefresh } = require('../services/equipesOficiais');
    await forceRefresh();

    res.status(201).json({ ok: true, sigla });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/equipes/:sigla — atualiza tipo/placa/regional/ativo
router.put('/admin/equipes/:sigla', async (req, res) => {
  const sigla = (req.params.sigla || '').toUpperCase().trim();
  if (!_RE_SIGLA.test(sigla)) return res.status(400).json({ error: 'sigla inválida' });

  // Validação parcial — só os campos enviados
  const upd = {};
  const body = req.body || {};
  if (body.setor !== undefined) {
    if (!_RE_SETOR.test(body.setor)) return res.status(400).json({ error: 'setor inválido' });
    upd.setor = body.setor;
  }
  if (body.regional !== undefined) {
    if (!_RE_REG.test(body.regional)) return res.status(400).json({ error: 'regional inválida' });
    upd.regional = body.regional;
  }
  if (body.tipo !== undefined) {
    if (!_RE_TIPO.test(body.tipo)) return res.status(400).json({ error: 'tipo inválido' });
    upd.tipo = body.tipo.toUpperCase();
  }
  if (body.placa !== undefined) {
    if (body.placa && !_RE_PLACA.test(body.placa)) return res.status(400).json({ error: 'placa inválida' });
    upd.placa = body.placa ? body.placa.toUpperCase().trim() : null;
  }
  if (body.ativo !== undefined) {
    if (typeof body.ativo !== 'boolean') return res.status(400).json({ error: 'ativo deve ser boolean' });
    upd.ativo = body.ativo;
  }
  // escala_inicio / escala_fim: aceitam "HH:MM" ou "HH:MM:SS" (TIME without TZ
  // no Postgres). null/'' limpa a escala. Tudo que vier é validado antes de
  // gravar — qualquer string fora do formato é rejeitada.
  const _RE_TIME = /^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
  if (body.escala_inicio !== undefined) {
    if (body.escala_inicio === null || body.escala_inicio === '') {
      upd.escala_inicio = null;
    } else if (_RE_TIME.test(String(body.escala_inicio))) {
      upd.escala_inicio = String(body.escala_inicio);
    } else {
      return res.status(400).json({ error: 'escala_inicio inválido (use HH:MM)' });
    }
  }
  if (body.escala_fim !== undefined) {
    if (body.escala_fim === null || body.escala_fim === '') {
      upd.escala_fim = null;
    } else if (_RE_TIME.test(String(body.escala_fim))) {
      upd.escala_fim = String(body.escala_fim);
    } else {
      return res.status(400).json({ error: 'escala_fim inválido (use HH:MM)' });
    }
  }
  if (Object.keys(upd).length === 0) return res.status(400).json({ error: 'nenhum campo para atualizar' });
  upd.updated_at = new Date().toISOString();

  try {
    const sb = require('../services/dbClient').getClient();
    const { data, error } = await sb
      .from('equipes_oficiais')
      .update(upd)
      .eq('sigla', sigla)
      .select();
    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: `Equipe "${sigla}" não encontrada.` });

    const { forceRefresh } = require('../services/equipesOficiais');
    await forceRefresh();

    res.json({ ok: true, equipe: data[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/equipes/:sigla — soft delete (ativo=false)
// Use ?hard=1 para deletar permanentemente (cuidado: perde histórico).
router.delete('/admin/equipes/:sigla', async (req, res) => {
  const sigla = (req.params.sigla || '').toUpperCase().trim();
  if (!_RE_SIGLA.test(sigla)) return res.status(400).json({ error: 'sigla inválida' });

  const hard = req.query.hard === '1';
  try {
    const sb = require('../services/dbClient').getClient();
    let resp;
    if (hard) {
      resp = await sb.from('equipes_oficiais').delete().eq('sigla', sigla).select();
    } else {
      resp = await sb
        .from('equipes_oficiais')
        .update({ ativo: false, updated_at: new Date().toISOString() })
        .eq('sigla', sigla)
        .select();
    }
    if (resp.error) throw resp.error;
    if (!resp.data || resp.data.length === 0) {
      return res.status(404).json({ error: `Equipe "${sigla}" não encontrada.` });
    }

    const { forceRefresh } = require('../services/equipesOficiais');
    await forceRefresh();

    res.json({ ok: true, sigla, hard });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/drift?date=YYYY-MM-DD — verifica drift sem reparar
// Compara snapshot_count vs table_count para o dia. has_drift=true se diff > limiar.
router.get('/admin/drift', async (req, res) => {
  const date = req.query.date || dateBRT();
  if (!_RE_YYYYMMDD.test(date)) {
    return res.status(400).json({ error: 'date inválido. Use YYYY-MM-DD' });
  }
  try {
    const { detectDrift } = require('../services/dataWriter');
    const report = await detectDrift(date);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/drift/repair?date=YYYY-MM-DD — re-consolida o dia (sobrescreve agregados)
router.post('/admin/drift/repair', async (req, res) => {
  const date = req.query.date || dateBRT();
  if (!_RE_YYYYMMDD.test(date)) {
    return res.status(400).json({ error: 'date inválido. Use YYYY-MM-DD' });
  }
  try {
    const { detectDrift, consolidateDay, shouldAutoRepair } = require('../services/dataWriter');
    const before = await detectDrift(date);

    // Esta rota ficou 6 dias com DOIS defeitos que o fix do P0-6 (25/07/2026) já
    // havia corrigido no cron — corrigidos aqui em 31/07:
    //   1) rodava consolidateDay(date), a régua de D, que subconta e APAGA
    //      produção; quem grava o dia é o passe de D+1 (before.repair_date);
    //   2) reparava mesmo com drift NEGATIVO (tabela maior que a régua), o que
    //      destrói o acúmulo legítimo de passes posteriores.
    // Ver shouldAutoRepair em services/dataWriter.js.
    const decisao = shouldAutoRepair(before);
    const forcar = req.query.force === '1';
    if (!decisao.repair && !forcar) {
      return res.json({
        ok: false, date, before, skipped: true, motivo: decisao.reason,
        aviso: decisao.reason === 'tabela_acima_da_regua'
          ? 'A tabela tem MAIS que a régua enxerga — re-consolidar APAGARIA produção. '
            + 'Investigue com scripts/diag-drift-team.js antes. Use ?force=1 se tiver certeza.'
          : 'Sem drift acima do limiar — nada a reparar. Use ?force=1 pra forçar.',
      });
    }

    await consolidateDay(before.repair_date);
    const after = await detectDrift(date);
    res.json({ ok: true, date, repair_date: before.repair_date, forcado: forcar, before, after });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/subcat-trace?date=YYYY-MM-DD&tipo=SF
//
// Rastreia a cadeia completa de classificação de subcategoria para um dia.
// Mostra exatamente onde cada nota MD/SF/DD está (classificada, OUTROS por
// fallback, ou ausente). Útil quando algum sub_code aparece zerado.
//
// Resposta:
//   { date, tipo, totals: {snapshot, classified, unclassified},
//     by_sub_code: { L0: N, L1: N, OUTROS: N, ... },
//     samples: { unclassified: [{noteId, team, ...}], outros: [...] } }
router.get('/admin/subcat-trace', async (req, res) => {
  const date = req.query.date || dateBRT();
  const tipo = (req.query.tipo || 'SF').toUpperCase();
  if (!_RE_YYYYMMDD.test(date)) {
    return res.status(400).json({ error: 'date inválido. Use YYYY-MM-DD' });
  }
  if (!['MD', 'SF', 'DD'].includes(tipo)) {
    return res.status(400).json({ error: 'tipo deve ser MD, SF ou DD' });
  }

  try {
    const sq = sbq();
    if (!sq) return res.status(503).json({ error: 'Supabase indisponível' });
    const sb = require('../services/dbClient').getClient();
    const { isOficial } = require('../services/equipesOficiais');

    // Pega snapshot mais recente por (date, team) que tenha sessionDate=date
    const dPlus1 = new Date(date + 'T12:00:00Z');
    dPlus1.setUTCDate(dPlus1.getUTCDate() + 1);
    const { data: snaps, error } = await sb
      .from('snapshots')
      .select('team_name, regional, sector_id, captured_at, data')
      .in('date', [date, dPlus1.toISOString().slice(0, 10)])
      .order('captured_at', { ascending: false });
    if (error) throw error;

    // Coleta UUIDs do tipo desejado, com snapshot mais recente por (team, sessionBegin)
    const seenSession = new Set();
    const noteRecs    = []; // [{noteId, team, regional}]
    for (const s of (snaps || [])) {
      const t = s.data;
      if (!t || !t.sessionBegin) continue;
      // sessionDate igual ao date alvo
      const sessDate = String(t.sessionBegin).slice(0, 10);
      if (sessDate !== date) continue;
      const sk = `${s.team_name}|${t.sessionBegin}`;
      if (seenSession.has(sk)) continue;
      seenSession.add(sk);

      // Filtra pela whitelist
      if (!isOficial(s.team_name)) continue;

      const realizadas = [...(t.notasExecutadas || []), ...(t.notasConcluidas || [])];
      for (const n of realizadas) {
        if (!n.id) continue;
        const ntipo = (n.tipoCode || n.tipo_code || '').toUpperCase();
        if (ntipo !== tipo) continue;
        noteRecs.push({
          noteId:   n.id,
          codigo:   n.codigo || n.code || null,
          team:     s.team_name,
          regional: s.regional,
        });
      }
    }

    // Dedupe por noteId (mesma OS pode estar em multiple snapshots ou em concluídas+executadas)
    const uniqByNote = new Map();
    for (const r of noteRecs) {
      if (!uniqByNote.has(r.noteId)) uniqByNote.set(r.noteId, r);
    }
    const unique = [...uniqByNote.values()];

    // Busca classificação atual em note_subcategorias
    const ids = unique.map(r => r.noteId);
    const subcatMap = {};
    const CHUNK = 100;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const { data: subs, error: e2 } = await sb
        .from('note_subcategorias')
        .select('note_id, sub_code, code, code_text, quantidade')
        .in('note_id', chunk);
      if (e2) throw e2;
      (subs || []).forEach(s => { subcatMap[s.note_id] = s; });
    }

    // Cruza dados: status por nota
    const by_sub_code = {};
    const samples = { unclassified: [], outros: [] };
    let classified = 0, unclassified = 0;
    for (const r of unique) {
      const sc = subcatMap[r.noteId];
      if (!sc) {
        unclassified++;
        if (samples.unclassified.length < 20) {
          samples.unclassified.push({ noteId: r.noteId, codigo: r.codigo, team: r.team });
        }
        // Notas sem classificação caem em OUTROS no upsertSubcatTotals
        by_sub_code['(unclassified→OUTROS)'] = (by_sub_code['(unclassified→OUTROS)'] || 0) + 1;
      } else {
        classified++;
        by_sub_code[sc.sub_code] = (by_sub_code[sc.sub_code] || 0) + 1;
        if (sc.sub_code === 'OUTROS' && samples.outros.length < 20) {
          samples.outros.push({
            noteId: r.noteId, codigo: r.codigo, team: r.team,
            wpa_code: sc.code, wpa_code_text: sc.code_text,
          });
        }
      }
    }

    res.json({
      date,
      tipo,
      totals: {
        snapshot:     unique.length,
        classified,
        unclassified,
      },
      by_sub_code,
      samples,
      hint: unclassified > 0
        ? `${unclassified} nota(s) ainda não foram classificadas — caem em OUTROS no agregado. Use POST /admin/subcat-reclassify para reprocessar.`
        : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/subcat-reclassify?date=YYYY-MM-DD&tipo=SF
//
// Reclassifica TODAS as notas MD/SF/DD do período (ou só do tipo especificado),
// purgando de note_subcategorias antes — força o classifier a ler de novo do
// WPA. Em seguida, re-agrega team_daily_subcat_totals via consolidateDay.
//
// ASYNC: responde 202 imediato com job_id e processa em background. Cliente
// poll em GET /admin/subcat-reclassify/status. Antes era síncrono e o worker
// pm2 era morto por OOM (300M) durante reclassifies grandes (notas DD baixam
// /details/optimized de até 1.6MB cada), gerando HTTP 000 no cliente.
//
// Estado é mantido em memória (single job global) E espelhado em app_settings
// via reclassifyJobStore (P2-10): o status sobrevive a restart do PM2/OOM e o
// boot marca job 'running' órfão como 'interrupted'. A memória segue sendo a
// fonte viva no processo; o banco é a cópia durável. Se já houver um job em
// execução, retorna 409.
const reclassifyJobStore = require('../services/reclassifyJobStore');
let _reclassifyJob = null; // { id, status, date, tipo, started_at, finished_at, processed, total, deleted, classified_ok, classified_failed, saved, error, last_batch_at }

async function _runReclassifyBackground(jobState) {
  try {
    const sb = require('../services/dbClient').getClient();
    const { classificarBatch } = require('../services/classifierService');
    const { upsertSubcategorias } = require('../db/subcategoriasQueries');
    const { consolidateDay } = require('../services/dataWriter');

    const date = jobState.date;
    const tipoFilter = jobState.tipo === 'ALL' ? null : jobState.tipo;

    // 1. Coleta UUIDs MD/SF/DD do dia (de snapshots)
    const dPlus1 = new Date(date + 'T12:00:00Z');
    dPlus1.setUTCDate(dPlus1.getUTCDate() + 1);
    const { data: snaps, error } = await sb
      .from('snapshots')
      .select('team_name, sector_id, data')
      .in('date', [date, dPlus1.toISOString().slice(0, 10)]);
    if (error) throw error;

    const SUBCAT_TIPOS = tipoFilter ? new Set([tipoFilter]) : new Set(['MD', 'SF', 'DD']);
    const seen = new Set();
    const jobs = [];
    for (const s of (snaps || [])) {
      const t = s.data;
      if (!t || !t.sessionBegin) continue;
      if (String(t.sessionBegin).slice(0, 10) !== date) continue;
      const realizadas = [...(t.notasExecutadas || []), ...(t.notasConcluidas || [])];
      for (const n of realizadas) {
        if (!n.id) continue;
        const ntipo = (n.tipoCode || n.tipo_code || '').toUpperCase();
        if (!SUBCAT_TIPOS.has(ntipo)) continue;
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        jobs.push({ noteId: n.id, tipo: ntipo, sectorId: s.sector_id });
      }
    }

    jobState.total = jobs.length;
    await reclassifyJobStore.saveJob(jobState); // persiste total cedo (status já reflete o tamanho)
    if (jobs.length === 0) {
      jobState.status = 'done';
      jobState.finished_at = new Date().toISOString();
      await reclassifyJobStore.saveJob(jobState);
      return;
    }

    // 2. Apaga classificações existentes pra forçar reprocessamento
    const ids = jobs.map(j => j.noteId);
    const CHUNK = 100;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { error: e2 } = await sb.from('note_subcategorias').delete().in('note_id', ids.slice(i, i + CHUNK));
      if (e2) throw e2;
      jobState.deleted += Math.min(CHUNK, ids.length - i);
    }

    // 3. Reclassifica em lotes pra atualizar progresso e ceder GC.
    //    classificarBatch já serializa MD/SF + DD e dá setImmediate entre chunks.
    const LOTE = 100;
    const classifsAll = [];
    for (let i = 0; i < jobs.length; i += LOTE) {
      const slice = jobs.slice(i, i + LOTE);
      const classifs = await classificarBatch(slice, 6);
      if (classifs && classifs.length > 0) {
        const saved = await upsertSubcategorias(classifs);
        jobState.saved += saved;
        jobState.classified_ok += classifs.length;
      }
      jobState.classified_failed += slice.length - (classifs ? classifs.length : 0);
      jobState.processed += slice.length;
      classifsAll.push(...classifs);
      jobState.last_batch_at = new Date().toISOString();
      await reclassifyJobStore.saveJob(jobState); // progresso durável a cada lote
    }

    // 4. Re-consolida o dia
    await consolidateDay(date);

    jobState.status = 'done';
    jobState.finished_at = new Date().toISOString();
    await reclassifyJobStore.saveJob(jobState);
  } catch (err) {
    jobState.status = 'error';
    jobState.error = err.message;
    jobState.finished_at = new Date().toISOString();
    await reclassifyJobStore.saveJob(jobState);
  }
}

router.post('/admin/subcat-reclassify', async (req, res) => {
  const date = req.query.date || dateBRT();
  const tipoFilter = req.query.tipo ? req.query.tipo.toUpperCase() : null;
  if (!_RE_YYYYMMDD.test(date)) {
    return res.status(400).json({ error: 'date inválido. Use YYYY-MM-DD' });
  }
  if (tipoFilter && !['MD', 'SF', 'DD'].includes(tipoFilter)) {
    return res.status(400).json({ error: 'tipo deve ser MD, SF ou DD' });
  }

  const sq = sbq();
  if (!sq) return res.status(503).json({ error: 'Supabase indisponível' });

  if (_reclassifyJob && _reclassifyJob.status === 'running') {
    return res.status(409).json({
      error: 'já existe um reclassify em execução',
      job: _reclassifyJob,
    });
  }

  _reclassifyJob = {
    id: `reclass-${Date.now()}`,
    status: 'running',
    date,
    tipo: tipoFilter || 'ALL',
    started_at: new Date().toISOString(),
    finished_at: null,
    processed: 0,
    total: 0,
    deleted: 0,
    classified_ok: 0,
    classified_failed: 0,
    saved: 0,
    error: null,
    last_batch_at: null,
  };

  // Persiste ANTES de disparar → status já sobrevive a restart mesmo que o
  // processo caia no 1º lote.
  await reclassifyJobStore.saveJob(_reclassifyJob);

  // Dispara em background — não await
  _runReclassifyBackground(_reclassifyJob);

  res.status(202).json({ ok: true, job: _reclassifyJob });
});

// GET /admin/subcat-reclassify/status — lê o estado persistido (sobrevive a
// restart do PM2). Fallback pra memória se o banco estiver indisponível.
router.get('/admin/subcat-reclassify/status', async (req, res) => {
  try {
    const job = await reclassifyJobStore.loadJob();
    res.json({ job: job || _reclassifyJob || null });
  } catch (e) {
    res.json({ job: _reclassifyJob || null });
  }
});

// GET /api/admin/note-trace?numero=035009000490 OU ?id=UUID
//
// Rastreia uma OS específica em todo o pipeline:
//   - teams_current (em campo agora?)
//   - snapshots (em quais dias foi vista? por qual equipe?)
//   - note_subcategorias (classificada com qual sub_code?)
//   - team_daily_subcat_totals (já entrou no agregado?)
//
// Útil quando WPA mostra uma OS mas nosso sistema não a contabiliza.
router.get('/admin/note-trace', async (req, res) => {
  const numero = (req.query.numero || '').trim();
  const id     = (req.query.id || '').trim();
  if (!numero && !id) {
    return res.status(400).json({ error: 'forneça ?numero= ou ?id=' });
  }

  try {
    const sq = sbq();
    if (!sq) return res.status(503).json({ error: 'Supabase indisponível' });
    const sb = require('../services/dbClient').getClient();

    const out = {
      query: { numero: numero || null, id: id || null },
      teams_current:    [],
      snapshots:        [],
      note_subcategoria: null,
      team_daily_subcat: [],
      hint: null,
    };

    // 1) teams_current (em campo agora?)
    const { data: tc } = await sb.from('teams_current').select('team_name, regional, data');
    for (const t of (tc || [])) {
      const found = _findNoteInTeam(t.data, { numero, id });
      if (found) {
        out.teams_current.push({
          team:     t.team_name,
          regional: t.regional,
          ...found,
        });
      }
    }

    // 2) snapshots (histórico — últimos 30 dias por simplicidade)
    const { data: sn } = await sb
      .from('snapshots')
      .select('team_name, regional, date, captured_at, data')
      .gte('date', new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10))
      .order('captured_at', { ascending: false })
      .range(0, 5000);  // limite de segurança
    const snapsSeen = new Set();  // dedupe por (team, date)
    for (const s of (sn || [])) {
      const key = `${s.team_name}|${s.date}`;
      if (snapsSeen.has(key)) continue;
      const found = _findNoteInTeam(s.data, { numero, id });
      if (found) {
        snapsSeen.add(key);
        out.snapshots.push({
          team:        s.team_name,
          regional:    s.regional,
          date:        s.date,
          captured_at: s.captured_at,
          ...found,
        });
      }
    }

    // Pega o ID encontrado pra próximas etapas (se chegou via numero)
    const noteId = id || (out.teams_current[0]?.id || out.snapshots[0]?.id);

    // 3) note_subcategorias (classificada?)
    if (noteId) {
      const { data: nsc } = await sb
        .from('note_subcategorias')
        .select('*')
        .eq('note_id', noteId)
        .maybeSingle();
      out.note_subcategoria = nsc || null;
    }

    // 4) team_daily_subcat_totals (entrou no agregado?)
    // Não tem note_id na tabela — só agregado por (date, team, tipo, sub_code).
    // Se snapshot mostrou a OS, podemos verificar se há linha pro mesmo dia/team/tipo.
    if (out.snapshots.length > 0) {
      const datesTeams = out.snapshots.map(s => `(${s.date},${s.team})`);
      const dates  = [...new Set(out.snapshots.map(s => s.date))];
      const teams  = [...new Set(out.snapshots.map(s => s.team))];
      const tipos  = [...new Set(out.snapshots.map(s => s.tipo))];
      const { data: tdsc } = await sb
        .from('team_daily_subcat_totals')
        .select('date, team_name, tipo, sub_code, count')
        .in('date', dates)
        .in('team_name', teams)
        .in('tipo', tipos);
      out.team_daily_subcat = tdsc || [];
    }

    // Hint heurístico
    if (out.teams_current.length === 0 && out.snapshots.length === 0) {
      out.hint = 'OS não encontrada em teams_current nem snapshots dos últimos 30 dias. ' +
                 'Pode estar apenas EMITIDA no WPA mas não executada por equipe oficial. ' +
                 'Verifique se a equipe responsável está na whitelist.';
    } else if (out.snapshots.length > 0 && !out.note_subcategoria) {
      out.hint = 'OS apareceu em snapshot(s) mas não está em note_subcategorias. ' +
                 'Classifier ainda não processou — cairá em OUTROS no agregado até reclassificar.';
    } else if (out.note_subcategoria && !out.team_daily_subcat.length) {
      out.hint = 'OS classificada mas team_daily_subcat_totals do dia/equipe está vazio. ' +
                 'Provável drift — rode reconciliação.';
    }

    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// helper: procura uma OS dentro do payload de uma team
function _findNoteInTeam(teamData, { numero, id }) {
  if (!teamData) return null;
  const buckets = ['notasConcluidas', 'notasExecutadas', 'notasBaixadas', 'notasRejeitadas'];
  for (const bucket of buckets) {
    for (const n of (teamData[bucket] || [])) {
      const matchById  = id     && n.id === id;
      const matchByNum = numero && (n.codigo === numero || n.code === numero);
      if (matchById || matchByNum) {
        return {
          id:      n.id,
          codigo:  n.codigo || n.code,
          tipo:    n.tipoCode || n.tipo_code,
          status:  bucket.replace('notas', '').toLowerCase(),
          conclusionDate: n.conclusionDate || null,
        };
      }
    }
  }
  return null;
}

// GET /api/admin/equipes-sem-producao?de=YYYY-MM-DD&ate=YYYY-MM-DD&regional=GUA
// Lista equipes oficiais (whitelist) que NÃO tiveram nenhuma OS executada no período.
// Útil para validar discrepâncias tipo "esperava 40 equipes mas painel mostra 35".
router.get('/admin/equipes-sem-producao', async (req, res) => {
  const de  = req.query.de;
  const ate = req.query.ate;
  const regional = (req.query.regional || 'ALL').toUpperCase();
  if (!_RE_YYYYMMDD.test(de || '') || !_RE_YYYYMMDD.test(ate || '')) {
    return res.status(400).json({ error: 'parâmetros de e ate obrigatórios (YYYY-MM-DD)' });
  }
  try {
    const sq = sbq();
    if (!sq) return res.status(503).json({ error: 'Supabase indisponível' });
    const sb = require('../services/dbClient').getClient();
    const { getOficiais } = require('../services/equipesOficiais');

    // Quem produziu no período (qualquer equipe oficial com pelo menos 1 record)
    const { data, error } = await sb
      .from('team_daily_totals')
      .select('team_name')
      .gte('date', de)
      .lte('date', ate);
    if (error) throw error;
    const produziram = new Set((data || []).map(r => String(r.team_name).toUpperCase()));

    // Whitelist filtrada por regional
    const all = getOficiais().filter(e =>
      req.scope.regionals.includes((e.regional || '').toUpperCase())
    );
    const ausentes = all.filter(e => !produziram.has(e.sigla.toUpperCase()));

    res.json({
      de, ate, regional,
      total_whitelist: all.length,
      total_com_producao: all.length - ausentes.length,
      total_sem_producao: ausentes.length,
      ausentes: ausentes.map(e => ({
        sigla: e.sigla, setor: e.setor, regional: e.regional, tipo: e.tipo,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/team-search?siglas=ETGPR18,ETGPR19
// Procura siglas em snapshots / teams_current SEM aplicar whitelist.
// Útil pra ver se uma equipe existe no WPA sob qualquer sigla/setor.
router.get('/admin/team-search', async (req, res) => {
  const siglas = String(req.query.siglas || '').toUpperCase()
    .split(',').map(s => s.trim()).filter(Boolean);
  if (siglas.length === 0) return res.status(400).json({ error: 'parâmetro siglas obrigatório (separado por vírgula)' });
  try {
    const sb = require('../services/dbClient').getClient();

    // Snapshots últimos 90 dias
    const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const { data: snaps, error } = await sb
      .from('snapshots')
      .select('team_name, regional, sector_id, date')
      .in('team_name', siglas)
      .gte('date', cutoff)
      .order('date', { ascending: false });
    if (error) throw error;

    const byTeam = {};
    for (const s of (snaps || [])) {
      const k = s.team_name.toUpperCase();
      if (!byTeam[k]) byTeam[k] = { sigla: k, dates: new Set(), regionals: new Set(), sectors: new Set() };
      byTeam[k].dates.add(s.date);
      byTeam[k].regionals.add(s.regional);
      byTeam[k].sectors.add(s.sector_id);
    }

    // teams_current (em campo agora)
    const { data: tc } = await sb
      .from('teams_current')
      .select('team_name, regional, sector_id')
      .in('team_name', siglas);

    const result = siglas.map(s => {
      const t = byTeam[s];
      const current = (tc || []).find(c => c.team_name.toUpperCase() === s);
      return {
        sigla: s,
        encontrada: !!t,
        em_campo_agora: current ? { regional: current.regional, sector: current.sector_id } : null,
        dias_em_snapshots: t ? t.dates.size : 0,
        ultima_data: t ? [...t.dates].sort().reverse()[0] : null,
        regionais_vistas: t ? [...t.regionals] : [],
        setores_vistos: t ? [...t.sectors] : [],
      };
    });

    res.json({ siglas, cutoff, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/equipes/refresh — força recarga do cache em memória
router.post('/admin/equipes/refresh', async (_req, res) => {
  try {
    const { forceRefresh, isFromSupabase, getOficiais } = require('../services/equipesOficiais');
    await forceRefresh();
    res.json({
      ok: true,
      source: isFromSupabase() ? 'supabase' : 'fallback',
      total:  getOficiais().length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
    const { saveSnapshot, upsertDailyTotals, upsertTeamDailyTotals } = require('../services/dataWriter');

    const SETORES = ['DESG', 'DEPT', 'DESC', 'DSSJ'];   // SJC adicionado 08/06/2026
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
  const { saveSnapshot, upsertDailyTotals, upsertTeamDailyTotals } = require('../services/dataWriter');
  const SETORES = ['DESG', 'DEPT', 'DESC', 'DSSJ'];   // SJC adicionado 08/06/2026

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

// POST /api/admin/retry-outros?days=30
// Re-classifica todas as notas DD/OUTROS dos últimos N dias (default 7).
// Útil quando Activities[] da WPA só são populadas dias depois da conclusão,
// deixando C93/BTZ013 presos como OUTROS no cache.
// Após reclassificar, consolida automaticamente todos os dias da janela.
router.post('/admin/retry-outros', async (req, res) => {
  try {
    const c = cron();
    if (!c) return res.status(503).json({ ok: false, error: 'cronService indisponível neste ambiente (Vercel/supabase)' });
    const days = parseInt(req.query.days || '7', 10);
    if (!Number.isFinite(days) || days < 1 || days > 90) {
      return res.status(400).json({ error: 'Parâmetro days deve ser entre 1 e 90' });
    }
    const result = await c.runRetryRecentOutros(days);
    res.json({ ok: true, days, ...(result || {}) });
  } catch (err) {
    console.error('[retry-outros]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/backfill-rejeicoes?days=30
// Varre snapshots dos últimos N dias e classifica motivos das notas
// rejeitadas (popula `note_rejections`). Default 30 dias, máx 90.
router.post('/admin/backfill-rejeicoes', async (req, res) => {
  try {
    const c = cron();
    if (!c) return res.status(503).json({ ok: false, error: 'cronService indisponível neste ambiente (Vercel/supabase)' });
    const days = parseInt(req.query.days || '30', 10);
    if (!Number.isFinite(days) || days < 1 || days > 90) {
      return res.status(400).json({ error: 'Parâmetro days deve ser entre 1 e 90' });
    }
    const result = await c.runBackfillRejeicoes(days);
    res.json({ ok: true, days, ...(result || {}) });
  } catch (err) {
    console.error('[backfill-rejeicoes]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/sync-logoffs?date=YYYY-MM-DD
// Busca sessões finalizadas do dia via /api/Sessions/all/date e atualiza
// sessionEnd nos snapshots correspondentes. Útil quando o cron noturno
// falhou ou pra dias antigos onde queremos preencher logoff retroativo.
// Default: dia anterior (BRT).
router.post('/admin/sync-logoffs', async (req, res) => {
  try {
    const c = cron();
    if (!c) return res.status(503).json({ ok: false, error: 'cronService indisponível neste ambiente (Vercel/supabase)' });
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const date = req.query.date;
    if (date && !dateRe.test(date)) {
      return res.status(400).json({ error: 'Parâmetro date deve ser YYYY-MM-DD' });
    }
    const result = await c.runSyncLogoffs(date || undefined);
    res.json({ ok: true, ...(result || {}) });
  } catch (err) {
    console.error('[sync-logoffs]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/sync-intervalos?date=YYYY-MM-DD
// Coleta os intervalos das sessões de um dia (default: ontem BRT) e grava em
// `sessao_intervalo`. O cron já faz isso às 03:10; esta rota serve pra popular
// um dia específico ou recuperar noite em que o cron falhou. 1 request por sessão.
router.post('/admin/sync-intervalos', async (req, res) => {
  try {
    const c = cron();
    if (!c) return res.status(503).json({ ok: false, error: 'cronService indisponível neste ambiente (Vercel/supabase)' });
    const date = req.query.date;
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Parâmetro date deve ser YYYY-MM-DD' });
    }
    const result = await c.runSyncIntervalos(date || undefined);
    res.json({ ok: true, ...(result || {}) });
  } catch (err) {
    console.error('[sync-intervalos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/sync-escala-dia
// Puxa a escala cadastrada do mês corrente (GET /api/collaboratorshifts) para os
// 4 setores e grava em `escala_dia`. O cron já faz isso às 05:20; esta rota existe
// pra popular sem esperar o dia seguinte — sem ela, o cruzamento do P1-26 só passa
// a valer amanhã. 1 request por setor.
router.post('/admin/sync-escala-dia', async (req, res) => {
  try {
    const c = cron();
    if (!c) return res.status(503).json({ ok: false, error: 'cronService indisponível neste ambiente (Vercel/supabase)' });
    const result = await c.runSyncEscalaDia();
    res.json({ ok: true, ...(result || {}) });
  } catch (err) {
    console.error('[sync-escala-dia]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/revalidate-dd?days=30  ou  ?all=true
// Revalida notas DD usando regras atualizadas do classificador.
//   - days=N  → últimos N dias (default 30, máx 90)
//   - all=true → TODAS as DD do banco (ignora janela de tempo)
// Útil quando muda critério de negócio (ex: regra "RAMAL BT no Address" pra C93).
// Reconsolida automaticamente os dias afetados.
router.post('/admin/revalidate-dd', async (req, res) => {
  try {
    const c = cron();
    if (!c) return res.status(503).json({ ok: false, error: 'cronService indisponível neste ambiente (Vercel/supabase)' });
    const all = req.query.all === 'true' || req.query.all === '1';
    const days = parseInt(req.query.days || '30', 10);
    if (!all && (!Number.isFinite(days) || days < 1 || days > 90)) {
      return res.status(400).json({ error: 'Parâmetro days deve ser entre 1 e 90 (ou use all=true)' });
    }
    const result = await c.runRevalidateDD(days, { all });
    res.json({ ok: true, days: all ? 'TODAS' : days, ...(result || {}) });
  } catch (err) {
    console.error('[revalidate-dd]', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── REJEIÇÕES ────────────────────────────────────────────────────────────────

/** Parse comum dos filtros usados nas três rotas de rejeições.
 *  Suporta multi-select: `team`, `regional`, `tipos`, `motivos` aceitam CSV.
 *  Mantém `team` (string) e `regional` (string) como aliases retrocompatíveis
 *  quando há 1 só valor — quem consome decide se usa .team ou .teams. */
function _parseRejeicoesFilters(req, res) {
  const de  = req.query.de;
  const ate = req.query.ate;
  if (de && !_RE_YYYYMMDD.test(de))  { res.status(400).json({ error: 'Parâmetro de inválido (YYYY-MM-DD)' });  return null; }
  if (ate && !_RE_YYYYMMDD.test(ate)){ res.status(400).json({ error: 'Parâmetro ate inválido (YYYY-MM-DD)' }); return null; }

  const _csv = (v) => v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : null;
  const regionaisArr = _csv(req.query.regional);
  const regionais = regionaisArr && !regionaisArr.includes('ALL')
    ? regionaisArr.map(s => s.toUpperCase()) : null;
  const teamsArr = _csv(req.query.team);
  const teams = teamsArr && !teamsArr.includes('ALL') ? teamsArr : null;
  const tipos    = req.query.tipos
    ? String(req.query.tipos).split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    : null;
  const motivos  = req.query.motivos
    ? String(req.query.motivos).split(',').map(s => s.trim()).filter(Boolean)
    : null;
  const somenteComMotivo = req.query.somenteComMotivo === 'true' || req.query.somenteComMotivo === '1';
  // Por padrão excluímos rejeições "legítimas" (Pix no WPA, conta paga etc.) —
  // cliente já fez o acerto, não conta como desvio. Toggle pra auditoria.
  const incluirContaPaga = req.query.incluirContaPaga === 'true' || req.query.incluirContaPaga === '1';
  return {
    de: de || dateBRT(),
    ate: ate || de || dateBRT(),
    regional: regionais && regionais.length === 1 ? regionais[0] : null,
    regionais,
    team:     teams && teams.length === 1 ? teams[0] : null,
    teams,
    tipos, motivos, somenteComMotivo, incluirContaPaga,
  };
}

// GET /api/rejeicoes/totais?de=&ate=&regional=&team=&tipos=MD,SF
router.get('/rejeicoes/totais', async (req, res) => {
  try {
    const sq = sbq();
    if (!sq) return res.json({ total: 0, comMotivo: 0, semMotivo: 0, porRegional: {GUA:0,CAC:0}, porTipo: {}, porMotivo: [], porEquipe: [], porDia: [], executadasNoPeriodo: 0, percentualGeral: null });
    const f = _parseRejeicoesFilters(req, res);
    if (!f) return;
    const result = await sq.getRejeicoesTotais(f.de, f.ate, req.scope.regionals, { team: f.team, teams: f.teams, tipos: f.tipos, motivos: f.motivos, incluirContaPaga: f.incluirContaPaga });
    res.json(result);
  } catch (err) {
    console.error('[rejeicoes/totais]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rejeicoes/lista?de=&ate=&regional=&team=&tipos=&motivos=&somenteComMotivo=&limit=&offset=
router.get('/rejeicoes/lista', async (req, res) => {
  try {
    const sq = sbq();
    if (!sq) return res.json({ total: 0, limit: 500, offset: 0, rows: [] });
    const f = _parseRejeicoesFilters(req, res);
    if (!f) return;
    const result = await sq.getRejeicoesLista(f.de, f.ate, req.scope.regionals, {
      team: f.team, teams: f.teams,
      tipos: f.tipos, motivos: f.motivos, somenteComMotivo: f.somenteComMotivo,
      incluirContaPaga: f.incluirContaPaga,
      limit: req.query.limit, offset: req.query.offset,
    });
    res.json(result);
  } catch (err) {
    console.error('[rejeicoes/lista]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rejeicoes/motivos?de=&ate=&regional=
// Catálogo de motivos vistos no período (pra alimentar dropdown de filtro).
router.get('/rejeicoes/motivos', async (req, res) => {
  try {
    const sq = sbq();
    if (!sq) return res.json([]);
    const f = _parseRejeicoesFilters(req, res);
    if (!f) return;
    const result = await sq.getRejeicoesMotivos(f.de, f.ate, req.scope.regionals, { incluirContaPaga: f.incluirContaPaga });
    res.json(result);
  } catch (err) {
    console.error('[rejeicoes/motivos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DESLOCAMENTOS ─────────────────────────────────────────────────────────────
// Análise de tempo real vs estimativa OSRM (cliente é medido pelo Google,
// mas usamos OSRM grátis — diferença típica < 10%, suficiente pra benchmark).
const _deslocQ = require('../db/deslocamentosQueries');

function _parseDeslocFilters(req) {
  const de  = req.query.de  || dateBRT();
  const ate = req.query.ate || de;
  const _csv = (v) => v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : null;
  // Multi-select compat: aceita "team=SIG1,SIG2" e "regional=GUA,CAC"
  const teamsArr     = _csv(req.query.team);
  const teams        = teamsArr && !teamsArr.includes('ALL') ? teamsArr : null;
  // Regional: sempre usa req.scope.regionals (já intersectado pelo applyScope
  // com o escopo do usuário). Query string ?regionals= é lida pelo middleware.
  const regionais    = (req.scope && Array.isArray(req.scope.regionals) && req.scope.regionals.length > 0)
    ? req.scope.regionals : null;
  return {
    de, ate,
    regionais,
    team_name: teams && teams.length === 1 ? teams[0] : null,
    teams,
    tipo:      req.query.tipo || null,
    limit:     req.query.limit,
    // Quando true, retorna so deslocamentos com status='lento' (>1.5x tempo Maps).
    // Afeta lista, ranking e tendencia consistentemente.
    somenteLentos: req.query.somenteLentos === 'true' || req.query.somenteLentos === '1',
    // 'acima' filtra deslocamentos com desvio>X% E excedente>15min.
    // Valores aceitos: 50, 100. Null/ausente = sem filtro (todos).
    acimaPct: (req.query.acima === '50' || req.query.acima === '100')
      ? Number(req.query.acima) : null,
  };
}

// GET /api/deslocamentos/lista?de=&ate=&regional=&team=&tipo=&limit=
router.get('/deslocamentos/lista', async (req, res) => {
  try {
    const f = _parseDeslocFilters(req);
    const r = await _deslocQ.listDeslocamentos(f.de, f.ate, f);
    res.json(r);
  } catch (err) {
    console.error('[deslocamentos/lista]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/deslocamentos/ranking?de=&ate=&regional=
router.get('/deslocamentos/ranking', async (req, res) => {
  try {
    const f = _parseDeslocFilters(req);
    const r = await _deslocQ.rankingEquipes(f.de, f.ate, f);
    res.json(r);
  } catch (err) {
    console.error('[deslocamentos/ranking]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/deslocamentos/tendencia?de=&ate=&regional=
router.get('/deslocamentos/tendencia', async (req, res) => {
  try {
    const f = _parseDeslocFilters(req);
    const r = await _deslocQ.tendenciaDiaria(f.de, f.ate, f);
    res.json(r);
  } catch (err) {
    console.error('[deslocamentos/tendencia]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/deslocamentos/threshold — fator atual (logado)
router.get('/deslocamentos/threshold', async (req, res) => {
  try {
    const fator = await _deslocQ.getThreshold();
    res.json({ fator });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/deslocamentos/threshold — só admin. Body: { fator: 1.5 }
router.put('/deslocamentos/threshold', requireAdmin, async (req, res) => {
  try {
    const sq = sbq();
    if (!sq) return res.status(503).json({ error: 'supabase indisponível' });
    const fator = Number(req.body && req.body.fator);
    if (!isFinite(fator) || fator <= 1 || fator > 10) {
      return res.status(400).json({ error: 'fator inválido (use número entre 1 e 10, ex: 1.5)' });
    }
    await sq.setSetting('desloc-threshold', { fator });
    _deslocQ.setThresholdCache(fator);   // reflete imediato (sem esperar 60s do cache)
    res.json({ ok: true, fator });
  } catch (err) {
    console.error('[deslocamentos/threshold PUT]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/carteira/equipes?de=YYYY-MM-DD&ate=YYYY-MM-DD&regionals=GUA,CAC
// Aproveitamento de carteira por equipe: linhas cruas (dia × equipe) de
// team_daily_carteira (populada pelo cron + backfill). Cada linha:
//   { date, team_name, regional, carteira_inicial, entradas_novas,
//     atual, andamento, concluidas, rejeitadas, canceladas }
// Invariante por linha: inicial + entradas = atual + andamento + concluidas
// + rejeitadas + canceladas. Frontend agrega por equipe e exporta XLSX.
router.get('/carteira/equipes', async (req, res) => {
  try {
    const { _getPool } = require('../services/pgShim');
    const pool = _getPool();
    if (!pool) return res.json({ rows: [] });
    const today = dateBRT();
    const de  = req.query.de  || today;
    const ate = req.query.ate || de;

    const params = [de, ate];
    const { inRegionalsSql } = require('../services/regionals');
    const regClause = inRegionalsSql(req.scope.regionals, params, 'c.regional');

    const { rows } = await pool.query(`
      SELECT c.date, c.team_name, c.regional,
             c.carteira_inicial, c.entradas_novas,
             c.atual, c.andamento, c.concluidas, c.rejeitadas, c.canceladas
      FROM team_daily_carteira c
      JOIN equipes_oficiais eo ON eo.sigla = c.team_name AND eo.ativo = true
      WHERE c.date >= $1 AND c.date <= $2 AND ${regClause}
      ORDER BY c.date, c.team_name
    `, params);

    res.json({ de, ate, rows });
  } catch (err) {
    console.error('[carteira/equipes]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mapa/equipe?team=SIGLA&date=YYYY-MM-DD
// Retorna notas com checkpoints GPS de uma equipe no dia.
router.get('/mapa/equipe', async (req, res) => {
  try {
    const sq   = sbq();
    const team = req.query.team;
    if (!team) return res.status(400).json({ error: 'Parâmetro team é obrigatório.' });
    // Bloqueia se equipe é de outra regional (não-admin)
    if (!(await enforceTeamRegional(req, res, team))) return;
    const date = req.query.date || dateBRT();
    if (!sq) return res.json({ notes: [], team, date, teamInfo: {} });
    const result = await sq.getMapaEquipe(team, date);
    res.json(result);
  } catch (err) {
    console.error('[mapa/equipe]', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ── NOTAS DEVOLVIDAS ────────────────────────────────────────────────────────
// Monitor das notas devolvidas pelo SAP (a serem tratadas pelo backoffice).
// Snapshot horário via cronService.runNotasCollect → tabelas notas_snapshots
// + notas_daily_agg. Implementação em db/notasQueries.js.

const notasQueries = require('../db/notasQueries');

function _classif(req) {
  const c = (req.query.classificacao || 'todas').toLowerCase();
  return ['todas', 'oficial', 'nova'].includes(c) ? c : 'todas';
}

const _REG_VALIDAS = new Set(['GUA', 'CAC', 'SJC']);
// Escopo regional AUTORITATIVO para as rotas /notas/*.
// Usa req.scope.regionals — já intersectado por applyScope com o token do user.
// NUNCA ler req.query.regionais cru aqui: era o vetor de vazamento (14/07/2026)
// que deixava um user GUA passar ?regionais=SJC e ver dados de outra regional,
// ou omitir o param e receber TODAS (null virava "sem filtro" na query).
function _regionais(req) {
  const scope = (req.scope && Array.isArray(req.scope.regionals)) ? req.scope.regionals : [];
  const arr = scope.map(s => String(s).toUpperCase()).filter(s => _REG_VALIDAS.has(s));
  return arr.length ? arr : null;
}

router.get('/notas/kpis', async (req, res) => {
  try { res.json(await notasQueries.getKpis(_classif(req), _regionais(req))); }
  catch (err) { console.error('[notas/kpis]', err.message); res.status(500).json({ error: err.message }); }
});

router.get('/notas/serie', async (req, res) => {
  try {
    const dias = Math.min(Math.max(parseInt(req.query.dias, 10) || 30, 1), 365);
    res.json(await notasQueries.getSerie(dias, _classif(req), _regionais(req)));
  } catch (err) { console.error('[notas/serie]', err.message); res.status(500).json({ error: err.message }); }
});

router.get('/notas/serie-horaria', async (req, res) => {
  try {
    const dias = Math.min(Math.max(parseInt(req.query.dias, 10) || 7, 1), 30);
    res.json(await notasQueries.getSerieHoraria(dias, _classif(req), _regionais(req)));
  } catch (err) { console.error('[notas/serie-horaria]', err.message); res.status(500).json({ error: err.message }); }
});

router.get('/notas/por-equipe', async (req, res) => {
  try { res.json(await notasQueries.getPorEquipe(_classif(req), _regionais(req))); }
  catch (err) { console.error('[notas/por-equipe]', err.message); res.status(500).json({ error: err.message }); }
});

router.get('/notas/equipe/:nome', async (req, res) => {
  try { res.json(await notasQueries.getNotasDeEquipe(req.params.nome, _regionais(req))); }
  catch (err) { console.error('[notas/equipe]', err.message); res.status(500).json({ error: err.message }); }
});

module.exports = router;
// Exportado p/ teste (P1-41, 28/08/2026). O router é o export principal;
// pendurar o helper nele evita mudar a forma do módulo pra quem já usa.
module.exports._checkJanela = _checkJanela;
// P1-42 (28/08/2026) — baldes do rate limit de login.
module.exports._loginKey       = _loginKey;
module.exports._loginKeyUser   = _loginKeyUser;
module.exports._baldeEstourado = _baldeEstourado;
module.exports._loginTries     = _loginTries;
module.exports._LOGIN_MAX      = LOGIN_MAX;
module.exports._LOGIN_MAX_USER = LOGIN_MAX_USER;
module.exports._LOGIN_WINDOW_MS= LOGIN_WINDOW_MS;
