# docs/handoff — Documentação de continuidade

Objetivo: qualquer AI/dev/pessoa da TI entrar neste repo e conseguir operar
sem depender do conhecimento tácito do José Zouain.

## Por onde começar

**Se você é AI/LLM:** leia primeiro [`CLAUDE.md`](../../CLAUDE.md) na raiz —
tem as rules of engagement.

**Se você é humano:** este README + `RUNBOOK.md` são suficientes pra operar.

## Arquivos

| Arquivo | Quando ler |
|---|---|
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Antes de mexer no código. Mapa do sistema, fluxo de dados, invariantes, decisões arquiteturais. |
| [`BACKLOG.md`](./BACKLOG.md) | Antes de propor nova mudança. Prioridades ordenadas do mais crítico ao menos crítico. Cada item tem evidência, ação, aceite, esforço, rollback. |
| [`RUNBOOK.md`](./RUNBOOK.md) | Em incidente. Comandos de emergência, restore, deploy, sintomas comuns. |
| [`AUDIT-2026-07-08.md`](./AUDIT-2026-07-08.md) | Registro histórico da auditoria de arquitetura + CTO review de 08/07/2026. Não editar. |

## Convenções

- **Não delete conteúdo antigo.** Mova pra "log de execução" ou crie
  arquivo novo (`AUDIT-YYYY-MM-DD.md`). História é ativo.
- **Todo item do backlog fechado gera entrada no log de execução** com
  data e hash do commit.
- **Nova auditoria = novo arquivo `AUDIT-YYYY-MM-DD.md`**, não sobrescreve
  o anterior.
- **Runbook cresce por incidente.** Cada sintoma novo que você resolveu
  vira entrada em "Sintomas comuns" do `RUNBOOK.md`.
- **`ARCHITECTURE.md` atualiza no MESMO commit que mudar arquitetura.**
  Nunca "depois". Se o commit muda fluxo de dados, atualize o diagrama.

## O que NÃO está aqui

- Senhas, tokens, credenciais — vivem no cofre corporativo referenciado
  em `RUNBOOK.md`.
- Knowledge base interno do WPA (mapa de campos, regras de negócio EDP) —
  vive em `docs/WPA-EDP-KNOWLEDGE-BASE.md` que **é gitignored** (privado).
- Notas de sessão, checkpoints, drafts — vivem em `_local/` ou `.claude/`
  (gitignored).
