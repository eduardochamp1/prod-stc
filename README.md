# WPA Monitor — Engelmig Energia

## PROJECT IDENTITY

- **Domain**: Field-team productivity dashboard for Engelmig Energia (electrical utility subcontractor operating under EDP/Neoenergia concession in Espírito Santo, Brazil)
- **Core problem solved**: EDP's WPA (Work Planning & Assignment) system exposes a real-time Azure API but provides no persistent productivity history. This project polls that API every 15 min, accumulates data in Supabase, and serves a multi-tab SPA dashboard.
- **Deployment topology**: Two nodes with distinct roles. Node A = Linux server inside Engelmig's intranet (access to WPA API, runs cron, writes Supabase). Node B = Vercel serverless (public dashboard, reads Supabase only, no WPA access).

---

## RUNTIME MODES — `DATA_MODE` env var

| Value | Where | Behavior |
|---|---|---|
| `wpa` | Linux server (PM2) | Fetches live from WPA API; cron writes Supabase every 15 min; full R/W |
| `supabase` | Vercel serverless | Reads Supabase only; no WPA access; no cron capability |
| `mock` | Local dev | Returns static fixture data; no external calls |

**Critical invariant**: `server.js` starts `cronService` only when `DATA_MODE === 'wpa'`. `routes/index.js` loads `supabaseQueries` for all modes except `mock` (lazy singleton via `sbq()`). The Vercel entry-point is detected by `process.env.VERCEL`; when truthy, `server.js` exports `app` without calling `app.listen()`.

---

## FILE MAP

```
server.js               Entry point. Express app. Webhook handler (MUST be before express.json()).
routes/index.js         All API routes. Lazy-loads supabaseQueries (sbq()) and cronService.
services/
  wpaService.js         WPA Azure API auth + fetch. JWT cache. V2 note API. Historical fetch. Daily accumulator.
  dataService.js        Mode-aware data abstraction (mock | wpa). Maps sectorId → regional.
  supabaseClient.js     Singleton Supabase client (service_role key, server-only).
  supabasePush.js       All Supabase writes: snapshots, teams_current, daily_totals, team_daily_totals.
  cronService.js        node-cron: token refresh 45 min (24/7), snapshot 15 min (06-20h), consolidation 20:30.
db/
  supabaseQueries.js    All Supabase reads. filterByMonth() helper. Goal calculations. Historical snapshot query.
mock/mockData.js        Static fixtures for DATA_MODE=mock.
index.html              Single-file SPA. 5 tabs. Vanilla JS + CSS. No build step.
vercel.json             Routes all traffic to server.js.
supabase/schema.sql     Reference DDL for all 5 tables.
```

---

## WPA API INTEGRATION (`services/wpaService.js`)

### Auth
- **Auth URL**: `https://edp-wpa-po.azurewebsites.net/identity/signin`
- **Method**: `POST application/x-www-form-urlencoded` with `Username`, `Password`
- **Header required**: `X-Requested-With: XMLHttpRequest`
- **Response**: `{ Token: "<JWT>", UserId: "..." }`
- JWT cached in module-scope `_token`; refreshed 60 s before expiry (`_expireAt`). Fallback TTL = 1 h.
- `forceRefresh()` — forces re-login regardless of TTL. Called by cron every 45 min and on server start.
- `getTokenStatus()` — returns `{ valid, reason, expiresAt, expiresIn }` without making network call.

### API Bases
- **Auth URL**: `https://edp-wpa-po.azurewebsites.net`
- **API URL**: `https://edp-wpa-web-api.azurewebsites.net`
- All API requests: `Authorization: Bearer <token>`

### Live Endpoints (current data)

| Endpoint | Method | Description |
|---|---|---|
| `GET /api/sessions/current?sectorId={sid}` | GET | Active sessions. Sole source of `Team.CompanyId` for Engelmig filter. Also has vehicle plate. |
| `GET /api/teamsstatus/V2?sectorId={sid}&filterByExhibitionSector=true` | GET | V2 note arrays per team: `Concluded[]`, `Downloaded[]`, `Executed[]`, `Rejected[]` |
| `GET /api/route/preroute?sectorId={sid}` | GET | Returns `WalletCount` per team (carteira size) |

### Historical Endpoints (past dates)

| Endpoint | Method | Description |
|---|---|---|
| `POST /api/Sessions/all/date?sectorId={sid}&date=M/D/YYYY` | POST | All sessions for a specific date. Body empty. |
| `GET /api/notes/executed/{sessionId}` | GET | Concluded notes for a session. Array with `Number`, `Type`, `ConclusionDate`. |
| `GET /api/notes/downloaded/{sessionId}` | GET | Downloaded notes for a session. |
| `GET /api/notes/rejected/{sessionId}` | GET | Rejected notes for a session. |

> **Historical note**: `GET /api/notes/execution?sectorId={sid}&date=M/D/YYYY` exists but returns only notes still in the system (not yet exported to ERP). Per-session endpoints are more reliable for historical data.

### V2 Note Architecture (`getTeamsBySector`)

Two parallel calls per sector:
1. `GET /api/sessions/current` → filter Engelmig sessions by `CompanyId`, get vehicle plate
2. `GET /api/teamsstatus/V2` → get note arrays per team

V2 returns structured arrays instead of a flat note list. Match V2 data to sessions by `Team.Id` (primary) or `Team.Name` (fallback).

**V2 ExecutionStatus mapping:**
```
1 → baixada   (in wallet, waiting)
2 → baixada   (in wallet variant)
3 → executada (in progress)
6 → executada (actively working on note)
7 → executada (in progress variant)
4 → concluida (exported/synced)
5 → concluida (exported variant)
9 → concluida (mobile pending sync)
```

**`carteiraCount`**: sourced from `preroute` endpoint's `WalletCount` — this is the authoritative wallet size. The `Downloaded[]` array in V2 is used for note-level details but `WalletCount` is the count shown in the UI.

### Company Filter
Only sessions where `session.Team.CompanyId === '92a2f98e-8877-433e-8358-173b94c13a54'` are kept. This is Engelmig's UUID in EDP's system.

### Sector → Regional Mapping
```javascript
REGIONAL_MAP = { DESG: 'GUA', DEPT: 'GUA', DESC: 'CAC' }
SETORES      = { GUA: ['DESG','DEPT'], CAC: ['DESC'], ALL: ['DESG','DEPT','DESC'] }
```

### Daily Accumulator (`_acc`)
**Problem**: Notes synced (status 9→4) disappear from the V2 API. If polled after sync, count drops.
**Solution**: In-memory `Map` keyed by `noteId`. Every `getTeamsBySector` call records all executadas + concluidas. `_accApply()` re-injects previously seen notes on the next poll. Resets at midnight.

### Historical Fetch (`getTeamsByDate`)
Used by the backfill endpoint. Per-sector strategy:
1. `POST /api/Sessions/all/date` → get sessions for the date, filter by Engelmig `CompanyId`
2. For each Engelmig session: call `GET /api/notes/executed/{sessionId}`, `downloaded/{sessionId}`, `rejected/{sessionId}` in parallel
3. Map `executed` → `notasConcluidas`, `downloaded` → `notasBaixadas`, `rejected` → `notasRejeitadas`
4. Merge multiple sessions for same team (relogins) deduplicating by note code

> **Limitation**: Per-session note endpoints only return data while the session is still active or recently closed. Fully exported historical sessions return empty arrays. This means backfill data is partial for dates more than ~1 day old.

### Note Object (normalized)
```javascript
{
  codigo:   string,   // note number (e.g. "015001763337")
  tipoCode: string,   // service type (e.g. "LN", "LE", "DL")
  tipoNome: string,   // same as tipoCode for historical (full name from V2 when available)
  status:   string,   // "baixada" | "executada" | "concluida" | "rejeitada"
}
```

### Normalized Team Object
```javascript
{
  id:             string,          // WPA session ID
  sigla:          string,          // team code (e.g. "EPVGA30")
  teamName:       string,          // same as sigla
  sectorId:       string,          // "DESG" | "DEPT" | "DESC"
  regional:       string,          // "GUA" | "CAC"
  date:           string,          // "YYYY-MM-DD"
  sessionBegin:   string|null,     // ISO datetime
  sessionEnd:     string|null,     // ISO datetime, null if still active
  vehiclePlate:   string,
  collaborators:  [{nome, matricula, cargo}],
  relogins:       number,
  deviceModel:    string|null,
  appVersion:     string|null,
  carteiraCount:  number,          // WalletCount from preroute (authoritative)
  servicosPerfil: string[],        // unique tipoCode values across all notes
  notasBaixadas:   [Note],         // status baixada
  notasExecutadas: [Note],         // status executada (em andamento)
  notasConcluidas: [Note],         // status concluida (executadas no sentido de produção)
  notasRejeitadas: [Note],
}
```

**UI nomenclature** (differs from internal field names):
| Internal | UI label |
|---|---|
| `notasBaixadas` | OS em Carteira |
| `notasExecutadas` | Em Andamento |
| `notasConcluidas` | OS Executadas |
| `carteiraCount` | OS em Carteira (count) |

---

## CRON JOBS (`services/cronService.js`)

All jobs use `timezone: 'America/Sao_Paulo'`. Only active when `DATA_MODE === 'wpa'`.

| Schedule | Job | Action |
|---|---|---|
| `*/45 * * * *` (every 45 min, 24/7) | Token refresh | `forceRefresh()` — renews WPA JWT proactively |
| `*/15 6-20 * * *` (every 15 min, 06h–20h) | Snapshot | Fetches all teams, writes to 4 Supabase tables |
| `30 20 * * *` (daily 20:30) | Consolidation | Finalizes `daily_totals` and `team_daily_totals` with concluidas-only counts |

**On startup** (with 2 s and 5 s delays respectively):
- Token refresh runs immediately
- Snapshot runs immediately if current hour is between 06h–20h

---

## SUPABASE SCHEMA

All tables use `service_role` key (bypasses RLS). Client singleton in `supabaseClient.js`.

### `snapshots` — raw historical record
```sql
id            BIGSERIAL PK
date          DATE                          -- YYYY-MM-DD
team_name     TEXT
sector_id     TEXT
regional      TEXT
session_begin TIMESTAMPTZ
session_end   TIMESTAMPTZ
vehicle_plate TEXT
baixadas      INTEGER
executadas    INTEGER
concluidas    INTEGER
rejeitadas    INTEGER
captured_at   TIMESTAMPTZ DEFAULT now()
data          JSONB                         -- full normalized team object
```
Write: `INSERT` (never upsert) — one row per team per poll. Grows continuously.
Read: `consolidateDay()` reads to find last snapshot per team for end-of-day finalization.
Read: `getTeamsByDateFromSnapshots(de, ate, regional)` — powers the Monitor date filter.

### `teams_current` — latest state per team
```sql
team_name   TEXT UNIQUE PK
regional    TEXT
sector_id   TEXT
data        JSONB       -- full normalized team object
updated_at  TIMESTAMPTZ
```
Write: `UPSERT ON CONFLICT team_name`. Replaced on every snapshot cycle.
Read: `GET /api/teams` in `supabase` mode (Vercel).

### `daily_totals` — regional-level daily aggregation
```sql
id         BIGSERIAL PK
date       DATE
regional   TEXT
tipo_code  TEXT
count      INTEGER
UNIQUE(date, regional, tipo_code)
```
Intraday: accumulates `executadas + concluidas`. End-of-day: `consolidateDay()` overwrites with `concluidas` only.

### `metas` — monthly productivity targets per regional
```sql
regional  TEXT UNIQUE PK   -- "GUA" | "CAC"
data      JSONB             -- e.g. {"LN": 120, "LE": 80, "DL": 40}
```
Write: `UPSERT ON CONFLICT regional`. Set via dashboard modal (password protected).

### `team_daily_totals` — per-team daily aggregation
```sql
id         BIGSERIAL PK
date       DATE
team_name  TEXT
regional   TEXT
sector_id  TEXT
tipo_code  TEXT
count      INTEGER
UNIQUE(date, team_name, tipo_code)
```
Intraday: `executadas + concluidas`. End-of-day: `concluidas` only.

---

## DATA WRITE PIPELINE (Linux server, DATA_MODE=wpa)

```
node-cron every 45 min (24/7)
  └─ runTokenRefresh()  →  forceRefresh()  →  WPA auth endpoint

node-cron every 15 min (06:00–20:00 BRT)
  └─ runSnapshot()
       ├─ getTeams()                    ← WPA API V2 (all sectors in parallel)
       ├─ saveSnapshot(teams, date)     → INSERT into snapshots
       ├─ pushTeams(teams)              → UPSERT into teams_current
       ├─ upsertDailyTotals(teams)      → UPSERT into daily_totals    (exec+conc, deduped by key)
       └─ upsertTeamDailyTotals(teams)  → UPSERT into team_daily_totals (exec+conc, deduped by key)

node-cron daily at 20:30 BRT
  └─ runConsolidate(date)
       └─ consolidateDay(date)
            ├─ SELECT snapshots WHERE date=today ORDER BY captured_at DESC
            ├─ keep latest row per team_name
            ├─ UPSERT into daily_totals       (concluidas only — authoritative final)
            └─ UPSERT into team_daily_totals  (concluidas only — authoritative final)
```

**Deduplication in upserts**: Before sending to Supabase, rows are accumulated by conflict key in memory. This prevents the PostgreSQL error `ON CONFLICT DO UPDATE command cannot affect row a second time` which occurs when the same team has multiple sessions (relogins) in one day.

---

## HISTORICAL BACKFILL (`POST /api/admin/backfill?date=YYYY-MM-DD`)

Populates Supabase with data from a past date using WPA historical endpoints.

**Flow per sector** (`DESG`, `DEPT`, `DESC` run in parallel):
1. `POST /api/Sessions/all/date` → sessions for that date
2. Filter Engelmig sessions by `CompanyId`
3. For each session: fetch `executed`, `downloaded`, `rejected` note arrays
4. Merge sessions for the same team (relogins), deduplicate notes by code
5. `saveSnapshot(teams, date)` + `upsertDailyTotals` + `upsertTeamDailyTotals`
6. `runConsolidate(date)` — finalize totals

**Limitation**: Notes from fully-exported sessions are not accessible via the per-session endpoints. Backfill data is partial for dates before ~24 h ago.

**Manual loop for April:**
```bash
for d in 01 02 03 04 07 08 09 10 11 14 15 16 17 18 21 22 23 24 25; do
  echo -n "2026-04-$d → "
  curl -s -X POST "http://localhost:3002/api/admin/backfill?date=2026-04-$d"
  echo ""
  sleep 3
done
```

---

## GOAL CALCULATION (`getMetasCalculadas`)

```javascript
// Input: yearMonth = "YYYY-MM"
totalDU    = diasUteisNoMes(year, month)         // Mon–Fri count in full month
decorridos = diasUteisAte(year, month, diaRef)   // Mon–Fri from day 1 to today (or last day if past month)
semanaAtual = Math.ceil(diaRef / 7)

// Per tipo, per regional:
diaria     = mensal / 22          // 22 = fixed constant agreed with management (NOT totalDU)
semanal    = diaria * 5
ateHoje    = diaria * decorridos  // proportional target up to today
realizado  = SUM(count) FROM daily_totals WHERE month = yearMonth AND regional = X AND tipo_code = Y
percentual = (realizado / ateHoje) * 100
saldo      = realizado - ateHoje  // positive = ahead, negative = behind
```

`diaria = mensal / 22` uses the fixed constant 22. Intentional — targets were agreed on a 22-day basis.

---

## API ROUTES (`routes/index.js`)

All routes under `/api`. `sbq()` = lazy singleton for `supabaseQueries`.

### Monitor
| Method | Path | Query params | Notes |
|---|---|---|---|
| GET | `/api/teams` | `regional`, `sectorId` | `supabase` → `teams_current`; `wpa`/`mock` → live |
| GET | `/api/teams/historico` | `de=YYYY-MM-DD`, `ate=YYYY-MM-DD`, `regional` | Snapshots for date range. Single day = latest snapshot per team. Range = latest snapshot + accumulated notes. |
| GET | `/api/teams/:teamId` | — | Searches all sectors |
| GET | `/api/summary` | — | Aggregated per regional |
| GET | `/api/status` | — | Health check + mode/config status |

### Metas
| Method | Path | Query params | Notes |
|---|---|---|---|
| GET | `/api/metas` | — | Raw `{GUA:{},CAC:{}}` |
| POST | `/api/metas` | — | Body: `{GUA:{LN:120,...},CAC:{...}}` |
| GET | `/api/metas/calculadas` | `m=YYYY-MM` | diaria/semanal/ateHoje/realizado/percentual/saldo |

### Histórico
| Method | Path | Query params | Notes |
|---|---|---|---|
| GET | `/api/historico/mes` | `m=YYYY-MM` | Month totals by regional/tipo |
| GET | `/api/historico/diario` | `m=YYYY-MM` | Daily breakdown by regional/tipo |
| GET | `/api/ranking/equipes` | `m=YYYY-MM`, `regional` | Teams ranked by total concluidas |
| GET | `/api/historico/equipes` | `m=YYYY-MM`, `team` | Day-by-day per team |
| GET | `/api/equipes/producao` | `de`, `ate`, `regional`, `team` | Aggregated production, free date range |

### WPA / Admin
| Method | Path | Query params | Notes |
|---|---|---|---|
| GET | `/api/wpa/token-status` | — | Current JWT state without network call |
| POST | `/api/wpa/login` | — | Force WPA re-login |
| GET | `/api/wpa/probe` | `path` | Proxy any WPA endpoint for debugging |
| POST | `/api/admin/snapshot` | — | Manual snapshot trigger |
| POST | `/api/admin/consolidar` | `date=YYYY-MM-DD` | Manual consolidation |
| POST | `/api/admin/backfill` | `date=YYYY-MM-DD` | Historical data import from WPA |

### Debug
| Method | Path | Query params | Notes |
|---|---|---|---|
| GET | `/api/debug/notas` | `sectorId` | Session↔note matching diagnostic (live) |
| GET | `/api/debug/historico` | `sectorId`, `date` | Raw historical sessions (all companies) |
| GET | `/api/debug/historico-notas` | `sectorId`, `date` | Raw historical note structure — shows `byStatus`, `byExecStatus`, field names |
| GET | `/api/debug/preroute` | `sectorId` | Raw preroute/WalletCount structure |
| GET | `/api/debug/teamsstatus` | `sectorId`, `team`, `raw=1` | V2 teamsstatus diagnostic. `raw=1` = raw structure; default = filtered to Engelmig |

---

## FRONTEND SPA (`index.html`)

Single HTML file. No build step, no bundler, no framework. Vanilla JS + CSS custom properties.

### Tab Architecture
```
switchTab(tab)
  monitor   → loadData() on interval; re-loads on date/regional/tipos change
  metas     → loadMetasCalculadas() on switch + month input change
  ranking   → loadRanking() on switch + month/regional change
  historico → loadHistorico() on switch + month/team change
  equipes   → initEquipes() on switch (sets default De/Até) → loadEquipes()
```

### Global State
```javascript
allTeams        // array: current teams (Monitor tab)
currentRegional // "ALL" | "GUA" | "CAC"
currentFilter   // string: team name search
currentTab      // active tab name
selectedTipos   // Set<string>: service type filter (default = all 10 types)
_metasCache     // { GUA:{}, CAC:{} } — fetched once at load
```

### TIPOS_SERVICO
```javascript
{ LN:'Ligação Nova', LE:'Ligação Existente', DL:'Desligamento', MD:'Modificação',
  SF:'Suspensão de Fornecimento', RL:'Religa', UG:'Uso Geral',
  DD:'Falhas para Distribuição', II:'Inspeção de Irregularidade', PO:'Ordem Prioritária' }
```

### Tab: Monitor
**Filter bar**: De / Até (date range) + Regional + Tipos (checkbox dropdown) + Atualizar.

- **De = Até = today** → live data from `GET /api/teams`; auto-refreshes every 5 min
- **Past date or range** → historical data from `GET /api/teams/historico`; badge "📅 HISTÓRICO" shown; button "↩ Hoje" to return to live; auto-refresh paused
- **"Até" validation**: never allowed before "De" (auto-corrected)
- **Tipos filter**: dropdown with checkboxes per service type; "Todos" / "Nenhum" shortcuts; affects produtividade grid and tipo chips in team cards
- **OS cards**: flex-wrap layout — reorganize and center when fewer items are visible

Productivity section: `calcTotaisPorRegional(teams)` aggregates `notasExecutadas + notasConcluidas` filtered by `selectedTipos`. Progress bar per tipo vs `metas[regional][tipoCode]`.

### Tab: Metas (configuração)
**Password protected**: clicking "⚙ Metas" button in header opens a password modal first. Uses `crypto.subtle.digest('SHA-256')` to verify. Hash stored in frontend constant `SENHA_HASH`. Default password: `engelmig2025`.

To change password: generate SHA-256 hash (e.g. https://emn178.github.io/online-tools/sha256.html) and update `SENHA_HASH` in `index.html`.

After authentication: input grid for each `TIPOS_SERVICO × ['GUA','CAC']`. Diária/semanal hints inline. `salvarMetas()` POSTs to `/api/metas`.

Info cards: dias úteis total/decorridos/restantes/semana. Per-regional blocks: one card per tipo with progress bar + saldo pill (green ≥ 0, yellow ≥ −2×diária, red below).

### Tab: Ranking
`GET /api/ranking/equipes`. Table: position (medals top 3), team, regional badge, one column per tipo, total. Tipo columns dynamic from data.

### Tab: Histórico
`GET /api/historico/equipes`. Team select auto-populated. Table: date, team, regional, tipo columns, total.

### Tab: Equipes
`GET /api/equipes/producao`. `initEquipes()` sets De = first day of current month, Até = today. Team select auto-populated. Table: one row per team, tipo columns, footer totals.

---

## WEBHOOK (`server.js`)

Route: `POST /webhook/deploy`

**Critical middleware ordering**: MUST be registered before `app.use(express.json())`. Uses `express.raw({ type: 'application/json' })` to preserve raw body for HMAC. If `express.json()` runs first, body is consumed and HMAC fails silently.

Security: `crypto.timingSafeEqual` on `x-hub-signature-256` vs `sha256=HMAC(WEBHOOK_SECRET, rawBody)`.

Trigger condition: `payload.ref === 'refs/heads/main'` only.

Action: `git pull origin main && npm install --production && pm2 restart wpa-monitor`

> **Current status**: Port 3002 blocked by corporate firewall. Manual deploy in use:
> ```bash
> cd ~/zouain/prod && git pull origin main && pm2 restart wpa-monitor
> ```

---

## ENVIRONMENT VARIABLES

| Variable | Required on | Description |
|---|---|---|
| `DATA_MODE` | both | `wpa` \| `supabase` \| `mock` |
| `WPA_URL` | Linux server | Auth base URL (default: `https://edp-wpa-po.azurewebsites.net`) |
| `WPA_API_URL` | Linux server | API base URL (default: `https://edp-wpa-web-api.azurewebsites.net`) |
| `WPA_USERNAME` | Linux server | EDP WPA login |
| `WPA_PASSWORD` | Linux server | EDP WPA password |
| `SUPABASE_URL` | both | Project URL |
| `SUPABASE_SERVICE_KEY` | both | `service_role` key — server-only, never browser |
| `PORT` | Linux server | Default 3002 |
| `WEBHOOK_SECRET` | Linux server | GitHub webhook HMAC secret |
| `VERCEL` | Vercel (auto) | Set by Vercel runtime; disables `app.listen()` |

---

## INFRASTRUCTURE

### Linux Server (DATA_MODE=wpa)
- PM2 app name: `wpa-monitor`
- Entry: `node server.js`
- All cron TZ: `America/Sao_Paulo`
- Project path: `~/zouain/prod`
- Manual deploy:
  ```bash
  cd ~/zouain/prod && git pull origin main && pm2 restart wpa-monitor
  ```
- First-time setup: after deploy run `pm2 save` to survive reboots

### Vercel (DATA_MODE=supabase)
- `vercel.json` routes all traffic to `server.js` via `@vercel/node`
- `server.js` detects `process.env.VERCEL`, exports `app` without `app.listen()`
- No cron on Vercel — all writes originate from Linux server
- Public URL: `prod-stc.vercel.app`
- GitHub repo: `eduardochamp1/prod-stc` — auto-deploys on push to `main`

### Supabase
- Project URL: `https://iyadtjzehhebwojreudz.supabase.co`
- All access via `service_role` (RLS bypassed)
- 5 tables: `snapshots`, `teams_current`, `daily_totals`, `metas`, `team_daily_totals`

---

## KNOWN CONSTRAINTS & GOTCHAS

1. **WPA API is undocumented.** All field names (`n.Number`, `n.ExecutionStatus`, `s.Team.CompanyId`, etc.) were reverse-engineered via browser devtools, Postman interceptor, and debug endpoints.

2. **V2 vs historical endpoints differ in structure.** Live data uses V2 (`teamsstatus/V2`) with `ExecutionStatus`. Historical endpoints (`notes/execution?date=X`) use flat structure with `Status` and flat `TeamName`/`TeamId` fields (not `Team.Name`/`Team.Id`).

3. **Note status 9→4 sync drop**: Notes completed on mobile (status 9) disappear from the V2 API after backend sync. The in-memory `_acc` accumulator in `wpaService.js` prevents count drops within the same day but resets at midnight.

4. **Historical data is partial**: Per-session note endpoints (`notes/executed/{sessionId}`) only return data for active or recently closed sessions. Fully exported sessions return empty arrays. Backfill for dates more than ~1 day old will have incomplete concluded counts.

5. **Duplicate sessions (relogins)**: A team may have multiple sessions in one day (disconnect + reconnect). Both `getTeamsByDate` and `upsertTeamDailyTotals` merge/deduplicate by team name + note code to prevent the PostgreSQL error `ON CONFLICT DO UPDATE command cannot affect row a second time`.

6. **22-day constant**: All `diaria = mensal / 22` use the fixed constant 22, not actual working days. Changing requires updating `getMetasCalculadas` in `db/supabaseQueries.js`.

7. **Intraday count inflation**: `upsertDailyTotals` counts `executadas + concluidas` during the day. `consolidateDay` at 20:30 overwrites with `concluidas` only. Historical months always show final values; current day may show a higher number.

8. **PostgreSQL DATE columns**: `LIKE` / `~~` operator does not work on `DATE` columns. Always use `filterByMonth()` with `.gte()/.lt()` range. Error: `operator does not exist: date ~~ unknown`.

9. **No RLS on Supabase**: All tables accessed via `service_role`. Key must never reach the browser — server-only (Linux `.env` and Vercel env vars).

10. **PM2 persistence**: Run `pm2 save` after first deploy to survive reboots. `pm2 restart wpa-monitor` required after every code change.

11. **`express.raw` middleware ordering**: `POST /webhook/deploy` MUST be defined before `app.use(express.json())`. Reversing this silently breaks HMAC.

12. **Metas password is frontend-only**: The SHA-256 verification runs in the browser. It prevents casual access but is not a security boundary — the `/api/metas` POST endpoint has no server-side auth. Suitable for internal use only.
