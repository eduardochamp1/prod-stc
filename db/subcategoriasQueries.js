/**
 * db/subcategoriasQueries.js
 * Leitura/escrita da tabela note_subcategorias (cache persistente de classificação).
 *
 * O classificador (services/classifierService.js) gera as classificações.
 * Aqui só lemos do cache e gravamos em batch. Nunca chama WPA daqui.
 */

const { getClient } = require('../services/supabaseClient');

/**
 * Retorna o conjunto de UUIDs já classificados (para deduplicação rápida).
 */
async function getClassifiedIds() {
  const sb = getClient();
  const ids = new Set();
  let from = 0;
  const PAGE = 1000;
  // Paginação manual — Supabase limita a 1000 por requisição
  while (true) {
    const { data, error } = await sb
      .from('note_subcategorias')
      .select('note_id')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    data.forEach(r => ids.add(r.note_id));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return ids;
}

/**
 * Insere/atualiza várias classificações.
 * @param {Array<{note_id, numero, tipo, sub_code, sub_categoria, code, code_text, quantidade, raw}>} rows
 */
async function upsertSubcategorias(rows) {
  if (!rows || rows.length === 0) return 0;
  const sb = getClient();
  // upsert em chunks de 500 para evitar payload gigante
  const CHUNK = 500;
  let total = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await sb
      .from('note_subcategorias')
      .upsert(chunk, { onConflict: 'note_id' });
    if (error) throw error;
    total += chunk.length;
  }
  return total;
}

/**
 * Busca subcategorias de uma lista de UUIDs.
 * @param {string[]} noteIds
 * @returns {Promise<Object>} mapa note_id → { sub_code, sub_categoria, code, code_text, quantidade, tipo }
 */
async function getSubcategoriasByIds(noteIds) {
  if (!noteIds || noteIds.length === 0) return {};
  const sb = getClient();
  const out = {};
  // Supabase aceita IN com até ~1000 valores; quebra em chunks por segurança
  const CHUNK = 500;
  for (let i = 0; i < noteIds.length; i += CHUNK) {
    const chunk = noteIds.slice(i, i + CHUNK);
    const { data, error } = await sb
      .from('note_subcategorias')
      .select('note_id, tipo, sub_code, sub_categoria, code, code_text, quantidade')
      .in('note_id', chunk);
    if (error) throw error;
    (data || []).forEach(r => { out[r.note_id] = r; });
  }
  return out;
}

/**
 * Conta classificações por sub_code (útil para diagnóstico/dashboard).
 * @returns {Promise<Object>} { sub_code: count }
 */
async function getCountsBySubcode() {
  const sb = getClient();
  const counts = {};
  let from = 0;
  const PAGE = 1000;
  // Paginação manual — Supabase limita a 1000 por requisição (igual getClassifiedIds)
  while (true) {
    const { data, error } = await sb
      .from('note_subcategorias')
      .select('sub_code')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    data.forEach(r => { counts[r.sub_code] = (counts[r.sub_code] || 0) + 1; });
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return counts;
}

module.exports = {
  getClassifiedIds,
  upsertSubcategorias,
  getSubcategoriasByIds,
  getCountsBySubcode,
};
