-- 014_sessao_intervalo.sql
-- Intervalos e paradas apontados na sessão (P2-15).
--
-- CONTEXTO (22/08/2026). `GET /api/sessions/{sessionId}/break` devolve o que
-- explica POR QUE a equipe está parada: almoço, callback, oficina, aguardando —
-- com quem autorizou a parada. Sem isso o painel não distingue **parada legítima**
-- de **desvio**, e é a base da prevenção ("no ritmo atual não fecha a carteira").
--
-- Nenhum dos três outros projetos da empresa deixou esse dado de fora; nós é que
-- não tínhamos o endpoint.
--
-- ⚠️ A CHAVE INCLUI O HORÁRIO, de propósito. O P2-15 registra o erro a evitar: na
-- tabela equivalente do outro projeto (`rota_dia`) a PK NÃO incluía o horário, e
-- por isso dois eventos do mesmo tipo no mesmo dia colapsavam num registro só —
-- o que anula o propósito da tabela. Uma sessão tem vários intervalos (refeição,
-- callback, oficina), então (session_id, inicio) é o grão correto.
--
-- `fim` NULO é intervalo EM ABERTO — estado de negócio válido, não dado faltando.
-- Uma equipe em intervalo no momento da coleta tem EndTime nulo na API.
--
-- Populada por services/cronService.js (runSyncIntervalos), 1x/dia às 03:10 sobre
-- as sessões de D-1, e sob demanda via POST /api/admin/sync-intervalos?date=.
-- Cadência diária de propósito: é 1 request por SESSÃO (~130/dia). Pendurar no
-- ciclo de 15min custaria ~2.900 requests/dia na conta compartilhada (P1-25).

CREATE TABLE IF NOT EXISTS sessao_intervalo (
  session_id    TEXT        NOT NULL,   -- Sessions/all/date → Data[].Id
  inicio        TIMESTAMPTZ NOT NULL,   -- StartTime — parte da chave, ver acima
  fim           TIMESTAMPTZ,            -- EndTime; NULO = intervalo em aberto
  data          DATE        NOT NULL,   -- dia BRT da sessão, para filtrar rápido
  sector_id     TEXT,
  equipe        TEXT,
  motivo        TEXT,                   -- SessionBreakReason.Text, ex.: '15 - Horário de Refeição'
  responsavel   TEXT,                   -- SessionBreakReason.Responsible — quem autorizou
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, inicio)
);

-- O acesso é "os intervalos deste dia" e "desta equipe no período".
CREATE INDEX IF NOT EXISTS idx_sessao_intervalo_data   ON sessao_intervalo (data);
CREATE INDEX IF NOT EXISTS idx_sessao_intervalo_equipe ON sessao_intervalo (equipe, data);

COMMENT ON TABLE sessao_intervalo IS
  'Intervalos/paradas da sessão (GET /api/sessions/{id}/break). Populada por '
  'cronService.runSyncIntervalos. Base para distinguir parada legítima de desvio '
  '(P2-15).';

COMMENT ON COLUMN sessao_intervalo.inicio IS
  'Parte da PK de propósito: uma sessão tem vários intervalos, e chave sem '
  'horário os colapsaria num registro só — o erro que o P2-15 manda evitar.';

COMMENT ON COLUMN sessao_intervalo.fim IS
  'NULO = intervalo em aberto no momento da coleta. Estado válido, não ausência.';

-- Owner do app. Ver 012, 013 e a seção "Aplicar uma migration" do RUNBOOK.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wpa_app') THEN
    EXECUTE 'ALTER TABLE sessao_intervalo OWNER TO wpa_app';
  END IF;
END $$;
