/**
 * db/supabaseQueries.js
 * Queries de leitura usadas pelo Vercel (DATA_MODE=supabase) e pelos endpoints de histórico.
 */

const { getClient } = require('../services/supabaseClient');

// ── UTILITÁRIOS ────────────────────────────────────────────────────────────────

/** Aplica filtro de intervalo de datas para um mês inteiro (evita LIKE em coluna DATE) */
function filterByMonth(query, yearMonth) {
  const [y, m] = yearMonth.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const start = `${yearMonth}-01`;
  const end   = `${ny}-${String(nm).padStart(2, '0')}-01`;
  return query.gte('date', start).lt('date', end);
}

/** Conta dias úteis (seg–sex) em um mês */
function diasUteisNoMes(year, month) {
  const total = new Date(year, month, 0).getDate();
  let count = 0;
  for (let d = 1; d <= total; d++) {
    const dow = new Date(year, month - 1, d).getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

/** Conta dias úteis (seg–sex) do dia 1 até `dia` inclusive */
function diasUteisAte(year, month, dia) {
  const lastDay = Math.min(dia, new Date(year, month, 0).getDate());
  let count = 0;
  for (let d = 1; d <= lastDay; d++) {
    const dow = new Date(year, month - 1, d).getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

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

/**
 * Retorna metas mensais com cálculos de meta diária, semanal e progresso.
 * yearMonth: 'YYYY-MM'
 */
async function getMetasCalculadas(yearMonth) {
  const [year, month] = yearMonth.split('-').map(Number);
  const hoje          = new Date();
  const isAtual       = hoje.getFullYear() === year && (hoje.getMonth() + 1) === month;
  const diaRef        = isAtual ? hoje.getDate() : new Date(year, month, 0).getDate();

  const totalDU      = diasUteisNoMes(year, month);
  const decorridos   = diasUteisAte(year, month, diaRef);
  const semanaAtual  = Math.ceil(diaRef / 7);

  const [metas, totais] = await Promise.all([getMetas(), getMonthTotals(yearMonth)]);

  const regionais = {};
  for (const regional of ['GUA', 'CAC']) {
    regionais[regional] = {};
    const metasReg  = metas[regional]  || {};
    const totaisReg = totais[regional] || {};

    for (const [tipo, mensal] of Object.entries(metasReg)) {
      const diaria     = mensal / 22;
      const semanal    = diaria * 5;
      const ateHoje    = diaria * decorridos;
      const realizado  = totaisReg[tipo] || 0;
      const percentual = ateHoje > 0 ? (realizado / ateHoje) * 100 : 0;

      regionais[regional][tipo] = {
        mensal,
        diaria:     +diaria.toFixed(1),
        semanal:    +semanal.toFixed(1),
        ateHoje:    +ateHoje.toFixed(1),
        realizado,
        percentual: +percentual.toFixed(1),
        saldo:      +(realizado - ateHoje).toFixed(1),
      };
    }
  }

  return { mes: yearMonth, diasUteisNoMes: totalDU, diasUteisDecorridos: decorridos, semanaAtual, regionais };
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

// ── HISTÓRICO REGIONAL ─────────────────────────────────────────────────────────

async function getMonthTotals(yearMonth) {
  const sb = getClient();
  const { data, error } = await filterByMonth(
    sb.from('daily_totals').select('regional, tipo_code, count'),
    yearMonth
  );
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
  const { data, error } = await filterByMonth(
    sb.from('daily_totals').select('date, regional, tipo_code, count'),
    yearMonth
  ).order('date');
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

// ── HISTÓRICO POR EQUIPE ───────────────────────────────────────────────────────

/**
 * Ranking de equipes no mês — total de notas concluídas por equipe.
 * Retorna lista ordenada por total decrescente.
 */
async function getTeamRanking(yearMonth, regional) {
  const sb = getClient();
  let query = filterByMonth(
    sb.from('team_daily_totals').select('team_name, regional, sector_id, tipo_code, count'),
    yearMonth
  );

  if (regional && regional !== 'ALL') query = query.eq('regional', regional);

  const { data, error } = await query;
  if (error) throw error;

  const teams = {};
  (data || []).forEach(row => {
    if (!teams[row.team_name]) {
      teams[row.team_name] = {
        team_name: row.team_name,
        regional:  row.regional,
        sector_id: row.sector_id,
        total:     0,
        por_tipo:  {},
      };
    }
    teams[row.team_name].total                       += row.count;
    teams[row.team_name].por_tipo[row.tipo_code]      =
      (teams[row.team_name].por_tipo[row.tipo_code] || 0) + row.count;
  });

  return Object.values(teams).sort((a, b) => b.total - a.total);
}

/**
 * Histórico dia a dia de uma equipe específica no mês.
 */
async function getTeamDailyHistory(yearMonth, teamName) {
  const sb = getClient();
  let query = filterByMonth(
    sb.from('team_daily_totals').select('date, team_name, regional, tipo_code, count'),
    yearMonth
  ).order('date');

  if (teamName) query = query.eq('team_name', teamName);

  const { data, error } = await query;
  if (error) throw error;

  // Agrupa por date → team_name → tipo_code
  const byDate = {};
  (data || []).forEach(row => {
    if (!byDate[row.date]) byDate[row.date] = { date: row.date, equipes: {} };
    const eq = byDate[row.date].equipes;
    if (!eq[row.team_name]) eq[row.team_name] = { team_name: row.team_name, regional: row.regional, total: 0, por_tipo: {} };
    eq[row.team_name].total                    += row.count;
    eq[row.team_name].por_tipo[row.tipo_code]   =
      (eq[row.team_name].por_tipo[row.tipo_code] || 0) + row.count;
  });

  return Object.values(byDate).map(d => ({ date: d.date, equipes: Object.values(d.equipes) }));
}

module.exports = {
  getMetas, setMetas, getMetasCalculadas,
  getTeamsFromSupabase,
  getMonthTotals, getDailyHistory,
  getTeamRanking, getTeamDailyHistory,
};
