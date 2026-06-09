-- Adiciona coluna regional em notas_snapshots e notas_daily_agg.
-- Regional vem do setor da coleta (DESG/DEPT → GUA, DESC → CAC, DSSJ → SJC).
ALTER TABLE notas_snapshots
  ADD COLUMN IF NOT EXISTS regional text;

CREATE INDEX IF NOT EXISTS idx_notas_snapshots_regional_ts
  ON notas_snapshots (regional, snapshot_ts DESC);

-- Em notas_daily_agg precisa fazer parte da PK (data, equipe, regional)
-- pra não colidir caso uma equipe apareça em mais de uma regional ao longo do tempo.
ALTER TABLE notas_daily_agg
  ADD COLUMN IF NOT EXISTS regional text NOT NULL DEFAULT 'GUA';

-- Recria a PK incluindo regional (sem alterar dados existentes — DEFAULT cobre).
ALTER TABLE notas_daily_agg DROP CONSTRAINT IF EXISTS notas_daily_agg_pkey;
ALTER TABLE notas_daily_agg ADD PRIMARY KEY (data, equipe, regional);
