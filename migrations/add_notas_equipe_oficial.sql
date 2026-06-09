-- Adiciona coluna `equipe_oficial` em notas_snapshots.
-- true  = equipe está no whitelist equipesOficiais (oficialmente Engelmig)
-- false = equipe pertence a uma CompanyId Engelmig mas não está no whitelist
--         (provavelmente nova/recém-criada — a revisar e migrar pra whitelist)
ALTER TABLE notas_snapshots
  ADD COLUMN IF NOT EXISTS equipe_oficial boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_notas_snapshots_oficial
  ON notas_snapshots (equipe_oficial, snapshot_ts DESC);
