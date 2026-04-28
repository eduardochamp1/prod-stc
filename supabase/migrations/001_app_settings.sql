-- 001_app_settings.sql
-- Cria tabela genérica de preferências compartilhadas entre todas as sessões/usuários.
-- Atual uso: persiste filtros do monitor (regional + tipos selecionados).
--
-- Como aplicar:
--   1. Painel Supabase → SQL Editor → New query
--   2. Cole o conteúdo abaixo e execute (Ctrl+Enter)

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT        PRIMARY KEY,
  data       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
