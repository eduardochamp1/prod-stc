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

-- ⚠️ OWNER — acrescentado em 22/09/2026, retroativamente.
--
-- Estas tabelas funcionam em produção, o que significa que o dono foi ajustado
-- à mão na época e nunca voltou pro arquivo. Sem estas linhas, a migration não
-- é REPLAYABLE: aplicada num banco novo (recuperação de desastre, P0-2), a
-- aplicação levantaria "permission denied" e ninguém saberia por quê.
--
-- O `psql` da VM entra por peer auth como `usr_jose`, então a tabela nasce
-- dele; a aplicação conecta como `wpa_app`, que é outro papel e não herda nada.
-- Foi exatamente o que aconteceu com o add_usuarios.sql em 21/09/2026.
--
-- `ALTER ... OWNER TO` é idempotente: rodar de novo não faz mal.
ALTER TABLE notas_snapshots OWNER TO wpa_app;
ALTER TABLE notas_daily_agg OWNER TO wpa_app;
