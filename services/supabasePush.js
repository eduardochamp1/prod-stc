/**
 * services/supabasePush.js
 * Escrita no Supabase — snapshots, teams_current, daily_totals e team_daily_totals.
 */

const { getClient } = require('./supabaseClient');

// Data operacional BRT (UTC-3). Usar UTC daria a data errada após 21:00 BRT
// (quando UTC já virou pro dia seguinte) e desalinharia tudo com o front.
function _hojeBRT() {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

// Lock simples para serializar execuções concorrentes de pushTeams.
// Evita race condition onde upsert do ciclo A e delete do ciclo B se sobrepõem,
// resultando na remoção de equipes recém-escritas.
let _pushTeamsLock = false;

/**
 * Salva snapshot histórico das equipes na tabela `snapshots`.
 * Chamado a cada 15 min pelo cronService.
 */
async function saveSnapshot(teams, date) {
  if (!teams || teams.length === 0) return;
  const sb = getClient();
  date = date || _hojeBRT();

  const rows = teams.map(t => ({
    date,
    team_name:     t.teamName || t.sigla,
    sector_id:     t.sectorId,
    regional:      t.regional,
    session_begin: t.sessionBegin || null,
    session_end:   t.sessionEnd   || null,
    vehicle_plate: t.vehiclePlate || null,
    baixadas:      (t.notasBaixadas   || []).length,
    executadas:    (t.notasExecutadas || []).length,
    concluidas:    (t.notasConcluidas || []).length,
    rejeitadas:    (t.notasRejeitadas || []).length,
    data:          t,
  }));

  const { error } = await sb.from('snapshots').insert(rows);
  if (error) throw error;
  console.log(`[SUPABASE] snapshots: ${rows.length} equipes salvas`);
}

/**
 * Upsert do estado atual das equipes em `teams_current`.
 * Chamado a cada 15 min — substitui o registro anterior de cada equipe E remove
 * registros velhos de equipes que sumiram do sessions/current (sessão encerrada).
 *
 * Sem esse delete, equipes que deslogavam após meia-noite (EndTime preenchido em dia
 * diferente do BeginTime) ficavam pra sempre em teams_current com o estado pré-logout
 * (EndTime null), aparecendo no monitor como "Em campo · DIA ANT." indevidamente.
 */
async function pushTeams(teams) {
  if (!teams || teams.length === 0) return;

  // Se já há uma execução em andamento, aguarda até 10s antes de prosseguir
  const deadline = Date.now() + 10_000;
  while (_pushTeamsLock && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100));
  }
  if (_pushTeamsLock) {
    console.warn('[SUPABASE] pushTeams: lock expirou — prosseguindo mesmo assim para não travar o cron');
  }
  _pushTeamsLock = true;

  try {
    const sb = getClient();
    const now = new Date().toISOString();

    const rows = teams.map(t => ({
      team_name:  t.teamName,
      regional:   t.regional,
      sector_id:  t.sectorId,
      data:       t,
      updated_at: now,
    }));

    // 1) Upsert das equipes ativas no momento
    const { error: upErr } = await sb
      .from('teams_current')
      .upsert(rows, { onConflict: 'team_name' });
    if (upErr) throw upErr;

    // 2) TTL: remove linhas não atualizadas nos últimos 35 min (2x o ciclo de 15 min + buffer).
    //    Solução geral que cobre qualquer origem de linha órfã: ghost do _acc, stale data,
    //    falha do delete por nome, reinício do servidor, etc.
    //    Qualquer equipe não vista pelo cron em 35 min definitivamente não está mais no WPA.
    const ttlThreshold = new Date(Date.now() - 35 * 60 * 1000).toISOString();
    const { error: ttlErr, count: ttlCount } = await sb
      .from('teams_current')
      .delete({ count: 'exact' })
      .lt('updated_at', ttlThreshold);
    if (ttlErr) {
      console.warn('[SUPABASE] teams_current TTL: falha ao limpar linhas expiradas:', ttlErr.message);
    } else if (ttlCount > 0) {
      console.log(`[SUPABASE] teams_current TTL: ${ttlCount} linha(s) expirada(s) removida(s)`);
    }

    // 3) Delete por nome — segunda camada de segurança para equipes que
    //    possam ter sido upsertadas no mesmo ciclo com updated_at atualizado
    //    mas que já não estão mais no batch (ex: equipe sumiu entre upsert e delete).
    const aliveNames = teams.map(t => t.teamName);
    if (aliveNames.length > 0) {
      const { error: delErr, count } = await sb
        .from('teams_current')
        .delete({ count: 'exact' })
        .not('team_name', 'in', `(${aliveNames.join(',')})`)
        .gte('updated_at', ttlThreshold); // só linhas recentes (as expiradas já foram limpas acima)
      if (delErr) {
        console.warn('[SUPABASE] teams_current: falha ao limpar equipes ausentes:', delErr.message);
      } else if (count > 0) {
        console.log(`[SUPABASE] teams_current: ${count} equipe(s) removida(s) (não está no WPA)`);
      }
    }

    console.log(`[SUPABASE] teams_current: ${teams.length} equipes atualizadas`);
  } finally {
    _pushTeamsLock = false;
  }
}

/**
 * Verifica se uma nota foi concluída no dia-alvo. Equipes com sessão antiga
 * (dia anterior ainda aberta) carregam notas velhas em notasConcluidas — sem
 * esse filtro, elas entrariam no contador do dia de hoje indevidamente.
 *
 * Notas em "executada" (status 3/6/7 — em andamento agora) ficam sem
 * conclusionDate e são consideradas do dia atual (estão sendo feitas agora).
 */
function _belongsToDate(nota, date) {
  if (!nota.conclusionDate) return true;          // executada em andamento → conta hoje
  const cd = String(nota.conclusionDate).slice(0, 10);
  // ConclusionDate2 vem como ISO; ConclusionDate (UTC) também. slice(0,10) pega YYYY-MM-DD.
  if (/^\d{4}-\d{2}-\d{2}/.test(cd)) return cd === date;
  // Formato BR fallback DD/MM/YYYY
  const m = nota.conclusionDate.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}` === date;
  // Formato desconhecido → rejeita (não deixa nota fantasma entrar no contador)
  console.warn(`[SUPABASE] _belongsToDate: formato de data desconhecido ignorado: "${nota.conclusionDate}"`);
  return false;
}

/**
 * Atualiza `daily_totals` por regional/tipo (intraday — visão da regional).
 */
async function upsertDailyTotals(teams, date) {
  const sb = getClient();
  date = date || _hojeBRT();

  // Acumula por (regional, tipo_code) — evita duplicatas mesmo com múltiplas sessões por equipe
  const acc = {};
  teams.forEach(t => {
    const realizadas = [...(t.notasExecutadas || []), ...(t.notasConcluidas || [])];
    realizadas.forEach(n => {
      if (!_belongsToDate(n, date)) return;        // ignora notas de outros dias
      const code = n.tipoCode || n.tipo_code;
      if (!code) return;
      const key = `${t.regional}|${code}`;
      acc[key] = (acc[key] || 0) + 1;
    });
  });

  const rows = Object.entries(acc).map(([key, count]) => {
    const [regional, tipo_code] = key.split('|');
    return { date, regional, tipo_code, count };
  });

  if (rows.length === 0) return;

  const { error } = await sb
    .from('daily_totals')
    .upsert(rows, { onConflict: 'date,regional,tipo_code' });

  if (error) throw error;
  console.log(`[SUPABASE] daily_totals: ${rows.length} tipos atualizados para ${date}`);
}

/**
 * Atualiza `team_daily_totals` por equipe/tipo (intraday — visão individual).
 */
async function upsertTeamDailyTotals(teams, date) {
  const sb = getClient();
  date = date || _hojeBRT();

  // Acumula por (team_name, tipo_code) para evitar duplicatas quando
  // a mesma equipe aparece mais de uma vez no array (ex: múltiplas sessões no dia)
  const acc = {};
  teams.forEach(t => {
    const teamName = t.teamName || t.sigla;
    const realizadas = [...(t.notasExecutadas || []), ...(t.notasConcluidas || [])];
    realizadas.forEach(n => {
      if (!_belongsToDate(n, date)) return;        // ignora notas de outros dias
      const code = n.tipoCode || n.tipo_code;
      if (!code) return;
      const key = `${teamName}|${code}`;
      if (!acc[key]) {
        acc[key] = { date, team_name: teamName, regional: t.regional, sector_id: t.sectorId, tipo_code: code, count: 0 };
      }
      acc[key].count += 1;
    });
  });

  const rows = Object.values(acc);
  if (rows.length === 0) return;

  const { error } = await sb
    .from('team_daily_totals')
    .upsert(rows, { onConflict: 'date,team_name,tipo_code' });

  if (error) throw error;
  console.log(`[SUPABASE] team_daily_totals: ${rows.length} registros para ${date}`);
}

/**
 * Atualiza daily_subcat_totals + team_daily_subcat_totals a partir das equipes
 * em memória. Joina com note_subcategorias (cache de classificação) pra
 * agregar por sub_code (TL11/OBSOLETO/L0/L1/C93/BTZ013/OUTROS).
 *
 * Quantidade (NUMERIC):
 *   DD/C93    → soma de Amount (metros de ramal substituídos)
 *   DD/BTZ013 → soma de Amount (pontos de CS substituídos)
 *
 * Idempotente — usa upsert por (date, regional/team, tipo, sub_code).
 *
 * @param {Array} teams       Array de equipes (com notasExecutadas/notasConcluidas)
 * @param {string} date       'YYYY-MM-DD' BRT
 */
async function upsertSubcatTotals(teams, date) {
  const sb = getClient();
  date = date || _hojeBRT();

  // 1. Coleta UUIDs únicos de MD/SF/DD em executadas + concluidas
  const TIPOS = new Set(['MD', 'SF', 'DD']);
  const events = [];
  const noteIds = new Set();

  teams.forEach(t => {
    const teamName = t.teamName || t.sigla;
    // sectorId pode ser null em equipes-fantasma (_ghostFromAcc) — não é motivo de exclusão
    if (!teamName || !t.regional) return;
    const realizadas = [...(t.notasExecutadas || []), ...(t.notasConcluidas || [])];
    realizadas.forEach(n => {
      if (!_belongsToDate(n, date)) return;
      if (!n.id) return;
      const tipo = (n.tipoCode || n.tipo_code || '').toUpperCase();
      if (!TIPOS.has(tipo)) return;
      events.push({
        team:     teamName,
        regional: t.regional,
        sector:   t.sectorId,
        tipo,
        noteId:   n.id,
      });
      noteIds.add(n.id);
    });
  });

  if (events.length === 0) return;

  // 2. Busca classificações em note_subcategorias.
  //    Estratégia robusta: chunks pequenos (100) p/ não estourar URL/timeout.
  //    Tipicamente em runSnapshot temos algumas centenas de UUIDs, raramente milhares.
  const subcatMap = {};
  const ids = [...noteIds];
  const CHUNK_IN = 100;
  for (let i = 0; i < ids.length; i += CHUNK_IN) {
    const chunk = ids.slice(i, i + CHUNK_IN);
    const { data, error } = await sb
      .from('note_subcategorias')
      .select('note_id, sub_code, quantidade')
      .in('note_id', chunk);
    if (error) throw error;
    (data || []).forEach(r => { subcatMap[r.note_id] = r; });
  }

  // 3. Dedupe por (team, tipo, noteId) e agrega
  const seen = new Set();
  const byRegional = new Map();
  const byTeam     = new Map();

  events.forEach(e => {
    const dedupeKey = `${e.team}|${e.tipo}|${e.noteId}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    const sc = subcatMap[e.noteId];
    const sub_code   = sc?.sub_code || 'OUTROS';
    const quantidade = sc?.quantidade != null ? Number(sc.quantidade) : null;

    const rk = `${e.regional}|${e.tipo}|${sub_code}`;
    if (!byRegional.has(rk)) {
      byRegional.set(rk, {
        date, regional: e.regional, tipo: e.tipo, sub_code,
        count: 0, quantidade: null,
      });
    }
    const r = byRegional.get(rk);
    r.count += 1;
    if (quantidade != null) r.quantidade = (r.quantidade ?? 0) + quantidade;

    const tk = `${e.team}|${e.tipo}|${sub_code}`;
    if (!byTeam.has(tk)) {
      byTeam.set(tk, {
        date, team_name: e.team, regional: e.regional, sector_id: e.sector,
        tipo: e.tipo, sub_code, count: 0, quantidade: null,
      });
    }
    const t = byTeam.get(tk);
    t.count += 1;
    if (quantidade != null) t.quantidade = (t.quantidade ?? 0) + quantidade;
  });

  const now = new Date().toISOString();
  const regionalRows = [...byRegional.values()].map(r => ({ ...r, updated_at: now }));
  const teamRows     = [...byTeam.values()].map(r => ({ ...r, updated_at: now }));

  if (regionalRows.length > 0) {
    const { error } = await sb
      .from('daily_subcat_totals')
      .upsert(regionalRows, { onConflict: 'date,regional,tipo,sub_code' });
    if (error) throw error;
    console.log(`[SUPABASE] daily_subcat_totals: ${regionalRows.length} linhas p/ ${date}`);
  }
  if (teamRows.length > 0) {
    const { error } = await sb
      .from('team_daily_subcat_totals')
      .upsert(teamRows, { onConflict: 'date,team_name,tipo,sub_code' });
    if (error) throw error;
    console.log(`[SUPABASE] team_daily_subcat_totals: ${teamRows.length} linhas p/ ${date}`);
  }
}

/**
 * Consolida os snapshots do dia em `daily_totals` e `team_daily_totals` (chamado às 20:30).
 * Usa o snapshot mais recente de cada equipe como resultado final do dia.
 */
async function consolidateDay(date) {
  const sb = getClient();
  date = date || _hojeBRT();

  const { data: snaps, error: e1 } = await sb
    .from('snapshots')
    .select('team_name, regional, sector_id, captured_at, data')
    .eq('date', date)
    .order('captured_at', { ascending: false });

  if (e1) throw e1;
  if (!snaps || snaps.length === 0) {
    console.log(`[SUPABASE] consolidateDay: nenhum snapshot para ${date}`);
    return;
  }

  // Mantém apenas o snapshot mais recente por equipe
  const latest = {};
  snaps.forEach(s => { if (!latest[s.team_name]) latest[s.team_name] = s; });

  // ── daily_totals (por regional/tipo) ─────────────────────────────────────────
  // Inclui executadas + concluídas, mas só as que pertencem ao dia-alvo.
  // Sem _belongsToDate, equipes que ficaram com sessão aberta da virada do dia
  // trazem notas antigas que inflam os totais históricos.
  const regionalAcc = {};
  Object.values(latest).forEach(s => {
    const notas = [
      ...(s.data?.notasExecutadas || []),
      ...(s.data?.notasConcluidas || []),
    ];
    notas.forEach(n => {
      if (!_belongsToDate(n, date)) return;           // rejeita notas de outros dias
      const code = n.tipoCode || n.tipo_code;
      if (!code) return;
      const key = `${s.regional}|${code}`;
      regionalAcc[key] = (regionalAcc[key] || 0) + 1;
    });
  });

  const regionalRows = Object.entries(regionalAcc).map(([key, count]) => {
    const [regional, tipo_code] = key.split('|');
    return { date, regional, tipo_code, count };
  });

  if (regionalRows.length > 0) {
    const { error: e2 } = await sb
      .from('daily_totals')
      .upsert(regionalRows, { onConflict: 'date,regional,tipo_code' });
    if (e2) throw e2;
    console.log(`[SUPABASE] daily_totals consolidados: ${regionalRows.length} tipos para ${date}`);
  }

  // ── team_daily_totals (por equipe/tipo) ───────────────────────────────────────
  const teamRows = [];
  Object.values(latest).forEach(s => {
    const notas = [
      ...(s.data?.notasExecutadas || []),
      ...(s.data?.notasConcluidas || []),
    ];
    const acc = {};
    notas.forEach(n => {
      if (!_belongsToDate(n, date)) return;           // rejeita notas de outros dias
      const code = n.tipoCode || n.tipo_code;
      if (code) acc[code] = (acc[code] || 0) + 1;
    });
    Object.entries(acc).forEach(([tipo_code, count]) => {
      teamRows.push({
        date,
        team_name: s.team_name,
        regional:  s.regional,
        sector_id: s.sector_id,
        tipo_code,
        count,
      });
    });
  });

  if (teamRows.length > 0) {
    const { error: e3 } = await sb
      .from('team_daily_totals')
      .upsert(teamRows, { onConflict: 'date,team_name,tipo_code' });
    if (e3) throw e3;
    console.log(`[SUPABASE] team_daily_totals consolidados: ${teamRows.length} registros para ${date}`);
  }

  // ── daily_subcat_totals + team_daily_subcat_totals (por sub_code) ────────────
  // Reusa snapshots mais recentes (latest) reformatados como "teams" pra reusar
  // a mesma lógica de upsertSubcatTotals (que aceita t.notasExecutadas etc).
  const teamsForSubcat = Object.values(latest).map(s => ({
    teamName: s.team_name,
    regional: s.regional,
    sectorId: s.sector_id,
    notasExecutadas: s.data?.notasExecutadas || [],
    notasConcluidas: s.data?.notasConcluidas || [],
  }));
  try {
    await upsertSubcatTotals(teamsForSubcat, date);
  } catch (errSubcat) {
    // Não bloqueia consolidação principal — log warn e segue
    console.warn(`[SUPABASE] consolidateDay: upsertSubcatTotals falhou: ${errSubcat.message}`);
  }
}

/**
 * Remove snapshots com mais de 30 dias da tabela `snapshots`.
 * Chamado uma vez por dia (após a consolidação). Evita crescimento indefinido
 * da tabela que não tem uso operacional para dados tão antigos.
 */
async function cleanOldSnapshots() {
  const sb = getClient();
  // Data-limite: hoje BRT menos 30 dias
  const cutoff = new Date(Date.now() - 3 * 3600 * 1000 - 30 * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);

  const { error, count } = await sb
    .from('snapshots')
    .delete({ count: 'exact' })
    .lt('date', cutoff);

  if (error) {
    console.warn('[SUPABASE] cleanOldSnapshots: erro ao limpar:', error.message);
    return;
  }
  if (count > 0) {
    console.log(`[SUPABASE] cleanOldSnapshots: ${count} snapshots anteriores a ${cutoff} removidos`);
  }
}

module.exports = { saveSnapshot, pushTeams, upsertDailyTotals, upsertTeamDailyTotals, upsertSubcatTotals, consolidateDay, cleanOldSnapshots };
