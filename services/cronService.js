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

let tokenJob        = null;
let snapshotJob     = null;
let consolidaJob    = null;
let isRunning       = false;
let isRunningAt     = 0;          // timestamp de quando isRunning foi ligado
const MAX_RUN_MS    = 5 * 60_000; // 5 minutos — destrava automaticamente se travar

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
    // Ghosts existem apenas para manter KPIs no frontend quando uma equipe desloga.
    // NUNCA devem ir para o Supabase: se fossem, entrariam no aliveNames do
    // pushTeams e impediriam a deleção das equipes que realmente saíram do WPA,
    // fazendo-as aparecer indefinidamente como "sessão anômala" no monitor.
    const teams     = allTeams.filter(t => !t._ghostFromAcc);
    const ghostCount = allTeams.length - teams.length;
    if (ghostCount > 0) {
      console.log(`[CRON] _acc: ${ghostCount} equipe(s) fantasma excluída(s) das operações Supabase`);
    }

    if (teams.length === 0) {
      console.log('[CRON] Snapshot: nenhuma equipe ativa no WPA.');
      return; // finally abaixo libera isRunning corretamente
    }

    const ts = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const { saveSnapshot, pushTeams, upsertDailyTotals, upsertTeamDailyTotals, upsertSubcatTotals } = require('./supabasePush');

    await saveSnapshot(teams);
    await pushTeams(teams);
    await upsertDailyTotals(teams);
    await upsertTeamDailyTotals(teams);

    console.log(`[CRON] Snapshot salvo — ${teams.length} equipes reais às ${ts}`);

    // Classifica subcategorias dos UUIDs novos (não bloqueia o snapshot).
    // Quando concluir, dispara upsertSubcatTotals pra atualizar daily_subcat_totals
    // intraday (com base nos sub_codes recém-classificados).
    runClassifyNewNotes(teams)
      .then(() => upsertSubcatTotals(teams).catch(err =>
        console.warn('[CRON] upsertSubcatTotals intraday falhou:', err.message)))
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
          const fb = classificarSubCategoria(raw.Type, raw.Code, raw.Comments, raw.Activities);
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

  const { getClassifiedIds, upsertSubcategorias } = require('../db/subcategoriasQueries');
  const { classificarBatch } = require('./classifierService');

  // Filtra os que já estão classificados no Supabase
  const known = await getClassifiedIds();
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

// ── CONSOLIDAÇÃO ──────────────────────────────────────────────────────────────

async function runConsolidate(date) {
  // Sem data explícita usa BRT (UTC-3) — evita consolidar "amanhã" depois das 21h UTC
  date = date || new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  try {
    const { consolidateDay, cleanOldSnapshots } = require('./supabasePush');
    await consolidateDay(date);
    // Limpa snapshots velhos logo após a consolidação (uma vez por dia)
    await cleanOldSnapshots();
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

  console.log('[CRON] Jobs iniciados — token a cada 45 min (24/7), snapshot a cada 15 min (06–20h), consolidação às 20:30');

  // Login imediato ao iniciar para garantir token válido desde o primeiro ciclo
  setTimeout(runTokenRefresh, 2000);

  // Snapshot imediato ao iniciar (se dentro do horário — usa hora BRT, não UTC)
  const horaBRT = new Date(Date.now() - 3 * 3600 * 1000).getUTCHours();
  if (horaBRT >= 6 && horaBRT <= 20) {
    setTimeout(runSnapshot, 5000);
  }
}

function stopCron() {
  tokenJob?.stop();
  snapshotJob?.stop();
  consolidaJob?.stop();
}

module.exports = { startCron, stopCron, runSnapshot, runConsolidate, runTokenRefresh, runClassifyNewNotes, runCacheNotaDetails };
