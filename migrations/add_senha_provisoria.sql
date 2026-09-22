-- ===========================================================================
-- Migration: marca de senha provisória
-- Aplicar em 22/09/2026
--
-- Incremento 2 da gestão de usuários. Ver
-- docs/handoff/SPEC-troca-senha-2026-09-22.md
--
-- ⚠️ DEFAULT false de propósito: os usuários JÁ MIGRADOS não são forçados a
-- trocar. Eles têm senhas que já usam e conhecem — a senha deles nunca foi
-- gerada pelo sistema, então obrigá-los seria atrito sem motivo.
--
-- A marca nasce `true` só em criação e reset pela tela, onde a senha é uma
-- sequência aleatória de 20 caracteres que ninguém decora.
-- ===========================================================================

ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS senha_provisoria boolean NOT NULL DEFAULT false;

-- A trilha precisa aceitar a ação nova.
--
-- ⚠️ Sem isto, o INSERT na auditoria viola o CHECK — e como o `registrarLog`
-- engole o erro de propósito (pra não derrubar a troca de senha por causa do
-- log), a troca funcionaria e o REGISTRO SUMIRIA EM SILÊNCIO. Numa trilha de
-- acesso, silêncio é o pior defeito possível: seis meses depois ninguém sabe
-- quem trocou a própria senha e quando.
--
-- Pego em 22/09/2026, relendo o código antes de commitar — nenhum teste
-- pegaria, porque o pool fake dos testes não valida CHECK.
ALTER TABLE usuarios_log DROP CONSTRAINT IF EXISTS usuarios_log_acao_check;
ALTER TABLE usuarios_log ADD  CONSTRAINT usuarios_log_acao_check CHECK (
  acao IN ('criar','desativar','reativar','alterar','resetar_senha','trocar_senha'));

-- ⚠️ OWNER — o `psql` da VM entra por peer auth como `usr_jose`, e a aplicação
-- conecta como `wpa_app`. Um ALTER TABLE não muda o dono da tabela, então aqui
-- isto é só reafirmação idempotente — mas fica, porque foi exatamente o que
-- faltou em 21/09 e custou uma rodada de investigação.
ALTER TABLE usuarios      OWNER TO wpa_app;
ALTER TABLE usuarios_log  OWNER TO wpa_app;
