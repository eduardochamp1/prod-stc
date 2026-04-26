/**
 * services/wpaService.js
 * Integração com a API WPA EDP.
 *
 * Auth:  POST https://edp-wpa-po.azurewebsites.net/identity/signin  → JWT
 * API:   https://edp-wpa-web-api.azurewebsites.net
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
  if (now >= _expireAt)          return { valid: false, reason: 'expirado', expiresAt: new Date(_expireAt).toISOString(), expiresIn: '0s' };
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
 * GET /api/notes/execution?sectorId={sectorId}
 */
async function getNotesExecution(sectorId) {
  const res  = await wpaFetch(`/api/notes/execution?sectorId=${sectorId}`);
  if (!res.ok) throw new Error(`WPA notes/execution ${res.status}`);
  const data = await res.json();
  return data.Data?.Notes || [];
}

/**
 * Retorna carteira de notas (wallet) por equipe no setor.
 * GET /api/route/preroute?sectorId={sectorId}
 */
async function getPreroute(sectorId) {
  const res  = await wpaFetch(`/api/route/preroute?sectorId=${sectorId}`);
  if (!res.ok) throw new Error(`WPA preroute ${res.status}`);
  const data = await res.json();
  return data.Data || [];
}

// ── ACUMULADOR DIÁRIO ─────────────────────────────────────────────────────────
// Guarda IDs de notas concluídas observadas durante o dia.
// Quando uma nota passa de status 9 → 4 (sincronizada), ela some do endpoint
// de execução; o acumulador garante que o contador não caia para zero.
const _acc = {
  date:  '',           // 'YYYY-MM-DD' do dia atual
  notes: new Map(),    // noteId → { tipoCode, teamName, regional }
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
    // Acumula executadas (status 2) E concluídas (status 9/4) preservando o status original
    const realizadas = [...(t.notasExecutadas || []), ...(t.notasConcluidas || [])];
    realizadas.forEach(n => {
      if (n.codigo && !_acc.notes.has(n.codigo)) {
        // FIX: guarda o status original (não força 'concluida')
        _acc.notes.set(n.codigo, {
          tipoCode:  n.tipoCode,
          teamName:  t.teamName,
          regional:  t.regional,
          status:    n.status,   // preserva: 'executada' ou 'concluida'
        });
        console.log(`[WPA] ★ Nota acumulada: equipe=${t.teamName} tipo=${n.tipoCode} nota=${n.codigo} status=${n.status}`);
      }
    });
  });
}

function _accApply(teams) {
  _accReset();
  if (_acc.notes.size === 0) return teams;

  // Separa extras por status para reinserir na lista correta
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
    // IDs já presentes nas notas atuais
    const existentes = new Set([
      ...(t.notasExecutadas || []).map(n => n.codigo),
      ...(t.notasConcluidas || []).map(n => n.codigo),
    ]);
    const novasExec = (extrasExec[t.teamName] || []).filter(n => !existentes.has(n.codigo));
    const novasConc = (extrasConc[t.teamName] || []).filter(n => !existentes.has(n.codigo));
    if (novasExec.length === 0 && novasConc.length === 0) return t;
    // FIX: reinsere cada nota na lista correta conforme seu status original
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
 * Status das notas no WPA:
 *   1 = Baixada       (nota enviada ao dispositivo)
 *   2 = Aceita        (equipe aceitou / em execução)
 *   3 = Rejeitada
 *   4 = Exportada     (concluída / sincronizada)
 *   9 = Concluída mobile (pendente sincronização)
 */
const STATUS_LABEL = { 1: 'baixada', 2: 'executada', 3: 'rejeitada', 4: 'concluida', 9: 'concluida' };

function normalizarNota(n) {
  return {
    codigo:   String(n.Number || n.Id || ''),
    tipoCode: n.Type || '??',
    tipoNome: n.Type || '??',
    status:   STATUS_LABEL[n.Status] || 'baixada',
  };
}

function normalizarSessao(s, notasPorEquipe = {}, carteiraCount = 0) {
  const teamName = s.Team?.Name || '?';
  const sectorId = s.SectorId || s.Sector?.Code || 'DESG';
  const notas    = notasPorEquipe[teamName] || [];

  return {
    id:           s.Id,
    sigla:        teamName,
    teamName,
    sectorId,
    regional:     REGIONAL_MAP[sectorId] || 'GUA',
    date:         s.BeginTime?.slice(0, 10) || new Date().toISOString().slice(0, 10),
    sessionBegin: s.BeginTime,
    sessionEnd:   s.EndTime || null,
    vehiclePlate: s.Vehicle?.Code || '—',
    collaborators: (s.Collaborators || []).map(c => ({
      nome:      c.Collaborator?.Name || '—',
      matricula: c.Collaborator?.Code || '—',
      cargo:     '—',
    })),
    relogins:    0,
    sessions:    [],
    deviceModel: s.Device?.Model || null,
    appVersion:  s.AppVersion || null,
    teamStatus:  s.TeamStatus,
    carteiraCount,
    servicosPerfil: [...new Set(notas.map(n => n.tipoCode))],
    notasBaixadas:   notas.filter(n => n.status === 'baixada'),
    notasExecutadas: notas.filter(n => n.status === 'executada'),
    notasConcluidas: notas.filter(n => n.status === 'concluida'),
    notasRejeitadas: notas.filter(n => n.status === 'rejeitada'),
  };
}

/**
 * Combina sessões + notas de execução para um setor.
 * Retorna array de equipes normalizado.
 */
async function getTeamsBySector(sectorId) {
  const [sessions, notasRaw, preroute] = await Promise.all([
    getSessions(sectorId),
    getNotesExecution(sectorId),
    getPreroute(sectorId).catch(() => []),
  ]);

  // Monta mapa teamName → WalletCount a partir do preroute
  const walletMap = {};
  preroute.forEach(item => {
    const nome = (item.Name || '').trim();
    if (nome) walletMap[nome] = item.WalletCount || 0;
  });
  console.log(`[WPA] ${sectorId}: preroute ${preroute.length} equipes, carteira total=${preroute.reduce((s,i) => s + (i.WalletCount||0), 0)}`);

  // Filtra apenas equipes da ENGELMIG
  const engelmigSessions = sessions.filter(s =>
    s.Team?.CompanyId === ENGELMIG_COMPANY_ID
  );

  console.log(`[WPA] ${sectorId}: ${sessions.length} sessões totais → ${engelmigSessions.length} Engelmig | ${notasRaw.length} notas no setor`);

  // Indexa notas por nome de equipe E por ID de equipe (fallback)
  const notasPorNome = {};
  const notasPorId   = {};
  notasRaw.forEach(n => {
    const nome = (n.Team?.Name || '').trim();
    const id   = n.Team?.Id   || n.TeamId;
    const nota = normalizarNota(n);
    if (nome) {
      if (!notasPorNome[nome]) notasPorNome[nome] = [];
      notasPorNome[nome].push(nota);
    }
    if (id) {
      if (!notasPorId[id]) notasPorId[id] = [];
      notasPorId[id].push(nota);
    }
  });

  // Log amostral: quais nomes aparecem nas notas (para detectar mismatch)
  const nomesNasNotas = Object.keys(notasPorNome);
  if (nomesNasNotas.length > 0) {
    console.log(`[WPA] ${sectorId}: nomes nas notas (amostra): ${nomesNasNotas.slice(0, 8).join(', ')}`);
  }

  const result = engelmigSessions.map(s => {
    const teamName = (s.Team?.Name || '').trim();
    const teamId   = s.Team?.Id;

    // 1. Tenta por nome exato; 2. fallback por ID de equipe
    const notas = notasPorNome[teamName]
               || (teamId ? notasPorId[teamId] : null)
               || [];

    const conc     = notas.filter(n => n.status === 'concluida').length;
    const carteira = walletMap[teamName] ?? 0;
    if (walletMap[teamName] === undefined) {
      console.warn(`[WPA]   ${sectorId}/${teamName}: ⚠️ não encontrado no preroute — carteira=0`);
    } else {
      console.log(`[WPA]   ${sectorId}/${teamName}: ${notas.length} notas (${conc} concluídas, ${carteira} carteira)`);
    }

    return normalizarSessao(s, { [teamName]: notas }, carteira);
  });

  // Registra concluídas no acumulador e reaplica (preserva notas status-4 que sumiram da API)
  _accRecord(result);
  return _accApply(result);
}

module.exports = { login, getToken, forceRefresh, getTokenStatus, wpaFetch, getSessions, getNotesExecution, getPreroute, getTeamsBySector, REGIONAL_MAP };
