-- 017_saida_nota.sql
-- Aba "Saída da nota" (P2-70): resultado de cada nota concluída × trilha do
-- rastreador. Spec em docs/handoff/SPEC-saida-da-nota-2026-10-18.md.
--
-- CONTEXTO (18/10/2026). José: "quando uma equipe faz o apontamento que está
-- executando uma nota e desloca grandes distâncias enquanto deveria estar
-- executando essa nota". O job noturno (services/saidaNotaJob.js, 04:30 BRT)
-- grava D-1 aqui.
--
-- POR QUE GRAVAR (e para sempre): a trilha vem do banco do gseq, que apaga
-- `vehicle_positions` com 60 dias. Sem esta tabela o número de um mês atrás não
-- se reproduz — e a EDP audita. A coluna `trilha` guarda os pontos da janela de
-- execução para a tela não depender do gseq depois disso.
--
-- IDEMPOTÊNCIA: PK = note_id; o job faz upsert (rodar o mesmo dia de novo
-- substitui). `regra_versao` diz com quais parâmetros a linha foi calculada.
--
-- LGPD: só placa e coordenadas — nunca nome de motorista, CPF ou `Driver`.
--
-- ⚠️ APLICAR ANTES do deploy do código (incidente de 07/10/2026, P0-1d). Sem a
-- tabela, o job registra erro no log e a aba mostra "sem dados" — não derruba nada.

CREATE TABLE IF NOT EXISTS saida_nota (
  note_id                UUID        PRIMARY KEY,
  data                   DATE        NOT NULL,     -- dia BRT do início da execução
  equipe                 TEXT        NOT NULL,
  regional               TEXT        NOT NULL,
  numero                 TEXT,
  tipo                   TEXT,
  status                 TEXT        NOT NULL,     -- SPEC §4
  motivo                 TEXT,                     -- detalhe de sem_janela
  placa                  TEXT,
  placa_fonte            TEXT,                     -- gseq-dia | gseq-vigencia
  inicio                 TIMESTAMPTZ,              -- janela de execução
  fim                    TIMESTAMPTZ,
  ancora_lat             DOUBLE PRECISION,
  ancora_lon             DOUBLE PRECISION,
  ancora_fonte           TEXT,                     -- cadastro | inicio
  dist_max_m             INTEGER,
  min_fora               INTEGER,
  km                     NUMERIC(8,1),
  saidas                 JSONB,                    -- [{inicio, fim, minutos, distMaxM}]
  trilha                 JSONB,                    -- [{t, lat, lon, ign}]
  ponto_max              JSONB,                    -- {lat, lon, t}
  d_veiculo_tablet_m     INTEGER,
  d_cadastro_tablet_m    INTEGER,
  pausa_descontada_min   INTEGER,
  veiculos_junto         TEXT[],                   -- sem_placa/divergente: placas junto do tablet (sugestão, SPEC A7)
  ocorrencia_id          TEXT,                     -- notas da mesma equipe executadas juntas (SPEC A4)
  regra_versao           TEXT        NOT NULL,
  calculado_em           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_saida_nota_data        ON saida_nota (data);
CREATE INDEX IF NOT EXISTS idx_saida_nota_data_status ON saida_nota (data, status);

COMMENT ON TABLE saida_nota IS
  'Saída da nota (017): 1 linha por nota concluída. Spec SPEC-saida-da-nota-2026-10-18.';
COMMENT ON COLUMN saida_nota.trilha IS
  'Pontos do rastreador na janela de execução. O gseq apaga a trilha com 60 dias; esta cópia não.';

-- Owner do app. Ver 012, 013, 015, 016 e a seção "Aplicar uma migration" do RUNBOOK.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wpa_app') THEN
    EXECUTE 'ALTER TABLE saida_nota OWNER TO wpa_app';
  END IF;
END $$;
