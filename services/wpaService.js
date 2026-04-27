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

let _token    = null;
let _expireAt = 0;

// ── AUTH ──────────────────────────────────────────────────────────────────────

async function login() {
  const body = new URLSearchParams({
    Username: process.env.WPA_USERNAME || '',
    Password: process.env.WPA_PASSWORD || '',
  });

  const res = await fetch(`${WPA_AUTH}/identity/signin`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`WPA login falhou (${res.status}): ${txt.slice(0, 200)}`);
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

async function getToken() {
  if (!_token || Date.now() >= _expireAt - 60_000) {
    await login();
  }
  return _token;
}

/** Força novo login independente do TTL atual (usado pelo cron de renovação proativa). */
async function forceRefresh() {
  return login();
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

async function wpaFetch(path, options = {}) {
  const token = await getToken();
  const res = await fetch(`${WPA_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  });
  return res;
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

// Cache de V2 por setor — evita chamadas duplicadas quando equipes visitantes
// precisam buscar V2 do setor home numa mesma rodada de coleta.
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
      codigo:   String(n.Number || n.Id || ''),
      tipoCode: n.Type || '??',
      tipoNome: n.Type || '??',
      status,
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

// ── ACUMULADOR DIÁRIO ─────────────────────────────────────────────────────────
// Preserva notas concluídas/executadas vistas durante o dia.
// Garante que o contador não caia caso uma equipe encerre e reabra sessão.
const _acc = {
  date:  '',
  notes: new Map(),    // noteId → { tipoCode, teamName, regional, status }
};

function _accReset() {
  const today = new Date().toISOString().slice(0, 10);
  if (_acc.date !== today) {
    _acc.date = today;
    _acc.notes.clear();
    console.log('[WPA] Acumulador diário resetado para', today);
  }
}

function _accRecord(teams) {
  _accReset();
  teams.forEach(t => {
    const realizadas = [...(t.notasExecutadas || []), ...(t.notasConcluidas || [])];
    realizadas.forEach(n => {
      if (n.codigo && !_acc.notes.has(n.codigo)) {
        _acc.notes.set(n.codigo, {
          tipoCode: n.tipoCode,
          teamName: t.teamName,
          regional: t.regional,
          status:   n.status,
        });
        console.log(`[WPA] ★ Nota acumulada: equipe=${t.teamName} tipo=${n.tipoCode} nota=${n.codigo} status=${n.status}`);
      }
    });
  });
}

function _accApply(teams) {
  _accReset();
  if (_acc.notes.size === 0) return teams;

  const extrasExec = {};
  const extrasConc = {};
  _acc.notes.forEach((info, noteId) => {
    const nota = { codigo: noteId, tipoCode: info.tipoCode, tipoNome: info.tipoCode, status: info.status };
    if (info.status === 'executada') {
      if (!extrasExec[info.teamName]) extrasExec[info.teamName] = [];
      extrasExec[info.teamName].push(nota);
    } else {
      if (!extrasConc[info.teamName]) extrasConc[info.teamName] = [];
      extrasConc[info.teamName].push(nota);
    }
  });

  return teams.map(t => {
    const existentes = new Set([
      ...(t.notasExecutadas || []).map(n => n.codigo),
      ...(t.notasConcluidas || []).map(n => n.codigo),
    ]);
    const novasExec = (extrasExec[t.teamName] || []).filter(n => !existentes.has(n.codigo));
    const novasConc = (extrasConc[t.teamName] || []).filter(n => !existentes.has(n.codigo));
    if (novasExec.length === 0 && novasConc.length === 0) return t;
    return {
      ...t,
      notasExecutadas: [...(t.notasExecutadas || []), ...novasExec],
      notasConcluidas: [...(t.notasConcluidas || []), ...novasConc],
    };
  });
}

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
    codigo:   String(n.Number || n.Id || ''),
    tipoCode: n.Type || '??',
    tipoNome: n.Type || '??',
    status:   statusForcado || STATUS_V2[n.ExecutionStatus] || 'baixada',
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

    // Fallback: equipe visitante — busca V2 no setor home da equipe
    // (ocorre quando uma equipe loga em setor diferente do seu setor de origem)
    if (!v2 && teamSectorId !== sectorId) {
      try {
        const homeList = await getV2Cached(teamSectorId);
        const { byId: homeById, byName: homeByName } = buildV2Index(homeList);
        v2 = (teamId && homeById.get(teamId)) || homeByName.get(teamName);
        if (v2) {
          console.log(`[WPA] ${sectorId}/${teamName}: V2 encontrado no setor home (${teamSectorId}) ✓`);
        }
      } catch (err) {
        console.warn(`[WPA] ${sectorId}/${teamName}: falha ao buscar V2 fallback (${teamSectorId}):`, err.message);
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

  _accRecord(result);
  return _accApply(result);
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
  getNotesExecution,
  getPreroute,
  getTeamStatusV2,
  // Principal
  getTeamsBySector,
  // Histórico
  getTeamsByDate,
  REGIONAL_MAP,
};
