-- notas_snapshots: 1 linha por (snapshot, nota) ainda no backlog naquele instante.
-- Retenção: 30 dias (limpeza no job).
CREATE TABLE IF NOT EXISTS notas_snapshots (
  snapshot_ts        timestamptz NOT NULL,
  nota_number        text        NOT NULL,
  nota_id            uuid,
  tipo               text,
  equipe             text        NOT NULL,
  status             integer,
  conclusion_date    timestamptz,
  conclusion_status  text,
  sap_message        text,
  PRIMARY KEY (snapshot_ts, nota_number)
);

CREATE INDEX IF NOT EXISTS idx_notas_snapshots_number
  ON notas_snapshots (nota_number);
CREATE INDEX IF NOT EXISTS idx_notas_snapshots_equipe_ts
  ON notas_snapshots (equipe, snapshot_ts DESC);

-- notas_daily_agg: agregado por (dia, equipe). Sem retenção.
CREATE TABLE IF NOT EXISTS notas_daily_agg (
  data                     date NOT NULL,
  equipe                   text NOT NULL,
  pendentes_fim_dia        integer NOT NULL DEFAULT 0,
  entraram_no_dia          integer NOT NULL DEFAULT 0,
  sairam_no_dia            integer NOT NULL DEFAULT 0,
  idade_mais_antiga_dias   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (data, equipe)
);

CREATE INDEX IF NOT EXISTS idx_notas_daily_agg_data
  ON notas_daily_agg (data DESC);
