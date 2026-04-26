-- WPA Monitor — Schema Supabase
-- Execute no SQL Editor do painel Supabase (https://supabase.com/dashboard)

-- Metas por regional (GUA/CAC) armazenadas como JSON
CREATE TABLE IF NOT EXISTS metas (
  regional  TEXT PRIMARY KEY,
  data      JSONB NOT NULL DEFAULT '{}'
);

-- Último snapshot das equipes ativas (atualizado a cada 15 min)
CREATE TABLE IF NOT EXISTS teams_current (
  team_name   TEXT        PRIMARY KEY,
  regional    TEXT        NOT NULL,
  sector_id   TEXT        NOT NULL,
  data        JSONB       NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Totais diários consolidados por regional/tipo (para gráficos históricos)
CREATE TABLE IF NOT EXISTS daily_totals (
  id         BIGSERIAL   PRIMARY KEY,
  date       DATE        NOT NULL,
  regional   TEXT        NOT NULL,
  tipo_code  TEXT        NOT NULL,
  count      INTEGER     NOT NULL DEFAULT 0,
  UNIQUE (date, regional, tipo_code)
);

CREATE INDEX IF NOT EXISTS idx_daily_totals_date ON daily_totals (date);

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

-- Totais diários consolidados por equipe/tipo (para ranking e histórico individual)
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

CREATE INDEX IF NOT EXISTS idx_team_daily_totals_date     ON team_daily_totals (date);
CREATE INDEX IF NOT EXISTS idx_team_daily_totals_team     ON team_daily_totals (team_name);
CREATE INDEX IF NOT EXISTS idx_team_daily_totals_regional ON team_daily_totals (date, regional);

-- Limpeza automática de snapshots com mais de 90 dias (opcional)
-- Ativar se quiser controlar o tamanho da tabela:
-- SELECT cron.schedule('cleanup-snapshots', '0 3 * * *',
--   $$DELETE FROM snapshots WHERE captured_at < NOW() - INTERVAL '90 days'$$);
