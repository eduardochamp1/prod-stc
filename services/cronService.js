/**
 * services/cronService.js
 * Cron jobs para coleta periódica de dados do WPA e consolidação diária.
 *
 * Agendamentos:
 *   - A cada 15 min (06:00–20:00 dias úteis) → salva snapshot das equipes
 *   - Todo dia às 20:30 → consolida daily_totals do dia
 */

const cron       = require('node-cron');
const { getTeams }        = require('./dataService');
const { saveSnapshot, consolidateDay } = require('../db/queries');

let snapshotJob   = null;
let consolidaJob  = null;
let isRunning     = false;

// ── SNAPSHOT ─────────────────────────────────────────────────────────────────

async function runSnapshot() {
  if (isRunning) return; // evita execuções paralelas
  isRunning = true;
  try {
    const teams = await getTeams();
    if (teams.length > 0) {
      await saveSnapshot(teams);
      console.log(`[CRON] Snapshot salvo — ${teams.length} equipes às ${new Date().toLocaleTimeString('pt-BR')}`);
    } else {
      console.log('[CRON] Snapshot: nenhuma equipe ativa no momento.');
    }
  } catch (err) {
    console.error('[CRON] Erro no snapshot:', err.message);
  } finally {
    isRunning = false;
  }
}

// ── CONSOLIDAÇÃO ──────────────────────────────────────────────────────────────

async function runConsolidate() {
  const date = new Date().toISOString().slice(0, 10);
  try {
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

  // Snapshot a cada 15 min, apenas entre 06:00 e 20:00
  // '*/15 6-20 * * *'  →  minuto */15, hora 6–20, todo dia
  snapshotJob = cron.schedule('*/15 6-20 * * *', runSnapshot, {
    timezone: 'America/Sao_Paulo',
  });

  // Consolidação diária às 20:30
  consolidaJob = cron.schedule('30 20 * * *', runConsolidate, {
    timezone: 'America/Sao_Paulo',
  });

  console.log('[CRON] Jobs iniciados — snapshot a cada 15 min (06–20h), consolidação às 20:30');

  // Roda um snapshot imediato ao iniciar (se dentro do horário)
  const hora = new Date().getHours();
  if (hora >= 6 && hora <= 20) {
    setTimeout(runSnapshot, 5000); // aguarda 5s o servidor estabilizar
  }
}

function stopCron() {
  snapshotJob?.stop();
  consolidaJob?.stop();
}

module.exports = { startCron, stopCron, runSnapshot, runConsolidate };
