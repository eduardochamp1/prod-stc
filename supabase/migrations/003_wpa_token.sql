-- 003_wpa_token.sql
-- Cache compartilhado do token JWT do WPA Auth entre containers/processos.
--
-- Problema que resolve:
--   O App Service do WPA Auth (edp-wpa-po.azurewebsites.net) hiberna no Azure
--   e responde 403 com HTML "Web App - Unavailable" durante cold-starts. O
--   VPS rpa1 (cron de snapshots) mantém o WPA quente, mas o Vercel deploy
--   tem cold-starts esporádicos — cada Lambda novo faz seu próprio login,
--   que pega o WPA frio e falha mesmo com retry de backoff (~7s não basta).
--
-- Solução:
--   Singleton de token JWT compartilhado. O cron rpa1 (que sempre roda)
--   grava token novo após cada login bem-sucedido. Lambdas Vercel leem dessa
--   tabela antes de tentar login próprio — só entram no caminho de login
--   se a tabela estiver vazia OU expirada.
--
-- Chave fixa 'wpa' permite UPSERT sem precisar de UUID/sequence — uma linha
-- só. (Caso futuro de múltiplos clients/credenciais, key vira o discriminador.)
--
-- Como aplicar:
--   1. Painel Supabase → SQL Editor → New query
--   2. Cole e execute (Ctrl+Enter)

CREATE TABLE IF NOT EXISTS wpa_token (
  key         TEXT        PRIMARY KEY,        -- discriminador (atualmente 'wpa')
  token       TEXT        NOT NULL,           -- JWT bruto
  expires_at  TIMESTAMPTZ NOT NULL,           -- quando o JWT expira (do claim 'exp')
  user_id     TEXT,                           -- UserId que veio no /signin (debug)
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wpa_token_expires ON wpa_token (expires_at);
