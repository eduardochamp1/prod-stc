-- ===========================================================================
-- Migration: adicionar colunas de escala em equipes_oficiais
-- Aplica em 22/05/2026
--
-- Adiciona escala_inicio e escala_fim (TIME). Popula defaults por turno de 9h
-- baseado no segundo caractere da sigla (C/T/P/B/V). Usuário pode ajustar
-- depois via Admin → Equipes.
-- ===========================================================================

ALTER TABLE equipes_oficiais
  ADD COLUMN IF NOT EXISTS escala_inicio TIME,
  ADD COLUMN IF NOT EXISTS escala_fim    TIME;

-- Comercial (ECxxx) → 08:00 – 17:00
UPDATE equipes_oficiais
   SET escala_inicio = '08:00'::TIME,
       escala_fim    = '17:00'::TIME
 WHERE sigla LIKE 'EC%'
   AND escala_inicio IS NULL;

-- Turma (ETxxx) → 07:00 – 16:00
UPDATE equipes_oficiais
   SET escala_inicio = '07:00'::TIME,
       escala_fim    = '16:00'::TIME
 WHERE sigla LIKE 'ET%'
   AND escala_inicio IS NULL;

-- Plantão (EPxxx) → 14:00 – 23:00 (turno tarde)
UPDATE equipes_oficiais
   SET escala_inicio = '14:00'::TIME,
       escala_fim    = '23:00'::TIME
 WHERE sigla LIKE 'EP%'
   AND escala_inicio IS NULL;

-- BTZero (EBxxx) → 07:00 – 16:00
UPDATE equipes_oficiais
   SET escala_inicio = '07:00'::TIME,
       escala_fim    = '16:00'::TIME
 WHERE sigla LIKE 'EB%'
   AND escala_inicio IS NULL;

-- Vigilância (EVxxx) e qualquer outro → 07:00 – 16:00
UPDATE equipes_oficiais
   SET escala_inicio = '07:00'::TIME,
       escala_fim    = '16:00'::TIME
 WHERE escala_inicio IS NULL;

-- Verifica resultado
SELECT
  CASE LEFT(sigla, 2)
    WHEN 'EC' THEN 'EC (Comercial)'
    WHEN 'ET' THEN 'ET (Turma)'
    WHEN 'EP' THEN 'EP (Plantão)'
    WHEN 'EB' THEN 'EB (BTZero)'
    WHEN 'EV' THEN 'EV (Vigilância)'
    ELSE 'Outros'
  END AS grupo,
  COUNT(*) AS qtd,
  escala_inicio,
  escala_fim
FROM equipes_oficiais
WHERE ativo = true
GROUP BY 1, escala_inicio, escala_fim
ORDER BY 1;
