-- 002_note_subcategorias.sql
-- Cria tabela de cache persistente da classificação de subcategorias (MD/SF/DD).
-- Uma linha por UUID. A subcategoria de uma nota nunca muda depois de criada,
-- então classifica uma vez e usa para sempre.
--
-- Origem dos dados (endpoints leves do WPA):
--   MD → /api/notes/md?noteId={uuid}            (~2.6 KB) — Code, CodeText
--      + /api/notepriorities/GetByNoteId/{uuid} (~1.6 KB) — SubProject (TL11/OBSOLETO)
--   SF → /api/notes/sfdl?noteId={uuid}          (~2 KB)   — fallback /sfrl?noteId={uuid}
--   DD → /api/notes/dd?noteId={uuid}            (~1.9 KB) — GroupCode, GroupDescription
--      + /api/Notes/{uuid}/details/optimized   (Activities[].Activity.Code, Amount, IsPrimary)
--
-- Sub_codes canônicos:
--   sub_code   sub_categoria        tipo
--   ─────────────────────────────────────
--   OBSOLETO   Subs Obsoleto        MD
--   TL11       Subs TL11            MD
--   L0         Corte Disjuntor      SF
--   L1         Corte Borne          SF
--   C93        Subs Ramal           DD   (com quantidade)
--   BTZ013     Substituição CS      DD   (com quantidade)
--   OUTROS     {Tipo} Outros        qualquer (fallback)
--
-- Como aplicar:
--   1. Painel Supabase → SQL Editor → New query
--   2. Cole o conteúdo abaixo e execute (Ctrl+Enter)
--   3. Rode `node scripts/backfill-subcategorias.js` para popular a partir dos snapshots

CREATE TABLE IF NOT EXISTS note_subcategorias (
  note_id       UUID        PRIMARY KEY,
  numero        TEXT,
  tipo          TEXT        NOT NULL,            -- MD, SF, DD
  sub_code      TEXT        NOT NULL,            -- OBSOLETO, TL11, L0, L1, C93, BTZ013, OUTROS
  sub_categoria TEXT        NOT NULL,            -- nome bonito p/ UI ("Subs Obsoleto")
  code          TEXT,                            -- Code original WPA (SPEB, CREB, SRED...)
  code_text     TEXT,                            -- CodeText / GroupDescription bruto
  quantidade    NUMERIC,                         -- só DD/C93 e DD/BTZ013 (metros / pontos)
  classified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw           JSONB                            -- payloads brutos p/ debug e re-classificação futura
);

CREATE INDEX IF NOT EXISTS idx_note_subcat_subcode ON note_subcategorias (sub_code);
CREATE INDEX IF NOT EXISTS idx_note_subcat_tipo    ON note_subcategorias (tipo);
