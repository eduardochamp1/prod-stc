-- 006_equipes_oficiais.sql
-- Tabela de equipes oficiais (whitelist) editável via UI Admin.
--
-- A whitelist anterior era hardcoded em services/equipesOficiais.js.
-- Esta tabela permite adicionar/remover/editar equipes sem redeploy.
-- O serviço carrega da tabela com cache de 60s; se Supabase falhar, usa
-- o hardcoded como fallback de segurança.
--
-- Estrutura:
--   sigla    — PK (uppercase, único globalmente; teams_current.team_name é
--              PK lá também, então não pode haver sigla duplicada entre
--              regionais).
--   regional — GUA | CAC
--   tipo     — A1 | A2 | A3 | L1 (categoria do veículo)
--   placa    — placa do veículo (free-form)
--   ativo    — soft delete: equipe inativa fica fora dos cálculos sem
--              precisar deletar a linha (preserva histórico de quem foi
--              oficial em determinado período).
--
-- Como aplicar:
--   1. Painel Supabase → SQL Editor → New query
--   2. Cole este arquivo e execute (Ctrl+Enter)

CREATE TABLE IF NOT EXISTS equipes_oficiais (
  sigla       TEXT        PRIMARY KEY,
  regional    TEXT        NOT NULL CHECK (regional IN ('GUA', 'CAC')),
  tipo        TEXT        NOT NULL,
  placa       TEXT        NOT NULL,
  ativo       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_equipes_oficiais_regional ON equipes_oficiais (regional);
CREATE INDEX IF NOT EXISTS idx_equipes_oficiais_ativo    ON equipes_oficiais (ativo);

-- ── SEED INICIAL ──────────────────────────────────────────────────────────────
-- 60 equipes (31 GUA + 29 CAC). Idempotente via ON CONFLICT.

INSERT INTO equipes_oficiais (sigla, regional, tipo, placa) VALUES
  -- GUARAPARI (31)
  ('EBGPR62', 'GUA', 'A2', 'QMS9I79'),
  ('EBGPR63', 'GUA', 'A3', 'SFE8E68'),
  ('EBGPR64', 'GUA', 'A3', 'QUS4128'),
  ('EBGPR65', 'GUA', 'A3', 'TGX0G99'),
  ('ECACH50', 'GUA', 'A1', 'SIG1A15'),
  ('ECANC50', 'GUA', 'L1', 'TDY1C60'),
  ('ECGPR51', 'GUA', 'L1', 'SHQ6F47'),
  ('ECGPR53', 'GUA', 'L1', 'SH6F39'),
  ('ECGPR54', 'GUA', 'L1', 'SHU2I02'),
  ('ECGPR81', 'GUA', 'L1', 'SHQ6F41'),
  ('ECGPR82', 'GUA', 'L1', 'SHU2H93'),
  ('ECGPR90', 'GUA', 'L1', 'TDY1C70'),
  ('ECGPR91', 'GUA', 'L1', 'TDY1C67'),
  ('ECMRT50', 'GUA', 'L1', 'TDY1C69'),
  ('ECMRT51', 'GUA', 'A2', 'SIH0G13'),
  ('ECMRT80', 'GUA', 'L1', 'TDY1C68'),
  ('ECPIU50', 'GUA', 'A1', 'SIG0A67'),
  ('ECPIU90', 'GUA', 'L1', 'TDY1C66'),
  ('ECPKE50', 'GUA', 'A1', 'RVW0D45'),
  ('EPACH30', 'GUA', 'A1', 'SIG0A46'),
  ('EPANC30', 'GUA', 'A1', 'RMP2F33'),
  ('EPGPR30', 'GUA', 'A1', 'SIG0A73'),
  ('EPGPR31', 'GUA', 'A1', 'SIG4C84'),
  ('EPGPR32', 'GUA', 'A3', 'SFD0F41'),
  ('EPGPR33', 'GUA', 'A1', 'SIF8B17'),
  ('EPICO30', 'GUA', 'A1', 'SNH8G77'),
  ('EPMRT30', 'GUA', 'A2', 'SIH0G17'),
  ('EPMRT31', 'GUA', 'A3', 'SFD0F63'),
  ('EPMRT32', 'GUA', 'A1', 'SIG4C86'),
  ('EPPIU30', 'GUA', 'A3', 'SFD0F63'),
  ('EPPIU31', 'GUA', 'A1', 'SIG0A63'),
  -- CACHOEIRO (29)
  ('EPCIT30', 'CAC', 'A1', 'RVW0D46'),
  ('EPCIT31', 'CAC', 'A1', 'RVW0D53'),
  ('EPCIT32', 'CAC', 'A2', 'SIG4C88'),
  ('EPVGA30', 'CAC', 'A1', 'SIA6D14'),
  ('EPRNS30', 'CAC', 'A1', 'SIG4C92'),
  ('EPVGA31', 'CAC', 'A1', 'SIG0A56'),
  ('EPALE30', 'CAC', 'A1', 'SIG4C91'),
  ('EPALE31', 'CAC', 'A1', 'SIF8B13'),
  ('EPGUI30', 'CAC', 'A1', 'SIH0G14'),
  ('EPGUI31', 'CAC', 'A1', 'SIG0A40'),
  ('EPMUQ30', 'CAC', 'A1', 'SIG0A62'),
  ('EPMSU31', 'CAC', 'A1', 'SIH0G16'),
  ('EPBJE31', 'CAC', 'A1', 'SIG4C85'),
  ('ECCIT50', 'CAC', 'L1', 'TDY1C64'),
  ('ECCIT51', 'CAC', 'L1', 'TDY1C71'),
  ('ECCIT53', 'CAC', 'L1', 'TDY1C61'),
  ('ECCIT55', 'CAC', 'L1', 'TDY1C73'),
  ('ECCIT56', 'CAC', 'L1', 'TDY1C62'),
  ('ECCIT70', 'CAC', 'A2', 'SIG4C88'),
  ('ECCIT80', 'CAC', 'A1', 'RVW7J53'),
  ('ECCIT81', 'CAC', 'A1', 'SIG0A48'),
  ('ECALE80', 'CAC', 'A1', 'SFD0F53'),
  ('ECGUI80', 'CAC', 'L1', 'TDY1C72'),
  ('ECCIT90', 'CAC', 'L1', 'TDY1C65'),
  ('ECVGA50', 'CAC', 'A2', 'SIH0G15'),
  ('ECALE50', 'CAC', 'L1', 'SHQ6F37'),
  ('ECMSU50', 'CAC', 'A1', 'SIG0A48'),
  ('ECGUI50', 'CAC', 'A2', 'SIF8B11'),
  ('ECBJE50', 'CAC', 'A1', 'SIG0A72')
ON CONFLICT (sigla) DO NOTHING;
