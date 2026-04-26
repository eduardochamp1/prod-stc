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
  wpaService.js         WPA Azure API auth + fetch. JWT cache. Daily note accumulator.
  dataService.js        Mode-aware data abstraction (mock | wpa). Maps sectorId → regional.
  supabaseClient.js     Singleton Supabase client (service_role key, server-only).
  supabasePush.js       All Supabase writes: snapshots, teams_current, daily_totals, team_daily_totals.
  cronService.js        node-cron jobs: snapshot every 15 min (06-20h BRT), consolidation at 20:30 BRT.
db/
  supabaseQueries.js    All Supabase reads. filterByMonth() helper. Goal calculations.
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

### API Base
- **API URL**: `https://edp-wpa-web-api.azurewebsites.net`
- All requests: `Authorization: Bearer <token>`

### Key Endpoints Used
| Endpoint | Description |
|---|---|
| `GET /api/sessions/current?sectorId={sid}` | Active team sessions. Returns `{ Data: [Session] }` |
| `GET /api/notes/execution?sectorId={sid}` | Work orders in execution today. Returns `{ Data: { Notes: [Note] } }` |
| `GET /api/route/preroute?sectorId={sid}` | Team wallet (future notes). Returns `{ Data: [...] }` |

### Note Status Codes (WPA proprietary)
```
1 = baixada    (dispatched to device)
2 = executada  (team accepted / in progress)
3 = rejeitada  (rejected by team)
4 = exportada  (completed + synced to backend)  ← counts as done
9 = concluida  (completed on mobile, sync pending) ← counts as done
```
Status 4 and 9 both count as "completed". Status 9 disappears from the API after sync (becomes 4 and leaves execution endpoint). **This is the main data integrity risk.**

### Daily Accumulator (`_acc`)
**Problem**: When a note syncs (status 9→4), it disappears from `GET /api/notes/execution`. If polled after sync, the count drops.
**Solution**: In-memory `Map` keyed by `noteId`. Every call to `getTeamsBySector` records all status-2 and status-9/4 notes seen. On the next poll, `_accApply()` re-injects previously seen notes that are no longer in the API response. Accumulator resets at midnight (compares `YYYY-MM-DD` string).

### Company Filter
Only sessions where `session.Team.CompanyId === '92a2f98e-8877-433e-8358-173b94c13a54'` are kept. This is Engelmig's UUID in EDP's system. Other companies share the same WPA sectors; this filter is essential.

### Note↔Session Matching
Notes are matched to sessions by `Team.Name` (exact string match). Fallback: match by `Team.Id`. Mismatch between session team name and note team name is a known risk — the `/api/debug/notas` endpoint was built to diagnose this.

### Sector → Regional Mapping
```javascript
REGIONAL_MAP = { DESG: 'GUA', DEPT: 'GUA', DESC: 'CAC' }
SETORES = { GUA: ['DESG','DEPT'], CAC: ['DESC'], ALL: ['DESG','DEPT','DESC'] }
```
`getTeams()` calls `getTeamsBySector()` in parallel for each sector, then flattens results.

---

## NORMALIZED TEAM OBJECT (output of `normalizarSessao`)

```javascript
{
  id:             string,          // WPA session ID
  sigla:          string,          // team name (e.g. "EPICO30")
  teamName:       string,          // same as sigla
  sectorId:       string,          // "DESG" | "DEPT" | "DESC"
  regional:       string,          // "GUA" | "CAC"
  date:           string,          // "YYYY-MM-DD"
  sessionBegin:   string|null,     // ISO datetime
  sessionEnd:     string|null,     // ISO datetime, null if active
  vehiclePlate:   string,
  collaborators:  [{nome, matricula, cargo}],
  relogins:       number,
  deviceModel:    string|null,
  appVersion:     string|null,
  teamStatus:     any,
  servicosPerfil: string[],        // unique tipoCode values
  notasBaixadas:   [{codigo, tipoCode, tipoNome, status}],
  notasExecutadas: [{...}],
  notasConcluidas: [{...}],        // status 4 or 9
  notasRejeitadas: [{...}],
}
```
`tipoCode` values: `LN LE DL MD SF RL UG DD II PO` (service type abbreviations).

---

## SUPABASE SCHEMA

All tables use `service_role` key (bypasses RLS). Client singleton in `supabaseClient.js`.

### `snapshots` — raw historical record
```sql
id            BIGSERIAL PK
date          DATE
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
data          JSONB       -- full normalized team object
```
Write: `INSERT` (never upsert) — one row per team per poll. Grows continuously.
Read: `consolidateDay()` reads to find last snapshot per team for end-of-day finalization.

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
Intraday: `upsertDailyTotals()` upserts after every snapshot — accumulates executadas + concluidas.
End-of-day: `consolidateDay()` overwrites with final count from last snapshot (concluidas only).
Read: `getMonthTotals()`, `getDailyHistory()` for Metas and Histórico tabs.

### `metas` — monthly productivity targets per regional
```sql
regional  TEXT UNIQUE PK   -- "GUA" | "CAC"
data      JSONB             -- e.g. {"LN": 120, "LE": 80, "DL": 40}
```
Write: `UPSERT ON CONFLICT regional`. Set via dashboard modal.
Read: `getMetas()` → `{ GUA: {LN:120,...}, CAC: {...} }`

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
Intraday: `upsertTeamDailyTotals()` upserts after every snapshot — executadas + concluidas.
End-of-day: `consolidateDay()` overwrites with concluidas only from last snapshot.
Read: `getTeamRanking()`, `getTeamDailyHistory()`, `getTeamProducao()`.

---

## DATA WRITE PIPELINE (runs on Linux server, DATA_MODE=wpa)

```
node-cron every 15 min (06:00–20:00 BRT, Mon–Sun)
  └─ runSnapshot()
       ├─ getTeams()                    ← WPA API (all sectors in parallel)
       ├─ saveSnapshot(teams)           → INSERT into snapshots
       ├─ pushTeams(teams)              → UPSERT into teams_current
       ├─ upsertDailyTotals(teams)      → UPSERT into daily_totals    (executadas+concluidas)
       └─ upsertTeamDailyTotals(teams)  → UPSERT into team_daily_totals (executadas+concluidas)

node-cron every day at 20:30 BRT
  └─ runConsolidate(date)
       └─ consolidateDay(date)
            ├─ SELECT snapshots WHERE date=today ORDER BY captured_at DESC
            ├─ keep only latest row per team_name
            ├─ UPSERT into daily_totals       (concluidas only — authoritative final count)
            └─ UPSERT into team_daily_totals  (concluidas only — authoritative final count)
```

Intraday vs consolidated: During the day, `daily_totals` and `team_daily_totals` include both `executadas` (status 2) and `concluidas` (status 4/9) because a note can finish after 20:30. The consolidation at 20:30 overwrites with `concluidas` only. Queries against historical months always return consolidation-corrected data. Queries for the current day may show a slightly higher number.

---

## GOAL CALCULATION (`getMetasCalculadas`)

```javascript
// Input: yearMonth = "YYYY-MM"
totalDU    = diasUteisNoMes(year, month)         // Mon–Fri count in full month
decorridos = diasUteisAte(year, month, diaRef)   // Mon–Fri from day 1 to today (or last day if past month)
semanaAtual = Math.ceil(diaRef / 7)

// Per tipo, per regional:
diaria     = mensal / 22          // 22 = fixed constant (agreed basis), NOT totalDU
semanal    = diaria * 5
ateHoje    = diaria * decorridos  // proportional target up to today
realizado  = sum(count) FROM daily_totals WHERE month = yearMonth AND regional = X AND tipo_code = Y
percentual = (realizado / ateHoje) * 100
saldo      = realizado - ateHoje  // positive = ahead of target, negative = behind
```

`diaria = mensal / 22` uses the fixed constant 22, not `totalDU`. Intentional — targets were agreed on a 22-day basis. `totalDU` is displayed informationally only.

---

## API ROUTES (`routes/index.js`)

All routes under `/api`. `sbq()` = lazy singleton loading `supabaseQueries`.

| Method | Path | Query params | Notes |
|---|---|---|---|
| GET | `/api/teams` | `regional`, `sectorId` | `supabase` mode → `teams_current`; `wpa`/`mock` → live |
| GET | `/api/teams/:teamId` | — | Searches all sectors |
| GET | `/api/summary` | — | Aggregated per regional |
| GET | `/api/status` | — | Health check |
| GET | `/api/metas` | — | Raw `{GUA:{},CAC:{}}` |
| POST | `/api/metas` | — | Body: `{GUA:{LN:120,...},CAC:{...}}` |
| GET | `/api/metas/calculadas` | `m=YYYY-MM` | diaria/semanal/ateHoje/realizado/percentual/saldo |
| GET | `/api/historico/mes` | `m=YYYY-MM` | Month totals by regional/tipo |
| GET | `/api/historico/diario` | `m=YYYY-MM` | Daily breakdown by regional/tipo |
| GET | `/api/ranking/equipes` | `m=YYYY-MM`, `regional` | Teams ranked by total concluidas |
| GET | `/api/historico/equipes` | `m=YYYY-MM`, `team` | Day-by-day per team |
| GET | `/api/equipes/producao` | `de`, `ate`, `regional`, `team` | Aggregated production, free date range |
| POST | `/api/wpa/login` | — | Debug: force WPA re-login |
| GET | `/api/wpa/probe` | `path` | Debug: proxy any WPA endpoint |
| GET | `/api/debug/notas` | `sectorId` | Debug: session↔note matching diagnostic |
| POST | `/api/admin/snapshot` | — | Manual snapshot trigger |
| POST | `/api/admin/consolidar` | `date=YYYY-MM-DD` | Manual consolidation trigger |

---

## WEBHOOK (`server.js`)

Route: `POST /webhook/deploy`

**Critical middleware ordering**: This route MUST be registered before `app.use(express.json())`. Uses `express.raw({ type: 'application/json' })` to preserve raw body for HMAC. If `express.json()` runs first, body is consumed and HMAC fails silently.

Security: `crypto.timingSafeEqual` on `x-hub-signature-256` vs `sha256=HMAC(WEBHOOK_SECRET, rawBody)`.

Trigger condition: `payload.ref === 'refs/heads/main'` only.

Action (fire-and-forget after response): `git pull origin main && npm install --production && pm2 restart wpa-monitor`

Current status: Configured in GitHub but port 3002 blocked by corporate firewall. Manual deploy used instead.

---

## DATE FILTER — BUG HISTORY

**Original bug**: `.lte('date', '${yearMonth}-31')` — PostgreSQL rejected for months without day 31.

**Wrong fix attempt**: `.like('date', '${yearMonth}-%')` — PostgreSQL LIKE (`~~`) does not work on `DATE` columns. Error: `operator does not exist: date ~~ unknown`.

**Correct implementation** (`filterByMonth()` in `db/supabaseQueries.js`):
```javascript
function filterByMonth(query, yearMonth) {
  const [y, m] = yearMonth.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return query.gte('date', `${yearMonth}-01`).lt('date', `${ny}-${String(nm).padStart(2,'0')}-01`);
}
```
Applied in: `getMonthTotals`, `getDailyHistory`, `getTeamRanking`, `getTeamDailyHistory`.

---

## FRONTEND SPA (`index.html`)

Single HTML file. No build step, no bundler, no framework. Vanilla JS + CSS custom properties.

### Tab Architecture
```
switchTab(tab)
  monitor   → loadData() called on interval; no lazy-load on tab switch
  metas     → loadMetasCalculadas() on switch + month input change
  ranking   → loadRanking() on switch + month/regional change
  historico → loadHistorico() on switch + month/team change
  equipes   → initEquipes() on switch (sets default dates) → loadEquipes()
```

### API Base URL Detection
```javascript
const API = (hostname === 'localhost' || hostname === '127.0.0.1')
  ? `http://${hostname}:3002/api`
  : '/api';
```

### Global State
```javascript
allTeams         // array: current snapshot (Monitor tab)
currentRegional  // "ALL" | "GUA" | "CAC" (Monitor filter)
currentFilter    // string: team name search
currentTab       // active tab name
_metasCache      // { GUA:{}, CAC:{} } — fetched once at load
```

### TIPOS_SERVICO (frontend constant)
```javascript
{ LN:'Ligação Nova', LE:'Ligação Existente', DL:'Desligamento', MD:'Modificação',
  SF:'Suspensão de Fornecimento', RL:'Religa', UG:'Uso Geral',
  DD:'Falhas para Distribuição', II:'Inspeção de Irregularidade', PO:'Ordem Prioritária' }
```

### Tab: Monitor
Auto-refresh every 60 s. `calcTotaisPorRegional(teams)` aggregates `notasExecutadas + notasConcluidas` by `regional` and `tipoCode`. Progress bar per tipo vs `metas[regional][tipoCode]`. Team cards show note counts, session status, vehicle, collaborators.

### Tab: Metas
Calls `GET /api/metas/calculadas`. Info cards: dias úteis total/decorridos/restantes/semana. Per-regional blocks: one card per tipo with progress bar + saldo pill. Pill: `saldo >= 0` → green; `saldo >= -diaria*2` → yellow; else → red.

### Tab: Ranking
Calls `GET /api/ranking/equipes`. Table: position (medals top 3), team, regional badge, one column per tipo, total. Tipo columns dynamic.

### Tab: Histórico
Calls `GET /api/historico/equipes`. Team select auto-populated from returned data. Table: date, team, regional, tipo columns, total.

### Tab: Equipes
Calls `GET /api/equipes/producao`. `initEquipes()` sets default De = first of current month, Até = today. Team select auto-populated from data. Table: one row per team, tipo columns, footer totals row.

### Modal: Metas (settings)
Input grid for each `TIPOS_SERVICO × ['GUA','CAC']`. Shows diaria/semanal hints inline. `salvarMetas()` POSTs to `/api/metas`, re-renders Monitor productivity bar.

---

## ENVIRONMENT VARIABLES

| Variable | Required on | Description |
|---|---|---|
| `DATA_MODE` | both | `wpa` \| `supabase` \| `mock` |
| `WPA_URL` | Linux server | Auth base URL |
| `WPA_API_URL` | Linux server | API base URL |
| `WPA_USERNAME` | Linux server | EDP WPA login |
| `WPA_PASSWORD` | Linux server | EDP WPA password |
| `SUPABASE_URL` | both | Project URL (hardcoded default in supabaseClient.js) |
| `SUPABASE_SERVICE_KEY` | both | `service_role` key — server-only, never browser |
| `PORT` | Linux server | Default 3002 |
| `WEBHOOK_SECRET` | Linux server | GitHub webhook HMAC secret |
| `VERCEL` | Vercel (auto) | Set by Vercel runtime; disables app.listen() |

---

## INFRASTRUCTURE

### Linux Server (DATA_MODE=wpa)
- PM2 app name: `wpa-monitor`
- Entry: `node server.js`
- All cron TZ: `America/Sao_Paulo`
- Project path: `~/zouain/prod`
- Manual deploy: `cd ~/zouain/prod && git pull origin main && pm2 restart wpa-monitor`

### Vercel (DATA_MODE=supabase)
- `vercel.json` routes all traffic to `server.js` via `@vercel/node`
- `server.js` detects `process.env.VERCEL`, exports app without `app.listen()`
- No cron on Vercel — all writes originate from Linux server
- Public URL: `prod-stc.vercel.app`
- GitHub repo: `eduardochamp1/prod-stc` — auto-deploys on push to `main`

### Supabase
- Project URL: `https://iyadtjzehhebwojreudz.supabase.co`
- All access via `service_role` (RLS bypassed)
- 5 tables: `snapshots`, `teams_current`, `daily_totals`, `metas`, `team_daily_totals`

---

## KNOWN CONSTRAINTS & GOTCHAS

1. **WPA API is undocumented.** Field mapping (`n.Number`, `n.Id`, `n.Type`, `s.Team.CompanyId`) was reverse-engineered via `/api/debug/notas`.

2. **Note status 9→4 sync drop**: Notes completed on mobile (status 9) disappear from the execution endpoint after backend sync. The in-memory `_acc` accumulator in `wpaService.js` prevents count drops within the same day but resets at midnight.

3. **Team name mismatch risk**: Session team name and note team name must match exactly (string). EDP may change display names. If a team shows 0 notes unexpectedly, diagnose via `/api/debug/notas?sectorId=DESG`.

4. **22-day constant**: All `diaria = mensal / 22` use the fixed constant 22, not actual working days in the month. Changing this requires updating `getMetasCalculadas` in `db/supabaseQueries.js`.

5. **Intraday count inflation**: `upsertDailyTotals` and `upsertTeamDailyTotals` count `executadas + concluidas` during the day. Nightly `consolidateDay` overwrites with `concluidas` only. Historical months are always correct; current day may read higher.

6. **No RLS on Supabase**: All tables accessed via `service_role`. Key must never reach the browser. It is server-only (Linux `.env` and Vercel env vars).

7. **PM2 persistence**: After first deploy, run `pm2 save` to survive server reboots. After code changes, `pm2 restart wpa-monitor` is required — PM2 does not auto-reload on file changes.

8. **`express.raw` middleware ordering**: `POST /webhook/deploy` MUST be defined before `app.use(express.json())`. Reversing this silently breaks HMAC because the body is already consumed.
