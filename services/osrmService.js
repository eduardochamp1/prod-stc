/**
 * services/osrmService.js
 *
 * Consulta tempo/distância de rota dirigindo entre 2 pontos via OSRM
 * (Open Source Routing Machine — público, gratuito, sem API key).
 *
 * Endpoint público: https://router.project-osrm.org/route/v1/driving/{lng1,lat1};{lng2,lat2}
 *   Retorna: { routes: [{ duration, distance, geometry }] }
 *   - duration em segundos
 *   - distance em metros
 *   - geometry como polyline (encoded5) ou GeoJSON conforme overview
 *
 * IMPORTANTE — política de cache:
 *   Pra cada par (origem, destino) consultamos UMA vez e gravamos em
 *   `osrm_cache`. A malha viária do OSM não muda em escalas relevantes pra
 *   nosso uso. Coords são arredondados a 5 casas (~1m) na chave pra evitar
 *   explosão de cache por jitter de GPS.
 *
 * RATE LIMITING:
 *   A instância pública tem "fair use". Limitamos a 1 req/s por padrão.
 *   Caches reutilizam — após backfill inicial, o tráfego cai pra ~0.
 *
 * Limitações conhecidas do OSRM público:
 *   - Sem garantia de uptime
 *   - Pode banir IPs abusivos (limit ~1 req/s recomendado)
 *   - Tempos podem ser ligeiramente diferentes do Google Maps
 *     (estimativas conservadoras, sem tráfego em tempo real)
 */

const fetch = require('node-fetch');
const crypto = require('crypto');
const { getClient } = require('./supabaseClient');

const OSRM_HOST = process.env.OSRM_HOST || 'https://router.project-osrm.org';
const MIN_INTERVAL_MS = parseInt(process.env.OSRM_MIN_INTERVAL_MS || '1100', 10);  // ~1 req/s

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
    source:       'osrm_public',
  }, { onConflict: 'cache_key' });
}

/** Consulta OSRM e retorna { duration_sec, distance_m, geometry }. */
async function _fetchOsrm(oLat, oLng, dLat, dLng) {
  await _throttle();
  const url = `${OSRM_HOST}/route/v1/driving/${oLng},${oLat};${dLng},${dLat}?overview=full&geometries=geojson`;
  let res;
  try {
    res = await fetch(url, { timeout: 15000 });
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
    const fresh = await _fetchOsrm(oLat, oLng, dLat, dLng);
    await _writeCache(key, oLat, oLng, dLat, dLng, fresh);
    return fresh;
  } catch (err) {
    console.warn(`[osrm] ${err.message} (${oLat},${oLng}→${dLat},${dLng})`);
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
