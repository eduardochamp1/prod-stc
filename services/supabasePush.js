/**
 * services/supabasePush.js
 * Escrita no Supabase — snapshots, teams_current, daily_totals e team_daily_totals.
 */

const { getClient } = require('./supabaseClient');

/**
 * Salva snapshot histórico das equipes na tabela `snapshots`.
 * Chamado a cada 15 min pelo cronService.
 */
async function saveSnapshot(teams, date) {
  if (!teams || teams.length === 0) return;
  const sb = getClient();
  date = date || new Date().toISOString().slice(0, 10);

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
 * Chamado a cada 15 min — substitui o registro anterior de cada equipe.
 */
async function pushTeams(teams) {
  if (!teams || teams.length === 0) return;
  const sb = getClient();

  const rows = teams.map(t => ({
    team_name:  t.teamName,
    regional:   t.regional,
    sector_id:  t.sectorId,
    data:       t,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await sb
    .from('teams_current')
    .upsert(rows, { onConflict: 'team_name' });

  if (error) throw error;
  console.log(`[SUPABASE] teams_current: ${teams.length} equipes atualizadas`);
}

/**
 * Atualiza `daily_totals` por regional/tipo (intraday — visão da regional).
 */
async function upsertDailyTotals(teams, date) {
  const sb = getClient();
  date = date || new Date().toISOString().slice(0, 10);

  const acc = {};
  teams.forEach(t => {
    const realizadas = [...(t.notasExecutadas || []), ...(t.notasConcluidas || [])];
    realizadas.forEach(n => {
      const key = `${t.regional}|${n.tipoCode}`;
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
  date = date || new Date().toISOString().slice(0, 10);

  const rows = [];
  teams.forEach(t => {
    const realizadas = [...(t.notasExecutadas || []), ...(t.notasConcluidas || [])];
    const acc = {};
    realizadas.forEach(n => {
      const code = n.tipoCode || n.tipo_code;
      if (code) acc[code] = (acc[code] || 0) + 1;
    });
    Object.entries(acc).forEach(([tipo_code, count]) => {
      rows.push({
        date,
        team_name: t.teamName || t.sigla,
        regional:  t.regional,
        sector_id: t.sectorId,
        tipo_code,
        count,
      });
    });
  });

  if (rows.length === 0) return;

  const { error } = await sb
    .from('team_daily_totals')
    .upsert(rows, { onConflict: 'date,team_name,tipo_code' });

  if (error) throw error;
  console.log(`[SUPABASE] team_daily_totals: ${rows.length} registros para ${date}`);
}

/**
 * Consolida os snapshots do dia em `daily_totals` e `team_daily_totals` (chamado às 20:30).
 * Usa o snapshot mais recente de cada equipe como resultado final do dia.
 */
async function consolidateDay(date) {
  const sb = getClient();
  date = date || new Date().toISOString().slice(0, 10);

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
  // FIX: inclui executadas (status 2) + concluídas (status 9/4) — igual ao intraday
  const regionalAcc = {};
  Object.values(latest).forEach(s => {
    const notas = [
      ...(s.data?.notasExecutadas || []),
      ...(s.data?.notasConcluidas || []),
    ];
    notas.forEach(n => {
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
  // FIX: inclui executadas + concluídas
  const teamRows = [];
  Object.values(latest).forEach(s => {
    const notas = [
      ...(s.data?.notasExecutadas || []),
      ...(s.data?.notasConcluidas || []),
    ];
    const acc = {};
    notas.forEach(n => {
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
}

module.exports = { saveSnapshot, pushTeams, upsertDailyTotals, upsertTeamDailyTotals, consolidateDay };
