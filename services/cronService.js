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
const { collectSnapshot: collectNotas } = require('./notasMonitor');
const { forceRefresh }        = require('./wpaService');
const { dateBRT, hourBRT }    = require('./timeUtil');
const log                     = require('./logger').forModule('cron');

let tokenJob        = null;
let snapshotJob     = null;
let consolidaJob    = null;
let uuidHealthJob   = null;
let retryOutrosJob  = null;
let driftJob        = null;
let notasJob        = null;
let isRunning       = false;
let isRunningAt     = 0;          // timestamp de quando isRunning foi ligado
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

// ── RENOVAÇÃO DE TOKEN ────────────────────────────────────────────────────────

async function runTokenRefresh() {
  try {
    const result = await forceRefresh();
    const exp = result?.token
      ? new Date(JSON.parse(Buffer.from(result.token.split('.')[1], 'base64').toString()).exp * 1000).toISOString()
      : null;
    log.info('token_refreshed', { exp });
  } catch (err) {
    log.error('token_refresh_failed', { msg: err.message });
  }
}

// ── NOTAS DEVOLVIDAS (monitor de tratamento backoffice) ─────────────────────

async function runNotasCollect() {
  try {
    const r = await collectNotas();
    log.info('notas_collect_ok', r);
  } catch (err) {
    log.error('notas_collect_failed', { msg: err.message });
  }
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
  try {
    const allTeams = await getTeams();

    // Separa equipes reais (vindas do WPA) das equipes-fantasma (_ghostFromAcc).
    // Ghosts existem para manter KPIs no frontend e nos totais quando uma equipe
    // desloga — mas NÃO devem ir para snapshots/teams_current: entrariam no
    // aliveNames do pushTeams e impediriam a deleção de sessões encerradas.
    const teams     = allTeams.filter(t => !t._ghostFromAcc);
    const ghostCount = allTeams.length - teams.length;
    if (ghostCount > 0) {
      log.info('ghost_teams', { count: ghostCount });
    }

    if (teams.length === 0) {
      log.info('snapshot_skipped_empty', {});
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

    log.info('snapshot_saved', { teams: teams.length, ghosts: ghostCount, at: ts });

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

    // Sincroniza escala (ShiftType do WPA) → equipes_oficiais.escala_inicio.
    // Não bloqueia o snapshot. Só grava quando o valor muda (idempotente).
    runSyncEscalas(teams).catch(err =>
      log.error('sync_escalas_failed', { msg: err.message })
    );
  } catch (err) {
    log.error('snapshot_failed', { msg: err.message });
  } finally {
    isRunning = false;
  }
}

// ── SYNC DE ESCALAS (ShiftType do WPA → equipes_oficiais) ──────────────────────
// A EDP expõe o turno real de cada equipe no campo ShiftType do /teamsstatus/V2
// (ex: "T15 15:00"). wpaService já extrai isso pra t.escalaInicioWPA ("HH:MM").
// Aqui comparamos com a escala_inicio salva e atualizamos quando diverge —
// elimina manutenção manual e mantém o indicador de atraso de logon correto.
//
// Só mexe em escala_inicio (o WPA não informa o fim do turno). escala_fim
// continua editável manualmente via Admin.
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
          const fb = classificarSubCategoria(raw.Type, raw.Code, raw.Comments, raw.Activities, groupDesc, raw.Address);
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
      } catch { return null; }
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
    const { detectDrift, consolidateDay } = require('./dataWriter');
    date = date || dateBRT();
    const report = await detectDrift(date);

    if (report.has_drift) {
      log.warn('drift_detected', {
        date: report.date,
        snapshot: report.snapshot_count,
        table:    report.table_count,
        diff:     report.diff,
        threshold: report.threshold,
      });
      await consolidateDay(date);

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
    } else {
      log.info('drift_ok', {
        date: report.date,
        snapshot: report.snapshot_count,
        table:    report.table_count,
        diff:     report.diff,
      });
    }
    return report;
  } catch (err) {
    log.error('drift_check_failed', { date, msg: err.message });
    return null;
  }
}

// Wrapper para o cron diário: verifica D-1 e D-7
async function runDailyDriftSweep() {
  const today = dateBRT();
  // D-1 (ontem)
  const d1 = new Date(today + 'T12:00:00Z');
  d1.setUTCDate(d1.getUTCDate() - 1);
  await runDriftCheck(d1.toISOString().slice(0, 10));
  // D-7 (uma semana atrás)
  const d7 = new Date(today + 'T12:00:00Z');
  d7.setUTCDate(d7.getUTCDate() - 7);
  await runDriftCheck(d7.toISOString().slice(0, 10));
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

  // Snapshot a cada 15 min entre 05:30 e 23:45.
  // Janela expandida pra cobrir:
  //   - logon antecipado de equipes 06h (com tolerância de 30min)
  //   - logoff de plantão noturno até 23:30
  // Antes era 06-20h, perdíamos logoffs após 20h — equipes ficavam pra sempre
  // "em campo" no histórico mesmo tendo deslogado.
  snapshotJob = cron.schedule('*/15 5-23 * * *', runSnapshot, {
    timezone: 'America/Sao_Paulo',
  });

  // Snapshot extra de madrugada (00:30, 02:00, 04:00) pra capturar logoffs
  // tardios de equipes que viraram a noite. Sem isso o sessionEnd só
  // entra no banco no primeiro snap do dia seguinte (= consolidação atrasada).
  const madrugadaJob = cron.schedule('30 0,2,4 * * *', runSnapshot, {
    timezone: 'America/Sao_Paulo',
  });
  // Guarda referência pra stopCron poder limpar
  if (!global._extraCronJobs) global._extraCronJobs = [];
  global._extraCronJobs.push(madrugadaJob);

  // Sync de logoffs do dia anterior — roda às 03:00 BRT.
  // Usa /api/Sessions/all/date pra pegar sessões finalizadas (que somem do
  // /sessions/current após logoff) e atualiza sessionEnd nos snapshots.
  const syncLogoffsJob = cron.schedule('0 3 * * *', () => runSyncLogoffs(), {
    timezone: 'America/Sao_Paulo',
  });
  global._extraCronJobs.push(syncLogoffsJob);

  // Consolidação diária às 23:50 (logo após o último snapshot do dia)
  consolidaJob = cron.schedule('50 23 * * *', runConsolidate, {
    timezone: 'America/Sao_Paulo',
  });

  // Health-check de UUID 1x por hora durante o expediente (06-20h)
  // Detecção precoce de regressão no scraper que possa invalidar a classificação
  uuidHealthJob = cron.schedule('5 6-20 * * *', runUuidHealthCheck, {
    timezone: 'America/Sao_Paulo',
  });

  // Retry de DD/OUTROS recentes (até 24h) — reclassifica caso Activities[]
  // tenha sido populada após classificação inicial. Roda no minuto 25 pra
  // não bater com snapshots (00,15,30,45) nem uuid-health (05).
  retryOutrosJob = cron.schedule('25 6-20 * * *', runRetryRecentOutros, {
    timezone: 'America/Sao_Paulo',
  });

  // Drift sweep noturno às 02:00 — verifica D-1 e D-7, repara se necessário
  driftJob = cron.schedule('0 2 * * *', runDailyDriftSweep, {
    timezone: 'America/Sao_Paulo',
  });

  // Notas devolvidas: a cada hora no minuto 5 (offset para não colidir com outros jobs)
  notasJob = cron.schedule('5 * * * *', runNotasCollect, {
    timezone: 'America/Sao_Paulo',
  });

  console.log('[CRON] Jobs iniciados — token 45 min (24/7), snapshot 15 min (06–20h), uuid-health/retry-outros 1x/h (06–20h), consolidação 20:30, drift-sweep 02:00, notas-devolvidas xx:05');

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
  retryOutrosJob?.stop();
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

  const { getSessionsByDate } = require('./wpaService');
  const { getClient } = require('./dbClient');
  const sb = getClient();
  if (!sb) return;

  // Default: dia anterior (BRT). Se passou dia específico, usa esse.
  const date = targetDate || new Date(Date.now() - (3 + 24) * 3600 * 1000).toISOString().slice(0, 10);

  console.log(`[CRON] sync-logoffs: buscando sessões finalizadas de ${date}`);
  const SETORES = ['DESG', 'DEPT', 'DESC', 'DSSJ'];   // SJC adicionado 08/06/2026
  const ENGELMIG_COMPANY_ID = process.env.WPA_COMPANY_ID || '92a2f98e-8877-433e-8358-173b94c13a54';

  let totalUpdated = 0;
  for (const sectorId of SETORES) {
    try {
      const sessions = await getSessionsByDate(sectorId, date);
      // Filtra só Engelmig + com EndTime preenchido (= sessões realmente fechadas)
      const fechadas = sessions.filter(s =>
        s.Team?.CompanyId === ENGELMIG_COMPANY_ID && s.EndTime && s.EndTime !== '0001-01-01T00:00:00'
      );
      if (fechadas.length === 0) {
        console.log(`[CRON] sync-logoffs: ${sectorId} sem sessões fechadas`);
        continue;
      }

      // Para cada sessão fechada, atualiza o snapshot mais recente daquela
      // equipe que ainda tem sessionEnd=null (= snapshot da sessão aberta).
      for (const s of fechadas) {
        const teamName = s.Team?.Name || s.Team?.ExternalReference;
        if (!teamName) continue;
        const beginTime = s.BeginTime;
        const endTime   = s.EndTime;

        // Busca último snap dessa equipe cujo sessionBegin bate
        const { data: rows } = await sb
          .from('snapshots')
          .select('id, data, captured_at')
          .eq('team_name', teamName)
          .gte('date', date)
          .order('captured_at', { ascending: false })
          .limit(20);

        if (!rows || rows.length === 0) continue;

        // Acha o snap com sessionBegin == beginTime E sessionEnd null (precisa atualizar)
        const snap = rows.find(r => {
          const sb1 = r.data?.sessionBegin || r.data?.session_begin;
          const se1 = r.data?.sessionEnd || r.data?.session_end;
          return sb1 === beginTime && !se1;
        });
        if (!snap) continue;

        // Atualiza o sessionEnd no payload
        const newData = { ...snap.data, sessionEnd: endTime };
        const { error } = await sb.from('snapshots').update({ data: newData }).eq('id', snap.id);
        if (!error) totalUpdated++;
        else console.warn(`[CRON] sync-logoffs: falha update ${teamName}: ${error.message}`);
      }
      console.log(`[CRON] sync-logoffs: ${sectorId} - ${fechadas.length} sessões fechadas processadas`);
    } catch (err) {
      console.warn(`[CRON] sync-logoffs: ${sectorId} falhou: ${err.message}`);
    }
  }
  console.log(`[CRON] sync-logoffs: ✓ ${totalUpdated} snapshots atualizados com sessionEnd`);
  return { date, updated: totalUpdated };
}

module.exports = {
  startCron, stopCron,
  runSnapshot, runConsolidate, runTokenRefresh,
  runClassifyNewNotes, runCacheNotaDetails,
  runDriftCheck, runDailyDriftSweep,
  runRetryRecentOutros, runRevalidateDD,
  runSyncLogoffs,
  runClassifyRejections, runBackfillRejeicoes,
  runSyncEscalas,
};
