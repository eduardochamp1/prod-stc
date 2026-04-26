/**
 * db/supabaseQueries.js
 * Queries de leitura/escrita usadas pelo Vercel (DATA_MODE=supabase).
 * Não faz chamadas ao WPA — apenas lê o que o servidor interno gravou.
 */

const { getClient } = require('../services/supabaseClient');

// ── METAS ──────────────────────────────────────────────────────────────────────

async function getMetas() {
  const sb = getClient();
  const { data, error } = await sb.from('metas').select('regional, data');
  if (error) throw error;
  const result = { GUA: {}, CAC: {} };
  (data || []).forEach(row => { result[row.regional] = row.data || {}; });
  return result;
}

async function setMetas(obj) {
  const sb = getClient();
  const rows = Object.entries(obj).map(([regional, data]) => ({ regional, data }));
  const { error } = await sb.from('metas').upsert(rows, { onConflict: 'regional' });
  if (error) throw error;
}

// ── EQUIPES ────────────────────────────────────────────────────────────────────

async function getTeamsFromSupabase(filters = {}) {
  const sb = getClient();
  let query = sb.from('teams_current').select('data, regional, updated_at');

  if (filters.regional && filters.regional !== 'ALL') {
    query = query.eq('regional', filters.regional);
  }

  const { data, error } = await query.order('team_name');
  if (error) throw error;
  return (data || []).map(row => row.data);
}

// ── HISTÓRICO ──────────────────────────────────────────────────────────────────

async function getMonthTotals(yearMonth) {
  const sb = getClient();
  const { data, error } = await sb
    .from('daily_totals')
    .select('regional, tipo_code, count')
    .like('date', `${yearMonth}-%`);
  if (error) throw error;

  const totais = { GUA: {}, CAC: {} };
  (data || []).forEach(row => {
    if (!totais[row.regional]) totais[row.regional] = {};
    totais[row.regional][row.tipo_code] =
      (totais[row.regional][row.tipo_code] || 0) + row.count;
  });
  return totais;
}

async function getDailyHistory(yearMonth) {
  const sb = getClient();
  const { data, error } = await sb
    .from('daily_totals')
    .select('date, regional, tipo_code, count')
    .like('date', `${yearMonth}-%`)
    .order('date');
  if (error) throw error;

  const byDate = {};
  (data || []).forEach(row => {
    const d = row.date;
    if (!byDate[d]) byDate[d] = { date: d, GUA: {}, CAC: {} };
    if (!byDate[d][row.regional]) byDate[d][row.regional] = {};
    byDate[d][row.regional][row.tipo_code] = row.count;
  });
  return Object.values(byDate);
}

module.exports = { getMetas, setMetas, getTeamsFromSupabase, getMonthTotals, getDailyHistory };
