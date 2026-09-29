-- ===========================================================================
-- Migration: exclusão de usuário (soft)
-- Aplicar em 29/09/2026 — ANTES do git pull do código que lê a coluna
--
-- Pedido do José em 29/09/2026: "vamos adicionar a opção de excluir usuário
-- também". Escolha dele: EXCLUIR = OCULTAR. A linha fica no banco.
--
-- ⚠️ Por que não DELETE: a spec de 21/09 (SPEC-gestao-usuarios §4.1) decidiu
-- "desativar é soft, nunca DELETE". O username aparece na trilha de auditoria e
-- em `criado_por` de outras contas. Um DELETE liberaria o nome para reuso, e aí
-- o histórico do antigo e as ações do novo se confundiriam numa auditoria da
-- EDP. Com a linha mantida, o PRIMARY KEY impede o reuso sozinho.
--
-- ⚠️ ORDEM DE IMPLANTAÇÃO: o código novo SELECIONA `excluido_em`. Sem esta
-- coluna, a leitura de usuários falha — e o login cai para SÓ a conta de
-- emergência. Aplique esta migration primeiro, depois o pull + restart.
--
-- Desfazer uma exclusão é pelo banco, de propósito (não há rota):
--   UPDATE usuarios SET excluido_em = NULL WHERE username = '...';
-- O usuário volta à lista como INATIVO; reativar é pela tela.
-- ===========================================================================

ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS excluido_em timestamptz;

-- A trilha precisa aceitar a ação nova — senão o registrarLog engole a
-- violação do CHECK e a exclusão some da auditoria EM SILÊNCIO (o mesmo furo
-- que o add_senha_provisoria.sql fechou para 'trocar_senha' em 22/09/2026).
ALTER TABLE usuarios_log DROP CONSTRAINT IF EXISTS usuarios_log_acao_check;
ALTER TABLE usuarios_log ADD  CONSTRAINT usuarios_log_acao_check CHECK (
  acao IN ('criar','desativar','reativar','alterar','resetar_senha','trocar_senha','excluir'));

-- ⚠️ OWNER — reafirmação idempotente; ver add_usuarios.sql (faltou em 21/09).
ALTER TABLE usuarios      OWNER TO wpa_app;
ALTER TABLE usuarios_log  OWNER TO wpa_app;
