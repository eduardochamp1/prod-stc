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
const { applyRegional, expandRegional } = require('../services/regionalGroups');

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
  const result = { GUA: {}, CAC: {}, SJC: {} };
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
  for (const regional of ['GUA', 'CAC', 'SJC']) {
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
    query = applyRegional(query, filters.regional);
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

  // Pra capturar o LOGOFF de equipes que viram a meia-noite, expande o range
  // de busca em +1 dia (snapshot da madrugada seguinte pode ter sessionEnd
  // preenchido com sessionBegin do dia filtrado). Esse "lookahead" é a mesma
  // regra usada em consolidateDay e detectDrift.
  const dPlus1 = new Date(ate + 'T12:00:00Z');
  dPlus1.setUTCDate(dPlus1.getUTCDate() + 1);
  const ateExpand = dPlus1.toISOString().slice(0, 10);

  // Pagina (snapshots a cada 15min × N dias × N equipes pode ultrapassar 1k)
  const rows0 = await _selectAll(() => {
    let q = sb
      .from('snapshots')
      .select('team_name, regional, sector_id, captured_at, date, data')
      .gte('date', de)
      .lte('date', ateExpand)
      .order('captured_at', { ascending: false });
    q = applyRegional(q, regional);
    return q;
  });
  // Aplica whitelist: só equipes oficiais entram no histórico
  const rows0Filt = _onlyOficiais(rows0, 'team_name');

  // Normaliza r.date pra string YYYY-MM-DD. O pg shim retorna coluna DATE como
  // objeto Date (ex: 2026-06-08T00:00:00.000Z) — comparações com strings via
  // >= / <= faziam coerção esquisita (Date.toString() = "Mon Jun 08 2026..." vs
  // string "2026-06-08") e zeravam o resultado. Bug descoberto em 08/06/2026
  // quando histórico retornava 0 teams apesar de 17k snapshots no range.
  rows0Filt.forEach(r => {
    if (r.date instanceof Date) r.date = r.date.toISOString().slice(0, 10);
    else if (typeof r.date === 'string') r.date = r.date.slice(0, 10);
  });

  if (!rows0Filt || rows0Filt.length === 0) return [];

  const isSingleDay = de === ate;

  if (isSingleDay) {
    // Dia único: precisamos resolver pra cada equipe o logon do PRIMEIRO snap do dia
    // (sessionBeginReal) e o logoff REAL (que pode estar num snap de date+1).
    //
    // Regra: filtra os snapshots cujo sessionBegin pertence ao dia filtrado.
    // Esses são os snapshots da SESSÃO desse dia (independente de quando foram
    // capturados — pode ser na madrugada seguinte).
    const pertenceAoDia = (snap) => {
      const sb1 = snap.data?.sessionBegin || snap.data?.session_begin;
      if (!sb1) return false;
      return String(sb1).slice(0, 10) === de;
    };

    // Filtra snaps que pertencem à sessão do dia alvo (pode incluir snaps de date+1)
    const rowsDoDia = rows0Filt.filter(r => r.date === de || pertenceAoDia(r));

    // Pra cada equipe, pega snap mais recente E mais antigo
    const latest = {};   // snapshot mais recente (com sessionEnd se já deslogou)
    const first  = {};   // snapshot mais antigo (sessionBegin original do dia)
    rowsDoDia.forEach(r => {
      if (!latest[r.team_name]) latest[r.team_name] = r;
      first[r.team_name] = r;  // como rows estão DESC, o último do loop é o mais antigo
    });

    return Object.values(latest)
      .sort((a, b) => a.team_name.localeCompare(b.team_name))
      .map(r => {
        const firstSnap = first[r.team_name];
        // Logon REAL = sessionBegin do primeiro snap que pertence à sessão desse dia
        const sb1 = firstSnap?.data?.sessionBegin || firstSnap?.data?.session_begin || null;
        const sbAtual = r.data?.sessionBegin || r.data?.session_begin || null;
        // Logoff REAL = sessionEnd do snap mais recente (pode estar em date+1)
        const seEnd   = r.data?.sessionEnd   || r.data?.session_end   || null;
        return {
          ...r.data,
          _snapshotAt:      r.captured_at,
          sessionBeginReal: sb1 || sbAtual,
          sessionEnd:       seEnd,
          relogouNoDia:     !!(sb1 && sbAtual && sb1 !== sbAtual),
        };
      });
  }

  // Para intervalo, continua usando o range original (sem expandir)
  const rows = rows0Filt.filter(r => r.date >= de && r.date <= ate);

  // Intervalo: snapshot base = o mais recente de cada equipe (para dados de sessão)
  // Notas concluídas/executadas/rejeitadas = acumuladas de todos os dias do período
  // (sem duplicar por código).
  const baseByTeam   = {};   // snapshot mais recente por equipe
  const notasByTeam  = {};   // Set de códigos já vistos por equipe + buckets

  // Percorre do mais recente para o mais antigo (já ordenado por captured_at desc)
  rows.forEach(r => {
    const name = r.team_name;
    if (!baseByTeam[name]) baseByTeam[name] = r;  // snapshot mais recente = base
    if (!notasByTeam[name]) notasByTeam[name] = { conc: [], exec: [], rej: [], codigos: new Set() };

    // Acumula notas de cada snapshot dedupicando por código (1 nota só conta 1x
    // mesmo aparecendo em vários snapshots do range).
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
    // Rejeitadas: histórico antes não acumulava — card "OS Rejeitadas" no
    // monitor histórico vinha sempre só do snapshot base (último dia), perdendo
    // todas as rejeições dos dias anteriores do range.
    (r.data?.notasRejeitadas || []).forEach(n => {
      const cod = n.codigo || n.code;
      if (cod && !notasByTeam[name].codigos.has(cod)) {
        notasByTeam[name].codigos.add(cod);
        notasByTeam[name].rej.push(n);
      }
    });
  });

  return Object.values(baseByTeam)
    .sort((a, b) => a.team_name.localeCompare(b.team_name))
    .map(r => {
      const name  = r.team_name;
      const notas = notasByTeam[name] || { conc: [], exec: [], rej: [] };
      return {
        ...r.data,
        notasConcluidas: notas.conc,
        notasExecutadas: notas.exec,
        notasRejeitadas: notas.rej,
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

  const totais = { GUA: {}, CAC: {}, SJC: {} };
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
    if (!byDate[d]) byDate[d] = { date: d, GUA: {}, CAC: {}, SJC: {} };
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
    q = applyRegional(q, regional);
    return q;
  });

  const totais = { GUA: {}, CAC: {}, SJC: {} };
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
    q = applyRegional(q, regional);
    return q;
  });

  const byDate = {};
  _onlyOficiais(data, 'team_name').forEach(row => {
    const d = row.date;
    if (!byDate[d]) byDate[d] = { date: d, GUA: {}, CAC: {}, SJC: {} };
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
    q = applyRegional(q, regional);
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
    query = applyRegional(query, regional);
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
    query = applyRegional(query, filters.regional);
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
    q = applyRegional(q, regional);
    return q;
  });

  // Normaliza r.date pra string ISO 'YYYY-MM-DD'. O pg driver retorna colunas
  // DATE como Date objects, e o resto da função usa r.date como chave de obj
  // e como string em .localeCompare(). Sem essa normalização, .localeCompare
  // dá TypeError silencioso e a função retorna lista vazia.
  for (const r of allRows) {
    if (r.date instanceof Date) {
      r.date = r.date.toISOString().slice(0, 10);
    }
  }

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
async function getRealizadasDoDia(de, ate, regional) {
  const sb = getClient();
  // Default = data BRT atual (UTC-3). toISOString() puro daria a data UTC,
  // que após 21:00 BRT já virou pra "amanhã" e retornaria zero indevidamente.
  const today = dateBRT();
  de  = de  || today;
  ate = ate || de;

  // Aplica filtro de regional no banco (suporta grupos: ES → IN (GUA,CAC)).
  // Sem isso, user ES via SJC nos totais via fallback shape pré-existente.
  const data = await _selectAll(() => applyRegional(
    sb.from('team_daily_totals')
      .select('team_name, regional, count')
      .gte('date', de)
      .lte('date', ate),
    regional
  ));

  // Shape do acc reflete só as regionais visíveis ao usuário.
  // Ex: user ES recebe { ALL, GUA, CAC } (sem SJC); user SJC recebe { ALL, SJC }.
  const regs = expandRegional(regional) || ['GUA', 'CAC', 'SJC'];
  const acc = { ALL: 0 };
  regs.forEach(r => { acc[r] = 0; });
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
async function getDailySubcatTotals(de, ate, regional, team) {
  const sb = getClient();
  const today = dateBRT();
  de  = de  || today;
  ate = ate || de;

  // Multi-select: team/regional aceitam CSV ("SIG1,SIG2"). Quando há vírgula,
  // usa IN; senão eq (mantém compat com chamadas legadas que passam string).
  const _csv = (v) => v && v !== 'ALL' && String(v).includes(',')
    ? String(v).split(',').map(s => s.trim()).filter(Boolean)
    : null;
  const teamsArr     = _csv(team);
  const regionaisArr = _csv(regional);

  const data = await _selectAll(() => {
    let query = sb
      .from('team_daily_subcat_totals')
      .select('team_name, regional, tipo, sub_code, count, quantidade')
      .gte('date', de)
      .lte('date', ate);
    if (regionaisArr)                            query = query.in('regional', regionaisArr);
    else                                         query = applyRegional(query, regional);
    if (teamsArr)                                query = query.in('team_name', teamsArr);
    else if (team && team !== 'ALL')             query = query.eq('team_name', team);
    return query;
  });

  // Shape reflete só as regionais visíveis ao usuário (ES vê GUA+CAC, não SJC).
  // Se regionaisArr veio explícito (multi-select), usa essa lista; senão expande.
  const regsVis = regionaisArr || expandRegional(regional) || ['GUA', 'CAC', 'SJC'];
  const totais = { ALL: {} };
  const quantidades = { ALL: {} };
  regsVis.forEach(r => { totais[r] = {}; quantidades[r] = {}; });
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
    q = applyRegional(q, regional);
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
  const [team_subcat_raw, team_totais_raw, notas_individuais] = await Promise.all([
    _paginateTable(sb, 'team_daily_subcat_totals',
      'date, team_name, regional, sector_id, tipo, sub_code, count, quantidade', de, ate, regional),
    _paginateTable(sb, 'team_daily_totals',
      'date, team_name, regional, sector_id, tipo_code, count', de, ate, regional),
    getNotasIndividuais(de, ate, regional),
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

  return { daily_subcat, team_subcat, team_totais, daily_totais, notas_individuais };
}

/**
 * Lista nota a nota (1 linha por OS) do período/regional, com:
 *   - codigo (número), uuid, equipe, regional, setor
 *   - data de conclusão (do snapshot mais recente que contém a nota)
 *   - tipo, sub_code, sub_categoria, quantidade  (de note_subcategorias)
 *   - status (concluida/executada/rejeitada/baixada)
 *   - endereco (de note_details, se cacheado)
 *
 * Estratégia: percorre snapshots do range, dedup por UUID mantendo apenas
 * o snapshot mais recente de cada nota (com status final do dia). Cruza
 * com note_subcategorias e note_details em chunks de 200.
 *
 * Whitelist aplicada: só notas de equipes oficiais entram no resultado.
 */
async function getNotasIndividuais(de, ate, regional) {
  const sb = getClient();
  de  = de  || dateBRT();
  ate = ate || de;

  // Pagina snapshots do range
  const snaps = await _selectAll(() => {
    let q = sb.from('snapshots')
      .select('team_name, regional, sector_id, captured_at, date, data')
      .gte('date', de).lte('date', ate)
      .order('captured_at', { ascending: false });
    q = applyRegional(q, regional);
    return q;
  });

  if (!snaps || snaps.length === 0) return [];

  // Whitelist nas equipes
  const rows = _onlyOficiais(snaps, 'team_name');

  // Dedup por UUID: pra cada nota, fica o snapshot MAIS recente
  // (rows já vem ordenado por captured_at DESC, então primeiro a setar é mais recente).
  const notaMap = new Map();   // noteId -> { ... }
  const LISTAS = [
    ['notasConcluidas', 'concluida'],
    ['notasExecutadas', 'executada'],
    ['notasRejeitadas', 'rejeitada'],
    ['notasBaixadas',   'baixada'  ],
  ];
  rows.forEach(r => {
    const t = r.data;
    if (!t) return;
    LISTAS.forEach(([listKey, statusFallback]) => {
      (t[listKey] || []).forEach(n => {
        const uuid = n.id;
        if (!uuid || notaMap.has(uuid)) return;
        notaMap.set(uuid, {
          uuid,
          numero:         n.codigo || '',
          tipo:           n.tipoCode || '',
          status:         n.status || statusFallback,
          conclusionDate: n.conclusionDate || null,
          date:           r.date,
          team_name:      r.team_name,
          regional:       r.regional,
          sector_id:      r.sector_id,
        });
      });
    });
  });

  const ids = [...notaMap.keys()];
  if (ids.length === 0) return [];

  // Cruza com note_subcategorias (em chunks de 200)
  const subcatMap = {};
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.from('note_subcategorias')
      .select('note_id, sub_code, sub_categoria, quantidade')
      .in('note_id', ids.slice(i, i + 200));
    (data || []).forEach(r => { subcatMap[r.note_id] = r; });
  }

  // Cruza com note_details pra ter endereço (em chunks de 200)
  const enderecoMap = {};
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.from('note_details')
      .select('note_id, payload')
      .in('note_id', ids.slice(i, i + 200));
    (data || []).forEach(r => {
      const e = r.payload?.endereco;
      enderecoMap[r.note_id] = {
        logradouro: e?.logradouro || '',
        bairro:     e?.bairro     || '',
        cidade:     e?.cidade     || '',
      };
    });
  }

  // Monta as linhas finais
  return ids.map(id => {
    const n  = notaMap.get(id);
    const sc = subcatMap[id] || {};
    const en = enderecoMap[id] || {};
    return {
      data:          n.date,
      numero:        n.numero,
      uuid:          n.uuid,
      equipe:        n.team_name,
      regional:      n.regional,
      setor:         n.sector_id,
      tipo:          n.tipo,
      sub_code:      sc.sub_code      || '',
      sub_categoria: sc.sub_categoria || '',
      quantidade:    sc.quantidade != null ? Number(sc.quantidade) : null,
      status:        n.status,
      motivo:        '',   // reservado para integração futura com BI EDP (rejeição/conta paga)
      logradouro:    en.logradouro,
      bairro:        en.bairro,
      cidade:        en.cidade,
      conclusionDate: n.conclusionDate,
    };
  }).sort((a, b) => {
    // Ordena por data desc, depois por equipe e número
    if (a.data !== b.data) return b.data.localeCompare(a.data);
    if (a.equipe !== b.equipe) return a.equipe.localeCompare(b.equipe);
    return (a.numero || '').localeCompare(b.numero || '');
  });
}

/**
 * Performance de equipes num período: total OS, dias trabalhados, média OS/dia.
 * tipo: 'COMERCIAL' (team_name starts with EC), 'PLANTAO' (starts with EP), 'TODAS'
 */
async function getPerformanceEquipes(de, ate, regional, tipo, team) {
  const sb = getClient();
  // Multi-select: team/regional aceitam CSV (igual getDailySubcatTotals)
  const _csv = (v) => v && v !== 'ALL' && String(v).includes(',')
    ? String(v).split(',').map(s => s.trim()).filter(Boolean)
    : null;
  const teamsArr     = _csv(team);
  const regionaisArr = _csv(regional);

  const data = await _selectAll(() => {
    let query = sb
      .from('team_daily_totals')
      .select('team_name, regional, sector_id, tipo_code, count, date');
    if (de)                                     query = query.gte('date', de);
    if (ate)                                    query = query.lte('date', ate);
    if (regionaisArr)                           query = query.in('regional', regionaisArr);
    else                                        query = applyRegional(query, regional);
    if (teamsArr)                               query = query.in('team_name', teamsArr);
    else if (team && team !== 'ALL')            query = query.eq('team_name', team);
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

/**
 * Retorna notas com checkpoints GPS de uma equipe em um dia específico.
 * Busca o snapshot mais recente do dia, extrai todas as notas (concluídas,
 * rejeitadas, executadas, baixadas), e enriquece com `note_details` (checkpoints).
 *
 * Categoria: Bounded por design — 1 snapshot + N note_details (< 200 notas/dia/equipe).
 *
 * @param {string} team  Sigla da equipe (ex: 'GUA01')
 * @param {string} date  Data no formato YYYY-MM-DD
 * @returns {{ notes, team, date, teamInfo }}
 */
async function getMapaEquipe(team, date) {
  const sb = getClient();

  // 1. Snapshot mais recente do dia (estado final — notas, sessão atual)
  const { data: snapRows, error: snapErr } = await sb
    .from('snapshots')
    .select('data, captured_at')
    .eq('team_name', team)
    .eq('date', date)
    .order('captured_at', { ascending: false })
    .limit(1);

  if (snapErr) throw new Error(`[getMapaEquipe] snapshots: ${snapErr.message}`);
  if (!snapRows || !snapRows.length) return { notes: [], team, date, teamInfo: {} };

  const snap     = snapRows[0];
  const snapData = snap.data || {};

  // 1b. PRIMEIRO snapshot do dia — pra capturar o sessionBegin REAL.
  // Equipes que deslogam/relogam durante o dia (instabilidade, fim de turno
  // intermediário etc.) têm sessionBegin diferente no último snapshot vs no
  // primeiro. Sem isso, o card de Sessão mostra a sessão MAIS RECENTE como
  // se fosse o início do dia, escondendo as horas trabalhadas pela manhã.
  const { data: firstRows } = await sb
    .from('snapshots')
    .select('data, captured_at')
    .eq('team_name', team)
    .eq('date', date)
    .order('captured_at', { ascending: true })
    .limit(1);
  const firstSnapData = (firstRows && firstRows[0]?.data) || null;

  // 2. Coletar notas de todos os status relevantes
  const STATUS_MAP = [
    ['notasConcluidas',  'concluida'],
    ['notasRejeitadas',  'rejeitada'],
    ['notasExecutadas',  'executada'],
    ['notasBaixadas',    'baixada'],
  ];

  const seen   = new Set();
  const merged = [];
  for (const [key, status] of STATUS_MAP) {
    const arr = snapData[key] || [];
    for (const n of arr) {
      if (!n.id || seen.has(n.id)) continue;
      seen.add(n.id);
      merged.push({ ...n, status });
    }
  }

  if (!merged.length) return { notes: [], team, date, teamInfo: _buildTeamInfo(snapData, firstSnapData) };

  // 3. Buscar note_details para os IDs coletados
  const ids = merged.map(n => n.id);
  const { data: details, error: detErr } = await sb
    .from('note_details')
    .select('note_id, numero, tipo, payload')
    .in('note_id', ids);

  if (detErr) throw new Error(`[getMapaEquipe] note_details: ${detErr.message}`);

  const detailMap = {};
  (details || []).forEach(d => { detailMap[d.note_id] = d; });

  // 4. Combinar e construir lista final
  const notes = merged.map(n => {
    const d        = detailMap[n.id];
    const payload  = d?.payload || {};
    const checkpoints = Array.isArray(payload.checkpoints) ? payload.checkpoints : [];
    return {
      id:           n.id,
      numero:       d?.numero   || n.numero   || n.number || '',
      tipo:         d?.tipo     || n.tipo     || n.type   || '',
      status:       n.status,
      subCategoria: n.subCategoria || n.sub_categoria || payload.subCategoria || '',
      checkpoints,
      endereco:     payload.endereco  || n.endereco  || {},
      datas:        payload.datas     || n.datas     || {},
      hasCached:    !!d,
    };
  });

  // 5. Ordenar pelo timestamp do ev:0 (partida)
  notes.sort((a, b) => {
    const depA = (a.checkpoints || []).find(c => c.event === 0);
    const depB = (b.checkpoints || []).find(c => c.event === 0);
    if (!depA && !depB) return 0;
    if (!depA) return 1;
    if (!depB) return -1;
    return new Date(depA.timestamp) - new Date(depB.timestamp);
  });

  return { notes, team, date, teamInfo: _buildTeamInfo(snapData, firstSnapData) };
}

// ── REJEIÇÕES ────────────────────────────────────────────────────────────────

/**
 * Motivos que NÃO contam pros indicadores Engelmig.
 *
 * Regra de negócio EDP (validada com cliente 25/05/2026):
 *   '0128' - "Baixa via Sistema" — o proprio sistema EDP faz a rejeicao
 *   automaticamente. Nao gera multa, glosa, nem entra nos indicadores oficiais
 *   da concessionaria. Por isso nao deve aparecer nos paineis Engelmig.
 *
 * Comportamento:
 *   - Notas que tem motivo_codes = ['0128'] (so esse) -> DESCARTADAS, nao
 *     contam como rejeitada em lugar nenhum.
 *   - Notas que tem motivo_codes = ['0128', '0031'] (misto) -> mantidas, mas
 *     o '0128' eh REMOVIDO do array motivo_codes/motivo_textos. Aparecem como
 *     rejeitadas pelo motivo legitimo (0031).
 *   - Notas sem motivo (motivo_codes = []) continuam contando como "sem motivo
 *     registrado" (independente dessa regra).
 *
 * Os dados crus em `note_rejections` ficam intactos — a exclusao eh so na
 * camada de leitura. Mudar a regra eh trivial (so editar a Set).
 */
const MOTIVOS_EXCLUIDOS_INDICADORES = new Set(['0128']);

/**
 * Aplica a exclusao de motivos numa lista de rejeicoes. Retorna nova lista
 * (nao muta input). Veja regra acima.
 */
function _aplicarExclusaoMotivos(rows) {
  const out = [];
  for (const r of rows) {
    const codes  = Array.isArray(r.motivo_codes)  ? r.motivo_codes  : [];
    const labels = Array.isArray(r.motivo_textos) ? r.motivo_textos : [];

    // Se a nota nao tinha motivo, mantem como esta (regra so mexe em
    // notas com motivo cadastrado).
    if (codes.length === 0) { out.push(r); continue; }

    // Filtra mantendo paridade index codes/labels.
    const newCodes  = [];
    const newLabels = [];
    let tinhaExcluido = false;
    for (let i = 0; i < codes.length; i++) {
      if (MOTIVOS_EXCLUIDOS_INDICADORES.has(codes[i])) {
        tinhaExcluido = true;
        continue;
      }
      newCodes.push(codes[i]);
      newLabels.push(labels[i] || codes[i]);
    }

    // Se a nota tinha SO motivos excluidos -> descarta (nao conta).
    if (tinhaExcluido && newCodes.length === 0) continue;

    // Senao, mantem nota com motivos filtrados.
    out.push({ ...r, motivo_codes: newCodes, motivo_textos: newLabels });
  }
  return out;
}

/**
 * Lê linhas de `note_rejections` no intervalo [de, ate] aplicando filtros opcionais.
 * Paginado (pode passar de 1000). Filtra whitelist de equipes oficiais.
 * Aplica regra de exclusao de motivos (ver MOTIVOS_EXCLUIDOS_INDICADORES).
 *
 * @param {object} opts
 * @param {string} opts.de            'YYYY-MM-DD'
 * @param {string} opts.ate           'YYYY-MM-DD'
 * @param {string} [opts.regional]    'GUA' | 'CAC' | 'ALL'
 * @param {string} [opts.team]        sigla específica
 * @param {string[]} [opts.tipos]     ['MD','SF',...]
 * @param {boolean} [opts.somenteComMotivo]  só linhas com reason_codes não vazio
 */
async function _fetchRejeicoes({ de, ate, regional, regionais, team, teams, tipos, somenteComMotivo } = {}) {
  const sb = getClient();
  const today = dateBRT();
  de  = de  || today;
  ate = ate || de;

  const rows = await _selectAll(() => {
    let q = sb.from('note_rejections')
      .select('note_id, numero, tipo, team_name, regional, sector_id, session_date, motivo_codes, motivo_textos, rejection_date, observacao, formulario, collaborator_codes, collaborator_names')
      .gte('session_date', de)
      .lte('session_date', ate);
    // Aceita tanto valor único (regional/team) quanto array (regionais/teams).
    // Quando array com 1 só, vira eq; com 2+, vira in.
    if (Array.isArray(regionais) && regionais.length > 0)      q = q.in('regional', regionais);
    else                                                        q = applyRegional(q, regional);
    if (Array.isArray(teams) && teams.length > 0)               q = q.in('team_name', teams);
    else if (team && team !== 'ALL')                            q = q.eq('team_name', team);
    if (Array.isArray(tipos) && tipos.length > 0)               q = q.in('tipo', tipos);
    return q;
  });

  let filtered = _onlyOficiais(rows, 'team_name');

  // Normaliza session_date e rejection_date pra strings ISO YYYY-MM-DD / ISO,
  // porque o pg driver retorna DATE/TIMESTAMPTZ como Date objects nativos —
  // o que quebra .localeCompare e o JSON.stringify gera "2026-05-24T03:00:00..."
  // em vez de "2026-05-24". A UI espera strings.
  for (const r of filtered) {
    if (r.session_date instanceof Date) {
      r.session_date = r.session_date.toISOString().slice(0, 10);
    }
    if (r.rejection_date instanceof Date) {
      r.rejection_date = r.rejection_date.toISOString();
    }
  }

  // Aplica regra de negocio: "Baixa via Sistema" e outros nao contam.
  // Notas com SO motivo excluido sao descartadas inteiramente.
  filtered = _aplicarExclusaoMotivos(filtered);

  if (somenteComMotivo) {
    filtered = filtered.filter(r => Array.isArray(r.motivo_codes) && r.motivo_codes.length > 0);
  }
  return filtered;
}

/**
 * KPIs agregados de rejeições no intervalo.
 * Retorna:
 *   {
 *     total, comMotivo, semMotivo,
 *     porRegional: { GUA: n, CAC: n },
 *     porTipo:     { MD: n, SF: n, ... },
 *     porMotivo:   [{ code, label, count }, ...]  (top 20),
 *     porEquipe:   [{ team, regional, count }, ...]  (top 20),
 *     porDia:      [{ date, count }, ...],
 *     executadasNoPeriodo  (do team_daily_totals — pra calcular % de rejeição)
 *   }
 */
// Motivos considerados "legítimos" — cliente já fez o acerto (Pix/conta paga),
// não conta como desvio operacional da equipe. Excluídos por padrão de todas
// as queries de rejeição. Use opts.incluirContaPaga=true pra incluir (auditoria).
// Match case-insensitive sobre motivo_textos (códigos podem variar).
const MOTIVOS_LEGITIMOS = new Set([
  'pix no wpa',
  'cliente apresentou conta paga',
  'conta paga no momento do corte',
]);

function _ehLegitima(row) {
  const textos = Array.isArray(row?.motivo_textos) ? row.motivo_textos : [];
  return textos.some(t => t && MOTIVOS_LEGITIMOS.has(String(t).trim().toLowerCase()));
}

function _aplicarFiltroLegitimas(rows, opts) {
  if (opts && opts.incluirContaPaga) return rows;
  return rows.filter(r => !_ehLegitima(r));
}

async function getRejeicoesTotais(de, ate, regional, opts = {}) {
  const sb = getClient();
  const today = dateBRT();
  de  = de  || today;
  ate = ate || de;

  let rows = await _fetchRejeicoes({
    de, ate, regional, regionais: opts.regionais,
    team: opts.team, teams: opts.teams,
    tipos: opts.tipos,
  });

  // Por padrão exclui rejeições "legítimas" (cliente já fez o acerto).
  rows = _aplicarFiltroLegitimas(rows, opts);

  // Filtro por código de motivo (mesma logica da getRejeicoesLista — pos-fetch
  // porque motivo_codes eh TEXT[]). Quando ativo, KPIs/paineis refletem so as
  // notas que tiveram pelo menos um dos motivos selecionados.
  if (Array.isArray(opts.motivos) && opts.motivos.length > 0) {
    const setM = new Set(opts.motivos);
    rows = rows.filter(r =>
      Array.isArray(r.motivo_codes) && r.motivo_codes.some(c => setM.has(c))
    );
  }

  const total = rows.length;
  let comMotivo = 0, semMotivo = 0;
  const porRegional = { GUA: 0, CAC: 0, SJC: 0 };
  const porTipo     = {};
  const motivoMap   = new Map();  // code → { code, label, count }
  const equipeMap   = new Map();  // team → { team, regional, count }
  const diaMap      = new Map();  // date → count

  for (const r of rows) {
    const codes  = Array.isArray(r.motivo_codes)  ? r.motivo_codes  : [];
    const labels = Array.isArray(r.motivo_textos) ? r.motivo_textos : [];
    if (codes.length > 0) comMotivo++; else semMotivo++;

    if (r.regional && porRegional[r.regional] !== undefined) porRegional[r.regional]++;
    if (r.tipo) porTipo[r.tipo] = (porTipo[r.tipo] || 0) + 1;

    if (codes.length === 0) {
      const k = '__SEM_MOTIVO__';
      const cur = motivoMap.get(k) || { code: k, label: 'Sem motivo registrado', count: 0 };
      cur.count++;
      motivoMap.set(k, cur);
    } else {
      codes.forEach((c, i) => {
        const lbl = labels[i] || c;
        const cur = motivoMap.get(c) || { code: c, label: lbl, count: 0 };
        cur.count++;
        motivoMap.set(c, cur);
      });
    }

    if (r.team_name) {
      const cur = equipeMap.get(r.team_name) || { team: r.team_name, regional: r.regional, count: 0 };
      cur.count++;
      equipeMap.set(r.team_name, cur);
    }

    if (r.session_date) {
      diaMap.set(r.session_date, (diaMap.get(r.session_date) || 0) + 1);
    }
  }

  const porMotivo = Array.from(motivoMap.values()).sort((a, b) => b.count - a.count).slice(0, 20);
  const porEquipe = Array.from(equipeMap.values()).sort((a, b) => b.count - a.count).slice(0, 20);

  // porDia: garante continuidade do calendario [de, ate] preenchendo 0 em dias
  // sem rejeicao. Sem isso, o grafico pula dias zerados (ex: depois do filtro
  // de 'Baixa via Sistema' alguns dias zeraram) e a media movel 7d usa janela
  // que nao corresponde a 7 dias reais de calendario.
  const porDia = [];
  if (de && ate) {
    const cur = new Date(de + 'T00:00:00Z');
    const end = new Date(ate + 'T00:00:00Z');
    while (cur <= end) {
      const isoDate = cur.toISOString().slice(0, 10);
      porDia.push({ date: isoDate, count: diaMap.get(isoDate) || 0 });
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
  }

  // Executadas no período (pra %): team_daily_totals filtrado
  const tdt = await _selectAll(() => {
    let q = sb.from('team_daily_totals')
      .select('team_name, regional, count')
      .gte('date', de)
      .lte('date', ate);
    q = applyRegional(q, regional);
    if (opts.team && opts.team !== 'ALL') q = q.eq('team_name', opts.team);
    return q;
  });
  let executadas = 0;
  _onlyOficiais(tdt, 'team_name').forEach(r => { executadas += (r.count || 0); });

  // % de rejeição por equipe (top 20 já)
  const tdtMap = new Map();
  _onlyOficiais(tdt, 'team_name').forEach(r => {
    tdtMap.set(r.team_name, (tdtMap.get(r.team_name) || 0) + (r.count || 0));
  });
  porEquipe.forEach(e => {
    const exec = tdtMap.get(e.team) || 0;
    e.executadas = exec;
    const denom = exec + e.count;
    e.percentual = denom > 0 ? +(100 * e.count / denom).toFixed(1) : null;
  });

  // Total de OCORRENCIAS de motivos no periodo. Diferente do `total` (notas
  // unicas) porque uma nota com 3 motivos contribui 3x aqui. Sempre vale
  // totalOcorrenciasMotivo >= comMotivo (igualdade quando ninguem tem >1 motivo).
  // Exclui a categoria sintetica '__SEM_MOTIVO__'.
  const totalOcorrenciasMotivo = Array.from(motivoMap.values())
    .filter(m => m.code !== '__SEM_MOTIVO__')
    .reduce((acc, m) => acc + m.count, 0);

  return {
    total, comMotivo, semMotivo,
    totalOcorrenciasMotivo,
    porRegional, porTipo, porMotivo, porEquipe, porDia,
    executadasNoPeriodo: executadas,
    percentualGeral: (executadas + total) > 0
      ? +(100 * total / (executadas + total)).toFixed(1)
      : null,
  };
}

/**
 * Lista detalhada de rejeições com paginação cliente-lado.
 * Aplica filtros + ordena por session_date desc.
 */
async function getRejeicoesLista(de, ate, regional, opts = {}) {
  const rowsRaw = await _fetchRejeicoes({
    de, ate, regional, regionais: opts.regionais,
    team: opts.team, teams: opts.teams,
    tipos: opts.tipos,
    somenteComMotivo: opts.somenteComMotivo,
  });

  // Por padrão exclui rejeições "legítimas" (cliente já fez o acerto).
  const rows = _aplicarFiltroLegitimas(rowsRaw, opts);

  // Filtro por código de motivo (após fetch porque é array)
  let filtered = rows;
  if (Array.isArray(opts.motivos) && opts.motivos.length > 0) {
    const setM = new Set(opts.motivos);
    filtered = filtered.filter(r =>
      Array.isArray(r.motivo_codes) && r.motivo_codes.some(c => setM.has(c))
    );
  }

  filtered.sort((a, b) => {
    const da = a.session_date || ''; const db = b.session_date || '';
    if (da !== db) return db.localeCompare(da);
    return (b.rejection_date || '').localeCompare(a.rejection_date || '');
  });

  const limit  = Math.min(Math.max(parseInt(opts.limit || 500, 10), 1), 5000);
  const offset = Math.max(parseInt(opts.offset || 0, 10), 0);

  return {
    total: filtered.length,
    limit, offset,
    rows: filtered.slice(offset, offset + limit),
  };
}

/**
 * Catálogo distinto de motivos vistos no período (pra alimentar dropdown de filtro).
 */
async function getRejeicoesMotivos(de, ate, regional, opts = {}) {
  const rowsRaw = await _fetchRejeicoes({ de, ate, regional, regionais: opts.regionais });
  // Por padrão exclui rejeições "legítimas" (cliente já fez o acerto).
  const rows = _aplicarFiltroLegitimas(rowsRaw, opts);
  const map = new Map();
  for (const r of rows) {
    const codes  = Array.isArray(r.motivo_codes)  ? r.motivo_codes  : [];
    const labels = Array.isArray(r.motivo_textos) ? r.motivo_textos : [];
    codes.forEach((c, i) => {
      const lbl = labels[i] || c;
      const cur = map.get(c) || { code: c, label: lbl, count: 0 };
      cur.count++;
      map.set(c, cur);
    });
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

function _buildTeamInfo(snapData, firstSnapData) {
  const currentBegin = snapData.sessionBegin || snapData.session_begin || null;
  const currentEnd   = snapData.sessionEnd   || snapData.session_end   || null;
  // sessionBegin do PRIMEIRO snapshot do dia = início real do trabalho
  const firstBegin = firstSnapData
    ? (firstSnapData.sessionBegin || firstSnapData.session_begin || null)
    : null;
  // Houve relogin se o primeiro snapshot tem um sessionBegin diferente do atual
  const hasRelogin = firstBegin && currentBegin && firstBegin !== currentBegin;
  return {
    regional:          snapData.regional || null,
    sessionBegin:      firstBegin || currentBegin,       // início REAL do dia
    sessionBeginAtual: hasRelogin ? currentBegin : null, // sessão atual (se relogou)
    sessionEnd:        currentEnd,
    relogou:           hasRelogin,
  };
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
  getNotasIndividuais,
  getMapaEquipe,
  getRejeicoesTotais, getRejeicoesLista, getRejeicoesMotivos,
};
