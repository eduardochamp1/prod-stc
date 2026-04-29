/**
 * services/wpaService.js
 * Integração com a API WPA EDP.
 *
 * Auth:  POST https://edp-wpa-po.azurewebsites.net/identity/signin  → JWT
 * API:   https://edp-wpa-web-api.azurewebsites.net
 *
 * Estratégia de dados (2 chamadas paralelas por setor):
 *   1. GET /api/sessions/current?sectorId=X
 *      → Única fonte do Team.CompanyId — necessário para filtrar equipes Engelmig.
 *        Também fornece Vehicle.Code (placa) que o V2 não retorna.
 *   2. GET /api/teamsstatus/V2?sectorId=X&filterByExhibitionSector=true
 *      → Fonte dos contadores de notas.
 *        Inclui Concluded[] com ExecutionStatus 4/5 que some de /notes/execution.
 *
 * ExecutionStatus das notas no V2 (confirmado em campo):
 *   1 → baixada   (na carteira, aguardando)
 *   3 → executada (em andamento)
 *   6 → executada ("Trabalhando na nota X" — nota ativa)
 *   7 → executada (variante de nota ativa)
 *   4 → concluida (exportada/sincronizada)
 *   5 → concluida (exportada variante)
 *   9 → concluida (mobile pendente sync)
 *
 * Estrutura de Collaborators:
 *   sessions/current → Collaborators[].Collaborator.{Name, Code}  (aninhado)
 *   teamsstatus/V2   → Session.Collaborators[].{Name, Code}        (plano)
 *   O código trata ambos com fallback defensivo.
 */

const fetch = require('node-fetch');

const WPA_AUTH = process.env.WPA_URL      || 'https://edp-wpa-po.azurewebsites.net';
const WPA_API  = process.env.WPA_API_URL  || 'https://edp-wpa-web-api.azurewebsites.net';

let _token        = null;
let _expireAt     = 0;
let _loginPromise = null;   // serializa logins concorrentes

// ── AUTH ──────────────────────────────────────────────────────────────────────

/**
 * Tenta uma única vez fazer login. Marca erros como `isAzureColdStart` (quando
 * o App Service do WPA responde 403 com a página HTML "Web App - Unavailable"
 * — típico de hibernação/cold-start no Azure) ou `isNetworkError` (fetch jogou
 * exceção: timeout, DNS, conexão recusada). O `login()` externo usa essas flags
 * para decidir retry — erros legítimos (ex: 401 credencial inválida) não retry.
 */
async function loginAttempt() {
  const body = new URLSearchParams({
    Username: process.env.WPA_USERNAME || '',
    Password: process.env.WPA_PASSWORD || '',
  });

  let res;
  try {
    res = await fetch(`${WPA_AUTH}/identity/signin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: body.toString(),
    });
  } catch (err) {
    err.isNetworkError = true;
    throw err;
  }

  if (!res.ok) {
    const txt = await res.text();
    const isAzureColdStart = /Web App\s*-\s*Unavailable/i.test(txt);
    const tag = isAzureColdStart ? ' [Azure cold-start]' : '';
    const error = new Error(`WPA login falhou (${res.status})${tag}: ${txt.slice(0, 200)}`);
    error.isAzureColdStart = isAzureColdStart;
    error.httpStatus       = res.status;
    throw error;
  }

  const data = await res.json();

  if (!data.Token) {
    const msg = data.Error?.Message || 'Token não retornado';
    throw new Error(`WPA login: ${msg}`);
  }

  _token = data.Token;

  try {
    const [, payload] = data.Token.split('.');
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
    _expireAt = decoded.exp ? decoded.exp * 1000 : Date.now() + 3_600_000;
  } catch {
    _expireAt = Date.now() + 3_600_000;
  }

  const userId = data.UserIdId || data.UserId || null;
  console.log(`[WPA] Login OK — userId=${userId}  exp=${new Date(_expireAt).toISOString()}`);
  return { token: _token, userId };
}

/**
 * Login com retry exponencial p/ erros transientes do Azure App Service.
 *
 * Cenário comum: cold-start do edp-wpa-po (App Service do WPA Auth) —
 * primeira request retorna 403 com HTML "Web App - Unavailable" enquanto
 * o container está iniciando. Geralmente sobe em 5-15s.
 *
 * Estratégia: até 3 tentativas com backoff [2s, 5s]. Total ~7s de espera
 * antes de propagar o erro pra UI (que já mostra wpaStatus real).
 *
 * Erros legítimos (401 credencial errada, etc) não fazem retry — propaga já.
 */
async function login(opts = {}) {
  // Backoff calibrado p/ Azure cold-start do edp-wpa-po. Em produção foi
  // observado cold-start de até 25-30s — backoff agressivo cobre isso.
  // Cliente pode pedir backoff mais longo via opts.aggressive (rota /admin/warm).
  const BACKOFF_MS = opts.aggressive
    ? [5000, 10000, 15000, 18000]   // ~48s — para warm/admin onde tempo é OK
    : [4000,  8000, 14000];          // ~26s — para chamadas de usuário
  const MAX_ATTEMPTS = BACKOFF_MS.length + 1;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await loginAttempt();
      if (attempt > 1) console.log(`[WPA] Login OK na tentativa ${attempt}/${MAX_ATTEMPTS}`);
      return result;
    } catch (err) {
      const transient = err.isAzureColdStart || err.isNetworkError;
      if (!transient || attempt === MAX_ATTEMPTS) throw err;
      const delay = BACKOFF_MS[attempt - 1];
      const reason = err.isAzureColdStart ? 'Azure cold-start' : 'erro de rede';
      console.warn(`[WPA] Login tentativa ${attempt}/${MAX_ATTEMPTS} falhou (${reason}: ${err.message.slice(0, 80)}) — retry em ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function getToken() {
  if (!_token || Date.now() >= _expireAt - 60_000) {
    // Serializa logins concorrentes: se já há um login em curso, aguarda o mesmo.
    // Sem isso, Promise.all() no classificarDD dispara dois logins simultâneos e o
    // WPA invalida o primeiro token ao receber o segundo — a chamada details/optimized
    // recebe 401 e retorna null silenciosamente.
    if (!_loginPromise) {
      _loginPromise = login().finally(() => { _loginPromise = null; });
    }
    await _loginPromise;
  }
  return _token;
}

/** Força novo login independente do TTL atual.
 *  opts.aggressive=true → backoff longo (até ~48s); usado pelo /admin/warm. */
async function forceRefresh(opts = {}) {
  return login(opts);
}

/** Retorna o estado atual do token sem fazer nenhuma chamada de rede. */
function getTokenStatus() {
  const now = Date.now();
  if (!_token) return { valid: false, reason: 'sem token', expiresAt: null, expiresIn: null };
  if (now >= _expireAt) return { valid: false, reason: 'expirado', expiresAt: new Date(_expireAt).toISOString(), expiresIn: '0s' };
  const secsLeft = Math.round((_expireAt - now) / 1000);
  return { valid: true, reason: 'ok', expiresAt: new Date(_expireAt).toISOString(), expiresIn: `${secsLeft}s` };
}

// ── FETCH HELPER ──────────────────────────────────────────────────────────────

/**
 * Detecta se uma resposta é a página HTML de cold-start do Azure App Service
 * (header content-type=text/html + body contendo "Web App - Unavailable").
 * Consome o body via clone() para não quebrar o read posterior.
 */
async function _isAzureColdStartResponse(res) {
  const ctype = res.headers.get('content-type') || '';
  if (!ctype.includes('text/html') && res.status !== 503 && res.status !== 403) return false;
  try {
    const txt = await res.clone().text();
    return /Web App\s*-\s*Unavailable/i.test(txt);
  } catch { return false; }
}

/**
 * Faz fetch contra a Web API do WPA com retry em caso de:
 *   • Cold-start do Azure App Service (edp-wpa-web-api) — 403/503 com HTML "Unavailable"
 *   • Erro de rede (timeout, conexão recusada)
 * Backoff alinhado com login() — total ~21s de paciência.
 *
 * Importante: erros legítimos da API (401/404/500 com JSON) são propagados
 * direto sem retry, pra não esconder problemas reais.
 */
async function wpaFetch(path, options = {}) {
  // Backoff mais curto que o do login: a Web API costuma estar quente quando
  // o auth está; só protege contra cold-start ocasional. Total ~9s.
  const BACKOFF_MS = [3000, 6000];
  const MAX_ATTEMPTS = BACKOFF_MS.length + 1;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const token = await getToken();
    let res;
    try {
      res = await fetch(`${WPA_API}${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(options.headers || {}),
        },
      });
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw err;
      const delay = BACKOFF_MS[attempt - 1];
      console.warn(`[WPA] wpaFetch ${path} erro de rede (tentativa ${attempt}/${MAX_ATTEMPTS}): ${err.message} — retry em ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    // Cold-start do App Service da Web API → retry
    if (await _isAzureColdStartResponse(res)) {
      if (attempt === MAX_ATTEMPTS) {
        console.warn(`[WPA] wpaFetch ${path} cold-start persistente (${MAX_ATTEMPTS} tentativas) — desistindo`);
        return res;
      }
      const delay = BACKOFF_MS[attempt - 1];
      console.warn(`[WPA] wpaFetch ${path} Azure cold-start (tentativa ${attempt}/${MAX_ATTEMPTS}) — retry em ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    return res;
  }
}

// ── ENDPOINTS ─────────────────────────────────────────────────────────────────

/**
 * Retorna sessões ativas no setor.
 * Única fonte de Team.CompanyId — necessário para filtrar equipes Engelmig.
 * Também fornece Vehicle.Code (placa) que o V2 não retorna.
 * GET /api/sessions/current?sectorId={sectorId}
 */
async function getSessions(sectorId) {
  const res  = await wpaFetch(`/api/sessions/current?sectorId=${sectorId}`);
  if (!res.ok) throw new Error(`WPA sessions ${res.status}`);
  const data = await res.json();
  return data.Data || [];
}

/**
 * Retorna notas em execução no setor (dia corrente).
 * ATENÇÃO: não retorna notas ExecutionStatus 4/5 (exportadas). Mantido apenas para debug.
 * GET /api/notes/execution?sectorId={sectorId}
 */
async function getNotesExecution(sectorId) {
  const res  = await wpaFetch(`/api/notes/execution?sectorId=${sectorId}`);
  if (!res.ok) throw new Error(`WPA notes/execution ${res.status}`);
  const data = await res.json();
  return data.Data?.Notes || [];
}

/**
 * Retorna carteira de notas por equipe no setor.
 * Mantido para compatibilidade/debug. O V2 já fornece Downloaded[] que substitui este endpoint.
 * GET /api/route/preroute?sectorId={sectorId}
 */
async function getPreroute(sectorId) {
  const res  = await wpaFetch(`/api/route/preroute?sectorId=${sectorId}`);
  if (!res.ok) throw new Error(`WPA preroute ${res.status}`);
  const data = await res.json();
  return data.Data || [];
}

/**
 * Retorna status completo das equipes do setor — mesmo endpoint do WPA Gestão Online.
 * GET /api/teamsstatus/V2?sectorId={sectorId}&filterByExhibitionSector=true
 *
 * Estrutura de cada item (confirmada em campo):
 *   Concluded[]  — notas concluídas (ExecutionStatus 4/5 — inclui o que some de /notes/execution)
 *   Downloaded[] — notas na carteira do dispositivo
 *                  ExecutionStatus: 1=aguardando, 3/6/7=em andamento ativo
 *   Executed[]   — subconjunto de Downloaded em execução ativa (pode estar vazio mesmo
 *                  com notas em andamento — usar ExecutionStatus do Downloaded como fonte)
 *   Assigned[]   — notas atribuídas ainda não baixadas no dispositivo
 *   Rejected[]   — notas rejeitadas (pode ser null)
 *   Session      — dados de sessão; Team NÃO tem CompanyId (usar sessions/current para filtrar)
 *                  Collaborators[] é plano: { Id, Code, Name, Phone }
 *   Status       — texto descritivo: "Trabalhando na nota X", "Intervalo - 15...", etc.
 *   Location     — GPS { Latitude, Longitude }
 *   IsOnline, IsInLunchTime, LastUpdate, LastStatusUpdate
 */
async function getTeamStatusV2(sectorId) {
  const res = await wpaFetch(
    `/api/teamsstatus/V2?sectorId=${sectorId}&filterByExhibitionSector=true`
  );
  if (!res.ok) throw new Error(`WPA teamsstatus/V2 ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : (data.Data || []);
}

// Todos os setores conhecidos — usados no fallback cross-setor do V2.
// Se novos setores forem adicionados ao WPA, incluir aqui.
const ALL_SECTORS = ['DESG', 'DEPT', 'DESC'];

// Cache de V2 por setor — evita chamadas duplicadas quando equipes visitantes
// precisam buscar V2 em outros setores na mesma rodada de coleta.
// TTL de 3 minutos (bem abaixo do ciclo de 15 min do cron).
const _v2Cache   = new Map(); // sectorId → { list, ts }
const V2_TTL_MS  = 3 * 60 * 1000;

async function getV2Cached(sectorId) {
  const cached = _v2Cache.get(sectorId);
  if (cached && Date.now() - cached.ts < V2_TTL_MS) return cached.list;
  const list = await getTeamStatusV2(sectorId);
  _v2Cache.set(sectorId, { list, ts: Date.now() });
  return list;
}

/** Constrói índice (teamId → item, teamName → item) a partir de uma lista V2 */
function buildV2Index(statusList) {
  const byId   = new Map();
  const byName = new Map();
  statusList.forEach(item => {
    const id   = item.Session?.Team?.Id || item.Session?.TeamId;
    const nome = (item.Session?.Team?.Name || '').trim();
    if (id)   byId.set(id, item);
    if (nome) byName.set(nome, item);
  });
  return { byId, byName };
}

// ── HISTÓRICO (endpoints com parâmetro date) ──────────────────────────────────

/** Converte YYYY-MM-DD → M/D/YYYY (formato aceito pela API WPA) */
function toWpaDate(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${parseInt(m)}/${parseInt(d)}/${y}`;
}

/**
 * Sessões de um dia específico.
 * POST /api/Sessions/all/date?sectorId={sid}&date=M/D/YYYY
 */
async function getSessionsByDate(sectorId, isoDate) {
  const wpaDate = toWpaDate(isoDate);
  const res = await wpaFetch(
    `/api/Sessions/all/date?sectorId=${sectorId}&date=${encodeURIComponent(wpaDate)}`,
    { method: 'POST' }
  );
  if (!res.ok) throw new Error(`WPA sessions/date ${res.status}`);
  const data = await res.json();
  return data.Data || [];
}

/**
 * Notas de execução de um dia específico.
 * GET /api/notes/execution?sectorId={sid}&date=M/D/YYYY
 */
async function getNotesByDate(sectorId, isoDate) {
  const wpaDate = toWpaDate(isoDate);
  const res = await wpaFetch(
    `/api/notes/execution?sectorId=${sectorId}&date=${encodeURIComponent(wpaDate)}`
  );
  if (!res.ok) throw new Error(`WPA notes/date ${res.status}`);
  const data = await res.json();
  return data.Data?.Notes || [];
}

/**
 * Busca notas de uma sessão histórica por sessionId.
 * GET /api/notes/{category}/{sessionId}
 * Retorna array de notas com Number, Type, ConclusionDate.
 */
async function getNotesForSession(sessionId, category) {
  try {
    // Portal usa sufixo /session: GET /api/notes/{category}/{sessionId}/session
    const res  = await wpaFetch(`/api/notes/${category}/${sessionId}/session`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.Data || [];
  } catch {
    return [];
  }
}

/**
 * Retorna detalhes completos de uma nota (OS) pelo UUID e sectorId.
 * GET /api/Notes/{noteId}/details/optimized?sectorId={sectorId}
 *
 * Confirmado via interceptor Postman — endpoint usado pelo portal EDP WPA.
 * O noteId é o UUID (Data.Id), NÃO o número da OS (Data.Number).
 *
 * A resposta inclui:
 *   Data.Checkpoints[]  — eventos GPS (Event 0=início, 1=chegada, 2=concluída, 3=saída, 4=retorno)
 *                          Checkpoint com FileWrappers[] contém fotos em Base64
 *   Data.Equipments[]   — medidores e equipamentos (SerialNumber, Model, Prefix, etc.)
 *   Data.Seals[]        — lacres (SealNumber, SealId, SealType, etc.)
 *   Data.Materials[]    — materiais utilizados
 *   Data.Activities[]   — atividades registradas
 *   Data.*Note          — formulários preenchidos pelo técnico (SFRLNote, MDNote, etc.)
 *   Data.CustomerName, Address, City, Neighborhood, ZipCode — dados do cliente
 */
async function getNoteDetail(noteId, sectorId) {
  const qs   = sectorId ? `?sectorId=${encodeURIComponent(sectorId)}` : '';
  const path = `/api/Notes/${encodeURIComponent(noteId)}/details/optimized${qs}`;
  const t0   = Date.now();
  try {
    const res = await wpaFetch(path);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const elapsed = Date.now() - t0;
      console.warn(`[wpa] getNoteDetail !ok status=${res.status} path=${path} body=${body.slice(0,200)} ${elapsed}ms`);
      // Lança erro estruturado pro caller poder propagar status/body real do WPA
      // pra UI (em vez de só "HTTP 404"). Útil pra discriminar 401 (token race
      // em cold-start Vercel) de 404 real ou 5xx (timeout / erro upstream).
      const err = new Error(`WPA ${res.status} em ${path}`);
      err.wpaStatus  = res.status;
      err.wpaBody    = body.slice(0, 300);
      err.wpaPath    = path;
      err.wpaElapsed = elapsed;
      throw err;
    }
    const data = await res.json();
    console.log(`[wpa] getNoteDetail OK noteId=${noteId} sector=${sectorId} ${Date.now()-t0}ms`);
    return data.Data || data || null;
  } catch (err) {
    if (err.wpaStatus) throw err; // re-lança erro já estruturado
    const elapsed = Date.now() - t0;
    console.warn(`[wpa] getNoteDetail erro noteId=${noteId} sector=${sectorId} ${elapsed}ms — ${err.message}`);
    const wrapped = new Error(`WPA fetch falhou: ${err.message}`);
    wrapped.wpaStatus  = 0; // 0 = erro de rede / timeout / aborted
    wrapped.wpaBody    = err.message;
    wrapped.wpaPath    = path;
    wrapped.wpaElapsed = elapsed;
    throw wrapped;
  }
}

/**
 * Retorna detalhes completos de uma sessão individual.
 * GET /api/Sessions/{sessionId}
 * Único endpoint que retorna Collaborators[] com nome e matrícula.
 * sessions/all/date retorna Collaborators vazio.
 */
async function getSessionDetail(sessionId) {
  try {
    const res  = await wpaFetch(`/api/Sessions/${sessionId}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.Data || data;
  } catch {
    return null;
  }
}

/**
 * Combina sessões + notas de um dia histórico para um setor.
 *
 * Nova abordagem (v3): por sessionId
 *   1. POST /api/Sessions/all/date → lista de sessões do dia
 *   2. Filtra sessões Engelmig pelo CompanyId
 *   3. Para cada sessão: GET /api/notes/executed/{id} + /api/notes/downloaded/{id} + /api/notes/rejected/{id}
 *      → notas diretamente vinculadas à sessão, sem necessidade de cruzar por TeamName
 *
 * O endpoint /api/notes/executed/{sessionId} retorna notas com ConclusionDate preenchida
 * (confirmado via interceptor Postman) — essas são as "concluídas" do dia.
 */
async function getTeamsByDate(sectorId, isoDate) {
  function normalizarNotaHist(n, status) {
    return {
      id:             n.Id   || null,                    // UUID — necessário para /details/optimized
      codigo:         String(n.Number || n.Id || ''),
      tipoCode:       n.Type || '??',
      tipoNome:       n.Type || '??',
      status,
      conclusionDate: n.ConclusionDate2 || n.ConclusionDate || null,
    };
  }

  const sessions = await getSessionsByDate(sectorId, isoDate);
  const engelmigSessions = sessions.filter(s => s.Team?.CompanyId === ENGELMIG_COMPANY_ID);
  console.log(`[WPA] backfill ${sectorId}/${isoDate}: ${sessions.length} sessões totais, ${engelmigSessions.length} Engelmig`);

  // Busca notas + detalhe da sessão (colaboradores) em paralelo por sessão
  const sessionsWithNotes = await Promise.all(
    engelmigSessions.map(async s => {
      const sid = s.Id;
      const [executedRaw, downloadedRaw, rejectedRaw, surveyedRaw, detail] = await Promise.all([
        getNotesForSession(sid, 'executed'),
        getNotesForSession(sid, 'downloaded'),
        getNotesForSession(sid, 'rejected'),
        getNotesForSession(sid, 'surveyed'),
        getSessionDetail(sid),            // colaboradores reais (sessions/all/date retorna vazio)
      ]);

      const concluidas  = executedRaw.map(n  => normalizarNotaHist(n, 'concluida'));
      const baixadas    = downloadedRaw.map(n => normalizarNotaHist(n, 'baixada'));
      const rejeitadas  = rejectedRaw.map(n  => normalizarNotaHist(n, 'rejeitada'));
      const vistoriadas = surveyedRaw.map(n  => normalizarNotaHist(n, 'vistoriada'));

      // Colaboradores vêm do detalhe individual; fallback para o que vier na lista
      const collaborators = (detail?.Collaborators || s.Collaborators || []).map(normalizarColaborador);

      const teamName     = (s.Team?.Name || '').trim();
      const teamSectorId = s.SectorId || s.Sector?.Code || sectorId;

      console.log(`[WPA]   ${sectorId}/${teamName}: conc=${concluidas.length} baixadas=${baixadas.length} rej=${rejeitadas.length} vist=${vistoriadas.length} colab=${collaborators.length}`);

      return { s, teamName, teamSectorId, concluidas, baixadas, rejeitadas, vistoriadas, collaborators };
    })
  );

  // Mescla sessões da mesma equipe (relogins no mesmo dia)
  const teamMap = {};
  sessionsWithNotes.forEach(({ s, teamName, teamSectorId, concluidas, baixadas, rejeitadas, vistoriadas, collaborators }) => {
    if (!teamMap[teamName]) {
      teamMap[teamName] = {
        id:           s.Id,
        sigla:        teamName,
        teamName,
        sectorId:     teamSectorId,
        regional:     REGIONAL_MAP[teamSectorId] || 'GUA',
        date:         s.BeginTime?.slice(0, 10) || isoDate,
        sessionBegin: s.BeginTime,
        sessionEnd:   s.EndTime || null,
        vehiclePlate: s.Vehicle?.Code || '—',
        collaborators,
        relogins:     0,
        sessions:     [{ begin: s.BeginTime, end: s.EndTime || null }],
        deviceModel:  s.Device?.Model || null,
        appVersion:   s.AppVersion   || null,
        _conc: [], _baix: [], _rej: [], _vist: [],
      };
    } else {
      teamMap[teamName].relogins += 1;
      if (s.EndTime) teamMap[teamName].sessionEnd = s.EndTime;
      teamMap[teamName].sessions.push({ begin: s.BeginTime, end: s.EndTime || null });
      // Acumula colaboradores sem duplicar por matrícula
      collaborators.forEach(c => {
        if (!teamMap[teamName].collaborators.some(x => x.matricula === c.matricula)) {
          teamMap[teamName].collaborators.push(c);
        }
      });
    }

    // Acumula notas dedupicando por código
    const dedup = (arr, novas) => {
      const seen = new Set(arr.map(n => n.codigo).filter(Boolean));
      novas.forEach(n => { if (!seen.has(n.codigo)) { arr.push(n); seen.add(n.codigo); } });
    };
    dedup(teamMap[teamName]._conc, concluidas);
    dedup(teamMap[teamName]._baix, baixadas);
    dedup(teamMap[teamName]._rej,  rejeitadas);
    dedup(teamMap[teamName]._vist, vistoriadas);
  });

  return Object.values(teamMap).map(t => {
    const { _conc: notasConcluidas, _baix: notasBaixadas, _rej: notasRejeitadas, _vist: notasVistoriadas } = t;
    delete t._conc; delete t._baix; delete t._rej; delete t._vist;
    const allNotas = [...notasConcluidas, ...notasBaixadas, ...notasRejeitadas, ...notasVistoriadas];
    return {
      ...t,
      carteiraCount:   notasBaixadas.length,
      servicosPerfil:  [...new Set(allNotas.map(n => n.tipoCode))],
      notasBaixadas,
      notasExecutadas: [],   // histórico não distingue "em andamento" do dia
      notasConcluidas,
      notasRejeitadas,
      notasVistoriadas,
    };
  });
}

// NOTA: O acumulador diário em memória (_acc) foi removido.
// A persistência de KPIs agora é feita via Supabase (daily_totals / team_daily_totals),
// que sobrevivem a logoffs de equipe e reinícios do servidor.
// O frontend usa Math.max(contagem_ao_vivo, total_persistente) para garantir
// que o KPI nunca caia. Ver: db/supabaseQueries.js → getRealizadasDoDia,
// routes/index.js → GET /api/totais/dia.

// ── NORMALIZAÇÃO ──────────────────────────────────────────────────────────────

const REGIONAL_MAP = {
  DESG: 'GUA',
  DEPT: 'GUA',
  DESC: 'CAC',
};

const ENGELMIG_COMPANY_ID = '92a2f98e-8877-433e-8358-173b94c13a54';

/**
 * Normaliza uma nota do teamsstatus/V2.
 *
 * @param {object} n           - Objeto de nota do V2 (Concluded/Downloaded/Executed/Rejected)
 * @param {string} statusForcado - Se fornecido, ignora ExecutionStatus e usa este valor
 */
function normalizarNotaV2(n, statusForcado) {
  // Mapeamento confirmado em campo com dados reais
  const STATUS_V2 = {
    1: 'baixada',
    2: 'baixada',

    3: 'executada',   // em andamento
    6: 'executada',   // nota ativa ("Trabalhando na nota X")
    7: 'executada',   // variante de nota ativa
    4: 'concluida',   // exportada/sincronizada
    5: 'concluida',   // exportada variante
    9: 'concluida',   // mobile pendente sync
  };
  return {
    id:             n.Id   || null,                    // UUID — necessário para /details/optimized
    codigo:         String(n.Number || n.Id || ''),
    tipoCode:       n.Type || '??',
    tipoNome:       n.Type || '??',
    status:         statusForcado || STATUS_V2[n.ExecutionStatus] || 'baixada',
    // ConclusionDate2 (DD/MM/YYYY HH:MM:SS BR) preferido por já vir no fuso BRT;
    // ConclusionDate (ISO UTC) fallback. Necessário para filtrar contadores
    // diários — equipes com sessão de dia anterior ainda aberta carregam notas
    // velhas no payload, e não podem inflar o contador de hoje.
    conclusionDate: n.ConclusionDate2 || n.ConclusionDate || null,
  };
}

/**
 * Normaliza colaboradores vindos de sessions/current.
 * sessions/current usa estrutura aninhada: Collaborators[].Collaborator.{Name, Code}
 * O fallback plano (c.Name) cobre variações futuras da API.
 */
function normalizarColaborador(c) {
  return {
    nome:      c.Collaborator?.Name || c.Name || '—',
    matricula: c.Collaborator?.Code || c.Code || '—',
    cargo:     '—',
  };
}

/**
 * Combina sessions/current (filtro Engelmig + metadados) + teamsstatus/V2 (notas).
 * Retorna array de equipes normalizado com contagem correta de concluídas.
 *
 * Fluxo:
 *   1. sessions/current  → lista de equipes Engelmig (CompanyId) + placa do veículo
 *   2. teamsstatus/V2    → Concluded[], Downloaded[], Executed[] para cada equipe
 *   3. Cruza os dois por Team.Id (fallback por Team.Name)
 *   4. Aplica acumulador diário como segurança
 */
async function getTeamsBySector(sectorId) {
  // Paralelo: sessions/current + V2 (via cache para evitar chamadas duplicadas)
  const [sessions, statusList] = await Promise.all([
    getSessions(sectorId),
    getV2Cached(sectorId),
  ]);

  // Filtra apenas sessões Engelmig (CompanyId só existe em sessions/current).
  // Não filtramos por data: sessões abertas de dias anteriores (equipe esqueceu de encerrar)
  // devem aparecer — a data de início fica visível no card para identificação.
  const todayBRT = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);

  const allEngelmig     = sessions.filter(s => s.Team?.CompanyId === ENGELMIG_COMPANY_ID);
  const engelmigSessions = allEngelmig; // sem corte de data — todas as sessões abertas

  // Loga quantas sessões são de dias anteriores (informativo)
  const antigas = allEngelmig.filter(s => s.BeginTime && s.BeginTime.slice(0, 10) < todayBRT);
  if (antigas.length > 0) {
    console.warn(
      `[WPA] ${sectorId}: ℹ️ ${antigas.length} sessão(ões) de dias anteriores ainda abertas` +
      ` (serão exibidas com destaque no monitor)`
    );
  }

  // Índice V2 do setor consultado
  const { byId: v2ByTeamId, byName: v2ByTeamName } = buildV2Index(statusList);

  console.log(
    `[WPA] ${sectorId}: ${sessions.length} sessões totais → ${engelmigSessions.length} Engelmig` +
    ` | ${statusList.length} entradas V2`
  );

  // Processamento assíncrono para suportar fallback de V2 entre setores
  const result = await Promise.all(engelmigSessions.map(async s => {
    const teamName     = (s.Team?.Name || '').trim();
    const teamId       = s.Team?.Id;
    const teamSectorId = s.SectorId || s.Sector?.Code || sectorId;

    // Busca dado V2: por ID primeiro (mais confiável), nome como fallback
    let v2 = (teamId && v2ByTeamId.get(teamId)) || v2ByTeamName.get(teamName);

    // Fallback cross-setor: quando V2 do setor atual não retorna dados da equipe,
    // tenta todos os outros setores conhecidos.
    // Ocorre quando o "setor de exibição" configurado no WPA difere do setor de login,
    // fazendo a equipe sumir do V2 com filterByExhibitionSector=true.
    if (!v2) {
      for (const altSector of ALL_SECTORS) {
        if (altSector === sectorId) continue; // já tentamos este
        try {
          const altList = await getV2Cached(altSector);
          const { byId: altById, byName: altByName } = buildV2Index(altList);
          v2 = (teamId && altById.get(teamId)) || altByName.get(teamName);
          if (v2) {
            console.log(`[WPA] ${sectorId}/${teamName}: V2 encontrado em setor alternativo (${altSector}) ✓`);
            break;
          }
        } catch (err) {
          console.warn(`[WPA] ${sectorId}/${teamName}: falha ao buscar V2 em ${altSector}:`, err.message);
        }
      }
    }

    let baixadas, executadas, concluidas, rejeitadas;

    if (v2) {
      // Concluded[] → força 'concluida' (inclui ExecutionStatus 4/5 que sumia antes)
      concluidas = (v2.Concluded || []).map(n => normalizarNotaV2(n, 'concluida'));

      // Downloaded[] → classifica pelo ExecutionStatus
      //   1/2   → baixada (aguardando na carteira)
      //   3/6/7 → executada (nota em andamento ativo)
      const downloadedNormed = (v2.Downloaded || []).map(n => normalizarNotaV2(n));
      baixadas = downloadedNormed.filter(n => n.status === 'baixada');

      // Executed[] → força 'executada' (subconjunto de Downloaded em execução ativa)
      const execBase = (v2.Executed || []).map(n => normalizarNotaV2(n, 'executada'));
      const execIds  = new Set(execBase.map(n => n.codigo));
      // Merge: Executed[] + Downloaded com ExecutionStatus 3/6/7 (sem duplicatas)
      const execFromDownloaded = downloadedNormed.filter(n => n.status === 'executada');
      executadas = [...execBase, ...execFromDownloaded.filter(n => !execIds.has(n.codigo))];

      // Rejected pode ser null na API
      rejeitadas = (v2.Rejected || []).map(n => normalizarNotaV2(n, 'rejeitada'));
    } else {
      console.warn(`[WPA] ${sectorId}/${teamName}: ⚠️ sem dados V2`);
      baixadas = []; executadas = []; concluidas = []; rejeitadas = [];
    }

    // carteiraCount = notas que a equipe tem no dispositivo (= "Em Campo" do WPA)
    const carteiraCount = baixadas.length + executadas.length;
    const allNotas      = [...baixadas, ...executadas, ...concluidas, ...rejeitadas];

    console.log(
      `[WPA]   ${sectorId}/${teamName}: ` +
      `início=${s.BeginTime?.slice(0, 16) || '?'} ` +
      `baixadas=${baixadas.length} exec=${executadas.length} ` +
      `conc=${concluidas.length} rej=${rejeitadas.length} ` +
      `carteira=${carteiraCount}${v2 ? '' : ' [SEM V2]'}`
    );

    return {
      id:           s.Id,
      sigla:        teamName,
      teamName,
      sectorId:     teamSectorId,
      regional:     REGIONAL_MAP[teamSectorId] || 'GUA',
      date:         s.BeginTime?.slice(0, 10) || new Date().toISOString().slice(0, 10),
      sessionBegin: s.BeginTime,
      sessionEnd:   s.EndTime || null,
      // Placa: só existe em sessions/current (V2 tem apenas VehicleCategory)
      vehiclePlate: s.Vehicle?.Code || '—',
      // Colaboradores: sessions/current usa estrutura aninhada Collaborator.{Name,Code}
      collaborators: (s.Collaborators || []).map(normalizarColaborador),
      relogins:    0,
      sessions:    [],
      deviceModel: s.Device?.Model || null,
      appVersion:  s.AppVersion   || null,
      // Campos enriquecidos do V2
      teamStatus:    v2?.Status        || s.TeamStatus || null,
      isOnline:      v2?.IsOnline      || false,
      isInLunchTime: v2?.IsInLunchTime || false,
      lastUpdate:    v2?.LastUpdate    || null,
      location:      v2?.Location      || null,
      carteiraCount,
      servicosPerfil: [...new Set(allNotas.map(n => n.tipoCode))],
      notasBaixadas:   baixadas,
      notasExecutadas: executadas,
      notasConcluidas: concluidas,
      notasRejeitadas: rejeitadas,
    };
  }));

  return result;
}

module.exports = {
  login,
  getToken,
  forceRefresh,
  getTokenStatus,
  wpaFetch,
  // Endpoints individuais (usados em rotas de debug)
  getSessions,
  getSessionDetail,
  getNoteDetail,
  getNotesExecution,
  getPreroute,
  getTeamStatusV2,
  // Principal
  getTeamsBySector,
  // Histórico
  getTeamsByDate,
  REGIONAL_MAP,
};
