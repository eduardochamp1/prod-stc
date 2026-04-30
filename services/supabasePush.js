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
 * Data de produção da equipe = data BRT do sessionBegin (truncada YYYY-MM-DD).
 *
 * REGRA DE NEGÓCIO (abr/2026):
 *   Toda nota executada/concluída por uma equipe pertence ao DIA EM QUE A SESSÃO
 *   DA EQUIPE COMEÇOU. Se a equipe logou em 29/04 07h e encerrou em 30/04 02h,
 *   todas as notas dela contam pra 29/04 (não importa o conclusionDate de cada
 *   nota individualmente).
 *
 *   Sem essa regra, equipes que viram a meia-noite trabalhando inflavam o
 *   contador do dia seguinte (ex: ~270 notas no início de 30/04 que eram
 *   na verdade execuções de 29/04).
 *
 * Formato esperado de sessionBegin (validado em prod):
 *   '2026-04-26T10:59:03.96' (BRT local, sem timezone)
 *
 * Retorna null se sessionBegin estiver ausente — equipe sem sessão é descartada.
 */
function _sessionDate(team) {
  if (!team || !team.sessionBegin) return null;
  const sb = String(team.sessionBegin);
  if (/^\d{4}-\d{2}-\d{2}/.test(sb)) return sb.slice(0, 10);
  return null;
}

/**
 * Atualiza `daily_totals` por regional/tipo (intraday — visão da regional).
 */
async function upsertDailyTotals(teams, _date) {
  const sb = getClient();

  // Cada equipe é atribuída ao seu _sessionDate (data BRT do sessionBegin).
  // Equipes sem sessão são descartadas. Múltiplas datas podem coexistir no
  // mesmo batch (ex: equipe da virada com sessionDate = D-1 num cron de D).
  const acc = {};
  teams.forEach(t => {
    const sessDate = _sessionDate(t);
    if (!sessDate) return;
    const realizadas = [...(t.notasExecutadas || []), ...(t.notasConcluidas || [])];
    realizadas.forEach(n => {
      const code = n.tipoCode || n.tipo_code;
      if (!code) return;
      const key = `${sessDate}|${t.regional}|${code}`;
      acc[key] = (acc[key] || 0) + 1;
    });
  });

  const newRows = Object.entries(acc).map(([key, count]) => {
    const [date, regional, tipo_code] = key.split('|');
    return { date, regional, tipo_code, count };
  });

  if (newRows.length === 0) return;

  // Estratégia MAX (preservada): nunca deixa o contador diminuir entre snapshots
  // do mesmo dia. Agora chave inclui date — busca existentes nas datas envolvidas.
  const dates = [...new Set(newRows.map(r => r.date))];
  const { data: existing } = await sb
    .from('daily_totals')
    .select('date, regional, tipo_code, count')
    .in('date', dates);
  const prev = {};
  (existing || []).forEach(r => { prev[`${r.date}|${r.regional}|${r.tipo_code}`] = r.count; });

  const rows = newRows.map(r => ({
    ...r,
    count: Math.max(r.count, prev[`${r.date}|${r.regional}|${r.tipo_code}`] || 0),
  }));

  const { error } = await sb
    .from('daily_totals')
    .upsert(rows, { onConflict: 'date,regional,tipo_code' });

  if (error) throw error;
  console.log(`[SUPABASE] daily_totals: ${rows.length} linhas em ${dates.length} dia(s) (${dates.join(', ')})`);
}

/**
 * Atualiza `team_daily_totals` por equipe/tipo (intraday — visão individual).
 */
async function upsertTeamDailyTotals(teams, _date) {
  const sb = getClient();

  // Chave: (sessDate, team_name, tipo_code). sessDate vem do sessionBegin da equipe.
  const acc = {};
  teams.forEach(t => {
    const sessDate = _sessionDate(t);
    if (!sessDate) return;
    const teamName = t.teamName || t.sigla;
    const realizadas = [...(t.notasExecutadas || []), ...(t.notasConcluidas || [])];
    realizadas.forEach(n => {
      const code = n.tipoCode || n.tipo_code;
      if (!code) return;
      const key = `${sessDate}|${teamName}|${code}`;
      if (!acc[key]) {
        acc[key] = {
          date: sessDate, team_name: teamName, regional: t.regional, sector_id: t.sectorId,
          tipo_code: code, count: 0,
        };
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
  const dates = [...new Set(rows.map(r => r.date))].sort();
  console.log(`[SUPABASE] team_daily_totals: ${rows.length} linhas em ${dates.length} dia(s) (${dates.join(', ')})`);
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
async function upsertSubcatTotals(teams, _date) {
  const sb = getClient();

  // 1. Coleta eventos por equipe, atribuindo cada um ao _sessionDate da equipe
  // Tipos MD/SF/DD têm sub-classificação real (consultam note_subcategorias).
  // Demais tipos (LN, LE, DL, RL, UG, II, PO, SO, RD…) gravam com sub_code = tipo.
  const SUBCATEGORIZED = new Set(['MD', 'SF', 'DD']);
  const events = [];
  const noteIds = new Set();

  teams.forEach(t => {
    const teamName = t.teamName || t.sigla;
    if (!teamName || !t.regional) return;
    const sessDate = _sessionDate(t);
    if (!sessDate) return;                          // sem sessão → descarta
    const realizadas = [...(t.notasExecutadas || []), ...(t.notasConcluidas || [])];
    realizadas.forEach(n => {
      if (!n.id) return;
      const tipo = (n.tipoCode || n.tipo_code || '').toUpperCase();
      if (!tipo) return;
      const isSubcat = SUBCATEGORIZED.has(tipo);
      events.push({
        date:     sessDate,
        team:     teamName,
        regional: t.regional,
        sector:   t.sectorId,
        tipo,
        noteId:   n.id,
        isSubcat,
      });
      if (isSubcat) noteIds.add(n.id);
    });
  });

  if (events.length === 0) return;

  // 2. Busca classificações em note_subcategorias (apenas MD/SF/DD).
  //    Estratégia robusta: chunks pequenos (100) p/ não estourar URL/timeout.
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

  // 3. Dedupe por (date, team, tipo, noteId) e agrega — chave inclui date pra
  // suportar múltiplas datas no mesmo batch (cron de D pegando equipes com
  // sessionDate D e raras com sessionDate D-1)
  const seen = new Set();
  const byRegional = new Map();
  const byTeam     = new Map();

  events.forEach(e => {
    const dedupeKey = `${e.date}|${e.team}|${e.tipo}|${e.noteId}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    let sub_code, quantidade;
    if (e.isSubcat) {
      const sc = subcatMap[e.noteId];
      sub_code   = sc?.sub_code || 'OUTROS';
      quantidade = sc?.quantidade != null ? Number(sc.quantidade) : null;
    } else {
      sub_code   = e.tipo;
      quantidade = null;
    }

    const rk = `${e.date}|${e.regional}|${e.tipo}|${sub_code}`;
    if (!byRegional.has(rk)) {
      byRegional.set(rk, {
        date: e.date, regional: e.regional, tipo: e.tipo, sub_code,
        count: 0, quantidade: null,
      });
    }
    const r = byRegional.get(rk);
    r.count += 1;
    if (quantidade != null) r.quantidade = (r.quantidade ?? 0) + quantidade;

    const tk = `${e.date}|${e.team}|${e.tipo}|${sub_code}`;
    if (!byTeam.has(tk)) {
      byTeam.set(tk, {
        date: e.date, team_name: e.team, regional: e.regional, sector_id: e.sector,
        tipo: e.tipo, sub_code, count: 0, quantidade: null,
      });
    }
    const t = byTeam.get(tk);
    t.count += 1;
    if (quantidade != null) t.quantidade = (t.quantidade ?? 0) + quantidade;
  });

  const now = new Date().toISOString();
  const regionalRowsNew = [...byRegional.values()].map(r => ({ ...r, updated_at: now }));
  const teamRows        = [...byTeam.values()].map(r => ({ ...r, updated_at: now }));

  if (regionalRowsNew.length > 0) {
    // Estratégia MAX — nunca reduz contadores já gravados
    const dates = [...new Set(regionalRowsNew.map(r => r.date))];
    const { data: exReg } = await sb
      .from('daily_subcat_totals')
      .select('date, regional, tipo, sub_code, count, quantidade')
      .in('date', dates);
    const prevReg = {};
    (exReg || []).forEach(r => { prevReg[`${r.date}|${r.regional}|${r.tipo}|${r.sub_code}`] = r; });

    const regionalRows = regionalRowsNew.map(r => {
      const p = prevReg[`${r.date}|${r.regional}|${r.tipo}|${r.sub_code}`];
      return {
        ...r,
        count:      Math.max(r.count,      p?.count      || 0),
        quantidade: (r.quantidade != null || p?.quantidade != null)
          ? Math.max(r.quantidade ?? 0, p?.quantidade ?? 0)
          : null,
      };
    });

    const { error } = await sb
      .from('daily_subcat_totals')
      .upsert(regionalRows, { onConflict: 'date,regional,tipo,sub_code' });
    if (error) throw error;
    console.log(`[SUPABASE] daily_subcat_totals: ${regionalRows.length} linhas em ${dates.length} dia(s)`);
  }
  if (teamRows.length > 0) {
    const { error } = await sb
      .from('team_daily_subcat_totals')
      .upsert(teamRows, { onConflict: 'date,team_name,tipo,sub_code' });
    if (error) throw error;
    const datesT = [...new Set(teamRows.map(r => r.date))];
    console.log(`[SUPABASE] team_daily_subcat_totals: ${teamRows.length} linhas em ${datesT.length} dia(s)`);
  }
}

/**
 * Consolida os snapshots do dia em `daily_totals` e `team_daily_totals` (chamado às 20:30).
 * Usa o snapshot mais recente de cada equipe como resultado final do dia.
 */
async function consolidateDay(date) {
  const sb = getClient();
  date = date || _hojeBRT();

  // Busca snapshots de date E date+1 (madrugada do dia seguinte) — equipes que
  // ainda estavam ativas após meia-noite seguem com sessionBegin = date e suas
  // notas pertencem a date pela regra de negócio.
  const dPlus1 = new Date(date + 'T12:00:00Z');
  dPlus1.setUTCDate(dPlus1.getUTCDate() + 1);
  const dayPlus1 = dPlus1.toISOString().slice(0, 10);

  const { data: snaps, error: e1 } = await sb
    .from('snapshots')
    .select('team_name, regional, sector_id, captured_at, data')
    .in('date', [date, dayPlus1])
    .order('captured_at', { ascending: false });

  if (e1) throw e1;
  if (!snaps || snaps.length === 0) {
    console.log(`[SUPABASE] consolidateDay: nenhum snapshot para ${date}`);
    return;
  }

  // Filtra só equipes cujo sessionBegin === date (regra de produção por sessão).
  // Mantém apenas o snapshot MAIS RECENTE de cada (team_name, sessionBegin) — ordem
  // captured_at desc garante que o primeiro a setar é o mais recente.
  const latest = {};
  snaps.forEach(s => {
    const t = s.data;
    if (!t) return;
    if (_sessionDate(t) !== date) return;
    const key = `${s.team_name}|${t.sessionBegin}`;
    if (!latest[key]) {
      latest[key] = {
        teamName: s.team_name,
        regional: s.regional,
        sectorId: s.sector_id,
        notasExecutadas: t.notasExecutadas || [],
        notasConcluidas: t.notasConcluidas || [],
        sessionBegin: t.sessionBegin,
      };
    }
  });

  const teams = Object.values(latest);
  if (teams.length === 0) {
    console.log(`[SUPABASE] consolidateDay: nenhuma equipe com sessionDate=${date}`);
    return;
  }

  console.log(`[SUPABASE] consolidateDay(${date}): ${teams.length} equipes (snapshot final por sessão)`);

  // Reagrega via upsertDailyTotals/upsertTeamDailyTotals/upsertSubcatTotals,
  // que agora respeitam _sessionDate de cada equipe e são idempotentes.
  await upsertDailyTotals(teams);
  await upsertTeamDailyTotals(teams);
  try {
    await upsertSubcatTotals(teams);
  } catch (errSubcat) {
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
