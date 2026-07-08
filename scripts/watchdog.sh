#!/bin/bash
# scripts/watchdog.sh — vigia a saúde do WPA Monitor e alerta no Teams (P1-1).
#
# Roda FORA do processo Node (no crontab do usuário), pra detectar até queda
# total do app. Consome /health (que faz check real de Postgres + idade do
# último snapshot — ver P1-2) e dispara alerta se degradado.
#
# Instalar no crontab (a cada 15 min):
#   crontab -e
#   */15 * * * * /home/usr_jose/prod-stc/scripts/watchdog.sh >> /home/usr_jose/prod-stc/logs/watchdog.log 2>&1
#
# Configurar o webhook (Teams Incoming Webhook) via env ou editar abaixo:
#   export WATCHDOG_TEAMS_WEBHOOK="https://outlook.office.com/webhook/..."

set -u

HEALTH_URL="${WATCHDOG_HEALTH_URL:-http://localhost:3002/health}"
WEBHOOK="${WATCHDOG_TEAMS_WEBHOOK:-}"
STATE_FILE="${WATCHDOG_STATE_FILE:-/tmp/wpa_watchdog_state}"

# Consulta /health (timeout 15s). Captura corpo e status HTTP.
BODY=$(curl -sS --max-time 15 -w "\n%{http_code}" "$HEALTH_URL" 2>/dev/null)
HTTP_CODE=$(echo "$BODY" | tail -1)
JSON=$(echo "$BODY" | sed '$d')

PROBLEMA=""
if [ -z "$HTTP_CODE" ] || [ "$HTTP_CODE" = "000" ]; then
  PROBLEMA="App inacessível (sem resposta de $HEALTH_URL — Node caiu?)"
elif [ "$HTTP_CODE" != "200" ]; then
  REASON=$(echo "$JSON" | grep -o '"reason":"[^"]*"' | head -1 | cut -d'"' -f4)
  PROBLEMA="Health degradado (HTTP $HTTP_CODE): ${REASON:-motivo não informado}"
fi

# Alerta com deduplicação: só dispara quando o estado MUDA (evita spam a cada 15min).
LAST_STATE=""
[ -f "$STATE_FILE" ] && LAST_STATE=$(cat "$STATE_FILE")

if [ -n "$PROBLEMA" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') ALERTA: $PROBLEMA"
  if [ "$LAST_STATE" != "DOWN" ]; then
    echo "DOWN" > "$STATE_FILE"
    if [ -n "$WEBHOOK" ]; then
      curl -sS --max-time 15 -H "Content-Type: application/json" \
        -d "{\"text\":\"🔴 **WPA Monitor** — $PROBLEMA\"}" "$WEBHOOK" >/dev/null 2>&1
    fi
  fi
else
  echo "$(date '+%Y-%m-%d %H:%M:%S') OK ($HTTP_CODE)"
  if [ "$LAST_STATE" = "DOWN" ]; then
    echo "UP" > "$STATE_FILE"
    if [ -n "$WEBHOOK" ]; then
      curl -sS --max-time 15 -H "Content-Type: application/json" \
        -d "{\"text\":\"🟢 **WPA Monitor** — recuperado, health OK.\"}" "$WEBHOOK" >/dev/null 2>&1
    fi
  fi
fi
