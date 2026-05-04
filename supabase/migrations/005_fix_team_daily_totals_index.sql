-- 005_fix_team_daily_totals_index.sql
-- Corrige ordem do índice composto em team_daily_totals.
-- O índice antigo (date, regional) não atende bem a queries que filtram
-- por regional fixa em um range de datas (forma mais comum: aba Gráficos
-- e Ranking). A ordem (regional, date) permite ao Postgres usar o índice
-- como prefixo direto.
--
-- Mantém o índice antigo se existir (DROP IF EXISTS é seguro), recria
-- com a ordem correta. Idempotente.

DROP INDEX IF EXISTS idx_team_daily_totals_regional;

CREATE INDEX IF NOT EXISTS idx_team_daily_totals_regional_date
  ON team_daily_totals (regional, date);

-- Idem para team_daily_subcat_totals (já está em (regional, date), mas
-- garantimos consistência caso tenha sido criado com ordem errada
-- em algum ambiente).
DROP INDEX IF EXISTS idx_team_daily_subcat_regional;

CREATE INDEX IF NOT EXISTS idx_team_daily_subcat_regional_date
  ON team_daily_subcat_totals (regional, date);
