# CLAUDE.md — Entry point para qualquer AI/LLM neste repo

> Se você é uma AI (Claude, GPT, Gemini, etc.) ou dev novo entrando neste
> projeto, **leia este arquivo inteiro antes de propor ou executar qualquer
> mudança**. Ele tem tudo que precisa pra atuar com segurança.

## O que é este projeto

**WPA Monitor** — painel de monitoramento de equipes de campo da Engelmig
Energia (empreiteira da EDP). Ingere dados da API WPA da EDP a cada 15min,
consolida em métricas diárias por equipe/regional/tipo de serviço, e serve
um painel web pra gestão operacional. Dados aqui são **reportados à EDP** —
erro em número visível a cliente.

- **Stack:** Node.js/Express, frontend vanilla em `public/index.html` monolítico,
  Postgres local via `services/pgShim.js` (shim compatível com API supabase-js).
- **Deploy:** VM Ubuntu 24.04 corporativa (~3.8GB RAM, **sem sudo**), atrás
  de Fortinet com TLS interception (bloqueia CDNs públicos), PM2 modo cluster
  1 instância.
- **Contrato:** 6 dígitos × 60 meses, iniciado julho/2026. É **infraestrutura
  crítica de negócio**, não experimento. Trate com cuidado proporcional.

## Contexto de negócio (não perca de vista)

- **Bus factor 1** hoje. Todo conhecimento (senhas, `.env`, credenciais
  Cloudflare/EDP) vive só na cabeça do José Zouain. **Reduzir isso é
  prioridade absoluta** — ver P0 em `docs/handoff/BACKLOG.md`.
- **EDP audita.** Números que aparecem no painel podem ser questionados
  em auditoria de contrato. Bug de agregação = ameaça reputacional.
- **Sem orçamento formal, sem CI/CD, sem staging.** Todo deploy é `git pull
  + pm2` direto em produção. Não introduza dependências pagas sem consultar.

## Rules of engagement (obrigatórias)

1. **Sempre leia `docs/handoff/BACKLOG.md` antes de começar.** É a fonte de
   verdade sobre prioridades. Item mais no topo = mais crítico.
2. **Nunca invente `file:line`.** Se a evidência precisar ser reverificada,
   use Read/Grep antes de propor. Todo item do backlog tem evidência —
   valide antes de executar.
3. **Nunca remova comentários datados.** Comentários no código com data
   (ex.: `// bug reportado em 11/06/2026`) são arqueologia deliberada de
   incidentes passados. **Preserve mesmo em refactor.**
4. **PM2 cluster mode é frágil com `--update-env`.** Sempre use
   `pm2 delete wpa-monitor && pm2 start ecosystem.config.js && pm2 save`.
5. **Fortinet bloqueia CDNs.** Bibliotecas de terceiros são vendorizadas em
   `public/vendor/`. Não sugira `<script src="cdn...">` — vai quebrar em
   produção sem aviso.
6. **Testes: `node --test`** (built-in do Node, sem framework). Suíte roda
   em ~0.8s. **Rode antes de propor merge** — foi ignorada 4 semanas em
   2026 e a suíte ficou vermelha sem ninguém saber.
7. **Zero manipulação de números pra "fechar contas".** O usuário foi
   explícito: se aritmética não fecha, é bug de fonte, não de exibição.
   Corrija a origem.
8. **Cluster mode instances=1.** Vários locks/caches são em memória do
   processo. Não sugira escalar horizontalmente sem antes migrar isso.
9. **Sudo indisponível.** Todas as soluções têm que caber em usuário sem
   privilégios (sem apt, sem systemd novo, sem instalar CA no OS).

## Como pegar trabalho

1. Abra `docs/handoff/BACKLOG.md`.
2. Ache o próximo item **P0** ainda com `status: pending`. Se todos P0
   estão `done`, pega o próximo P1. E assim por diante.
3. Cada item tem: **evidência, impacto, ação, critério de aceite, esforço
   estimado, rollback**. Se algum campo estiver vago, pare e pergunte —
   não improvise.
4. Ao concluir, atualize o status pra `done` com data + hash do commit.
   Não delete o item — vira registro histórico.

## Como fazer commit / deploy

```bash
# Sempre rode a suíte antes
node --test
# Deve dar 0 falhas (as 4 falhas antigas de classifier.test.js foram
# corrigidas em jun/2026). Se houver falha nova, é regressão sua.

# Commit convencional
git add ...
git commit -m "tipo(escopo): descrição curta

  Detalhes do que mudou e por quê.
  Se resolve item do backlog, cite: 'Resolve backlog item P1-4'.

  Co-Authored-By: <seu modelo/nome> <noreply@anthropic.com>"

# Push
git push

# Deploy (usuário roda na VM, você não roda daqui)
# → cd ~/prod-stc && git pull && pm2 delete wpa-monitor \
#     && pm2 start ecosystem.config.js && pm2 save
```

## Onde ficam as coisas

| Arquivo/pasta | O que tem |
|---|---|
| [`docs/handoff/BACKLOG.md`](docs/handoff/BACKLOG.md) | **Fonte de verdade das prioridades.** Ordem: mais crítico primeiro. |
| [`docs/handoff/ARCHITECTURE.md`](docs/handoff/ARCHITECTURE.md) | Mapa do sistema. Fluxo de dados. Invariantes. Onde vive cada métrica. |
| [`docs/handoff/RUNBOOK.md`](docs/handoff/RUNBOOK.md) | Como operar em produção. Reinício, rollback, incidentes. |
| [`docs/handoff/API-WPA-EDP.md`](docs/handoff/API-WPA-EDP.md) | **Todo endpoint da API WPA**: login/token, equipes, sessões, notas, motivo de rejeição. Mais nossos endpoints de backfill/conferência/fechamento, crons e as armadilhas que já causaram incidente. |
| [`docs/handoff/AUDIT-2026-07-08.md`](docs/handoff/AUDIT-2026-07-08.md) | Auditoria completa (7 dimensões). Evidência congelada no tempo. |
| [`docs/handoff/AUDIT-2026-08-28.md`](docs/handoff/AUDIT-2026-08-28.md) | Auditoria de 28/08/2026 — 13 achados novos (P1-41…P3-19) escritos como **ordem de serviço**: código atual verbatim, código novo verbatim, teste, verificação e rollback por item. Leia daqui se você for executar as correções. |
| `docs/` (fora de `handoff/`) | Knowledge base privado do dev (gitignored). Você não vê. |
| `.claude/`, `_local/` | Workspace do dev (gitignored). |
| `services/`, `db/`, `routes/`, `middleware/` | Backend. Comece por `services/regionals.js` (44 linhas, modelo do estilo). |
| `public/index.html` (~8.6k linhas) | Frontend monolítico. **Cuidado.** Ver risco H11 no backlog. (Movido pra `public/` no P2-3; CSS extraído pra `public/css/app.css` no P2-8 — ambos 22/07. O server serve SÓ `public/`.) |
| `public/css/app.css` (~4.3k linhas) | CSS do painel (extraído do `<style>` do index.html no P2-8). |
| `public/vendor/` | Bibliotecas 3rd-party servidas localmente (Fortinet mata CDN). |
| `scripts/` | Backfills, diagnóstico, migrações. Muitos read-only. |
| `test/` | 266 testes, `node --test`. Cobertura desigual (backend só). |
| `ecosystem.config.js` | Config PM2. Não edite sem entender max_memory_restart. |

## Filosofia deste projeto (aprendida em incidente)

- **Aritmética por construção.** Cada UUID em exatamente 1 bucket. Invariantes
  matemáticas fecham sozinhas. Ver `services/dataService.js:296-330`.
- **Fonte única por métrica.** `Math.max` entre 3 fontes é code smell — se
  duas fontes divergem, uma está errada. Investigue, não mascare.
- **Comentários com data e sintoma.** Quando corrigir bug, deixe o "por quê"
  no código com data e mensagem original do reporter. Isso é arqueologia
  útil, não ruído.
- **Idempotência sempre.** Todo upsert do cron pode ser re-executado sem
  duplicar dados. Se você adicionar novo insert, mantenha esse contrato.
- **Backfill retroativo é viável.** Snapshots retidos pra sempre (decisão
  de 07/07/2026, `dataWriter.js:539-549`). Qualquer métrica nova pode ser
  reconstruída pro passado.

## Última nota

Este projeto foi construído em conversas ao vivo (José × Claude Fable/Opus)
entre abril e julho de 2026. **Não há dívida escondida** — os riscos estão
todos catalogados em `docs/handoff/BACKLOG.md` com evidência. Se você achar
algo novo, adicione ao backlog na posição correta (por severidade), não
"corrija silenciosamente". Transparência > velocidade.

Boa sorte. Se travar, o próximo passo é sempre: **grep, ler o código real,
não confiar em conhecimento pré-existente**. O código é a fonte de verdade.
