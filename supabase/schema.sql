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

-- ─────────────────────────────────────────────────────────────────────────────
-- Subcategorias de notas (MD/SF/DD desdobrados em Subs Obsoleto, Subs TL11,
-- Corte Disjuntor, Corte Borne, Subs Ramal, Substituição CS, etc.)
-- Uma linha por UUID. A subcategoria de uma nota nunca muda depois de criada,
-- então classifica uma vez e usa para sempre.
--
-- Origem dos dados (endpoints leves do WPA):
--   MD → /api/notes/md?noteId={uuid}            (~2.6 KB) — Code, CodeText
--      + /api/notepriorities/GetByNoteId/{uuid} (~1.6 KB) — SubProject (TL11/OBSOLETO)
--   SF → /api/notes/sfdl?noteId={uuid}          (~2 KB)   — Code, CodeText
--   DD → /api/notes/dd?noteId={uuid}            (~1.9 KB) — GroupCode, GroupDescription
--      + details/optimized (só p/ DD/C93|BTZ013) — Activities[].Quantity
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS note_subcategorias (
  note_id       UUID        PRIMARY KEY,
  numero        TEXT,
  tipo          TEXT        NOT NULL,            -- MD, SF, DD
  sub_code      TEXT        NOT NULL,            -- OBSOLETO,TL11,L0,L1,C93,BTZ013,OUTROS
  sub_categoria TEXT        NOT NULL,            -- nome bonito p/ UI ("Subs Obsoleto")
  code          TEXT,                            -- Code original WPA (SPEB, CREB, SRED...)
  code_text     TEXT,                            -- CodeText / GroupDescription bruto
  quantidade    NUMERIC,                         -- só DD/C93 e DD/BTZ013 (metros / pontos)
  classified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw           JSONB                            -- payloads brutos p/ debug e re-classificação futura
);

CREATE INDEX IF NOT EXISTS idx_note_subcat_subcode ON note_subcategorias (sub_code);
CREATE INDEX IF NOT EXISTS idx_note_subcat_tipo    ON note_subcategorias (tipo);
