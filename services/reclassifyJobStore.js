/**
 * services/reclassifyJobStore.js
 *
 * Persistência do estado do job de reclassificação de subcategorias (P2-10).
 *
 * PROBLEMA: `_reclassifyJob` em routes/index.js é variável de módulo EM MEMÓRIA.
 * O pipeline roda em background por minutos (notas DD baixam /details de até
 * 1.6MB). Se o worker PM2 morre por OOM ou há deploy no meio, o estado some e
 * o cliente que faz poll em /admin/subcat-reclassify/status vê `job:null` pra
 * sempre — sem saber se terminou, quanto faltava, ou se deu erro.
 *
 * SOLUÇÃO: espelhar o job em `app_settings` (key `reclassify_job`, coluna JSONB)
 * a cada lote. O status endpoint lê do banco (sobrevive a restart). No boot, se
 * o job persistido estava `running`, ninguém o retomou → marca `interrupted`
 * (estado terminal; requer novo disparo manual).
 *
 * A escrita é BEST-EFFORT: uma falha de persistência nunca derruba o pipeline
 * nem o boot (só loga). A fonte viva dentro do processo continua sendo a
 * variável em memória; o banco é a cópia durável pra status/reconciliação.
 */

const { getSetting, setSetting } = require('../db/queries');

const KEY = 'reclassify_job';

/** Grava o job no banco (best-effort — engole erro pra não quebrar o pipeline). */
async function saveJob(job) {
  try {
    await setSetting(KEY, job);
  } catch (e) {
    console.warn('[reclassifyJobStore] falha ao persistir job:', e.message);
  }
}

/** Lê o job persistido. Retorna o objeto do job ou null (best-effort). */
async function loadJob() {
  try {
    const row = await getSetting(KEY);
    return row && row.data && Object.keys(row.data).length > 0 ? row.data : null;
  } catch (e) {
    console.warn('[reclassifyJobStore] falha ao ler job:', e.message);
    return null;
  }
}

/**
 * Decide o estado do job no boot. PURA (testável sem banco).
 * Se estava `running`, o processo reiniciou no meio → `interrupted`. Qualquer
 * outro estado (done/error/interrupted/null) é terminal e passa inalterado.
 */
function reconcileBootState(job, nowIso) {
  if (!job) return null;
  if (job.status === 'running') {
    return {
      ...job,
      status: 'interrupted',
      finished_at: job.finished_at || nowIso,
      error: job.error ||
        'processo reiniciou durante o job (restart do PM2 ou OOM) — dispare a reclassificação de novo',
    };
  }
  return job;
}

/**
 * Chamado no boot do server. Lê o job persistido; se estava `running`, marca
 * `interrupted` e regrava. Retorna o job reconciliado (ou null).
 * `load`/`save`/`nowIso` são injetáveis pra teste.
 */
async function reconcileOnBoot({ load = loadJob, save = saveJob, nowIso } = {}) {
  const now = nowIso || new Date().toISOString();
  const job = await load();
  const reconciled = reconcileBootState(job, now);
  if (job && reconciled && reconciled.status !== job.status) {
    await save(reconciled);
    console.warn(`[reclassifyJobStore] job ${reconciled.id || '?'} estava 'running' no boot — marcado 'interrupted'.`);
  }
  return reconciled;
}

module.exports = { KEY, saveJob, loadJob, reconcileBootState, reconcileOnBoot };
