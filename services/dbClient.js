/**
 * services/dbClient.js
 *
 * Cliente compartilhado para o backend de dados: shim local sobre `pg`
 * (Postgres self-hosted), exposto com a API encadeável de PostgREST builder:
 *   getClient().from('tabela').select(...).eq(...).order(...)
 *
 * Requer DATABASE_URL no ambiente (lança erro claro se faltar). O acesso remoto
 * ao Supabase (@supabase/supabase-js) foi APOSENTADO em 22/07/2026 (Fase 4 /
 * P3-8) — a migração pro Postgres self-hosted foi concluída nas Fases 1–3.
 *
 * Use superuser/app-role apenas no servidor. NUNCA expor no browser.
 */

let _client = null;
let _mode   = null;     // 'pg'

function _init() {
  if (_client) return _client;

  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL não configurada — defina no .env ' +
      '(ex.: DATABASE_URL=postgresql://user:pass@localhost:5432/wpa_monitor).'
    );
  }

  const { Client } = require('./pgShim');
  _client = new Client();
  _mode   = 'pg';
  console.log('[dbClient] modo=pg (Postgres local via shim)');
  return _client;
}

function getClient() {
  return _init();
}

/** Retorna 'pg' | null (para diagnósticos). */
function getMode() {
  if (!_client) _init();
  return _mode;
}

module.exports = { getClient, getMode };
