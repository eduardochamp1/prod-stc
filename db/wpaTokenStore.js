/**
 * db/wpaTokenStore.js
 * Read/write do token JWT compartilhado em Supabase.
 *
 * Singleton key='wpa' — uma linha só na tabela wpa_token.
 *
 * Modelo de uso:
 *   1. wpaService.getToken() chama loadToken() — se vier válido (com margem
 *      de 60s), usa direto e evita login.
 *   2. Se loadToken() retornar null/expirado, faz login fresh e chama
 *      saveToken() pra cachear pros próximos.
 *   3. Em alta concorrência (vários containers logando simultaneamente),
 *      o pior caso é múltiplos logins até alguém escrever — benigno, todos
 *      os tokens são válidos, só desperdiça uma request a mais.
 */

const { getClient } = require('../services/supabaseClient');

const KEY = 'wpa';
const SAFETY_MARGIN_MS = 60 * 1000; // considera "expirado" 60s antes do exp real

/**
 * Lê o token cacheado se ainda válido (com margem de segurança de 60s).
 * Falhas de rede/Supabase retornam null silenciosamente — caller faz fallback
 * pro login direto (loadToken nunca deve quebrar o fluxo principal).
 *
 * @returns {Promise<{token, expiresAt, userId} | null>}
 */
async function loadToken() {
  try {
    const sb = getClient();
    const { data, error } = await sb
      .from('wpa_token')
      .select('token, expires_at, user_id')
      .eq('key', KEY)
      .maybeSingle();
    if (error || !data) return null;

    const expiresAt = new Date(data.expires_at).getTime();
    if (Number.isNaN(expiresAt)) return null;
    if (Date.now() >= expiresAt - SAFETY_MARGIN_MS) return null; // expirado / quase

    return { token: data.token, expiresAt, userId: data.user_id || null };
  } catch (err) {
    console.warn(`[wpaTokenStore] loadToken falhou: ${err.message}`);
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
 */
async function saveToken(token, expireAtMs, userId = null) {
  try {
    const sb = getClient();
    const { error } = await sb
      .from('wpa_token')
      .upsert({
        key:        KEY,
        token,
        expires_at: new Date(expireAtMs).toISOString(),
        user_id:    userId,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });
    if (error) {
      console.warn(`[wpaTokenStore] saveToken erro: ${error.message}`);
    }
  } catch (err) {
    console.warn(`[wpaTokenStore] saveToken falhou: ${err.message}`);
  }
}

module.exports = { loadToken, saveToken };
