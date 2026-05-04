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
const { getTeams }            = require('./dataService');
const { forceRefresh }        = require('./wpaService');
const { dateBRT, hourBRT }    = require('./timeUtil');

let tokenJob        = null;
let snapshotJob     = null;
let consolidaJob    = null;
let uuidHealthJob   = null;
let isRunning       = false;
let isRunningAt     = 0;          // timestamp de quando isRunning foi ligado
const MAX_RUN_MS    = 5 * 60_000; // 5 minutos — destrava automaticamente se travar

// ── HELPERS DE OBSERVABILIDADE ────────────────────────────────────────────────
// Registra/limpa erros do subcat aggregation em app_settings (key: subcat_error).
// Permite que /admin/health ou logs externos detectem falhas persistentes.

async function _recordSubcatError(err) {
  try {
    const sq = require('../db/supabaseQueries');
    await sq.setSetting('subcat_error', {
      message: err && err.message ? err.message : String(err),
      ts:      new Date().toISOString(),
    });
  } catch (_) { /* setting opcional — não amplifica falha */ }
}

async function _clearSubcatError() {
  try {
    const sq = require('../db/supabaseQueries');
    // Marca como resolvido (não deleta, mantém histórico do último sucesso)
    await sq.setSetting('subcat_error', { message: null, ts: new Date().toISOString() });
  } catch (_) {}
}

// ── RENOVAÇÃO DE TOKEN ────────────────────────────────────────────────────────

async function runTokenRefresh() {
  try {
    const result = await forceRefresh();
    const exp = result?.token
      ? new Date(JSON.parse(Buffer.from(result.token.split('.')[1], 'base64').toString()).exp * 1000).toISOString()
      : '?';
    console.log(`[CRON] Token WPA renovado — expira em ${exp}`);
  } catch (err) {
    console.error('[CRON] Falha ao renovar token WPA:', err.message);
  }
}

// ── SNAPSHOT ──────────────────────────────────────────────────────────────────

async function runSnapshot() {
  // Verifica se uma execução anterior travou (não liberou isRunning em 5 min)
  if (isRunning) {
    const elapsed = Date.now() - isRunningAt;
    if (elapsed < MAX_RUN_MS) {
      console.log(`[CRON] Snapshot ignorado — já está em execução há ${Math.round(elapsed / 1000)}s`);
      return;
    }
    console.warn(`[CRON] Snapshot: isRunning travado por ${Math.round(elapsed / 1000)}s — forçando desbloqueio`);
  }
  isRunning   = true;
  isRunningAt = Date.now();
  try {
    const allTeams = await getTeams();

    // Separa equipes reais (vindas do WPA) das equipes-fantasma (_ghostFromAcc).
    // Ghosts existem para manter KPIs no frontend e nos totais quando uma equipe
    // desloga — mas NÃO devem ir para snapshots/teams_current: entrariam no
    // aliveNames do pushTeams e impediriam a deleção de sessões encerradas.
    const teams     = allTeams.filter(t => !t._ghostFromAcc);
    const ghostCount = allTeams.length - teams.length;
    if (ghostCount > 0) {
      console.log(`[CRON] _acc: ${ghostCount} equipe(s) fantasma — excluída(s) de snapshots/teams_current, incluídas nos totais diários`);
    }

    if (teams.length === 0) {
      console.log('[CRON] Snapshot: nenhuma equipe ativa no WPA.');
      return; // finally abaixo libera isRunning corretamente
    }

    const ts = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const { saveSnapshot, pushTeams, upsertDailyTotals, upsertTeamDailyTotals, upsertSubcatTotals } = require('./supabasePush');

    // snapshots e teams_current: apenas equipes reais (sem ghosts)
    await saveSnapshot(teams);
    await pushTeams(teams);

    // Totais diários: todas as equipes (real + ghost do _acc) — preserva notas
    // acumuladas de equipes que deslogaram durante o dia. Ghost teams têm regional
    // e notas corretas; _belongsToDate filtra qualquer nota de dia anterior.
    await upsertDailyTotals(allTeams);
    await upsertTeamDailyTotals(allTeams);

    console.log(`[CRON] Snapshot salvo — ${teams.length} equipes reais, ${ghostCount} acumuladas nos totais às ${ts}`);

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
      .catch(err =>
        console.error('[CRON] Erro classificando subcategorias:', err.message)
      );

    // Faz cache do payload completo das OS finalizadas (não bloqueia o snapshot).
    // Roda no servidor Engelmig (com IP autorizado pela WPA) e popula
    // `note_details` no Supabase, que é lido instantaneamente pela rota
    // /api/wpa/nota — inclusive na Vercel, que não consegue falar com a WPA.
    runCacheNotaDetails(teams).catch(err =>
      console.error('[CRON] Erro cacheando detalhes de OS:', err.message)
    );
  } catch (err) {
    console.error('[CRON] Erro no snapshot:', err.message);
  } finally {
    isRunning = false;
  }
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
  const sq = require('../db/supabaseQueries');
  const idsFaltando = await sq.filtrarNotesNaoCacheadas(candidatos.map(c => c.id));
  if (idsFaltando.length === 0) {
    console.log(`[CRON] Cache OS: nada novo (${candidatos.length} UUIDs, todos cacheados)`);
    return;
  }

  // 3) Pega N por ciclo p/ não bloquear
  const idSet = new Set(idsFaltando);
  const lote  = candidatos.filter(c => idSet.has(c.id)).slice(0, MAX_CACHE_POR_CICLO);
  console.log(`[CRON] Cache OS: ${idsFaltando.length} pendentes — processando ${lote.length}`);

  // 4) Busca + processa + grava (concorrência 4 — evita saturar /details/optimized)
  const { getNoteDetail } = require('./wpaService');
  const { processarNota, classificarSubCategoria } = require('./notaProcessor');
  const { getSubcategoriasByIds } = require('../db/subcategoriasQueries');

  const t0 = Date.now();
  let ok = 0, falha = 0;

  for (let i = 0; i < lote.length; i += 4) {
    const chunk = lote.slice(i, i + 4);
    const results = await Promise.all(chunk.map(async c => {
      try {
        const raw = await getNoteDetail(c.id, c.sectorId);
        if (!raw) return { ok: false, id: c.id, reason: 'WPA payload vazio' };

        // Resolve subcategoria
        let subcat = { subCategoria: null, subcatCode: null, quantidade: null };
        try {
          const cls = await getSubcategoriasByIds([raw.Id]);
          const ce = cls[raw.Id];
          if (ce) subcat = { subCategoria: ce.sub_categoria, subcatCode: ce.sub_code, quantidade: ce.quantidade };
        } catch {}
        if (!subcat.subCategoria) {
          // GroupDescription pode vir em raw.GroupDescription ou raw.Group?.Description
          // dependendo do endpoint. Passamos para alinhar com classifierService DD fallback.
          const groupDesc = raw.GroupDescription || raw.Group?.Description || '';
          const fb = classificarSubCategoria(raw.Type, raw.Code, raw.Comments, raw.Activities, groupDesc);
          subcat = { subCategoria: fb.subCategoria, subcatCode: fb.subcatCode, quantidade: fb.quantidade };
        }

        const processed = processarNota(raw, { incluirFotos: false, subcat });
        await sq.setNoteDetailCache(raw.Id, raw.Number, raw.Type, c.sectorId, processed);
        return { ok: true, id: c.id };
      } catch (err) {
        return { ok: false, id: c.id, reason: err.message };
      }
    }));
    ok    += results.filter(r => r.ok).length;
    falha += results.filter(r => !r.ok).length;
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[CRON] Cache OS: gravadas ${ok}/${lote.length} (falhas ${falha}) em ${dt}s`);
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
  const { getClient } = require('./supabaseClient');
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
  try {
    const { consolidateDay, cleanOldSnapshots, cleanOldNoteDetails } = require('./supabasePush');
    await consolidateDay(date);
    // Limpa registros antigos (uma vez por dia, após a consolidação)
    await cleanOldSnapshots();
    await cleanOldNoteDetails();
  } catch (err) {
    console.error('[CRON] Erro na consolidação:', err.message);
  }
}

// ── START / STOP ──────────────────────────────────────────────────────────────

function startCron() {
  if (process.env.DATA_MODE !== 'wpa') {
    console.log('[CRON] Modo mock — cron desativado.');
    return;
  }

  // Renovação de token a cada 45 min, 24/7 (garante sessão ativa mesmo fora do horário de snapshot)
  tokenJob = cron.schedule('*/45 * * * *', runTokenRefresh, {
    timezone: 'America/Sao_Paulo',
  });

  // Snapshot a cada 15 min entre 06:00 e 20:00
  snapshotJob = cron.schedule('*/15 6-20 * * *', runSnapshot, {
    timezone: 'America/Sao_Paulo',
  });

  // Consolidação diária às 20:30
  consolidaJob = cron.schedule('30 20 * * *', runConsolidate, {
    timezone: 'America/Sao_Paulo',
  });

  // Health-check de UUID 1x por hora durante o expediente (06-20h)
  // Detecção precoce de regressão no scraper que possa invalidar a classificação
  uuidHealthJob = cron.schedule('5 6-20 * * *', runUuidHealthCheck, {
    timezone: 'America/Sao_Paulo',
  });

  console.log('[CRON] Jobs iniciados — token 45 min (24/7), snapshot 15 min (06–20h), uuid-health 1x/h (06–20h), consolidação 20:30');

  // Login imediato ao iniciar para garantir token válido desde o primeiro ciclo
  setTimeout(runTokenRefresh, 2000);

  // Snapshot imediato ao iniciar (se dentro do horário — usa hora BRT, não UTC)
  const horaBRT = hourBRT();
  if (horaBRT >= 6 && horaBRT <= 20) {
    setTimeout(runSnapshot, 5000);
  }
}

function stopCron() {
  tokenJob?.stop();
  snapshotJob?.stop();
  consolidaJob?.stop();
  uuidHealthJob?.stop();
}

module.exports = { startCron, stopCron, runSnapshot, runConsolidate, runTokenRefresh, runClassifyNewNotes, runCacheNotaDetails };
