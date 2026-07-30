/**
 * services/dataWriter.js
 * Escrita no Supabase — snapshots, teams_current, daily_totals e team_daily_totals.
 */

const { getClient } = require('./dbClient');
const { dateBRT, dateBRTMinusDays } = require('./timeUtil');
const { classifyBuckets } = require('./bucketMath');   // fonte única da aritmética de buckets (P2-2)
const log = require('./logger').forModule('dataWriter');

// Data operacional BRT (America/Sao_Paulo). Usar UTC daria a data errada após 21:00 BRT
// (quando UTC já virou pro dia seguinte) e desalinharia tudo com o front.
function _hojeBRT() {
  return dateBRT();
}

/**
 * Soma `n` dias (pode ser negativo) a uma data 'YYYY-MM-DD', devolvendo
 * 'YYYY-MM-DD'. Usa meio-dia UTC como âncora pra não escorregar de dia por
 * fuso/DST. Função pura (testável).
 */
function _addDays(date, n) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
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

// Gap máximo (minutos) entre o logoff de uma sessão e o logon da seguinte pra
// tratar a segunda como RECONEXÃO da mesma noite (P1-14). Default 60min;
// ajustável sem deploy via env RECONEXAO_MAX_GAP_MIN.
const RECONEXAO_MAX_GAP_MIN = (() => {
  const n = parseInt(process.env.RECONEXAO_MAX_GAP_MIN || '60', 10);
  return Number.isFinite(n) && n >= 0 ? n : 60;
})();

/**
 * FUNÇÃO PURA (testável): data operacional EFETIVA de cada sessão, linkando
 * reconexões vira-noite ao dia do INÍCIO DO TURNO (P1-14, decisão José 30/07/2026).
 *
 * Regra: ordenando as sessões de cada equipe por begin, uma sessão cujo begin
 * está dentro de `gapMin` minutos após o `end` da anterior é uma reconexão e
 * HERDA o dia efetivo da anterior (encadeia). Gap negativo ou `end` ausente não
 * linka (conservador). Caso clássico: turno 20:05→01:08, reconexão 01:10→04:00
 * (gap 2min) → toda a noite fica no dia do 20:05.
 *
 * Edge conhecido (raro): cadeia de reconexões cruzando 2+ meia-noites pode
 * divergir na borda da janela de 3 dias do consolidateDay. Turno real < 24h
 * nunca cai nisso. Ver SPEC-reconexao-vira-noite-2026-07-30.md §4.1.
 *
 * @param {Array} entries  sessões {teamName, sessionBegin, sessionEnd}
 * @param {number} gapMin  limite em minutos (default RECONEXAO_MAX_GAP_MIN)
 * @returns {Map<string, string>}  `${teamName}|${sessionBegin}` → 'YYYY-MM-DD'
 */
function _effectiveSessionDates(entries, gapMin = RECONEXAO_MAX_GAP_MIN) {
  const byTeam = new Map();
  for (const e of (entries || [])) {
    if (!e || !e.sessionBegin) continue;
    if (!byTeam.has(e.teamName)) byTeam.set(e.teamName, []);
    byTeam.get(e.teamName).push(e);
  }
  const out = new Map();
  for (const [team, list] of byTeam) {
    list.sort((a, b) => String(a.sessionBegin).localeCompare(String(b.sessionBegin)));
    let prevEnd = null, prevEff = null;
    for (const e of list) {
      let eff = _sessionDate(e);
      if (prevEnd && prevEff) {
        const gap = (new Date(e.sessionBegin) - new Date(prevEnd)) / 60000;
        if (Number.isFinite(gap) && gap >= 0 && gap <= gapMin) eff = prevEff;
      }
      out.set(`${team}|${e.sessionBegin}`, eff);
      prevEnd = e.sessionEnd || null;
      prevEff = eff;
    }
  }
  return out;
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
    // _effDate: dia operacional efetivo (reconexão vira-noite herda o dia do
    // início do turno — P1-14). Ausente no caminho intraday (teams ao vivo) →
    // cai no _sessionDate, comportamento idêntico ao anterior.
    const sessDate = t._effDate || _sessionDate(t);
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
    // _effDate: reconexão vira-noite herda o dia do início do turno (P1-14).
    // Consistente com _aggregateTeamDailyTotals. Ausente intraday → _sessionDate.
    const sessDate = t._effDate || _sessionDate(t);
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
/**
 * FUNÇÃO PURA (testável): consolida os snapshots de um dia em `teams`, UNINDO as
 * notas concluídas/rejeitadas de TODOS os snapshots de cada (equipe, sessão) —
 * não só do último. Robusto a: rotação do `Concluded[]` da WPA ao longo do dia,
 * reset do acumulador `_acc` por restart do PM2, e o bug pré-P3-11 (nota
 * executada→concluída que ficava congelada). Sem a união, a consolidação usava
 * só o ÚLTIMO snapshot e SUBNOTIFICAVA a produção (~30-40%, medido 22/07/2026 —
 * P1-13).
 *
 * `notasExecutadas` (andamento) vem do snapshot MAIS RECENTE (estado transiente,
 * não entra na produtividade). O `conclusionDate` de cada nota é preservado, então
 * `_notaDate` segue atribuindo cada uma ao dia correto. `notasRejeitadas` também é
 * unida (a exclusão rejeitada > concluída é aplicada por _aggregateTeamDailyTotals).
 *
 * @param {Array}  snaps      rows {team_name, regional, sector_id, captured_at, data},
 *                            ORDENADOS por captured_at DESC (1ª ocorrência = a mais recente).
 * @param {string} date       'YYYY-MM-DD' BRT
 * @param {string} dayMinus1  'YYYY-MM-DD' BRT (D-1)
 */
function _unionTeamsFromSnapshots(snaps, date, dayMinus1, opts = {}) {
  const dayPlus1 = _addDays(date, 1);
  const gapMin = Number.isFinite(opts.reconexaoGapMin) ? opts.reconexaoGapMin : RECONEXAO_MAX_GAP_MIN;
  const acc = {};
  (snaps || []).forEach(s => {
    const t = s.data;
    if (!t) return;
    const sd = _sessionDate(t);
    // Aceita date-1, date E date+1. O date+1 entra porque pode ser uma
    // RECONEXÃO que cruza a meia-noite e herda o dia anterior (P1-14) — o filtro
    // final por _effDate decide se fica. Antes só {date, dayMinus1}.
    if (sd !== date && sd !== dayMinus1 && sd !== dayPlus1) return;
    const key = `${s.team_name}|${t.sessionBegin}`;
    if (!acc[key]) {
      acc[key] = {
        teamName: s.team_name,
        regional: s.regional,
        sectorId: s.sector_id,
        sessionBegin: t.sessionBegin,
        sessionEnd: t.sessionEnd || null,           // do mais recente (DESC → 1ª ocorrência)
        notasExecutadas: t.notasExecutadas || [],   // do mais recente (DESC → 1ª ocorrência)
        _conc: new Map(),
        _rej:  new Map(),
      };
    }
    const e = acc[key];
    (t.notasConcluidas || []).forEach(n => {
      const id = n && (n.id || n.codigo);
      if (id && !e._conc.has(id)) e._conc.set(id, n);
    });
    (t.notasRejeitadas || []).forEach(n => {
      const id = n && (n.id || n.codigo);
      if (id && !e._rej.has(id)) e._rej.set(id, n);
    });
  });
  const entries = Object.values(acc).map(({ _conc, _rej, ...rest }) => ({
    ...rest,
    notasConcluidas: [..._conc.values()],
    notasRejeitadas: [..._rej.values()],
  }));
  // Data operacional EFETIVA: linka reconexões vira-noite ao dia do início do
  // turno (P1-14). Mantém só as sessões cujo dia efetivo cai na janela que o
  // consolidateDay grava ({date, dayMinus1}); uma sessão de date+1 que NÃO
  // linka fica pro consolidateDay do próprio date+1.
  const effMap = _effectiveSessionDates(entries, gapMin);
  for (const e of entries) e._effDate = effMap.get(`${e.teamName}|${e.sessionBegin}`) || _sessionDate(e);
  return entries.filter(e => e._effDate === date || e._effDate === dayMinus1);
}

async function consolidateDay(date, opts = {}) {
  const sb = getClient();
  date = date || _hojeBRT();

  // Busca snapshots de date-1, date E date+1 — cobre 3 casos:
  //   - date+1: madrugada (equipe virando a noite, sessionBegin=date)
  //   - date-1: notas executadas no dia anterior carregadas na sessão atual
  //   - date: snapshots normais do dia
  const dayPlus1  = _addDays(date, 1);
  const dayMinus1 = _addDays(date, -1);

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
  // UNIÃO de todos os snapshots do dia por (equipe, sessão) — não só o último.
  // Recupera concluídas/rejeitadas que a WPA rotacionou pra fora do Concluded[]
  // ao longo do dia (ou que o _acc perdeu num restart do PM2). Ver
  // _unionTeamsFromSnapshots. Antes usava só o último snapshot e subnotificava
  // ~30-40% da produção (P1-13, medido 22/07/2026).
  const teams = _unionTeamsFromSnapshots(snaps, date, dayMinus1);
  if (teams.length === 0) {
    log.info('consolidate_no_session', { date });
    return;
  }

  log.info('consolidate_start', { date, teams: teams.length });

  // ── ENRIQUECE REJEITADAS com note_rejections (fonte autoritativa) ──────
  // O WPA limpa notasRejeitadas do payload após algumas horas, então o snapshot
  // subconta. note_rejections (cron de rejectionService) persiste os UUIDs.
  // Sem isso, uma nota rejeitada cujo payload já foi limpo voltaria a contar
  // como produção na reconsolidação (rejeitada > concluída, 20/07/2026). Mesma
  // união que _buildDiaSummary faz na view "hoje".
  try {
    const { data: rejRows } = await sb
      .from('note_rejections')
      .select('note_id, team_name, session_date')
      .in('session_date', [dayMinus1, date]);
    if (Array.isArray(rejRows) && rejRows.length) {
      const byTeamDate = new Map();
      for (const r of rejRows) {
        const k = `${r.session_date}|${r.team_name}`;
        if (!byTeamDate.has(k)) byTeamDate.set(k, new Set());
        byTeamDate.get(k).add(r.note_id);
      }
      for (const tm of teams) {
        const sd = _sessionDate(tm);
        const extra = byTeamDate.get(`${sd}|${tm.teamName}`);
        if (!extra) continue;
        const have = new Set((tm.notasRejeitadas || []).map(n => n && n.id).filter(Boolean));
        for (const id of extra) if (!have.has(id)) tm.notasRejeitadas.push({ id });
      }
    }
  } catch (errRej) {
    log.warn('consolidate_rejections_enrich_failed', { date, msg: errRej.message });
  }

  // Modo dry-run: calcula o que a produtividade SERIA (sem wipe, sem gravar) e
  // retorna. Usado por scripts/reconsolidar-produtividade.js pra medir o impacto
  // da regra rejeitada > concluída antes de aplicar no histórico.
  if (opts.dryRun) {
    const rows = _aggregateTeamDailyTotals(teams);
    const newCount = rows.reduce((s, r) => s + r.count, 0);
    return { date, teams: teams.length, newCount, rows };
  }

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
 *   - SNAPSHOTS: consolidateDay(date, {dryRun}) — UNIÃO de todos os snapshots do
 *                dia (exatamente o que o write-path gravaria). Ver nota no corpo.
 *   - TABELA   : sum(count) de team_daily_totals para o mesmo date
 *
 * ⚠️ Ambos os lados contam SÓ notasConcluidas — team_daily_totals grava apenas
 * concluídas ("Produtividade do dia = SÓ notasConcluidas", ver upsertTeamDailyTotals).
 * Versão anterior somava executadas+concluídas no lado snapshot, comparando
 * métrica de execução contra métrica de produção → drift falso-positivo crônico
 * que o auto-reparo nunca zerava (mascarava drift real). Corrigido 17/06/2026.
 *
 * Drift positivo (dryRun > tabela) = tabela DESATUALIZADA vs a lógica atual
 *   (dia não re-consolidado desde o P1-13 / regra rejeitada) → re-consolidar.
 * Drift negativo (dryRun < tabela) = tabela inflada (wipe não rodou / dupla gravação).
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

  // snapshot_count = o que a tabela DEVERIA ter pra `date`, calculado pela MESMA
  // via do write-path: consolidateDay em dryRun (UNIÃO de todos os snapshots do
  // dia + enriquecimento de rejeitadas via note_rejections + prioridade
  // rejeitada>concluída, tudo deduplicado por UUID).
  //
  // ALINHADO À UNIÃO em 23/07/2026: antes o detector usava só o ÚLTIMO snapshot
  // por (team, sessionBegin). Mas o consolidateDay migrou pra UNIÃO no P1-13
  // (22/07) — o último-snapshot subcontava (a WPA poda concluídas ao longo do
  // dia) e o detector acusava drift FALSO crônico (tabela sempre "maior" que a
  // régua velha). (Histórico: dedup por note id 08/07; só concluídas — não
  // executadas — 17/06; ambos preservados na união via _aggregateTeamDailyTotals.)
  //
  // ⚠️ RÉGUA = O PASSE DE D+1, não o de D (corrigido 25/07/2026).
  // `consolidateDay(X)` monta equipes com sessão em {X-1, X} mas WIPA {X-1, X}.
  // Logo, quem grava o valor FINAL de um dia D é o passe de D+1 (D entra nele
  // como X-1, e a janela {D, D+1} inclui as sessões da manhã seguinte). Uma nota
  // concluída em D e transmitida só numa sessão de D+1 (equipe que relogou) é
  // vista pelo passe de D+1 e NÃO pelo de D.
  // Usar o passe de D como régua subcontava ~6% e o auto-reparo então "corrigia"
  // a tabela pra baixo, APAGANDO produção legítima: medido em 25/07/2026 no
  // 07-13 (gravado 903 = passe D+1 904, contra 850 do passe de D — as 21 equipes
  // com gap batiam 1:1 com o passe D+1) e o 07-22 chegou a perder 172 OS
  // (1161 → 989) num sweep das 02:00. Ver scripts/diag-drift-team.js.
  const repair_date = _addDays(date, 1);
  const dry = await consolidateDay(repair_date, { dryRun: true });
  const snapshot_count = (dry?.rows || [])
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
    // Dia cujo passe de consolidação grava `date` — é o que o auto-reparo deve
    // rodar (consolidateDay(repair_date)), NÃO consolidateDay(date). Ver a nota
    // da régua acima: consolidateDay(date) escreveria o valor INCOMPLETO.
    repair_date,
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

    // Prioridade rejeitada > concluída > andamento > atual (decisão 20/07/2026):
    // nota rejeitada pela EDP não é produção, mesmo que também esteja concluída.
    // Precisa bater com _aggregateTeamDailyTotals, senão o drift dispara falso.
    // FONTE ÚNICA: services/bucketMath.classifyBuckets — a MESMA que a visão
    // "hoje" ao vivo (_buildDiaSummary) usa, pra histórico e ao-vivo nunca
    // divergirem (P2-2).
    const b = classifyBuckets({
      inicial, atual: atualRaw, andamento: andamentoRaw,
      concluidas: concluidasRaw, rejeitadas: rejeitadasRaw,
    });

    rows.push({
      date, team_name: team, regional: f.regional,
      carteira_inicial: b.inicial,
      entradas_novas:   b.entradas_novas,
      atual: b.atual, andamento: b.andamento, concluidas: b.concluidas,
      rejeitadas: b.rejeitadas, canceladas: b.canceladas,
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
  _addDays,
  _sessionDate, _notaDate, _aggregateTeamDailyTotals,
  _unionTeamsFromSnapshots,   // P1-13 — união dos snapshots do dia
  _effectiveSessionDates,     // P1-14 — reconexão vira-noite herda o dia do turno
};
