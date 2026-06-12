/**
 * db/wpaTokenStore.js
 * Read/write do token JWT compartilhado em Supabase.
 *
 * Multi-conta: cada conta WPA tem sua chave própria na tabela wpa_token.
 *   key='wpa'    → conta default (ES — Clarissa, GUA/CAC)  [legado]
 *   key='wpa:sp' → conta SP (SJC)
 *   key='wpa:<account>' → outras contas futuras
 *
 * A chave 'wpa' (sem prefixo) é mantida pra retrocompat — o sistema antigo
 * gravava lá. Novas contas usam 'wpa:<accountKey>'.
 *
 * Modelo de uso:
 *   1. wpaService.getToken(account) chama loadToken(account) — se válido,
 *      usa direto e evita login.
 *   2. Se loadToken() retornar null/expirado, faz login fresh e chama
 *      saveToken() pra cachear pros próximos.
 *   3. Em alta concorrência, o pior caso é múltiplos logins por conta
 *      até alguém escrever — benigno, todos os tokens são válidos.
 */

const { getClient } = require('../services/dbClient');

const LEGACY_KEY = 'wpa';                       // conta ES original
const SAFETY_MARGIN_MS = 60 * 1000; // considera "expirado" 60s antes do exp real

/**
 * Converte accountKey em row key da tabela wpa_token.
 * 'es' (default) → 'wpa' (legado, mantém retrocompat)
 * 'sp'           → 'wpa:sp'
 * 'qualquer'     → 'wpa:qualquer'
 */
function _rowKey(accountKey) {
  if (!accountKey || accountKey === 'es') return LEGACY_KEY;
  return `${LEGACY_KEY}:${accountKey}`;
}

/**
 * Lê o token cacheado se ainda válido (com margem de segurança de 60s).
 * Falhas de rede/Supabase retornam null silenciosamente — caller faz fallback
 * pro login direto (loadToken nunca deve quebrar o fluxo principal).
 *
 * @param {string} accountKey  'es' (default) ou 'sp'
 * @returns {Promise<{token, expiresAt, userId} | null>}
 */
async function loadToken(accountKey = 'es') {
  try {
    const sb = getClient();
    const { data, error } = await sb
      .from('wpa_token')
      .select('token, expires_at, user_id')
      .eq('key', _rowKey(accountKey))
      .maybeSingle();
    if (error || !data) return null;

    const expiresAt = new Date(data.expires_at).getTime();
    if (Number.isNaN(expiresAt)) return null;
    if (Date.now() >= expiresAt - SAFETY_MARGIN_MS) return null; // expirado / quase

    return { token: data.token, expiresAt, userId: data.user_id || null };
  } catch (err) {
    console.warn(`[wpaTokenStore] loadToken falhou (account=${accountKey}): ${err.message}`);
    return null;
  }
}

/**
 * Grava o token recém-obtido no cache. Falhas são logadas mas não propagam —
 * o token em memória do container atual continua válido, só não é compartilhado.
 *
 * @param {string} token
 * @param {number} expireAtMs   timestamp em ms (Date.now() + ttl)
 * @param {string|null} userId
 * @param {string} accountKey   'es' (default) ou 'sp'
 */
async function saveToken(token, expireAtMs, userId = null, accountKey = 'es') {
  try {
    const sb = getClient();
    const { error } = await sb
      .from('wpa_token')
      .upsert({
        key:        _rowKey(accountKey),
        token,
        expires_at: new Date(expireAtMs).toISOString(),
        user_id:    userId,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });
    if (error) {
      console.warn(`[wpaTokenStore] saveToken erro (account=${accountKey}): ${error.message}`);
    }
  } catch (err) {
    console.warn(`[wpaTokenStore] saveToken falhou (account=${accountKey}): ${err.message}`);
  }
}

module.exports = { loadToken, saveToken };
