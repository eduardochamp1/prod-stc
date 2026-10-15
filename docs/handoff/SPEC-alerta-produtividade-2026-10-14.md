# SPEC — Alerta de baixa produtividade (balão de avisos, lado esquerdo)

> Data: 2026-10-14 · Pedido do José. Status: **desenhado, não implementado**.
> Brainstorm fechado em 14/10/2026. Revisada contra o código na mesma data:
> toda âncora `arquivo:linha` abaixo foi **lida**, não lembrada (§12 lista o que
> a revisão corrigiu). Nasce **desligado** (`ativo: false`) até o backtest (§9)
> ser lido pelo José.
>
> Toca backend (avaliador + tabela + endpoint) e frontend (balão novo). **Não
> altera nenhuma agregação nem número reportado à EDP**: o alerta só LÊ a produção.

## 1. Objetivo

Avisar supervisores/coordenadores quando uma equipe chega à **metade do turno**
com **menos de 4 notas executadas**, para que acompanhem de perto, cobrem ou
procurem saber o motivo.

Restrição de produto: usuários reclamam de **excesso de informação na tela**.
O aviso é **silencioso por padrão** — sem popup, sem modal, sem som.

## 2. Decisões

### 2.1 Fechadas com o José

| # | Decisão | Escolha |
|---|---|---|
| D1 | Limite | **4 notas**, em configuração (não no código) |
| D2 | O que conta | **Só executadas não rejeitadas** (mesma regra do card "OS Executadas") |
| D3 | Contexto no alerta | Mostra também as **rejeitadas** da equipe no dia |
| D4 | Ação do supervisor | **Nenhuma.** Só avisa; some da lista quando a equipe chega ao limite |
| D5 | Categorias | **Comercial, Plantão, Moto, BT Zero.** Operacional fora; lista em configuração |
| D6 | Onde roda | **Backend**, após cada ciclo de coleta. "Só no navegador" rejeitada |
| D7 | Superfície | **Balão novo no lado ESQUERDO**, só de avisos. O balão de ações (borda direita) **não é tocado** |
| D8 | Popup | **Não.** Contador no balão + contador no `<title>` da aba |
| D9 | Entrega ativa (Teams/e-mail) | **Fora** (fase 2) |
| D10 | Refeição | O José confirmou que a equipe **aponta a refeição** (§10.1) |
| D11 | Escala | O José confirmou que **todas as equipes têm escala no SGE** (§10.2) |
| D12 | Fuso | **Horário da região (BRT)** (§10.3) |

**Por que D8:** popup interrompe, e a queixa é excesso de tela. O `<title>` com
contador (`(3) WPA Monitor`) avisa com a aba em segundo plano sem competir com o
que a pessoa faz. O app também não tem toast.

**Por que D7:** ações (Atualizar, Acordar WPA) e avisos são coisas diferentes;
misturar mudaria a spec do balão atual sem necessidade.

**Por que D9 fica fora:** as 5 contas do painel são **compartilhadas por região**
(a do ES vê GUA+CAC); não há login por supervisor. O alerta chega a quem abrir o
painel, filtrável por supervisor, **não a uma pessoa específica**. Chegar à
pessoa exige contato de cada supervisor e passar pelo Fortinet.

### 2.2 Adotadas por mim durante a revisão (o José pode vetar)

| # | Decisão | Motivo |
|---|---|---|
| A1 | Só avalia equipe com **sessão aberta** (`sessionEnd` nulo) | Equipe que já encerrou o turno é outro assunto; avaliar geraria alerta de quem já foi embora |
| A2 | **Turno que atravessa a meia-noite fica fora da v1** (`escala_fim <= escala_inicio`) | O cron intraday usa `_sessionDate` (o `_effDate` só existe na consolidação), então o "dia" de um turno vira-noite é ambíguo ao vivo. Entra no backtest como **contagem à parte** |
| A3 | Máximo de **8 consultas de refeição por ciclo** | A conta WPA é compartilhada com outro projeto (P1-25) |
| A4 | O front consulta o endpoint **dentro do `setInterval` de 5 min já existente** | Não criar timer novo (§7) |
| A5 | O alerta **fica gravado para sempre** (sem expurgo) | Volume ínfimo (≤ 1 linha por equipe por dia) e é o "registro de notificação" que o José pediu |

## 3. A regra

Uma equipe gera alerta no dia D quando **todas** forem verdadeiras:

1. Está na whitelist (`equipesOficiais.getMeta(sigla)` não nulo) e
   `categoriaDaSigla(sigla)` está em `config.categorias`.
2. Tem **sessão de hoje aberta**: está em `teams` (as equipes REAIS — **não** as
   fantasmas do `_acc`, que são equipes já deslogadas), `_sessionDate(t) ===
   dateBRT()` e `sessionEnd` nulo (A1). Equipe deslogada NÃO gera alerta: é outro
   problema, coberto pelas telas de sessão/deslogadas.
3. O turno **não atravessa a meia-noite** (A2) e
   `meio_turno <= agora_BRT < escala_fim`, com
   `meio_turno = (escala_inicio + escala_fim) / 2`, tudo em **minutos desde a
   meia-noite BRT**. Ex.: Comercial 08:00–17:00 → 12:30.
4. `executadas < config.limite`, onde `executadas` = **soma de `count` de
   `team_daily_totals`** para `date = dateBRT()` e a equipe (§6, "Fonte").
5. **Não** está em refeição **agora**: sem intervalo de refeição **em aberto** na
   sessão (§10.1). Em refeição, o alerta **espera o ciclo seguinte**; passados
   `config.tolerancia_refeicao_min` desde o primeiro adiamento, avalia mesmo
   assim (almoço de mais de 1h também é informação).

**Um alerta por equipe por dia.** Se depois a equipe chegar a `limite`, o alerta
é marcado como **resolvido** (sai da lista, fica no registro) e **não volta a
disparar** no mesmo dia.

### Casos de borda (todos têm teste)

- **Sem escala** na equipe (`escala_inicio`/`escala_fim` nulos) → **não avalia** e
  é contada como "sem escala" (§9). Nunca inventa horário. (Sem fallback por
  prefixo: o José confirmou que todas têm escala; se faltar, é dado a corrigir,
  não a mascarar.)
- Turno com `escala_fim <= escala_inicio` → **não avalia** (A2), contado à parte.
- `executadas` **cai** depois do disparo (nota concluída vira rejeitada): o
  alerta pode ABRIR num ciclo posterior; **não reabre** um resolvido.
- Dia sem equipe avaliável → lista vazia, sem erro.
- Ciclo repetido (reexecução) → mesmo resultado, nenhuma linha duplicada (§5).

## 4. Configuração

`app_settings`, chave `alerta_produtividade`, lida/gravada por
`db/queries.js` → `getSetting(key)` / `setSetting(key, value)` (o mesmo caminho
de `metas_diarias`):

```json
{
  "ativo": false,
  "limite": 4,
  "categorias": ["COMERCIAL", "PLANTAO", "MOTO", "BT_ZERO"],
  "tolerancia_refeicao_min": 60
}
```

- Ausente ou ilegível → **tudo desligado** (`ativo:false`). Nunca assume ligado.
- Validação (função pura): `limite` inteiro ≥ 1; `categorias` ⊂ chaves de
  `CATEGORIAS` (exportada por `services/categoriasEquipe.js`; `OPERACIONAL` é
  aceita mas fora do padrão); `tolerancia_refeicao_min` inteiro ≥ 0.
- Edição: `PUT /admin/alertas/config` (só admin). **Sem tela de edição na v1**;
  até lá, por script/psql.

## 5. Dados

Migration **`supabase/migrations/016_alertas_produtividade.sql`** (a série
numerada em uso; a última é `015_supervisores.sql`). Inclui o bloco
`DO $$ … ALTER TABLE … OWNER TO wpa_app … $$` **idêntico ao da 015** — tabela nova
sem owner correto é o que trancou o login em 07/10 (P0-1d). **Aplicar ANTES** do
deploy do código (RUNBOOK, "Aplicar uma migration").

```
alertas_produtividade
  id                 bigserial PK
  data               date        not null      -- dateBRT() do disparo
  team_name          text        not null
  regional           text        not null
  sector_id          text
  supervisor         text                      -- supervisorVigente(historico, sigla, data); null = sem supervisor
  limite             int         not null      -- limite em vigor no disparo
  meio_turno_em      timestamptz not null
  executadas_disparo int         not null
  executadas_atual   int         not null      -- atualizada a cada ciclo enquanto aberto
  rejeitadas         int         not null default 0
  disparado_em       timestamptz not null
  resolvido_em       timestamptz
  UNIQUE (data, team_name)                     -- idempotência: 1 alerta/equipe/dia
```

Escrita **idempotente** (princípio do projeto): disparo é
`INSERT … ON CONFLICT (data, team_name) DO NOTHING`; os ciclos seguintes só
**atualizam** `executadas_atual`, `rejeitadas` e `resolvido_em`. Reexecutar um
ciclo não duplica nem reabre.

## 6. Backend

| Unidade | Papel | Depende de |
|---|---|---|
| `services/timeUtil.js` — **`minutosBRT(when)`** (NOVA) | Minutos desde a meia-noite BRT (0..1439), por `Intl` com `America/Sao_Paulo`. O `timeUtil` hoje só tem `dateBRT`, `hourBRT` (hora cheia) e `dateBRTMinusDays` — **não** tem minutos | `Intl` |
| `services/alertaProdutividade.js` — `meioDoTurno(inicio, fim)` | **Pura**: minutos do meio, ou `null` se o turno atravessa a meia-noite. Aceita `'HH:MM'`/`'HH:MM:SS'` (formato de `escala_*`) | — |
| `services/alertaProdutividade.js` — `emRefeicao(breaks)` | **Pura**: há intervalo `emAberto` com motivo `/refei/i`? | lista de `getSessionBreaks` |
| `services/alertaProdutividade.js` — `avaliarEquipe(entrada)` | **Pura**: `{ estado: 'nenhum'\|'abrir'\|'manter'\|'resolver'\|'adiar' \| 'ignorar', motivo }` | só dados passados |
| `services/alertaProdutividade.js` — `validarConfig(raw)` | **Pura** (§4) | `CATEGORIAS` |
| `services/alertaProdutividade.js` — `avaliarCiclo(deps)` | Orquestra: monta entradas, chama `avaliarEquipe`, grava | deps **injetadas** |
| `db/alertasQueries.js` | `upsertAbrir`, `atualizar`, `resolver`, `listarAtivos(regionais)`, `historicoSupervisores()` | pgShim |
| `routes/index.js` | `GET /api/alertas/produtividade` (escopo `req.scope.regionals`), `PUT /admin/alertas/config` | auth existente |
| `services/cronService.js` | chama `avaliarCiclo` logo após `await upsertTeamDailyTotals(allTeams)` (`cronService.js:234`), **sem bloquear o ciclo** (`.catch` com `log.error`, padrão de `cronService.js:259`) | — |

**Cadência:** o `runSnapshot` roda em `*/15 5-23 * * *` (de 05:00 a 23:45) e às
00:30/02:30/04:30 (`cronService.js:1469-1476`). O alerta é avaliado em **todo**
ciclo; turnos comuns (07–23h) são cobertos pelos de 15 min.

**Fonte de `executadas` (fonte única — regra do projeto):**
`team_daily_totals`, a MESMA tabela que alimenta a coluna EXEC da matriz. Ela é
gravada **a cada ciclo** por `upsertTeamDailyTotals(allTeams)`
(`dataWriter.js:384-420`), que já aplica **dedup por UUID entre sessões** e a
regra **rejeitada > concluída** (decisão 20/07/2026). O avaliador roda DEPOIS
dessa gravação, no mesmo ciclo, então lê o valor do ciclo corrente. É
**proibido** recontar `notasConcluidas` por outro caminho.
> ⚠️ A função `_notasConcluidasReais` é do **frontend** (`index.html:8129`), não
> do backend. Não existe helper compartilhado no servidor: a regra vive em linha em
> `_aggregateTeamDailyTotals` e `upsertSubcatTotals`. Por isso a fonte é a TABELA.

**Limite conhecido, aceito:** a rejeição "por nota" (regra de 31/07 — rejeitada no
dia da conclusão ou depois) só é aplicada na **consolidação noturna**
(`consolidateDay`), não no ciclo intraday. Logo `executadas` ao meio-dia pode
incluir uma nota que a EDP rejeitará depois (ex.: SF "Conta Paga"; ver P2-61).
Efeito: o alerta tende a **subalertar**, nunca a alertar por engano. Documentar,
não corrigir.

**`rejeitadas` (contexto, D3):** união por `id` de `notasRejeitadas` das entradas
da equipe em memória no ciclo.

**`supervisor`:** `supervisorVigente(historico, sigla, dataISO)`
(`services/supervisores.js`) com o histórico lido de `equipe_supervisor_historico`
**uma vez por ciclo**, não por equipe.

**`escala`:** `equipesOficiais.getMeta(sigla).escala_inicio` / `.escala_fim`
(`equipesOficiais.js:180-187`), tipo `TIME`.

**Por que `deps` injetadas:** o backlog P2-39 documenta que funções de cron são
**invisíveis à suíte** (saem cedo sem banco; erro de escopo só estoura em
produção, na hora agendada). `avaliarCiclo` recebe relógio, leitor de totais,
leitor de refeição, gravador e config por parâmetro; o teste a exercita de ponta
a ponta com dados falsos.

**Instâncias = 1** (regra 8 do CLAUDE.md): nenhum estado novo em memória do
processo; o estado vive na tabela.

## 7. Frontend

- Bloco novo, **irmão dos `.tab-panel`**, `position: fixed` na **borda esquerda**
  (aparece nas 9 abas sem repetir markup). O balão de ações usa as classes
  `.fab-acoes*` (`app.css:4562-4667`, borda direita; no celular vai para
  `bottom: 84px`). O novo usa o prefixo **`.fab-avisos*`** e, no celular, fica no
  **canto inferior esquerdo**, para não colidir com ele.
- Fechado: círculo 🔔 com **contador** (oculto quando 0). Aberto: painel curto.
- Cada linha: `ECXXX00 · GUA · Sup. FULANO` e abaixo
  `2 executadas (+1 rejeitada) às 12:30 · turno 08–17h`. Ordenação: menos
  executadas primeiro; empate pelo disparo mais antigo.
- Vazio: `Nenhum alerta agora.`
- Filtro por **supervisor**, reaproveitando `_supPopularSelect`. O escopo por
  regional vem do servidor (a conta só recebe o que pode ver).
- Contador também no `document.title` (`(3) WPA Monitor`); some quando 0.
- **Atualização:** o app **não** tem polling geral; o único timer é o
  `setInterval` de 5 min do Monitor (`index.html:9586`), que só recarrega quando o
  período é "hoje". O consultor de avisos é chamado **dentro desse mesmo
  `setInterval`, fora do `if (isRangeToday…)`** (avisos valem em qualquer aba e
  período), **no `boot`** e **ao abrir o painel**. Nenhum timer novo.
  Latência máxima: até 5 min (front) + até 15 min (ciclo) = **~20 min** do fato ao
  contador.
- Acessibilidade: `aria-live="polite"` no contador; ESC fecha e devolve o foco ao
  toggle (mesmo padrão do balão de ações).
- **Sem** popup, modal, toast ou som.
- Todo texto vindo do banco (sigla, supervisor) passa por `escapeHtml` /
  `escapeJsAttr` — o commit 684d277 (`escapeJsAttr` nos `onclick` com dado da EDP)
  mostrou que atributo com dado externo é vetor.

## 8. Erros

- Falha de config/banco/avaliação → `log.warn` + **nenhum alerta novo**; a lista
  mostra o que já estava gravado. Nunca fabrica número.
- Falha da consulta de refeição (timeout, 5xx) → **não alerta neste ciclo** para
  aquela equipe (nunca alerta por falta de informação).
- Falha do endpoint no front → o balão mostra `Avisos indisponíveis`, sem derrubar
  a aba.
- `ativo:false` → o endpoint responde `{ ativo: false, alertas: [] }` e o balão
  **nem aparece**.

## 9. Testes e rollout

**Testes** (`node --test`; função pura primeiro):

- `minutosBRT`: um instante UTC que já é "amanhã" em UTC e ainda "hoje" em BRT;
- `meioDoTurno`: 08:00–17:00 → 12:30; `'HH:MM:SS'`; **turno que atravessa a
  meia-noite → `null`**; início = fim → `null`;
- limite exato (3 alerta, 4 não); `limite` configurável;
- `executadas` vem de `team_daily_totals` (soma por equipe/dia); rejeitadas só
  como contexto;
- sem escala → ignora e **conta à parte**; deslogada (fantasma), sessão
  encerrada e categoria desligada **não** alertam;
- refeição **adia**; passada a tolerância, avalia; **falha da consulta → não
  alerta**; teto de 8 consultas por ciclo;
- resolve ao chegar a `limite` e **não reabre**; 1 por equipe por dia;
- `validarConfig`: ausente/ilegível → desligado; limite inválido; categoria
  inexistente;
- `avaliarCiclo` com `deps` falsas: **idempotente em 2 execuções**;
- endpoint respeita o escopo de regional; `ativo:false` → vazio;
- front (estilo `test/remotasNaII.test.js`): balão no DOM, chamada dentro do
  `setInterval` existente e fora do `if (isRangeToday…)`, contador no `<title>`,
  texto escapado.

**Backtest antes de ligar** — `scripts/backtest-alerta-produtividade.js`:
reaplica a regra sobre os **últimos 30 dias**. Para cada equipe/dia reconstrói o
estado **no horário do meio do turno** a partir de `snapshots`
(`captured_at`, `team_name`, `session_*`, `concluidas`, `rejeitadas`): o último
snapshot da equipe com `captured_at <=` meio do turno. Imprime, por dia e por
categoria, quantas equipes teriam alertado e a distribuição de `executadas`.
Imprime também, **à parte**, as equipes **sem escala** e os **turnos vira-noite**
ignorados.

- **Refeição no backtest:** o histórico vem de `sessao_intervalo` (D-1 em diante;
  é sincronizada às 03:10, `cronService.js:545`), lida com `AT TIME ZONE 'UTC'`
  para desfazer o `Z` errado do P1-48 (mesma técnica da Medição HE,
  `heQueries.js:423-430`). Se isso não for confiável o bastante, o backtest roda
  **sem** o adiamento por refeição e **diz isso na saída**: o resultado vira um
  **teto** de alertas, não uma previsão exata.
- **Critério de parada:** se a regra alertaria uma fração alta e constante das
  equipes (ordem de dezenas de %), o limite ou a regra estão errados — **não
  ligar**, rediscutir com o José.

**Ordem de deploy:** (1) migration 016; (2) código com `ativo:false`; (3) rodar o
backtest na VM; (4) José lê e decide; (5) `ativo:true`.
Deploy normal: `git pull && pm2 delete wpa-monitor && pm2 start ecosystem.config.js && pm2 save`.

**Rollback:** `ativo:false` desliga tudo na hora, sem deploy. A tabela pode ficar.

## 10. Verificações — RESOLVIDAS (14/10/2026)

**10.1 Refeição ao vivo.** O José confirmou que a equipe aponta a refeição. Mas
o caminho exige cuidado, medido no código:

- `sessao_intervalo` **NÃO serve**: é sincronizada **uma vez por dia, às 03:10,
  para o dia anterior** (`cronService.runSyncIntervalos`). O almoço de hoje não
  está lá no meio do turno.
- Serve `getSessionBreaks(sessionId)` (`GET /api/sessions/{id}/break`), ao vivo
  (`wpaService.js:1118`). O `id` da equipe em memória **é** o id da sessão
  (`wpaService.js:2294`).
- "Em refeição agora" = existe intervalo com **`emAberto` (`EndTime` nulo)** e
  motivo casando `/refei/i` (vem como "15 - Horário de Refeição").
- **Isso dispensa comparar horários.** O `inicio/fim` dos intervalos tem o defeito
  de fuso do **P1-48** (`Z` anexado a hora de parede, 3h adiantado), mas um
  intervalo em aberto não precisa de relógio. A regra **não depende do P1-48**.
- **Custo controlado:** só se consulta a equipe que já estaria a alertar (passou
  do meio do turno, `executadas < limite`, sem alerta aberto), no máximo **8 por
  ciclo** (A3), e a consulta para assim que o alerta abre.
- Equipe que não apontou a refeição → o alerta abre normalmente (é o caso que o
  supervisor quer ver).

**10.2 Escala.** O José confirmou: todas as equipes têm escala no SGE. O
**P2-47** (30/08) registrava 10 equipes da whitelist ausentes; se já foi
corrigido, está fechado. Se sobrar alguma, ela é **ignorada e contada** (§3, §9)
— não há fallback por prefixo. Observação: `escala_fim` vem do SGE como início +
9h (8h + 1h de refeição); o catálogo de turnos tem turnos que desmentem o +9h,
mas os 5 em uso coincidem (memória do projeto) — **conferir no backtest** se o
meio do turno calculado bate com a realidade das equipes em uso.

**10.3 Fuso — horário da região (BRT).** Decisão do José. Toda comparação
(`agora` × meio do turno; `escala_*` é `TIME` sem zona) é feita em **BRT** pelo
`timeUtil` (`dateBRT`, e a nova `minutosBRT`). **Proibido** `-3h` fixo (o P3-12
documenta 5 lugares que ainda o fazem). Teste obrigatório em §9.

## 11. Fora de escopo (v1)

- Ação do supervisor ("acompanhando", motivo) — D4; reavaliar após ver o ruído.
- Teams/e-mail/WhatsApp — D9.
- Tela de edição da configuração.
- **Turno que atravessa a meia-noite** (A2).
- Outros tipos de alerta (equipe parada, sessão anômala etc.). A tabela se chama
  `alertas_produtividade` de propósito; um catálogo geral de notificações só se
  justifica quando existir o segundo tipo (YAGNI).
- Peso por tipo de nota (SF é rápida, DD/MD demoradas). O limite é por **nota**;
  se o backtest mostrar viés por categoria, vira item próprio.
- Aplicar a rejeição "por nota" (31/07) no ciclo intraday — ver "Limite conhecido,
  aceito" em §6.

## 12. O que a revisão de 14/10/2026 corrigiu nesta spec

Registro de honestidade: a 1ª versão tinha afirmações **que o código desmentiu**.

1. Citava `_notasConcluidasReais` como "a mesma função do backend". É do
   **frontend**; a fonte passou a ser `team_daily_totals` (§6).
2. Dizia que o `timeUtil` bastava. Ele **não tem minutos**; ganha `minutosBRT` (§6).
3. Dizia "sem `setInterval` próprio, no ciclo de refresh das abas". Não existe
   refresh geral; o único timer é o de 5 min do Monitor, condicionado a "hoje".
   Corrigido em §7, com a latência real (~20 min).
4. Usava `_effDate` para o dia do alerta. No intraday ele é **ausente**
   (`dataWriter.js:388-390`); o dia é `_sessionDate`. Turno vira-noite saiu da v1.
5. Previa fallback de escala por prefixo da sigla. Removido: o José confirmou que
   todas têm escala; mascarar dado faltante contraria a regra 7 do CLAUDE.md.
6. Apontava `migrations/`. A série numerada em uso é `supabase/migrations/`
   (016, com o bloco `OWNER TO wpa_app` da 015).
7. Não definia "logada hoje". Agora: equipe REAL (não fantasma), sessão de hoje,
   `sessionEnd` nulo (A1).
8. Não dizia onde `getSetting`/`setSetting` moram (`db/queries.js`) nem que a
   `CATEGORIAS` é exportada.
9. O backtest dizia "snapshots" sem dizer como reconstruir o meio do turno. Agora:
   último snapshot com `captured_at <=` meio do turno.
