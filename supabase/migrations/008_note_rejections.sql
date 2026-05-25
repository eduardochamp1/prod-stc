-- 008_note_rejections.sql
-- Tabela de detalhes das notas rejeitadas com motivos categorizados.
--
-- Cada nota rejeitada no WPA tem na UI uma seção "Detalhes da Rejeição" com:
--   - Data da rejeição
--   - Observação (texto livre do operador)
--   - Motivos (lista de códigos categorizados, ex: "0101 - Depende de projeto elétrico",
--             "0031 - Outros motivos-resp. cliente") — uma rejeição pode ter 1+ motivos
--   - Formulário (ex: "Vistoria de Entrada e Serviço")
--
-- O cron coleta esses detalhes via WPA API após detectar nova rejeição nos snapshots.
-- Colaboradores vêm via cruzamento com sessions (todos os colab que atuaram naquela sessão
-- recebem 1 ponto cada — política B(a) acordada com a área de negócio).
--
-- Como aplicar:
--   1. Painel Supabase → SQL Editor → New query
--   2. Cole o conteúdo abaixo e execute (Ctrl+Enter)
--   3. Rode `node scripts/backfill-rejections.js` para popular histórico
--   4. Daí em diante, o cron incremental mantém atualizado

CREATE TABLE IF NOT EXISTS note_rejections (
  note_id            UUID         PRIMARY KEY,
  numero             TEXT,                              -- código humano (ex: '045006313164')
  tipo               TEXT         NOT NULL,             -- MD, SF, DD, LE, LN, etc
  team_name          TEXT         NOT NULL,
  regional           TEXT         NOT NULL,             -- GUA | CAC
  sector_id          TEXT,
  rejection_date     TIMESTAMPTZ,                       -- data/hora real da rejeição (do WPA)
  session_date       DATE         NOT NULL,             -- atribuição por sessionDate (regra do projeto)
  observacao         TEXT,                              -- texto livre do operador
  motivo_codes       TEXT[]       NOT NULL DEFAULT '{}',-- ['0101','0031'] — códigos categorizados
  motivo_textos      TEXT[]       NOT NULL DEFAULT '{}',-- ['Depende de projeto elétrico', ...]
  formulario         TEXT,                              -- ex: 'Vistoria de Entrada e Serviço'
  collaborator_codes TEXT[]       NOT NULL DEFAULT '{}',-- matrículas dos colab da sessão
  collaborator_names TEXT[]       NOT NULL DEFAULT '{}',-- nomes (denormalizado p/ UI rápida)
  raw                JSONB,                             -- payload bruto pra debug
  fetched_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Índices p/ queries da aba Rejeições
CREATE INDEX IF NOT EXISTS idx_rej_session_date    ON note_rejections (session_date);
CREATE INDEX IF NOT EXISTS idx_rej_team_date       ON note_rejections (team_name, session_date);
CREATE INDEX IF NOT EXISTS idx_rej_regional_date   ON note_rejections (regional, session_date);
CREATE INDEX IF NOT EXISTS idx_rej_tipo            ON note_rejections (tipo);

-- Índice GIN p/ buscas em arrays (top motivos, filtro por motivo, etc)
CREATE INDEX IF NOT EXISTS idx_rej_motivo_codes    ON note_rejections USING gin (motivo_codes);
CREATE INDEX IF NOT EXISTS idx_rej_collab_codes    ON note_rejections USING gin (collaborator_codes);
