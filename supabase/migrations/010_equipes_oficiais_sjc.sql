-- 010_equipes_oficiais_sjc.sql
-- Adiciona regional SJC (São José dos Campos) e 58 equipes da EDP SP.
--
-- Contexto: Engelmig atende SJC via conta WPA separada da Clarissa (ES).
-- O wpaService foi refatorado pra multi-conta em 08/06/2026 (commit 647588e).
-- Esta migration completa o setup do lado de dados:
--   • Estende o CHECK de regional pra aceitar 'SJC'
--   • Insere as 58 equipes do XLSX 'STC EQUIPES.xlsx' (lista oficial Engelmig SJC)
--
-- Tipos preservados do Excel:
--   L0 — CORTE/RELIGA DISJUNTOR  (ECTSJ — 14 equipes)
--   L1 — Equipe de campo padrão  (ECASJ, ECCSJ, ECLSJ, ECLJA, ECLGM)
--   L3 — Cesta aérea / leitura especial (ECZSJ, ECZGM, ECLSJ98, EPMOL, EPGUE81)
--   A2 — Plantão diurno  (ECMSJ, ECMJA, EPJAC, EPAVP38, EPGUE)
--   A2N — Plantão noturno (EPPTE04, EPAVP37, EPAVP38)
--
-- Como aplicar:
--   1. Painel Supabase (ou psql) → SQL Editor → New query
--   2. Cole e execute
--
-- Idempotente: ON CONFLICT DO UPDATE. Roda 2× sem efeito colateral.

-- ── Estende CHECK de regional pra incluir SJC ────────────────────────────────
ALTER TABLE equipes_oficiais DROP CONSTRAINT IF EXISTS equipes_oficiais_regional_check;
ALTER TABLE equipes_oficiais ADD CONSTRAINT equipes_oficiais_regional_check
  CHECK (regional IN ('GUA', 'CAC', 'SJC'));

-- ── Seed das 58 equipes SJC ──────────────────────────────────────────────────
INSERT INTO equipes_oficiais (sigla, setor, regional, tipo, placa, ativo) VALUES
  -- ECTSJ (Corte/Religa Disjuntor) — 14 equipes — tipo L0
  ('ECTSJ80', 'DSSJ', 'SJC', 'L0',  'TKC5B97', true),
  ('ECTSJ81', 'DSSJ', 'SJC', 'L0',  'GCF4J14', true),
  ('ECTSJ82', 'DSSJ', 'SJC', 'L0',  'SWY1A75', true),
  ('ECTSJ83', 'DSSJ', 'SJC', 'L0',  'FSX-3709', true),
  ('ECTSJ84', 'DSSJ', 'SJC', 'L0',  'BYW4F26', true),
  ('ECTSJ85', 'DSSJ', 'SJC', 'L0',  'FMK6G59', true),
  ('ECTSJ86', 'DSSJ', 'SJC', 'L0',  'FRL5B43', true),
  ('ECTSJ87', 'DSSJ', 'SJC', 'L0',  'FQD0C13', true),
  ('ECTSJ88', 'DSSJ', 'SJC', 'L0',  'TJF7F86', true),
  ('ECTSJ89', 'DSSJ', 'SJC', 'L0',  'GBF0F21', true),
  ('ECTSJ90', 'DSSJ', 'SJC', 'L0',  'TLY0H79', true),
  ('ECTSJ91', 'DSSJ', 'SJC', 'L0',  'GET4E07', true),
  ('ECTSJ92', 'DSSJ', 'SJC', 'L0',  'SSY1E24', true),
  ('ECTSJ93', 'DSSJ', 'SJC', 'L0',  'TLI9J67', true),

  -- ECASJ (2 equipes) — L1
  ('ECASJ84', 'DSSJ', 'SJC', 'L1',  'TIO2G36', true),
  ('ECASJ85', 'DSSJ', 'SJC', 'L1',  'SHU2I06', true),

  -- ECCSJ (7 equipes) — L1
  ('ECCSJ80', 'DSSJ', 'SJC', 'L1',  'TLK3H59', true),
  ('ECCSJ81', 'DSSJ', 'SJC', 'L1',  'SHU2I06', true),  -- placa duplicada no Excel — confirmar
  ('ECCSJ82', 'DSSJ', 'SJC', 'L1',  'SUX7D71', true),
  ('ECCSJ83', 'DSSJ', 'SJC', 'L1',  'SHU2I05', true),
  ('ECCSJ84', 'DSSJ', 'SJC', 'L1',  'SHU2H72', true),
  ('ECCSJ85', 'DSSJ', 'SJC', 'L1',  'SHR8F14', true),
  ('ECCSJ86', 'DSSJ', 'SJC', 'L1',  'SHV0B24', true),

  -- ECLGM (1 equipe) — L1
  ('ECLGM61', 'DSSJ', 'SJC', 'L1',  'TLW3D82', true),

  -- ECLJA (4 equipes) — L1/A2
  ('ECLJA70', 'DSSJ', 'SJC', 'L1',  'SHR8F24', true),
  ('ECLJA71', 'DSSJ', 'SJC', 'L1',  'SHQ6F50', true),
  ('ECLJA72', 'DSSJ', 'SJC', 'L1',  'TCW2D39', true),
  ('ECLJA74', 'DSSJ', 'SJC', 'A2',  'TLW8F93', true),

  -- ECLSJ (17 equipes) — L1/L3/A2
  ('ECLSJ73', 'DSSJ', 'SJC', 'L1',  'SHU2I20', true),
  ('ECLSJ80', 'DSSJ', 'SJC', 'L1',  'SHQ6F44', true),
  ('ECLSJ82', 'DSSJ', 'SJC', 'L1',  'SHR8F36', true),
  ('ECLSJ83', 'DSSJ', 'SJC', 'L1',  'TLZ2I57', true),
  ('ECLSJ84', 'DSSJ', 'SJC', 'L1',  'SHQ6F31', true),
  ('ECLSJ85', 'DSSJ', 'SJC', 'L1',  'SHR8F15', true),
  ('ECLSJ86', 'DSSJ', 'SJC', 'L1',  'SHU2I05', true),
  ('ECLSJ87', 'DSSJ', 'SJC', 'L1',  'SHQ6F30', true),
  ('ECLSJ88', 'DSSJ', 'SJC', 'L1',  'SWN4J56', true),
  ('ECLSJ89', 'DSSJ', 'SJC', 'L1',  'SHR8F32', true),
  ('ECLSJ90', 'DSSJ', 'SJC', 'L1',  'SUJ2E86', true),
  ('ECLSJ91', 'DSSJ', 'SJC', 'A2',  'TLW0F34', true),
  ('ECLSJ92', 'DSSJ', 'SJC', 'L1',  'TCW2D37', true),
  ('ECLSJ94', 'DSSJ', 'SJC', 'L1',  'SHQ6F43', true),
  ('ECLSJ97', 'DSSJ', 'SJC', 'L1',  'SHU2I11', true),
  ('ECLSJ98', 'DSSJ', 'SJC', 'L3',  'SFD0F46', true),

  -- ECZ (Cesta/Leitura — 2 equipes) — L3
  ('ECZGM62', 'DSSJ', 'SJC', 'L3',  'SFD0F45', true),
  ('ECZSJ81', 'DSSJ', 'SJC', 'L3',  'SIG0A71', true),

  -- Plantões metropolitanos (METROPOLITANA / CESTA AEREA — escalas 6X3 noturnas)
  ('EPJAC31', 'DSSJ', 'SJC', 'A2',  'TMF8C24', true),   -- Plantão Jacareí dia 09-18
  ('EPJAC34', 'DSSJ', 'SJC', 'A2',  'SIG0A54', true),   -- Plantão Jacareí tarde 13-22
  ('EPPTE04', 'DSSJ', 'SJC', 'A2N', 'TMF9J74', true),   -- Plantão PTE noturno 21-06
  ('ECMJA70', 'DSSJ', 'SJC', 'A2',  'TMG9B58', true),   -- Manutenção Jacareí 08-17
  ('EPAVP37', 'DSSJ', 'SJC', 'A2N', 'SIG0A64', true),   -- Plantão AVP noturno
  ('EPAVP38', 'DSSJ', 'SJC', 'A2N', 'TMF9F17', true),   -- Plantão AVP noturno
  ('EPAVP39', 'DSSJ', 'SJC', 'A2N', NULL,      true),   -- ADICIONAL (sem placa fixa)
  ('ECMSJ80', 'DSSJ', 'SJC', 'A2',  'TMD0A91', true),   -- Manutenção SJC 08-17
  ('ECMSJ81', 'DSSJ', 'SJC', 'A2',  'TLY2E18', true),   -- Manutenção SJC 08-17
  ('EPMOL30', 'DSSJ', 'SJC', 'L3',  'SIG4C89', true),   -- Cesta aérea Moc... 13-22
  ('EPGUE80', 'DSSJ', 'SJC', 'A2',  'SFE8E65', true),   -- Plantão GUE 07-16
  ('EPGUE81', 'DSSJ', 'SJC', 'L3',  'SFD8E70', true),   -- Cesta aérea GUE 07-16
  ('EPGUE82', 'DSSJ', 'SJC', 'A2',  NULL,      true)    -- Plantão GUE 13-22 (sem placa fixa)
ON CONFLICT (sigla) DO UPDATE SET
  setor    = EXCLUDED.setor,
  regional = EXCLUDED.regional,
  tipo     = EXCLUDED.tipo,
  placa    = EXCLUDED.placa,
  ativo    = EXCLUDED.ativo,
  updated_at = NOW();

-- ── Verificação ──────────────────────────────────────────────────────────────
-- SELECT regional, COUNT(*) FROM equipes_oficiais GROUP BY regional;
-- Esperado:  GUA 40, CAC 35, SJC 58
