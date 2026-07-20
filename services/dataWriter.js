/**
 * services/dataWriter.js
 * Escrita no Supabase — snapshots, teams_current, daily_totals e team_daily_totals.
 */

const { getClient } = require('./dbClient');
const { dateBRT, dateBRTMinusDays } = require('./timeUtil');
const log = require('./logger').forModule('dataWriter');

// Data operacional BRT (America/Sao_Paulo). Usar UTC daria a data errada após 21:00 BRT
// (quando UTC já virou pro dia seguinte) e desalinharia tudo com o front.
function _hojeBRT() {
  return dateBRT();
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
  log.info('snapshots_saved', { teams: rows.length });
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
    log.warn('push_teams_lock_expired', {});
  }
  _pushTeamsLock = true;

  try {
    const sb = getClient();
    const now = new Date().toISOString();

    // Dedupe por team_name — se o WPA devolveu a mesma equipe 2x no mesmo
    // batch (split de sessão, race), Postgres aborta o upsert inteiro com
    // "ON CONFLICT DO UPDATE command cannot affect row a second time".
    // Mantemos a ÚLTIMA ocorrência (a mais recente do snapshot).
    const dedupMap = new Map();
    teams.forEach(t => {
      if (!t.teamName) return;
      dedupMap.set(t.teamName, t);
    });
    const rows = [...dedupMap.values()].map(t => ({
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
      log.warn('teams_current_ttl_failed', { msg: ttlErr.message });
    } else if (ttlCount > 0) {
      log.info('teams_current_ttl_cleared', { removed: ttlCount });
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
        log.warn('teams_current_delete_failed', { msg: delErr.message });
      } else if (count > 0) {
        log.info('teams_current_offline_removed', { count });
      }
    }

    log.info('teams_current_updated', { teams: teams.length });
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
 * Data EFETIVA da nota para fins de agregação.
 *
 * Regra geral: a nota pertence ao DIA DA SESSÃO (_sessionDate) — equipes que
 * viram a meia-noite seguem contando no dia em que começaram a trabalhar.
 *
 * EXCEÇÃO (mai/2026): se a nota tem `conclusionDate` claramente anterior ao
 * sessionBegin (executada em dia anterior, antes da sessão atual começar),
 * usa o dia da conclusão. Isso evita inflação quando uma equipe loga hoje
 * carregando notas que ela já executou ontem.
 *
 * Confirmado em prod: ETGPR15/ETPIU15 logaram em 22/05 com 77 notas L0 em
 * `notasConcluidas` cujo `conclusionDate` era 21/05 12h–17h.
 */
function _notaDate(n, sessDate, sessionBegin) {
  if (!n.conclusionDate) return sessDate;
  const cd = String(n.conclusionDate).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}/.test(cd)) return sessDate;

  // Se conclusionDate é de dia anterior ao sessionDate, usa conclusionDate.
  // (Se for igual ou posterior, mantém sessionDate — preserva regra "vira-noite")
  if (cd < sessDate) return cd;

  // Caso especial: nota concluída no mesmo dia mas ANTES do sessionBegin
  // (ex: notas que apareceram na próxima sessão da mesma data). Mantém sessDate.
  return sessDate;
}

/**
 * Atualiza `daily_totals` por regional/tipo (intraday — visão da regional).
 */
/**
 * @deprecated `daily_totals` não é mais lida pelo sistema (queries leem
 * direto de `team_daily_totals` para permitir filtro pela whitelist).
 * Mantida como no-op para preservar compatibilidade do callsite — qualquer
 * agregação regional é re-feita em runtime nas funções de leitura.
 */
async function upsertDailyTotals(_teams, _date) {
  // intencionalmente vazio
}

/**
 * Atualiza `team_daily_totals` por equipe/tipo (intraday — visão individual).
 */
/**
 * FUNÇÃO PURA (testável sem DB): agrega notasConcluidas das equipes em rows
 * de team_daily_totals. Chave (notaDate, team_name, tipo_code).
 *
 * Produtividade do dia = notasConcluidas que NÃO foram rejeitadas. Notas em
 * andamento ainda podem virar rejeitadas (não são "produção feita"); e nota
 * concluída que a EDP REJEITOU também não é produção válida. Regra de negócio
 * (decisão 20/07/2026, José): prioridade rejeitada > concluída — uma nota que
 * está em notasConcluidas E notasRejeitadas conta SÓ como rejeitada. O WPA
 * mantém a nota nas duas fontes (Concluded[] e /rejected), então sem esta
 * exclusão a produção reportada à EDP inflava (diagnóstico 20/07: ~30 equipes,
 * ECTSJ83 mostrava 17 executadas sendo 14 rejeitadas). Regra alinhada com o
 * card OS EXECUTADAS do Monitor, upsertSubcatTotals, _buildDiaSummary e detectDrift.
 *
 * @param {Array} teams
 * @returns {Array<{date, team_name, regional, sector_id, tipo_code, count}>}
 */
function _aggregateTeamDailyTotals(teams) {
  const acc = {};
  teams.forEach(t => {
    const sessDate = _sessionDate(t);
    if (!sessDate) return;
    const teamName = t.teamName || t.sigla;
    const rejIds = new Set(
      (t.notasRejeitadas || []).map(n => n && (n.id || n.noteId)).filter(Boolean)
    );
    (t.notasConcluidas || []).forEach(n => {
      const code = n.tipoCode || n.tipo_code;
      if (!code) return;
      // rejeitada > concluída: nota rejeitada não conta como produção
      if (n.id && rejIds.has(n.id)) return;
      const notaDate = _notaDate(n, sessDate, t.sessionBegin);
      const key = `${notaDate}|${teamName}|${code}`;
      if (!acc[key]) {
        acc[key] = {
          date: notaDate, team_name: teamName, regional: t.regional, sector_id: t.sectorId,
          tipo_code: code, _ids: new Set(),
        };
      }
      // DEDUP por UUID: a MESMA OS concluída aparece em várias sessões do dia
      // quando a equipe reloga (o payload da WPA carrega as concluídas
      // acumuladas em cada sessão). Sem dedup, a produção inflava até ~8x
      // (bug 08/07/2026: ECCSJ82 tinha 18 OS reais viradas em 143 contagens).
      // Espelha o dedupeKey de upsertSubcatTotals, que já fazia certo.
      // Nota sem id (raro) usa fallback único pra não sumir da contagem.
      const id = n.id || n.noteId || `sem-id:${acc[key]._ids.size}:${Math.random()}`;
      acc[key]._ids.add(id);
    });
  });
  return Object.values(acc).map(({ _ids, ...row }) => ({ ...row, count: _ids.size }));
}

async function upsertTeamDailyTotals(teams, _date) {
  const sb = getClient();
  const rows = _aggregateTeamDailyTotals(teams);
  if (rows.length === 0) return;

  const { error } = await sb
    .from('team_daily_totals')
    .upsert(rows, { onConflict: 'date,team_name,tipo_code' });

  if (error) throw error;
  const dates = [...new Set(rows.map(r => r.date))].sort();
  log.info('team_daily_totals_upserted', { rows: rows.length, dates });
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
    // Produtividade do dia = notasConcluidas que NÃO foram rejeitadas. Notas em
    // andamento ainda podem virar rejeitadas, e concluída rejeitada pela EDP não
    // é "produção feita". Prioridade rejeitada > concluída (decisão 20/07/2026 —
    // ver _aggregateTeamDailyTotals). Alinhada com o card OS EXECUTADAS.
    const _rejIds = new Set(
      (t.notasRejeitadas || []).map(n => n && (n.id || n.noteId)).filter(Boolean)
    );
    const realizadas = (t.notasConcluidas || []).filter(n => !(n && n.id && _rejIds.has(n.id)));
    realizadas.forEach(n => {
      if (!n.id) return;
      const tipo = (n.tipoCode || n.tipo_code || '').toUpperCase();
      if (!tipo) return;
      const isSubcat = SUBCATEGORIZED.has(tipo);
      // Usa conclusionDate quando ela aponta pra dia anterior à sessão atual
      // (notas que vieram "do passado" via WPA não devem inflar o dia atual).
      const notaDate = _notaDate(n, sessDate, t.sessionBegin);
      events.push({
        date:     notaDate,
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
  const byTeam = new Map();

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
  const teamRows = [...byTeam.values()].map(r => ({ ...r, updated_at: now }));

  // Nota: `daily_subcat_totals` (regional) não é mais escrita. Toda leitura
  // re-agrega em runtime a partir de `team_daily_subcat_totals` para respeitar
  // a whitelist de equipes oficiais.
  if (teamRows.length > 0) {
    const { error } = await sb
      .from('team_daily_subcat_totals')
      .upsert(teamRows, { onConflict: 'date,team_name,tipo,sub_code' });
    if (error) throw error;
    const datesT = [...new Set(teamRows.map(r => r.date))];
    log.info('team_daily_subcat_upserted', { rows: teamRows.length, days: datesT.length });
  }
}

/**
 * Consolida os snapshots do dia em `daily_totals` e `team_daily_totals` (chamado às 20:30).
 * Usa o snapshot mais recente de cada equipe como resultado final do dia.
 */
async function consolidateDay(date) {
  const sb = getClient();
  date = date || _hojeBRT();

  // Busca snapshots de date-1, date E date+1 — cobre 3 casos:
  //   - date+1: madrugada (equipe virando a noite, sessionBegin=date)
  //   - date-1: notas executadas no dia anterior carregadas na sessão atual
  //   - date: snapshots normais do dia
  const dPlus1 = new Date(date + 'T12:00:00Z');
  dPlus1.setUTCDate(dPlus1.getUTCDate() + 1);
  const dayPlus1 = dPlus1.toISOString().slice(0, 10);

  const dMinus1 = new Date(date + 'T12:00:00Z');
  dMinus1.setUTCDate(dMinus1.getUTCDate() - 1);
  const dayMinus1 = dMinus1.toISOString().slice(0, 10);

  const { data: snaps, error: e1 } = await sb
    .from('snapshots')
    .select('team_name, regional, sector_id, captured_at, data')
    .in('date', [dayMinus1, date, dayPlus1])
    .order('captured_at', { ascending: false });

  if (e1) throw e1;
  if (!snaps || snaps.length === 0) {
    log.info('consolidate_no_snapshot', { date });
    return;
  }

  // Mantém snap mais recente de cada (team, sessionBegin) cujo sessionDate IN
  // (date-1, date). Equipes com sessionDate em date-1 são incluídas porque
  // suas notas (conclusionDate < date-1) podem migrar pra date-2 — mas o foco
  // principal é processar AMBAS as datas date-1 e date numa rodada só, pra
  // que o wipe + reagregação não percam linhas legítimas.
  const latest = {};
  snaps.forEach(s => {
    const t = s.data;
    if (!t) return;
    const sd = _sessionDate(t);
    if (sd !== date && sd !== dayMinus1) return;
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
    log.info('consolidate_no_session', { date });
    return;
  }

  log.info('consolidate_start', { date, teams: teams.length });

  // ── RESET ─────────────────────────────────────────────────────────────
  // Wipa date E date-1 — cobre notas migradas pelo _notaDate (notas executadas
  // em D-1 carregadas em sessão de D). Sem wipar D-1, upserts duplicam linhas.
  const datesToWipe = [dayMinus1, date];
  for (const d of datesToWipe) {
    for (const op of [
      sb.from('team_daily_totals').delete().eq('date', d),
      sb.from('team_daily_subcat_totals').delete().eq('date', d),
    ]) {
      const { error } = await op;
      if (error && !/does not exist|PGRST204|42P01/i.test(error.message || '')) {
        log.warn('consolidate_reset_failed', { date: d, msg: error.message });
      }
    }
  }
  log.info('consolidate_wipe_done', { date, range: datesToWipe });

  // Reagrega via upsertTeamDailyTotals/upsertSubcatTotals.
  await upsertTeamDailyTotals(teams);
  try {
    await upsertSubcatTotals(teams);
  } catch (errSubcat) {
    log.warn('consolidate_subcat_failed', { date, msg: errSubcat.message });
  }
}

/**
 * Compara o total de OS CONCLUÍDAS (produtividade do dia) em um dia entre as
 * duas fontes:
 *   - SNAPSHOTS: snapshot mais recente de cada equipe com sessionDate=date
 *   - TABELA   : sum(count) de team_daily_totals para o mesmo date
 *
 * ⚠️ Ambos os lados contam SÓ notasConcluidas — team_daily_totals grava apenas
 * concluídas ("Produtividade do dia = SÓ notasConcluidas", ver upsertTeamDailyTotals).
 * Versão anterior somava executadas+concluídas no lado snapshot, comparando
 * métrica de execução contra métrica de produção → drift falso-positivo crônico
 * que o auto-reparo nunca zerava (mascarava drift real). Corrigido 17/06/2026.
 *
 * Drift positivo (snapshot > tabela) = consolidação atrasada / falha
 * Drift negativo (snapshot < tabela) = tabela inflada / wipe não rodou
 *
 * Não considera whitelist — se houver drift em equipes não-oficiais ainda
 * vale a pena saber (indica falha sistêmica).
 *
 * @param   {string} date  'YYYY-MM-DD' BRT
 * @returns {Promise<{date, snapshot_count, table_count, diff, has_drift, threshold}>}
 */
async function detectDrift(date) {
  const sb = getClient();
  date = date || _hojeBRT();

  // Snapshots: range date..date+1 (madrugada do dia seguinte conta pra date
  // se sessionDate=date — mesma regra do consolidateDay).
  const dPlus1 = new Date(date + 'T12:00:00Z');
  dPlus1.setUTCDate(dPlus1.getUTCDate() + 1);
  const dayPlus1 = dPlus1.toISOString().slice(0, 10);

  const { data: snaps, error: e1 } = await sb
    .from('snapshots')
    .select('team_name, captured_at, data')
    .in('date', [date, dayPlus1])
    .order('captured_at', { ascending: false });
  if (e1) throw e1;

  // Reconstrói o que team_daily_totals DEVERIA ter pra `date` usando a MESMA
  // função de gravação (_aggregateTeamDailyTotals): dedup por note id +
  // atribuição por _notaDate. Antes o detector somava notasConcluidas.length
  // por sessionDate sem dedup — pra equipes que relogam, contava a mesma nota
  // várias vezes (ECCSJ82 = 143 ocorrências vs 18 reais) e comparava contra a
  // tabela (já deduplicada), gerando drift fantasma que nenhum reparo zerava.
  // Corrigido 08/07/2026.
  //
  // Um objeto-equipe por (team_name, sessionBegin), snapshot mais recente
  // (snaps já vem ordenado por captured_at DESC). A janela [date, date+1]
  // cobre todas as sessões que podem escrever em `date`: _notaDate empurra
  // notas pra TRÁS, então uma sessão de date+1 pode ter nota com
  // conclusionDate=date; sessões de date-1 nunca escrevem em date.
  const seen = new Set();
  const teams = [];
  for (const s of (snaps || [])) {
    const t = s.data;
    if (!t || !t.sessionBegin) continue;
    const key = `${s.team_name}|${t.sessionBegin}`;
    if (seen.has(key)) continue;
    seen.add(key);
    teams.push(t);
  }
  const snapshot_count = _aggregateTeamDailyTotals(teams)
    .filter(r => r.date === date)
    .reduce((sum, r) => sum + r.count, 0);

  // Tabela: sum(count) de team_daily_totals para o date
  const { data: rows, error: e2 } = await sb
    .from('team_daily_totals')
    .select('count')
    .eq('date', date);
  if (e2) throw e2;
  const table_count = (rows || []).reduce((sum, r) => sum + (r.count || 0), 0);

  const diff = snapshot_count - table_count;
  // Limiar: 5 OS de diferença OU 2% (o que for maior). Tolerância para
  // pequenas inconsistências naturais (ex: 1 nota dedupada por dedupeKey).
  const threshold = Math.max(5, Math.round(snapshot_count * 0.02));

  return {
    date,
    snapshot_count,
    table_count,
    diff,
    abs_diff:  Math.abs(diff),
    threshold,
    has_drift: Math.abs(diff) > threshold,
  };
}

/**
 * Remove snapshots com mais de 30 dias da tabela `snapshots`.
 * Chamado uma vez por dia (após a consolidação). Evita crescimento indefinido
 * da tabela que não tem uso operacional para dados tão antigos.
 */
async function cleanOldSnapshots() {
  // Retenção configurável via SNAPSHOT_RETENTION_DAYS no .env.
  // 0 ou ausente = NUNCA apaga (decisão do negócio em jul/2026: manter o
  // histórico bruto pra reprocessamentos retroativos de métricas futuras —
  // custo ~16MB/dia ≈ 6GB/ano no disco da VM).
  // Pra reativar a limpeza: SNAPSHOT_RETENTION_DAYS=90 (ou o TTL desejado).
  const retentionDays = parseInt(process.env.SNAPSHOT_RETENTION_DAYS || '0', 10);
  if (!retentionDays || retentionDays <= 0) {
    log.info('clean_snapshots_skipped', { reason: 'retencao ilimitada (SNAPSHOT_RETENTION_DAYS nao setado)' });
    return;
  }
  const sb = getClient();
  const cutoff = dateBRTMinusDays(retentionDays);

  const { error, count } = await sb
    .from('snapshots')
    .delete({ count: 'exact' })
    .lt('date', cutoff);

  if (error) {
    log.warn('clean_snapshots_failed', { msg: error.message });
    return;
  }
  if (count > 0) {
    log.info('clean_snapshots_done', { count, cutoff });
  }
}

/**
 * Remove note_details com mais de 90 dias (TTL).
 * Cache de payloads completos de OS — útil só para consultas recentes.
 * Chamado junto com cleanOldSnapshots no cron diário.
 */
async function cleanOldNoteDetails() {
  const sb = getClient();
  // Cutoff = hoje BRT - 90 dias, em formato ISO com hora 00:00 UTC
  const cutoff = dateBRTMinusDays(90) + 'T00:00:00.000Z';

  const { error, count } = await sb
    .from('note_details')
    .delete({ count: 'exact' })
    .lt('fetched_at', cutoff);

  if (error) {
    log.warn('clean_note_details_failed', { msg: error.message });
    return;
  }
  if (count > 0) {
    log.info('clean_note_details_done', { count, cutoff: cutoff.slice(0, 10) });
  }
}

/**
 * Aproveitamento de carteira POR EQUIPE — persiste em `team_daily_carteira`.
 *
 * Mesma matemática do _buildDiaSummary (dataService.js), mas agrupada por
 * equipe em vez de agregada. Cada UUID classificado em EXATAMENTE 1 bucket:
 *   concluida > rejeitada > andamento > atual > cancelada.
 *
 * Invariante por equipe:
 *   inicial + entradas = atual + andamento + concluidas + rejeitadas + canceladas
 *
 * Nota: sem dedup cross-team — nota transferida entre equipes conta na
 * carteira de ambas (visão de produtividade individual, não de estoque).
 *
 * Roda no cron (dia atual) e no backfill (datas passadas, enquanto os
 * snapshots ainda existem — retenção ~30 dias).
 */
async function upsertTeamDailyCarteira(date) {
  const { _getPool } = require('./pgShim');
  const pool = _getPool();
  if (!pool) return;
  date = date || _hojeBRT();

  const bucketsSql = (order) => `
    SELECT DISTINCT ON (team_name) team_name, regional,
      coalesce(data->'notasBaixadas',   '[]'::jsonb) AS baixadas,
      coalesce(data->'notasExecutadas', '[]'::jsonb) AS executadas,
      coalesce(data->'notasConcluidas', '[]'::jsonb) AS concluidas,
      coalesce(data->'notasRejeitadas', '[]'::jsonb) AS rejeitadas
    FROM snapshots
    WHERE date = $1
    ORDER BY team_name, captured_at ${order}`;

  const [firstRes, lastRes, rejRes] = await Promise.all([
    pool.query(bucketsSql('ASC'), [date]),
    pool.query(bucketsSql('DESC'), [date]),
    pool.query(`SELECT team_name, note_id FROM note_rejections WHERE session_date = $1`, [date]),
  ]);
  if (firstRes.rows.length === 0) return;

  const ids = (arr) => {
    const s = new Set();
    if (Array.isArray(arr)) for (const n of arr) { if (n && n.id) s.add(n.id); }
    return s;
  };

  // Rejeitadas persistentes por equipe (WPA limpa do payload após horas)
  const rejByTeam = new Map();
  for (const r of rejRes.rows) {
    if (!rejByTeam.has(r.team_name)) rejByTeam.set(r.team_name, new Set());
    if (r.note_id) rejByTeam.get(r.team_name).add(r.note_id);
  }

  const lastByTeam = new Map(lastRes.rows.map(r => [r.team_name, r]));
  const rows = [];

  for (const f of firstRes.rows) {
    const team = f.team_name;
    const l = lastByTeam.get(team) || f;

    const inicial = new Set([
      ...ids(f.baixadas), ...ids(f.executadas), ...ids(f.concluidas), ...ids(f.rejeitadas),
    ]);
    const atualRaw      = ids(l.baixadas);
    const andamentoRaw  = ids(l.executadas);
    const concluidasRaw = ids(l.concluidas);
    const rejeitadasRaw = new Set([...ids(l.rejeitadas), ...(rejByTeam.get(team) || [])]);

    const todas = new Set([...atualRaw, ...andamentoRaw, ...concluidasRaw, ...rejeitadasRaw]);
    let atual = 0, andamento = 0, concluidas = 0, rejeitadas = 0;
    // Prioridade rejeitada > concluída > andamento > atual (decisão 20/07/2026):
    // nota rejeitada pela EDP não é produção, mesmo que também esteja concluída.
    // Precisa bater com _aggregateTeamDailyTotals, senão o drift dispara falso.
    for (const u of todas) {
      if      (rejeitadasRaw.has(u))  rejeitadas++;
      else if (concluidasRaw.has(u))  concluidas++;
      else if (andamentoRaw.has(u))   andamento++;
      else                            atual++;
    }
    let canceladas = 0;
    for (const u of inicial) if (!todas.has(u)) canceladas++;
    let entradas = 0;
    for (const u of todas) if (!inicial.has(u)) entradas++;

    rows.push({
      date, team_name: team, regional: f.regional,
      carteira_inicial: inicial.size,
      entradas_novas:   entradas,
      atual, andamento, concluidas, rejeitadas, canceladas,
      updated_at: new Date().toISOString(),
    });
  }

  if (rows.length === 0) return;
  const sb = getClient();
  const { error } = await sb
    .from('team_daily_carteira')
    .upsert(rows, { onConflict: 'date,team_name' });
  if (error) throw error;
  log.info('team_daily_carteira_upserted', { date, rows: rows.length });
}

module.exports = {
  saveSnapshot, pushTeams,
  upsertDailyTotals, upsertTeamDailyTotals, upsertSubcatTotals,
  upsertTeamDailyCarteira,
  consolidateDay, detectDrift,
  cleanOldSnapshots, cleanOldNoteDetails,
  // Exportadas pra teste (P0-3) — funções puras da regra de agregação.
  _sessionDate, _notaDate, _aggregateTeamDailyTotals,
};
