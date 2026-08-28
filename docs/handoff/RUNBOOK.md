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

### Trocar credencial WPA / conta de backup SJC

A EDP rotaciona senha das contas WPA sem avisar. Contas (`.env`):

| conta | env | quem/o quê | setores |
|---|---|---|---|
| `es`  | `WPA_USERNAME` / `WPA_PASSWORD`         | Clarissa (ES) | GUA, CAC |
| `sp`  | `WPA_USERNAME_SP` / `WPA_PASSWORD_SP`   | Ismael (SJC — primária) | SJC |
| `sp2` | `WPA_USERNAME_SP2` / `WPA_PASSWORD_SP2` | Luan (SJC — **BACKUP**) | SJC (só se `sp` cair) |

SJC tem **failover automático** (`sp` → `sp2`, ver P1-22 no BACKLOG): a backup só
é usada quando a primária "para de funcionar" (desativada ou com breaker aberto).

**Procedimento pra trocar uma senha (ex.: EDP rotacionou a do Ismael):**

```bash
cd ~/prod-stc
nano .env            # editar a senha da conta
```

⚠️ **SENHA COM CARACTERE ESPECIAL PRECISA DE ASPAS DUPLAS.** Se a senha tem `#`,
espaço, `$` ou aspas, o dotenv CORTA o valor sem aspas — `#` vira comentário e a
senha é truncada silenciosamente. Sempre:

```
WPA_PASSWORD_SP2="Ab3#xy9k2"
```

Confirme o que o Node carregou ANTES de reiniciar (não imprime a senha):

```bash
node -e "require('dotenv').config(); const p=process.env.WPA_PASSWORD_SP||''; console.log('len_pass='+p.length+' espaco='+/\s/.test(p));"
```

`len_pass` tem de bater com o tamanho REAL. Se vier menor (ex.: 3 numa senha de
9), a senha está truncada — faltam aspas. (Isso custou ~40min em 14/08/2026.)

Teste o login da conta direto, sem esperar o cron (1 tentativa, o breaker
protege — não trava a conta):

```bash
node -e "require('dotenv').config(); const w=require('./services/wpaService'); w.login({account:'sp'}).then(r=>console.log('>>> LOGIN OK (userId='+r.userId+')')).catch(e=>console.log('>>> FALHOU: '+e.message)).finally(()=>setTimeout(()=>process.exit(0),500));"
```

Só depois de `>>> LOGIN OK`, reinicie:

```bash
pm2 delete wpa-monitor && pm2 start ecosystem.config.js && pm2 save
```

**Pausar uma conta de propósito** (kill-switch, ex.: senha revogada e sem prazo):
`WPA_ACCOUNTS_DISABLED=sp` no `.env` + restart. Com a backup ativa, SJC segue via
`sp2`. Reativar = tirar do `.env` + restart.

> ### ⚠️ SJC roda SEM FAILOVER desde 26/08/2026 — decisão, não bug
>
> `WPA_ACCOUNTS_DISABLED=sp2` está ativo no `.env` **de propósito**. A senha da
> conta do Luan (`sp2`) ficou desatualizada no incidente de 24-25/08 e o José
> decidiu **não renová-la**. A cadeia `DSSJ → [sp, sp2]` continua no código
> (P1-22), mas na prática só a `sp` (Ismael) coleta São José dos Campos.
>
> **Por que a conta fica desativada em vez de só "com senha errada":** conta
> errada e habilitada é pior que desabilitada. A cada expiração de cooldown ela
> tentaria `/signin`, falharia, e consumiria uma das **5 tentativas** que a EDP
> concede antes de travar a conta — queimando devagar a conta de uma pessoa que
> nem usa o sistema. O kill-switch faz o roteador nunca escolhê-la, sem gastar
> nada.
>
> **O que isso custa:** se a `sp` cair (senha expirada, bloqueio, revogação),
> **SJC para inteiro** — não há para onde escorregar. Desde o P1-39 o painel
> avisa na hora ("coleta de São José dos Campos indisponível desde HH:MM") em
> vez de mostrar `0` como se fosse domingo, então a queda é visível; mas visível
> não é o mesmo que coberta.
>
> **Para religar o failover** (quando houver uma segunda credencial válida —
> do Luan ou de outra pessoa):
> 1. `WPA_PASSWORD_SP2='...'` no `.env`, com **aspas simples**;
> 2. confirmar o hash pelo método da seção "Usuário ou senha inválidos" acima —
>    **antes** de qualquer restart;
> 3. `sed -i '/^WPA_ACCOUNTS_DISABLED=/d' ~/prod-stc/.env` (confira que sobrou 0);
> 4. `DELETE FROM app_settings WHERE key='wpa_breaker';`
> 5. `pm2 delete wpa-monitor && pm2 start ecosystem.config.js && pm2 save`.
>
> Não pule o passo 2. Foi exatamente ele que faltou em 25/08 e custou um ciclo
> inteiro de recuperação fracassada.

> ⚠️ **MUDOU EM 21/08/2026 (P1-29): reiniciar NÃO limpa mais o breaker.**
> Ele agora é persistido em `app_settings.wpa_breaker`, porque o restart zerava a
> proteção e um crash-loop (`autorestart` + os 161 restarts num dia registrados no
> `ecosystem.config.js`) queimava os 5 logins da EDP em segundos — o incidente da
> conta do Ismael acontecia COM o P1-20 no ar. Para liberar antes do prazo, depois
> de corrigir o `.env`:
>
> ```bash
> node -e 'require("dotenv").config(); require("./db/queries").setSetting("wpa_breaker",{accounts:{},ts:new Date().toISOString()}).then(()=>console.log("breaker limpo no banco")).finally(()=>process.exit(0));'
> ```
>
> E **em seguida reinicie** — limpar o banco não apaga o breaker do processo que
> já está rodando; o restart zera a memória e a hidratação não encontra mais nada:
>
> ```bash
> pm2 delete wpa-monitor && pm2 start ecosystem.config.js && pm2 save
> ```
>
> Ver o estado atual sem limpar:
>
> ```bash
> node -e 'require("dotenv").config(); require("./db/queries").getSetting("wpa_breaker").then(r=>console.log(JSON.stringify(r&&r.data,null,2))).finally(()=>process.exit(0));'
> ```

**Se a conta travou na EDP** ("bloqueado após 5 tentativas, aguarde até HH:MM"): o
circuit breaker (P1-20) já impede isso daqui pra frente — no máx. 1 tentativa por
janela, e desde o P1-29 isso vale TAMBÉM entre reinícios. Se acontecer mesmo assim,
é só esperar o horário do desbloqueio ou usar a backup. NUNCA fique reiniciando pra
tentar logar com senha errada — é o que trava.

**"Usuário ou senha inválidos" mas a senha ESTÁ certa** — como provar, sem expor o
segredo e sem gastar tentativa (incidente 25/08/2026, SJC fora ~30h):

A senha da conta `sp` no `.env` estava desatualizada e tinha **exatamente o mesmo
número de caracteres** da nova. `len`, `cat .env` e leitura visual não denunciavam
nada — as três "pareciam certas". Só comparação de hash separou as duas.

```bash
# 1) hash do que o .env carrega (não imprime a senha)
cd ~/prod-stc && node -e 'require("dotenv").config({override:true});const c=require("crypto");for(const[k,p]of[["es","WPA_PASSWORD"],["sp","WPA_PASSWORD_SP"],["sp2","WPA_PASSWORD_SP2"]]){const P=process.env[p]||"";console.log(k.padEnd(4),"len="+P.length,"sha8="+(P?c.createHash("sha256").update(P).digest("hex").slice(0,8):"-"));}'

# 2) hash da senha que sabidamente funciona (não ecoa, não vai pro histórico)
read -rsp 'senha: ' P; echo; printf '%s' "$P" | sha256sum | cut -c1-8; unset P
```

Hashes diferentes = sequências diferentes. É aritmética, não opinião — serve
justamente para quando "tenho certeza de que a senha está certa".

Para descartar quoting antes de acusar a senha, hasheie as variantes da linha crua
(cru / sem aspas / com trim / o que o dotenv devolve). No **dotenv 16.x**:
`A=ab#c` carrega só `"ab"` (trunca no `#` em valor não-quotado), aspas **duplas**
expandem `\n`, aspas **simples** são literais (prefira-as), e as pontas sofrem
trim. Diferença de exatamente 2 caracteres entre cru e carregado = só o par de
aspas, normal.

Teste de desempate quando o hash não conclui: pegue o valor do `.env`
(`grep '^WPA_PASSWORD_SP=' .env`) e tente logar com ELE no portal
(https://edp-wpa-po.azurewebsites.net). O portal dá a mensagem real ("senha
expirada", "troca no primeiro acesso"), enquanto a API devolve sempre o genérico
`Usuário ou senha inválidos` — em **HTTP 200**, com `Error.Message` no corpo
(`wpaService.js:450`); se fosse rede ou cold-start, o erro seria outro.

> ⚠️ **`pm2 logs` mente sobre a origem da linha.** O prefixo (`79|wpa-mon`) é o id
> ATUAL do app, aplicado na LEITURA — não o id de quem escreveu. Com
> `merge_logs: true` todos gravam no mesmo arquivo, então linha de processo antigo
> aparece com o id do processo novo e parece recente. Ancore com
> `date -u` + `pm2 describe wpa-monitor | grep uptime` antes de concluir que um
> sintoma sobreviveu ao restart.

**Mensagem de erro nova da EDP:** desde o P1-32 uma mensagem que não casa com
nossos regexes ("Senha incorreta", "Too many attempts", 429/HTML) também abre o
breaker — cooldown curto (20 min, `WPA_UNKNOWN_ERROR_COOLDOWN_MIN`) a partir da 2ª
falha consecutiva. Antes disso, texto desconhecido = breaker nunca abria.

**Timeout:** desde o P1-31 toda chamada à EDP tem timeout de 20s
(`WPA_HTTP_TIMEOUT_MS`). Se o painel travar num setor específico, não é mais
promise pendurada — investigue o log.

### Disparar snapshot / consolidação por HTTP (cron manual)

As rotas `/api/cron/*` existem pra disparo manual ou por agendador externo. Elas
**não** usam o JWT de usuário — usam o `CRON_SECRET`.

> ⚠️ **MUDOU EM 28/08/2026 (P1-43): `?secret=` na URL não funciona mais.**
> Ele valia em produção apesar de estar documentado como "fallback de teste", e
> query string vaza pro `logs/out.log` do PM2, pro log de acesso do Fortinet, pro
> histórico do navegador e pro header `Referer`. Quem lesse a linha podia disparar
> `consolidate` em qualquer data — e re-consolidação de dia antigo SUBCONTA
> (P2-13), ou seja rebaixaria número já reportado à EDP sem deixar rastro de quem
> pediu. Agora é só header, em qualquer ambiente.

Snapshot agora:

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" http://localhost:3002/api/cron/snapshot
```

Consolidar uma data — ⚠️ **APAGA e reescreve** `team_daily_totals` de `{data-1, data}`:

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" "http://localhost:3002/api/cron/consolidate?date=2026-08-27"
```

Se o `CRON_SECRET` não estiver no ambiente do shell, leia do `.env`:

```bash
export CRON_SECRET=$(grep -m1 '^CRON_SECRET' ~/prod-stc/.env | cut -d= -f2-)
```

A data agora é validada: qualquer coisa fora de `YYYY-MM-DD` real devolve **400**
em vez de seguir pro `runConsolidate` — onde formato inválido virava erro engolido
pelo `try/catch` interno e o wipe podia rodar mesmo assim.

**Se algum agendador externo ainda chamar com `?secret=`, ele passa a tomar 401 em
silêncio.** Confira antes de deployar:

```bash
crontab -l | grep -n "api/cron"
```

### Verificar saúde geral

```bash
# Health-check consolidado (rodando? dados confiáveis? degradou?) — leva ~30-60s
node scripts/health-check.js

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

### Aplicar uma migration de banco

```bash
cd ~/prod-stc
psql -d wpa_monitor -f supabase/migrations/NNN_nome.sql
```

Duas armadilhas, as duas pisadas em 22/08/2026 aplicando a 012:

- **Não use `psql "$DATABASE_URL"`.** `DATABASE_URL` vive no `.env`, não no
  shell da VM. A variável expande vazia, o psql cai no banco default do usuário,
  e o erro é `FATAL: database "usr_jose" does not exist` — que parece problema de
  Postgres e é só variável vazia. O `psql -d wpa_monitor` sem credencial funciona
  porque `usr_jose` autentica por `peer`.
- **Owner.** Esse psql roda como `usr_jose`, mas o app conecta como `wpa_app`.
  Tabela criada por `usr_jose` e não reatribuída fica **sem permissão de escrita
  para o app** — é o mesmo motivo do passo `REASSIGN OWNED BY` no restore.
  Da 012 em diante a migration faz isso sozinha, no fim do arquivo; ao escrever
  uma nova, copie o bloco `DO ... IF EXISTS (pg_roles) ... ALTER TABLE OWNER` da
  012. Guardado por `IF EXISTS` porque em máquina de desenvolvimento a role
  `wpa_app` não existe e um ALTER solto abortaria a migration inteira.

Conferir que pegou (deve listar as colunas e o Owner `wpa_app`):

```bash
psql -d wpa_monitor -c "\d escalas_catalogo"
```

## Backfills

> ⚠️ **REGRA CRÍTICA — nunca rode backfill em múltiplos processos.**
> Em 09/07/2026 um backfill como `for d in $(seq 0 60); do node -e ...; done`
> (60 processos node paralelos, cada um abrindo um pool pg) **derrubou o
> Postgres por OOM** — a VM tem 3.8GB e **zero swap**. Produção ficou sem banco
> por ~2min. SEMPRE use 1 processo, sequencial, com pausa entre dias (script
> abaixo). Ver P0-0 no BACKLOG.

### Backfill de consolidação em massa (script oficial — 1 processo, seguro)

Corrige `team_daily_totals`/`team_daily_subcat_totals` de um período inteiro.
Ordem oldest→newest (cada dia é finalizado quando o seguinte consolida).
**Não roda em horário de pico se puder** (o cron para às 20h — janela ideal
é após 20h BRT).

Use o script oficial `scripts/backfill-consolidate.js` (NÃO improvise `node -e`
em loop de shell — foi o que causou o incidente de 09/07). Ele é single-process,
sequencial com pausa, e pega um **advisory lock do Postgres** que RECUSA uma 2ª
cópia concorrente por construção.

```bash
cd ~/prod-stc

# 1. DRY-RUN primeiro (só mede antes/depois por dia, não grava):
node scripts/backfill-consolidate.js 2026-05-09 2026-07-08

# 2. Se os números fizerem sentido, aplica (NÃO inclua o dia de hoje — é live):
node scripts/backfill-consolidate.js 2026-05-09 2026-07-08 --apply

# Opções: --pause=MS (default 800) · --force (ignora o lock; só se tiver CERTEZA
# que não há outra cópia — anula a proteção anti-OOM).
```

Validação após backfill (amostra 3 dias — todos devem dar `drift: false`):
```bash
node -e "require('dotenv').config(); const dw=require('./services/dataWriter'); (async()=>{ for (const d of ['2026-06-15','2026-06-30','2026-07-05']) { const r=await dw.detectDrift(d); console.log(d,'drift:',r.has_drift,'diff:',r.diff); } process.exit(0); })()"
```

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

## Backup offsite (P0-2)

**Estado (22/07/2026):** o backup **LOCAL** já roda automático via cron (03:01
diário, dumps `-Fc` em `~/backups/wpa_monitor/`, integridade verificada, retenção
14 dias) — confirmado com 15 dumps presentes. Isso já protege contra corrupção,
migração ruim e deleção acidental (as falhas mais comuns). Falta só o **OFFSITE**
(cópia fora da VM, pro caso de o disco/VM morrer).

### Offsite SIMPLES (recomendado se não quiser mexer com rclone)

Pelo **SFTP** (Termius ou qualquer cliente), copie periodicamente (semanal cobre)
o `.dump` mais recente de `~/backups/wpa_monitor/` pra uma pasta do **OneDrive**
no Windows. 1 arquivo (~600M), sem OAuth, sem config. Resolve o cenário de disco
morto. É "offsite manual" — suficiente enquanto o rclone não for prioridade.

### Offsite AUTOMÁTICO via rclone (opcional — automatiza o acima)

O `scripts/backup-wpa-monitor.sh` já tem a etapa: se o `rclone` estiver
configurado, copia o dump pro OneDrive após a verificação de integridade (retenção
offsite 30d). Sem rclone, degrada pra local sem quebrar. Setup **uma vez** (o
ponto chato é o OAuth headless — precisa de rclone no Windows p/ `rclone authorize`):

### 1. Instalar rclone no usuário (SEM sudo — binário único em ~/bin)

```bash
mkdir -p ~/bin && cd /tmp
curl -fSL -o rclone.zip https://downloads.rclone.org/rclone-current-linux-amd64.zip
unzip -o rclone.zip
cp rclone-*-linux-amd64/rclone ~/bin/rclone && chmod +x ~/bin/rclone
grep -q 'HOME/bin' ~/.bashrc || echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc
export PATH="$HOME/bin:$PATH"
rclone version   # confirma
```

> Se o Fortinet bloquear o download de rclone.org: baixe o zip na sua máquina
> Windows e suba pro servidor via `scp`, ou peça o binário à TI. É 1 arquivo.

### 2. Autorizar o OneDrive (OAuth headless — servidor não tem navegador)

Na VM: `rclone config` → `n` (new remote) → nome **`onedrive`** → tipo
**`onedrive`** (Microsoft OneDrive) → deixe client_id/secret em branco →
quando perguntar "Use auto config?" responda **`N`** (headless). O rclone imprime
um comando `rclone authorize "onedrive" ...`.

Na sua **máquina Windows** (com rclone instalado): rode esse comando, faça login
com `jose.zouain@engelmig.com.br`, autorize, e **copie o token JSON** que aparece.
Cole de volta no prompt da VM. Escolha a conta (Business/SharePoint) e confirme.

```bash
rclone listremotes            # deve listar "onedrive:"
rclone lsd onedrive:          # lista as pastas do OneDrive corporativo
rclone mkdir onedrive:wpa-backups
```

### 3. Rodar e conferir

```bash
~/backup-wpa-monitor.sh                       # dump + integridade + offsite
tail -20 ~/backups/wpa_monitor/backup.log      # deve ter "✓ Offsite OK"
rclone lsl onedrive:wpa-backups/               # dump do dia lá
```

O crontab (passo 4 da instalação do script) já cobre o agendamento diário 03h.
Retenção: **14 dias local**, **30 dias offsite** (sobrescrevível via
`OFFSITE_RETENTION_DAYS`).

### 4. Teste de restore a partir do OFFSITE (fecha o aceite)

```bash
# baixa o dump do OneDrive e restaura num banco de teste (NÃO toca produção)
rclone copy onedrive:wpa-backups/ /tmp/rtest/ --include "*_$(date +%Y-%m-%d)_*.dump"
createdb -h 127.0.0.1 -U wpa_app wpa_monitor_test 2>/dev/null || true
PGPASSWORD="$APP_PASS" pg_restore -h 127.0.0.1 -U wpa_app -d wpa_monitor_test \
  --clean --if-exists /tmp/rtest/wpa_monitor_*.dump
PGPASSWORD="$APP_PASS" psql -h 127.0.0.1 -U wpa_app -d wpa_monitor_test \
  -c "SELECT count(*) FROM snapshots;"   # sanidade
dropdb -h 127.0.0.1 -U wpa_app wpa_monitor_test
```

**Aceite:** `rclone version` roda sem sudo ✓ · `rclone lsd onedrive:` lista ✓ ·
backup diário grava em `onedrive:wpa-backups/` ✓ · restore do dump offsite
funciona ✓.

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

### "Postgres caiu / painel mostra db:error / ECONNREFUSED 5432"

Sintoma: `/health` retorna `{"db":"error","reason":"Postgres inacessível"}`,
ou `psql` dá `connection ... failed` / `ECONNREFUSED 127.0.0.1:5432`.

1. Confirma o estado do cluster:
   ```bash
   pg_lsclusters          # procura status: down
   psql -d wpa_monitor -c "SELECT 1;"
   free -h                # checa se foi OOM (memória estava cheia?)
   ```
2. **Reiniciar o Postgres exige a TI da Engelmig** — o cluster é de sistema
   (owner `postgres`) e `usr_jose` NÃO tem sudo. Comandos que a TI roda:
   ```bash
   sudo pg_ctlcluster 16 main start
   # ou: sudo systemctl start postgresql@16-main
   ```
   Observação: em 09/07/2026 o systemd auto-recuperou o Postgres em ~2min sem
   intervenção — pode ser que ele volte sozinho. Aguarde 2-3min e re-teste
   `psql SELECT 1` antes de acionar a TI.
3. Quando o banco voltar, o app precisa reconectar:
   ```bash
   psql -d wpa_monitor -c "SELECT 1;"     # confirma banco up
   pm2 restart wpa-monitor
   sleep 3 && curl -sS http://localhost:3002/health   # deve voltar db:ok
   ```
4. **Causa mais provável:** OOM por excesso de processos/conexões. O que
   derrubou em 09/07 foi um backfill em 60 processos paralelos (ver aviso na
   seção Backfills). VM sem swap não perdoa. Se recorrer, é P0-0 (pedir swap +
   auto-restart à TI).

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
