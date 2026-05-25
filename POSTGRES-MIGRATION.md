# Migração Supabase → Postgres self-hosted

Guia de 4 fases para mover o backend de dados do Supabase Free
(esgotando recursos) para um **Postgres 16 self-hosted** no servidor
novo. Mantém 90 dias de retenção de snapshots, elimina dependência
externa, custo zero recorrente.

> **Servidor alvo:** Ubuntu/Debian, 4 GB RAM, IP já liberado pra WPA.
> **Esforço total:** ~3 dias úteis efetivos.
> **Status atual:** *Fase 1 em execução.*

---

## Sumário das 4 fases

| Fase | O que entrega                                                   | Tempo  | Status        |
|------|-----------------------------------------------------------------|--------|---------------|
| 1    | Postgres instalado, tunado pra 4 GB, schema aplicado            | 0.5 d  | ▶ em execução |
| 2    | Dump do Supabase + restore local, contagens validadas           | 0.5 d  | ⏳ aguardando |
| 3    | `services/supabaseClient.js` reescrito como shim sobre `pg`     | 1.5 d  | ⏳ aguardando |
| 4    | Cutover, aposentar Vercel, monitoramento 24 h                   | 0.5 d  | ⏳ aguardando |

---

# Fase 1 — Setup do Postgres no servidor novo

## 1.1 Instalar Postgres 16

```bash
# Repositório oficial PGDG (Postgres versões atuais)
sudo apt update
sudo apt install -y curl ca-certificates lsb-release
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -fsS -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  https://www.postgresql.org/media/keys/ACCC4CF8.asc
sudo sh -c 'echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
  https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list'

sudo apt update
sudo apt install -y postgresql-16 postgresql-client-16

# Confere
sudo systemctl status postgresql
psql --version    # esperado: psql (PostgreSQL) 16.x
```

## 1.2 Criar usuário + database da aplicação

```bash
sudo -u postgres psql <<SQL
  -- usuário dedicado da app (sem superuser)
  CREATE USER wpa_app WITH PASSWORD 'TROCAR_POR_SENHA_FORTE_AQUI';

  -- database
  CREATE DATABASE wpa_monitor
    WITH OWNER  = wpa_app
         ENCODING = 'UTF8'
         LC_COLLATE = 'C.UTF-8'
         LC_CTYPE   = 'C.UTF-8'
         TEMPLATE = template0;

  -- timezone (importante para queries que filtram por dia BRT)
  ALTER DATABASE wpa_monitor SET timezone TO 'America/Sao_Paulo';

  -- privilégios
  GRANT ALL PRIVILEGES ON DATABASE wpa_monitor TO wpa_app;
SQL

# Testa login
PGPASSWORD='SENHA_AQUI' psql -h localhost -U wpa_app -d wpa_monitor -c "SELECT version(), now();"
```

Anote a senha — vai pro `.env` do app como `DATABASE_URL`.

## 1.3 Tuning pra 4 GB de RAM

Edita `/etc/postgresql/16/main/postgresql.conf`:

```bash
sudo nano /etc/postgresql/16/main/postgresql.conf
```

Ajustes recomendados pra um servidor 4 GB com 1 app cliente leitora/escritora:

```ini
# ── MEMÓRIA ───────────────────────────────────────────────────────────────
shared_buffers = 1GB                  # ~25% da RAM
effective_cache_size = 3GB            # ~75% (estimativa do que SO + PG cacheiam)
work_mem = 32MB                       # por operação de sort/hash (cuidado: ×N conexões)
maintenance_work_mem = 256MB          # VACUUM/CREATE INDEX
huge_pages = try

# ── WAL / DURABILIDADE ────────────────────────────────────────────────────
wal_buffers = 16MB
min_wal_size = 256MB
max_wal_size = 2GB
checkpoint_completion_target = 0.9

# ── PARALLELISM (4 vCPUs típico) ──────────────────────────────────────────
max_worker_processes = 4
max_parallel_workers = 4
max_parallel_workers_per_gather = 2
max_parallel_maintenance_workers = 2

# ── CONEXÕES ──────────────────────────────────────────────────────────────
# Node usa 1 pool com ~10 conexões. Margem confortável:
max_connections = 50

# ── LOGS (útil pra debug; rotaciona via logrotate) ────────────────────────
log_min_duration_statement = 500ms    # logs só queries lentas > 500ms
log_checkpoints = on
log_connections = off
log_disconnections = off
log_lock_waits = on
log_temp_files = 10MB

# ── PLANEJADOR ────────────────────────────────────────────────────────────
random_page_cost = 1.1                # SSD; HDD usaria 4
effective_io_concurrency = 200        # SSD
default_statistics_target = 100

# ── AUTOVACUUM (snapshots crescem rápido) ─────────────────────────────────
autovacuum = on
autovacuum_max_workers = 3
autovacuum_naptime = 30s
autovacuum_vacuum_scale_factor = 0.1
autovacuum_analyze_scale_factor = 0.05
```

Aplica:

```bash
sudo systemctl restart postgresql
sudo -u postgres psql -c "SHOW shared_buffers; SHOW work_mem; SHOW max_connections;"
```

## 1.4 Permitir conexões locais com senha

Em `/etc/postgresql/16/main/pg_hba.conf`, garanta:

```
# localhost com senha (não trust)
host    wpa_monitor   wpa_app   127.0.0.1/32    scram-sha-256
host    wpa_monitor   wpa_app   ::1/128         scram-sha-256
```

```bash
sudo systemctl reload postgresql
```

> **Não exponha 5432 na VPN** se a app roda no mesmo servidor (que é
> o nosso caso). Mantém só `localhost` — superfície de ataque mínima.
> Se um dia precisar acessar do laptop pra debug, use `ssh -L` em vez
> de abrir a porta.

## 1.5 Aplicar o schema

O arquivo `supabase/schema.sql` no repo contém o schema completo
(tabelas `snapshots`, `teams_current`, `team_daily_totals`,
`team_daily_subcat_totals`, `note_subcategorias`, `wpa_token`,
`app_settings`, `note_details`, `daily_totals`, `daily_subcat_totals`,
`metas`).

```bash
cd /home/wpa/prod-stc                              # (já clonado no DEPLOY.md)

# 1. schema base
PGPASSWORD='SENHA' psql -h localhost -U wpa_app -d wpa_monitor \
  -f supabase/schema.sql

# 2. migrations adicionais (na ordem)
for f in supabase/migrations/001_*.sql \
         supabase/migrations/002_*.sql \
         supabase/migrations/003_*.sql \
         supabase/migrations/004_*.sql \
         supabase/migrations/005_*.sql \
         supabase/migrations/006_*.sql \
         supabase/migrations/007_*.sql \
         supabase/migrations/008_*.sql \
         migrations/add_escala_equipes.sql; do
  echo "▶ Aplicando $f"
  PGPASSWORD='SENHA' psql -h localhost -U wpa_app -d wpa_monitor -f "$f"
done

# 3. confere que todas as tabelas estão lá
PGPASSWORD='SENHA' psql -h localhost -U wpa_app -d wpa_monitor -c "\dt"
```

Esperado: ~14 tabelas listadas (`snapshots`, `teams_current`,
`team_daily_totals`, `team_daily_subcat_totals`, `note_subcategorias`,
`note_details`, `note_rejections`, `daily_totals`, `daily_subcat_totals`,
`metas`, `wpa_token`, `app_settings`, `equipes_oficiais`).

## 1.6 Capacidade de disco — planejamento

Estimativa pra 90 dias de retenção:

| Tabela                       | Linhas/dia | Tam/row | Total 90d |
|------------------------------|-----------:|--------:|----------:|
| `snapshots` (JSONB)          | ~5.760     | ~20 KB  | **~10 GB** |
| `note_details` (JSONB)       | ~500       | ~5 KB   | ~225 MB   |
| `note_rejections`            | ~90        | ~2 KB   | ~16 MB    |
| `team_daily_*_totals`        | ~120       | ~200 B  | ~2 MB     |
| WAL + bloat (~30%)           | —          | —       | ~3 GB     |
| **Total estimado**           |            |         | **~13 GB** |

**Recomendação:** disco ≥ **40 GB livres** no volume do Postgres pra
ter folga (índices, vacuum, backups locais).

```bash
df -h /var/lib/postgresql        # confere espaço
sudo du -sh /var/lib/postgresql/16/main   # consumo atual
```

Se o volume root tiver pouco espaço, mova o `data_directory` pra um
disco maior:

```bash
sudo systemctl stop postgresql
sudo rsync -a /var/lib/postgresql/16/main/ /mnt/data/pgdata/
sudo nano /etc/postgresql/16/main/postgresql.conf
# data_directory = '/mnt/data/pgdata'
sudo chown -R postgres:postgres /mnt/data/pgdata
sudo systemctl start postgresql
```

## 1.7 Retention policy automática (snapshots > 90 dias)

Pra evitar que `snapshots` cresça indefinidamente, cria um cron interno
do Postgres usando `pg_cron` (opcional) **ou** um script bash agendado
no PM2/cron do SO.

**Opção simples (bash via cron do SO):**

```bash
sudo nano /etc/cron.d/wpa-retention
```

```cron
# Diariamente às 03:00 BRT — apaga snapshots > 90 dias
0 3 * * * postgres psql -d wpa_monitor -c "DELETE FROM snapshots WHERE date < CURRENT_DATE - INTERVAL '90 days';" >> /var/log/pg-retention.log 2>&1
0 4 * * 0 postgres psql -d wpa_monitor -c "VACUUM FULL ANALYZE snapshots;" >> /var/log/pg-retention.log 2>&1
```

> O `VACUUM FULL` semanal recupera espaço físico de blocos com tuplas
> mortas — importante depois de muitas deleções.

## 1.8 Backup diário (essencial — Supabase fazia isso por você)

```bash
sudo mkdir -p /var/backups/postgres
sudo chown postgres:postgres /var/backups/postgres
sudo nano /etc/cron.d/wpa-backup
```

```cron
# Backup completo às 02:00 BRT; mantém 14 dias
0 2 * * * postgres pg_dump -Fc -d wpa_monitor -f /var/backups/postgres/wpa_monitor_$(date +\%Y\%m\%d).dump && find /var/backups/postgres -name 'wpa_monitor_*.dump' -mtime +14 -delete
```

> **Importante:** copie os backups pra fora do servidor regularmente
> (S3, Google Drive corporativo, NFS). Backup que mora no mesmo disco
> não é backup.

Teste de restore (válida que o dump funciona):

```bash
sudo -u postgres pg_dump -Fc -d wpa_monitor -f /tmp/test.dump
sudo -u postgres createdb wpa_test
sudo -u postgres pg_restore -d wpa_test /tmp/test.dump
sudo -u postgres psql -d wpa_test -c "SELECT count(*) FROM snapshots;"
sudo -u postgres dropdb wpa_test
```

## 1.9 Checklist Fase 1

- [ ] `psql --version` mostra PG 16
- [ ] `systemctl status postgresql` → active (running)
- [ ] Login no banco `wpa_monitor` com user `wpa_app` funciona
- [ ] `SHOW shared_buffers` retorna `1GB`
- [ ] `\dt` lista as 14 tabelas vazias
- [ ] `df -h` mostra ≥ 40 GB livres no volume do PG
- [ ] Cron de retention + backup em `/etc/cron.d/`
- [ ] `DATABASE_URL` anotado pra usar no `.env`:
  `postgresql://wpa_app:SENHA@localhost:5432/wpa_monitor`

---

# Fase 2 — Migrar dados do Supabase para o Postgres local

**Pré-requisitos:** Fase 1 completa (schema aplicado, Postgres rodando).

Toda a Fase 2 está automatizada em **`scripts/migrate-from-supabase.sh`**.
O script faz: sanity check de ambas as pontas → contagens da origem →
verificação/limpeza do destino → `pg_dump` (formato custom) →
`pg_restore` paralelo → comparação row-a-row → `ANALYZE`.

## 2.1 Pegar a connection string do Supabase

1. Acessa Supabase Dashboard → **Project Settings → Database**
2. Em **Connection string** copia o "URI" (formato `postgresql://...`)
3. **Use a connection direta** (não a "pooled") — porta `5432`, não 6543

Anota:
- `SUPABASE_HOST` = `db.iyadtjzehhebwojreudz.supabase.co`
- `SUPABASE_USER` = `postgres`
- `SUPABASE_DB`   = `postgres`
- `SUPABASE_PASSWORD` = (a senha que você definiu ao criar o projeto;
  se esqueceu, **Reset database password** na mesma página)

## 2.2 Configurar `.env.migration`

No servidor novo (ou no seu laptop com `postgresql-client-16` instalado e
rede aberta pro Supabase **e** pro Postgres local):

```bash
cd /home/wpa/prod-stc
cp scripts/.env.migration.example scripts/.env.migration
chmod 600 scripts/.env.migration
nano scripts/.env.migration
```

Preenche `SUPABASE_PASSWORD` e `LOCAL_PASSWORD` (a senha que você criou
na Fase 1.2 para o usuário `wpa_app`).

## 2.3 Rodar a migração

```bash
chmod +x scripts/migrate-from-supabase.sh
source scripts/.env.migration
./scripts/migrate-from-supabase.sh
```

O script vai:
1. Conectar nos dois lados e mostrar versões — falha se uma das conexões cair
2. Verificar que as 13 tabelas existem no destino (senão, manda você rodar a Fase 1 primeiro)
3. Imprimir **contagem de rows na origem** (baseline)
4. Imprimir contagens no destino; se houver dados residuais, pede confirmação pra `TRUNCATE` antes de restaurar (evita conflito de PKs)
5. `pg_dump` em formato custom (compactado) — leva 5-15 min para ~15 GB
6. `pg_restore` com `--jobs=2` (paralelo) e `--disable-triggers`
7. **Tabela comparativa origem × destino × delta** — abortando se algum delta ≠ 0
8. `ANALYZE` pra atualizar estatísticas do planner
9. Imprimir tamanho final do banco

Saída de sucesso (exemplo):

```
TABELA                                  ORIGEM      DESTINO        DELTA
------                                  ------      -------        -----
metas                                        2            2            0  OK
equipes_oficiais                            60           60            0  OK
teams_current                               60           60            0  OK
snapshots                               517824       517824            0  OK
team_daily_totals                         1834         1834            0  OK
team_daily_subcat_totals                  4127         4127            0  OK
note_subcategorias                       45120        45120            0  OK
note_details                              9821         9821            0  OK
note_rejections                           2633         2633            0  OK
wpa_token                                    1            1            0  OK
app_settings                                 3            3            0  OK
...
  ok  MIGRACAO COMPLETA — todas as 13 tabelas batem com a origem
```

## 2.4 Resolver problemas comuns

**`could not connect to server: timeout`**
- Firewall do servidor não libera saída na 5432. Tenta `nc -zv $SUPABASE_HOST 5432` pra confirmar.
- Em alguns ambientes, só o pooler (porta 6543) é acessível. Nesse caso use:
  `SUPABASE_HOST=aws-0-sa-east-1.pooler.supabase.com SUPABASE_PORT=6543 SUPABASE_USER=postgres.<project-ref>`
  Atenção: pooler tem timeout mais agressivo em dumps longos. Se cair no meio, divida por tabela.

**`pg_restore: error: COPY failed: ERROR: duplicate key value`**
- Destino não estava vazio. O script normalmente faz `TRUNCATE` antes,
  mas se você pulou esse passo, rode manualmente:
  ```bash
  PGPASSWORD=$LOCAL_PASSWORD psql -h localhost -U wpa_app -d wpa_monitor -c \
    "TRUNCATE snapshots, note_details, note_subcategorias, note_rejections,
              team_daily_totals, team_daily_subcat_totals, teams_current,
              equipes_oficiais, metas, wpa_token, app_settings,
              daily_totals, daily_subcat_totals
     RESTART IDENTITY CASCADE;"
  ```

**Delta > 0 em alguma tabela**
- Pode acontecer se cronjobs continuaram rodando contra o Supabase durante o dump.
- **Solução limpa:** pare o PM2 do servidor antigo ANTES de rodar o dump,
  depois roda este script. Cron novo só liga na Fase 4 (cutover).

**Erro em `wpa_token`**
- Essa tabela tem só 1 linha (token JWT atual). Se o restore falhar
  nela, o cron vai recriar automaticamente no próximo refresh. Tolerável.

## 2.5 Validações pós-migração (manuais, extras)

```bash
PGPASSWORD=$LOCAL_PASSWORD psql -h localhost -U wpa_app -d wpa_monitor <<SQL
-- 1) data mais recente em snapshots (esperado: hoje ou ontem)
SELECT max(date) AS ultima_data, max(captured_at) AS ultimo_captured FROM snapshots;

-- 2) total de notas concluídas no mês atual (cruza com a UI)
SELECT regional, sum(count) AS total
  FROM team_daily_totals
 WHERE date >= date_trunc('month', current_date)
 GROUP BY regional;

-- 3) rejeições recentes (cruza com a aba Rejeições)
SELECT count(*) AS total_rejeicoes_mes,
       count(*) FILTER (WHERE motivo_codes <> '{}') AS com_motivo
  FROM note_rejections
 WHERE session_date >= date_trunc('month', current_date);

-- 4) equipes oficiais (deve dar 60: 31 GUA + 29 CAC)
SELECT regional, count(*) FROM equipes_oficiais WHERE ativo GROUP BY regional;

-- 5) tamanhos das tabelas pesadas
SELECT relname,
       pg_size_pretty(pg_total_relation_size(relid)) AS size,
       n_live_tup AS estimated_rows
  FROM pg_stat_user_tables
 ORDER BY pg_total_relation_size(relid) DESC LIMIT 8;
SQL
```

Compara com o que você vê hoje no Supabase Studio — devem bater.

## 2.6 Checklist Fase 2

- [ ] `.env.migration` preenchido e com `chmod 600`
- [ ] PM2 do servidor antigo **parado** (`pm2 stop wpa-monitor` no antigo)
- [ ] Script rodou sem `DIFF` na comparação final
- [ ] Validações 2.5 batem com o que você vê no Supabase Studio
- [ ] Dump arquivado em local seguro (`/var/backups/postgres/migration_inicial.dump`)
- [ ] `pg_database_size` no destino é próximo do esperado (~13-20 GB)

> **Não delete o projeto do Supabase ainda** — só depois da Fase 4
> estabilizar por ≥ 1 semana. Mantém como backup de emergência.

---

# Fase 3 — Shim `pg` (resumo)

O arquivo `services/supabaseClient.js` será reescrito mantendo a API
`getClient().from(t).select().eq()...`, mas internamente emitindo SQL
via `pg` (driver oficial Postgres do Node).

105 call sites no codebase **continuam funcionando sem mudança**.

- Métodos a implementar: `select`, `insert`, `upsert`, `update`,
  `delete`, `eq`, `gte`, `lte`, `in`, `order`, `range`, `limit`,
  `single`, `maybeSingle`, `ilike`, `not`, `filter`.
- `getClient()` retorna um *thenable* compatível com o padrão Supabase
  (resolve com `{ data, error }`).
- Pool de conexões via `pg.Pool` (10 conexões, idle 30 s).

Env var nova: `DATABASE_URL=postgresql://wpa_app:SENHA@localhost:5432/wpa_monitor`.

A var `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` deixa de ser usada
(podemos manter o fallback temporário pra rollback rápido).

---

# Fase 4 — Cutover (resumo)

1. Deploy do código novo com `DATABASE_URL` no `.env`
2. `pm2 restart wpa-monitor`
3. Smoke test: login + Monitor + Rejeições + Gráficos
4. Monitora 24 h (logs, métricas do Postgres, tamanho do DB)
5. Atualiza link compartilhado com a equipe: `prod-stc.vercel.app` →
   `http://<IP-INTERNO>:3002` (ou hostname interno via Nginx — anexo B
   do DEPLOY.md)
6. Deleta projeto no Vercel **só depois** de 1 semana estável

---

## Comandos do dia-a-dia do Postgres

```bash
# Tamanho de cada tabela
sudo -u postgres psql -d wpa_monitor -c "
  SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) AS size
  FROM pg_catalog.pg_statio_user_tables
  ORDER BY pg_total_relation_size(relid) DESC LIMIT 15;"

# Top queries lentas
sudo -u postgres psql -d wpa_monitor -c "
  SELECT substring(query, 1, 80) AS query, calls, mean_exec_time::int AS ms_avg, total_exec_time::int AS ms_total
  FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10;"
# (exige extensão pg_stat_statements habilitada: CREATE EXTENSION pg_stat_statements;)

# Conexões ativas
sudo -u postgres psql -c "SELECT state, count(*) FROM pg_stat_activity GROUP BY 1;"

# Restart sem perder conexões em andamento
sudo systemctl reload postgresql

# Backup manual antes de mudança crítica
sudo -u postgres pg_dump -Fc -d wpa_monitor -f /var/backups/postgres/manual_$(date +%s).dump
```

---

**Próximo passo:** quando você confirmar que terminou o checklist da
Fase 1, me chama com o output do `\dt` e do `df -h` que eu sigo pra
Fase 2 (dump do Supabase + restore).
