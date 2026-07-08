# RUNBOOK — WPA Monitor em produção

> **Público-alvo:** dev/AI/pessoa da TI da Engelmig que precise operar o
> sistema quando o José Zouain estiver indisponível. Objetivo: reiniciar,
> restaurar e diagnosticar sem depender de conhecimento tácito.

## Onde estão as senhas

**NUNCA guardadas em texto claro neste arquivo.** Referência apenas:

| Credencial | Onde | Quem tem acesso |
|---|---|---|
| SSH `usr_jose` na VM | Cofre corporativo (a definir — P0-1) | José + 2 pessoas |
| `.env` completo da VM (`/home/usr_jose/prod-stc/.env`) | Cofre corporativo | José + 2 pessoas |
| Postgres `wpa_app` | Dentro do `.env` (`DATABASE_URL`) | idem |
| WPA da EDP (`AUTH_USERS`) | Dentro do `.env` | idem |
| Cloudflare Worker | Dashboard cloudflare.com (login com email do José) | José |
| GitHub `eduardochamp1/prod-stc` | Login do José | José |

**Se você chegou aqui sem acesso ao cofre:** contate a diretoria da Engelmig
imediatamente. O contrato com EDP tem SLA que exige que 2+ pessoas possam
operar. Se só 1 tem acesso e essa pessoa não está disponível, é falha
organizacional grave — precisa ser tratada como emergência.

## Contatos externos (fill in)

- **EDP — TI / autorização de IP na WPA:** _(nome, email, telefone — José
  preencher)_
- **EDP — gestor do contrato / SLA:** _(nome, email, telefone)_
- **Engelmig — diretoria comercial (dono do contrato):** _(nome)_
- **Engelmig — TI corporativa (VM, rede, Fortinet):** _(nome)_

## Endereços úteis

| Recurso | Endereço |
|---|---|
| Painel produção | http://172.25.3.154:3002 (só rede interna Engelmig / VPN) |
| VM SSH | `ssh usr_jose@172.25.3.154` |
| Repo git | https://github.com/eduardochamp1/prod-stc |
| Postgres | `psql -d wpa_monitor` (no `usr_jose`, autenticação `peer`) |
| API WPA EDP | https://edp-wpa-web-api.azurewebsites.net |
| Cloudflare Worker (OSRM proxy) | https://osrm-proxy.jose-zouain.workers.dev |

## Comandos de emergência

### Reiniciar o app (PM2 travado, erro)

```bash
ssh usr_jose@172.25.3.154
cd ~/prod-stc
pm2 delete wpa-monitor
pm2 start ecosystem.config.js
pm2 save
pm2 logs wpa-monitor --lines 50
```

**NÃO use** `pm2 reload --update-env` — não funciona confiavelmente em
cluster mode. Sempre `delete + start`.

### Verificar saúde geral

```bash
# Idade do último snapshot (deve ser < 20min em horário útil 06-20h BRT)
psql -d wpa_monitor -c "SELECT max(captured_at) AT TIME ZONE 'America/Sao_Paulo' FROM snapshots;"

# Tamanho do banco (crescimento saudável ~16MB/dia)
psql -d wpa_monitor -c "SELECT pg_size_pretty(pg_database_size('wpa_monitor'));"

# Espaço livre no disco (< 20% = alerta)
df -h /

# Processo PM2
pm2 status
pm2 logs wpa-monitor --lines 100

# Health endpoint (após P1-2 estar deployado)
curl -sS http://localhost:3002/health
```

### Ver erros recentes

```bash
pm2 logs wpa-monitor --lines 500 --nostream | grep -iE "error|failed|exception" | tail -30

# Ou por evento específico
pm2 logs wpa-monitor --lines 1000 --nostream | grep "snapshot_failed"
pm2 logs wpa-monitor --lines 1000 --nostream | grep "consolidate_failed"
```

### Reiniciar o cron sem reiniciar o app

O cron está no mesmo processo que o Express — não tem separação. Se o cron
está travado (não há novos snapshots), a única opção é reiniciar todo o app:

```bash
pm2 restart wpa-monitor
# Se ainda travar: pm2 delete wpa-monitor && pm2 start ecosystem.config.js
```

### Rodar snapshot manual (fora do ciclo)

```bash
cd ~/prod-stc
node -e "require('./services/cronService').runSnapshot()"
```

Deve levar 30-90 segundos. Ao final, `psql -c "SELECT max(captured_at)..."` deve
mostrar timestamp novo.

## Backfills

### Se um dia faltar em `team_daily_carteira` (aproveitamento)

```bash
cd ~/prod-stc
node scripts/backfill-carteira.js 2026-07-15   # data específica ou desde essa data
```

Idempotente — pode rodar quantas vezes quiser.

### Se snapshots antigos ainda existem mas agregados estão errados

```bash
# Consolida um dia específico (D-N)
node -e "require('./services/dataWriter').consolidateDay('2026-07-10')"
```

Roda o mesmo processo do cron das 20:30 pra aquela data. Wipa e reagrega
`team_daily_totals` e `team_daily_subcat_totals`.

### Drift check manual

```bash
node -e "require('./services/dataWriter').detectDrift('2026-07-10').then(r => console.log(JSON.stringify(r,null,2)))"
```

Retorna JSON com `snapshot_count`, `table_count`, `diff`, `has_drift`.
Se `has_drift: true`, considere rodar `consolidateDay`.

## Restore de backup

### Verificar backup mais recente

```bash
ls -lht ~/backups/wpa_monitor/ | head
# formato: wpa_monitor_YYYY-MM-DD_HH-MM.dump
```

### Restaurar num banco de teste (SEM tocar em produção)

```bash
sudo -u postgres psql -c "CREATE DATABASE wpa_monitor_restore;"   # requer intervenção do admin da VM
# ou como usr_jose se tiver permissão:
createdb wpa_monitor_restore

pg_restore -d wpa_monitor_restore --no-owner --no-privileges ~/backups/wpa_monitor/wpa_monitor_YYYY-MM-DD.dump

# Validar
psql -d wpa_monitor_restore -c "SELECT count(*) FROM snapshots;"
```

### Restaurar em produção (SOMENTE em disaster recovery)

**⚠️ Isto substitui o banco atual. Só faça se o atual estiver corrompido
ou perdido.**

```bash
# 1. Parar o app (impede escritas concorrentes)
pm2 stop wpa-monitor

# 2. Backup do estado atual (por precaução)
pg_dump -d wpa_monitor -Fc -f /tmp/pre_restore_$(date +%Y%m%d_%H%M).dump

# 3. Restaurar
dropdb wpa_monitor
createdb wpa_monitor
pg_restore -d wpa_monitor --no-owner --no-privileges ~/backups/wpa_monitor/wpa_monitor_YYYY-MM-DD.dump

# 4. Aplicar owner do app
psql -d wpa_monitor -c "REASSIGN OWNED BY usr_jose TO wpa_app;"
# ou por tabela: ALTER TABLE X OWNER TO wpa_app;

# 5. Reiniciar
pm2 start wpa-monitor
pm2 logs wpa-monitor --lines 30
```

**Se o backup local também foi perdido (VM morreu):** ver P0-2 (backup
offsite). Após P0-2 concluído, dumps estão em OneDrive corporativo. Baixar
com `rclone copy onedrive:wpa-backups/<data>.dump ~/`.

## Deploy de mudança nova

### Fluxo padrão

```bash
# No seu ambiente local:
git pull                    # sincroniza
# faz mudanças, commita
node --test                 # OBRIGATÓRIO — não pode ter falha
git push

# Na VM:
ssh usr_jose@172.25.3.154
cd ~/prod-stc
git pull
pm2 delete wpa-monitor && pm2 start ecosystem.config.js && pm2 save
pm2 logs wpa-monitor --lines 30 --nostream

# Verificar que subiu e cron está rodando
psql -d wpa_monitor -c "SELECT max(captured_at) AT TIME ZONE 'America/Sao_Paulo' FROM snapshots;"
```

### Mudança que precisa de novo `.env`

```bash
# Backup do atual
cp .env .env.bak_$(date +%Y%m%d)

# Editar
nano .env

# Validar parse (útil pra AUTH_USERS)
node -e "require('dotenv').config(); console.log(require('./middleware/auth').getUsers().map(u => ({user: u.username, regs: u.regionals})))"

# Deploy
pm2 delete wpa-monitor && pm2 start ecosystem.config.js && pm2 save
```

**NUNCA use `pm2 reload --update-env`** — não funciona em cluster mode. Sempre
delete + start.

### Rollback rápido

```bash
cd ~/prod-stc
git log --oneline -10                 # identifica o commit anterior
git reset --hard <commit-anterior>    # ou usa tag pre-deploy se existir
pm2 delete wpa-monitor && pm2 start ecosystem.config.js && pm2 save
```

### Tag antes de deploy grande

Antes de mudança arriscada:
```bash
git tag "pre-<nome-mudanca>-$(date +%Y%m%d)"
git push --tags
# Se der ruim: git reset --hard pre-<nome-mudanca>-YYYYMMDD
```

## Sintomas comuns e o que fazer

### "Painel mostra dados de 2 horas atrás"

Cron parou. Ver logs:
```bash
pm2 logs wpa-monitor --lines 200 --nostream | tail -50
```

Se ver `snapshot_failed` repetido: WPA da EDP fora do ar OU credencial
expirada. Testar login manual:
```bash
node -e "require('./services/wpaService').loginWithRetry().then(t => console.log('login OK', t.exp))"
```

Se retornar erro 401: `AUTH_USERS` da WPA está errado no `.env`. Se retornar
"cold start Azure": esperar 3-5min, retentar.

### "Números do painel parecem errados"

1. Rodar drift check em D e D-1:
   ```bash
   node -e "require('./services/dataWriter').detectDrift(require('./services/timeUtil').dateBRT()).then(r => console.log(r))"
   ```
2. Se `has_drift: true`, rodar consolidateDay manual.
3. Se ainda errado, comparar `snapshots.data` com o agregado (SQL manual).
4. Ver comentário em `dataService.js:313-317` — pode ser variação do bug
   canc=904/294. Testar priorização de buckets.

### "Login não funciona pra ninguém"

Provavelmente `.env` corrompido ou `JWT_SECRET` mudou.
```bash
cat .env | grep -E "JWT_SECRET|AUTH_USERS"
# Se JWT_SECRET vazio ou 'wpa-monitor-mude-esta-chave', app não sobe em DATA_MODE=wpa
# Restaurar do backup .env.bak_YYYYMMDD
```

### "Disco cheio"

```bash
df -h /
psql -d wpa_monitor -c "SELECT pg_size_pretty(pg_database_size('wpa_monitor'));"

# Se banco > 10GB, considere ativar TTL de snapshots (que hoje é infinito):
# Editar .env, adicionar: SNAPSHOT_RETENTION_DAYS=180
# Restart PM2. Próxima consolidação às 20:30 apaga snapshots > 180 dias.
```

**Cuidado:** apagar snapshots limita backfill retroativo de métricas novas.
Decisão de negócio, não técnica — ver `dataWriter.js:539-549`.

### "Fortinet bloqueou algo"

Sintoma: recurso externo (CDN, API) começa a dar erro sem mudança de código.

Já bloqueou:
- `router.project-osrm.org` → resolvido com Cloudflare Worker (`osrm-proxy.jose-zouain.workers.dev`)
- `cdn.sheetjs.com` → resolvido com `vendor/xlsx.full.min.js`

Se algo novo bloquear:
1. Identificar a URL bloqueada (F12 → Network no navegador ou `curl -v` na VM).
2. Baixar o recurso pra `vendor/` e servir localmente.
3. Ou passar por Cloudflare Worker (padrão do OSRM proxy).

Ver P1-9 no backlog — Leaflet e Google Fonts ainda são CDN, candidatos a
quebrar.

## Manutenção agendada

### Diária (automática)

- **00:00** — backup do Postgres em `~/backups/wpa_monitor/`
  (script: `scripts/backup-wpa-monitor.sh` no crontab do `usr_jose`).
- **02:00 BRT** — drift check de D-1 e D-7 (dentro do `cronService`).
- **20:30 BRT** — consolidação diária de D e D-1 + limpeza opcional de
  snapshots antigos (se `SNAPSHOT_RETENTION_DAYS` estiver setado).

### Manual (a definir na TI)

- **Trimestral:** validar restore do backup mais recente num banco de teste
  (garante que dumps não estão corrompidos).
- **Trimestral:** validar que 2ª pessoa consegue seguir este runbook
  ("simulação seca").
- **Anual:** rotacionar `JWT_SECRET`, senhas de banco, tokens EDP.

## Escalonamento (quando pedir ajuda)

| Sintoma | Primeiro passo | Se não resolver |
|---|---|---|
| Painel fora do ar | `pm2 restart wpa-monitor` | Ver logs, escalar TI da Engelmig |
| Números errados | Drift check + consolidateDay manual | Escalar dev/AI que conhece a matemática |
| Cron parado > 1h | Ver logs, testar login WPA | Escalar dev (pode ser API EDP mudou) |
| Disco cheio | Ver P0-2 backup offsite / SNAPSHOT_RETENTION_DAYS | TI da Engelmig (aumentar VM) |
| VM inacessível | Ping / SSH — se falhar, contatar TI | TI Engelmig (VM caiu) |
| WPA EDP fora | Aguardar (Azure cold-start comum) | Após 1h+, contatar TI EDP |
| Fortinet bloqueou | Identificar URL, vendorizar ou proxy | TI Engelmig (whitelist) |

## Nota final

Este runbook começa incompleto. **Todo incidente novo deve ser registrado
aqui com "sintoma → causa → como resolvi"** pra próxima pessoa não repetir
o diagnóstico. Não é pra ficar bonito, é pra ficar útil.
