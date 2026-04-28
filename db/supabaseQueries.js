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

  // Sem filtro de data estrita: exibe todas as sessões abertas, inclusive de dias anteriores
  // (equipes que esqueceram de encerrar a sessão ficam visíveis até encerrar no WPA).
  // A data de início aparece no card do monitor para identificação visual.
  //
  // Janela de segurança: descarta registros com mais de 7 dias para não acumular
  // lixo indefinidamente em casos extremos.
  const cutoff7 = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  let query = sb
    .from('teams_current')
    .select('data, regional, updated_at')
    .filter('data->>date', 'gte', cutoff7);

  if (filters.regional && filters.regional !== 'ALL') {
    query = query.eq('regional', filters.regional);
  }

  const { data, error } = await query.order('team_name');
  if (error) throw error;
  return (data || []).map(row => row.data);
}

/**
 * Retorna equipes de um período histórico via tabela snapshots.
 * Para um único dia (de === ate): snapshot mais recente do dia.
 * Para um intervalo: snapshot mais recente de cada equipe dentro do período,
 * com notas concluídas acumuladas de todos os dias do intervalo.
 * de, ate: 'YYYY-MM-DD'
 */
async function getTeamsByDateFromSnapshots(de, ate, regional) {
  const sb = getClient();
  let query = sb
    .from('snapshots')
    .select('team_name, regional, sector_id, captured_at, date, data')
    .gte('date', de)
    .lte('date', ate)
    .order('captured_at', { ascending: false });

  if (regional && regional !== 'ALL') {
    query = query.eq('regional', regional);
  }

  const { data: rows, error } = await query;
  if (error) throw error;

  if (!rows || rows.length === 0) return [];

  const isSingleDay = de === ate;

  if (isSingleDay) {
    // Dia único: snapshot mais recente por equipe
    const latest = {};
    rows.forEach(r => { if (!latest[r.team_name]) latest[r.team_name] = r; });
    return Object.values(latest)
      .sort((a, b) => a.team_name.localeCompare(b.team_name))
      .map(r => ({ ...r.data, _snapshotAt: r.captured_at }));
  }

  // Intervalo: snapshot base = o mais recente de cada equipe (para dados de sessão)
  // Notas concluídas = acumuladas de todos os dias do período (sem duplicar por código)
  const baseByTeam   = {};   // snapshot mais recente por equipe
  const notasByTeam  = {};   // Set de códigos já vistos por equipe

  // Percorre do mais recente para o mais antigo (já ordenado por captured_at desc)
  rows.forEach(r => {
    const name = r.team_name;
    if (!baseByTeam[name]) baseByTeam[name] = r;  // snapshot mais recente = base
    if (!notasByTeam[name]) notasByTeam[name] = { conc: [], exec: [], codigos: new Set() };

    // Acumula notas concluídas de cada snapshot dedupicando por código
    (r.data?.notasConcluidas || []).forEach(n => {
      const cod = n.codigo || n.code;
      if (cod && !notasByTeam[name].codigos.has(cod)) {
        notasByTeam[name].codigos.add(cod);
        notasByTeam[name].conc.push(n);
      }
    });
    (r.data?.notasExecutadas || []).forEach(n => {
      const cod = n.codigo || n.code;
      if (cod && !notasByTeam[name].codigos.has(cod)) {
        notasByTeam[name].codigos.add(cod);
        notasByTeam[name].exec.push(n);
      }
    });
  });

  return Object.values(baseByTeam)
    .sort((a, b) => a.team_name.localeCompare(b.team_name))
    .map(r => {
      const name  = r.team_name;
      const notas = notasByTeam[name] || { conc: [], exec: [] };
      return {
        ...r.data,
        notasConcluidas: notas.conc,
        notasExecutadas: notas.exec,
        _snapshotAt: r.captured_at,
        _period: `${de} → ${ate}`,
      };
    });
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

/**
 * Produção agregada por equipe com filtros livres de período, regional e equipe.
 * filters: { de, ate, regional, team }
 */
async function getTeamProducao(filters = {}) {
  const sb = getClient();
  let query = sb
    .from('team_daily_totals')
    .select('team_name, regional, sector_id, tipo_code, count');

  if (filters.de)                                     query = query.gte('date', filters.de);
  if (filters.ate)                                    query = query.lte('date', filters.ate);
  if (filters.regional && filters.regional !== 'ALL') query = query.eq('regional', filters.regional);
  if (filters.team     && filters.team     !== 'ALL') query = query.eq('team_name', filters.team);

  const { data, error } = await query.order('team_name');
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
    teams[row.team_name].total += row.count;
    teams[row.team_name].por_tipo[row.tipo_code] =
      (teams[row.team_name].por_tipo[row.tipo_code] || 0) + row.count;
  });

  const lista  = Object.values(teams).sort((a, b) => a.team_name.localeCompare(b.team_name));
  const tipos  = [...new Set((data || []).map(r => r.tipo_code))].sort();
  return { equipes: lista, tipos };
}

/**
 * Histórico de sessões por equipe no mês — com colaboradores, horários e notas por tipo.
 * Fonte: tabela snapshots (snapshot mais recente por date+team_name).
 * yearMonth: 'YYYY-MM'
 * teamName: nome exato da equipe ou null para todas
 * regional: 'GUA'|'CAC' ou null para todas
 */
async function getTeamSessionHistory(de, ate, teamName, regional) {
  const sb = getClient();
  const start = de;
  // ate é inclusivo — adiciona 1 dia para o upper bound exclusivo do Supabase
  const ateDate = new Date(ate + 'T12:00:00Z');
  ateDate.setDate(ateDate.getDate() + 1);
  const end = ateDate.toISOString().slice(0, 10);

  // Pagina até buscar todas as linhas do intervalo
  const pageSize = 1000;
  let allRows = [];
  let page = 0;
  while (true) {
    let q = sb
      .from('snapshots')
      .select('team_name, regional, sector_id, date, captured_at, data')
      .gte('date', start)
      .lt('date', end)
      .order('captured_at', { ascending: false })
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (teamName && teamName !== 'ALL') q = q.eq('team_name', teamName);
    if (regional && regional !== 'ALL') q = q.eq('regional', regional);

    const { data: rows, error } = await q;
    if (error) throw error;
    if (!rows || rows.length === 0) break;
    allRows = allRows.concat(rows);
    if (rows.length < pageSize) break;
    page++;
  }

  // Mantém apenas o snapshot mais recente por (date, team_name)
  const latest = {};
  allRows.forEach(r => {
    const key = `${r.date}|${r.team_name}`;
    if (!latest[key]) latest[key] = r;
  });

  // Agrupa por data → lista de equipes
  const byDate = {};
  Object.values(latest).forEach(r => {
    const d = r.data || {};
    const notas = [...(d.notasConcluidas || []), ...(d.notasExecutadas || [])];
    const por_tipo = {};
    notas.forEach(n => {
      const code = n.tipoCode || n.tipo_code;
      if (code) por_tipo[code] = (por_tipo[code] || 0) + 1;
    });

    if (!byDate[r.date]) byDate[r.date] = { date: r.date, equipes: [] };
    byDate[r.date].equipes.push({
      team_name:    r.team_name,
      regional:     r.regional,
      sector_id:    r.sector_id,
      total:        notas.length,
      por_tipo,
      collaborators: d.collaborators || [],
      sessionBegin:  d.sessionBegin  || null,
      sessionEnd:    d.sessionEnd    || null,
      vehiclePlate:  d.vehiclePlate  || null,
      relogins:      d.relogins      || 0,
      sessions:      d.sessions      || [],
    });
  });

  return Object.values(byDate)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(d => ({
      ...d,
      equipes: d.equipes.sort((a, b) => a.team_name.localeCompare(b.team_name)),
    }));
}

// ── NOTE DETAILS CACHE (payload completo das OS, populado pelo cron) ──────────

/**
 * Lê do cache local. Retorna { payload, fetched_at } ou null.
 * Pensado para ser leitura instantânea, com latência típica de 50-150ms.
 */
async function getNoteDetailCache(noteId) {
  const sb = getClient();
  const { data, error } = await sb
    .from('note_details')
    .select('payload, fetched_at')
    .eq('note_id', noteId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/**
 * Insere/atualiza uma OS no cache. Sempre upsert por note_id (UUID).
 * O payload deve ser o output do notaProcessor SEM fotos (incluirFotos=false).
 */
async function setNoteDetailCache(noteId, numero, tipo, sectorId, payload) {
  const sb = getClient();
  const { error } = await sb
    .from('note_details')
    .upsert(
      {
        note_id:    noteId,
        numero:     numero || null,
        tipo:       tipo   || null,
        sector_id:  sectorId || null,
        payload,
        fetched_at: new Date().toISOString(),
      },
      { onConflict: 'note_id' },
    );
  if (error) throw error;
}

/**
 * Filtra um lote de UUIDs e retorna apenas os que NÃO estão em cache.
 * Mais eficiente que ler todos os IDs e diff em memória — usa um IN no Supabase.
 */
async function filtrarNotesNaoCacheadas(noteIds) {
  if (!noteIds || noteIds.length === 0) return [];
  const sb = getClient();
  const { data, error } = await sb
    .from('note_details')
    .select('note_id')
    .in('note_id', noteIds);
  if (error) throw error;
  const existentes = new Set((data || []).map(r => r.note_id));
  return noteIds.filter(id => !existentes.has(id));
}

// ── APP SETTINGS (chave/valor compartilhado) ──────────────────────────────────

async function getSetting(key) {
  const sb = getClient();
  const { data, error } = await sb
    .from('app_settings')
    .select('data, updated_at')
    .eq('key', key)
    .maybeSingle();
  if (error) throw error;
  return data || null;          // { data, updated_at } ou null
}

async function setSetting(key, value) {
  const sb = getClient();
  const { error } = await sb
    .from('app_settings')
    .upsert({ key, data: value, updated_at: new Date().toISOString() },
            { onConflict: 'key' });
  if (error) throw error;
}

module.exports = {
  getNoteDetailCache, setNoteDetailCache, filtrarNotesNaoCacheadas,
  getSetting, setSetting,
  getMetas, setMetas, getMetasCalculadas,
  getTeamsFromSupabase, getTeamsByDateFromSnapshots,
  getMonthTotals, getDailyHistory,
  getTeamRanking, getTeamDailyHistory,
  getTeamProducao,
  getTeamSessionHistory,
};
