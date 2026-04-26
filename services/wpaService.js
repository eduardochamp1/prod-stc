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

function normalizarSessao(s, notasPorEquipe = {}) {
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
  const [sessions, notasRaw] = await Promise.all([
    getSessions(sectorId),
    getNotesExecution(sectorId),
  ]);

  // Agrupa notas por nome de equipe
  const notasPorEquipe = {};
  notasRaw.forEach(n => {
    const nome = n.Team?.Name;
    if (!nome) return;
    if (!notasPorEquipe[nome]) notasPorEquipe[nome] = [];
    notasPorEquipe[nome].push(normalizarNota(n));
  });

  // Filtra apenas equipes da ENGELMIG
  const engelmigSessions = sessions.filter(s =>
    s.Team?.CompanyId === ENGELMIG_COMPANY_ID
  );

  console.log(`[WPA] ${sectorId}: ${sessions.length} sessões totais → ${engelmigSessions.length} da ENGELMIG`);

  return engelmigSessions.map(s => normalizarSessao(s, notasPorEquipe));
}

module.exports = { login, getToken, wpaFetch, getSessions, getNotesExecution, getPreroute, getTeamsBySector, REGIONAL_MAP };
