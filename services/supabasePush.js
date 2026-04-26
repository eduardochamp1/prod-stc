/**
 * services/supabasePush.js
 * Escrita no Supabase — snapshots, teams_current e daily_totals.
 */

const { getClient } = require('./supabaseClient');

/**
 * Salva snapshot histórico das equipes na tabela `snapshots`.
 * Chamado a cada 15 min pelo cronService.
 */
async function saveSnapshot(teams) {
  if (!teams || teams.length === 0) return;
  const sb   = getClient();
  const date = new Date().toISOString().slice(0, 10);

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
 * Atualiza `daily_totals` com o estado atual das equipes (intraday).
 * Permite ver o acumulado do dia antes da consolidação das 20:30.
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
 * Consolida os snapshots do dia em `daily_totals` (chamado às 20:30).
 * Usa o snapshot mais recente de cada equipe para calcular os totais finais.
 */
async function consolidateDay(date) {
  const sb = getClient();
  date = date || new Date().toISOString().slice(0, 10);

  const { data: snaps, error: e1 } = await sb
    .from('snapshots')
    .select('team_name, regional, captured_at, data')
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

  // Agrega por regional + tipo_code a partir das notas concluídas
  const acc = {};
  Object.values(latest).forEach(s => {
    const notas = s.data?.notasConcluidas || [];
    notas.forEach(n => {
      const code = n.tipoCode || n.tipo_code;
      if (!code) return;
      const key = `${s.regional}|${code}`;
      acc[key] = (acc[key] || 0) + 1;
    });
  });

  const rows = Object.entries(acc).map(([key, count]) => {
    const [regional, tipo_code] = key.split('|');
    return { date, regional, tipo_code, count };
  });

  if (rows.length === 0) {
    console.log(`[SUPABASE] consolidateDay: nenhuma nota concluída para ${date}`);
    return;
  }

  const { error: e2 } = await sb
    .from('daily_totals')
    .upsert(rows, { onConflict: 'date,regional,tipo_code' });

  if (e2) throw e2;
  console.log(`[SUPABASE] daily_totals consolidados: ${rows.length} tipos para ${date}`);
}

module.exports = { saveSnapshot, pushTeams, upsertDailyTotals, consolidateDay };
