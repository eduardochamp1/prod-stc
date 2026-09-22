-- ===========================================================================
-- Migration: tabelas de usuários do painel
-- Aplicar em 21/09/2026
--
-- Tira os usuários do AUTH_USERS do .env e põe no banco, pra conceder e
-- retirar acesso pela tela em vez de por SSH. Ver
-- docs/handoff/SPEC-gestao-usuarios-2026-09-21.md
--
-- ⚠️ Esta migration NÃO migra os dados. Ela cria as tabelas VAZIAS, e o
-- comportamento do login segue idêntico ao de hoje (o getUsers une banco +
-- .env; com a tabela vazia, só o .env responde). A migração dos dados é o
-- scripts/migrar-usuarios.js, rodado depois e conferido com --dry-run.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS usuarios (
  username        text PRIMARY KEY,
  senha_hash      text        NOT NULL,
  role            text        NOT NULL DEFAULT 'user',
  -- Mesmo formato do .env ('GUA|CAC'), de propósito: reusa o parser e as
  -- validações que já existem no auth.js, inclusive as que recusam 'ALL' e
  -- grupos como 'ES'. Um formato novo seria um segundo parser.
  regionals       text        NOT NULL,
  ativo           boolean     NOT NULL DEFAULT true,
  -- A permissão de CONCEDER acesso. Separada de role='admin' de propósito:
  -- admin abre o /admin inteiro; esta diz quem mexe em quem entra.
  pode_gerenciar  boolean     NOT NULL DEFAULT false,
  criado_em       timestamptz NOT NULL DEFAULT now(),
  criado_por      text,
  atualizado_em   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usuarios_role_check      CHECK (role IN ('admin', 'user')),
  CONSTRAINT usuarios_username_check  CHECK (username ~ '^[a-z0-9_]{3,32}$')
);

-- Trilha de auditoria. SÓ escrita e leitura — não há rota de edição nem de
-- exclusão. Acesso concedido e retirado é o tipo de coisa que alguém pergunta
-- seis meses depois, e "acho que fui eu" não é resposta num contrato auditado.
CREATE TABLE IF NOT EXISTS usuarios_log (
  id       bigserial   PRIMARY KEY,
  ts       timestamptz NOT NULL DEFAULT now(),
  ator     text        NOT NULL,
  acao     text        NOT NULL,
  alvo     text        NOT NULL,
  -- NUNCA contém senha nem hash.
  detalhe  jsonb,
  CONSTRAINT usuarios_log_acao_check CHECK (
    acao IN ('criar','desativar','reativar','alterar','resetar_senha'))
);

CREATE INDEX IF NOT EXISTS usuarios_log_ts_idx   ON usuarios_log (ts DESC);
CREATE INDEX IF NOT EXISTS usuarios_log_alvo_idx ON usuarios_log (alvo, ts DESC);

-- ⚠️ OWNER — sem isto, a aplicação levanta "permission denied for table
-- usuarios" e o script de migração para antes de começar.
--
-- O `psql -d wpa_monitor` da VM entra por peer auth como `usr_jose`, então a
-- tabela nasce dele. A aplicação conecta como `wpa_app` (via DATABASE_URL do
-- .env), que é outro papel e não herda nada.
--
-- Aconteceu de verdade em 21/09/2026, com esta migration: as tabelas foram
-- criadas, e o migrar-usuarios.js recusou na primeira linha.
--
-- `ALTER ... OWNER TO` é idempotente: rodar de novo não faz mal.
ALTER TABLE    usuarios            OWNER TO wpa_app;
ALTER TABLE    usuarios_log        OWNER TO wpa_app;
ALTER SEQUENCE usuarios_log_id_seq OWNER TO wpa_app;
