#!/bin/bash
# ============================================================================
# backup-wpa-monitor.sh — Backup diário do Postgres local (wpa_monitor)
#
# - pg_dump em formato custom (-Fc): comprimido + permite restore seletivo
# - Retenção LOCAL: mantém os últimos N dias (default 14), apaga mais antigos
# - OFFSITE (P0-2): copia o dump pro OneDrive corporativo via rclone (opt-in;
#   se rclone não estiver configurado, degrada pra backup só local sem quebrar)
# - Log append em ~/backups/wpa_monitor/backup.log
#
# INSTALAÇÃO (no servidor app-jose-zouain):
#   1. Copie pra home (ou rode do repo). RE-COPIE após cada git pull que mexa aqui:
#        cp ~/prod-stc/scripts/backup-wpa-monitor.sh ~/backup-wpa-monitor.sh
#        chmod +x ~/backup-wpa-monitor.sh
#   2. Garanta que ~/.wpa_app_pass existe (APP_PASS=...)
#   3. (OFFSITE) Configure o rclone → OneDrive UMA vez. Passo a passo no
#        RUNBOOK.md, seção "Backup offsite (P0-2)". Sem isso o backup fica local.
#   4. Adicione no crontab (crontab -e):
#        0 3 * * * /home/usr_jose/backup-wpa-monitor.sh >> /home/usr_jose/backups/wpa_monitor/cron.log 2>&1
#   5. Teste manual: ~/backup-wpa-monitor.sh && ls -lh ~/backups/wpa_monitor/
#      Com offsite: confira `~/bin/rclone lsl onedrive:wpa-backups/`
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
INTEGRITY_OK=1
if pg_restore --list "$OUT" > /dev/null 2>&1; then
  log "✓ Integridade verificada (pg_restore --list OK)"
else
  INTEGRITY_OK=0
  log "⚠ AVISO: dump pode estar corrompido (pg_restore --list falhou) — NÃO será enviado offsite"
fi

# ── OFFSITE (rclone → OneDrive corporativo) — P0-2 ────────────────────────────
# Opt-in e com degradação segura: só roda se o rclone existir E o remote estiver
# configurado E a integridade tiver passado. Sem isso, o backup permanece LOCAL
# (nunca aborta o script). Setup do rclone (install sem sudo + OAuth OneDrive) e
# critério de aceite estão no RUNBOOK.md (P0-2). Variáveis sobrescrevíveis:
#   RCLONE_REMOTE (default onedrive), RCLONE_PATH (default wpa-backups),
#   OFFSITE_RETENTION_DAYS (default 30), RCLONE_BIN (default ~/bin/rclone|PATH).
RCLONE_BIN="${RCLONE_BIN:-$HOME/bin/rclone}"
[ -x "$RCLONE_BIN" ] || RCLONE_BIN="$(command -v rclone 2>/dev/null || true)"
RCLONE_REMOTE="${RCLONE_REMOTE:-onedrive}"
RCLONE_PATH="${RCLONE_PATH:-wpa-backups}"
OFFSITE_RETENTION_DAYS="${OFFSITE_RETENTION_DAYS:-30}"

if [ "$INTEGRITY_OK" -eq 1 ] && [ -n "$RCLONE_BIN" ] && [ -x "$RCLONE_BIN" ] \
   && "$RCLONE_BIN" listremotes 2>/dev/null | grep -q "^${RCLONE_REMOTE}:"; then
  log "☁ Enviando offsite → ${RCLONE_REMOTE}:${RCLONE_PATH}/"
  if "$RCLONE_BIN" copy "$OUT" "${RCLONE_REMOTE}:${RCLONE_PATH}/" --no-traverse 2>>"$LOG"; then
    log "✓ Offsite OK — $(basename "$OUT")"
    # Retenção offsite: apaga dumps remotos com mais de N dias
    if "$RCLONE_BIN" delete "${RCLONE_REMOTE}:${RCLONE_PATH}/" \
         --min-age "${OFFSITE_RETENTION_DAYS}d" --include "${PG_DB}_*.dump" 2>>"$LOG"; then
      log "🗑  Retenção offsite: dumps > ${OFFSITE_RETENTION_DAYS}d removidos do OneDrive"
    fi
  else
    log "⚠ AVISO: cópia offsite FALHOU (rclone) — backup LOCAL está OK; offsite pendente"
  fi
elif [ "$INTEGRITY_OK" -eq 1 ]; then
  log "ℹ Offsite não configurado (rclone/remote ausente) — backup só LOCAL. Ver RUNBOOK P0-2."
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
