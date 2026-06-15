/**
 * services/osrmService.js
 *
 * Consulta tempo/distância de rota dirigindo entre 2 pontos via OSRM.
 *
 * OSRM_HOST configura o endpoint. Em prod aponta pra Cloudflare Worker
 * (`osrm-proxy.jose-zouain.workers.dev`) que repassa pro OSRM publico —
 * router.project-osrm.org direto e bloqueado pelo Fortinet do servidor.
 * Free tier do Worker: 100k req/dia, sem cartao. Em dev, default vai
 * direto pro OSRM publico (sem Fortinet pra bloquear).
 *
 * Cache: tabela `osrm_cache` (md5 das coords arredondadas ~1m). Entries
 * cacheados de provedores antigos (HERE pre-jun/2026) continuam validos —
 * distancia/tempo sao similares.
 *
 * RATE LIMITING: 1100ms (~1 req/s) — fair-use do OSRM publico.
 * Cache hits sao instantaneos, so requests novas pagam o throttle.
 */

const fetch = require('node-fetch');
const https = require('https');
const crypto = require('crypto');
const { getClient } = require('./dbClient');

const OSRM_HOST = process.env.OSRM_HOST || 'https://router.project-osrm.org';
const MIN_INTERVAL_MS = parseInt(process.env.ROUTING_MIN_INTERVAL_MS || '1100', 10);

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
    source:       'osrm',
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
    console.warn(`[routing] ${err.message} (${oLat},${oLng}→${dLat},${dLng})`);
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
