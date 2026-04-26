/**
 * services/cronService.js
 * Cron jobs para coleta periódica de dados do WPA e consolidação diária.
 *
 * Agendamentos:
 *   - A cada 15 min (06:00–20:00 dias úteis) → salva snapshot no Supabase
 *   - Todo dia às 20:30 → consolida daily_totals do dia
 */

const cron         = require('node-cron');
const { getTeams } = require('./dataService');

let snapshotJob  = null;
let consolidaJob = null;
let isRunning    = false;

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

  // Snapshot a cada 15 min entre 06:00 e 20:00
  snapshotJob = cron.schedule('*/15 6-20 * * *', runSnapshot, {
    timezone: 'America/Sao_Paulo',
  });

  // Consolidação diária às 20:30
  consolidaJob = cron.schedule('30 20 * * *', runConsolidate, {
    timezone: 'America/Sao_Paulo',
  });

  console.log('[CRON] Jobs iniciados — snapshot a cada 15 min (06–20h), consolidação às 20:30');

  // Snapshot imediato ao iniciar (se dentro do horário)
  const hora = new Date().getHours();
  if (hora >= 6 && hora <= 20) {
    setTimeout(runSnapshot, 5000);
  }
}

function stopCron() {
  snapshotJob?.stop();
  consolidaJob?.stop();
}

module.exports = { startCron, stopCron, runSnapshot, runConsolidate };
