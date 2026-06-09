/**
 * services/memoCache.js
 *
 * Cache em memória com TTL + single-flight.
 *
 *   const wrap = require('./memoCache').create({ ttlMs: 5*60*1000, name: 'desloc' });
 *   const cached = wrap(async (opts) => { ... }, opts => JSON.stringify(opts));
 *   await cached(opts);   // primeira chamada bate no DB
 *   await cached(opts);   // <5min depois → instantâneo
 *   // 4 chamadas concorrentes com mesma chave → 1 query, 3 aguardam a mesma promise
 *
 * Não substitui Redis em produção distribuída, mas para um app single-instance
 * (pm2 cluster=1) reduz drasticamente latência percebida em mudanças de filtro.
 */

function create({ ttlMs = 5 * 60 * 1000, name = 'cache', maxEntries = 200 } = {}) {
  const store = new Map();   // key → { value, expiresAt }
  const inflight = new Map(); // key → Promise

  function _prune() {
    if (store.size <= maxEntries) return;
    // remove os mais antigos (Map preserva ordem de inserção)
    const excess = store.size - maxEntries;
    let i = 0;
    for (const k of store.keys()) {
      if (i++ >= excess) break;
      store.delete(k);
    }
  }

  function _now() { return Date.now(); }

  /**
   * Embrulha uma função async com cache + single-flight.
   * @param {Function} fn — função async com payload variável
   * @param {Function} keyFn — recebe os args, retorna string-chave
   */
  function wrap(fn, keyFn) {
    return async function cached(...args) {
      const key = keyFn(...args);
      // 1. Hit válido?
      const hit = store.get(key);
      if (hit && hit.expiresAt > _now()) {
        return hit.value;
      }
      // 2. Já tem alguém computando essa chave? Aguarda.
      if (inflight.has(key)) {
        return inflight.get(key);
      }
      // 3. Computa, registra in-flight pra coalescer concorrentes.
      const promise = (async () => {
        try {
          const value = await fn(...args);
          store.set(key, { value, expiresAt: _now() + ttlMs });
          _prune();
          return value;
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, promise);
      return promise;
    };
  }

  function invalidate(predicate) {
    if (!predicate) {
      const n = store.size;
      store.clear();
      return n;
    }
    let n = 0;
    for (const [k, v] of store) {
      if (predicate(k, v)) { store.delete(k); n++; }
    }
    return n;
  }

  function stats() {
    return { name, size: store.size, inflight: inflight.size };
  }

  return { wrap, invalidate, stats };
}

module.exports = { create };
