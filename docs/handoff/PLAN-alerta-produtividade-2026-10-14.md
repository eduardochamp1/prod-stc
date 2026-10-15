# PLANO — Alerta de baixa produtividade

> Data: 2026-10-14. Executa a [SPEC-alerta-produtividade-2026-10-14.md](SPEC-alerta-produtividade-2026-10-14.md)
> (aprovada pelo José em 14/10/2026). **T1–T9 implementadas em 14/10/2026** (backlog P2-63);
> **T10 é do José, na VM.** Desvios do plano registrados abaixo, em "Execução".
>
> Regras do projeto que valem em TODA tarefa: ler o código antes de mexer
> (nunca inventar `arquivo:linha`); **não remover comentários datados**;
> `node --test` verde antes de cada commit (o hook de `pre-push` também roda);
> commit convencional; dados de fonte única; idempotência.
> Base: suíte com **1377 testes** verdes em 14/10/2026.

## Ordem e dependências

```
T1 minutosBRT ─┐
T2 funções puras ─┼─> T4 avaliarCiclo ─> T5 gancho no cron ─┐
T3 migration + queries ──┘                                   ├─> T8 backtest ─> T10 deploy
                          T6 rotas ──> T7 front ─────────────┘
                                         T9 docs (em paralelo com T6-T8)
```

T1–T5 são backend puro e testável sem banco. T7 só começa depois de T6 (o front
consome o contrato do endpoint). Nenhuma tarefa liga o alerta: `ativo:false`
até o passo final do José.

---

## T1 — `minutosBRT` no `timeUtil`

- **Arquivo:** `services/timeUtil.js` (+ export), teste em `test/timeUtil.test.js`
  (o arquivo **já existe**: acrescentar).
- **Passos:**
  1. Teste primeiro: `minutosBRT(new Date('2026-10-14T02:30:00Z'))` → `23*60+30`
     (UTC já é "amanhã", BRT ainda é "ontem"); `minutosBRT(new Date('2026-10-14T15:30:00Z'))` → `12*60+30`; meia-noite → `0` (não `1440`: tratar o `24` do `Intl` como `hourBRT` já faz).
  2. Implementar com `Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: 'numeric', hour12: false })` e `formatToParts` (não parsear string).
- **Pronto quando:** testes verdes; `hourBRT`/`dateBRT` intocados.
- **Commit:** `feat(timeUtil): minutosBRT (minutos desde a meia-noite BRT)`
- **Esforço:** pequeno.

## T2 — Funções puras de `services/alertaProdutividade.js`

- **Arquivos:** `services/alertaProdutividade.js` (novo), `test/alertaProdutividade.test.js` (novo).
- **Funções (TDD, uma por vez):**
  - `meioDoTurno(inicio, fim)` → minutos ou `null`. Casos: `'08:00'/'17:00'` → 750; `'08:00:00'/'17:00:00'`; vira-noite → `null`; inicio==fim → `null`; nulo/inválido → `null`.
  - `emRefeicao(breaks)` → `true` só se há item com `emAberto === true` e motivo `/refei/i`. Casos: intervalo fechado de refeição → `false`; aberto de outro motivo → `false`; lista vazia/`null` → `false`.
  - `validarConfig(raw)` → config normalizada ou **desligada**. Casos da spec §4 (ausente, ilegível, `limite` 0/negativo/não inteiro, categoria inexistente, `tolerancia` negativa). Importar `CATEGORIAS` de `services/categoriasEquipe.js`.
  - `avaliarEquipe(entrada)` → `{ estado, motivo }`. `entrada` = `{ agoraMin, config, escala:{inicio,fim}, executadas, rejeitadas, sessaoAberta, categoria, ehReal, jaAberto, jaResolvido, emRefeicao, adiadoDesdeMin }`. Cobrir **todas** as regras da §3 e os casos de borda: limite 3 vs 4; antes/depois do meio; depois do fim; sem escala → `ignorar` com `motivo:'sem_escala'`; vira-noite → `ignorar` com `motivo:'vira_noite'`; fantasma/encerrada/categoria desligada → `nenhum`; em refeição → `adiar`; passada a tolerância → avalia; aberto e `executadas >= limite` → `resolver`; resolvido nunca reabre; aberto e ainda abaixo → `manter`.
- **Pronto quando:** funções **puras** (sem `require` de banco/WPA no topo do arquivo); cobertura de cada ramo da §3.
- **Commit:** `feat(alertas): regras puras do alerta de produtividade (meioDoTurno, emRefeicao, validarConfig, avaliarEquipe)`
- **Esforço:** médio (é onde mora a regra de negócio).

## T3 — Migration 016 e camada de acesso

- **Arquivos:** `supabase/migrations/016_alertas_produtividade.sql`, `db/alertasQueries.js`.
- **Passos:**
  1. Migration conforme §5 da spec, com `CREATE TABLE IF NOT EXISTS`, `UNIQUE (data, team_name)`, índice em `(data)` e o bloco `DO $$ … OWNER TO wpa_app … $$` **copiado da 015** (incluindo a sequence).
  2. `db/alertasQueries.js`: `upsertAbrir(linha)` (`ON CONFLICT (data, team_name) DO NOTHING`), `atualizar(data, team, campos)`, `resolver(data, team, quando)`, `listarAtivos(regionais)` (`resolvido_em IS NULL`, dia = `dateBRT()`), `historicoSupervisores()`.
  3. **O `upsert` do `pgShim` NÃO serve para abrir o alerta** (verificado em `pgShim.js:301-313`): ele gera `ON CONFLICT … DO UPDATE SET` para toda coluna que não é chave, então um 2º ciclo **sobrescreveria** `disparado_em` e `executadas_disparo`. Só vira `DO NOTHING` quando todas as colunas são chave. Portanto `upsertAbrir` usa **SQL direto** (`INSERT … ON CONFLICT (data, team_name) DO NOTHING`) pelo pool, como `heQueries.js` faz; `atualizar`/`resolver` usam `UPDATE … WHERE data=$1 AND team_name=$2 AND resolvido_em IS NULL` (o filtro garante que um resolvido não é reaberto nem reescrito). Atenção à armadilha do NULL no `upsert` (backlog P3-14).
  4. Escopo de regional em `listarAtivos` via `inRegionals` (de `services/regionals`, o helper que `db/queries.js` usa; **proibido** consulta sem filtro de regional — `db/queries.js:43` tem `_assertRegionals`). Como a leitura é por SQL direto, usar `inRegionalsSql` (mesma origem).
- **Pronto quando:** SQL revisado contra a 015; funções finas (a regra fica na T2).
- **Commit:** `feat(alertas): migration 016 e db/alertasQueries`
- **Esforço:** pequeno–médio. **Risco:** o `upsert` do shim (passo 3) — já tratado.

## T4 — `avaliarCiclo(deps)`

- **Arquivos:** `services/alertaProdutividade.js`, `test/alertaProdutividade.ciclo.test.js` (novo).
- **Contrato de `deps`:** `{ agora(), teams, lerConfig(), lerExecutadas(date), lerAtivos(date), lerHistoricoSupervisores(), getMeta(sigla), lerRefeicao(sessionId), gravar:{abrir, atualizar, resolver} , log }`. Nada de `require` de banco/WPA dentro de `avaliarCiclo`: tudo entra por parâmetro (lição do P2-39).
- **Fluxo:** config → se `!ativo` retorna sem tocar em nada → para cada equipe REAL: monta `entrada` → `avaliarEquipe` → aplica. Consulta de refeição **só** para quem estaria a alertar, **máx. 8 por ciclo**; falha de `lerRefeicao` ⇒ `adiar` (não alerta).
- **Testes (com `deps` falsas):** idempotência (rodar 2× ⇒ mesmas gravações, 0 duplicatas); `ativo:false` ⇒ zero chamadas; teto de 8; falha de refeição não alerta; fantasma ignorada; supervisor vigente gravado; conta de "sem escala" e "vira-noite" devolvida no retorno (usada no backtest e no log).
- **Pronto quando:** o teste de ponta a ponta passa **sem banco e sem WPA**.
- **Commit:** `feat(alertas): avaliarCiclo com dependencias injetadas`
- **Esforço:** médio.

## T5 — Gancho no cron

- **Arquivo:** `services/cronService.js`, logo após `await upsertTeamDailyTotals(allTeams)` (hoje `:234`).
- **Passos:** montar as `deps` reais (leitor de totais = `SELECT team_name, SUM(count) FROM team_daily_totals WHERE date=$1 GROUP BY 1`; refeição = `getSessionBreaks` de `wpaService`) e chamar `avaliarCiclo(...)` **sem `await`** no caminho do ciclo, com `.catch(err => log.error('alerta_produtividade_failed', …))`, no padrão de `upsertTeamDailyCarteira().catch(...)`.
- **Teste:** de fonte (a chamada existe, vem depois do `upsertTeamDailyTotals`, e tem `.catch`) + o teste de T4 cobre a lógica. **Não** rodar a WPA em teste.
- **Pronto quando:** com `ativo:false` o ciclo se comporta **exatamente** como hoje (nenhuma chamada extra à WPA, nenhuma escrita).
- **Commit:** `feat(alertas): avalia o alerta apos cada ciclo de coleta (desligado por padrao)`
- **Esforço:** pequeno. **Risco:** montar `deps` reais erradas — por isso o teste de fonte e a revisão do `diff`.

## T6 — Rotas

- **Arquivo:** `routes/index.js` (+ `test/alertasRotas.test.js`).
- **Passos:**
  1. `GET /api/alertas/produtividade`: lê config; `ativo:false` ⇒ `{ ativo:false, alertas:[] }`; senão `listarAtivos(req.scope.regionals)`. Formato do item: `{ equipe, regional, supervisor, executadas, rejeitadas, limite, meioTurnoEm, turno:{inicio,fim} }`. **Não** devolver `err.message` cru (item P3-18a).
  2. `PUT /admin/alertas/config`: só admin (mesmo middleware das outras rotas `/admin`), `validarConfig` e `setSetting('alerta_produtividade', …)`; 400 com mensagem fixa se inválido.
  3. Seguir o padrão de `metas_diarias` (`routes/index.js:926-970`) para o desenho das rotas.
- **Testes:** escopo de regional (conta ES não vê SJC), `ativo:false` ⇒ vazio, não-admin ⇒ 403 no PUT, config inválida ⇒ 400.
- **Commit:** `feat(alertas): rotas GET /api/alertas/produtividade e PUT /admin/alertas/config`
- **Esforço:** pequeno–médio.

## T7 — Frontend (depois da T6)

- **Arquivos:** `public/index.html`, `public/css/app.css`, `test/alertasFront.test.js` (estilo `test/remotasNaII.test.js`).
- **Passos:**
  1. Markup: bloco `.fab-avisos` irmão dos `.tab-panel` (🔔 + contador + painel `hidden`), lado esquerdo; no celular, canto inferior esquerdo (o balão de ações sobe para `bottom: 84px` à direita — não colidir).
  2. JS `carregarAvisos()`: `fetch` do endpoint; renderiza linhas; escapa **todo** texto (`escapeHtml`); filtro por supervisor reutilizando `_supPopularSelect`; contador no `document.title`.
  3. **Gancho de atualização:** chamar `carregarAvisos()` (a) no `boot`, (b) **dentro** do `setInterval` de 5 min existente (`index.html:~9586`) mas **fora** do `if (isRangeToday…)`, (c) ao abrir o painel. Nenhum timer novo.
  4. `ativo:false` ⇒ o balão não aparece. Falha de rede ⇒ "Avisos indisponíveis".
  5. a11y: `aria-live="polite"`, ESC fecha e devolve o foco.
- **Testes de fonte:** balão no DOM; `carregarAvisos` chamado dentro do `setInterval` e fora do `if`; `document.title`; uso de `escapeHtml`; nenhum `alert(`/`confirm(`/modal/`setInterval` novo.
- **Verificação visual:** abrir o painel (preview) e conferir 0 alertas, 1 alerta e vários, desktop e celular. **Não declarar pronto sem ter olhado.**
- **Commit:** `feat(painel): balao de avisos (lado esquerdo) com alertas de baixa produtividade`
- **Esforço:** médio.

## T8 — Backtest (`scripts/backtest-alerta-produtividade.js`)

- **Passos:** reaplicar a regra por equipe/dia nos últimos 30 dias, usando o último `snapshots` com `captured_at <=` meio do turno (`concluidas`/`rejeitadas` e a `data` jsonb para dedup por UUID, **mesma** regra rejeitada > concluída). Saída: por dia × categoria → nº de equipes avaliadas, nº que alertariam, distribuição de `executadas`; e **à parte**: sem escala, vira-noite, e "refeição não considerada" se for o caso (§9 da spec). Somente leitura. Opções `--dias=N`, `--limite=N`.
- **Reuso:** as funções puras da T2 (`meioDoTurno`, `avaliarEquipe`); **não** reescrever a regra no script.
- **Teste:** a função de reconstrução do estado no meio do turno (pura) com snapshots falsos.
- **Pronto quando:** roda na VM em tempo razoável e o José consegue ler a saída sem ajuda.
- **Commit:** `feat(alertas): backtest da regra sobre 30 dias de snapshots`
- **Esforço:** médio.

## T9 — Documentação (em paralelo)

- `docs/handoff/BACKLOG.md`: item **P2-63** (alerta de baixa produtividade) + linha no índice, com status e os hashes.
- `docs/handoff/ARCHITECTURE.md`: onde vive a métrica e o novo gancho do cron.
- `docs/handoff/RUNBOOK.md`: como ligar/desligar (`ativo`), como editar o limite, como aplicar a 016.
- **Commit:** `docs(alertas): P2-63, ARCHITECTURE e RUNBOOK`

## T10 — Deploy e ativação (feito pelo José, na VM)

1. **Aplicar a migration 016 ANTES do código** (incidente de 07/10): `psql -d wpa_monitor -f supabase/migrations/016_alertas_produtividade.sql`; conferir `\dt+ alertas_produtividade` e o owner `wpa_app`.
2. `cd ~/prod-stc && git pull && pm2 delete wpa-monitor && pm2 start ecosystem.config.js && pm2 save`. (Nunca `--update-env`.)
3. Confirmar no log que o ciclo segue normal e **não há** `alerta_produtividade_failed`.
4. `node scripts/backtest-alerta-produtividade.js` → José lê.
5. **Só se o backtest for razoável:** ligar `ativo:true` (script/psql ou `PUT /admin/alertas/config`) e acompanhar o 1º dia.
6. **Rollback:** `ativo:false` (imediato). Código: `git revert`. A tabela pode ficar.

---

## Riscos e pontos de atenção

| Risco | Mitigação |
|---|---|
| `upsert` do `pgShim` sobrescreve (`DO UPDATE SET`) em vez de ignorar duplicata — **confirmado** em `pgShim.js:301-313` | T3 passo 3: abrir o alerta por SQL direto com `DO NOTHING`; `UPDATE` com `resolvido_em IS NULL` |
| Montar `deps` reais erradas no cron (os testes de cron são cegos — P2-39) | `avaliarCiclo` 100% injetável (T4) + teste de fonte do gancho (T5) + `ativo:false` por padrão |
| Consulta de refeição estoura a conta WPA compartilhada (P1-25) | Teto de 8 por ciclo; só equipes candidatas; falha ⇒ não alerta |
| Regra dispara em muitas equipes (ruído) | Backtest antes de ligar; critério de parada na spec §9 |
| Meio do turno errado se `escala_fim` do SGE não for início+9h | Conferir no backtest (§10.2 da spec) |
| `index.html` monolítico: edição frágil | Edições pequenas e localizadas + testes de fonte; olhar a tela antes de declarar pronto |

## Estimativa de ordem de trabalho

T1 → T2 → T3 → T4 → T5 (backend, ~1 sessão) · T6 → T7 (~1 sessão) · T8 → T9 (~1 sessão)
· T10 (José, na VM). Cada tarefa fecha com suíte verde e commit próprio; dá para
parar entre quaisquer duas sem deixar o sistema quebrado, porque o alerta só liga
no passo 5 do T10.

## Execução (14/10/2026)

Todas as tarefas fecharam com suíte verde e commit próprio (1377 → 1583 testes).
Desvios do plano, todos registrados na spec:

- **T2:** a tolerância de refeição é medida a partir do **meio do turno** (adia até
  `meio + tolerância`), não "desde o 1º adiamento" — evita guardar estado entre ciclos.
- **T3:** a tabela ganhou `escala_inicio`/`escala_fim` (o painel mostra o turno).
- **T6:** além do `PUT`, um `GET /api/admin/alertas/config`. O `PUT` **mescla** com o
  gravado (mandar só o limite não desliga o alerta) e valida antes de exigir o banco.
- **T7:** no celular o círculo **subia** até o meio do painel ao abrir — achado na
  conferência visual e corrigido (`align-items: flex-end`), com teste.
- **T8:** o núcleo do backtest virou módulo puro (`services/alertaBacktest.js`) e o
  `timeUtil` ganhou `instanteBRT`; o script é só I/O, testado com pool falso.
- **Intermitência:** na T4, uma execução da suíte teve 1 falha que não se repetiu em 3
  reexecuções (mesmo padrão do **P3-19**; não identifiquei o arquivo). A partir da T5
  o commit só sai com `fail 0`.

