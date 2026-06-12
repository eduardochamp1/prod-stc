/**
 * services/dbClient.js
 *
 * Cliente compartilhado para o backend de dados. Dual-mode:
 *
 *   DATABASE_URL setado  → usa shim local sobre `pg` (Postgres self-hosted)
 *   senão                → usa @supabase/supabase-js (modo legado/transição)
 *
 * Ambos os modos expõem A MESMA API encadeável de PostgREST builder:
 *   getClient().from('tabela').select(...).eq(...).order(...)
 *
 * Use service_role / superuser apenas no servidor. NUNCA expor no browser.
 *
 * Logs no boot identificam qual modo está ativo, para evitar surpresa.
 */

let _client = null;
let _mode   = null;     // 'pg' | 'supabase'

function _init() {
  if (_client) return _client;

  const hasPg       = !!process.env.DATABASE_URL;
  const hasSupabase = !!process.env.SUPABASE_SERVICE_KEY;

  if (hasPg) {
    const { Client } = require('./pgShim');
    _client = new Client();
    _mode   = 'pg';
    console.log('[dbClient] modo=pg (Postgres local via shim)');
    return _client;
  }

  if (hasSupabase) {
    const { createClient } = require('@supabase/supabase-js');
    const URL = process.env.SUPABASE_URL || 'https://iyadtjzehhebwojreudz.supabase.co';
    _client = createClient(URL, process.env.SUPABASE_SERVICE_KEY);
    _mode   = 'supabase';
    console.log('[dbClient] modo=supabase (@supabase/supabase-js)');
    return _client;
  }

  throw new Error(
    'Nem DATABASE_URL nem SUPABASE_SERVICE_KEY configuradas. ' +
    'Defina uma delas no .env (DATABASE_URL=postgresql://... para Postgres local; ' +
    'SUPABASE_SERVICE_KEY=... para Supabase).'
  );
}

function getClient() {
  return _init();
}

/** Retorna 'pg' | 'supabase' | null (para diagnósticos). */
function getMode() {
  if (!_client) _init();
  return _mode;
}

module.exports = { getClient, getMode };
