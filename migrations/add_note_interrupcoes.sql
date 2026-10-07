-- ===========================================================================
-- Migration: note_interrupcoes — interrupções de notas MD
-- Criada em 07/10/2026. Pode ser aplicada ANTES ou DEPOIS do git pull: sem a
-- tabela, a coleta só avisa no log (interrupcoes_sem_tabela) e a matriz mostra
-- a coluna INTERR vazia ("—"). Nada quebra.
--
-- Pedido do José em 07/10/2026: coluna de interrupções no grupo MD da matriz
-- "Notas Atendidas por Tipo", só Subs Obsoleto e Subs TL11. Conta no dia da
-- interrupção, na equipe que interrompeu; não é produção (fora da SOMA).
-- Fonte: GET /api/Notes/{id}/completeInterruptions (services/interrupcaoService.js).
--
-- 1 linha = 1 interrupção (Id da EDP). Uma nota interrompida em 28/09 e de
-- novo em 07/10 tem 2 linhas. O upsert por interrupcao_id torna a coleta
-- idempotente — reprocessar não duplica.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS note_interrupcoes (
  interrupcao_id  text PRIMARY KEY,
  note_id         uuid NOT NULL,
  numero          text,
  tipo            text NOT NULL,
  team_name       text NOT NULL,     -- equipe que INTERROMPEU (TeamName da EDP)
  regional        text,
  sector_id       text,
  dia             date NOT NULL,     -- dia BRT da interrupção
  instante        timestamptz,
  motivo          text,
  observacao      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_note_interrupcoes_dia      ON note_interrupcoes (dia);
CREATE INDEX IF NOT EXISTS idx_note_interrupcoes_note_id  ON note_interrupcoes (note_id);

-- ⚠️ OWNER — tabela nova precisa ser do wpa_app, senão o app não grava.
ALTER TABLE note_interrupcoes OWNER TO wpa_app;
