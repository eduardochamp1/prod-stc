-- 011_team_daily_carteira.sql
-- Aproveitamento de carteira POR EQUIPE, consolidado por dia.
--
-- CONTEXTO (P2-7, 22/07/2026): esta tabela existia em produção mas NÃO tinha
-- CREATE TABLE em nenhum .sql do repo — era escrita por
-- services/dataWriter.js (upsertTeamDailyCarteira, onConflict date,team_name),
-- lida por routes/index.js (GET /api/carteira/equipes) e populada
-- retroativamente por scripts/backfill-carteira.js. Este arquivo versiona o
-- schema REAL (extraído de db/schema-atual.sql via pg_dump da VM), pra que um
-- ambiente novo / DR consiga recriá-la. Ver db/README.md.
--
-- Semântica (mesma matemática de _buildDiaSummary, mas por equipe): cada UUID
-- do dia cai em EXATAMENTE 1 bucket, prioridade
--   rejeitada > concluída > andamento > atual (> cancelada p/ quem sumiu).
-- Invariante por linha:
--   carteira_inicial + entradas_novas
--     = atual + andamento + concluidas + rejeitadas + canceladas
-- Sem dedup cross-team: nota transferida conta na carteira de ambas as equipes
-- (é visão de produtividade individual, não de estoque global).

CREATE TABLE IF NOT EXISTS team_daily_carteira (
  date              DATE        NOT NULL,
  team_name         TEXT        NOT NULL,
  regional          TEXT,
  carteira_inicial  INTEGER     NOT NULL DEFAULT 0,   -- UUIDs vistos no 1º snapshot do dia
  entradas_novas    INTEGER     NOT NULL DEFAULT 0,   -- apareceram depois do 1º snapshot
  atual             INTEGER     NOT NULL DEFAULT 0,   -- ainda baixadas (não trabalhadas)
  andamento         INTEGER     NOT NULL DEFAULT 0,   -- em execução no último snapshot
  concluidas        INTEGER     NOT NULL DEFAULT 0,   -- executadas de fato (não rejeitadas)
  rejeitadas        INTEGER     NOT NULL DEFAULT 0,   -- rejeitadas pela EDP (via note_rejections)
  canceladas        INTEGER     NOT NULL DEFAULT 0,   -- sumiram da carteira (transferidas/canceladas)
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (date, team_name)
);

-- Filtro por regional + range de datas é o caminho quente do endpoint.
CREATE INDEX IF NOT EXISTS idx_tdc_regional ON team_daily_carteira (regional, date);

COMMENT ON TABLE team_daily_carteira IS
  'Aproveitamento de carteira por equipe/dia. Populada por '
  'dataWriter.upsertTeamDailyCarteira (cron) e scripts/backfill-carteira.js. '
  'Schema versionado retroativamente no P2-7 (era órfã no repo).';
