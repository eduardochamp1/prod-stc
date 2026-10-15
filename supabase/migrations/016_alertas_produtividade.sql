-- 016_alertas_produtividade.sql
-- Alerta de BAIXA PRODUTIVIDADE: registro de cada aviso (1 por equipe por dia).
--
-- CONTEXTO (14/10/2026). José: avisar supervisores/coordenadores quando uma
-- equipe chega à metade do turno com menos de 4 notas executadas. Spec em
-- docs/handoff/SPEC-alerta-produtividade-2026-10-14.md.
--
-- É também o "registro de notificação" que o José pediu: a linha fica para
-- sempre (volume ínfimo: no máximo 1 por equipe por dia). Resolvido = a equipe
-- chegou ao limite depois; a linha continua, com `resolvido_em`.
--
-- IDEMPOTÊNCIA: UNIQUE (data, team_name). O avaliador abre com
-- INSERT ... ON CONFLICT DO NOTHING e depois só ATUALIZA. NÃO usar o upsert do
-- pgShim pra abrir: ele gera DO UPDATE SET nas colunas que não são chave e
-- sobrescreveria `disparado_em` / `executadas_disparo` no 2º ciclo.
--
-- ⚠️ APLICAR ANTES do deploy do código (aprendizado do incidente de 07/10/2026,
-- P0-1d: migration pendente trancou o login). O código com o alerta desligado
-- (`app_settings.alerta_produtividade.ativo = false`) não toca nesta tabela.

CREATE TABLE IF NOT EXISTS alertas_produtividade (
  id                 BIGSERIAL   PRIMARY KEY,
  data               DATE        NOT NULL,        -- dia BRT do disparo
  team_name          TEXT        NOT NULL,
  regional           TEXT        NOT NULL,
  sector_id          TEXT,
  supervisor         TEXT,                        -- vigente NO DIA; NULO = sem supervisor
  limite             INTEGER     NOT NULL,        -- limite em vigor no disparo
  escala_inicio      TEXT,                        -- 'HH:MM' (pro painel mostrar o turno)
  escala_fim         TEXT,
  meio_turno_em      TIMESTAMPTZ NOT NULL,
  executadas_disparo INTEGER     NOT NULL,
  executadas_atual   INTEGER     NOT NULL,        -- atualizada a cada ciclo enquanto aberto
  rejeitadas         INTEGER     NOT NULL DEFAULT 0,
  disparado_em       TIMESTAMPTZ NOT NULL,
  resolvido_em       TIMESTAMPTZ,
  UNIQUE (data, team_name)
);

CREATE INDEX IF NOT EXISTS idx_alertas_produtividade_data
  ON alertas_produtividade (data);

COMMENT ON TABLE alertas_produtividade IS
  'Alerta de baixa produtividade (016): 1 linha por equipe por dia. Spec SPEC-alerta-produtividade-2026-10-14.';
COMMENT ON COLUMN alertas_produtividade.resolvido_em IS
  'Preenchido quando a equipe chega ao limite depois do disparo. Nunca reabre no mesmo dia.';

-- Owner do app. Ver 012, 013, 015 e a seção "Aplicar uma migration" do RUNBOOK.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wpa_app') THEN
    EXECUTE 'ALTER TABLE alertas_produtividade OWNER TO wpa_app';
    EXECUTE 'ALTER SEQUENCE alertas_produtividade_id_seq OWNER TO wpa_app';
  END IF;
END $$;
