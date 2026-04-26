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

let tokenJob     = null;
let snapshotJob  = null;
let consolidaJob = null;
let isRunning    = false;

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
  if (isRunning) return;
  isRunning = true;
  try {
    const teams = await getTeams();
    if (teams.length === 0) {
      console.log('[CRON] Snapshot: nenhuma equipe ativa.');
      return;
    }

    const ts = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const { saveSnapshot, pushTeams, upsertDailyTotals, upsertTeamDailyTotals } = require('./supabasePush');

    await saveSnapshot(teams);
    await pushTeams(teams);
    await upsertDailyTotals(teams);
    await upsertTeamDailyTotals(teams);

    console.log(`[CRON] Snapshot salvo — ${teams.length} equipes às ${ts}`);
  } catch (err) {
    console.error('[CRON] Erro no snapshot:', err.message);
  } finally {
    isRunning = false;
  }
}

// ── CONSOLIDAÇÃO ──────────────────────────────────────────────────────────────

async function runConsolidate(date) {
  date = date || new Date().toISOString().slice(0, 10);
  try {
    const { consolidateDay } = require('./supabasePush');
    await consolidateDay(date);
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

  // Snapshot imediato ao iniciar (se dentro do horário)
  const hora = new Date().getHours();
  if (hora >= 6 && hora <= 20) {
    setTimeout(runSnapshot, 5000);
  }
}

function stopCron() {
  tokenJob?.stop();
  snapshotJob?.stop();
  consolidaJob?.stop();
}

module.exports = { startCron, stopCron, runSnapshot, runConsolidate, runTokenRefresh };
