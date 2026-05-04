/**
 * db/supabaseQueries.js
 * Queries de leitura usadas pelo Vercel (DATA_MODE=supabase) e pelos endpoints de histórico.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POLÍTICA DE PAGINAÇÃO (importante!)
 * ─────────────────────────────────────────────────────────────────────────────
 * O PostgREST do Supabase tem limite default de 1000 linhas por SELECT.
 * Queries que excedem esse limite são SILENCIOSAMENTE TRUNCADAS.
 *
 * Toda query desta camada deve seguir uma destas regras:
 *
 *   1. **Bounded por design** — A consulta tem WHERE/EQ que garante
 *      retorno < 1000 rows (ex: getMetas retorna 2 linhas; teams_current
 *      tem 1 row por equipe da whitelist, max ~60).
 *
 *   2. **`_selectAll(queryFactory)`** — Para qualquer query que pode
 *      crescer com o tempo (mês de dados, todas as notas de N dias,
 *      etc.). Pagina até esgotar os resultados (max 200 páginas).
 *
 *   3. **`_paginateTable()`** — Wrapper específico para export bruto
 *      por intervalo de datas (usado em getExportData).
 *
 *   4. **`.maybeSingle()` / `.single()`** — Para lookups por PK.
 *
 * Ao adicionar uma nova query, escolha a categoria certa e documente
 * no jsdoc qual ela é. Veja `_selectAll` abaixo para a implementação.
 *
 * Para verificar manualmente se uma query está truncando: rode em prod
 * com um mês cheio e cheque se data.length === 1000 (suspeito).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { getClient } = require('../services/supabaseClient');
const { isOficial, SET_ALL: _SET_OFICIAIS } = require('../services/equipesOficiais');
const { dateBRT } = require('../services/timeUtil');

/**
 * Filtra um array de linhas mantendo só registros de equipes oficiais.
 * `key` é o nome do campo com a sigla (default: 'team_name').
 */
function _onlyOficiais(rows, key = 'team_name') {
  if (!Array.isArray(rows)) return rows;
  return rows.filter(r => r && isOficial(r[key]));
}

/**
 * Executa uma query Supabase paginando até buscar todos os registros.
 * Contorna o limite de 1000 linhas/req do PostgREST.
 *
 * @param {() => any} queryFactory  fábrica que devolve um query builder NOVO
 *                                  (sem .range() aplicado) — chamado a cada página
 * @param {number} pageSize         tamanho da página (default 1000)
 * @returns {Promise<any[]>}        array completo de rows
 */
async function _selectAll(queryFactory, pageSize = 1000) {
  let allRows = [];
  let page = 0;
  // Limite de segurança: 200 páginas × 1000 = 200k linhas (impede loop infinito)
  const MAX_PAGES = 200;
  while (page < MAX_PAGES) {
    const q = queryFactory().range(page * pageSize, (page + 1) * pageSize - 1);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    allRows = allRows.concat(data);
    if (data.length < pageSize) break;
    page++;
  }
  if (page >= MAX_PAGES) {
    console.warn(`[_selectAll] limite de páginas atingido (${MAX_PAGES * pageSize} rows)`);
  }
  return allRows;
}

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
  // Filtra pela whitelist de equipes oficiais (sigla extraída de data.sigla ou data.teamName)
  return (data || [])
    .map(row => row.data)
    .filter(t => t && isOficial(t.sigla || t.teamName));
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
  // Pagina (snapshots a cada 15min × N dias × N equipes pode ultrapassar 1k)
  const rows0 = await _selectAll(() => {
    let q = sb
      .from('snapshots')
      .select('team_name, regional, sector_id, captured_at, date, data')
      .gte('date', de)
      .lte('date', ate)
      .order('captured_at', { ascending: false });
    if (regional && regional !== 'ALL') q = q.eq('regional', regional);
    return q;
  });
  // Aplica whitelist: só equipes oficiais entram no histórico
  const rows = _onlyOficiais(rows0, 'team_name');

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
  // Lê do nível por-equipe (paginado) e filtra pela whitelist antes de agregar
  const data = await _selectAll(() => filterByMonth(
    sb.from('team_daily_totals').select('team_name, regional, tipo_code, count'),
    yearMonth
  ));

  const totais = { GUA: {}, CAC: {} };
  _onlyOficiais(data, 'team_name').forEach(row => {
    if (!totais[row.regional]) totais[row.regional] = {};
    totais[row.regional][row.tipo_code] =
      (totais[row.regional][row.tipo_code] || 0) + row.count;
  });
  return totais;
}

async function getDailyHistory(yearMonth) {
  const sb = getClient();
  const data = await _selectAll(() => filterByMonth(
    sb.from('team_daily_totals').select('date, team_name, regional, tipo_code, count'),
    yearMonth
  ).order('date'));

  const byDate = {};
  _onlyOficiais(data, 'team_name').forEach(row => {
    const d = row.date;
    if (!byDate[d]) byDate[d] = { date: d, GUA: {}, CAC: {} };
    if (!byDate[d][row.regional]) byDate[d][row.regional] = {};
    byDate[d][row.regional][row.tipo_code] =
      (byDate[d][row.regional][row.tipo_code] || 0) + row.count;
  });
  return Object.values(byDate);
}

// ── HISTÓRICO POR SUBCATEGORIA ─────────────────────────────────────────────────

/**
 * Totais do mês por sub_code (regional × tipo × sub_code → count + quantidade).
 * Estrutura:
 *   { GUA: { 'MD/TL11': { count, quantidade }, 'DD/C93': { count, quantidade }, ... }, CAC: {...} }
 */
async function getSubcatMonthTotals(yearMonth, regional) {
  const sb = getClient();
  // Lê por equipe (paginado) e filtra pela whitelist antes de agregar
  const data = await _selectAll(() => {
    let q = filterByMonth(
      sb.from('team_daily_subcat_totals').select('team_name, regional, tipo, sub_code, count, quantidade'),
      yearMonth
    );
    if (regional) q = q.eq('regional', regional);
    return q;
  });

  const totais = { GUA: {}, CAC: {} };
  _onlyOficiais(data, 'team_name').forEach(row => {
    if (!totais[row.regional]) totais[row.regional] = {};
    const key = `${row.tipo}/${row.sub_code}`;
    if (!totais[row.regional][key]) totais[row.regional][key] = { count: 0, quantidade: 0 };
    totais[row.regional][key].count      += row.count;
    totais[row.regional][key].quantidade += Number(row.quantidade || 0);
  });
  return totais;
}

/**
 * Histórico diário por sub_code — uma linha por (date, regional) com map por sub_code.
 * Estrutura:
 *   [ { date, GUA: { 'MD/TL11': {count, quantidade}, ... }, CAC: {...} }, ... ]
 */
async function getSubcatDailyHistory(yearMonth, regional) {
  const sb = getClient();
  const data = await _selectAll(() => {
    let q = filterByMonth(
      sb.from('team_daily_subcat_totals').select('date, team_name, regional, tipo, sub_code, count, quantidade'),
      yearMonth
    ).order('date');
    if (regional) q = q.eq('regional', regional);
    return q;
  });

  const byDate = {};
  _onlyOficiais(data, 'team_name').forEach(row => {
    const d = row.date;
    if (!byDate[d]) byDate[d] = { date: d, GUA: {}, CAC: {} };
    if (!byDate[d][row.regional]) byDate[d][row.regional] = {};
    const key = `${row.tipo}/${row.sub_code}`;
    if (!byDate[d][row.regional][key]) {
      byDate[d][row.regional][key] = { count: 0, quantidade: 0 };
    }
    byDate[d][row.regional][key].count      += row.count;
    byDate[d][row.regional][key].quantidade += Number(row.quantidade || 0);
  });
  return Object.values(byDate);
}

/**
 * Ranking de equipes no mês por sub_code (X notas de C93 por equipe Y).
 * Retorna lista ordenada por count decrescente.
 *   [ { team_name, regional, sector_id, tipo, sub_code, count, quantidade } ]
 */
async function getSubcatTeamRanking(yearMonth, regional, tipo, subCode) {
  const sb = getClient();
  const data = await _selectAll(() => {
    let q = filterByMonth(
      sb.from('team_daily_subcat_totals').select('team_name, regional, sector_id, tipo, sub_code, count, quantidade'),
      yearMonth
    );
    if (regional) q = q.eq('regional', regional);
    if (tipo)     q = q.eq('tipo', tipo);
    if (subCode)  q = q.eq('sub_code', subCode);
    return q;
  });

  // Agrega por equipe (somando todos os dias do mês) — apenas equipes oficiais
  const byTeam = {};
  _onlyOficiais(data, 'team_name').forEach(row => {
    const k = `${row.team_name}|${row.tipo}|${row.sub_code}`;
    if (!byTeam[k]) {
      byTeam[k] = {
        team_name: row.team_name, regional: row.regional, sector_id: row.sector_id,
        tipo: row.tipo, sub_code: row.sub_code,
        count: 0, quantidade: 0,
      };
    }
    byTeam[k].count      += row.count;
    byTeam[k].quantidade += Number(row.quantidade || 0);
  });
  return Object.values(byTeam).sort((a, b) => b.count - a.count);
}

// ── HISTÓRICO POR EQUIPE ───────────────────────────────────────────────────────

/**
 * Ranking de equipes no mês — total de notas concluídas por equipe.
 * Retorna lista ordenada por total decrescente.
 */
async function getTeamRanking(yearMonth, regional) {
  const sb = getClient();
  const data = await _selectAll(() => {
    let query = filterByMonth(
      sb.from('team_daily_totals').select('team_name, regional, sector_id, tipo_code, count'),
      yearMonth
    );
    if (regional && regional !== 'ALL') query = query.eq('regional', regional);
    return query;
  });

  const teams = {};
  _onlyOficiais(data, 'team_name').forEach(row => {
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
  const data = await _selectAll(() => {
    let query = filterByMonth(
      sb.from('team_daily_totals').select('date, team_name, regional, tipo_code, count'),
      yearMonth
    ).order('date');
    if (teamName) query = query.eq('team_name', teamName);
    return query;
  });

  // Agrupa por date → team_name → tipo_code (somente equipes oficiais)
  const byDate = {};
  _onlyOficiais(data, 'team_name').forEach(row => {
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
  const data = await _selectAll(() => {
    let query = sb
      .from('team_daily_totals')
      .select('team_name, regional, sector_id, tipo_code, count');
    if (filters.de)                                     query = query.gte('date', filters.de);
    if (filters.ate)                                    query = query.lte('date', filters.ate);
    if (filters.regional && filters.regional !== 'ALL') query = query.eq('regional', filters.regional);
    if (filters.team     && filters.team     !== 'ALL') query = query.eq('team_name', filters.team);
    return query.order('team_name');
  });

  const teams = {};
  _onlyOficiais(data, 'team_name').forEach(row => {
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
  const tipos  = [...new Set(_onlyOficiais(data, 'team_name').map(r => r.tipo_code))].sort();
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
  // Usa lte() inclusivo direto — sem precisar de truque +1 dia/UTC
  const allRows = await _selectAll(() => {
    let q = sb
      .from('snapshots')
      .select('team_name, regional, sector_id, date, captured_at, data')
      .gte('date', de)
      .lte('date', ate)
      .order('captured_at', { ascending: false });
    if (teamName && teamName !== 'ALL') q = q.eq('team_name', teamName);
    if (regional && regional !== 'ALL') q = q.eq('regional', regional);
    return q;
  });

  // Filtra pela whitelist e mantém apenas o snapshot mais recente por (date, team_name)
  const latest = {};
  _onlyOficiais(allRows, 'team_name').forEach(r => {
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

// ── KPIs DO DIA (acumulador persistente — sobrevive a logoff de equipes) ──────

/**
 * Soma OS realizadas (executadas + concluídas) num range, agrupado por regional.
 * Lê de daily_totals (já filtrado por conclusionDate no cron) — preserva o
 * contador mesmo quando equipes encerram sessão e somem de teams_current.
 *
 * Aceita um único `date` (compat retrô) OU um par `(de, ate)`. Se `ate` for
 * omitido, vira igual a `de` (intervalo de um dia).
 *
 * Retorna { ALL, GUA, CAC } com a contagem total no período.
 */
async function getRealizadasDoDia(de, ate) {
  const sb = getClient();
  // Default = data BRT atual (UTC-3). toISOString() puro daria a data UTC,
  // que após 21:00 BRT já virou pra "amanhã" e retornaria zero indevidamente.
  const today = dateBRT();
  de  = de  || today;
  ate = ate || de;

  // Lê do nível por-equipe (paginado) e filtra pela whitelist antes de somar
  const data = await _selectAll(() => sb
    .from('team_daily_totals')
    .select('team_name, regional, count')
    .gte('date', de)
    .lte('date', ate)
  );

  const acc = { ALL: 0, GUA: 0, CAC: 0 };
  _onlyOficiais(data, 'team_name').forEach(r => {
    if (acc[r.regional] !== undefined) acc[r.regional] += r.count;
    acc.ALL += r.count;
  });
  return acc;
}

/**
 * Retorna daily_subcat_totals para uma data e regional, agregado em
 * { GUA: { L0: n, L1: n, ... }, CAC: { ... }, ALL: { ... } }
 * com quantidades separadas para DD (metros/pontos).
 */
async function getDailySubcatTotals(de, ate, regional) {
  const sb = getClient();
  const today = dateBRT();
  de  = de  || today;
  ate = ate || de;

  // Lê do nível por-equipe (paginado) e filtra pela whitelist antes de agregar
  const data = await _selectAll(() => {
    let query = sb
      .from('team_daily_subcat_totals')
      .select('team_name, regional, tipo, sub_code, count, quantidade')
      .gte('date', de)
      .lte('date', ate);
    if (regional && regional !== 'ALL') {
      query = query.eq('regional', regional);
    }
    return query;
  });

  const totais = { ALL: {}, GUA: {}, CAC: {} };
  const quantidades = { ALL: {}, GUA: {}, CAC: {} };
  _onlyOficiais(data, 'team_name').forEach(r => {
    const key = r.sub_code === 'OUTROS' ? `${r.tipo}_OUTROS` : r.sub_code;
    const reg = r.regional;
    if (!totais[reg]) totais[reg] = {};
    if (!quantidades[reg]) quantidades[reg] = {};
    totais[reg][key]   = (totais[reg][key]   || 0) + r.count;
    totais.ALL[key]    = (totais.ALL[key]    || 0) + r.count;
    if (r.quantidade != null) {
      quantidades[reg][key] = (quantidades[reg][key] || 0) + Number(r.quantidade);
      quantidades.ALL[key]  = (quantidades.ALL[key]  || 0) + Number(r.quantidade);
    }
  });
  return { totais, quantidades };
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

/**
 * Busca todas as linhas de uma tabela num intervalo, paginando para evitar o
 * limite de 1000 linhas do Supabase. Retorna array com todos os registros.
 */
async function _paginateTable(sb, tableName, selectFields, de, ate, regional) {
  const PAGE = 1000;
  let allRows = [], page = 0;
  while (true) {
    let q = sb
      .from(tableName)
      .select(selectFields)
      .gte('date', de)
      .lte('date', ate)
      .order('date')
      .range(page * PAGE, (page + 1) * PAGE - 1);
    if (regional && regional !== 'ALL') q = q.eq('regional', regional);
    const { data, error } = await q;
    if (error) throw new Error(`[export] ${tableName}: ${error.message}`);
    if (!data || data.length === 0) break;
    allRows = allRows.concat(data);
    if (data.length < PAGE) break;
    page++;
  }
  return allRows;
}

/**
 * Exporta dados brutos de todas as tabelas de histórico para um intervalo.
 * Retorna:
 *   daily_subcat:  daily_subcat_totals  (regional × tipo × sub_code + quantidade)
 *   team_subcat:   team_daily_subcat_totals (equipe × tipo × sub_code + quantidade)
 *   team_totais:   team_daily_totals    (equipe × tipo_code)
 *   daily_totais:  daily_totals         (regional × tipo_code)
 */
async function getExportData(de, ate, regional) {
  const sb = getClient();
  // Lê tudo do nível por-equipe; agrega "daily_*" filtrando pela whitelist
  const [team_subcat_raw, team_totais_raw] = await Promise.all([
    _paginateTable(sb, 'team_daily_subcat_totals',
      'date, team_name, regional, sector_id, tipo, sub_code, count, quantidade', de, ate, regional),
    _paginateTable(sb, 'team_daily_totals',
      'date, team_name, regional, sector_id, tipo_code, count', de, ate, regional),
  ]);

  const team_subcat = _onlyOficiais(team_subcat_raw, 'team_name');
  const team_totais = _onlyOficiais(team_totais_raw, 'team_name');

  // Re-agrega daily_subcat e daily_totais a partir das tabelas por equipe (já filtradas)
  const daily_subcat_map = {}; // key: date|regional|tipo|sub_code
  team_subcat.forEach(r => {
    const k = `${r.date}|${r.regional}|${r.tipo}|${r.sub_code}`;
    if (!daily_subcat_map[k]) {
      daily_subcat_map[k] = {
        date: r.date, regional: r.regional, tipo: r.tipo, sub_code: r.sub_code,
        count: 0, quantidade: 0,
      };
    }
    daily_subcat_map[k].count      += r.count;
    daily_subcat_map[k].quantidade += Number(r.quantidade || 0);
  });
  const daily_subcat = Object.values(daily_subcat_map);

  const daily_totais_map = {}; // key: date|regional|tipo_code
  team_totais.forEach(r => {
    const k = `${r.date}|${r.regional}|${r.tipo_code}`;
    if (!daily_totais_map[k]) {
      daily_totais_map[k] = {
        date: r.date, regional: r.regional, tipo_code: r.tipo_code, count: 0,
      };
    }
    daily_totais_map[k].count += r.count;
  });
  const daily_totais = Object.values(daily_totais_map);

  return { daily_subcat, team_subcat, team_totais, daily_totais };
}

/**
 * Performance de equipes num período: total OS, dias trabalhados, média OS/dia.
 * tipo: 'COMERCIAL' (team_name starts with EC), 'PLANTAO' (starts with EP), 'TODAS'
 */
async function getPerformanceEquipes(de, ate, regional, tipo) {
  const sb = getClient();
  const data = await _selectAll(() => {
    let query = sb
      .from('team_daily_totals')
      .select('team_name, regional, sector_id, tipo_code, count, date');
    if (de)                                     query = query.gte('date', de);
    if (ate)                                    query = query.lte('date', ate);
    if (regional && regional !== 'ALL')         query = query.eq('regional', regional);
    return query;
  });

  const teams = {};
  _onlyOficiais(data, 'team_name').forEach(row => {
    const name  = row.team_name;
    const upper = name.toUpperCase();
    if (tipo === 'COMERCIAL' && !upper.startsWith('EC')) return;
    if (tipo === 'PLANTAO'   && !upper.startsWith('EP')) return;
    if (!teams[name]) {
      teams[name] = {
        team_name:  name,
        regional:   row.regional,
        sector_id:  row.sector_id,
        total:      0,
        por_tipo:   {},
        dates:      new Set(),
        tipo_equipe: upper.startsWith('EC') ? 'COMERCIAL'
                   : upper.startsWith('EP') ? 'PLANTAO'
                   : 'OPERACIONAL',
      };
    }
    teams[name].total += row.count;
    teams[name].dates.add(row.date);
    teams[name].por_tipo[row.tipo_code] =
      (teams[name].por_tipo[row.tipo_code] || 0) + row.count;
  });

  const lista = Object.values(teams).map(t => {
    const dias = t.dates.size;
    return {
      team_name:        t.team_name,
      regional:         t.regional,
      sector_id:        t.sector_id,
      total:            t.total,
      dias_trabalhados: dias,
      media:            dias > 0 ? +(t.total / dias).toFixed(2) : 0,
      por_tipo:         t.por_tipo,
      tipo_equipe:      t.tipo_equipe,
    };
  }).sort((a, b) => b.media - a.media);

  return { equipes: lista, de, ate };
}

module.exports = {
  getRealizadasDoDia,
  getNoteDetailCache, setNoteDetailCache, filtrarNotesNaoCacheadas,
  getSetting, setSetting,
  getMetas, setMetas, getMetasCalculadas,
  getTeamsFromSupabase, getTeamsByDateFromSnapshots,
  getMonthTotals, getDailyHistory,
  getSubcatMonthTotals, getSubcatDailyHistory, getSubcatTeamRanking,
  getTeamRanking, getTeamDailyHistory,
  getTeamProducao,
  getTeamSessionHistory,
  getDailySubcatTotals,
  getPerformanceEquipes,
  getExportData,
};
