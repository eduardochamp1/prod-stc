-- ===========================================================================
-- Migration: tabela note_rejections — motivos canônicos de rejeição das notas
-- Aplica em 23/05/2026
--
-- Fonte: /api/notes/{tipo}?noteId=... → Rejection.RejectionReasons[]
--   { Code, Description, EntityId, Label, ... }
--
-- Uma nota pode ter VÁRIOS motivos. Guardamos em arrays paralelos
-- (reason_codes + reason_labels) e o payload bruto em `raw` pra auditoria.
--
-- Notas que aparecem em notasRejeitadas[] mas Rejection vem vazio (~60%
-- dos casos — "bandeiradas" tipo Conta Paga) entram aqui com reason_codes=[].
-- ===========================================================================

CREATE TABLE IF NOT EXISTS note_rejections (
  note_id          UUID        PRIMARY KEY,
  numero           TEXT,
  tipo             TEXT        NOT NULL,        -- MD, SF, DD, LN, LE, DL, RL...
  team_name        TEXT        NOT NULL,
  regional         TEXT,                        -- GUA, CAC
  sector_id        TEXT,                        -- DESG, DESC, DEPT
  session_date     DATE        NOT NULL,        -- data efetiva (sessionBegin do snapshot)
  reason_codes     TEXT[]      DEFAULT '{}',    -- ['0101','0122']
  reason_labels    TEXT[]      DEFAULT '{}',    -- ['Depende projeto', ...]
  rejected_at      TIMESTAMPTZ,                 -- conclusionDate da nota
  classified_at    TIMESTAMPTZ DEFAULT NOW(),
  raw              JSONB                        -- payload completo de Rejection (debug)
);

CREATE INDEX IF NOT EXISTS idx_nr_session_date   ON note_rejections (session_date DESC);
CREATE INDEX IF NOT EXISTS idx_nr_team_date      ON note_rejections (team_name, session_date DESC);
CREATE INDEX IF NOT EXISTS idx_nr_regional_date  ON note_rejections (regional, session_date DESC);
CREATE INDEX IF NOT EXISTS idx_nr_reason_codes   ON note_rejections USING GIN (reason_codes);
CREATE INDEX IF NOT EXISTS idx_nr_tipo           ON note_rejections (tipo);

COMMENT ON TABLE note_rejections IS
  'Cache de motivos canônicos de rejeição (Rejection.RejectionReasons da WPA). '
  'Populado pelo cronService.runClassifyRejections e backfill manual.';
