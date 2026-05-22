/**
 * services/equipesOficiais.js
 * Whitelist de equipes oficiais (Guarapari + Cachoeiro).
 *
 * FONTE PRIMÁRIA: tabela `equipes_oficiais` no Supabase (migration 006).
 *   - Carregada com cache em memória + TTL de 60s
 *   - Refresh é assíncrono (não bloqueia lookup sync)
 *   - CRUD via /api/admin/equipes (não precisa redeploy)
 *
 * FALLBACK: lista hardcoded abaixo (OFICIAIS_*_FALLBACK).
 *   - Usada se Supabase off ou tabela vazia
 *   - Mantém o sistema operacional mesmo com banco fora do ar
 *
 * Apenas equipes ATIVAS (ativo=true) entram nos cálculos.
 */

// ──────────────────────────────────────────────────────────────────────────────
// FALLBACK HARDCODED (usado se a tabela Supabase estiver indisponível/vazia)
// ──────────────────────────────────────────────────────────────────────────────

// Versão maio/2026: 75 equipes (40 DESG + 35 DESC), tipos operacionais.
// Sincronizar com migration 007_equipes_oficiais_setor.sql.
//
// Regional é derivada do setor:
//   DESG → GUA, DEPT → GUA, DESC → CAC
// (Mapping também em services/wpaService.js REGIONAL_MAP — manter alinhado.)

const OFICIAIS_GUA_FALLBACK = [
  // BTZERO / CS
  { sigla: 'EBGPR62', setor: 'DESG', tipo: 'BTZERO' },
  { sigla: 'EBGPR63', setor: 'DESG', tipo: 'BTZERO' },
  { sigla: 'EBGPR64', setor: 'DESG', tipo: 'CS' },
  { sigla: 'EBGPR65', setor: 'DESG', tipo: 'BTZERO' },
  // Comercial
  { sigla: 'ECACH50', setor: 'DESG', tipo: 'COMERCIAL' },
  { sigla: 'ECANC50', setor: 'DESG', tipo: 'COMERCIAL' },
  { sigla: 'ECGPR51', setor: 'DESG', tipo: 'COMERCIAL' },
  { sigla: 'ECGPR53', setor: 'DESG', tipo: 'COMERCIAL' },
  { sigla: 'ECGPR54', setor: 'DESG', tipo: 'COMERCIAL' },
  { sigla: 'ECMRT50', setor: 'DESG', tipo: 'COMERCIAL' },
  { sigla: 'ECMRT51', setor: 'DESG', tipo: 'COMERCIAL' },
  { sigla: 'ECPIU50', setor: 'DESG', tipo: 'COMERCIAL' },
  { sigla: 'ECPKE50', setor: 'DESG', tipo: 'COMERCIAL' },
  // Corte L0 (ET*)
  { sigla: 'ETGPR15', setor: 'DESG', tipo: 'CORTE L0' },
  { sigla: 'ETGPR16', setor: 'DESG', tipo: 'CORTE L0' },
  { sigla: 'ETGPR17', setor: 'DESG', tipo: 'CORTE L0' },
  { sigla: 'ETGPR18', setor: 'DESG', tipo: 'CORTE L0' },
  { sigla: 'ETGPR19', setor: 'DESG', tipo: 'CORTE L0' },
  { sigla: 'ETMRT15', setor: 'DESG', tipo: 'CORTE L0' },
  { sigla: 'ETMRT16', setor: 'DESG', tipo: 'CORTE L0' },
  { sigla: 'ETPIU15', setor: 'DESG', tipo: 'CORTE L0' },
  { sigla: 'ETPKE15', setor: 'DESG', tipo: 'CORTE L0' },
  // Corte L1
  { sigla: 'ECGPR90', setor: 'DESG', tipo: 'CORTE L1' },
  { sigla: 'ECGPR91', setor: 'DESG', tipo: 'CORTE L1' },
  { sigla: 'ECPIU90', setor: 'DESG', tipo: 'CORTE L1' },
  // MD
  { sigla: 'ECGPR82', setor: 'DESG', tipo: 'MD' },
  // Plantão
  { sigla: 'EPACH30', setor: 'DESG', tipo: 'PLANTÃO' },
  { sigla: 'EPANC30', setor: 'DESG', tipo: 'PLANTÃO' },
  { sigla: 'EPGPR30', setor: 'DESG', tipo: 'PLANTÃO' },
  { sigla: 'EPGPR31', setor: 'DESG', tipo: 'PLANTÃO' },
  { sigla: 'EPGPR32', setor: 'DESG', tipo: 'PLANTÃO' },
  { sigla: 'EPGPR33', setor: 'DESG', tipo: 'PLANTÃO' },
  { sigla: 'EPICO30', setor: 'DESG', tipo: 'PLANTÃO' },
  { sigla: 'EPMRT30', setor: 'DESG', tipo: 'PLANTÃO' },
  { sigla: 'EPMRT31', setor: 'DESG', tipo: 'PLANTÃO' },
  { sigla: 'EPMRT32', setor: 'DESG', tipo: 'PLANTÃO' },
  { sigla: 'EPPIU30', setor: 'DESG', tipo: 'PLANTÃO' },
  { sigla: 'EPPIU31', setor: 'DESG', tipo: 'PLANTÃO' },
  // Ramal
  { sigla: 'ECGPR81', setor: 'DESG', tipo: 'RAMAL' },
  { sigla: 'ECMRT80', setor: 'DESG', tipo: 'RAMAL' },
];

const OFICIAIS_CAC_FALLBACK = [
  // Comercial
  { sigla: 'ECALE50', setor: 'DESC', tipo: 'COMERCIAL' },
  { sigla: 'ECBJE50', setor: 'DESC', tipo: 'COMERCIAL' },
  { sigla: 'ECCIT50', setor: 'DESC', tipo: 'COMERCIAL' },
  { sigla: 'ECCIT51', setor: 'DESC', tipo: 'COMERCIAL' },
  { sigla: 'ECCIT53', setor: 'DESC', tipo: 'COMERCIAL' },
  { sigla: 'ECCIT55', setor: 'DESC', tipo: 'COMERCIAL' },
  { sigla: 'ECCIT56', setor: 'DESC', tipo: 'COMERCIAL' },
  { sigla: 'ECGUI50', setor: 'DESC', tipo: 'COMERCIAL' },
  { sigla: 'ECMSU50', setor: 'DESC', tipo: 'COMERCIAL' },
  { sigla: 'ECVGA50', setor: 'DESC', tipo: 'COMERCIAL' },
  // Corte L0 (ET*)
  { sigla: 'ETALE15', setor: 'DESC', tipo: 'CORTE L0' },
  { sigla: 'ETCIT15', setor: 'DESC', tipo: 'CORTE L0' },
  { sigla: 'ETCIT16', setor: 'DESC', tipo: 'CORTE L0' },
  { sigla: 'ETCIT17', setor: 'DESC', tipo: 'CORTE L0' },
  { sigla: 'ETCIT18', setor: 'DESC', tipo: 'CORTE L0' },
  // Corte L1
  { sigla: 'ECCIT90', setor: 'DESC', tipo: 'CORTE L1' },
  // MD e Ramal
  { sigla: 'ECALE80', setor: 'DESC', tipo: 'MD E RAMAL' },
  { sigla: 'ECCIT80', setor: 'DESC', tipo: 'MD E RAMAL' },
  { sigla: 'ECCIT81', setor: 'DESC', tipo: 'MD E RAMAL' },
  { sigla: 'ECGUI80', setor: 'DESC', tipo: 'MD E RAMAL' },
  // Plantão
  { sigla: 'EPALE30', setor: 'DESC', tipo: 'PLANTÃO' },
  { sigla: 'EPALE31', setor: 'DESC', tipo: 'PLANTÃO' },
  { sigla: 'EPBJE31', setor: 'DESC', tipo: 'PLANTÃO' },
  { sigla: 'EPCIT30', setor: 'DESC', tipo: 'PLANTÃO' },
  { sigla: 'EPCIT31', setor: 'DESC', tipo: 'PLANTÃO' },
  { sigla: 'EPCIT32', setor: 'DESC', tipo: 'PLANTÃO' },
  { sigla: 'EPCIT33', setor: 'DESC', tipo: 'PLANTÃO' },
  { sigla: 'EPGUI30', setor: 'DESC', tipo: 'PLANTÃO' },
  { sigla: 'EPGUI31', setor: 'DESC', tipo: 'PLANTÃO' },
  { sigla: 'EPMSU31', setor: 'DESC', tipo: 'PLANTÃO' },
  { sigla: 'EPMUQ30', setor: 'DESC', tipo: 'PLANTÃO' },
  { sigla: 'EPRNS30', setor: 'DESC', tipo: 'PLANTÃO' },
  { sigla: 'EPVGA30', setor: 'DESC', tipo: 'PLANTÃO' },
  { sigla: 'EPVGA31', setor: 'DESC', tipo: 'PLANTÃO' },
  // Uso Mútuo
  { sigla: 'ECCIT70', setor: 'DESC', tipo: 'USO MUTUO' },
];

// ──────────────────────────────────────────────────────────────────────────────
// VALIDAÇÃO FAIL-FAST (do fallback hardcoded — Supabase tem CHECK + PK)
// ──────────────────────────────────────────────────────────────────────────────

(function _validarFallback() {
  const guaSet = new Set(OFICIAIS_GUA_FALLBACK.map(e => e.sigla.toUpperCase().trim()));
  const cacSet = new Set(OFICIAIS_CAC_FALLBACK.map(e => e.sigla.toUpperCase().trim()));
  const dup = [...guaSet].filter(s => cacSet.has(s));
  if (dup.length > 0) {
    throw new Error(
      `[equipesOficiais] sigla(s) duplicada(s) entre GUA e CAC no fallback: ${dup.join(', ')}.`
    );
  }
  for (const list of [['GUA', OFICIAIS_GUA_FALLBACK], ['CAC', OFICIAIS_CAC_FALLBACK]]) {
    const [reg, arr] = list;
    const seen = new Set();
    for (const e of arr) {
      const key = e.sigla.toUpperCase().trim();
      if (seen.has(key)) {
        throw new Error(`[equipesOficiais] sigla "${e.sigla}" duplicada em ${reg} (fallback).`);
      }
      seen.add(key);
    }
  }
})();

// ──────────────────────────────────────────────────────────────────────────────
// CACHE EM MEMÓRIA — lookups sync, refresh assíncrono
// ──────────────────────────────────────────────────────────────────────────────

// _activeList = [{sigla, regional, tipo, placa, ativo}, ...]
let _activeList     = null;   // populada por _rebuildFromFallback ou _doRefresh
let _setGua         = null;
let _setCac         = null;
let _setAll         = null;
let _metaBySigla    = null;
let _lastRefreshAt  = 0;
let _refreshPromise = null;
let _isFromSupabase = false;  // true se o cache veio do banco (não do fallback)

const REFRESH_TTL_MS = 60_000;

function _norm(sigla) {
  return String(sigla || '').toUpperCase().trim();
}

function _rebuildIndexesFromList(rows) {
  const setGua = new Set();
  const setCac = new Set();
  const meta   = new Map();
  for (const e of rows) {
    if (e.ativo === false) continue;  // soft delete
    const k = _norm(e.sigla);
    if (e.regional === 'GUA') setGua.add(k);
    else if (e.regional === 'CAC') setCac.add(k);
    meta.set(k, {
      sigla: e.sigla, setor: e.setor || null, tipo: e.tipo,
      placa: e.placa || null, regional: e.regional,
      // Escala configurada (turno previsto da equipe). Pode estar null se a
      // migration ainda não rodou ou se a equipe foi cadastrada sem escala.
      escala_inicio: e.escala_inicio || null,
      escala_fim:    e.escala_fim    || null,
    });
  }
  _activeList   = rows;
  _setGua       = setGua;
  _setCac       = setCac;
  _setAll       = new Set([...setGua, ...setCac]);
  _metaBySigla  = meta;
}

function _rebuildFromFallback() {
  // setor → regional: DESG/DEPT → GUA, DESC → CAC
  const setorToRegional = (s) => (s === 'DESC' ? 'CAC' : 'GUA');
  const rows = [
    ...OFICIAIS_GUA_FALLBACK.map(e => ({ ...e, regional: setorToRegional(e.setor), ativo: true })),
    ...OFICIAIS_CAC_FALLBACK.map(e => ({ ...e, regional: setorToRegional(e.setor), ativo: true })),
  ];
  _rebuildIndexesFromList(rows);
  _isFromSupabase = false;
}

// Inicializa cache com fallback no module load (lookups sync funcionam imediatamente)
_rebuildFromFallback();

async function _doRefresh() {
  try {
    const { getClient } = require('./supabaseClient');
    const sb = getClient();
    // Tenta com escala primeiro; se a migration ainda não rodou, faz fallback
    // sem essas colunas (não quebra o serviço).
    let { data, error } = await sb
      .from('equipes_oficiais')
      .select('sigla, setor, regional, tipo, placa, ativo, escala_inicio, escala_fim')
      .order('regional')
      .order('sigla');
    if (error && /escala_inicio|escala_fim/.test(error.message || '')) {
      console.warn('[equipesOficiais] colunas escala_inicio/fim não existem — rode migrations/add_escala_equipes.sql');
      const fb = await sb
        .from('equipes_oficiais')
        .select('sigla, setor, regional, tipo, placa, ativo')
        .order('regional')
        .order('sigla');
      data = fb.data;
      error = fb.error;
    }
    if (error) throw error;
    if (!data || data.length === 0) {
      console.warn('[equipesOficiais] tabela equipes_oficiais vazia — usando fallback hardcoded');
      _lastRefreshAt = Date.now();  // não fica retentando
      return;
    }
    _rebuildIndexesFromList(data);
    _isFromSupabase = true;
    _lastRefreshAt = Date.now();
    console.log(`[equipesOficiais] sincronizado do Supabase: ${data.length} equipes (${data.filter(e => e.ativo !== false).length} ativas)`);
  } catch (err) {
    console.warn(`[equipesOficiais] refresh falhou (${err.message}) — mantendo cache atual`);
    // Não atualiza _lastRefreshAt para tentar de novo na próxima
  }
}

function _maybeRefresh() {
  if (Date.now() - _lastRefreshAt < REFRESH_TTL_MS) return;
  if (_refreshPromise) return;  // já está atualizando
  _refreshPromise = _doRefresh().finally(() => { _refreshPromise = null; });
}

/**
 * Força refresh imediato (chamado após CRUD via API).
 * Aguarda o resultado para garantir que o próximo lookup já reflita a mudança.
 */
async function forceRefresh() {
  if (_refreshPromise) {
    await _refreshPromise;
    return;
  }
  _refreshPromise = _doRefresh().finally(() => { _refreshPromise = null; });
  await _refreshPromise;
}

// ──────────────────────────────────────────────────────────────────────────────
// API PÚBLICA
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Retorna true se a sigla está na whitelist (qualquer regional).
 * Se `regional` for fornecido (GUA/CAC), valida só dentro daquela regional.
 */
function isOficial(sigla, regional) {
  _maybeRefresh();
  const s = _norm(sigla);
  if (!s) return false;
  if (regional === 'GUA') return _setGua.has(s);
  if (regional === 'CAC') return _setCac.has(s);
  return _setAll.has(s);
}

/**
 * Retorna 'GUA' ou 'CAC' se a sigla for oficial, null caso contrário.
 */
function getRegional(sigla) {
  _maybeRefresh();
  const meta = _metaBySigla.get(_norm(sigla));
  return meta ? meta.regional : null;
}

/**
 * Filtra um array de equipes/objetos mantendo só os que têm sigla oficial.
 */
function filterOficiais(arr, siglaKey = 'sigla', regional) {
  if (!Array.isArray(arr)) return arr;
  return arr.filter(item => {
    const sig = item && (item[siglaKey] || item.teamName || item.team_name);
    return isOficial(sig, regional);
  });
}

/**
 * Retorna a lista completa de siglas oficiais (opcionalmente filtrada por regional).
 */
function getSiglas(regional) {
  _maybeRefresh();
  if (regional === 'GUA') return [..._setGua];
  if (regional === 'CAC') return [..._setCac];
  return [..._setAll];
}

/**
 * Retorna metadados completos { sigla, tipo, placa, regional } da equipe oficial.
 */
function getMeta(sigla) {
  _maybeRefresh();
  return _metaBySigla.get(_norm(sigla)) || null;
}

/**
 * Lista as equipes oficiais ATIVAS (use no /admin/health, etc).
 * Snapshot imutável — modificações em equipes não afetam o resultado retornado.
 */
function getOficiais(regional) {
  _maybeRefresh();
  const all = (_activeList || []).filter(e => e.ativo !== false);
  if (regional === 'GUA') return all.filter(e => e.regional === 'GUA').map(e => ({ ...e }));
  if (regional === 'CAC') return all.filter(e => e.regional === 'CAC').map(e => ({ ...e }));
  return all.map(e => ({ ...e }));
}

/**
 * Indica se o cache atual veio do Supabase (true) ou está usando o fallback (false).
 * Útil para o /admin/health mostrar a fonte da verdade ativa.
 */
function isFromSupabase() {
  return _isFromSupabase;
}

// Compatibilidade legada — exports usados em alguns locais (preferir getOficiais)
const OFICIAIS_GUA = OFICIAIS_GUA_FALLBACK;
const OFICIAIS_CAC = OFICIAIS_CAC_FALLBACK;

module.exports = {
  // Listas (preferir usar getOficiais para refletir whitelist editada)
  OFICIAIS_GUA, OFICIAIS_CAC,
  // Lookups
  isOficial, getRegional, filterOficiais, getSiglas, getMeta,
  // Cache control
  getOficiais, forceRefresh, isFromSupabase,
  // Sets diretos (legado — ainda usados em alguns testes)
  get SET_GUA() { _maybeRefresh(); return _setGua; },
  get SET_CAC() { _maybeRefresh(); return _setCac; },
  get SET_ALL() { _maybeRefresh(); return _setAll; },
};
