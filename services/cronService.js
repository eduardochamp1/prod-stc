/**
 * services/cronService.js
 * Cron jobs para coleta periódica de dados do WPA e consolidação diária.
 *
 * Agendamentos:
 *   - A cada 45 min (24/7)            → renova token WPA proativamente
 *   - A cada 15 min (06:00–20:00 BRT) → salva snapshot no Supabase
 *   - Todo dia às 20:30 BRT           → consolida daily_totals do dia
 */

const cron                    = require('node-cron');
const { getTeams, getLastSectorReport } = require('./dataService');
const { collectSnapshot: collectNotas } = require('./notasMonitor');
const { ensureFreshToken, getToken, isSectorDisabled } = require('./wpaService');
const { dateBRT, hourBRT, dateBRTMinusDays } = require('./timeUtil');
const log                     = require('./logger').forModule('cron');
// 24/10/2026 (spec wpa-acesso-edp.md, R3.1): falha do caminho até a EDP (proxy,
// IP bloqueado) para a rotina inteira no ciclo — uma linha de log com o code, e
// nada gravado por cima. Ver services/wpaErros.js.
const { ehWpaAccessError, ehFalhaDeCaminho } = require('./wpaErros');

let tokenJob        = null;
let snapshotJob     = null;
let consolidaJob    = null;
let uuidHealthJob   = null;
let retryOutrosJob  = null;
let retryRejJob     = null;
let driftJob        = null;
let notasJob        = null;
let isRunning       = false;
let isRunningAt     = 0;
let _runSeq         = 0;          // P2-23: id da execução dona do lock
let _currentRun     = 0;          // timestamp de quando isRunning foi ligado
const MAX_RUN_MS    = 5 * 60_000; // 5 minutos — destrava automaticamente se travar

// ── HELPERS DE OBSERVABILIDADE ────────────────────────────────────────────────
// Registra/limpa erros do subcat aggregation em app_settings (key: subcat_error).
// Permite que /admin/health ou logs externos detectem falhas persistentes.

async function _recordSubcatError(err) {
  try {
    const sq = require('../db/queries');
    await sq.setSetting('subcat_error', {
      message: err && err.message ? err.message : String(err),
      ts:      new Date().toISOString(),
    });
  } catch (_) { /* setting opcional — não amplifica falha */ }
}

async function _clearSubcatError() {
  try {
    const sq = require('../db/queries');
    // Marca como resolvido (não deleta, mantém histórico do último sucesso)
    await sq.setSetting('subcat_error', { message: null, ts: new Date().toISOString() });
  } catch (_) {}
}

// Registra sucesso/erro do CICLO DE SNAPSHOT em app_settings (P1-3).
// Sem isso, queda da WPA por horas era invisível — snapshot_failed só ia
// pro log do pm2. Agora /admin/health e o watchdog (P1-1) leem snapshot_last_ok
// e alertam se ficar velho. Espelha o padrão de _recordSubcatError.
async function _recordSnapshotOk(meta) {
  try {
    const sq = require('../db/queries');
    await sq.setSetting('snapshot_last_ok', { ts: new Date().toISOString(), ...meta });
  } catch (_) { /* setting opcional */ }
}

async function _recordSnapshotError(err) {
  try {
    const sq = require('../db/queries');
    await sq.setSetting('snapshot_error', {
      message: err && err.message ? err.message : String(err),
      ts:      new Date().toISOString(),
    });
  } catch (_) {}
}

// Limpa o snapshot_error quando o ciclo dá certo (mesmo parcialmente) — senão uma
// mensagem antiga fica pra sempre no /admin/health e no health-check. Falha DE
// SETOR (ex: conta desativada) não é erro de ciclo: fica em snapshot_last_ok.sectors_failed.
async function _clearSnapshotError() {
  try {
    const sq = require('../db/queries');
    await sq.setSetting('snapshot_error', { message: null, ts: new Date().toISOString() });
  } catch (_) {}
}

// ── ÚLTIMO CICLO OK POR SETOR (P1-39) ────────────────────────────────────────
// `snapshot_last_ok` responde "quando foi o último ciclo bem-sucedido" — e no
// incidente de 24-25/08/2026 ele ficou VERDE o tempo todo, porque GUA e CAC
// seguiram coletando enquanto SJC estava fora (credencial WPA inválida). A
// informação "SJC não coleta desde ontem" não existia em lugar nenhum, e o
// painel não tinha como dizer "indisponível desde HH:MM" em vez de mostrar 0.
//
// `sector_last_ok` guarda um carimbo POR SETOR. O merge é o que importa: gravar
// o mapa inteiro apagaria o histórico justamente dos setores que falharam neste
// ciclo — os únicos que precisamos datar.
function _mergeSectorLastOk(anterior, sectorsOk, ts) {
  const base = (anterior && typeof anterior === 'object' && !Array.isArray(anterior))
    ? { ...anterior }
    : {};
  for (const s of (Array.isArray(sectorsOk) ? sectorsOk : [])) {
    if (s) base[s] = ts;
  }
  return base;
}

/** Persiste o carimbo por setor. Best-effort: erro de banco não derruba o ciclo. */
async function _recordSectorLastOk(sectorsOk) {
  if (!Array.isArray(sectorsOk) || sectorsOk.length === 0) return;
  try {
    const sq = require('../db/queries');
    const row = await sq.getSetting('sector_last_ok');
    const merged = _mergeSectorLastOk(row && row.data, sectorsOk, new Date().toISOString());
    await sq.setSetting('sector_last_ok', merged);
  } catch (_) { /* setting opcional */ }
}

// Decisão PURA do desfecho do ciclo de snapshot (testável sem DB/rede):
//   teamsCount > 0                     → 'ok'    (salvou algo; sucesso, ainda que parcial)
//   0 equipes e algum setor FALHOU     → 'error' (queda real, não "dia vazio")
//   0 equipes e nada falhou            → 'empty' (legítimo: madrugada, ninguém logado,
//                                                  ou só contas desativadas)
//   0 equipes, TODO setor coletado veio
//   com 0 sessões na EDP, em expediente → 'suspeito' (P0-10, abaixo)
//
// ⚠️ 'suspeito' — INCIDENTE 16/10/2026: a EDP passou a responder 200 com
// {"Message":"Nenhum dado encontrado."} (filtro do User-Agent do node-fetch). Nada
// "falhava", então o ciclo caía em 'empty' e logava `snapshot_skipped_empty` em
// nível info — dois dias de painel zerado sem um único erro no log. Zero sessões
// de QUALQUER empresa em DESG/DEPT/DESC/DSSJ ao mesmo tempo, entre 7h e 19h BRT,
// não acontece: é falha da fonte, e vira snapshot_error (o watchdog vê).
/**
 * Tira da coleta as sessões abertas de dia anterior (P2-68, 18/10/2026). Elas vêm
 * do getTeams só para o Monitor mostrar o plantão noturno depois da meia-noite;
 * se entrassem no snapshot (gravado com a data de HOJE) e nos totais, o upsert
 * intraday reescreveria a linha de ONTEM com a visão parcial de uma só sessão
 * (família do P2-13).
 */
function _semSessaoDiaAnterior(teams) {
  return (teams || []).filter(t => !(t && t.sessaoDiaAnterior));
}

const EXPEDIENTE_BRT = { inicio: 7, fim: 19 };   // [inicio, fim)
function _classifySnapshotOutcome(teamsCount, report, horaBRT) {
  if (teamsCount > 0) return 'ok';
  if (report && Array.isArray(report.failed) && report.failed.length > 0) return 'error';
  const ok = (report && Array.isArray(report.ok)) ? report.ok : [];
  const semSessoes = new Set((report && Array.isArray(report.semSessoes)) ? report.semSessoes : []);
  const emExpediente = Number.isInteger(horaBRT)
    && horaBRT >= EXPEDIENTE_BRT.inicio && horaBRT < EXPEDIENTE_BRT.fim;
  if (emExpediente && ok.length > 0 && ok.every(s => semSessoes.has(s))) return 'suspeito';
  return 'empty';
}

// ── RENOVAÇÃO DE TOKEN ────────────────────────────────────────────────────────

// 22/08/2026: era forceRefresh() — /signin INCONDICIONAL a cada disparo, ou seja
// 32 logins/dia na conta `es`, que o projeto GQO usa nos MESMOS setores
// DESG/DESC/DEPT (P1-25). Como a WPA invalida o token anterior a cada login novo,
// os dois sistemas se derrubavam mutuamente, e o token morto voltava como 500
// "Token is invalid!" que o _safeNotes engolia em bucket vazio. Agora o `exp` do
// JWT decide: ensureFreshToken só loga dentro da margem de 30 min. O cron
// continua sendo o heartbeat — só ficou barato.
async function runTokenRefresh() {
  try {
    const r = await ensureFreshToken();
    log.info(r.refreshed ? 'token_refreshed' : 'token_ainda_valido', {
      exp: r.expireAt ? new Date(r.expireAt).toISOString() : null,
      account: r.account,
    });
  } catch (err) {
    log.error('token_refresh_failed', { code: err.code || null, msg: err.message });
  }
}

/**
 * Aquecimento de token no BOOT: usa getToken (respeita cache em memória e no
 * banco) em vez de forçar /signin. Ver P1-29.
 */
async function runTokenWarm() {
  try {
    const token = await getToken();
    log.info('token_warm_ok', { has_token: Boolean(token) });
  } catch (err) {
    log.error('token_warm_failed', { code: err.code || null, msg: err.message });
  }
}

// ── NOTAS DEVOLVIDAS (monitor de tratamento backoffice) ─────────────────────

async function runNotasCollect() {
  try {
    const r = await collectNotas();
    log.info('notas_collect_ok', r);
  } catch (err) {
    log.error('notas_collect_failed', { code: err.code || null, msg: err.message });
  }
}

// ── ALERTA DE BAIXA PRODUTIVIDADE (14/10/2026) ───────────────────────────────
// Roda logo depois de `upsertTeamDailyTotals` no MESMO ciclo, então os totais que
// ele lê (team_daily_totals) já são os deste ciclo. Spec:
// docs/handoff/SPEC-alerta-produtividade-2026-10-14.md.
//
// Este é só o FIO que liga o avaliador às dependências reais: a regra e o
// orquestrador vivem em services/alertaProdutividade.js e são 100% injetáveis
// (P2-39 — funções de cron são invisíveis à suíte). Os `require` ficam aqui
// dentro, preguiçosos, de propósito: com o alerta DESLIGADO (padrão) este ciclo
// faz UMA leitura em app_settings e mais nada — nenhuma chamada à WPA, nenhuma
// escrita. Só equipes REAIS (`teams`): as fantasmas do _acc já deslogaram.
async function runAlertaProdutividade(teams) {
  if (process.env.DATA_MODE === 'mock') return null;
  const { avaliarCiclo } = require('./alertaProdutividade');
  const { _sessionDate } = require('./dataWriter');
  const { getMeta } = require('./equipesOficiais');
  const { getSessionBreaks } = require('./wpaService');
  const { getSetting } = require('../db/queries');
  const Q = require('../db/alertasQueries');

  return avaliarCiclo({
    agora: () => new Date(),
    teams,
    sessionDate: _sessionDate,
    lerConfig: async () => {
      const linha = await getSetting('alerta_produtividade');
      return linha ? linha.data : null;
    },
    getMeta,
    estadoDoDia: (data) => Q.estadoDoDia(null, data),
    executadasPorEquipe: (data) => Q.executadasPorEquipe(null, data),
    historicoSupervisores: () => Q.historicoSupervisores(null),
    lerRefeicao: (sessionId) => getSessionBreaks(sessionId),
    gravar: {
      abrir:     (l)        => Q.abrir(null, l),
      atualizar: (d, t, c)  => Q.atualizar(null, d, t, c),
      resolver:  (d, t, c)  => Q.resolver(null, d, t, c),
    },
    log,
  });
}

// ── SNAPSHOT ──────────────────────────────────────────────────────────────────

async function runSnapshot() {
  // Verifica se uma execução anterior travou (não liberou isRunning em 5 min)
  if (isRunning) {
    const elapsed = Date.now() - isRunningAt;
    if (elapsed < MAX_RUN_MS) {
      log.info('snapshot_skipped_concurrent', { elapsed_s: Math.round(elapsed / 1000) });
      return;
    }
    log.warn('snapshot_unstuck', { elapsed_s: Math.round(elapsed / 1000) });
  }
  isRunning   = true;
  isRunningAt = Date.now();
  // 13/10/2026 — P2-23: token de execução. Sem ele, o finally de uma execução
  // antiga (destravada pelo MAX_RUN_MS) zerava o lock da NOVA e liberava uma
  // terceira, sobrepondo execuções (snapshots é insert puro: duplica linhas).
  const myRun = ++_runSeq;
  _currentRun = myRun;
  try {
    // P1-30 (20/08/2026): o report tem que ser o DESTA chamada. Antes lia o
    // global, que um /api/teams de browser podia sobrescrever durante os
    // enriches — snapshot gravava saúde verde com setor faltando.
    const sectorOut = {};
    // P2-66 (16/10/2026): o setor que falhar ganha 1 nova tentativa, depois dos
    // outros. Só aqui — o /api/teams do navegador não espera mais 45s.
    const coletadas = await getTeams({ repetirSetorFalho: true }, sectorOut);
    // P2-68 (18/10/2026): sessão aberta de dia anterior (plantão noturno depois
    // da meia-noite) é SÓ exibição do Monitor. Nada persistido muda: fora do
    // snapshot, do teams_current e dos totais. A produção do plantão segue com o
    // dia em que o turno começou, pelos snapshots do próprio dia — exatamente
    // como antes desta consulta existir.
    const allTeams = _semSessaoDiaAnterior(coletadas);
    const sectorReport = sectorOut.report || getLastSectorReport();   // { ok, failed, skipped } por setor

    // Separa equipes reais (vindas do WPA) das equipes-fantasma (_ghostFromAcc).
    // Ghosts existem para manter KPIs no frontend e nos totais quando uma equipe
    // desloga — mas NÃO devem ir para snapshots/teams_current: entrariam no
    // aliveNames do pushTeams e impediriam a deleção de sessões encerradas.
    const teams     = allTeams.filter(t => !t._ghostFromAcc);
    const ghostCount = allTeams.length - teams.length;
    if (ghostCount > 0) {
      log.info('ghost_teams', { count: ghostCount });
    }

    // 24/10/2026 (spec wpa-acesso-edp.md, R3.1): o caminho até a EDP caiu no meio
    // do ciclo (proxy, IP bloqueado) — setores coletados antes da queda NÃO são
    // gravados sozinhos: snapshot parcial vira subcontagem nos totais do dia. Uma
    // linha de log, snapshot_error registrado, e o próximo ciclo tenta de novo.
    if (sectorReport && sectorReport.caminho) {
      log.error('rotina_sem_acesso_edp', { rotina: 'snapshot', code: sectorReport.caminho,
        coletados_descartados: sectorReport.ok, failed: sectorReport.failed.map(f => f.sector) });
      await _recordSnapshotError(new Error(`sem acesso à EDP (${sectorReport.caminho}) — ciclo não gravado`));
      return; // finally abaixo libera isRunning corretamente
    }

    if (teams.length === 0) {
      // Distingue "dia vazio" de QUEDA REAL: se todos os setores ativos falharam,
      // é queda da WPA — tem de virar snapshot_error (senão o watchdog não vê).
      const desfecho = _classifySnapshotOutcome(0, sectorReport, hourBRT());
      if (desfecho === 'error') {
        log.error('snapshot_all_sectors_failed', { failed: sectorReport.failed });
        await _recordSnapshotError(new Error(
          `todos os setores ativos falharam: ${sectorReport.failed.map(f => f.sector).join(', ')}`));
      } else if (desfecho === 'suspeito') {
        // P0-10: nada gravado (não há o que gravar), mas o ciclo é FALHA.
        log.error('snapshot_vazio_suspeito', { setores: sectorReport.ok });
        await _recordSnapshotError(new Error(
          `EDP devolveu 0 sessões em todos os setores (${sectorReport.ok.join(', ')}) em horário de expediente — ` +
          `"Nenhum dado encontrado" é falha da fonte, não dia vazio (P0-10)`));
      } else {
        log.info('snapshot_skipped_empty', { skipped: sectorReport.skipped });
      }
      return; // finally abaixo libera isRunning corretamente
    }

    const ts = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const { saveSnapshot, pushTeams, upsertDailyTotals, upsertTeamDailyTotals, upsertSubcatTotals, upsertTeamDailyCarteira } = require('./dataWriter');

    // snapshots e teams_current: apenas equipes reais (sem ghosts)
    await saveSnapshot(teams);
    await pushTeams(teams);

    // Totais diários: todas as equipes (real + ghost do _acc) — preserva notas
    // acumuladas de equipes que deslogaram durante o dia. Ghost teams têm regional
    // e notas corretas; _sessionDate atribui cada equipe ao seu dia de sessionBegin
    // (não importa o conclusionDate individual de cada nota).
    await upsertDailyTotals(allTeams);
    await upsertTeamDailyTotals(allTeams);

    // Alerta de baixa produtividade (14/10/2026). DEPOIS do upsert acima (lê
    // team_daily_totals do ciclo) e SEM await: não pode atrasar nem derrubar o
    // snapshot — mesmo padrão de upsertTeamDailyCarteira / runClassifyNewNotes.
    runAlertaProdutividade(teams).catch(err =>
      log.error('alerta_produtividade_failed', { msg: err.message })
    );

    log.info('snapshot_saved', { teams: teams.length, ghosts: ghostCount, at: ts });
    // Marca sucesso do ciclo pra observabilidade (P1-3) — /admin/health e
    // watchdog leem snapshot_last_ok pra detectar queda da WPA. Inclui o estado
    // POR SETOR: sucesso do ciclo não é mais tudo-ou-nada entre contas — enquanto
    // UMA conta ativa coletar, o marcador fica fresco, e as contas fora ficam
    // visíveis em sectors_failed/sectors_skipped (o watchdog distingue "SP
    // desativado de propósito" de "queda real").
    _recordSnapshotOk({
      teams: teams.length, ghosts: ghostCount,
      sectors_ok:      sectorReport.ok,
      sectors_skipped: sectorReport.skipped,
      sectors_failed:  sectorReport.failed.map(f => f.sector),
    });
    _recordSectorLastOk(sectorReport.ok);   // carimbo por setor (P1-39)
    _clearSnapshotError();   // ciclo deu certo → limpa erro de ciclo antigo
    if (sectorReport.failed.length > 0) {
      log.warn('snapshot_partial', {
        ok: sectorReport.ok, failed: sectorReport.failed, skipped: sectorReport.skipped,
        retried: sectorReport.retried || [] });
    } else if (sectorReport.retried && sectorReport.retried.length > 0) {
      // Setor caiu na 1ª tentativa e voltou na 2ª: ciclo completo. Fica no log
      // pra medir se a nova tentativa está resolvendo (P2-66).
      log.info('snapshot_sector_recovered', { retried: sectorReport.retried });
    }

    // Aproveitamento de carteira por equipe (team_daily_carteira) — histórico
    // permanente do que estava disponível vs executado. Lê dos snapshots recém
    // gravados; não bloqueia o ciclo.
    upsertTeamDailyCarteira().catch(err =>
      log.error('team_daily_carteira_failed', { msg: err.message })
    );

    // Classifica subcategorias dos UUIDs novos (não bloqueia o snapshot).
    // Quando concluir, dispara upsertSubcatTotals pra atualizar team_daily_subcat_totals.
    // Usa allTeams (real + ghost) para incluir notas de equipes deslogadas.
    //
    // Auto-recovery: se uma execução anterior tiver falhado (registrado em
    // app_settings → 'subcat_pending'), tenta também reprocessar essa data.
    // Falhas são registradas com timestamp para visibilidade no /admin.
    runClassifyNewNotes(allTeams)
      .then(async () => {
        try {
          await upsertSubcatTotals(allTeams);
          await _clearSubcatError();      // sucesso: limpa flag de erro pendente
        } catch (err) {
          console.warn('[CRON] upsertSubcatTotals intraday falhou:', err.message);
          await _recordSubcatError(err);
          throw err;
        }
      })
      .catch(err => log.error('classify_subcat_failed', { msg: err.message }));

    // Faz cache do payload completo das OS finalizadas (não bloqueia o snapshot).
    // Roda no servidor Engelmig (com IP autorizado pela WPA) e popula
    // `note_details` no Supabase, que é lido instantaneamente pela rota
    // /api/wpa/nota — inclusive na Vercel, que não consegue falar com a WPA.
    runCacheNotaDetails(teams).catch(err =>
      log.error('cache_note_details_failed', { msg: err.message })
    );

    // Classifica motivos das notas REJEITADAS (não bloqueia o snapshot).
    // Usa allTeams (real + ghost) pra incluir rejeições de equipes deslogadas.
    runClassifyRejections(allTeams).catch(err =>
      log.error('classify_rejections_failed', { msg: err.message })
    );

    // Interrupções de MD (07/10/2026) → note_interrupcoes. Só equipes REAIS:
    // as fantasma vêm do _acc, que não guarda o executionStatus usado como
    // gatilho. Não bloqueia o snapshot. Ver services/interrupcaoService.js.
    require('./interrupcaoService').runColetaInterrupcoes(teams).catch(err =>
      log.error('coleta_interrupcoes_failed', { msg: err.message })
    );

    // Sincroniza escala (ShiftType do WPA) → equipes_oficiais.escala_inicio.
    // Não bloqueia o snapshot. Só grava quando o valor muda (idempotente).
    runSyncEscalas(teams).catch(err =>
      log.error('sync_escalas_failed', { msg: err.message })
    );

    // Persiste o catálogo de turnos da EDP (scaletypes/matches) em
    // escalas_catalogo. getScaleTypes tem cache de 12h, então na prática isso é
    // 1 request por setor por meio-dia. Não bloqueia o snapshot.
    runSyncEscalaCatalogo().catch(err =>
      log.error('sync_escala_catalogo_failed', { msg: err.message })
    );
  } catch (err) {
    log.error('snapshot_failed', { msg: err.message });
    _recordSnapshotError(err);   // P1-3: falha visível no /admin/health
  } finally {
    if (_currentRun === myRun) isRunning = false;
  }
}

// ── SYNC DE ESCALAS (ShiftType do WPA → equipes_oficiais) ──────────────────────
// A EDP expõe o turno real de cada equipe no campo ShiftType do /teamsstatus/V2
// (ex: "T15 15:00"). wpaService já extrai isso pra t.escalaInicioWPA ("HH:MM").
// Aqui comparamos com a escala_inicio salva e atualizamos quando diverge —
// elimina manutenção manual e mantém o indicador de atraso de logon correto.
//
// 22/08/2026 — este comentário dizia "só mexe em escala_inicio (o WPA não
// informa o fim do turno); escala_fim continua editável manualmente via Admin".
// Estava errado em duas frentes: o código JÁ gravava escala_fim (com o valor
// INFERIDO início+9h), e o WPA informa o fim de verdade — em
// GET /api/scaletypes/matches, endpoint que os outros três projetos da empresa
// usam e nós não. Agora t.escalaFimWPA vem do catálogo, com o +9h só como
// fallback pra turno não catalogado. Edição manual via Admin é sobrescrita pelo
// cron, como já era antes — o que mudou é que o valor gravado deixou de ser um
// palpite.
async function runSyncEscalas(teams) {
  if (process.env.DATA_MODE === 'mock') return;
  if (!teams || teams.length === 0) return;

  const { getMeta, forceRefresh } = require('./equipesOficiais');
  const { getClient } = require('./dbClient');
  const sb = getClient();
  if (!sb) return;

  const updates = [];
  const seen = new Set();
  for (const t of teams) {
    const sigla = (t.sigla || t.teamName || '').toUpperCase().trim();
    if (!sigla || seen.has(sigla)) continue;
    seen.add(sigla);

    const novaEscala = t.escalaInicioWPA;        // "HH:MM" ou null
    if (!novaEscala) continue;                    // WPA não informou turno
    const novoFim = t.escalaFimWPA || null;       // início + 9h (inferido)

    const meta = getMeta(sigla);
    if (!meta) continue;                          // não é equipe oficial
    const atual    = meta.escala_inicio ? String(meta.escala_inicio).slice(0, 5) : null;
    const atualFim = meta.escala_fim    ? String(meta.escala_fim).slice(0, 5)    : null;

    if (atual !== novaEscala || atualFim !== novoFim) {
      updates.push({ sigla, de: atual, para: novaEscala, deFim: atualFim, paraFim: novoFim });
    }
  }

  if (updates.length === 0) return;

  let ok = 0;
  for (const u of updates) {
    const { error } = await sb
      .from('equipes_oficiais')
      .update({ escala_inicio: u.para, escala_fim: u.paraFim, updated_at: new Date().toISOString() })
      .eq('sigla', u.sigla);
    if (!error) ok++;
    else console.warn(`[CRON] sync-escalas: falha em ${u.sigla}: ${error.message}`);
  }

  if (ok > 0) {
    await forceRefresh();   // invalida cache em memória pra refletir já
    console.log(`[CRON] sync-escalas: ✓ ${ok} escala(s) atualizada(s) — ` +
      updates.slice(0, 8).map(u => `${u.sigla} ${u.de || '∅'}-${u.deFim || '∅'}→${u.para}-${u.paraFim}`).join(', ') +
      (updates.length > 8 ? ` (+${updates.length - 8})` : ''));
  }
}

// ── CATÁLOGO DE TURNOS (scaletypes/matches → escalas_catalogo) ────────────────
// Espelha no banco a definição de turno que a EDP publica por setor: entrada,
// janela de intervalo, saída, e ciclo de dias trabalhados/folga.
//
// Serve a três coisas (22/08/2026): auditar de onde saiu o escala_fim de cada
// equipe; dar ao P1-26 os dias de folga, que é o que falta pra "equipe não
// logou" parar de acusar quem está de folga; e dar ao P2-15 o intervalo
// previsto pra comparar com o realizado.
//
// Tolera a migration 012 não ter rodado: loga e segue. O painel não depende
// desta tabela — o fim do turno já chega pelo catálogo em memória.
async function runSyncEscalaCatalogo() {
  if (process.env.DATA_MODE === 'mock') return;

  const { getScaleTypes, isSectorDisabled: setorDesativado } = require('./wpaService');
  const { getClient } = require('./dbClient');
  const sb = getClient();
  if (!sb) return;

  const SETORES = ['DESG', 'DEPT', 'DESC', 'DSSJ'];
  let gravados = 0;
  let turnos   = 0;

  for (const sectorId of SETORES) {
    if (setorDesativado(sectorId)) continue;   // conta desativada — não cutuca (P1-21)

    let catalogo;
    try {
      catalogo = await getScaleTypes(sectorId);
    } catch (err) {
      if (ehFalhaDeCaminho(err)) throw err;   // 24/10/2026: proxy/IP — para o ciclo, 1 log no job
      log.warn('escala_catalogo_fetch_falhou', { sectorId, msg: err.message });
      continue;
    }
    if (!catalogo || catalogo.length === 0) continue;
    turnos += catalogo.length;

    const linhas = catalogo.map(e => ({
      codigo:               e.codigo,
      sector_id:            sectorId,
      descricao:            e.descricao,
      inicio_escala:        e.inicio,
      inicio_intervalo:     e.intervaloInicio,
      fim_intervalo:        e.intervaloFim,
      fim_escala:           e.fim,
      dias_trabalhados:     e.diasTrabalho,
      dias_nao_trabalhados: e.diasFolga,
      updated_at:           new Date().toISOString(),
    }));

    const { error } = await sb
      .from('escalas_catalogo')
      .upsert(linhas, { onConflict: 'codigo,sector_id' });

    if (error) {
      // Tabela ausente = migration 012 pendente. É aviso, não falha do ciclo.
      const faltaTabela = /escalas_catalogo|does not exist|relation/i.test(error.message || '');
      if (faltaTabela) {
        log.warn('escala_catalogo_sem_tabela', { msg: 'rode supabase/migrations/012_escalas_catalogo.sql' });
        return;   // não insiste nos outros setores
      }
      log.warn('escala_catalogo_upsert_falhou', { sectorId, msg: error.message });
      continue;
    }
    gravados += linhas.length;
  }

  if (gravados > 0) {
    log.info('escala_catalogo_ok', { turnos, gravados });
  }
}

// ── ESCALA CADASTRADA POR DIA (collaboratorshifts → escala_dia) ───────────────
// Traz a escala PLANEJADA do mês corrente para cada setor e grava no grão do
// colaborador. É o que permite ao /admin/health parar de acusar equipe de folga
// como "não logou" (P1-26) — ver services/escalaDia.js.
//
// Custo: 1 request por setor por execução. Roda 1x/dia de propósito: a conta `es`
// é compartilhada com outro projeto da empresa (P1-25), e pendurar isso na cauda
// do snapshot custaria ~384 requests/dia para um dado que muda uma vez ao dia.
//
// 18/10/2026 (P2-65): "muda uma vez ao dia" estava errado. Domingo, 15:00: 9
// equipes em campo com DR gravado (sync das 05:20) e C08 no ShiftType do V2; um
// sync manual às 15:11 trouxe C08 para 8 delas — a EDP lança a convocação no
// collaboratorshifts DURANTE o dia. Agora roda a cada 30 min, 05:20–22:20
// (35 execuções × 4 setores = 140 requests/dia, ainda ~1/3 do que o comentário
// acima temia).
//
// No mesmo dia: 61 linhas de HOJE que o sync não trazia mais seguiam gravadas
// (upsert sem DELETE) — colaborador que a EDP tirou da escala continuava
// "esperado". Depois de gravar um setor, apaga as linhas dele de hoje até o fim
// do mês que este sync não tocou. Dias PASSADOS ficam como estão: são o
// registro do que estava planejado, e a EDP pode reescrevê-los depois.
//
// Tolera a migration 013 não ter rodado: loga e segue, e o health degrada pro
// comportamento antigo em vez de suprimir equipe no escuro.
async function runSyncEscalaDia() {
  if (process.env.DATA_MODE === 'mock') return;

  const { getCollaboratorShifts, isSectorDisabled: setorDesativado } = require('./wpaService');
  const { getClient } = require('./dbClient');
  const sb = getClient();
  if (!sb) return;

  // Mês/ano de HOJE em BRT. Usar o relógio do servidor (UTC) faria a virada do
  // mês acontecer 3h antes aqui do que na operação.
  const hoje = dateBRT();                       // 'YYYY-MM-DD'
  const [ano, mes] = hoje.split('-').map(Number);
  const proximoMes = mes === 12 ? `${ano + 1}-01-01` : `${ano}-${String(mes + 1).padStart(2, '0')}-01`;
  // Um carimbo só para a execução inteira: o que ficar com updated_at anterior a
  // ele no setor gravado é linha que a EDP não devolveu mais.
  const syncAt = new Date().toISOString();

  const SETORES = ['DESG', 'DEPT', 'DESC', 'DSSJ'];
  let linhasTotal = 0;
  let gravadas    = 0;
  let orfasApagadas = 0;

  for (const sectorId of SETORES) {
    if (setorDesativado(sectorId)) continue;     // conta desativada — não cutuca (P1-21)

    let linhas;
    try {
      linhas = await getCollaboratorShifts(sectorId, mes, ano);
    } catch (err) {
      if (ehFalhaDeCaminho(err)) throw err;   // 24/10/2026: proxy/IP — para o ciclo, 1 log no job
      log.warn('escala_dia_fetch_falhou', { sectorId, mes, ano, msg: err.message });
      continue;
    }
    if (!linhas || linhas.length === 0) continue;
    linhasTotal += linhas.length;

    const rows = linhas.map(l => ({
      data:               l.data,
      sector_id:          l.sectorId,
      equipe:             l.equipe,
      colaborador_codigo: l.colaboradorCodigo || '',   // PK não aceita nulo
      colaborador_nome:   l.colaboradorNome,
      codigo_escala:      l.codigoEscala,
      updated_at:         syncAt,
    }));

    const { error } = await sb
      .from('escala_dia')
      .upsert(rows, { onConflict: 'data,sector_id,equipe,colaborador_codigo' });

    if (error) {
      const faltaTabela = /escala_dia|does not exist|relation/i.test(error.message || '');
      if (faltaTabela) {
        log.warn('escala_dia_sem_tabela', { msg: 'rode supabase/migrations/013_escala_dia.sql' });
        return;                                  // não insiste nos outros setores
      }
      log.warn('escala_dia_upsert_falhou', { sectorId, msg: error.message });
      continue;
    }
    gravadas += rows.length;

    // Só chega aqui com resposta NÃO vazia e upsert ok — resposta vazia ou erro
    // nunca apaga a escala do setor.
    const { error: errDel, count } = await sb
      .from('escala_dia')
      .delete({ count: 'exact' })
      .eq('sector_id', sectorId)
      .gte('data', hoje)
      .lt('data', proximoMes)
      .lt('updated_at', syncAt);
    if (errDel) {
      log.warn('escala_dia_limpeza_falhou', { sectorId, msg: errDel.message });
    } else if (count) {
      orfasApagadas += count;
      log.info('escala_dia_orfas_apagadas', { sectorId, apagadas: count });
    }
  }

  if (gravadas > 0) {
    log.info('escala_dia_ok', { mes, ano, linhas: linhasTotal, gravadas, orfasApagadas });
  }
  return { mes, ano, linhas: linhasTotal, gravadas, orfasApagadas };
}

// ── INTERVALOS DA SESSÃO (sessions/{id}/break → sessao_intervalo) ─────────────
// O dado que explica POR QUE a equipe está parada — refeição, callback, oficina —
// e quem autorizou. Sem ele o painel não distingue parada legítima de desvio
// (P2-15).
//
// Cadência DIÁRIA sobre as sessões de D-1, não no ciclo de 15min: é 1 request
// por SESSÃO (~130/dia). No ciclo custaria ~2.900 requests/dia na conta que já
// é compartilhada com outro projeto da empresa (P1-25). Roda às 03:10, depois do
// sync-logoffs das 03:00, quando o dia já fechou e os intervalos não mudam mais.
//
// Tolera a migration 014 não ter rodado: loga e para. Nada no painel depende
// desta tabela ainda.
async function runSyncIntervalos(date) {
  if (process.env.DATA_MODE === 'mock') return;

  const { getSessionsByDate, getSessionBreaks, isSectorDisabled: setorDesativado,
          ENGELMIG_COMPANY_ID } = require('./wpaService');
  const { getClient } = require('./dbClient');
  const sb = getClient();
  if (!sb) return;

  const dia = date || dateBRTMinusDays(1);
  const SETORES = ['DESG', 'DEPT', 'DESC', 'DSSJ'];
  let sessoes = 0, intervalos = 0, gravados = 0;

  for (const sectorId of SETORES) {
    if (setorDesativado(sectorId)) continue;    // conta desativada (P1-21)

    let lista;
    try {
      lista = await getSessionsByDate(sectorId, dia);
    } catch (err) {
      if (ehFalhaDeCaminho(err)) throw err;   // 24/10/2026: proxy/IP — para o ciclo, 1 log no job
      log.warn('intervalos_sessoes_falhou', { sectorId, dia, msg: err.message });
      continue;
    }

    // Só as nossas: sem o filtro de CompanyId entrariam paradas de outras
    // empreiteiras do setor.
    const nossas = (lista || []).filter(s => s.Team?.CompanyId === ENGELMIG_COMPANY_ID);

    for (const s of nossas) {
      if (!s.Id) continue;
      sessoes++;

      let breaks;
      try {
        breaks = await getSessionBreaks(s.Id);
      } catch (err) {
        if (ehFalhaDeCaminho(err)) throw err;   // 24/10/2026: proxy/IP — para o ciclo, 1 log no job
        log.warn('intervalos_break_falhou', { sessionId: s.Id, msg: err.message });
        continue;
      }
      if (!breaks || breaks.length === 0) continue;   // sessão sem parada é normal
      intervalos += breaks.length;

      const rows = breaks.map(b => ({
        session_id:  s.Id,
        inicio:      b.inicio,
        fim:         b.fim,
        data:        (s.BeginTime || dia).slice(0, 10),
        sector_id:   sectorId,
        equipe:      (s.Team?.Name || '').trim() || null,
        motivo:      b.motivo,
        responsavel: b.responsavel,
        updated_at:  new Date().toISOString(),
      }));

      const { error } = await sb
        .from('sessao_intervalo')
        .upsert(rows, { onConflict: 'session_id,inicio' });

      if (error) {
        const faltaTabela = /sessao_intervalo|does not exist|relation/i.test(error.message || '');
        if (faltaTabela) {
          log.warn('intervalos_sem_tabela', { msg: 'rode supabase/migrations/014_sessao_intervalo.sql' });
          return;
        }
        log.warn('intervalos_upsert_falhou', { sessionId: s.Id, msg: error.message });
        continue;
      }
      gravados += rows.length;
    }
  }

  if (gravados > 0) {
    log.info('intervalos_ok', { dia, sessoes, intervalos, gravados });
  }
  return { dia, sessoes, intervalos, gravados };
}

// ── CACHE DE DETALHES DE OS ───────────────────────────────────────────────────
// Para cada OS concluída/rejeitada que ainda não está em `note_details`, busca
// o payload completo via WPA (sem fotos) e salva no Supabase. Limita a N por
// ciclo para não exceder o tempo do cron quando há muitas pendentes.

const MAX_CACHE_POR_CICLO = 30;

async function runCacheNotaDetails(teams) {
  if (process.env.DATA_MODE === 'mock') return;

  // 1) Coleta UUIDs únicos de OS finalizadas (concluída ou rejeitada)
  const candidatos = [];
  const visto = new Set();
  (teams || []).forEach(t => {
    const fim = [...(t.notasConcluidas || []), ...(t.notasRejeitadas || [])];
    fim.forEach(n => {
      if (!n.id || visto.has(n.id)) return;
      visto.add(n.id);
      candidatos.push({
        id:       n.id,
        numero:   n.codigo || null,
        tipo:     n.tipoCode || null,
        sectorId: t.sectorId || 'DESG',
      });
    });
  });

  if (candidatos.length === 0) return;

  // 2) Filtra os que ainda não estão no cache
  const sq = require('../db/queries');
  const idsFaltando = await sq.filtrarNotesNaoCacheadas(candidatos.map(c => c.id));
  if (idsFaltando.length === 0) {
    console.log(`[CRON] Cache OS: nada novo (${candidatos.length} UUIDs, todos cacheados)`);
    return;
  }

  // 3) Pega N por ciclo p/ não bloquear
  const idSet = new Set(idsFaltando);
  const lote  = candidatos.filter(c => idSet.has(c.id)).slice(0, MAX_CACHE_POR_CICLO);
  console.log(`[CRON] Cache OS: ${idsFaltando.length} pendentes — processando ${lote.length}`);

  // 4) Busca + processa + grava. O TRABALHO POR NOTA vive em
  //    `services/noteDetailCacher.js` — o backfill retroativo usa o mesmo
  //    codigo. Ver o cabecalho de la pro porque (licao do P1-47).
  const { cachearLote } = require('./noteDetailCacher');

  const t0 = Date.now();
  const r  = await cachearLote(lote);

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[CRON] Cache OS: gravadas ${r.ok}/${lote.length} (falhas ${r.falha}) em ${dt}s`);
}

// ── CLASSIFICAÇÃO DE SUBCATEGORIAS ────────────────────────────────────────────
// Após cada snapshot, identifica os UUIDs novos (que ainda não estão em
// note_subcategorias) e classifica via endpoints leves do WPA. Resultado é
// gravado no Supabase para servir o frontend instantaneamente.

async function runClassifyNewNotes(teams) {
  // Coleta todos os UUIDs presentes neste snapshot, com seu tipo e sectorId
  const jobs = [];
  const seen = new Set();
  (teams || []).forEach(t => {
    const todas = [
      ...(t.notasConcluidas  || []),
      ...(t.notasExecutadas  || []),
      ...(t.notasBaixadas    || []),
      ...(t.notasRejeitadas  || []),
      ...(t.notasVistoriadas || []),
    ];
    todas.forEach(n => {
      if (!n.id || seen.has(n.id)) return;
      const tipo = (n.tipoCode || '').toUpperCase();
      // Só classifica MD, SF e DD — outros tipos não têm subcategoria de interesse
      if (!['MD','SF','DD'].includes(tipo)) return;
      seen.add(n.id);
      jobs.push({
        noteId:   n.id,
        tipo,
        sectorId: t.sectorId || 'DESG',
        numero:   n.codigo || null,
      });
    });
  });

  if (jobs.length === 0) return;

  // getClassifiedIdsComplete exclui notas DD com C93/BTZ013 e quantidade=null,
  // permitindo que sejam re-tentadas para obter o Amount (metros/unid.) do WPA.
  const { getClassifiedIdsComplete, upsertSubcategorias } = require('../db/subcategoriasQueries');
  const { classificarBatch } = require('./classifierService');

  // Filtra os que já estão COMPLETAMENTE classificados no Supabase
  const known = await getClassifiedIdsComplete();
  const todo  = jobs.filter(j => !known.has(j.noteId));
  if (todo.length === 0) {
    console.log(`[CRON] Subcategorias: nada novo (${jobs.length} UUIDs, todos cacheados)`);
    return;
  }

  console.log(`[CRON] Classificando subcategorias: ${todo.length} novas (${jobs.length - todo.length} cacheadas)`);
  const t0 = Date.now();
  const classifs = await classificarBatch(todo, 10);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  if (classifs.length > 0) {
    const saved = await upsertSubcategorias(classifs);
    console.log(`[CRON] Subcategorias gravadas: ${saved} (em ${dt}s)`);
  } else {
    console.log(`[CRON] Subcategorias: classificador retornou vazio (em ${dt}s)`);
  }
}

// ── CLASSIFICAÇÃO DE REJEIÇÕES (motivos canônicos) ─────────────────────────────
// Para cada nota em `notasRejeitadas[]` de um snapshot, chama o endpoint
// específico do tipo (/api/notes/{md|sf|dd|...}) e extrai Rejection.RejectionReasons[].
// Grava em `note_rejections`.
//
// Concorrência baixa (4) — cada chamada é ~2 KB mas roda em paralelo com
// outras tarefas do snapshot. Aplica `seen` por noteId pra deduplicar.

async function runClassifyRejections(teams) {
  if (process.env.DATA_MODE === 'mock') return;
  if (!teams || teams.length === 0) return;

  const { getClient } = require('./dbClient');
  const { fetchRejectionDetails } = require('./rejectionService');
  const sb = getClient();
  if (!sb) return;

  // 1) Coleta UUIDs únicos de rejeitadas, com contexto da equipe.
  // Política B(a): todos os colaboradores da sessão recebem 1 ponto cada
  // por rejeição. Por isso guardamos arrays codes+names.
  const jobs = [];
  const seen = new Set();
  teams.forEach(t => {
    if (!t.sessionBegin) return;  // sem sessão = sem data efetiva
    const sessDate = String(t.sessionBegin).slice(0, 10);

    const collabs = (t.collaborators || []).map(c => ({
      code: String(c?.code || c?.Code || c?.matricula || '').trim(),
      name: String(c?.name || c?.Name || '').trim(),
    })).filter(c => c.code);
    const collaborator_codes = collabs.map(c => c.code);
    const collaborator_names = collabs.map(c => c.name);

    (t.notasRejeitadas || []).forEach(n => {
      if (!n.id || seen.has(n.id)) return;
      const tipo = (n.tipoCode || '').toUpperCase();
      if (!tipo) return;
      seen.add(n.id);
      jobs.push({
        note_id:      n.id,
        numero:       n.codigo || null,
        tipo,
        team_name:    t.teamName || t.sigla,
        regional:     t.regional || null,
        sector_id:    t.sectorId || null,
        session_date: sessDate,
        collaborator_codes,
        collaborator_names,
      });
    });
  });

  if (jobs.length === 0) return;

  // 2) Filtra UUIDs que já estão em note_rejections (paginado pra cobrir > 1000)
  const ids = jobs.map(j => j.note_id);
  const jaCacheadas = new Set();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data } = await sb.from('note_rejections')
      .select('note_id').in('note_id', chunk);
    (data || []).forEach(r => jaCacheadas.add(r.note_id));
  }
  const todo = jobs.filter(j => !jaCacheadas.has(j.note_id));
  if (todo.length === 0) {
    console.log(`[CRON] rejeicoes: nada novo (${jobs.length} UUIDs, todos cacheados)`);
    return;
  }

  console.log(`[CRON] rejeicoes: ${todo.length} novas a coletar (${jobs.length - todo.length} já cacheadas)`);
  const t0 = Date.now();

  // 3) Coleta detalhes em paralelo controlado (concorrência 4 — WPA-friendly).
  // Mesmo se WPA não retornar detalhes, gravamos a rejeição (motivos vazios)
  // pra contagem ficar correta no dashboard.
  const linhas = [];
  for (let i = 0; i < todo.length; i += 4) {
    const chunk = todo.slice(i, i + 4);
    const results = await Promise.all(chunk.map(async j => {
      try {
        const det = await fetchRejectionDetails(j.note_id, j.tipo);
        return {
          note_id:        j.note_id,
          numero:         j.numero,
          tipo:           j.tipo,
          team_name:      j.team_name,
          regional:       j.regional,
          sector_id:      j.sector_id,
          rejection_date: det?.rejection_date || null,
          session_date:   j.session_date,
          observacao:     det?.observacao || null,
          motivo_codes:   det?.motivo_codes  || [],
          motivo_textos:  det?.motivo_textos || [],
          formulario:     det?.formulario    || null,
          collaborator_codes: j.collaborator_codes,
          collaborator_names: j.collaborator_names,
          raw:            det?.raw || null,
        };
      } catch (err) {
        if (ehFalhaDeCaminho(err)) throw err;   // 24/10/2026: proxy/IP — para o ciclo, 1 log no job
        console.warn(`[CRON] rejeicoes: ${j.numero || j.note_id} falhou: ${err.message}`);
        return null;
      }
    }));
    results.forEach(r => { if (r) linhas.push(r); });
  }

  if (linhas.length === 0) return;

  // 4) Insere em batch (UPSERT pra ser idempotente)
  const { error } = await sb.from('note_rejections')
    .upsert(linhas, { onConflict: 'note_id' });
  if (error) {
    console.warn(`[CRON] rejeicoes: falha ao gravar: ${error.message}`);
    return;
  }

  const comMotivo = linhas.filter(l => l.motivo_codes.length > 0).length;
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[CRON] rejeicoes: ✓ ${linhas.length} gravadas em ${dt}s (${comMotivo} com motivo, ${linhas.length - comMotivo} sem)`);
}

// ── BACKFILL HISTÓRICO DE REJEIÇÕES ────────────────────────────────────────────
// Varre snapshots dos últimos N dias, junta UUIDs únicos de rejeitadas e
// classifica em massa. Usado pra inicializar a tabela ou recuperar lacunas.

async function runBackfillRejeicoes(daysBack) {
  const { getClient } = require('./dbClient');
  const { fetchRejectionDetails } = require('./rejectionService');
  const sb = getClient();
  if (!sb) return { error: 'supabase indisponível' };

  const DAYS = Math.min(Math.max(Number(daysBack) || 30, 1), 90);
  const cutoff = new Date(Date.now() - DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10);

  console.log(`[BACKFILL-REJ] varrendo snapshots desde ${cutoff} (${DAYS} dias)...`);

  // Pagina snapshots em ordem ASC (mais antigos primeiro) — pra cada note_id
  // mantém o snapshot mais antigo, que tem os colaboradores corretos da sessão.
  const byNoteId = new Map();
  let page = 0;
  let totalSnaps = 0;
  while (true) {
    const { data, error } = await sb.from('snapshots')
      .select('team_name, regional, sector_id, data, date')
      .gte('date', cutoff)
      .order('captured_at', { ascending: true })
      .range(page * 1000, (page + 1) * 1000 - 1);
    if (error || !data || data.length === 0) break;
    totalSnaps += data.length;
    data.forEach(r => {
      const t = r.data;
      if (!t) return;
      const collabs = (t.collaborators || []).map(c => ({
        code: String(c?.code || c?.Code || c?.matricula || '').trim(),
        name: String(c?.name || c?.Name || '').trim(),
      })).filter(c => c.code);
      const collaborator_codes = collabs.map(c => c.code);
      const collaborator_names = collabs.map(c => c.name);

      (t.notasRejeitadas || []).forEach(n => {
        if (!n.id || byNoteId.has(n.id)) return;
        const tipo = (n.tipoCode || '').toUpperCase();
        if (!tipo) return;
        byNoteId.set(n.id, {
          note_id:      n.id,
          numero:       n.codigo || null,
          tipo,
          team_name:    r.team_name,
          regional:     r.regional,
          sector_id:    r.sector_id,
          session_date: r.date,
          collaborator_codes,
          collaborator_names,
        });
      });
    });
    if (data.length < 1000) break;
    page++;
  }

  const jobs = Array.from(byNoteId.values());
  console.log(`[BACKFILL-REJ] ${totalSnaps} snapshots varridos, ${jobs.length} UUIDs únicos`);
  if (jobs.length === 0) return { totalSnaps, jobs: 0, gravadas: 0 };

  // Filtra os que já estão no banco
  const ids = jobs.map(j => j.note_id);
  const jaCache = new Set();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const { data } = await sb.from('note_rejections')
      .select('note_id').in('note_id', chunk);
    (data || []).forEach(r => jaCache.add(r.note_id));
  }
  const todo = jobs.filter(j => !jaCache.has(j.note_id));
  console.log(`[BACKFILL-REJ] ${todo.length} novas a coletar (${jaCache.size} já cacheadas)`);
  if (todo.length === 0) return { totalSnaps, jobs: jobs.length, gravadas: 0, jaCache: jaCache.size };

  // Coleta detalhes em concorrência 4
  const linhas = [];
  const t0 = Date.now();
  for (let i = 0; i < todo.length; i += 4) {
    const chunk = todo.slice(i, i + 4);
    const results = await Promise.all(chunk.map(async j => {
      try {
        const det = await fetchRejectionDetails(j.note_id, j.tipo);
        return {
          note_id:        j.note_id,
          numero:         j.numero,
          tipo:           j.tipo,
          team_name:      j.team_name,
          regional:       j.regional,
          sector_id:      j.sector_id,
          rejection_date: det?.rejection_date || null,
          session_date:   j.session_date,
          observacao:     det?.observacao || null,
          motivo_codes:   det?.motivo_codes  || [],
          motivo_textos:  det?.motivo_textos || [],
          formulario:     det?.formulario    || null,
          collaborator_codes: j.collaborator_codes,
          collaborator_names: j.collaborator_names,
          raw:            det?.raw || null,
        };
      } catch (err) {
        if (ehFalhaDeCaminho(err)) throw err;   // 24/10/2026: proxy/IP — para o ciclo, 1 log no job
        return null;
      }
    }));
    results.forEach(r => { if (r) linhas.push(r); });
    if (i > 0 && i % 200 === 0) {
      console.log(`[BACKFILL-REJ] progresso: ${i}/${todo.length}`);
    }
  }

  // Grava em chunks de 200 (arrays + JSONB = payload grande)
  let gravadas = 0;
  for (let i = 0; i < linhas.length; i += 200) {
    const chunk = linhas.slice(i, i + 200);
    const { error } = await sb.from('note_rejections').upsert(chunk, { onConflict: 'note_id' });
    if (!error) gravadas += chunk.length;
  }

  const comMotivo = linhas.filter(l => l.motivo_codes.length > 0).length;
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[BACKFILL-REJ] ✓ ${gravadas} gravadas em ${dt}s (${comMotivo} com motivo, ${gravadas - comMotivo} sem)`);
  return { totalSnaps, jobs: jobs.length, gravadas, comMotivo, semMotivo: gravadas - comMotivo };
}

// ── RETRY DE REJEIÇÕES GRAVADAS VAZIAS POR FALHA DE COLETA ─────────────────────
// 14/10/2026 (reporte do José: "notas rejeitadas sem motivo, mas no WPA têm"):
// linhas com raw.no_path_cached / all_failed / unknown_tipo foram gravadas SEM
// motivo por falha de coleta (cache negativo do tipo SF envenenado) e o cron
// normal nunca volta nelas (filtra por presença do note_id). Este job re-coleta
// só essas linhas, as mais recentes primeiro, em lote pequeno (conta WPA
// compartilhada com outro projeto). UPDATE com COALESCE: nunca apaga o que já
// existe. Linha que continua falhando fica como está e é tentada no próximo ciclo.
async function runRetryRejeicoesVazias(limite = 120) {
  if (process.env.DATA_MODE === 'mock') return { alvo: 0 };
  const { _getPool } = require('./pgShim');
  const { fetchRejectionDetails } = require('./rejectionService');
  const pool = _getPool();
  if (!pool) return { alvo: 0 };

  const { rows: alvo } = await pool.query(
    `SELECT note_id::text AS note_id, numero, tipo
       FROM note_rejections
      WHERE coalesce(array_length(motivo_codes, 1), 0) = 0
        AND (raw ? 'no_path_cached' OR raw ? 'all_failed' OR raw ? 'unknown_tipo')
      ORDER BY session_date DESC
      LIMIT $1`, [limite]);
  if (alvo.length === 0) return { alvo: 0 };

  let recuperadas = 0;
  for (let i = 0; i < alvo.length; i += 3) {
    const lote = alvo.slice(i, i + 3);
    await Promise.all(lote.map(async r => {
      try {
        const det = await fetchRejectionDetails(r.note_id, r.tipo);
        // Só grava se a coleta de fato respondeu (traz motivo ou data).
        if (!det || (!det.motivo_codes?.length && !det.rejection_date)) return;
        await pool.query(
          `UPDATE note_rejections
              SET rejection_date = COALESCE($2, rejection_date),
                  motivo_codes   = CASE WHEN cardinality($3::text[]) > 0 THEN $3::text[] ELSE motivo_codes END,
                  motivo_textos  = CASE WHEN cardinality($4::text[]) > 0 THEN $4::text[] ELSE motivo_textos END,
                  observacao     = COALESCE($5, observacao),
                  formulario     = COALESCE($6, formulario),
                  raw            = COALESCE($7::jsonb, raw),
                  fetched_at     = now()
            WHERE note_id = $1::uuid`,
          [r.note_id, det.rejection_date || null,
           det.motivo_codes || [], det.motivo_textos || [],
           det.observacao || null, det.formulario || null,
           det.raw ? JSON.stringify(det.raw) : null]);
        recuperadas++;
      } catch (err) {
        if (ehFalhaDeCaminho(err)) throw err;   // 24/10/2026: proxy/IP — para o ciclo, 1 log no job
        console.warn(`[CRON] retry-rej: ${r.numero || r.note_id} falhou: ${err.message}`);
      }
    }));
  }
  console.log(`[CRON] retry-rej: ${recuperadas}/${alvo.length} linhas vazias recuperadas`);
  return { alvo: alvo.length, recuperadas };
}

// ── RETRY DE DD/OUTROS RECENTES ────────────────────────────────────────────────
// Bug histórico: equipes lançam Activities[] no WPA progressivamente durante o
// dia. O cron `runClassifyNewNotes` vê a nota cedo (sem Activities) e classifica
// como OUTROS. Quando a equipe registra BTZ013/C93 horas depois, o cache em
// note_subcategorias já está como OUTROS e o ID está em getClassifiedIds() →
// nunca mais é re-classificado.
//
// Solução: cron dedicado que pega DDs em OUTROS classificadas nas últimas 24h
// e re-classifica. Se Activities[] foi populada nesse meio-tempo, atualiza pra
// BTZ013/C93. Após 24h, considera-se que a nota é genuinamente OUTROS
// (PODA/MANUT/INSPECAO).
//
// Roda 1x por hora durante expediente (06-20h). Concorrência baixa (4) — cada
// chamada classificarDD faz GET /api/notes/dd (~2 KB) + GET /details/optimized
// (~50-150 KB), então N*2 chamadas por execução.

async function runRetryRecentOutros(daysBack) {
  const { getClient } = require('./dbClient');
  const { upsertSubcategorias } = require('../db/subcategoriasQueries');
  const { classificarBatch } = require('./classifierService');
  const { consolidateDay } = require('./dataWriter');
  const sb = getClient();

  // Janela default = 7 dias. Alguns Activities[] só são populadas pela WPA dias
  // após a conclusão (notas CAPEX/PREV especialmente). 24h era curto demais e
  // deixava C93/BTZ013 presos em OUTROS pra sempre. Após 7 dias considera-se
  // que a nota é genuinamente OUTROS (PODA/MANUT/INSPECAO).
  // Permite override (via rota admin) para reclassificação ampla pontual.
  const DAYS_BACK = Number.isFinite(daysBack) && daysBack > 0 ? daysBack : 7;
  const cutoff = new Date(Date.now() - DAYS_BACK * 24 * 3600 * 1000).toISOString();

  // PAGINADO — sem isso, Supabase corta em 1000 e perde notas mais antigas.
  const data = [];
  let pageR = 0;
  while (true) {
    const { data: chunk, error } = await sb
      .from('note_subcategorias')
      .select('note_id, numero')
      .eq('tipo', 'DD')
      .eq('sub_code', 'OUTROS')
      .gte('classified_at', cutoff)
      .order('classified_at', { ascending: false })
      .range(pageR * 1000, (pageR + 1) * 1000 - 1);
    if (error) {
      console.warn('[CRON] retry-outros: falha ao buscar:', error.message);
      return;
    }
    if (!chunk || chunk.length === 0) break;
    data.push(...chunk);
    if (chunk.length < 1000) break;
    pageR++;
  }

  if (data.length === 0) {
    return;  // nada pra reprocessar (silencioso)
  }

  console.log(`[CRON] retry-outros: ${data.length} DD/OUTROS classificadas nos últimos ${DAYS_BACK} dias — re-classificando`);

  const jobs = data.map(r => ({
    noteId:   r.note_id,
    tipo:     'DD',
    sectorId: 'DESG',  // default — details/optimized aceita qualquer sectorId
    numero:   r.numero || null,
  }));

  const t0 = Date.now();
  const classifs = await classificarBatch(jobs, 4);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  // Só persiste os que efetivamente mudaram de OUTROS pra outra coisa
  const changed = classifs.filter(c => c.sub_code !== 'OUTROS');

  if (changed.length === 0) {
    console.log(`[CRON] retry-outros: ${jobs.length} re-classificadas em ${dt}s, nenhuma mudou de OUTROS`);
    return;
  }

  await upsertSubcategorias(changed);
  const breakdown = {};
  changed.forEach(c => { breakdown[c.sub_code] = (breakdown[c.sub_code] || 0) + 1; });
  const summary = Object.entries(breakdown).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`[CRON] retry-outros: ✓ ${changed.length}/${jobs.length} reclassificadas em ${dt}s — ${summary}`);

  // Re-consolida todos os dias da janela (cobre a janela de DAYS_BACK)
  // pra propagar mudanças pra daily_subcat_totals + team_daily_subcat_totals.
  const todayMs = Date.now() - 3 * 3600 * 1000;
  const datasParaConsolidar = new Set();
  for (let i = 0; i <= DAYS_BACK; i++) {
    datasParaConsolidar.add(new Date(todayMs - i * 24 * 3600 * 1000).toISOString().slice(0, 10));
  }
  for (const d of [...datasParaConsolidar].sort().reverse()) {
    try {
      await consolidateDay(d);
    } catch (errC) {
      console.warn(`[CRON] retry-outros: consolidateDay(${d}) falhou:`, errC.message);
    }
  }
  return { reclassified: changed.length, total: jobs.length, summary, days: datasParaConsolidar.size };
}

// ── REVALIDAÇÃO DE DD (RAMAL BT) ──────────────────────────────────────────────
// Após introdução da regra "Address contém 'RAMAL BT'" para classificar C93,
// notas já cacheadas como C93 podem estar erroneamente infladas (têm Activity
// C93 mas Address sem "Ramal BT" — outras manutenções de ramal).
//
// Esta função re-roda o classificador em TODAS as DD classificadas (qualquer
// sub_code) dos últimos N dias e atualiza o cache. Reconsolida os dias afetados.
async function runRevalidateDD(daysBack, opts = {}) {
  const { getClient }           = require('./dbClient');
  const { upsertSubcategorias } = require('../db/subcategoriasQueries');
  const { classificarBatch }    = require('./classifierService');
  const { consolidateDay }      = require('./dataWriter');
  const sb = getClient();

  // Modo "all=true" ignora janela de tempo e revalida TODAS as DD do banco
  // (útil quando muda regra de negócio e precisa propagar pra notas antigas).
  const ALL = !!opts.all;
  const DAYS_BACK = Number.isFinite(daysBack) && daysBack > 0 ? daysBack : 30;
  const cutoff = new Date(Date.now() - DAYS_BACK * 24 * 3600 * 1000).toISOString();

  // Pega TODAS as DD classificadas (qualquer sub_code) — PAGINADO
  // Sem paginação, Supabase corta em 1000 e deixa de fora notas mais antigas.
  const data = [];
  let page = 0;
  while (true) {
    let q = sb
      .from('note_subcategorias')
      .select('note_id, numero, sub_code, quantidade')
      .eq('tipo', 'DD')
      .order('classified_at', { ascending: false })
      .range(page * 1000, (page + 1) * 1000 - 1);
    if (!ALL) q = q.gte('classified_at', cutoff);
    const { data: chunk, error } = await q;
    if (error) {
      console.warn('[CRON] revalidate-dd: falha ao buscar:', error.message);
      return { error: error.message };
    }
    if (!chunk || chunk.length === 0) break;
    data.push(...chunk);
    if (chunk.length < 1000) break;
    page++;
  }

  if (data.length === 0) {
    return { reclassified: 0, total: 0, summary: 'nada para revalidar' };
  }

  const escopo = ALL ? 'TODAS no banco' : `últimos ${DAYS_BACK} dias`;
  console.log(`[CRON] revalidate-dd: ${data.length} DD classificadas — escopo: ${escopo} — revalidando regra RAMAL BT`);

  const jobs = data.map(r => ({
    noteId:   r.note_id,
    tipo:     'DD',
    sectorId: 'DESG',
    numero:   r.numero || null,
  }));

  const prevByNote = {};
  data.forEach(r => { prevByNote[r.note_id] = r; });

  const t0 = Date.now();
  const classifs = await classificarBatch(jobs, 4);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  // Só persiste os que efetivamente MUDARAM
  const changed = classifs.filter(c => {
    const prev = prevByNote[c.note_id];
    if (!prev) return false;
    return prev.sub_code !== c.sub_code || Number(prev.quantidade ?? -1) !== Number(c.quantidade ?? -1);
  });

  if (changed.length === 0) {
    console.log(`[CRON] revalidate-dd: ${jobs.length} processadas em ${dt}s, nada mudou`);
    return { reclassified: 0, total: jobs.length, summary: 'sem mudanças', days: 0 };
  }

  await upsertSubcategorias(changed);

  // Sumário das mudanças
  const transicoes = {};
  changed.forEach(c => {
    const prev = prevByNote[c.note_id];
    const key = `${prev.sub_code} → ${c.sub_code}`;
    transicoes[key] = (transicoes[key] || 0) + 1;
  });
  const summary = Object.entries(transicoes).map(([k, v]) => `${k}: ${v}`).join(' | ');
  console.log(`[CRON] revalidate-dd: ✓ ${changed.length}/${jobs.length} reclassificadas em ${dt}s — ${summary}`);

  // Re-consolida todos os dias afetados (janela ou 60 dias se ALL=true)
  const todayMs = Date.now() - 3 * 3600 * 1000;
  const diasConsolidar = ALL ? 60 : DAYS_BACK;
  const datasParaConsolidar = new Set();
  for (let i = 0; i <= diasConsolidar; i++) {
    datasParaConsolidar.add(new Date(todayMs - i * 24 * 3600 * 1000).toISOString().slice(0, 10));
  }
  for (const d of [...datasParaConsolidar].sort().reverse()) {
    try {
      await consolidateDay(d);
    } catch (errC) {
      console.warn(`[CRON] revalidate-dd: consolidateDay(${d}) falhou:`, errC.message);
    }
  }
  return { reclassified: changed.length, total: jobs.length, summary, days: datasParaConsolidar.size };
}

// ── HEALTH-CHECK DE UUID ───────────────────────────────────────────────────────
// Verifica % de notas (em notasConcluidas + notasExecutadas) com `id` (UUID)
// nos snapshots da última hora. Loga warn se < 95%.
//
// Histórico: snapshots de 01-26/04/2026 não tinham UUID (scraper antigo).
// Desde 27/04/2026 a cobertura é >98%. Este check detecta regressão precoce —
// se o WPA mudar formato ou nosso scraper falhar, descobrimos em ≤1h em vez
// de só ao montar histórico semanas depois.
//
// Saída no log do PM2:
//   ✓ uuid-health: 1234/1234 (100.0%) MD/SF/DD com UUID — última hora
//   ⚠️  uuid-health: 850/1234 (68.9%) — abaixo de 95%, classificação por
//       subcategoria pode estar comprometida!

async function runUuidHealthCheck() {
  const { getClient } = require('./dbClient');
  const sb = getClient();
  const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();

  const { data: snaps, error } = await sb
    .from('snapshots')
    .select('data')
    .gte('captured_at', oneHourAgo);

  if (error) {
    console.warn('[CRON] uuid-health: falha ao buscar snapshots:', error.message);
    return;
  }
  if (!snaps || snaps.length === 0) {
    // Fora do horário do cron de snapshot (06-20h) é normal
    return;
  }

  let totalNotas    = 0;
  let notasComUuid  = 0;
  const SUBCAT_TIPOS = new Set(['MD', 'SF', 'DD']);

  snaps.forEach(s => {
    const t = s.data;
    if (!t) return;
    const realizadas = [...(t.notasConcluidas || []), ...(t.notasExecutadas || [])];
    realizadas.forEach(n => {
      const tipo = (n.tipoCode || '').toUpperCase();
      if (!SUBCAT_TIPOS.has(tipo)) return;
      totalNotas += 1;
      if (n.id) notasComUuid += 1;
    });
  });

  if (totalNotas === 0) return;

  const pct = (notasComUuid / totalNotas) * 100;
  const base = `uuid-health: ${notasComUuid}/${totalNotas} (${pct.toFixed(1)}%) MD/SF/DD com UUID — última hora (${snaps.length} snapshots)`;

  if (pct < 95) {
    console.warn(`[CRON] ⚠️  ${base} — abaixo de 95%, classificação por subcategoria pode estar comprometida!`);
  } else {
    console.log(`[CRON] ✓ ${base}`);
  }
}

// ── CONSOLIDAÇÃO ──────────────────────────────────────────────────────────────

async function runConsolidate(date) {
  // Sem data explícita usa BRT (America/Sao_Paulo) — evita consolidar "amanhã" depois das 21h UTC
  date = date || dateBRT();
  const { consolidateDay, cleanOldSnapshots, cleanOldNoteDetails } = require('./dataWriter');
  // Etapas independentes: falha na consolidação NÃO pode pular a limpeza.
  // (Bug até jul/2026: tudo num try só — consolidate_failed diario deixou
  // snapshots acumularem ~60 dias/961MB porque cleanOldSnapshots nunca rodava.)
  try {
    await consolidateDay(date);
  } catch (err) {
    log.error('consolidate_failed', { date, msg: err.message });
  }
  try {
    await cleanOldSnapshots();
    await cleanOldNoteDetails();
  } catch (err) {
    log.error('clean_old_failed', { msg: err.message });
  }
}

// ── RECONCILIAÇÃO (drift detection) ───────────────────────────────────────────
//
// Verifica se as tabelas agregadas (team_daily_totals) batem com os snapshots
// para um dia específico. Se detectar drift > limiar, dispara um consolidateDay
// novo para reagrupar a partir da fonte da verdade (snapshots).
//
// Roda 1x/dia às 02:00 BRT, verificando D-1 (ontem) e D-7 (uma semana atrás
// — captura casos onde o cron de 20:30 falhou silenciosamente).

async function runDriftCheck(date) {
  try {
    const { detectDrift, consolidateDay, shouldAutoRepair } = require('./dataWriter');
    date = date || dateBRT();
    const report = await detectDrift(date);
    const decisao = shouldAutoRepair(report);

    if (report.has_drift) {
      log.warn('drift_detected', {
        date: report.date,
        snapshot: report.snapshot_count,
        table:    report.table_count,
        diff:     report.diff,
        threshold: report.threshold,
        acao:     decisao.reason,
      });
    }

    // ⚠️ SÓ REPARA QUANDO FALTA PRODUÇÃO (31/07/2026). Drift negativo — tabela
    // MAIOR que a régua — é acúmulo legítimo de passes posteriores (uma nota de
    // sexta continua no payload de sábado e segunda, e o upsert não wipa o dia
    // antigo). Reparar isso APAGARIA produção real: em 31/07 seriam 84 OS no
    // 24/07, 117 no 17/07, 96 no 10/07. Ver shouldAutoRepair em dataWriter.js.
    if (!decisao.repair) {
      if (report.has_drift) {
        log.warn('drift_nao_reparado', {
          date: report.date,
          diff: report.diff,
          motivo: decisao.reason,
          nota: 'reparo automatico so ADICIONA; drift negativo exige investigacao humana',
        });
        try {
          const sq = require('../db/queries');
          await sq.setSetting('drift_last_skip', {
            date, report, motivo: decisao.reason, at: new Date().toISOString(),
          });
        } catch (_) {}
      } else {
        log.info('drift_ok', {
          date: report.date,
          snapshot: report.snapshot_count,
          table:    report.table_count,
          diff:     report.diff,
        });
      }
      return report;
    }

    {
      // ⚠️ REPARA VIA D+1, não via D (corrigido 25/07/2026).
      // consolidateDay(X) monta equipes com sessão em {X-1, X} mas wipa {X-1, X}
      // — logo quem grava o valor COMPLETO de um dia D é o passe de D+1 (a janela
      // dele pega as sessões da manhã seguinte, que carregam notas concluídas em
      // D por equipe que relogou). Rodar consolidateDay(D) aqui gravava o valor
      // INCOMPLETO e o "reparo" APAGAVA produção legítima: o 07-22 perdeu 172 OS
      // (1161 → 989) num sweep das 02:00, e o 07-13 media 850 pela régua de D
      // contra 903 reais. `report.repair_date` é o D+1. Ver detectDrift e
      // scripts/diag-drift-team.js.
      await consolidateDay(report.repair_date);

      // Re-verifica após reparo
      const after = await detectDrift(date);
      log.info('drift_repaired', {
        date,
        before_diff: report.diff,
        after_diff:  after.diff,
        still_drifting: after.has_drift,
      });

      // Registra no app_settings para observabilidade
      try {
        const sq = require('../db/queries');
        await sq.setSetting('drift_last_repair', {
          date,
          before: report,
          after,
          repaired_at: new Date().toISOString(),
        });
      } catch (_) {}
    }
    return report;
  } catch (err) {
    log.error('drift_check_failed', { date, msg: err.message });
    return null;
  }
}

// Wrapper para o cron diário: varre D-7 até D-1 (janela completa da semana).
//
// Antes verificava só D-1 e D-7, deixando D-2..D-6 órfãos: se o
// consolidateDay de um desses dias falhasse ou fosse interrompido no meio
// (crash entre wipe e reagregação), NENHUM job reparava — o dia ficava com
// dados parciais/zerados indefinidamente (risco P0-3 do backlog). Varrer a
// semana inteira é barato (7 detectDrift; só consolida quem tem drift real)
// e fecha esse buraco. Sequencial pra não competir por conexões do pool.
//
// ⚠️ ORDEM CRESCENTE (mais ANTIGO primeiro) — obrigatório desde 25/07/2026.
// O reparo de um dia D roda consolidateDay(D+1), que wipa {D, D+1}: grava D
// completo e D+1 INCOMPLETO (a janela de D+1 não vê as sessões de D+2). Indo do
// mais antigo pro mais novo, a iteração seguinte sempre conserta o colateral da
// anterior; o único dia que sobra incompleto é HOJE, coberto pela consolidação
// das 20:30, pelo cron intraday e pelo sweep de amanhã (como D-1). Na ordem
// inversa (como era antes) o reparo do dia mais antigo estragava o dia seguinte
// já corrigido, e o sweep nunca convergia.
async function runDailyDriftSweep() {
  const today = dateBRT();
  const base = new Date(today + 'T12:00:00Z');
  for (let d = 7; d >= 1; d--) {
    const dia = new Date(base);
    dia.setUTCDate(dia.getUTCDate() - d);
    await runDriftCheck(dia.toISOString().slice(0, 10));
  }
}

// ── COLETA EM JANELAS FIXAS (28/10/2026, P0-12) ──────────────────────────────
// Decisão do José em 28/10/2026, depois de a EDP questionar o volume (P0-11):
// "em horários específicos do dia iremos fazer as consultas que irão atualizar
// nosso sistema". A EDP só é chamada nas janelas abaixo, no fechamento das 05h
// e no botão "Atualizar agora" do admin. O painel só lê o banco.
const JANELAS_COLETA_H = [8, 12, 17];
const FECHAMENTO_H     = 5;
const ATUALIZACAO_MANUAL_MS = 30 * 60_000;   // botão do admin: 1 a cada 30 min
let _ultimaAtualizacaoManual = 0;            // em memória: instances=1 (regra 8)

/** Próxima janela (ms) depois de `agora`, em BRT. */
function proximaJanela(agora = Date.now()) {
  const { instanteBRT } = require('./timeUtil');
  const hoje = dateBRT(agora);
  for (const h of JANELAS_COLETA_H) {
    const t = instanteBRT(hoje, h * 60);
    if (t > agora) return t;
  }
  const amanha = new Date(hoje + 'T12:00:00Z');
  amanha.setUTCDate(amanha.getUTCDate() + 1);
  return instanteBRT(amanha.toISOString().slice(0, 10), JANELAS_COLETA_H[0] * 60);
}

/**
 * Botão do admin. Devolve { ok: true } e marca o uso, ou { ok: false, liberaEm }
 * se a última foi há menos de 30 min. Puro com `estado` injetado (teste).
 */
function reservarAtualizacaoManual(agora = Date.now(), estado = null) {
  const ultima = estado ? estado.ultima : _ultimaAtualizacaoManual;
  if (ultima && agora - ultima < ATUALIZACAO_MANUAL_MS) {
    return { ok: false, liberaEm: ultima + ATUALIZACAO_MANUAL_MS };
  }
  if (estado) estado.ultima = agora; else _ultimaAtualizacaoManual = agora;
  return { ok: true };
}

/**
 * Uma janela: o snapshot completo (com as caudas: classificação, detalhes,
 * rejeições, interrupções, escala) e, em série, o que antes rodava de hora em
 * hora ou a cada 30 min. Cada etapa falha sozinha.
 */
async function runJanela() {
  await runSnapshot();
  const etapas = [
    ['escala-dia', () => runSyncEscalaDia()],
    ['notas-devolvidas', () => runNotasCollect()],
    ['retry-rejeicoes', () => runRetryRejeicoesVazias()],
    ['retry-outros', () => runRetryRecentOutros()],
    ['uuid-health', () => runUuidHealthCheck()],
  ];
  for (const [nome, fn] of etapas) {
    try { await fn(); }
    catch (err) {
      if (ehWpaAccessError(err)) { log.error('rotina_sem_acesso_edp', { rotina: nome, code: err.code, msg: err.message }); break; }
      log.error('janela_etapa_falhou', { etapa: nome, msg: err.message });
    }
  }
}

/**
 * O dia `date` inteiro, já fechado, pelo caminho do backfill (getTeamsByDate):
 * grava os snapshots, os totais, classifica e consolida. Era o corpo de
 * POST /admin/backfill; virou função para o fechamento das 05h usar também.
 * Setor com falha → nada gravado e lança com o code (spec R3.2/R3.4).
 */
async function runBackfillDia(date) {
  const { getTeamsByDate } = require('./wpaService');
  const { saveSnapshot, upsertDailyTotals, upsertTeamDailyTotals } = require('./dataWriter');
  const SETORES = ['DESG', 'DEPT', 'DESC', 'DSSJ'];   // SJC adicionado 08/06/2026
  console.log(`[BACKFILL] Iniciando para ${date}...`);

  // 24/10/2026 (spec R3.2/R3.4): setor que falhava virava [] e a data era
  // gravada e consolidada SEM ele — subcontagem silenciosa. Agora, com qualquer
  // setor falhando, nada é gravado para a data e a resposta diz o code.
  const falhas = [];
  const resultados = await Promise.all(
    SETORES.map(s => getTeamsByDate(s, date).catch(err => {
      console.warn(`[BACKFILL] Setor ${s} falhou: ${err.message}`);
      falhas.push({ sector: s, code: err.code || null, msg: err.message, caminho: ehFalhaDeCaminho(err) });
      return [];
    }))
  );
  if (falhas.length > 0) {
    const err = new Error(`backfill de ${date} NÃO gravado: ${falhas.map(f => `${f.sector} ${f.code || f.msg}`).join(', ')}`);
    err.code = falhas[0].code;
    err.falhas = falhas;
    throw err;
  }
  const teams = resultados.flat();
  if (teams.length === 0) return { ok: false, date, teams: 0 };

  await saveSnapshot(teams, date);
  await upsertDailyTotals(teams, date);
  await upsertTeamDailyTotals(teams, date);

  // Classifica subcategorias (incluindo Amount de C93/BTZ013) ANTES de consolidar,
  // para que upsertSubcatTotals dentro de runConsolidate encontre os dados corretos.
  console.log(`[BACKFILL] Classificando subcategorias para ${date}...`);
  await runClassifyNewNotes([...teams]).catch(err =>
    console.warn(`[BACKFILL] runClassifyNewNotes falhou (não crítico): ${err.message}`)
  );

  // Consolida ao final para garantir apenas concluídas nos totais históricos
  await runConsolidate(date);

  console.log(`[BACKFILL] Concluído: ${teams.length} equipes para ${date}`);
  return {
    ok: true, date, teams: teams.length,
    concluidas: teams.reduce((s, t) => s + (t.notasConcluidas || []).length, 0),
    executadas: teams.reduce((s, t) => s + (t.notasExecutadas || []).length, 0),
  };
}

/**
 * Fechamento das 05h: o D-1 pelo backfill (vê as notas que chegam horas depois
 * do logoff — 40,6% das sessões, diag do P0-11), depois logoffs de D-1/D-2,
 * intervalos e saída da nota (que lê os dois anteriores). Era 03:00/03:10/04:30.
 */
async function runFechamento() {
  const ontem = dateBRTMinusDays(1);
  try {
    const r = await runBackfillDia(ontem);
    log.info('fechamento_backfill', r);
  } catch (err) {
    log.error('fechamento_backfill_falhou', { date: ontem, code: err.code || null, msg: err.message });
    if ((err.falhas || []).some(f => f.caminho)) return;   // sem caminho até a EDP, o resto também falharia
  }
  await runSyncLogoffs().catch(err => log.error('fechamento_logoffs_falhou', { msg: err.message }));
  await runSyncIntervalos().catch(err => log.error('fechamento_intervalos_falhou', { msg: err.message }));
  await runSaidaNota();
}

// ── START / STOP ──────────────────────────────────────────────────────────────

// 19/10/2026 (P0-11): cada job roda marcado como `cron:<nome>`, para o contador
// de requisições à EDP separar o que é cron do que é painel. As caudas sem await
// (ex.: as do snapshot) herdam a marca de quem as disparou. Os argumentos que o
// node-cron passa seguem intactos para a função do job.
function _agendar(nome, expr, fn, opts) {
  const { comOrigem } = require('./wpaContador');
  // 24/10/2026 (R3.1): a rotina que parou por falha de acesso à EDP deixa UMA
  // linha com o nome e o code, e o processo segue para o próximo ciclo. Antes, a
  // rejeição ia pro 'task-failed' do node-cron, que ninguém escuta: sem log.
  const comLog = (...args) => Promise.resolve()
    .then(() => fn(...args))
    .catch((err) => {
      if (!ehWpaAccessError(err)) throw err;
      log.error('rotina_sem_acesso_edp', { rotina: nome, code: err.code, msg: err.message });
    });
  return cron.schedule(expr, (...args) => comOrigem(`cron:${nome}`, () => comLog(...args)), opts);
}

function startCron() {
  if (process.env.DATA_MODE !== 'wpa') {
    console.log('[CRON] Modo mock — cron desativado.');
    return;
  }
  if (!global._extraCronJobs) global._extraCronJobs = [];
  const BRT = { timezone: 'America/Sao_Paulo' };

  // 28/10/2026 (P0-12): a EDP só é chamada aqui, nas janelas e no fechamento.
  // Agenda anterior e o porquê de cada job, preservados como registro (regra 3):
  //   - token '*/45 * * * *' 24/7. "ATENÇÃO: no campo de minutos isso dispara às
  //     :00 e :45 (intervalos alternados de 45 e 15 min), não 'a cada 45 min' —
  //     ver P2-29. Desde 22/08/2026 o disparo é barato: só faz /signin dentro da
  //     margem do exp." Saiu: o token é pedido sob demanda (getToken) na janela.
  //   - snapshot '*/15 5-23' — "Janela expandida pra cobrir logon antecipado de
  //     equipes 06h e logoff de plantão noturno até 23:30. Antes era 06-20h,
  //     perdíamos logoffs após 20h." E snapshot de madrugada '30 0,2,4' para
  //     logoffs tardios. Os dois saíram: o logoff vem do fechamento das 05h
  //     (Sessions/all/date de D-1 e D-2, P1-47).
  //   - escala-dia '20 5-22' e '50 5-21' — "18/10/2026 (P2-65): a cada 30 min até
  //     22:20 — convocação de folga é lançada pela EDP ao longo do dia." Agora
  //     roda em cada janela.
  //   - sync-logoffs 03:00, intervalos 03:10, saída da nota 04:30 → fechamento 05h.
  //   - uuid-health '5 6-20', retry-outros '25 6-20', retry-rejeicoes '40 6-20'
  //     ("Retry das rejeições gravadas vazias por falha de coleta (14/10/2026)"),
  //     notas-devolvidas '5 * * * *' → em cada janela, depois do snapshot.
  //   - No boot: warm do token e snapshot imediato se 6–20h. "P1-29 (20/08/2026):
  //     o boot chamava runTokenRefresh, que usa forceRefresh ... um /signin fresco
  //     obrigatório a cada reinício. Com autorestart + crash-loop (161 restarts
  //     num dia) isso queimava o orçamento de 5 tentativas da EDP em segundos."
  //     Saíram os dois: religar o processo não chama a EDP.
  snapshotJob = _agendar('janela', `0 ${JANELAS_COLETA_H.join(',')} * * *`, () => runJanela(), BRT);
  const fechamentoJob = _agendar('fechamento', `0 ${FECHAMENTO_H} * * *`, () => runFechamento(), BRT);
  global._extraCronJobs.push(fechamentoJob);

  // Só banco, sem EDP — ficam como estavam.
  // Consolidação diária às 23:50 (logo após o último snapshot do dia)
  // 28/10/2026: era `runConsolidate` direto, e o node-cron chama o job com a
  // data/hora do disparo (Date) como 1º argumento. runConsolidate(date) usava
  // esse Date como dia: `consolidate_failed ... "Invalid time value"` TODA noite
  // no err.log, de 22/08 (início do log) a 25/10/2026 — 65 noites. O dia só era
  // consolidado se o drift-sweep das 02:00 visse drift acima do limiar.
  consolidaJob = _agendar('consolidacao', '50 23 * * *', () => runConsolidate(), BRT);
  // Drift sweep noturno às 02:00 — verifica D-1 e D-7, repara se necessário
  driftJob = _agendar('drift-sweep', '0 2 * * *', () => runDailyDriftSweep(), BRT);

  console.log(`[CRON] Jobs iniciados — coleta da EDP às ${JANELAS_COLETA_H.map(h => h + 'h').join(', ')} ` +
    `e fechamento do D-1 às ${FECHAMENTO_H}h (P0-12); consolidação 23:50, drift-sweep 02:00. Boot não coleta.`);
}

function stopCron() {
  tokenJob?.stop();
  snapshotJob?.stop();
  consolidaJob?.stop();
  uuidHealthJob?.stop();
  retryOutrosJob?.stop();
  retryRejJob?.stop();
  driftJob?.stop();
  notasJob?.stop();
  // Para jobs extras (snapshot de madrugada)
  if (global._extraCronJobs) {
    global._extraCronJobs.forEach(j => j?.stop?.());
    global._extraCronJobs = [];
  }
}

// ── SYNC DE LOGOFFS NOTURNOS ─────────────────────────────────────────────────
// Quando a equipe desloga, ela sai do payload de /api/sessions/current. Nosso
// cron de snapshot só vê sessões ABERTAS, então nunca captura o sessionEnd.
// Esta função chama /api/Sessions/all/date que retorna TODAS as sessões do dia
// (incluindo fechadas com EndTime preenchido) e atualiza o último snapshot
// de cada equipe no Supabase com o sessionEnd correto.
//
// Roda 1x por dia às 03:00 BRT (depois que o expediente acabou pra todas as
// equipes — inclusive plantão noturno).

async function runSyncLogoffs(targetDate) {
  if (process.env.DATA_MODE === 'mock') return;

  const { getSessionsByDate, isSectorDisabled } = require('./wpaService');
  const { _getPool } = require('./pgShim');
  const { sincronizarDia, diaMenos } = require('../db/logoffSync');
  const { dateBRT } = require('./timeUtil');

  const pool = _getPool();
  if (!pool) return;

  const ENGELMIG_COMPANY_ID = process.env.WPA_COMPANY_ID
    || '92a2f98e-8877-433e-8358-173b94c13a54';

  // ⚠️ D-1 **E** D-2 — conserto do P1-47 (09/09/2026).
  //
  // Este job rodava só pra D-1, às 03:00, e filtrava apenas sessão que JÁ
  // tinha `EndTime`. Turno que entra 20:00 e sai 05:00 ainda está ABERTO às
  // 03:00: o job o via sem fim, pulava, e NUNCA voltava àquela data. Resultado
  // medido em 16-31/08: 113 sessões sem logoff, todas com o fim disponível na
  // EDP — a prorrogação de todo turno noturno se perdia, e é o turno em que
  // hora extra mais acontece.
  //
  // Com D-2 o turno ganha ~24h pra fechar antes de a gente perguntar, e o
  // horário do cron deixa de importar. Reprocessar é seguro: `sessoesSemFim`
  // só devolve o que está sem fim, e `gravarFim` nunca sobrescreve.
  const hoje = targetDate ? null : dateBRT();
  const dias = targetDate ? [targetDate] : [diaMenos(hoje, 1), diaMenos(hoje, 2)];

  let totalUpdated = 0;
  const porDia = [];
  for (const dia of dias) {
    try {
      const r = await sincronizarDia(pool, getSessionsByDate, dia, {
        companyId: ENGELMIG_COMPANY_ID,
        setorDesabilitado: isSectorDisabled,   // P1-21: conta desativada não é erro
        log: msg => console.log(`[CRON] ${msg}`),
      });
      totalUpdated += r.gravadas;
      porDia.push(r);
    } catch (err) {
      console.warn(`[CRON] sync-logoffs: ${dia} falhou: ${err.message}`);
      porDia.push({ dia, abertas: 0, gravadas: 0, semPar: 0, falhas: [{ erro: err.message }] });
    }
  }

  const semPar = porDia.reduce((s, r) => s + (r.semPar || 0), 0);
  console.log(`[CRON] sync-logoffs: ✓ ${totalUpdated} sessão(ões) com sessionEnd `
    + `recuperado em ${dias.length} dia(s)`
    + (semPar ? ` · ${semPar} sem par na EDP` : ''));
  // `date` mantido no retorno pra não quebrar chamador antigo (scripts que
  // passam targetDate e leem res.date/res.updated).
  return { date: dias[0], dias, updated: totalUpdated, semPar, porDia };
}

// ── SAÍDA DA NOTA (P2-70, 19/10/2026) ─────────────────────────────────────────
// Avalia D-1 às 04:30: depois do sync-logoffs (03:00), dos intervalos (03:10) e
// do drift-sweep (02:00). Não chama a EDP — lê o banco e a trilha do gseq.
// Spec: docs/handoff/SPEC-saida-da-nota-2026-10-18.md §6.
async function runSaidaNota(date) {
  if (process.env.DATA_MODE === 'mock') return;
  const { getGseqPool } = require('./gseqPool');
  const { runSaidaNota: avaliarEGravar } = require('./saidaNotaJob');
  const { _getPool } = require('./pgShim');
  const { getSetting } = require('../db/queries');
  try {
    return await avaliarEGravar({
      data: date || dateBRTMinusDays(1), pool: _getPool(), poolGseq: getGseqPool(), getSetting,
    });
  } catch (err) {
    log.warn('saida_nota_falhou', { msg: err.message });
  }
}

module.exports = {
  startCron, stopCron,
  runSnapshot, runConsolidate, runTokenRefresh,
  // P0-12: coleta em janelas fixas + fechamento + botão do admin.
  runJanela, runFechamento, runBackfillDia, proximaJanela, reservarAtualizacaoManual,
  JANELAS_COLETA_H, FECHAMENTO_H, ATUALIZACAO_MANUAL_MS,
  runClassifyNewNotes, runCacheNotaDetails,
  runDriftCheck, runDailyDriftSweep,
  runRetryRecentOutros, runRevalidateDD,
  runSyncLogoffs,
  runClassifyRejections, runBackfillRejeicoes, runRetryRejeicoesVazias,
  runSyncEscalas,
  runSyncEscalaCatalogo,
  runSyncEscalaDia,
  runSyncIntervalos,
  runAlertaProdutividade,
  // Exportado pra teste — desfecho do ciclo de snapshot (resiliência por setor).
  _classifySnapshotOutcome,
  _semSessaoDiaAnterior,   // P2-68
  // Exportado pra teste (P1-39) — merge do carimbo por setor.
  _mergeSectorLastOk,
};
