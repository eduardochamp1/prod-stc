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

const OFICIAIS_GUA_FALLBACK = [
  { sigla: 'EBGPR62', tipo: 'A2', placa: 'QMS9I79' },
  { sigla: 'EBGPR63', tipo: 'A3', placa: 'SFE8E68' },
  { sigla: 'EBGPR64', tipo: 'A3', placa: 'QUS4128' },
  { sigla: 'EBGPR65', tipo: 'A3', placa: 'TGX0G99' },
  { sigla: 'ECACH50', tipo: 'A1', placa: 'SIG1A15' },
  { sigla: 'ECANC50', tipo: 'L1', placa: 'TDY1C60' },
  { sigla: 'ECGPR51', tipo: 'L1', placa: 'SHQ6F47' },
  { sigla: 'ECGPR53', tipo: 'L1', placa: 'SH6F39'  },
  { sigla: 'ECGPR54', tipo: 'L1', placa: 'SHU2I02' },
  { sigla: 'ECGPR81', tipo: 'L1', placa: 'SHQ6F41' },
  { sigla: 'ECGPR82', tipo: 'L1', placa: 'SHU2H93' },
  { sigla: 'ECGPR90', tipo: 'L1', placa: 'TDY1C70' },
  { sigla: 'ECGPR91', tipo: 'L1', placa: 'TDY1C67' },
  { sigla: 'ECMRT50', tipo: 'L1', placa: 'TDY1C69' },
  { sigla: 'ECMRT51', tipo: 'A2', placa: 'SIH0G13' },
  { sigla: 'ECMRT80', tipo: 'L1', placa: 'TDY1C68' },
  { sigla: 'ECPIU50', tipo: 'A1', placa: 'SIG0A67' },
  { sigla: 'ECPIU90', tipo: 'L1', placa: 'TDY1C66' },
  { sigla: 'ECPKE50', tipo: 'A1', placa: 'RVW0D45' },
  { sigla: 'EPACH30', tipo: 'A1', placa: 'SIG0A46' },
  { sigla: 'EPANC30', tipo: 'A1', placa: 'RMP2F33' },
  { sigla: 'EPGPR30', tipo: 'A1', placa: 'SIG0A73' },
  { sigla: 'EPGPR31', tipo: 'A1', placa: 'SIG4C84' },
  { sigla: 'EPGPR32', tipo: 'A3', placa: 'SFD0F41' },
  { sigla: 'EPGPR33', tipo: 'A1', placa: 'SIF8B17' },
  { sigla: 'EPICO30', tipo: 'A1', placa: 'SNH8G77' },
  { sigla: 'EPMRT30', tipo: 'A2', placa: 'SIH0G17' },
  { sigla: 'EPMRT31', tipo: 'A3', placa: 'SFD0F63' },
  { sigla: 'EPMRT32', tipo: 'A1', placa: 'SIG4C86' },
  { sigla: 'EPPIU30', tipo: 'A3', placa: 'SFD0F63' },
  { sigla: 'EPPIU31', tipo: 'A1', placa: 'SIG0A63' },
];

const OFICIAIS_CAC_FALLBACK = [
  { sigla: 'EPCIT30', tipo: 'A1', placa: 'RVW0D46' },
  { sigla: 'EPCIT31', tipo: 'A1', placa: 'RVW0D53' },
  { sigla: 'EPCIT32', tipo: 'A2', placa: 'SIG4C88' },
  { sigla: 'EPVGA30', tipo: 'A1', placa: 'SIA6D14' },
  { sigla: 'EPRNS30', tipo: 'A1', placa: 'SIG4C92' },
  { sigla: 'EPVGA31', tipo: 'A1', placa: 'SIG0A56' },
  { sigla: 'EPALE30', tipo: 'A1', placa: 'SIG4C91' },
  { sigla: 'EPALE31', tipo: 'A1', placa: 'SIF8B13' },
  { sigla: 'EPGUI30', tipo: 'A1', placa: 'SIH0G14' },
  { sigla: 'EPGUI31', tipo: 'A1', placa: 'SIG0A40' },
  { sigla: 'EPMUQ30', tipo: 'A1', placa: 'SIG0A62' },
  { sigla: 'EPMSU31', tipo: 'A1', placa: 'SIH0G16' },
  { sigla: 'EPBJE31', tipo: 'A1', placa: 'SIG4C85' },
  { sigla: 'ECCIT50', tipo: 'L1', placa: 'TDY1C64' },
  { sigla: 'ECCIT51', tipo: 'L1', placa: 'TDY1C71' },
  { sigla: 'ECCIT53', tipo: 'L1', placa: 'TDY1C61' },
  { sigla: 'ECCIT55', tipo: 'L1', placa: 'TDY1C73' },
  { sigla: 'ECCIT56', tipo: 'L1', placa: 'TDY1C62' },
  { sigla: 'ECCIT70', tipo: 'A2', placa: 'SIG4C88' },
  { sigla: 'ECCIT80', tipo: 'A1', placa: 'RVW7J53' },
  { sigla: 'ECCIT81', tipo: 'A1', placa: 'SIG0A48' },
  { sigla: 'ECALE80', tipo: 'A1', placa: 'SFD0F53' },
  { sigla: 'ECGUI80', tipo: 'L1', placa: 'TDY1C72' },
  { sigla: 'ECCIT90', tipo: 'L1', placa: 'TDY1C65' },
  { sigla: 'ECVGA50', tipo: 'A2', placa: 'SIH0G15' },
  { sigla: 'ECALE50', tipo: 'L1', placa: 'SHQ6F37' },
  { sigla: 'ECMSU50', tipo: 'A1', placa: 'SIG0A48' },
  { sigla: 'ECGUI50', tipo: 'A2', placa: 'SIF8B11' },
  { sigla: 'ECBJE50', tipo: 'A1', placa: 'SIG0A72' },
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
      sigla: e.sigla, tipo: e.tipo, placa: e.placa, regional: e.regional,
    });
  }
  _activeList   = rows;
  _setGua       = setGua;
  _setCac       = setCac;
  _setAll       = new Set([...setGua, ...setCac]);
  _metaBySigla  = meta;
}

function _rebuildFromFallback() {
  const rows = [
    ...OFICIAIS_GUA_FALLBACK.map(e => ({ ...e, regional: 'GUA', ativo: true })),
    ...OFICIAIS_CAC_FALLBACK.map(e => ({ ...e, regional: 'CAC', ativo: true })),
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
    const { data, error } = await sb
      .from('equipes_oficiais')
      .select('sigla, regional, tipo, placa, ativo')
      .order('regional')
      .order('sigla');
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
