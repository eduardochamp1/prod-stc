/**
 * services/supabaseClient.js
 * Cliente Supabase compartilhado (usa service_role key — só servidor, nunca browser).
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://iyadtjzehhebwojreudz.supabase.co';

let _client = null;

function getClient() {
  if (_client) return _client;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_KEY não configurada');
  _client = createClient(SUPABASE_URL, key);
  return _client;
}

module.exports = { getClient };
