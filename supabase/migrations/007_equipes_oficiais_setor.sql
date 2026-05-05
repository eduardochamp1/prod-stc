-- 007_equipes_oficiais_setor.sql
-- Atualiza whitelist de equipes oficiais para a versão maio/2026:
--   • Adiciona coluna `setor` (DESG/DEPT/DESC) — granularidade que faltava
--   • Torna `placa` opcional (nem toda lista operacional inclui placa)
--   • Substitui CHECK rígido de `tipo` (A1/A2/A3/L1) por VARCHAR livre —
--     novos tipos operacionais: BTZERO, CS, COMERCIAL, CORTE L0, CORTE L1,
--     MD, MD E RAMAL, PLANTÃO, RAMAL, USO MUTUO
--   • Wipe + reseed com 75 equipes (40 DESG + 35 DESC)
--
-- Como aplicar:
--   1. Painel Supabase → SQL Editor → New query
--   2. Cole e execute (Ctrl+Enter)
--
-- Idempotente: pode rodar duas vezes sem efeito colateral (TRUNCATE +
-- INSERT recria do zero). Não usar em DB com dados manuais não-seed.

-- ── Schema changes ───────────────────────────────────────────────────────────
ALTER TABLE equipes_oficiais ADD COLUMN IF NOT EXISTS setor TEXT;
ALTER TABLE equipes_oficiais ALTER COLUMN placa DROP NOT NULL;

-- Remove CHECK antigo de regional (manter check, só atualiza para garantir)
ALTER TABLE equipes_oficiais DROP CONSTRAINT IF EXISTS equipes_oficiais_regional_check;
ALTER TABLE equipes_oficiais ADD CONSTRAINT equipes_oficiais_regional_check
  CHECK (regional IN ('GUA', 'CAC'));

-- ── Wipe + reseed ────────────────────────────────────────────────────────────
TRUNCATE TABLE equipes_oficiais;

INSERT INTO equipes_oficiais (sigla, setor, regional, tipo, ativo) VALUES
  -- DESG / GUA (40 equipes) ───────────────────────────────────────────────────
  ('EBGPR62', 'DESG', 'GUA', 'BTZERO',     true),
  ('EBGPR63', 'DESG', 'GUA', 'BTZERO',     true),
  ('EBGPR64', 'DESG', 'GUA', 'CS',         true),
  ('EBGPR65', 'DESG', 'GUA', 'BTZERO',     true),
  ('ECACH50', 'DESG', 'GUA', 'COMERCIAL',  true),
  ('ECANC50', 'DESG', 'GUA', 'COMERCIAL',  true),
  ('ECGPR51', 'DESG', 'GUA', 'COMERCIAL',  true),
  ('ECGPR53', 'DESG', 'GUA', 'COMERCIAL',  true),
  ('ECGPR54', 'DESG', 'GUA', 'COMERCIAL',  true),
  ('ECMRT50', 'DESG', 'GUA', 'COMERCIAL',  true),
  ('ECMRT51', 'DESG', 'GUA', 'COMERCIAL',  true),
  ('ECPIU50', 'DESG', 'GUA', 'COMERCIAL',  true),
  ('ECPKE50', 'DESG', 'GUA', 'COMERCIAL',  true),
  ('ETGPR15', 'DESG', 'GUA', 'CORTE L0',   true),
  ('ETGPR16', 'DESG', 'GUA', 'CORTE L0',   true),
  ('ETGPR17', 'DESG', 'GUA', 'CORTE L0',   true),
  ('ETGPR18', 'DESG', 'GUA', 'CORTE L0',   true),
  ('ETGPR19', 'DESG', 'GUA', 'CORTE L0',   true),
  ('ETMRT15', 'DESG', 'GUA', 'CORTE L0',   true),
  ('ETMRT16', 'DESG', 'GUA', 'CORTE L0',   true),
  ('ETPIU15', 'DESG', 'GUA', 'CORTE L0',   true),
  ('ETPKE15', 'DESG', 'GUA', 'CORTE L0',   true),
  ('ECGPR90', 'DESG', 'GUA', 'CORTE L1',   true),
  ('ECGPR91', 'DESG', 'GUA', 'CORTE L1',   true),
  ('ECPIU90', 'DESG', 'GUA', 'CORTE L1',   true),
  ('ECGPR82', 'DESG', 'GUA', 'MD',         true),
  ('EPACH30', 'DESG', 'GUA', 'PLANTÃO',    true),
  ('EPANC30', 'DESG', 'GUA', 'PLANTÃO',    true),
  ('EPGPR30', 'DESG', 'GUA', 'PLANTÃO',    true),
  ('EPGPR31', 'DESG', 'GUA', 'PLANTÃO',    true),
  ('EPGPR32', 'DESG', 'GUA', 'PLANTÃO',    true),
  ('EPGPR33', 'DESG', 'GUA', 'PLANTÃO',    true),
  ('EPICO30', 'DESG', 'GUA', 'PLANTÃO',    true),
  ('EPMRT30', 'DESG', 'GUA', 'PLANTÃO',    true),
  ('EPMRT31', 'DESG', 'GUA', 'PLANTÃO',    true),
  ('EPMRT32', 'DESG', 'GUA', 'PLANTÃO',    true),
  ('EPPIU30', 'DESG', 'GUA', 'PLANTÃO',    true),
  ('EPPIU31', 'DESG', 'GUA', 'PLANTÃO',    true),
  ('ECGPR81', 'DESG', 'GUA', 'RAMAL',      true),
  ('ECMRT80', 'DESG', 'GUA', 'RAMAL',      true),

  -- DESC / CAC (35 equipes) ───────────────────────────────────────────────────
  ('ECALE50', 'DESC', 'CAC', 'COMERCIAL',  true),
  ('ECBJE50', 'DESC', 'CAC', 'COMERCIAL',  true),
  ('ECCIT50', 'DESC', 'CAC', 'COMERCIAL',  true),
  ('ECCIT51', 'DESC', 'CAC', 'COMERCIAL',  true),
  ('ECCIT53', 'DESC', 'CAC', 'COMERCIAL',  true),
  ('ECCIT55', 'DESC', 'CAC', 'COMERCIAL',  true),
  ('ECCIT56', 'DESC', 'CAC', 'COMERCIAL',  true),
  ('ECGUI50', 'DESC', 'CAC', 'COMERCIAL',  true),
  ('ECMSU50', 'DESC', 'CAC', 'COMERCIAL',  true),
  ('ECVGA50', 'DESC', 'CAC', 'COMERCIAL',  true),
  ('ETALE15', 'DESC', 'CAC', 'CORTE L0',   true),
  ('ETCIT15', 'DESC', 'CAC', 'CORTE L0',   true),
  ('ETCIT16', 'DESC', 'CAC', 'CORTE L0',   true),
  ('ETCIT17', 'DESC', 'CAC', 'CORTE L0',   true),
  ('ETCIT18', 'DESC', 'CAC', 'CORTE L0',   true),
  ('ECCIT90', 'DESC', 'CAC', 'CORTE L1',   true),
  ('ECALE80', 'DESC', 'CAC', 'MD E RAMAL', true),
  ('ECCIT80', 'DESC', 'CAC', 'MD E RAMAL', true),
  ('ECCIT81', 'DESC', 'CAC', 'MD E RAMAL', true),
  ('ECGUI80', 'DESC', 'CAC', 'MD E RAMAL', true),
  ('EPALE30', 'DESC', 'CAC', 'PLANTÃO',    true),
  ('EPALE31', 'DESC', 'CAC', 'PLANTÃO',    true),
  ('EPBJE31', 'DESC', 'CAC', 'PLANTÃO',    true),
  ('EPCIT30', 'DESC', 'CAC', 'PLANTÃO',    true),
  ('EPCIT31', 'DESC', 'CAC', 'PLANTÃO',    true),
  ('EPCIT32', 'DESC', 'CAC', 'PLANTÃO',    true),
  ('EPCIT33', 'DESC', 'CAC', 'PLANTÃO',    true),
  ('EPGUI30', 'DESC', 'CAC', 'PLANTÃO',    true),
  ('EPGUI31', 'DESC', 'CAC', 'PLANTÃO',    true),
  ('EPMSU31', 'DESC', 'CAC', 'PLANTÃO',    true),
  ('EPMUQ30', 'DESC', 'CAC', 'PLANTÃO',    true),
  ('EPRNS30', 'DESC', 'CAC', 'PLANTÃO',    true),
  ('EPVGA30', 'DESC', 'CAC', 'PLANTÃO',    true),
  ('EPVGA31', 'DESC', 'CAC', 'PLANTÃO',    true),
  ('ECCIT70', 'DESC', 'CAC', 'USO MUTUO',  true);

-- ── Constraint pós-seed ──────────────────────────────────────────────────────
ALTER TABLE equipes_oficiais ALTER COLUMN setor SET NOT NULL;
ALTER TABLE equipes_oficiais DROP CONSTRAINT IF EXISTS equipes_oficiais_setor_check;
ALTER TABLE equipes_oficiais ADD CONSTRAINT equipes_oficiais_setor_check
  CHECK (setor IN ('DESG', 'DEPT', 'DESC'));

CREATE INDEX IF NOT EXISTS idx_equipes_oficiais_setor ON equipes_oficiais (setor);
