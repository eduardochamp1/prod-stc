/**
 * services/osrmService.js
 *
 * Consulta tempo/distância de rota dirigindo entre 2 pontos.
 *
 * PROVIDER: detectado automaticamente pelo env:
 *   - HERE_API_KEY setado  → HERE Routing v8 (preferido, 250k req/mes free)
 *   - senao                → OSRM publico (gratis, mas Fortinet bloqueia 403
 *                            na producao da Engelmig — so funciona em dev)
 *
 * Por que HERE: o servidor de producao esta atras de Fortinet que bloqueia
 * router.project-osrm.org. HERE (dominio business-categorized) passa.
 *
 * Cache: mesma tabela `osrm_cache` (nome historico, agnostico a provider).
 * Chave = md5 das coords arredondadas a 5 casas (~1m). Entries cacheados de
 * OSRM continuam validos mesmo apos migrar pra HERE — tempos sao similares.
 *
 * RATE LIMITING:
 *   - HERE: 100ms (10 req/s safety, free tier permite muito mais)
 *   - OSRM: 1100ms (~1 req/s, fair-use do publico)
 */

const fetch = require('node-fetch');
const https = require('https');
const crypto = require('crypto');
const { getClient } = require('./supabaseClient');

const HERE_API_KEY = process.env.HERE_API_KEY || '';
const PROVIDER = HERE_API_KEY ? 'here' : 'osrm';
const OSRM_HOST = process.env.OSRM_HOST || 'https://router.project-osrm.org';
const MIN_INTERVAL_MS = parseInt(
  process.env.ROUTING_MIN_INTERVAL_MS || (PROVIDER === 'here' ? '100' : '1100'),
  10
);

// Agent com TLS verification desabilitada — necessario pq o servidor de
// producao da Engelmig esta atras de Fortinet com TLS interception, e a CA
// raiz do Fortinet nao esta acessivel no servidor (firewall esconde do
// handshake e nao temos sudo pra instalar a CA via update-ca-certificates).
//
// Risco aceitavel pra routing API porque:
//   - request leva so coords (publicas), NAO leva auth body
//   - HERE_API_KEY vai na query string mas eh chave de API limitada (free
//     tier, sem privilegio destrutivo) — perda < custo de resolver TLS
//   - resposta vai pra cache local e nao executa nada
//   - trafego ja passa pelo Fortinet que controla a saida
//
// NAO COPIAR este pattern pra outros services sem analise — para tokens
// de usuario, dados sensiveis ou APIs com auth privilegiada isso ABRE
// caminho pra MITM real.
const _insecureAgent = new https.Agent({ rejectUnauthorized: false });

let _lastCall = 0;
async function _throttle() {
  const now = Date.now();
  const wait = MIN_INTERVAL_MS - (now - _lastCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastCall = Date.now();
}

/** Arredonda coord pra 5 casas (~1m precisão) — chave de cache estável. */
function _round(n) { return Math.round(n * 1e5) / 1e5; }

/** Chave determinística pra cache. */
function _cacheKey(oLat, oLng, dLat, dLng) {
  const s = `${_round(oLat)}:${_round(oLng)}:${_round(dLat)}:${_round(dLng)}`;
  return crypto.createHash('md5').update(s).digest('hex');
}

/**
 * Tenta achar no cache local.
 */
async function _readCache(key) {
  const sb = getClient();
  const { data, error } = await sb
    .from('osrm_cache')
    .select('duration_sec, distance_m, geometry')
    .eq('cache_key', key)
    .maybeSingle();
  if (error || !data) return null;
  return {
    duration_sec: data.duration_sec,
    distance_m:   data.distance_m,
    geometry:     data.geometry || null,
    cached:       true,
  };
}

async function _writeCache(key, oLat, oLng, dLat, dLng, payload) {
  const sb = getClient();
  await sb.from('osrm_cache').upsert({
    cache_key:    key,
    origin_lat:   _round(oLat),
    origin_lng:   _round(oLng),
    dest_lat:     _round(dLat),
    dest_lng:     _round(dLng),
    duration_sec: payload.duration_sec,
    distance_m:   payload.distance_m,
    geometry:     payload.geometry,
    source:       PROVIDER === 'here' ? 'here_v8' : 'osrm_public',
  }, { onConflict: 'cache_key' });
}

/** Consulta OSRM e retorna { duration_sec, distance_m, geometry }. */
async function _fetchOsrm(oLat, oLng, dLat, dLng) {
  await _throttle();
  const url = `${OSRM_HOST}/route/v1/driving/${oLng},${oLat};${dLng},${dLat}?overview=full&geometries=geojson`;
  let res;
  try {
    res = await fetch(url, { timeout: 15000, agent: _insecureAgent });
  } catch (err) {
    throw new Error(`OSRM fetch erro: ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`OSRM HTTP ${res.status}`);
  }
  const json = await res.json();
  if (json.code !== 'Ok' || !json.routes || !json.routes.length) {
    throw new Error(`OSRM sem rota: ${json.code || 'desconhecido'}`);
  }
  const r = json.routes[0];
  return {
    duration_sec: Math.round(r.duration),
    distance_m:   Math.round(r.distance),
    geometry:     r.geometry || null,   // GeoJSON LineString
    cached:       false,
  };
}

/**
 * Consulta HERE Routing v8 e retorna { duration_sec, distance_m, geometry }.
 * Docs: https://www.here.com/docs/bundle/routing-api-v8-api-reference/page/index.html
 *
 * Polyline vem em "flexible polyline" (formato proprietário HERE). Salvamos
 * como objeto { format, value } pra distinguir de GeoJSON. Pro mapa visual
 * (futuro), decodificar com pacote @here/flexpolyline.
 */
async function _fetchHere(oLat, oLng, dLat, dLng) {
  await _throttle();
  const url = `https://router.hereapi.com/v8/routes`
    + `?transportMode=car`
    + `&origin=${oLat},${oLng}`
    + `&destination=${dLat},${dLng}`
    + `&return=summary,polyline`
    + `&apiKey=${encodeURIComponent(HERE_API_KEY)}`;
  let res;
  try {
    res = await fetch(url, { timeout: 15000, agent: _insecureAgent });
  } catch (err) {
    throw new Error(`HERE fetch erro: ${err.message}`);
  }
  if (!res.ok) {
    let body = '';
    try { body = (await res.text()).slice(0, 150); } catch (_) {}
    throw new Error(`HERE HTTP ${res.status}: ${body}`);
  }
  const json = await res.json();
  const section = json.routes && json.routes[0] && json.routes[0].sections && json.routes[0].sections[0];
  if (!section || !section.summary) {
    throw new Error(`HERE sem rota: ${JSON.stringify(json).slice(0, 100)}`);
  }
  return {
    duration_sec: section.summary.duration,
    distance_m:   section.summary.length,
    geometry:     section.polyline ? { format: 'flexible_polyline', value: section.polyline } : null,
    cached:       false,
  };
}

/** Escolhe o provider baseado em env. */
async function _fetchRoute(oLat, oLng, dLat, dLng) {
  return PROVIDER === 'here'
    ? _fetchHere(oLat, oLng, dLat, dLng)
    : _fetchOsrm(oLat, oLng, dLat, dLng);
}

// ── API pública ──────────────────────────────────────────────────────────────

/**
 * Retorna duração + distância estimadas entre 2 pontos (driving).
 * Usa cache. Cacheia novos resultados.
 *
 * @returns {Promise<{ duration_sec, distance_m, geometry, cached }|null>}
 *   null se erro (logado). Chamador decide tratar (NaN, fallback, etc).
 */
async function getRoute(oLat, oLng, dLat, dLng) {
  if (
    typeof oLat !== 'number' || typeof oLng !== 'number' ||
    typeof dLat !== 'number' || typeof dLng !== 'number' ||
    !isFinite(oLat) || !isFinite(oLng) || !isFinite(dLat) || !isFinite(dLng)
  ) {
    return null;
  }
  // Origem == destino → 0 (não consulta)
  if (_round(oLat) === _round(dLat) && _round(oLng) === _round(dLng)) {
    return { duration_sec: 0, distance_m: 0, geometry: null, cached: true };
  }

  const key = _cacheKey(oLat, oLng, dLat, dLng);
  const cached = await _readCache(key);
  if (cached) return cached;

  try {
    const fresh = await _fetchRoute(oLat, oLng, dLat, dLng);
    await _writeCache(key, oLat, oLng, dLat, dLng, fresh);
    return fresh;
  } catch (err) {
    console.warn(`[routing:${PROVIDER}] ${err.message} (${oLat},${oLng}→${dLat},${dLng})`);
    return null;
  }
}

/**
 * Versão batch — útil pro backfill. Processa sequencialmente respeitando
 * throttle (~1s entre chamadas), mas cache hits são instantâneos.
 *
 * @param {Array<{oLat, oLng, dLat, dLng}>} pairs
 * @returns {Promise<Array<{duration_sec, distance_m, geometry, cached}|null>>}
 */
async function getRoutesBatch(pairs, onProgress) {
  const results = [];
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    const r = await getRoute(p.oLat, p.oLng, p.dLat, p.dLng);
    results.push(r);
    if (onProgress) onProgress(i + 1, pairs.length, r);
  }
  return results;
}

module.exports = { getRoute, getRoutesBatch, _cacheKey };
