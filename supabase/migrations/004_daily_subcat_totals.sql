-- 004_daily_subcat_totals.sql
-- Histórico diário agregado por subcategoria (TL11/OBSOLETO/L0/L1/C93/BTZ013/OUTROS).
-- Complementa daily_totals e team_daily_totals existentes (que agregam só por tipo MD/SF/DD).
--
-- Granularidade:
--   daily_subcat_totals       — dia × regional × tipo × sub_code
--   team_daily_subcat_totals  — dia × equipe × regional × tipo × sub_code
--
-- Quantidade (NUMERIC, opcional):
--   DD/C93    → soma de metros de ramal substituídos
--   DD/BTZ013 → soma de pontos de CS substituídos
--   Outras combinações tipo+sub_code → NULL (não aplicável)
--
-- Como aplicar:
--   1. Painel Supabase → SQL Editor → New query
--   2. Cole e execute (Ctrl+Enter)
--   3. Rode `node scripts/backfill-daily-subcat.js` para popular abril/maio histórico
--   4. Daí em diante, cronService.consolidateDay() mantém atualizado

CREATE TABLE IF NOT EXISTS daily_subcat_totals (
  id          BIGSERIAL    PRIMARY KEY,
  date        DATE         NOT NULL,
  regional    TEXT         NOT NULL,    -- GUA | CAC | (etc)
  tipo        TEXT         NOT NULL,    -- MD | SF | DD
  sub_code    TEXT         NOT NULL,    -- TL11 | OBSOLETO | L0 | L1 | C93 | BTZ013 | OUTROS
  count       INTEGER      NOT NULL DEFAULT 0,
  quantidade  NUMERIC,                  -- só DD/C93 (metros) e DD/BTZ013 (pontos)
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (date, regional, tipo, sub_code)
);

CREATE INDEX IF NOT EXISTS idx_daily_subcat_date         ON daily_subcat_totals (date);
CREATE INDEX IF NOT EXISTS idx_daily_subcat_subcode      ON daily_subcat_totals (sub_code);
CREATE INDEX IF NOT EXISTS idx_daily_subcat_regional_dt  ON daily_subcat_totals (regional, date);

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

CREATE INDEX IF NOT EXISTS idx_team_daily_subcat_date     ON team_daily_subcat_totals (date);
CREATE INDEX IF NOT EXISTS idx_team_daily_subcat_team     ON team_daily_subcat_totals (team_name);
CREATE INDEX IF NOT EXISTS idx_team_daily_subcat_regional ON team_daily_subcat_totals (regional, date);
CREATE INDEX IF NOT EXISTS idx_team_daily_subcat_subcode  ON team_daily_subcat_totals (sub_code);
