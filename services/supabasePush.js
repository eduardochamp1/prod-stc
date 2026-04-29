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
  const sb = getClient();

  const rows = teams.map(t => ({
    team_name:  t.teamName,
    regional:   t.regional,
    sector_id:  t.sectorId,
    data:       t,
    updated_at: new Date().toISOString(),
  }));

  // 1) Upsert das equipes ativas no momento
  const { error: upErr } = await sb
    .from('teams_current')
    .upsert(rows, { onConflict: 'team_name' });
  if (upErr) throw upErr;

  // 2) Remove qualquer linha cuja team_name NÃO está mais no batch
  // (equipes que encerraram sessão e sumiram do sessions/current)
  const aliveNames = teams.map(t => t.teamName);
  if (aliveNames.length > 0) {
    const { error: delErr, count } = await sb
      .from('teams_current')
      .delete({ count: 'exact' })
      .not('team_name', 'in', `(${aliveNames.map(n => `"${n.replace(/"/g, '""')}"`).join(',')})`);
    if (delErr) {
      console.warn('[SUPABASE] teams_current: falha ao limpar equipes ausentes:', delErr.message);
    } else if (count > 0) {
      console.log(`[SUPABASE] teams_current: ${count} equipe(s) removida(s) (sessão encerrada)`);
    }
  }

  console.log(`[SUPABASE] teams_current: ${teams.length} equipes atualizadas`);
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
  return true;                                     // formato desconhecido → não filtra
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
