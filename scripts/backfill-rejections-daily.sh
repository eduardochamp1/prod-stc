#!/bin/bash
# ============================================================================
# backfill-rejections-daily.sh — Saneamento diário de rejeições WPA
#
# Roda `scripts/backfill-rejections.js` cobrindo os últimos 2 dias (hoje +
# ontem) pra capturar qualquer rejeição que o cron rotineiro do wpa-monitor
# tenha perdido durante crashes / restarts do pm2.
#
# Por que 2 dias e não só hoje:
#   Notas rejeitadas hoje podem ser bandeiradas só depois da meia-noite. Cobrir
#   ontem garante que o backfill da virada não deixa lacuna no relatório do dia
#   anterior. O script é idempotente — UUIDs já gravados são filtrados antes do
#   fetch (vide _local/scripts/backfill-rejections.js passo 4/5).
#
# INSTALAÇÃO (no servidor app-jose-zouain):
#   1. Copia pra home (ou roda do repo):
#        cp ~/prod-stc/scripts/backfill-rejections-daily.sh ~/backfill-rejections-daily.sh
#        chmod +x ~/backfill-rejections-daily.sh
#   2. Garante que ~/.wpa_app_pass existe (mesma senha usada pelo backup)
#   3. Adiciona no crontab (crontab -e) — 23:30 BRT diariamente:
#        30 23 * * * /home/usr_jose/backfill-rejections-daily.sh >> /home/usr_jose/backups/wpa_monitor/backfill-rejections.log 2>&1
#   4. Teste manual:
#        ~/backfill-rejections-daily.sh && tail -30 ~/backups/wpa_monitor/backfill-rejections.log
# ============================================================================

set -uo pipefail

# ── Config ──────────────────────────────────────────────────────────────────
PROJECT_DIR="${PROJECT_DIR:-$HOME/prod-stc}"
LOG_DIR="${LOG_DIR:-$HOME/backups/wpa_monitor}"
LOG="$LOG_DIR/backfill-rejections.log"

DE=$(date -d 'yesterday' +%Y-%m-%d)
ATE=$(date +%Y-%m-%d)

mkdir -p "$LOG_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

# ── Pré-flight ──────────────────────────────────────────────────────────────
if [ ! -d "$PROJECT_DIR" ]; then
  log "ERRO: PROJECT_DIR $PROJECT_DIR não existe. Abortando."
  exit 1
fi

if [ ! -f "$PROJECT_DIR/scripts/backfill-rejections.js" ]; then
  log "ERRO: backfill-rejections.js não encontrado em $PROJECT_DIR/scripts/"
  exit 1
fi

cd "$PROJECT_DIR" || { log "ERRO: cd $PROJECT_DIR falhou"; exit 1; }

# ── Run ─────────────────────────────────────────────────────────────────────
log "─────────────────────────────────────────"
log "Backfill rejeições: ${DE} → ${ATE}"
START=$(date +%s)

# stderr e stdout vão pro log (cron redirect cuida do append)
if node scripts/backfill-rejections.js --de="$DE" --ate="$ATE" >> "$LOG" 2>&1; then
  DUR=$(( $(date +%s) - START ))
  log "✓ Backfill concluído em ${DUR}s"
else
  log "✗ FALHA no backfill (exit != 0) — verifique o log acima"
  exit 1
fi
