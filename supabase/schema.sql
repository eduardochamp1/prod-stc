-- WPA Monitor — Schema Supabase consolidado
-- Aplica todas as migrations 001..005 em ordem. Idempotente — todas as
-- tabelas/índices usam IF NOT EXISTS.
--
-- Como aplicar em ambiente novo:
--   1. Painel Supabase → SQL Editor → New query
--   2. Cole este arquivo inteiro e execute (Ctrl+Enter)
--
-- Em produção já existente, este arquivo é seguro de re-executar — só
-- aplica as DDLs que ainda não foram aplicadas.
--
-- ──────────────────────────────────────────────────────────────────────────────

-- ── METAS ────────────────────────────────────────────────────────────────────
-- Metas por regional (GUA/CAC) armazenadas como JSON (chave = tipo de OS)
CREATE TABLE IF NOT EXISTS metas (
  regional  TEXT PRIMARY KEY,
  data      JSONB NOT NULL DEFAULT '{}'
);

-- ── SNAPSHOTS / TEAMS_CURRENT ────────────────────────────────────────────────
-- Último snapshot das equipes ativas (atualizado a cada 15 min)
CREATE TABLE IF NOT EXISTS teams_current (
  team_name   TEXT        PRIMARY KEY,
  regional    TEXT        NOT NULL,
  sector_id   TEXT        NOT NULL,
  data        JSONB       NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Snapshots históricos — um registro por equipe a cada 15 min
CREATE TABLE IF NOT EXISTS snapshots (
  id            BIGSERIAL   PRIMARY KEY,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  date          DATE        NOT NULL,
  team_name     TEXT        NOT NULL,
  sector_id     TEXT        NOT NULL,
  regional      TEXT        NOT NULL,
  session_begin TEXT,
  session_end   TEXT,
  vehicle_plate TEXT,
  baixadas      INTEGER     NOT NULL DEFAULT 0,
  executadas    INTEGER     NOT NULL DEFAULT 0,
  concluidas    INTEGER     NOT NULL DEFAULT 0,
  rejeitadas    INTEGER     NOT NULL DEFAULT 0,
  data          JSONB
);

CREATE INDEX IF NOT EXISTS idx_snapshots_date_team   ON snapshots (date, team_name);
CREATE INDEX IF NOT EXISTS idx_snapshots_captured_at ON snapshots (captured_at DESC);

-- ── TOTAIS REGIONAIS (legados) ───────────────────────────────────────────────
-- daily_totals e daily_subcat_totals: tabelas regionais que NÃO são mais
-- lidas pelo sistema (queries leem direto do nível team_* para permitir
-- filtro pela whitelist de equipes oficiais). Mantidas no schema para
-- compatibilidade com backfill scripts; writes foram desativados em
-- supabasePush.js.
CREATE TABLE IF NOT EXISTS daily_totals (
  id         BIGSERIAL   PRIMARY KEY,
  date       DATE        NOT NULL,
  regional   TEXT        NOT NULL,
  tipo_code  TEXT        NOT NULL,
  count      INTEGER     NOT NULL DEFAULT 0,
  UNIQUE (date, regional, tipo_code)
);
CREATE INDEX IF NOT EXISTS idx_daily_totals_date ON daily_totals (date);

CREATE TABLE IF NOT EXISTS daily_subcat_totals (
  id          BIGSERIAL    PRIMARY KEY,
  date        DATE         NOT NULL,
  regional    TEXT         NOT NULL,
  tipo        TEXT         NOT NULL,
  sub_code    TEXT         NOT NULL,
  count       INTEGER      NOT NULL DEFAULT 0,
  quantidade  NUMERIC,
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (date, regional, tipo, sub_code)
);
CREATE INDEX IF NOT EXISTS idx_daily_subcat_date         ON daily_subcat_totals (date);
CREATE INDEX IF NOT EXISTS idx_daily_subcat_subcode      ON daily_subcat_totals (sub_code);
CREATE INDEX IF NOT EXISTS idx_daily_subcat_regional_dt  ON daily_subcat_totals (regional, date);

-- ── TOTAIS POR EQUIPE (fonte primária de leitura) ────────────────────────────
-- Estas são as tabelas efetivamente lidas — todas as agregações regionais
-- são feitas em runtime nas queries (ver db/supabaseQueries.js).
CREATE TABLE IF NOT EXISTS team_daily_totals (
  id         BIGSERIAL   PRIMARY KEY,
  date       DATE        NOT NULL,
  team_name  TEXT        NOT NULL,
  regional   TEXT        NOT NULL,
  sector_id  TEXT        NOT NULL,
  tipo_code  TEXT        NOT NULL,
  count      INTEGER     NOT NULL DEFAULT 0,
  UNIQUE (date, team_name, tipo_code)
);
CREATE INDEX IF NOT EXISTS idx_team_daily_totals_date          ON team_daily_totals (date);
CREATE INDEX IF NOT EXISTS idx_team_daily_totals_team          ON team_daily_totals (team_name);
-- Migração 005: ordem (regional, date) — aplicação primária filtra por regional
CREATE INDEX IF NOT EXISTS idx_team_daily_totals_regional_date ON team_daily_totals (regional, date);

CREATE TABLE IF NOT EXISTS team_daily_subcat_totals (
  id          BIGSERIAL    PRIMARY KEY,
  date        DATE         NOT NULL,
  team_name   TEXT         NOT NULL,
  regional    TEXT         NOT NULL,
  sector_id   TEXT         NOT NULL,
  tipo        TEXT         NOT NULL,
  sub_code    TEXT         NOT NULL,
  count       INTEGER      NOT NULL DEFAULT 0,
  quantidade  NUMERIC,
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (date, team_name, tipo, sub_code)
);
CREATE INDEX IF NOT EXISTS idx_team_daily_subcat_date          ON team_daily_subcat_totals (date);
CREATE INDEX IF NOT EXISTS idx_team_daily_subcat_team          ON team_daily_subcat_totals (team_name);
CREATE INDEX IF NOT EXISTS idx_team_daily_subcat_regional_date ON team_daily_subcat_totals (regional, date);
CREATE INDEX IF NOT EXISTS idx_team_daily_subcat_subcode       ON team_daily_subcat_totals (sub_code);

-- ── CACHE DE CLASSIFICAÇÃO (subcategorias) ───────────────────────────────────
-- Cache persistente da classificação de subcategorias. Uma linha por UUID.
-- Sub_code de uma nota nunca muda — classifica uma vez e reutiliza.
CREATE TABLE IF NOT EXISTS note_subcategorias (
  note_id       UUID        PRIMARY KEY,
  numero        TEXT,
  tipo          TEXT        NOT NULL,            -- MD, SF, DD
  sub_code      TEXT        NOT NULL,            -- OBSOLETO,TL11,L0,L1,C93,BTZ013,OUTROS
  sub_categoria TEXT        NOT NULL,
  code          TEXT,
  code_text     TEXT,
  quantidade    NUMERIC,                         -- só DD/C93 (metros) e DD/BTZ013 (pontos)
  classified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw           JSONB
);
CREATE INDEX IF NOT EXISTS idx_note_subcat_subcode ON note_subcategorias (sub_code);
CREATE INDEX IF NOT EXISTS idx_note_subcat_tipo    ON note_subcategorias (tipo);

-- ── TOKEN COMPARTILHADO (WPA) ────────────────────────────────────────────────
-- Cache do JWT para que múltiplos containers/lambdas não façam login redundante.
CREATE TABLE IF NOT EXISTS wpa_token (
  key         TEXT        PRIMARY KEY,           -- atualmente 'wpa'
  token       TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  user_id     TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wpa_token_expires ON wpa_token (expires_at);

-- ── APP SETTINGS ─────────────────────────────────────────────────────────────
-- Preferências e flags compartilhadas (chave/valor jsonb).
-- Usos atuais:
--   monitor-filters → filtros do monitor (regional + tipos selecionados)
--   subcat_error    → último erro de classificação (cron auto-recovery)
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT        PRIMARY KEY,
  data       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── NOTE_DETAILS (cache de payloads completos) ───────────────────────────────
-- Cache do payload completo de cada OS finalizada (sem fotos, comprimido).
-- Populado pelo cron — leitura instantânea pela rota /api/wpa/nota.
CREATE TABLE IF NOT EXISTS note_details (
  note_id     UUID        PRIMARY KEY,
  numero      TEXT,
  tipo        TEXT,
  sector_id   TEXT,
  payload     JSONB       NOT NULL,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_note_details_fetched_at ON note_details (fetched_at);

-- ── LIMPEZA AUTOMÁTICA (sugestão, opcional) ──────────────────────────────────
-- Habilitar via pg_cron se quiser controlar tamanho das tabelas:
--
--   SELECT cron.schedule('cleanup-snapshots', '0 3 * * *',
--     $$DELETE FROM snapshots WHERE captured_at < NOW() - INTERVAL '30 days'$$);
--
--   SELECT cron.schedule('cleanup-note-details', '0 4 * * *',
--     $$DELETE FROM note_details WHERE fetched_at < NOW() - INTERVAL '90 days'$$);
