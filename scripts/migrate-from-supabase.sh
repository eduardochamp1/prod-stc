#!/usr/bin/env bash
# ============================================================================
# migrate-from-supabase.sh
#
# Migra dados das 13 tabelas usadas pela aplicacao do Supabase para um
# Postgres self-hosted local. Validado para PG 16 destino e Postgres do
# Supabase como origem (qualquer versao compativel).
#
# Pre-requisitos:
#   - postgresql-client-16 instalado no servidor que roda este script
#   - Acesso de rede ao Supabase (porta 5432)
#   - Postgres local ja com schema aplicado (Fase 1 do POSTGRES-MIGRATION.md)
#   - Variaveis de ambiente abaixo configuradas
#
# Uso:
#   1. Copie .env.migration.example para .env.migration e preencha
#   2. source .env.migration
#   3. ./scripts/migrate-from-supabase.sh
#
# O script pergunta confirmacao antes de cada passo destrutivo.
# Idempotente: pode rodar de novo se algo der errado no meio.
# ============================================================================

set -euo pipefail

# ── Validacao de env ─────────────────────────────────────────────────────────
: "${SUPABASE_HOST:?defina SUPABASE_HOST (ex: db.iyadtjzehhebwojreudz.supabase.co)}"
: "${SUPABASE_PORT:=5432}"
: "${SUPABASE_USER:?defina SUPABASE_USER (ex: postgres)}"
: "${SUPABASE_DB:=postgres}"
: "${SUPABASE_PASSWORD:?defina SUPABASE_PASSWORD}"

: "${LOCAL_HOST:=localhost}"
: "${LOCAL_PORT:=5432}"
: "${LOCAL_USER:?defina LOCAL_USER (ex: wpa_app)}"
: "${LOCAL_DB:?defina LOCAL_DB (ex: wpa_monitor)}"
: "${LOCAL_PASSWORD:?defina LOCAL_PASSWORD}"

DUMP_DIR="${DUMP_DIR:-/tmp/wpa-migration}"
DUMP_FILE="${DUMP_DIR}/wpa_supabase_$(date +%Y%m%d_%H%M%S).dump"

# Tabelas a migrar (mesma ordem em que existem nas migrations)
TABLES=(
  metas
  equipes_oficiais
  teams_current
  snapshots
  daily_totals
  daily_subcat_totals
  team_daily_totals
  team_daily_subcat_totals
  note_subcategorias
  note_details
  note_rejections
  wpa_token
  app_settings
)

# ── Helpers ──────────────────────────────────────────────────────────────────
log()  { printf "\033[1;34m[%(%H:%M:%S)T]\033[0m %s\n" -1 "$*"; }
ok()   { printf "\033[1;32m  ok\033[0m  %s\n" "$*"; }
warn() { printf "\033[1;33m  warn\033[0m %s\n" "$*"; }
err()  { printf "\033[1;31m  err\033[0m %s\n" "$*" >&2; }

confirm() {
  read -r -p "$1 [y/N] " resp
  [[ "$resp" =~ ^[yY]$ ]] || { echo "abortado"; exit 1; }
}

sb_psql() {
  PGPASSWORD="$SUPABASE_PASSWORD" psql \
    -h "$SUPABASE_HOST" -p "$SUPABASE_PORT" -U "$SUPABASE_USER" -d "$SUPABASE_DB" \
    --set ON_ERROR_STOP=1 -A -t "$@"
}

local_psql() {
  PGPASSWORD="$LOCAL_PASSWORD" psql \
    -h "$LOCAL_HOST" -p "$LOCAL_PORT" -U "$LOCAL_USER" -d "$LOCAL_DB" \
    --set ON_ERROR_STOP=1 -A -t "$@"
}

# ── Passo 0: sanity checks ───────────────────────────────────────────────────
log "Sanity check: conectando no Supabase..."
sb_psql -c "SELECT current_database(), version();" | head -1
ok "Supabase responde"

log "Sanity check: conectando no Postgres local..."
local_psql -c "SELECT current_database(), version();" | head -1
ok "Postgres local responde"

log "Verificando que as tabelas existem no destino (schema da Fase 1)..."
missing=()
for t in "${TABLES[@]}"; do
  exists=$(local_psql -c "SELECT to_regclass('public.${t}') IS NOT NULL;")
  [[ "$exists" == "t" ]] || missing+=("$t")
done
if (( ${#missing[@]} > 0 )); then
  err "tabelas faltando no destino: ${missing[*]}"
  err "Aplique o schema da Fase 1 primeiro (supabase/schema.sql + migrations/)."
  exit 1
fi
ok "todas as ${#TABLES[@]} tabelas existem no destino"

# ── Passo 1: contagens da origem (baseline) ──────────────────────────────────
log "Coletando contagens na origem (Supabase)..."
mkdir -p "$DUMP_DIR"
SRC_COUNTS="${DUMP_DIR}/counts_source.txt"
: > "$SRC_COUNTS"
for t in "${TABLES[@]}"; do
  n=$(sb_psql -c "SELECT count(*) FROM public.${t};")
  printf "%-35s %s\n" "$t" "$n" | tee -a "$SRC_COUNTS"
done
ok "salvo em $SRC_COUNTS"

# ── Passo 2: contagens no destino antes do dump (deve ser 0 ou rows residuais) ──
log "Contagens no destino ANTES da migracao:"
DST_COUNTS_PRE="${DUMP_DIR}/counts_dest_before.txt"
: > "$DST_COUNTS_PRE"
total_pre=0
for t in "${TABLES[@]}"; do
  n=$(local_psql -c "SELECT count(*) FROM public.${t};")
  printf "%-35s %s\n" "$t" "$n" | tee -a "$DST_COUNTS_PRE"
  total_pre=$((total_pre + n))
done

if (( total_pre > 0 )); then
  warn "destino tem $total_pre rows residuais nas tabelas-alvo."
  warn "o pg_restore com --data-only pode falhar em PKs duplicadas."
  confirm "TRUNCATE essas tabelas antes do restore?"
  log "Truncando tabelas no destino..."
  # CASCADE para resolver FKs internas; reset sequences
  for t in "${TABLES[@]}"; do
    local_psql -c "TRUNCATE TABLE public.${t} RESTART IDENTITY CASCADE;"
    ok "truncado: $t"
  done
fi

# ── Passo 3: pg_dump ─────────────────────────────────────────────────────────
log "Iniciando pg_dump (formato custom, paralelizavel)..."
log "Destino: $DUMP_FILE"

# Args -t (table) em sequencia para limitar ao escopo das 13 tabelas.
T_ARGS=()
for t in "${TABLES[@]}"; do
  T_ARGS+=(-t "public.${t}")
done

PGPASSWORD="$SUPABASE_PASSWORD" pg_dump \
  -h "$SUPABASE_HOST" -p "$SUPABASE_PORT" -U "$SUPABASE_USER" -d "$SUPABASE_DB" \
  --data-only --no-owner --no-privileges \
  --no-comments --disable-triggers \
  "${T_ARGS[@]}" \
  -Fc -f "$DUMP_FILE" \
  --verbose 2> "${DUMP_DIR}/pg_dump.log" || {
    err "pg_dump falhou. Veja ${DUMP_DIR}/pg_dump.log"
    exit 1
  }

DUMP_SIZE=$(du -h "$DUMP_FILE" | cut -f1)
ok "dump concluido (${DUMP_SIZE})"

# ── Passo 4: pg_restore ──────────────────────────────────────────────────────
log "Iniciando pg_restore no destino..."
PGPASSWORD="$LOCAL_PASSWORD" pg_restore \
  -h "$LOCAL_HOST" -p "$LOCAL_PORT" -U "$LOCAL_USER" -d "$LOCAL_DB" \
  --data-only --disable-triggers --no-owner --no-privileges \
  --jobs=2 \
  --exit-on-error \
  "$DUMP_FILE" 2> "${DUMP_DIR}/pg_restore.log" || {
    err "pg_restore reportou erros. Veja ${DUMP_DIR}/pg_restore.log"
    err "Algumas linhas podem ter sido restauradas; verifique contagens abaixo."
  }

# ── Passo 5: contagens no destino + comparacao ───────────────────────────────
log "Contagens no destino DEPOIS da migracao:"
DST_COUNTS_POST="${DUMP_DIR}/counts_dest_after.txt"
: > "$DST_COUNTS_POST"
fail=0
printf "\n%-35s %12s %12s %12s\n" "TABELA" "ORIGEM" "DESTINO" "DELTA"
printf "%-35s %12s %12s %12s\n" "------" "------" "-------" "-----"
while read -r src_line && read -r dst_line <&3; do
  t=$(echo "$src_line" | awk '{print $1}')
  src_n=$(echo "$src_line" | awk '{print $2}')
  dst_n=$(local_psql -c "SELECT count(*) FROM public.${t};")
  delta=$((dst_n - src_n))
  marker=""
  if (( delta == 0 )); then
    marker="OK"
  else
    marker="DIFF"
    fail=$((fail+1))
  fi
  printf "%-35s %12s %12s %12s  %s\n" "$t" "$src_n" "$dst_n" "$delta" "$marker"
  printf "%-35s %s\n" "$t" "$dst_n" >> "$DST_COUNTS_POST"
done < "$SRC_COUNTS" 3< "$SRC_COUNTS"

echo
if (( fail == 0 )); then
  ok "MIGRACAO COMPLETA — todas as ${#TABLES[@]} tabelas batem com a origem"
else
  err "${fail} tabela(s) com discrepancia. Investigue antes do cutover."
  exit 1
fi

# ── Passo 6: ANALYZE pra estatisticas atualizadas ────────────────────────────
log "Rodando ANALYZE para atualizar estatisticas do planner..."
local_psql -c "ANALYZE;"
ok "ANALYZE concluido"

# ── Passo 7: estado final ────────────────────────────────────────────────────
log "Tamanho atual do banco no destino:"
local_psql -c "
  SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size,
         pg_size_pretty(pg_total_relation_size('snapshots'))   AS snapshots,
         pg_size_pretty(pg_total_relation_size('note_details')) AS note_details;
"

cat <<EOF

═══════════════════════════════════════════════════════════════════════════════
  MIGRACAO DOS DADOS CONCLUIDA
═══════════════════════════════════════════════════════════════════════════════

  Dump salvo em : $DUMP_FILE
  Logs em       : ${DUMP_DIR}/

  PROXIMO PASSO: Fase 3 do POSTGRES-MIGRATION.md
  - reescrever services/supabaseClient.js como shim sobre pg
  - configurar DATABASE_URL no .env do app
  - pm2 restart wpa-monitor apontando para o destino local

═══════════════════════════════════════════════════════════════════════════════
EOF
