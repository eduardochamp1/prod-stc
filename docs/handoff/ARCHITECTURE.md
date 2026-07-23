# Arquitetura — WPA Monitor

> Este documento descreve o sistema como ele está em **julho/2026**. É a "planta
> baixa" pra qualquer AI/dev navegar sem quebrar coisas. Se você mudar arquitetura,
> atualize este arquivo no mesmo commit.

## Visão de 10.000 metros

```
                   ┌────────────────────────────────────────────────┐
                   │  VM Ubuntu 24.04 (172.25.3.154, ~3.8GB RAM)   │
                   │  usr_jose · sem sudo · atrás de Fortinet       │
                   │                                                 │
   API WPA (EDP) ─►│  ┌──────────────────────────────────────────┐ │
   Azure App        │  │  PM2 wpa-monitor (fork, 1 instância)     │ │
   Service          │  │                                           │ │
   (undici,         │  │  Express (rotas /api/*)                   │ │
    máx 6           │  │    ├─ auth (JWT HMAC v=2)                 │ │
    conex.)         │  │    ├─ scope (regionals: string[])         │ │
                   │  │    └─ ~60 rotas de 12 domínios            │ │
                   │  │                                            │ │
                   │  │  node-cron (8 jobs no mesmo processo)     │ │
                   │  │    ├─ snapshot 15min (06-20h)              │ │
                   │  │    ├─ token refresh 45min                  │ │
                   │  │    ├─ consolidação 20:30                   │ │
                   │  │    ├─ drift-sweep 02:00 (D-1, D-7)         │ │
                   │  │    ├─ uuid-health 1x/h                     │ │
                   │  │    ├─ retry-outros 1x/h (:25)              │ │
                   │  │    ├─ classify subcategorias (async)       │ │
                   │  │    └─ classify rejections (async)          │ │
                   │  │                                            │ │
                   │  │  services/pgShim.js (10 conexões)         │ │
                   │  └──────────────────────────────────────────┘ │
                   │                     │                          │
                   │  ┌──────────────────▼──────────────────────┐  │
                   │  │  Postgres local (wpa_monitor)            │  │◄─ 5 users web
                   │  │  usuário app: wpa_app                    │  │  (rede 172.25.x)
                   │  │                                           │  │
                   │  │  Tabelas principais:                      │  │
                   │  │   snapshots (JSONB, ~16MB/dia, ∞)        │  │
                   │  │   teams_current (estado ao vivo)         │  │
                   │  │   team_daily_totals (produção)           │  │
                   │  │   team_daily_subcat_totals (por subcat)  │  │
                   │  │   team_daily_carteira (aproveitamento)   │  │
                   │  │   note_rejections (persistente)          │  │
                   │  │   note_subcategorias (cache class.)      │  │
                   │  │   note_details (payload OS, TTL 90d)     │  │
                   │  │   osrm_cache (rotas geo)                 │  │
                   │  │   equipes_oficiais (whitelist + escalas) │  │
                   │  │   app_settings (KV: metas, threshold…)   │  │
                   │  └──────────────────────────────────────────┘  │
                   │                                                 │
                   │  Backups: ~/backups/ (mesmo disco — P0-3!)     │
                   └────────────────────────────────────────────────┘
                                        │
                                        │ HTTP outbound
                                        ▼
                   Cloudflare Worker (osrm-proxy.jose-zouain.workers.dev)
                       └─► OSRM público (router.project-osrm.org)
                           (Fortinet bloqueia acesso direto — Worker é proxy free)
```

## Fluxo de dados (a cada 15 minutos)

```
API WPA (Azure) ──1──► wpaService.js
                          │
                          │ (login com backoff 48s pra cold-start Azure;
                          │  ~40 setores × equipes; undici cap 6 conexões)
                          │
                          ▼
                      cronService.runSnapshot()
                          │
                          ├──► dataWriter.saveSnapshot()   → snapshots (INSERT bruto)
                          ├──► dataWriter.pushTeams()      → teams_current (upsert + TTL)
                          ├──► dataWriter.upsertTeamDailyTotals()  → agregado por (date, team, tipo)
                          ├──► dataWriter.upsertTeamDailyCarteira() → aproveitamento diário
                          │
                          ├──async─► classifierService (MD/SF/DD → sub_code)
                          │             └─► note_subcategorias (cache UUID)
                          │             └─► dataWriter.upsertSubcatTotals()
                          │
                          ├──async─► rejectionService (motivos)
                          │             └─► note_rejections
                          │
                          ├──async─► notaProcessor (payload da OS)
                          │             └─► note_details (TTL 90d)
                          │
                          └──async─► syncEscalas (WPA shiftType → equipes_oficiais)
```

**Regra de ouro:** todo upsert **recompute o valor completo a partir do payload**.
Nunca "increment". Isso torna idempotente — re-rodar o mesmo ciclo não duplica dados.
Ver `services/dataWriter.js:206-245` (`upsertTeamDailyTotals`) como referência do padrão.

## Invariantes do domínio (não quebre)

### Invariante da carteira (por regional/dia ou por equipe/dia)

```
inicial + entradas_novas = atual + andamento + concluidas + rejeitadas + canceladas
```

Onde cada UUID de nota está em **exatamente 1 bucket final**, decidido por
prioridade `concluida > rejeitada > andamento > atual` no último snapshot do dia.
Implementado em duas cópias (dívida a resolver — ver backlog P2):

- `services/dataService.js:_buildDiaSummary()` (visão agregada por regional/dia)
- `services/dataWriter.js:upsertTeamDailyCarteira()` (visão persistente por equipe/dia)

**Bug histórico:** em 11/06/2026, canceladas mostrava 904 quando o esperado era
294 — comentário em `dataService.js:313-317` registra. Se seu bug se parecer
com isso, olhe primeiro se a prioridade de buckets está sendo respeitada.

### Regra do dia da nota (`_notaDate`)

Toda produção pertence ao **dia da sessão em que a equipe começou** (`sessionBegin`),
não ao `conclusionDate` da nota individual. Exceção: se `conclusionDate` está claramente
antes do dia da sessão, a nota "veio do passado" e conta no dia anterior.

Implementado em `services/dataWriter.js:_notaDate()` e `:_sessionDate()`. **É a
regra mais frequentemente esquecida em novos agregados** — quando adicionar métrica
nova, use essas funções.

### Whitelist de equipes oficiais

Métrica só conta pra equipe em `equipes_oficiais.ativo = true`. Aplicado em
`db/queries.js:_onlyOficiais()` — não confie que o payload da WPA já vem filtrado.

## Convenções de escopo (permissões)

### Modelo unificado (post-refactor #33, jul/2026)

- **JWT v=2.** Payload: `{ v: 2, username, role, regionals: string[], iat, exp }`.
- **`regionals` é sempre array de siglas reais.** Não existe `'ALL'`. Não existe
  grupo virtual (`'ES'`). Admin recebe `['GUA', 'CAC', 'SJC']`. User ES recebe
  `['GUA', 'CAC']`.
- **Interseção pedido × permitido no middleware `applyScope`** (`middleware/auth.js:178-198`).
  Query param `?regionals=CSV` é intersecionado com `req.user.regionals`. Vazio → 403.
- **`req.scope.regionals`** é o array a usar em queries. Nunca leia `req.user.regional`
  (singular) — vestígio pré-refactor, quando encontrar corrija (ver backlog H1).

### Helpers

- `services/regionals.js:inRegionals(qb, regs)` — para pgShim `.in()`.
- `services/regionals.js:inRegionalsSql(regs, params)` — para SQL raw com placeholders.
- `services/regionals.js:REGIONAIS_VALIDAS` — Set com GUA/CAC/SJC (única fonte).

## Layout do backend

```
server.js                    # Express boot, cron start, health, static
ecosystem.config.js          # PM2 (fork mode, 1G max, restart on OOM)
middleware/
  auth.js                    # JWT + applyScope + compatRegionalParam
routes/
  index.js                   # 2.755 linhas / ~60 rotas / 12 domínios (god-file — H6)
  cron.js                    # webhook /cron/tick (auth por CRON_SECRET)
services/
  dbClient.js                # getClient() → pgShim (Postgres local; exige DATABASE_URL)
  pgShim.js                  # Shim compatível com API supabase-js sobre pg
  regionals.js               # ★ 44 linhas, modelo de estilo (small, testado, único)
  dataService.js             # Reads agregados: getTeams, _buildDiaSummary
  dataWriter.js              # Writes agregados: upsert*, consolidateDay, cleanOld*
  cronService.js             # 8 jobs node-cron, locks, watchdogs
  wpaService.js              # Cliente HTTP da API WPA da EDP
  classifierService.js       # MD/SF/DD → sub_code (TL11, OBSOLETO, L0…)
  notaProcessor.js           # Extrai checkpoints/endereço do payload de nota
  rejectionService.js        # Coleta motivos de rejeição da WPA
  notasMonitor.js            # Aba "Notas devolvidas"
  equipesOficiais.js         # Cache in-memory da whitelist
  osrmService.js             # Rotas OSRM via Cloudflare Worker
  timeUtil.js                # dateBRT() — fonte única de "hoje em BRT"
  memoCache.js               # TTL + single-flight para queries caras
  logger.js                  # JSON logs estruturados via stdout
db/
  queries.js                 # 1.606 linhas — reads (getTeamsFromSupabase, historia)
  deslocamentosQueries.js    # Aba Deslocamentos (checkpoints + OSRM)
  rejectionsQueries.js       # Rejeições persistentes
  subcategoriasQueries.js    # Cache de classificação
  notasQueries.js            # Notas devolvidas
  wpaTokenStore.js           # Persistência do JWT da WPA da EDP
scripts/
  backfill-*.js              # Backfills retroativos (idempotentes)
  diag-*.js                  # Diagnóstico read-only
  migrate-*.js               # One-shots históricos (não rodar em prod agora)
  backup-wpa-monitor.sh      # Backup diário (crontab do usuário)
test/                        # node --test, 152 testes, ~0.8s
  regionals.test.js          # ★ Referência de bom teste puro
  pgShim.test.js             # Cobertura do shim
  auth.test.js               # JWT + applyScope
vendor/
  xlsx.full.min.js           # SheetJS vendorizado (Fortinet bloqueia CDN)
```

## Layout do frontend

Um `index.html` com **12.8k linhas** dividido informalmente por comentários:

- `<head>`: SheetJS + Leaflet (Leaflet ainda em CDN — H10).
- `<style>`: 4.259 linhas de CSS.
- `<body>`: markup das abas.
- `<script>` grande no fim (~7.500 linhas):
  - Bootstrap auth, patch de fetch (linhas 5300-5450).
  - Estado global (`selectedRegionals`, `_deslocCache`, etc — 56 lets soltos).
  - `MultiSelect` reusable (linhas 6070-6300).
  - Uma seção por aba: Monitor, Rejeições, Deslocamentos, Notas, Gráficos,
    Ranking, Mapa, Histórico, Metas.
  - `initXxx()` e `loadXxx()` por aba, disparados por `switchTab()`.
  - Boot ao final.

**Split incremental é backlog P2 (H11).** Enquanto não fizer, cuidado com:
- Ordem de declaração importa (bloco `REGIONAIS_ATIVAS` DEVE vir cedo — TDZ).
- Funções globais são referenciadas em `onclick=""` — renames silenciosos quebram.
- Estado é global mutável — mudanças em `let X` numa aba afetam outras.

## Pontos de acoplamento a saber

| Peça | Depende de | Quebra se… |
|---|---|---|
| `cronService` | `wpaService`, `dataWriter`, `classifierService`, `rejectionService`, `notaProcessor` | Qualquer erro não-catchado derruba o ciclo inteiro |
| `routes/index.js` | `dbClient`, `db/queries`, `dataService`, `services/regionals`, `middleware/auth` | 54 `require()` inline escondem o grafo — cuidado ao mover |
| Frontend | Backend `/api/*` | Zero validação de contrato — mudar shape do JSON pode quebrar UI silenciosamente |
| `pgShim` | `pg` driver puro | Se mudar API do supabase-js "legacy" caller, o shim tem que aprender novo método |
| `applyScope` middleware | `req.user.regionals` do JWT v=2 | Se qualquer rota ler `req.user.regional` (singular), está morta silenciosamente — ver H1 |

## Cache layers (não redundantes — cada uma resolve algo diferente)

- **`memoCache`** (in-memory, TTL 5min, single-flight) — deslocamentos e outras
  queries caras. Vira 0ss em cache hit.
- **`osrm_cache`** (Postgres, permanente) — rotas OSRM. Cache miss dispara
  Cloudflare Worker; cache hit é grátis.
- **`note_subcategorias`** (Postgres, permanente) — classificação de MD/SF/DD.
  Evita chamar `/api/notes/subcategoria` na WPA a cada snapshot.
- **`note_details`** (Postgres, TTL 90d) — payload completo da OS. Alimenta
  a aba Notas/Mapa. Retenção limitada por tamanho do JSONB.
- **`equipesOficiais` in-memory** (sync do banco a cada N snapshots) —
  whitelist quente pra `_onlyOficiais` não bater no banco a cada linha.

## Segurança em síntese

- **JWT HMAC-SHA256 caseiro** (`middleware/auth.js`). Ignora `alg` do header
  (imune a alg-confusion), `exp` obrigatório, `v=2` versionado.
- **AUTH_USERS no `.env`** formato `user:sha256hash:role:regional1|regional2`.
  SHA-256 **sem salt** (dívida — ver backlog).
- **CORS aberto** (`server.js:18`). Baixo risco: rede interna e auth por
  Bearer (não cookie).
- **SQL 100% parametrizado.** Zero interpolação de valor de usuário em SQL —
  auditado em jul/2026.
- **Segredos:** `.env`, `.env.migration`, `docs/`, `_local/` gitignored.
  Nenhum segredo em commits.

## Decisões arquiteturais que não devem ser desfeitas

Anote quando reverter tentar entrar em pauta:

1. **Retenção infinita de snapshots** (`dataWriter.js:539-549`, 07/07/2026).
   Custo real: ~16MB/dia (~6GB/ano). Benefício: backfill retroativo de
   métricas novas. **Já provou valor** — permitiu criar `team_daily_carteira`
   com 2 meses de histórico.
2. **Cloudflare Worker como proxy OSRM.** Free tier 100k req/dia, sem cartão.
   Alternativas (HERE, OSRM público direto) foram descartadas por custo/bloqueio
   Fortinet. Ver `services/osrmService.js:1-22`.
3. **`regionals` como `string[]` sempre.** Sem `'ALL'`, sem grupos. Refactor
   completo em jul/2026 (task #33). Simplifica queries e elimina magia.
4. **`pgShim` no lugar de `@supabase/supabase-js` remoto.** Migração de maio/2026.
   Mantém a API supabase-js pra 105 callsites — reescrever tudo era muito.
5. **Cluster PM2 com `instances: 1`.** Vários locks/caches são em memória. Não
   pode escalar horizontalmente sem antes migrar isso. Documentado em
   `ecosystem.config.js`.
6. **`docs/handoff/`** é a **única** parte de `docs/` versionada. O resto é
   knowledge base privado do dev.

## Coisas que NÃO existem (não invente)

- CI/CD (deploy manual)
- Staging (VM secundária)
- Bundler frontend (webpack, vite, esbuild)
- Framework de teste (só `node --test` nativo)
- ORM (queries SQL direto ou via pgShim)
- Docker (rodar `docker` requer sudo indisponível)
- Cache Redis (`memoCache` in-memory basta hoje)
- Fila (RabbitMQ, SQS) — cron sequencial é suficiente
- Observability stack (Prometheus, Datadog) — só `pm2 logs`
- Múltiplas linguagens (só JS)

Se alguém propuser adicionar qualquer coisa desta lista, questione. A restrição
"1 dev sem orçamento" foi deliberada e é o que mantém o projeto sustentável.
