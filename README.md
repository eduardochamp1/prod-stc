# WPA Monitor — Engelmig Energia

> Dashboard operacional em tempo real para monitoramento de equipes de campo do sistema WPA (EDP), com histórico persistido no Supabase, metas configuráveis por regional, ranking diário/mensal e autenticação por papel (admin / regional).

---

## Índice

1. [Visão Geral](#1-visão-geral)
2. [Arquitetura](#2-arquitetura)
3. [Estrutura de Arquivos](#3-estrutura-de-arquivos)
4. [Modos de Operação (DATA_MODE)](#4-modos-de-operação-data_mode)
5. [Integração com a API WPA (EDP)](#5-integração-com-a-api-wpa-edp)
6. [Banco de Dados — Supabase](#6-banco-de-dados--supabase)
7. [Autenticação (JWT)](#7-autenticação-jwt)
8. [Cron Jobs](#8-cron-jobs)
9. [Webhook de Auto-Deploy](#9-webhook-de-auto-deploy)
10. [Frontend — Abas e Funcionalidades](#10-frontend--abas-e-funcionalidades)
11. [Variáveis de Ambiente (.env)](#11-variáveis-de-ambiente-env)
12. [Como Rodar Localmente](#12-como-rodar-localmente)
13. [Deploy em Produção (Linux + PM2)](#13-deploy-em-produção-linux--pm2)
14. [Gerenciamento de Usuários](#14-gerenciamento-de-usuários)
15. [Restrições Conhecidas e Armadilhas](#15-restrições-conhecidas-e-armadilhas)
16. [Pendências e Roadmap](#16-pendências-e-roadmap)

---

## 1. Visão Geral

O **WPA Monitor** é uma aplicação web interna da **Engelmig Energia** desenvolvida para acompanhar em tempo real o desempenho das equipes de campo que operam no sistema **WPA** da **EDP** (Energias do Brasil). O sistema exibe quantas ordens de serviço cada equipe baixou, está executando e concluiu no dia — o mesmo que os gestores acompanham no painel do WPA Gestão Online, porém consolidado, filtrado apenas para as equipes Engelmig, com histórico persistido, metas configuráveis e controle de acesso por regional.

### Problemas que o sistema resolve

| Problema | Solução implementada |
|----------|----------------------|
| O WPA Gestão Online não filtra por empresa prestadora | Filtragem pelo `CompanyId` da Engelmig (`92a2f98e-8877-433e-8358-173b94c13a54`) |
| Nenhuma retenção de histórico no WPA | Snapshots a cada 15 min gravados no Supabase; consulta por intervalo De/Até |
| Notas com status 9→4 somem da API após sincronização | Acumulador em memória `_acc` no `wpaService.js` que reinjecta notas já vistas |
| Sem visão consolidada por regional | Filtro por regional com agrupamentos automáticos; controle server-side no JWT |
| Sem controle de metas | Metas mensais por tipo de OS configuráveis pelo admin; cálculo proporcional ao dia |
| Sem ranking comparativo | Ranking diário/mensal por equipe, com pódio visual |
| Acesso livre a dados de todas as regionais | JWT com roles (admin / gua / cac); filtro regional sobrescrito server-side |

---

## 2. Arquitetura

```
┌─────────────────────────────────────────────────────────────────────┐
│                       SERVIDOR LINUX (PM2)                          │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                      server.js (Express)                       │ │
│  │                                                                │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐  │ │
│  │  │  routes/     │  │ middleware/  │  │   services/        │  │ │
│  │  │  index.js    │  │  auth.js     │  │   wpaService.js    │  │ │
│  │  │              │  │              │  │   cronService.js   │  │ │
│  │  │  REST /api/* │  │  JWT HMAC    │  │   supabasePush.js  │  │ │
│  │  │              │  │  RBAC        │  │   dataService.js   │  │ │
│  │  └──────┬───────┘  └──────────────┘  └────────┬───────────┘  │ │
│  │         │                                      │               │ │
│  └─────────┼──────────────────────────────────────┼───────────────┘ │
│            │                                      │                  │
│            ▼                                      ▼                  │
│   ┌─────────────────┐                  ┌──────────────────────┐     │
│   │   index.html    │                  │   API WPA EDP        │     │
│   │   (SPA vanilla) │                  │   Azure AppService   │     │
│   └─────────────────┘                  │   edp-wpa-web-api    │     │
│                                        └──────────────────────┘     │
│                                                  │                   │
│                                           escreve a cada 15 min     │
│                                                  │                   │
└──────────────────────────────────────────────────┼───────────────────┘
                                                   ▼
                                      ┌────────────────────────┐
                                      │         Supabase       │
                                      │  (PostgreSQL gerenciado)│
                                      │                        │
                                      │  snapshots             │
                                      │  teams_current         │
                                      │  daily_totals          │
                                      │  team_daily_totals     │
                                      │  metas                 │
                                      └────────────────────────┘
```

### Fluxo principal de dados

1. **Cron (a cada 15 min, 06h–20h BRT)**: servidor consulta a API WPA EDP → filtra equipes Engelmig pelo `CompanyId` → grava snapshot completo no Supabase.
2. **Cliente (navegador)**: faz `GET /api/teams` com token JWT no header → servidor consulta WPA ao vivo → retorna dados frescos.
3. **Histórico**: cliente faz `GET /api/historico/sessoes?de=YYYY-MM-DD&ate=YYYY-MM-DD` → servidor lê `daily_totals` / `snapshots` do Supabase → retorna resumo detalhado por dia.
4. **Consolidação diária (20:30 BRT)**: cron lê os snapshots do dia, extrai o estado final de cada equipe e grava em `daily_totals` / `team_daily_totals` apenas as notas concluídas — valor definitivo do dia.

---

## 3. Estrutura de Arquivos

```
prod-stc/
│
├── server.js                  # Ponto de entrada — Express + webhook de deploy + inicialização
├── index.html                 # SPA frontend (HTML, CSS, JS embutidos — sem bundler)
├── package.json               # Dependências e scripts npm
├── .env                       # Variáveis de ambiente reais (não versionado — git ignored)
├── .env.example               # Modelo de configuração (versionado)
├── iniciar.bat                # Atalho para iniciar em Windows (desenvolvimento)
│
├── routes/
│   └── index.js               # Todas as rotas REST /api/* + middleware de autenticação
│
├── middleware/
│   └── auth.js                # JWT (HMAC-SHA256 nativo), login, authMiddleware, RBAC regional
│
├── services/
│   ├── wpaService.js          # Integração completa com API WPA EDP
│   │                          #   auth (JWT cache + auto-renovação), getSessions,
│   │                          #   getTeamsBySector (V2), getTeamsByDate (histórico),
│   │                          #   getSessionDetail, acumulador _acc
│   ├── dataService.js         # Abstração de fonte: mock | wpa — mapeia setores/regional
│   ├── supabasePush.js        # Escrita no Supabase: saveSnapshot, pushTeams,
│   │                          #   upsertDailyTotals, upsertTeamDailyTotals, consolidateDay
│   ├── supabaseClient.js      # Singleton do cliente @supabase/supabase-js (service_role)
│   └── cronService.js         # node-cron: renovação de token, snapshot 15 min, consolidação
│
├── db/
│   ├── supabaseQueries.js     # Queries de leitura Supabase: histórico, metas, ranking,
│   │                          #   getTeamSessionHistory (paginado), getMetasCalculadas
│   ├── index.js               # Inicialização SQLite (legado — banco original, desativado)
│   ├── schema.js              # Schema SQLite (legado, mantido para referência)
│   └── queries.js             # Queries SQLite (legado, mantido para referência)
│
├── mock/
│   └── mockData.js            # Dados simulados para DATA_MODE=mock (desenvolvimento offline)
│
└── node_modules/              # Dependências npm (não versionado)
```

### Dependências de produção

| Pacote | Versão | Função |
|--------|--------|--------|
| `express` | ^4.18.2 | Servidor HTTP e roteamento |
| `cors` | ^2.8.5 | Cabeçalhos CORS para desenvolvimento local |
| `dotenv` | ^16.4.5 | Carregamento de `.env` |
| `node-fetch` | ^2.7.0 | HTTP client para chamar a API WPA EDP |
| `node-cron` | ^3.0.3 | Agendamento de jobs periódicos |
| `@supabase/supabase-js` | ^2.49.4 | Cliente oficial Supabase |

> **Zero dependências externas para autenticação.** O JWT é assinado e verificado com o módulo nativo `crypto` do Node.js (HMAC-SHA256), sem `jsonwebtoken` ou similar.

---

## 4. Modos de Operação (DATA_MODE)

### `DATA_MODE=wpa` — Produção (servidor interno Engelmig)

- Consulta a API WPA EDP diretamente em tempo real.
- Cron jobs ativos: token renewal (45 min), snapshot (15 min), consolidação diária (20:30).
- Grava snapshots e totais no Supabase.
- **Requisito**: acesso à internet + credenciais WPA válidas no `.env`.

### `DATA_MODE=supabase` — Produção alternativa (Vercel / edge)

- Lê apenas o último estado salvo no Supabase (`teams_current`).
- Não acessa a API WPA EDP (sem credenciais necessárias).
- Cron desativado — todas as escritas vêm do servidor Linux.
- **Requisito**: `SUPABASE_URL` e `SUPABASE_SERVICE_KEY` configurados.

### `DATA_MODE=mock` — Desenvolvimento offline

- Dados simulados fixos de `mock/mockData.js`.
- Nenhuma conexão externa: sem WPA, sem Supabase.
- Cron desativado.
- Ideal para desenvolvimento de frontend sem dependências.

---

## 5. Integração com a API WPA (EDP)

A API WPA não possui documentação oficial. Todos os endpoints, parâmetros e estruturas de dados foram mapeados via inspeção do DevTools do browser no painel WPA Gestão Online e via Postman.

### URLs base

| Propósito | URL |
|-----------|-----|
| Autenticação | `https://edp-wpa-po.azurewebsites.net` |
| API de dados | `https://edp-wpa-web-api.azurewebsites.net` |

### Autenticação WPA

```
POST /identity/signin
Content-Type: application/x-www-form-urlencoded
X-Requested-With: XMLHttpRequest

Body: Username=...&Password=...
```

Resposta: `{ Token: "<JWT>", UserId: "..." }`

O token é cacheado em memória (`_token`, `_expireAt`). Renovado automaticamente 60 segundos antes de expirar. Fallback de TTL = 1 hora se o JWT não contiver `exp`. `forceRefresh()` força novo login independente do cache — chamado pelo cron a cada 45 min e no startup do servidor.

### Endpoints de dados ao vivo

| Endpoint | Método | Propósito |
|----------|--------|-----------|
| `GET /api/sessions/current?sectorId={sid}` | GET | Sessões ativas — **única fonte** do `Team.CompanyId` para filtrar Engelmig; também fornece a placa do veículo |
| `GET /api/teamsstatus/V2?sectorId={sid}&filterByExhibitionSector=true` | GET | Arrays de notas por equipe: `Concluded[]`, `Downloaded[]`, `Executed[]`, `Rejected[]` |
| `GET /api/route/preroute?sectorId={sid}` | GET | `WalletCount` por equipe (tamanho da carteira) |

### Endpoints históricos (datas passadas)

| Endpoint | Método | Propósito |
|----------|--------|-----------|
| `POST /api/Sessions/all/date?sectorId={sid}&date=M/D/YYYY` | POST | Todas as sessões de um dia. Body vazio. **Sempre retorna `Collaborators: []`** — dados reais de colaboradores só vêm do endpoint individual. |
| `GET /api/Sessions/{sessionId}` | GET | Detalhes completos de uma sessão, incluindo `Collaborators[{ Id, Code, Name, Phone }]` — **única fonte** de colaboradores reais |
| `GET /api/notes/executed/{sessionId}/session` | GET | Notas concluídas da sessão |
| `GET /api/notes/downloaded/{sessionId}/session` | GET | Notas baixadas da sessão |
| `GET /api/notes/rejected/{sessionId}/session` | GET | Notas rejeitadas da sessão |
| `GET /api/notes/surveyed/{sessionId}/session` | GET | Notas vistoriadas da sessão |

> **Atenção ao sufixo `/session`**: todos os endpoints de notas por sessão exigem esse sufixo. Sem ele, o endpoint retorna uma estrutura diferente e não útil. Confirmado via DevTools do painel WPA.

### Mapeamento de setores por regional

| Código do Setor | Regional |
|-----------------|----------|
| `DESG` | Guarapari (GUA) |
| `DEPT` | Guarapari (GUA) |
| `DESC` | Cachoeiro (CAC) |

```javascript
REGIONAL_MAP = { DESG: 'GUA', DEPT: 'GUA', DESC: 'CAC' }
SETORES      = { GUA: ['DESG','DEPT'], CAC: ['DESC'], ALL: ['DESG','DEPT','DESC'] }
```

### Filtragem de equipes Engelmig

O WPA retorna **todas** as equipes do setor (incluindo outras prestadoras). O filtro é feito pelo campo `session.Team.CompanyId`. O UUID da Engelmig no sistema EDP é:

```
92a2f98e-8877-433e-8358-173b94c13a54
```

### ExecutionStatus das notas (V2)

| Código | Classificação | Significado |
|--------|---------------|-------------|
| `1` | baixada | Na carteira, aguardando execução |
| `2` | baixada | Variante na carteira |
| `3` | executada | Em andamento |
| `6` | executada | Trabalhando ativamente na nota |
| `7` | executada | Variante em andamento |
| `4` | concluída | Exportada/sincronizada com ERP |
| `5` | concluída | Exportada variante |
| `9` | concluída | Concluída no mobile, pendente sincronização |

> **Status 4 e 5 somem do V2 após sincronização**: o endpoint `/api/notes/execution` não retorna notas com esses status. Apenas o array `Concluded[]` do V2 as contém. Por isso o V2 é a fonte canônica dos contadores. Adicionalmente, o acumulador `_acc` em memória (reinjetado a cada poll do mesmo dia) evita queda no contador quando notas transitam de status 9→4.

### Estratégia de dois endpoints paralelos por setor (`getTeamsBySector`)

Para cada setor, duas chamadas paralelas:
1. `GET /api/sessions/current` → sessões Engelmig (fonte do `CompanyId` e da placa)
2. `GET /api/teamsstatus/V2` → arrays de notas

Matching entre as duas respostas: por `Team.Id` (primário) ou `Team.Name` (fallback).

### Busca histórica (`getTeamsByDate`)

Usada pelo backfill. Fluxo por setor:
1. `POST /api/Sessions/all/date` → sessões do dia, filtradas por `CompanyId`
2. Para cada sessão Engelmig em paralelo:
   - `executed`, `downloaded`, `rejected`, `surveyed` — notas
   - `GET /api/Sessions/{sessionId}` — colaboradores reais
3. Agrupamento por equipe, merge de re-logins (múltiplas sessões do mesmo dia)
4. Deduplicação de notas por código e de colaboradores por matrícula

### Objeto normalizado de equipe

```javascript
{
  id:             string,          // WPA session ID
  sigla:          string,          // ex.: "EPVGA30"
  teamName:       string,          // igual a sigla
  sectorId:       string,          // "DESG" | "DEPT" | "DESC"
  regional:       string,          // "GUA" | "CAC"
  date:           string,          // "YYYY-MM-DD"
  sessionBegin:   string|null,     // ISO datetime
  sessionEnd:     string|null,     // ISO datetime, null se sessão ativa
  vehiclePlate:   string,
  collaborators:  [{ nome, matricula, cargo }],
  relogins:       number,          // sessões extras (0 = apenas uma sessão no dia)
  sessions:       [{ begin, end }],// todas as sessões do dia
  deviceModel:    string|null,
  appVersion:     string|null,
  carteiraCount:  number,          // fonte: WalletCount do preroute
  servicosPerfil: string[],        // tipos únicos de OS da carteira
  notasBaixadas:   [Note],
  notasExecutadas: [Note],
  notasConcluidas: [Note],
  notasRejeitadas: [Note],
  notasVistoriadas:[Note],
}
```

### Objeto normalizado de nota

```javascript
{
  codigo:   string,   // número da OS, ex.: "015001763337"
  tipoCode: string,   // código do tipo: "LN", "LE", "DL", ...
  tipoNome: string,   // nome por extenso (quando disponível do V2)
  status:   string,   // "baixada" | "executada" | "concluida" | "rejeitada" | "vistoriada"
}
```

---

## 6. Banco de Dados — Supabase

Todas as escritas e leituras históricas passam pelo Supabase. O cliente (`@supabase/supabase-js`) usa a chave `service_role`, que contorna RLS — a chave nunca deve chegar ao browser.

> **Atenção ao limite de 1.000 linhas**: o cliente Supabase retorna no máximo 1.000 linhas por query **sem emitir erro ou aviso**. Queries que possam exceder esse limite (ex.: `getTeamSessionHistory` com meses longos) usam paginação com `.range(page * size, (page+1)*size - 1)` em loop `while`.

### Tabela `snapshots` — registro bruto histórico

```sql
id            BIGSERIAL PRIMARY KEY
date          DATE           -- YYYY-MM-DD
team_name     TEXT
sector_id     TEXT           -- DESG | DEPT | DESC
regional      TEXT           -- GUA | CAC
session_begin TIMESTAMPTZ
session_end   TIMESTAMPTZ
vehicle_plate TEXT
baixadas      INTEGER
executadas    INTEGER
concluidas    INTEGER
rejeitadas    INTEGER
captured_at   TIMESTAMPTZ DEFAULT now()
data          JSONB          -- objeto completo normalizado da equipe
```

- **Escrita**: INSERT puro (nunca upsert) — um registro por equipe por ciclo de 15 min. Cresce continuamente.
- **Leitura**: base para consolidação, para a aba Monitor em datas passadas (`getTeamsByDateFromSnapshots`) e para a aba Histórico (`getTeamSessionHistory`).

### Tabela `teams_current` — estado mais recente por equipe

```sql
team_name   TEXT UNIQUE PRIMARY KEY
regional    TEXT
sector_id   TEXT
data        JSONB          -- objeto completo mais recente
updated_at  TIMESTAMPTZ
```

- **Escrita**: UPSERT ON CONFLICT `team_name`. Substituído em cada ciclo de snapshot.
- **Leitura**: `GET /api/teams` no modo `supabase` (Vercel).

### Tabela `daily_totals` — agregação diária por regional

```sql
id         BIGSERIAL PRIMARY KEY
date       DATE
regional   TEXT
tipo_code  TEXT
count      INTEGER
UNIQUE(date, regional, tipo_code)
```

- **Durante o dia (intraday)**: soma `executadas + concluidas` (contagem inclui notas ainda em campo).
- **Após consolidação (20:30)**: sobrescreve com `concluidas` apenas — valor definitivo do dia.

### Tabela `team_daily_totals` — agregação diária por equipe

```sql
id         BIGSERIAL PRIMARY KEY
date       DATE
team_name  TEXT
regional   TEXT
sector_id  TEXT
tipo_code  TEXT
count      INTEGER
UNIQUE(date, team_name, tipo_code)
```

Mesmo ciclo de vida que `daily_totals`, porém com granularidade por equipe. Usado no ranking e no histórico detalhado.

### Tabela `metas` — metas mensais por regional

```sql
regional  TEXT UNIQUE PRIMARY KEY   -- "GUA" | "CAC"
data      JSONB                      -- ex.: { "LN": 120, "LE": 80, "DL": 40 }
```

- **Escrita**: UPSERT pelo admin via interface.
- **Leitura**: `getMetasCalculadas` para cálculo de progresso proporcional.

### Pipeline de escrita (modo wpa)

```
Cron a cada 15 min (06h–20h)
  └─ runSnapshot()
       ├─ getTeams()                    ← API WPA (setores em paralelo)
       ├─ saveSnapshot(teams)           → INSERT snapshots
       ├─ pushTeams(teams)              → UPSERT teams_current
       ├─ upsertDailyTotals(teams)      → UPSERT daily_totals    (exec + conc, deduplicado)
       └─ upsertTeamDailyTotals(teams)  → UPSERT team_daily_totals (exec + conc, deduplicado)

Cron às 20:30 BRT
  └─ runConsolidate(date)
       └─ consolidateDay(date)
            ├─ SELECT snapshots WHERE date=X ORDER BY captured_at DESC
            ├─ último snapshot por equipe = estado final do dia
            ├─ UPSERT daily_totals       (concluidas apenas — definitivo)
            └─ UPSERT team_daily_totals  (concluidas apenas — definitivo)
```

**Deduplicação antes do UPSERT**: antes de enviar ao Supabase, as linhas são acumuladas em memória por chave de conflito. Isso evita o erro PostgreSQL `ON CONFLICT DO UPDATE command cannot affect row a second time` quando uma equipe tem múltiplas sessões (re-logins) no mesmo dia.

### Cálculo de metas (`getMetasCalculadas`)

```javascript
// Constante histórica acordada com a gestão: meta mensal ÷ 22 = meta diária
diaria    = mensal / 22               // NÃO usa dias úteis reais do mês
semanal   = diaria * 5
ateHoje   = diaria * diasUteisAte()   // proporcional ao dia atual
realizado = SUM(count) FROM daily_totals WHERE month = X AND regional = Y AND tipo_code = Z
percentual = (realizado / ateHoje) * 100
saldo     = realizado - ateHoje       // positivo = adiantado, negativo = atrasado
```

---

## 7. Autenticação (JWT)

### Visão geral

Autenticação implementada **sem dependências externas** usando o módulo nativo `crypto` do Node.js. Tokens JWT com assinatura HMAC-SHA256.

- **Sessões**: 8 horas
- **Armazenamento no cliente**: `localStorage` (`wpa-token`, `wpa-user`)
- **Transmissão**: header `Authorization: Bearer <token>` em todas as chamadas `/api/*`

### Rota pública de login

```
POST /api/auth/login
Content-Type: application/json

{ "username": "admin", "password": "suasenha" }
```

Resposta de sucesso:
```json
{
  "token":    "<JWT>",
  "username": "admin",
  "role":     "admin",
  "regional": "ALL",
  "exp":      1234567890
}
```

Esta é a **única rota pública**. Todas as demais rotas `/api/*` exigem Bearer token válido.

### Middleware server-side (`authMiddleware`)

1. Verifica presença do header `Authorization: Bearer`.
2. Valida assinatura HMAC-SHA256 do token com `JWT_SECRET`.
3. Verifica expiração (`payload.exp < now`).
4. Seta `req.user = { username, role, regional, exp }`.
5. **Para usuários não-admin**: sobrescreve `req.query.regional` e `req.body.regional` com o regional do JWT. Isso impede contorno via manipulação de URL — a restrição é aplicada no servidor.

### Papéis (roles)

| Role | Descrição | Regional no JWT |
|------|-----------|-----------------|
| `admin` | Acesso total — todas as regionais, aba Admin, edição de metas | `ALL` |
| `gua` | Somente Guarapari — dados GUA, sem Admin | `GUA` |
| `cac` | Somente Cachoeiro — dados CAC, sem Admin | `CAC` |

### Configuração de usuários

Usuários são definidos na variável `AUTH_USERS` do `.env`. Formato:

```
usuario1:sha256(senha1):role1:regional1,usuario2:sha256(senha2):role2:regional2
```

Exemplo completo:
```dotenv
AUTH_USERS=admin:HASH_ADMIN:admin:ALL,guarapari:HASH_GUA:gua:GUA,cachoeiro:HASH_CAC:cac:CAC
```

Geração de hash SHA-256:
```bash
# Linux / macOS
echo -n "suasenha" | sha256sum

# PowerShell (Windows)
[System.BitConverter]::ToString(
  [System.Security.Cryptography.SHA256]::Create().ComputeHash(
    [System.Text.Encoding]::UTF8.GetBytes("suasenha")
  )
).Replace("-","").ToLower()
```

### Hashes de exemplo (senhas para configuração inicial — altere imediatamente em produção)

| Usuário | Senha de exemplo | Hash SHA-256 |
|---------|------------------|--------------|
| `admin` | `Engelmig@2025` | `a1a15919c9895c3e7f52c2e5fb9bf0be412eff2f0e05e4b91733ed304a5a5797` |
| `guarapari` | `Guarapari@2025` | `e1e7753b136e9a059eb1a685e25e949e9f6f3f82fdda685949ff269d458fb303` |
| `cachoeiro` | `Cachoeiro@2025` | `204b0f28183908cf80a3920798e7be6c89db96fd7a17ecb51cf82a0589d98309` |

### Status da autenticação (abril/2026)

| Componente | Status |
|------------|--------|
| `middleware/auth.js` (backend) | ✅ Implementado e em produção |
| `routes/index.js` — `POST /api/auth/login` | ✅ Implementado |
| `routes/index.js` — `router.use(authMiddleware)` | ✅ Implementado |
| `.env.example` — campos `JWT_SECRET` e `AUTH_USERS` | ✅ Documentado |
| Frontend — tela de login, overlay, gestão de token no `index.html` | ⏳ Pendente |

---

## 8. Cron Jobs

Gerenciados por `services/cronService.js` usando `node-cron`. Só ativados quando `DATA_MODE=wpa`.

| Job | Expressão cron | Janela | Ação |
|-----|---------------|--------|------|
| Renovação de token WPA | `*/45 * * * *` | 24/7 | `forceRefresh()` — mantém JWT WPA sempre fresco |
| Snapshot | `*/15 6-20 * * *` | 06h–20h BRT | Busca todas as equipes, grava em 4 tabelas Supabase |
| Consolidação diária | `30 20 * * *` | Diariamente 20:30 BRT | Finaliza `daily_totals` e `team_daily_totals` com concluídas apenas |

Todos os jobs usam `timezone: 'America/Sao_Paulo'`.

**Comportamento no startup do servidor:**
- Token WPA renovado 2 segundos após iniciar.
- Snapshot executado 5 segundos após iniciar, se `hora >= 6 && hora <= 20`.

---

## 9. Webhook de Auto-Deploy

Permite deploy automático via GitHub sem acesso SSH direto ao servidor.

### Endpoint

```
POST /webhook/deploy
```

**Importante**: este endpoint deve ser definido em `server.js` **antes** de `app.use(express.json())`. Usa `express.raw({ type: 'application/json' })` para preservar o body bruto para verificação HMAC. Se `express.json()` rodar primeiro, o body é consumido e o HMAC falha silenciosamente.

### Segurança

Verificação via `crypto.timingSafeEqual(assinatura_github, sha256=HMAC(WEBHOOK_SECRET, bodyBruto))`.

### Ação executada

```bash
git pull origin main && npm install --production && pm2 restart wpa-monitor
```

Executado de forma assíncrona — o servidor responde `200 OK` imediatamente.

### Configuração no GitHub

1. **Settings → Webhooks → Add webhook**
2. **Payload URL**: `https://ip-do-servidor:porta/webhook/deploy`
3. **Content type**: `application/json`
4. **Secret**: mesmo valor do `WEBHOOK_SECRET` no `.env`
5. **Trigger**: "Just the push event"
6. Ativa apenas para push no branch `main` (`payload.ref === 'refs/heads/main'`)

> **Status atual**: a porta 3002 está bloqueada pelo firewall corporativo. O deploy manual é usado no momento:
> ```bash
> cd ~/zouain/prod && git pull origin main && pm2 restart wpa-monitor
> ```

---

## 10. Frontend — Abas e Funcionalidades

Single Page Application implementada em um único arquivo `index.html`, sem bundler, sem framework, sem build step. Todo CSS e JavaScript estão embutidos.

### Identidade Visual Engelmig

A interface segue o [Manual de Marca Engelmig Energia](https://www.engelmig.com.br):

- **Logo**: imagem original da empresa embarcada como data URI Base64 diretamente no HTML. Isso evita problemas de encoding com o nome do arquivo (`Cabeçalho Engelmig Energia.png`) e elimina dependência de serving de arquivo estático.
- **Tipografia**: Tahoma Bold para títulos e cabeçalhos; Roboto / sans-serif para corpo de texto.
- **Hierarquia de cores** (variáveis CSS `--amarelo`, `--verde`, `--preto`, `--vermelho`, `--branco`):
  - `--amarelo: #FEC40E` — cor de ação primária, abas ativas, botões, destaques
  - `--verde: #086738` — badges de sucesso, acentos regionais
  - `--preto: #231F20` — cabeçalho da página, headers de tabelas e cards (não é preto 100%)
  - `--vermelho: #ED1C24` — alertas, erros, rejeitadas
- **Textura de raios**: padrão SVG inline de relâmpagos com opacidade 4,5% no fundo da página — elemento gráfico da marca.

### Tipos de serviço (TIPOS_SERVICO)

```javascript
{
  LN: 'Ligação Nova',
  LE: 'Ligação Existente',
  DL: 'Desligamento',
  MD: 'Modificação',
  SF: 'Suspensão de Fornecimento',
  RL: 'Religa',
  UG: 'Uso Geral',
  DD: 'Falhas para Distribuição',
  II: 'Inspeção de Irregularidade',
  PO: 'Ordem Prioritária',
  SO: 'SO',   // nome completo a confirmar com EDP
  RD: 'RD',   // nome completo a confirmar com EDP
}
```

### Aba Monitor (padrão)

Visão ao vivo das equipes em campo.

**Filtros disponíveis:**
- **Regional**: ALL / Guarapari / Cachoeiro
- **Período De/Até**: padrão = hoje. Quando De = Até = hoje → dados ao vivo com auto-refresh a cada 5 min. Quando qualquer data passada → dados históricos do Supabase, badge "📅 HISTÓRICO" visível, botão "↩ Hoje" para retornar ao vivo.
- **Tipos de OS**: dropdown multi-seleção com checkboxes; atalhos "Todos" / "Nenhum"
- **Busca textual**: filtra por nome de equipe

**Cards de equipe:**
- Cabeçalho: nome da equipe, regional, placa do veículo, horário de início de sessão
- Contadores: Baixadas / Em Andamento / Concluídas / Rejeitadas
- Lista de colaboradores
- Chips de notas ativas (clicáveis → abre modal com detalhes)

**Seção de produtividade:**
- `calcTotaisPorRegional(teams)` agrega `notasExecutadas + notasConcluidas` filtradas pelos tipos selecionados
- Barra de progresso por tipo vs. meta (`_metasCache[regional][tipoCode]`)

**Modal de detalhes da equipe:**
- Cabeçalho: nome + regional + setor
- Todas as notas da equipe organizadas por status
- Informações de colaboradores com matrícula e cargo
- Dados da sessão: início, fim, veículo

### Aba Metas

Visualização e configuração das metas mensais.

**Visão de progresso:**
- Seletor de mês/ano
- Cards informativos: dias úteis total/decorridos/restantes/semana atual
- Por regional: um card por tipo de OS com valor realizado, meta proporcional ao dia, percentual e saldo (positivo = adiantado em verde; levemente negativo = amarelo; muito negativo = vermelho)

**Edição de metas (somente admin):**
- Formulário com um input por tipo × regional
- Salva via `POST /api/metas` com persistência no Supabase
- Protegido por senha (frontend)

### Aba Ranking

Ranking comparativo de produtividade.

- Seletor de regional e período (mês)
- Fonte: `GET /api/ranking/equipes`
- Tabela: posição (medalhas para top 3), equipe, regional, colunas dinâmicas por tipo de OS, total
- Destaque visual para ouro, prata e bronze

### Aba Histórico

Consulta detalhada do histórico de sessões por equipe e por dia.

**Filtros:**
- **De/Até** (datas livres — não limitado a um único mês como era antes)
- **Regional**: recarrega dados ao mudar
- **Equipe**: dropdown populado com as equipes presentes no período (client-side)
- **Colaborador**: filtro de texto livre por nome ou matrícula (client-side)

**Exibição por dia (agrupado):**
- Linha principal: data, equipe, badge com número de colaboradores, colunas por tipo de OS, total de concluídas
- O badge mostra "X colab." — **não** exibe matrícula EDP (a matrícula visível é a do sistema EDP, não da Engelmig)

**Expansão de linha (click):**
- 🕐 Sessão(ões): hora início/fim; badge RELOGIN se houver múltiplas sessões
- 🚗 Placa do veículo
- 👷 Colaboradores: matrícula (monospace) + nome completo
- 📋 Notas por tipo com quantidade

**Funções JS principais:**
```javascript
loadHistorico()           // fetch /api/historico/sessoes?de=&ate=, cacheia em _histDias
popularHistTeamSelect()   // popula dropdown de equipes com os dados do cache
applyHistoricoFilters()   // filtra client-side por equipe + colaborador
renderHistorico(rows)     // constrói tabela expansível
toggleHistDetail(rowId)   // expande/colapsa uma linha
```

### Aba Admin

**Acesso**: somente role `admin`.

Seções disponíveis:
1. **Token WPA**: status atual (válido/expirado, tempo restante, timestamp de expiração), botão para renovação manual
2. **Backfill Histórico**: inputs De/Até → `POST /api/admin/backfill/range` — importa dados históricos da API WPA para o Supabase; exibe barra de progresso e log linha a linha
3. **Consolidar Dia**: input de data → `POST /api/admin/consolidar?date=YYYY-MM-DD` — reprocessa um dia específico
4. **Snapshot Manual**: botão → `POST /api/admin/snapshot` — captura imediata como se o cron tivesse disparado

---

## 11. Variáveis de Ambiente (.env)

Copie `.env.example` para `.env` e preencha os valores reais antes de iniciar o servidor.

```dotenv
# ── MODO DE DADOS ──────────────────────────────────────────────────────────────
# "wpa"      → servidor interno Engelmig (API WPA ao vivo, grava no Supabase)
# "supabase" → Vercel / edge (lê Supabase, sem acesso ao WPA)
# "mock"     → dados simulados para desenvolvimento offline
DATA_MODE=wpa

# ── WPA API (somente no servidor interno) ─────────────────────────────────────
WPA_URL=https://edp-wpa-po.azurewebsites.net
WPA_API_URL=https://edp-wpa-web-api.azurewebsites.net
WPA_USERNAME=seu_usuario@engelmig.com.br
WPA_PASSWORD="sua_senha"

# ── SUPABASE ──────────────────────────────────────────────────────────────────
SUPABASE_URL=https://iyadtjzehhebwojreudz.supabase.co
# service_role key — NUNCA expor no frontend; somente servidor e Vercel server-side
SUPABASE_SERVICE_KEY=sua_service_role_key

# ── SERVIDOR ──────────────────────────────────────────────────────────────────
PORT=3002

# ── WEBHOOK DE DEPLOY (GitHub → servidor Linux) ───────────────────────────────
# Qualquer string secreta aleatória e longa — use a mesma no GitHub e aqui
WEBHOOK_SECRET=sua_chave_secreta_aqui

# ── AUTENTICAÇÃO ──────────────────────────────────────────────────────────────
# Chave secreta para assinar JWT — use uma string longa e aleatória (mín. 32 chars)
JWT_SECRET=mude-esta-chave-para-algo-seguro-e-longo

# Usuários: usuario:sha256(senha):role:regional — separados por vírgula
# Roles:     admin (acesso total) | gua (só Guarapari) | cac (só Cachoeiro)
# Regionais: ALL                  | GUA                | CAC
AUTH_USERS=admin:HASH_ADMIN:admin:ALL,guarapari:HASH_GUA:gua:GUA,cachoeiro:HASH_CAC:cac:CAC
```

### Referência de todas as variáveis

| Variável | Obrigatória em | Descrição |
|----------|----------------|-----------|
| `DATA_MODE` | ambos | `wpa` \| `supabase` \| `mock` |
| `WPA_URL` | Servidor Linux | Base URL de autenticação WPA |
| `WPA_API_URL` | Servidor Linux | Base URL da API WPA |
| `WPA_USERNAME` | Servidor Linux | Login EDP WPA |
| `WPA_PASSWORD` | Servidor Linux | Senha EDP WPA |
| `SUPABASE_URL` | ambos | URL do projeto Supabase |
| `SUPABASE_SERVICE_KEY` | ambos | Chave `service_role` — somente servidor |
| `PORT` | Servidor Linux | Padrão `3002` |
| `WEBHOOK_SECRET` | Servidor Linux | Segredo HMAC do webhook GitHub |
| `JWT_SECRET` | ambos | Segredo para assinar JWTs da aplicação |
| `AUTH_USERS` | ambos | Lista de usuários com hashes SHA-256 |
| `VERCEL` | Vercel (automático) | Definido pelo runtime Vercel; desativa `app.listen()` |

---

## 12. Como Rodar Localmente

### Pré-requisitos

- **Node.js** v18 ou superior
- **npm** v9 ou superior

### Passo a passo

```bash
# 1. Clone o repositório
git clone git@github.com:engelmig/prod-stc.git
cd prod-stc

# 2. Instale as dependências
npm install

# 3. Configure o ambiente
cp .env.example .env
# Edite .env com suas credenciais

# 4. Inicie em modo de desenvolvimento (auto-reload com nodemon)
npm run dev

# 5. Ou inicie em modo de produção
npm start
```

Acesse: `http://localhost:3002`

### Desenvolvimento offline (sem WPA, sem Supabase)

Configure `.env` com `DATA_MODE=mock`. Nenhuma conexão externa será feita.

### Windows — atalho rápido

Execute `iniciar.bat` para iniciar com `npm start`.

---

## 13. Deploy em Produção (Linux + PM2)

### Setup inicial (executado uma única vez)

```bash
# 1. Instalar Node.js via NVM
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20

# 2. Instalar PM2 globalmente
npm install -g pm2

# 3. Clonar o repositório
mkdir -p ~/zouain
cd ~/zouain
git clone git@github.com:engelmig/prod-stc.git prod
cd prod

# 4. Configurar .env
cp .env.example .env
nano .env   # preencher com valores reais de produção

# 5. Instalar dependências
npm install --production

# 6. Iniciar com PM2
pm2 start server.js --name wpa-monitor

# 7. Persistir configuração do PM2 (reinicia automaticamente após reboot do servidor)
pm2 save
pm2 startup   # execute o comando gerado por este comando
```

### Atualização manual (uso atual)

```bash
cd ~/zouain/prod
git pull origin main
npm install --production
pm2 restart wpa-monitor
```

### Comandos PM2 úteis

```bash
pm2 status                          # Lista todos os processos
pm2 logs wpa-monitor                # Logs em tempo real
pm2 logs wpa-monitor --lines 200    # Últimas 200 linhas
pm2 restart wpa-monitor             # Reinicia o processo
pm2 stop wpa-monitor                # Para o processo
pm2 monit                           # Monitor interativo de CPU/memória
pm2 save                            # Salva lista de processos para persistência
```

### Verificar saúde do servidor

```bash
curl http://localhost:3002/health
# Retorno esperado: { "ok": true, "ts": "2026-04-27T..." }
```

---

## 14. Gerenciamento de Usuários

O sistema de usuários é **baseado em variável de ambiente** — sem banco de dados de usuários. Usuários são definidos e gerenciados exclusivamente pelo `AUTH_USERS` no `.env`.

### Adicionar um novo usuário

**1. Gerar hash SHA-256 da senha:**
```bash
# Linux / macOS
echo -n "NovaSenha@2025" | sha256sum

# PowerShell (Windows)
[System.BitConverter]::ToString(
  [System.Security.Cryptography.SHA256]::Create().ComputeHash(
    [System.Text.Encoding]::UTF8.GetBytes("NovaSenha@2025")
  )
).Replace("-","").ToLower()
```

**2. Adicionar ao `AUTH_USERS` no `.env`:**
```dotenv
AUTH_USERS=...,novouser:HASH_AQUI:gua:GUA
```

**3. Reiniciar o servidor:**
```bash
pm2 restart wpa-monitor
```

O servidor lê `AUTH_USERS` a cada tentativa de login — não há cache de usuários.

### Alterar senha

Gere o novo hash, substitua no `AUTH_USERS`, reinicie. JWTs existentes com a senha antiga continuam válidos até expirarem (máximo 8 horas).

### Revogar acesso imediato

Para revogar acesso imediatamente (antes do JWT expirar), remova o usuário do `AUTH_USERS` **e** altere o `JWT_SECRET`. Alterar o `JWT_SECRET` invalida **todos** os tokens ativos de todos os usuários.

---

## 15. Restrições Conhecidas e Armadilhas

1. **API WPA não documentada.** Todos os campos, endpoints e comportamentos foram descobertos por engenharia reversa via DevTools do navegador e Postman. Mudanças na API EDP podem quebrar o sistema sem aviso.

2. **`sessions/all/date` retorna `Collaborators: []` sempre.** O endpoint de sessões históricas nunca retorna colaboradores reais. O único modo de obter colaboradores é chamando `GET /api/Sessions/{sessionId}` individualmente. O `getTeamsByDate()` faz isso em paralelo via `Promise.all`.

3. **Sufixo `/session` obrigatório nos endpoints de notas.** `GET /api/notes/{categoria}/{sessionId}/session` — sem o sufixo, o endpoint retorna estrutura diferente e inútil. Confirmado via DevTools.

4. **Status 9→4 desaparecem do V2 após sync.** Notas concluídas no mobile (status 9) somem da API quando o backend as sincroniza (status 4). O acumulador `_acc` em `wpaService.js` injeta de volta notas já vistas dentro do mesmo dia. Reinicia à meia-noite.

5. **Limite de 1.000 linhas do Supabase é silencioso.** O cliente JS retorna exatamente 1.000 linhas sem erro quando o resultado foi truncado. `getTeamSessionHistory` usa paginação com `.range()` para contornar isso.

6. **Múltiplas sessões (re-logins) no mesmo dia.** Uma equipe pode desconectar e reconectar. `upsertTeamDailyTotals` agrupa por `team_name` antes de enviar ao Supabase para evitar o erro `ON CONFLICT DO UPDATE command cannot affect row a second time`.

7. **Colunas `DATE` do PostgreSQL não aceitam LIKE.** Sempre usar `filterByMonth()` com `.gte()/.lt()`. Usar `LIKE` em coluna `DATE` gera `operator does not exist: date ~~ unknown`.

8. **Webhook requer ordem de middleware.** `POST /webhook/deploy` deve ser registrado **antes** de `app.use(express.json())`. Usar `express.raw()` no endpoint preserva o body bruto para HMAC.

9. **`service_role` nunca deve chegar ao browser.** Esta chave contorna RLS no Supabase. Somente no `.env` do servidor Linux e nas variáveis de ambiente do Vercel (server-side).

10. **Constante 22 para meta diária.** `diaria = mensal / 22` usa o número fixo 22, não os dias úteis reais do mês. Foi acordado assim com a gestão. Alterar exige mudança em `getMetasCalculadas` no `db/supabaseQueries.js`.

11. **Inflação intraday no `daily_totals`.** Durante o dia, `daily_totals` contém `executadas + concluidas`. Após a consolidação das 20:30, é sobrescrito com `concluidas` apenas. Meses passados mostram sempre o valor definitivo; o dia atual pode mostrar número maior.

12. **SO e RD sem nome completo.** Foram encontrados em produção no backfill de abril/2026. Mapeados como `SO: 'SO'` e `RD: 'RD'`. Confirmar nomes completos com EDP para atualizar `TIPOS_SERVICO` no `index.html`.

13. **Logo embarcada como Base64.** O arquivo original `Cabeçalho Engelmig Energia.png` tem caracteres acentuados no nome que causam erros de encoding ao servir como arquivo estático. A solução implementada é embarcar o conteúdo como data URI Base64 diretamente no HTML — elimina a dependência de serving e funciona em qualquer ambiente.

14. **PM2 persistence.** Após o primeiro deploy, executar `pm2 save` para garantir que o processo reinicie automaticamente após reboot do servidor. Sem isso, o processo não volta após reinicialização do OS.

---

## 16. Pendências e Roadmap

### Alta prioridade

#### Login Frontend (backend pronto, frontend pendente)

O backend está 100% funcional e em produção. O `index.html` ainda precisa receber:

**CSS (antes de `</style>`):**
- Overlay full-screen escuro (`position: fixed; inset: 0; z-index: 9999`)
- Card de login centralizado com identidade Engelmig (logo, fundo branco, botão amarelo `#FEC40E`)
- Inputs de usuário/senha com label uppercase
- Chip de usuário logado no header (`user-chip`) com nome, regional e botão "Sair"

**HTML (após `<body>`):**
- `<div id="login-overlay">` com inputs `#login-user` e `#login-pass`
- Botão de login chamando `doLogin()`
- `<div id="login-error">` para mensagens de erro
- `<div id="user-chip">` no `header-right`

**JavaScript (início do bloco `<script>`):**
- `getStoredSession()` — valida sessão do `localStorage` (verifica `exp`)
- `saveSession(data)` — grava token e metadados
- `clearSession()` — remove sessão
- Override de `window.fetch` — injeta `Authorization: Bearer` em chamadas `/api/*` e trata `401`
- `doLogin()` — `POST /api/auth/login`, salva token, inicia app
- `logout()` — limpa sessão, exibe login
- `applyUserPermissions(user)` — oculta botão Admin para não-admin, bloqueia seletor regional
- `showLogin(msg)` / `hideLogin()` — controla overlay
- Encapsular `initTiposFilter()` + `loadData()` + `setInterval` em `function init()` — chamada após auth
- `boot()` — verifica sessão no `localStorage` ao carregar; se válida: `applyUserPermissions()` + `hideLogin()` + `init()`; se inválida: `showLogin()`
- Enter em `#login-pass` → `doLogin()`; Enter em `#login-user` → foco em `#login-pass`

**Configuração em produção:**
- Definir `JWT_SECRET` com string aleatória longa no `.env` do servidor
- Definir `AUTH_USERS` com hashes reais das senhas escolhidas

### Melhorias futuras consideradas

| Feature | Descrição | Complexidade |
|---------|-----------|-------------|
| Exportação CSV/Excel | Download do histórico filtrado | Baixa |
| Deploy Vercel público | Dashboard externo via Vercel + Supabase para acesso de gestores remotos | Baixa |
| Notificações push | Alerta quando equipe para de reportar notas por mais de X horas | Média |
| Alertas de meta | Aviso quando regional está abaixo da meta diária proporcional | Média |
| Gestão de usuários via UI | Tela admin para criar/remover usuários sem editar `.env` | Média |
| Nomes completos SO e RD | Confirmar com EDP e atualizar `TIPOS_SERVICO` | Baixa |
| Mapa de equipes | Exibir localização das equipes via Google Maps API | Alta |

---

## Infraestrutura de Produção

| Componente | Detalhe |
|------------|---------|
| **Servidor Linux** | PM2 process name: `wpa-monitor` · Entry: `server.js` · Path: `~/zouain/prod` |
| **Supabase** | `https://iyadtjzehhebwojreudz.supabase.co` · 5 tabelas · Acesso via `service_role` |
| **Repositório** | Privado (Engelmig) · Branch principal: `main` · Auto-deploy via webhook (pendente desbloqueio de porta) |

---

*Documentação atualizada em abril de 2026 — versão 2.0. Abrange todas as features implementadas até a presente data, incluindo autenticação JWT, filtro De/Até no Histórico, identidade visual Engelmig e remoção da aba Equipes.*
