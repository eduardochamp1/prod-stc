#!/bin/bash
# ============================================================================
# backup-wpa-monitor.sh — Backup diário do Postgres local (wpa_monitor)
#
# - pg_dump em formato custom (-Fc): comprimido + permite restore seletivo
# - Retenção: mantém os últimos N dias (default 14), apaga mais antigos
# - Log append em ~/backups/wpa_monitor/backup.log
#
# INSTALAÇÃO (no servidor app-jose-zouain):
#   1. Copie pra home (ou rode do repo):
#        cp ~/prod-stc/scripts/backup-wpa-monitor.sh ~/backup-wpa-monitor.sh
#        chmod +x ~/backup-wpa-monitor.sh
#   2. Garanta que ~/.wpa_app_pass existe (APP_PASS=...)
#   3. Adicione no crontab (crontab -e):
#        0 3 * * * /home/usr_jose/backup-wpa-monitor.sh >> /home/usr_jose/backups/wpa_monitor/cron.log 2>&1
#   4. Teste manual: ~/backup-wpa-monitor.sh && ls -lh ~/backups/wpa_monitor/
#
# RESTORE (exemplo):
#   pg_restore -h 127.0.0.1 -U wpa_app -d wpa_monitor_restore --clean --if-exists \
#     ~/backups/wpa_monitor/wpa_monitor_2026-05-26_030000.dump
# ============================================================================

set -uo pipefail

# ── Config ──────────────────────────────────────────────────────────────────
PG_HOST="${PG_HOST:-127.0.0.1}"
PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-wpa_app}"
PG_DB="${PG_DB:-wpa_monitor}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/wpa_monitor}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
PASS_FILE="${PASS_FILE:-$HOME/.wpa_app_pass}"

TS="$(date +%Y-%m-%d_%H%M%S)"
OUT="$BACKUP_DIR/${PG_DB}_${TS}.dump"
LOG="$BACKUP_DIR/backup.log"

mkdir -p "$BACKUP_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

# ── Carrega senha ─────────────────────────────────────────────────────────────
if [ -f "$PASS_FILE" ]; then
  # shellcheck disable=SC1090
  source "$PASS_FILE"   # define APP_PASS
fi
if [ -z "${APP_PASS:-}" ]; then
  log "ERRO: APP_PASS não definido (esperado em $PASS_FILE). Abortando."
  exit 1
fi

# ── Dump ──────────────────────────────────────────────────────────────────────
log "Iniciando backup de ${PG_DB} → ${OUT}"
START=$(date +%s)

if PGPASSWORD="$APP_PASS" pg_dump \
      -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" \
      -Fc --no-owner --no-acl -f "$OUT"; then
  SIZE=$(du -h "$OUT" | cut -f1)
  DUR=$(( $(date +%s) - START ))
  log "✓ Backup OK — ${SIZE} em ${DUR}s"
else
  log "✗ FALHA no pg_dump — removendo arquivo parcial"
  rm -f "$OUT"
  exit 1
fi

# ── Verificação de integridade (lista conteúdo do dump) ──────────────────────
if pg_restore --list "$OUT" > /dev/null 2>&1; then
  log "✓ Integridade verificada (pg_restore --list OK)"
else
  log "⚠ AVISO: dump pode estar corrompido (pg_restore --list falhou)"
fi

# ── Retenção: apaga dumps com mais de N dias ─────────────────────────────────
DELETED=$(find "$BACKUP_DIR" -name "${PG_DB}_*.dump" -type f -mtime +"$RETENTION_DAYS" -print -delete | wc -l)
if [ "$DELETED" -gt 0 ]; then
  log "🗑  Retenção: ${DELETED} backup(s) com mais de ${RETENTION_DAYS} dias removido(s)"
fi

# ── Resumo ───────────────────────────────────────────────────────────────────
TOTAL=$(find "$BACKUP_DIR" -name "${PG_DB}_*.dump" -type f | wc -l)
DISK=$(du -sh "$BACKUP_DIR" | cut -f1)
log "📦 ${TOTAL} backup(s) no diretório (${DISK} total)"
log "─────────────────────────────────────────"
