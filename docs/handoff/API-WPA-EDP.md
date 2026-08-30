# API WPA da EDP — referência completa

> **O que é isto.** Todo endpoint da API WPA que este projeto usa, o que ele
> devolve, quais campos aproveitamos, e as armadilhas de cada um. Mais os
> endpoints NOSSOS (backfill, conferência, fechamento) que consomem esses dados.
>
> **Escrito em 21/08/2026 lendo o código, não de memória.** Cada seção cita
> `arquivo:linha`. Se você mudar o código, atualize aqui — este documento existe
> para reduzir o bus factor (P0-1 do backlog), e documentação errada é pior que
> documentação nenhuma: nesta mesma semana três comentários desatualizados no
> código custaram horas de investigação (um índice que não existia, um cache que
> não compartilhava, e um endpoint marcado como "desconhecido" que funcionava).
>
> **Nada aqui é oficial da EDP.** Não existe documentação da API. Tudo foi
> descoberto por intercept do browser (DevTools no portal WPA) e por probe em
> produção. As datas nas notas indicam quando cada coisa foi confirmada.

---

## Índice

1. [Os dois hosts](#1-os-dois-hosts)
2. [Login e token](#2-login-e-token)
3. [Contas, setores e regionais](#3-contas-setores-e-regionais)
4. [Como uma requisição sai daqui](#4-como-uma-requisição-sai-daqui-wpafetch)
5. [Endpoints: equipes e sessões](#5-endpoints-equipes-e-sessões)
6. [Endpoints: notas](#6-endpoints-notas)
7. [Endpoints: motivo de rejeição](#7-endpoints-motivo-de-rejeição)
8. [Endpoints: notas devolvidas (backoffice)](#8-endpoints-notas-devolvidas-backoffice)
9. [Endpoints que existem e NÃO usamos](#9-endpoints-que-existem-e-não-usamos)
10. [O fluxo de coleta ao vivo, ponta a ponta](#10-o-fluxo-de-coleta-ao-vivo-ponta-a-ponta)
11. [O fluxo histórico (backfill por data)](#11-o-fluxo-histórico-backfill-por-data)
12. [Fechamento do dia (consolidação)](#12-fechamento-do-dia-consolidação)
13. [Nossos endpoints de admin, backfill e conferência](#13-nossos-endpoints-de-admin-backfill-e-conferência)
14. [Crons](#14-crons)
15. [Scripts de linha de comando](#15-scripts-de-linha-de-comando)
16. [Armadilhas que já custaram incidente](#16-armadilhas-que-já-custaram-incidente)

---

## 1. Os dois hosts

A WPA tem **dois** hosts distintos, e confundi-los dá 404:

| Papel | Host | Env var |
|---|---|---|
| **Autenticação** | `https://edp-wpa-po.azurewebsites.net` | `WPA_URL` |
| **API de dados** | `https://edp-wpa-web-api.azurewebsites.net` | `WPA_API_URL` |

`services/wpaService.js:60-61`. O host de auth é o mesmo do portal web
(`edp-wpa-po`), onde ficam as telas `/Notes/StatusNotes`, `/Notes/GestaoOnline`
etc. — é lá que a maioria dos endpoints foi descoberta por DevTools.

Os dois são **Azure App Service**, o que importa na prática: eles hibernam. Um
cold-start responde **403 ou 503 com uma página HTML** contendo
`"Web App - Unavailable"` — não é erro de credencial, e o retry resolve. Já foi
observado cold-start de **25 a 30 segundos** (`wpaService.js:493`).

---

## 2. Login e token

### `POST {WPA_AUTH}/identity/signin`

`services/wpaService.js:383-397`

**Corpo** (`application/x-www-form-urlencoded`):

```
Username=<email>&Password=<senha>
```

Montado com `URLSearchParams`, então o encoding é automático — diferente de
outros projetos que passam a string já url-encoded na mão.

**Header obrigatório:** `X-Requested-With: XMLHttpRequest`. Sem ele o portal
responde HTML de login em vez de JSON.

**Resposta:** `{ Token: "<JWT>", ... }`. O `exp` do JWT é decodificado para
definir o vencimento; se não der para decodificar, assume 1 hora
(`wpaService.js:422`).

**Onde o token vive:**

1. **memória**, por conta — `_tokens` Map (`wpaService.js:150`);
2. **banco** — tabela `wpa_token` via `db/wpaTokenStore`, para não relogar a cada
   reinício do processo.

`getToken(accountKey)` (`wpaService.js:528`) tenta nessa ordem e só faz `/signin`
se as duas falharem. Logins concorrentes no mesmo processo são serializados por
`_loginPromises` (`wpaService.js:151`), porque a WPA **invalida o token anterior**
quando recebe um login novo.

### ⚠️ A conta bloqueia após 5 logins falhos

Isso é o fato operacional mais importante deste documento. A EDP trava a conta e
responde *"bloqueado, aguarde até HH:MM"*. Aconteceu em produção em 13/08/2026
(conta do Ismael, SJC) e deixou a coleta parada a noite toda.

Proteções, em camadas:

| Mecanismo | Onde | O que faz |
|---|---|---|
| **Circuit breaker** | `wpaService.js:196-268` | Credencial inválida ou conta bloqueada → recusa `/signin` por um cooldown (12h em credencial inválida). No máximo 1 tentativa por janela — nunca chega a 5. |
| **Breaker persistido** | `wpaService.js` (`app_settings.wpa_breaker`) | O breaker sobrevive a restart. Antes era só memória, e um crash-loop zerava a proteção a cada boot. **Reiniciar não limpa mais** — ver RUNBOOK. |
| **Fail-closed** | `_openBreaker` | Mensagem de erro **desconhecida** também abre o breaker, em cooldown curto (20 min), a partir da 2ª falha consecutiva. Antes, texto fora dos dois regexes em português não abria nada. |
| **Kill-switch manual** | `WPA_ACCOUNTS_DISABLED` no `.env` | Desliga por completo a extração de uma conta — nem tenta login. |
| **Failover** | `SECTOR_ACCOUNT_CHAIN` | SJC tem conta primária + backup; a backup só entra quando a primária está desativada ou com breaker aberto. |

---

## 3. Contas, setores e regionais

`services/wpaService.js:76-95`

```
account 'es'   → WPA_USERNAME     / WPA_PASSWORD       (Clarissa — GUA e CAC)
account 'sp'   → WPA_USERNAME_SP  / WPA_PASSWORD_SP    (SJC — primária)
account 'sp2'  → WPA_USERNAME_SP2 / WPA_PASSWORD_SP2   (SJC — BACKUP)
```

Cadeia por setor (a 1ª **usável** vence):

```
DESG: ['es']   DESC: ['es']   DEPT: ['es']   DSSJ: ['sp', 'sp2']
```

Setores → regionais (`wpaService.js:1224-1229`):

| sectorId | Regional | Significado |
|---|---|---|
| `DESG` | GUA | Guarapari |
| `DEPT` | GUA | (segundo setor de Guarapari) |
| `DESC` | CAC | Cachoeiro |
| `DSSJ` | SJC | São José dos Campos — **EDP SP**, conta separada |

**Filtro da empresa.** A WPA devolve equipes de todas as empreiteiras do setor.
Só ficam as nossas, por `Team.CompanyId === ENGELMIG_COMPANY_ID`
(`wpaService.js:1234`, default `92a2f98e-8877-433e-8358-173b94c13a54`,
sobrescrevível por `WPA_COMPANY_ID`). Sem esse filtro, os números incluiriam
produção de terceiros.

O `sectorId` da requisição é o que roteia a conta: `_sectorFromPath` lê
`?sectorId=` do path e resolve a cadeia (`_sectorFromPath`, `wpaService.js:144`).

---

## 4. Como uma requisição sai daqui (`wpaFetch`)

`services/wpaService.js:622` — **toda** chamada à API de dados passa por aqui.
É o único ponto de saída, o que o torna o lugar certo para qualquer política
global (rate limit, semáforo, métricas).

O que ele faz, em ordem:

1. **resolve a conta** — `options.account` explícito, ou inferido do `sectorId`
   do path, ou a default (`es`);
2. **pega o token** via `getToken` (memória → banco → login);
3. **injeta** `Authorization: Bearer` e `Accept: application/json`;
4. **timeout de 45s** (`WPA_HTTP_TIMEOUT_MS`);
5. **retry** com backoff `[3s, 6s]`, até 3 tentativas, **só** para erro de rede
   e cold-start do Azure. **Timeout não é retentado** — o cold-start real chega
   como resposta HTTP, e 3 tentativas de 45s só multiplicariam a espera.

Erros legítimos da API (401, 404, 500 com JSON) são **propagados sem retry**,
para não esconder problema real.

---

## 5. Endpoints: equipes e sessões

### 5.1 `GET /api/teamsstatus/V2?sectorId={X}&filterByExhibitionSector=true`

**O endpoint mais importante do projeto.** É o que alimenta a tela "Gestão
Online" do portal, e dele sai quase todo o painel ao vivo.

`services/wpaService.js:765` — `getTeamStatusV2` — `getTeamStatusV2(sectorId)`

Devolve um item por equipe com sessão, contendo:

| Campo | Conteúdo |
|---|---|
| `Session` | `{ Id, BeginTime, EndTime, Team{Id,Name,Description,CompanyId}, Vehicle, VehicleCategory, Collaborators[] }` |
| `Concluded[]` | notas concluídas (inclui `ExecutionStatus` 4/5) |
| `Downloaded[]` | notas na carteira; o `ExecutionStatus` diz se é **baixada** (1/2) ou **executada/em andamento** (3/6/7) |
| `Assigned[]` | notas atribuídas e ainda não baixadas — **documentado e NÃO usado** |
| `Rejected[]`, `Executed[]` | **vêm sempre vazios desde 30/05/2026** (ver abaixo) |
| `Status` | texto: "Trabalhando na nota X", "Intervalo - 15…" |
| `Location` | `{ Latitude, Longitude }` |
| `ShiftType` | escala, no formato `"T07 07:00"` |
| `IsOnline`, `IsInLunchTime`, `LastUpdate`, `LastStatusUpdate` | telemetria |

**Cache:** `getV2Cached` guarda por setor com TTL de 3 min (`wpaService.js:781`, TTL em `:782`).
⚠️ Esse cache **não tem single-flight**: N chamadas concorrentes no mesmo miss
disparam N requisições idênticas. Está registrado como achado.

**`filterByExhibitionSector=true`:** nós passamos, o outro projeto que consome a
mesma API não passa. Suspeita registrada (backlog **P2-16**): esse parâmetro pode
ser justamente o que faz equipes visitantes desaparecerem do setor e nos obriga
ao fallback cross-setor (`wpaService.js:1407`, que varre `ALL_SECTORS`).

### 5.2 `POST /api/Sessions/all/date?sectorId={X}&date=M/D/YYYY`

`services/wpaService.js:817` — `getSessionsByDate(sectorId, isoDate)`

Sessões de **um dia específico**. É o endpoint que usamos na coleta ao vivo
(sim, ao vivo — ver a armadilha do `today` na seção 16) e no histórico.

**Formato da data:** `M/D/YYYY` — **mês primeiro**, sem zero à esquerda
(`toWpaDate`, `wpaService.js:808`). `3/7/2026` é 7 de março.

Devolve `Data[]`, cada item com `Id`, `BeginTime`, `EndTime`, `SessionEndBy`,
`Team{...CompanyId}`, `Vehicle`.

⚠️ **`Collaborators` vem vazio** aqui (`wpaService.js:778-779`).

### 5.3 `GET /api/Sessions/{sessionId}`

`services/wpaService.js:918` — `getSessionDetail(sessionId)`

**Único endpoint que devolve `Collaborators[]` com nome e matrícula.** Usado no
backfill histórico (`wpaService.js:966`), uma chamada por sessão.

⚠️ O fluxo **ao vivo** não chama isto — ele lê `Collaborators` de
`Sessions/all/date`, que vem vazio. Consequência verificada: o ranking de
rejeições por colaborador fica sem linhas. Registrado.

### 5.4 `GET /api/Sessions/today?sectorId={X}`

`services/wpaService.js:736` — `getSessions(sectorId)`

Sessões "de hoje". **Praticamente aposentado no caminho principal**, por causa da
armadilha de fuso da seção 16. Sobrou em rotas de debug.

### 5.5 `GET /api/Teams/Simple?sectorId={X}&statusId={N}`

`services/wpaService.js:1597` — `getTeamsSimple(sectorId, statusId=1)`

Lista "leve" de equipes — o dropdown de filtro do portal. O valor dele é trazer
**`CompanyId` e `CompanyName` preenchidos**, o que permite separar Engelmig de
EDP própria e de outras terceiras. Usado pelo monitor de notas devolvidas.

Precisa dos headers `Wpa-Data-Context: default` e `X-Requested-With`.

---

## 6. Endpoints: notas

### 6.1 `GET /api/notes/{categoria}/{sessionId}/session`

`getNotesForSession` (`wpaService.js:847`) e os dois `_safeNotes` (`:1448`, `:1484`)

Categorias em uso: **`rejected`**, **`executed`**, **`downloaded`**, **`surveyed`**.

**Por que existe:** em **30/05/2026** a EDP fez uma breaking change — `v2.Rejected`
e `v2.Executed` passaram a vir `null`/`[]` em 100% das equipes, e os dados
migraram para estes endpoints indexados por `sessionId`
(nota longa em `wpaService.js:1409-1435`). Sem eles, rejeitadas e em-andamento simplesmente
não existem.

**Custo:** +2 fetches por equipe no ciclo ao vivo (~86 por snapshot).

**Shape:** o mesmo do `v2.Rejected` legado — `Id`, `Number`, `Type`,
`ExecutionStatus`, `ConclusionDate`, `ConclusionStatus`, `Address`,
`Neighborhood`, `City`, `DesiredConclusionDate`.

⚠️ Falha aqui é **silenciosa**: `_safeNotes` (`wpaService.js:1448` e `:1484`) captura
a exceção e devolve `[]` com um `console.warn` "esvaziando bucket". A equipe
aparece sem rejeitadas e sem executadas, e nada no banco registra que foi falha
e não realidade. Foi exatamente assim que um timeout curto demais virou
"páginas não carregando tudo" em 21/08/2026.

### 6.2 `GET /api/Notes/{noteId}/details/optimized?sectorId={X}`

`services/wpaService.js:876` — `getNoteDetail(noteId, sectorId)`

O detalhe completo de uma nota. É o payload mais rico da API e o que sustenta o
modal de OS, a classificação de subcategoria e a análise de deslocamento.

Contém, entre muitos outros:

| Campo | Uso nosso |
|---|---|
| `Checkpoints[]` | `{ Id, Event, TimeStamp, RegisteredAt2, Latitude, Longitude, Mileage, BatteryLevel, Accuracy, FileWrappers[], Try }` — a trilha GPS. **`Try` não é lido** (registrado). |
| `Interruptions[]` | interrupções da nota — **vem de graça e é ignorado** (backlog **P1-24**) |
| `IssueDate`, `DesiredConclusionDate`, `ConclusionDate` | datas |
| `ConclusionStatus` | **pontualidade** (`ok`/`late`) — decodificado em 22/07/2026 |
| `Address`, `Neighborhood`, `City`, `CustomerName`, `InstallationId` | localização e cliente |
| `Comments` | observações |
| `Activities[]` | atividades, com `Amount` — é daqui que sai a **quantidade** de CS e de metros de ramal |

**Eventos do checkpoint** — conferidos contra o portal em 30/08/2026 (nota
104875481, `scripts/diag-po-reparo.js`):

```
0 → Início do Deslocamento     3 → Fim do Trabalho
1 → Fim do Deslocamento        4 → Finalizando Trabalho
2 → Início do Trabalho
```

O par `0→1` é um deslocamento. Cada novo `event=0` começa uma tentativa.

⚠️ **O evento 4 NÃO é "Interrupção/pausa".** Esta doc e o comentário de
`db/deslocamentosQueries.js:7-12` afirmavam isso; a conferência linha a linha com
o portal mostrou que é **"Finalizando Trabalho"**, e que ele fica ENTRE o início
e o fim do trabalho. Interrupção é outra coisa e vem de outro endpoint
(`completeInterruptions`, §6.4). O `CP_LABELS` de `public/index.html` está errado
de um terceiro jeito ainda — 2='Serviço concluído', 3='Saída do cliente',
4='Retorno/fim'. **Nenhuma das três listas concordava.**

### ⚠️ `TimeStamp` × `RegisteredAt` — use `RegisteredAt`

Medido na nota 104875481 (30/08/2026). O portal da EDP exibe `RegisteredAt`:

| evento | `TimeStamp` | `RegisteredAt` (portal) | erro |
|---|---|---|---|
| 2 Início do Trabalho | 16:53:45 | 16:53:17 | 28s |
| 4 Finalizando Trabalho | 17:26:02 | 17:25:47 | 15s |
| 3 Fim do Trabalho | 17:35:28 | 17:35:06 | 22s |
| 0 Início do Deslocamento | 17:35:43 | 16:40:53 | **55 min** |
| 1 Fim do Deslocamento | 17:35:43 | 16:51:24 | **44 min** |

`TimeStamp` é o relógio do aparelho **no envio**: os eventos 0 e 1 saem os dois
carimbados no instante da sincronização. `RegisteredAt` é quando o evento
aconteceu.

**Consequência em produção:** `services/notaProcessor.js` (`_cpTs`) prefere
`TimeStamp` e só cai pro `RegisteredAt2` quando aquele falta — e aqui ele vem
preenchido e errado, então o fallback nunca dispara. O deslocamento desta nota é
calculado como **0 segundos** contra **10m31s** reais. É a explicação das linhas
`REAL 0s` na aba Deslocamento.

**Campos do checkpoint que ignoramos** e podem valer: `RegisteredAt`,
`RegisteredAt2`, `ValidTime`, `DisplacementMinutes`,
`DisplacementInTrafficMinutes`, `Accuracy`, `IsWifiOn`, `MobileDataStrength`.
⚠️ `DisplacementMinutes` veio **5** onde o deslocamento real foi 10m31s — é
estimativa da EDP, **concorrente** do nosso OSRM, não medição.

### 6.2.1 Outros endpoints da mesma nota

Capturados do próprio portal com o Interceptor do Postman em 30/08/2026 (nota
104875481) e sondados um a um. Nenhum traz o **"Horário do Reparo"** da seção
"Detalhes da Execução → Ocorrência" — ele continua sem origem conhecida.

| Endpoint | O que devolve |
|---|---|
| `GET /api/Notes/{id}/completeInterruptions` | interrupções. Wrapper `getNoteInterruptions` (P1-33) existe e **não tem chamador** |
| `GET /api/Notes/{id}/historic` | histórico de atribuição/desatribuição por equipe |
| `GET /api/callback-information?noteId={id}` | seção "Callback Emergencial" do portal |
| `GET /api/notesMEC/{id}` | vazio na nota testada |
| `GET /api/notes/getFormattedEquipments/{id}` | vazio na nota testada |
| `GET /api/notes/{id}/getnotebreakdisplacementtime` | vazio na nota testada |
| `GET /api/listener-mode/logs?noteId={id}` | vazio na nota testada |
| `GET /api/notes/clustering/getName/{id}` | vazio na nota testada |
| `GET /api/Notes/{id}/details` | **idêntico** ao `/details/optimized` — mesmas 123 chaves |

O portal (`edp-wpa-po`) consome o **mesmo** `edp-wpa-web-api` que nós. Não são
sistemas separados.

**Cache:** tabela `note_details`, com TTL de **90 dias**
(`services/dataWriter.js:948-965`). ⚠️ Esse TTL apaga a **única** fonte de
checkpoints — a métrica de deslocamento não é reconstruível além de 90 dias, e
não é backfillável (exigiria 1 request por nota em meses passados). Backlog
**P2-18**.

### 6.3 `GET /api/notes/execution?sectorId={X}&date=M/D/YYYY`

`services/wpaService.js:834` — `getNotesByDate`. Notas de execução de um dia.
Devolve `Data.Notes[]`. Uso residual — o V2 cobre melhor.

---

## 7. Endpoints: motivo de rejeição

`services/rejectionService.js`

Aqui está a parte menos óbvia da API inteira, e vale ler antes de mexer.

**A descoberta de 25/05/2026:** o endpoint do motivo **não é por tipo da nota, é
por tipo do FORMULÁRIO**. Uma nota `RL` cujo formulário é "Vistoria de Entrada e
Serviço" (SF) responde em `/api/notes/sfrl`. Foi por isso que `rl`, `rlrl` e
companhia sempre deram 404 — esses paths não existem.

**A ressalva de 21/08/2026:** essa conclusão foi **generalizada demais**.
`/api/notes/vl` existe e é path **por tipo**. Os dois padrões convivem — e foi a
generalização que fez ninguém tentar `vl` por três meses, deixando 1.278
rejeições VL sem motivo e sem data.

### Formato

```
GET /api/notes/{tipoPath}?noteId={uuid}
```

Paths **confirmados** (`KNOWN_PATHS` e `CANDIDATE_PATHS`, `rejectionService.js:89-139`):

| Tipo | Path | Como se sabe |
|---|---|---|
| MD | `md` | confirmado |
| LN | `lnrl` | confirmado |
| SF | `sfdl` (primário), `sfrl` (fallback) | confirmado |
| VL | `vl` | confirmado em 21/08/2026 (20/20 notas) |
| DL | `sfdl` | descoberto por auto-descoberta |
| LE | `lnrl` | descoberto por auto-descoberta |
| RL | `sfrl` | descoberto por auto-descoberta |
| SM | — | **nenhum candidato funciona** (16 notas) |

**Auto-descoberta:** para tipo sem path confirmado, tenta os `FALLBACK_PATHS`
(`sfrl`, `sfdl`, `lnrl`, `md`) e depois candidatos por tipo, cacheando o primeiro
que devolver 200 com `Data.Rejection`. Há **cache negativo**: tipo que esgota
todos os candidatos com 404 é marcado e não é tentado de novo no processo — sem
isso, 1.278 notas × 8 candidatos seriam ~10 mil requisições inúteis.

⚠️ Tipo que **não está** em `KNOWN_PATHS` nem em `CANDIDATE_PATHS` cai num ramo
que devolve "sem motivo" **sem fazer nenhuma chamada**. Não é "o endpoint não
existe" — é "o tipo nunca foi tentado". Foi o caso de VL e SM. **Ao aparecer tipo
novo, adicione à tabela** — existe teste que falha se um tipo conhecido ficar
fora.

### Resposta

```
Data.Rejection: {
  RejectionReasons:   [{ Code, Description, Label }],
  RejectionReasonIds: "0101|0031",
  RejectedAt:         "2026-05-03T14:43:00",     ← autoritativo
  RejectedById, SessionId, Observation
}
Data.RejectionRen1000: {                          ← renderização do formulário
  RejectionHeader: { Observation, FormId },
  RejectionReasons: [...]                         ← aqui o campo é "Number", não "Code"
}
```

⚠️ **Os dois têm schemas diferentes** para a mesma coisa: `Rejection` usa `Code`,
`RejectionRen1000` usa `Number`. O normalizador trata os dois
(`normalize`, `rejectionService.js:~165`).

⚠️ **`RejectedAt` é o dado autoritativo da data da rejeição.** Quando falta,
caímos em `session_date`, que é *"o dia em que o coletor VIU a rejeição, que pode
ser posterior ao fato"* (`dataWriter.js:256-259`). Isso importa porque a regra de
negócio compara o dia da rejeição com o dia da conclusão.

---

## 8. Endpoints: notas devolvidas (backoffice)

### `POST /api/Notes/NotesStatusFilterBySector`

`services/wpaService.js:1613` — `getNotasDevolvidas(sectorId)`

Corpo: `sectorId={X}` como form-urlencoded. Headers `Wpa-Data-Context` e
`X-Requested-With` obrigatórios.

Descoberto por DevTools na tela `/Notes/StatusNotes`. Alimenta o monitor de
notas devolvidas (`services/notasMonitor.js`), que cruza com `Teams/Simple` para
saber a empresa de cada equipe.

Cada item tem `Number`, `Type`, `Team.Name`, `Status`, `ConclusionDate`,
`ConclusionStatus`, `Id` — e dezenas de campos nulos na listagem.

---

## 9. Endpoints que existem e NÃO usamos

Levantados na revisão de 20/08/2026 comparando com outro projeto que consome a
mesma API. Todos **confirmados em uso por lá**, nenhum implementado aqui:

| Endpoint | O que traz | Backlog |
|---|---|---|
| `GET /api/Notes/{id}/historic` | **janela de posse da nota por equipe** — `Team.Name`, `CreatedAt`, `RemovedAt`. Hoje inferimos isso por data de sessão. | P1-23 |
| `GET /api/Notes/{id}/completeInterruptions` | interrupções com `Id`, `TeamName`, `Date`, `Try` e **`RejectionReasonId`** — motivo de rejeição uniforme, 1 request, sem `sectorId` | P1-33 |
| `GET /api/Sessions/{id}/collaborators` | colaboradores da sessão | P2-14 |
| `GET /api/sessions/{id}/break` | **intervalos** da sessão, com `SessionBreakReason.Text` e `.Responsible` (quem autorizou a parada) | P2-15 |
| `GET /api/collaboratorshifts/{setor}/{mes}/{ano}` | **escala do mês** por equipe, com `ScaleCategoryName`. Códigos que não são dia trabalhado: `FOL, DR, DES, FER, DIS, AFO, NA, SAV, SIN, TRE` | P1-26, P2-24 |

E campos que chegam nos payloads que **já baixamos** e jogamos fora:
`ConclusionStatus` e `DesiredConclusionDate` nas listas baratas de nota (KPI de
pontualidade a custo zero de rede), `Checkpoints[].Try`, `Team.Description`,
`Team.LastUpdateWallet`, `LastLocationComunication`, `Assigned[]`.

---

## 10. O fluxo de coleta ao vivo, ponta a ponta

`services/dataService.js:getTeams` → `wpaService.js:getTeamsBySector`

Por **setor**, em série (nunca em paralelo — ver seção 16):

```
1. POST /api/Sessions/all/date?sectorId=X&date=<hoje BRT>   → sessões do dia
2. GET  /api/teamsstatus/V2?sectorId=X                      → status (cache 3min)
   ├─ filtra Team.CompanyId === ENGELMIG_COMPANY_ID
   ├─ para cada equipe, casa sessão × item do V2
   └─ equipe sem V2 no setor → fallback varrendo ALL_SECTORS
3. por equipe (concorrência 8):
   ├─ GET /api/notes/rejected/{sessionId}/session
   └─ GET /api/notes/executed/{sessionId}/session
4. buckets:
   ├─ concluidas  ← V2.Concluded[]
   ├─ baixadas    ← V2.Downloaded[] com ExecutionStatus 1/2
   ├─ executadas  ← notes/executed + Downloaded[] com 3/6/7
   └─ rejeitadas  ← notes/rejected
5. enriquecimentos (banco, não WPA): escala, logon real, concluídas de
   encerradas, carteira inicial
```

**Custo medido em 22/08/2026:** 3 setores, 83 equipes → **9,2s total, sendo
8,75s (95%) na coleta da EDP**. Os enriquecimentos somam 450ms. Instrumentado em
`dataService.js` — procure `[getTeams]` no log.

---

## 11. O fluxo histórico (backfill por data)

`wpaService.js:getTeamsByDate(sectorId, isoDate)`

```
1. POST /api/Sessions/all/date?sectorId=X&date=M/D/YYYY
2. filtra CompanyId Engelmig
3. por sessão:
   ├─ GET /api/Sessions/{sessionId}          → Collaborators reais
   ├─ GET /api/notes/executed/{sid}/session
   ├─ GET /api/notes/downloaded/{sid}/session
   ├─ GET /api/notes/rejected/{sid}/session
   └─ GET /api/notes/surveyed/{sid}/session
```

Diferença crítica em relação ao ao vivo: aqui **chamamos `Sessions/{id}`** por
sessão, o que traz os colaboradores. O caminho ao vivo não faz isso.

---

## 12. Fechamento do dia (consolidação)

Não envolve a WPA — trabalha sobre os snapshots já gravados. Mas é onde os
números que vão para a EDP nascem, então precisa estar aqui.

`services/dataWriter.js:consolidateDay(date)`

```
1. lê snapshots de {D-1, D}
2. _unionTeamsFromSnapshots → une todos os snapshots do dia por equipe
3. injeta rejeições de note_rejections (por note_id, SEM janela de data)
4. APAGA team_daily_totals e team_daily_subcat_totals de {D-1, D}
5. reagrega e grava
```

### ⚠️ A régua D versus D+1 — leia isto antes de comparar qualquer número

`consolidateDay(D)` monta as equipes a partir das sessões de `{D-1, D}`, **mas
apaga `{D-1, D}`**. Ou seja: **o valor final do dia D é escrito pelo passe de
D+1**, que vê sessões que só aparecem nos snapshots de D+1 (equipe que relogou de
manhã, nota transmitida com atraso).

A régua de D **subconta ~5%**. Comparar a tabela contra `consolidateDay(D, {dryRun})`
produz uma divergência permanente que nunca fecha — e foi exatamente essa
confusão que gerou o **P0-6**, onde o auto-reparo "corrigia" a tabela para baixo
e **apagava produção legítima**.

Essa régua me enganou quatro vezes. Se você for comparar números, use
`detectDrift`, que já usa a régua de D+1, ou o `scripts/verify-consolidacao.js`.

### A regra de negócio da produção

Definida pelo dono do produto em 31/07/2026, implementada em
`dataWriter.js:_contaComoExecutada`:

> Uma visita não conta como executada. A nota conta como executada **só para a
> equipe que a finalizou 100%**. Se a equipe vai à nota e ela é rejeitada, conta
> **somente como rejeitada** para essa equipe. Se a nota é reprogramada e outra
> equipe finaliza 100%, conta como executada só para quem finalizou.

Na prática, comparando por **dia** (não por minuto):

```
rejeição no MESMO dia da conclusão  → não é produção
rejeição DEPOIS da conclusão        → não é produção
rejeição ANTES da conclusão         → é produção de quem concluiu
```

Medido em 21/08/2026 sobre 19.573 rejeições: rejeição **nunca** troca de equipe
(0 casos), e rejeição posterior à conclusão **não existe** (0 casos contra 3.781
no mesmo dia) — a EDP recusa na análise da própria visita. As duas últimas
cláusulas são defensivas para casos que não ocorrem.

---

## 13. Nossos endpoints de admin, backfill e conferência

`routes/index.js`. Todos sob `/api`, autenticados por JWT
(`middleware/auth.js`); os de escrita exigem admin.

### Backfill e reprocessamento

| Rota | O que faz |
|---|---|
| `POST /admin/snapshot` | força um ciclo de snapshot agora |
| `POST /admin/backfill` | backfill de um dia |
| `POST /admin/backfill/range` | backfill de um intervalo |
| `POST /admin/consolidar` | roda `consolidateDay` para uma data |
| `POST /admin/backfill-rejeicoes` | coleta motivo de rejeição das notas ainda sem |
| `POST /admin/retry-outros` | reprocessa notas classificadas como OUTROS |
| `POST /admin/revalidate-dd` | revalida subcategoria DD |
| `POST /admin/subcat-reclassify` | reclassificação em lote (assíncrona) |
| `GET /admin/subcat-reclassify/status` | progresso da reclassificação |
| `POST /admin/sync-logoffs` | fecha sessões cujo logoff a EDP só expôs depois |
| `POST /admin/equipes/refresh` | recarrega o cache da whitelist |
| `POST /admin/warm` | força login/aquecimento do token |

### Conferência e diagnóstico

| Rota | O que responde |
|---|---|
| `GET /admin/health` | saúde geral: último snapshot, erros, equipes que não logaram |
| `GET /admin/drift` | divergência entre tabela e régua |
| `POST /admin/drift/repair` | reparo **monotônico** — só ADICIONA, nunca subtrai (P0-7) |
| `GET /admin/note-trace` | rastreia uma nota por todos os buckets e dias |
| `GET /admin/subcat-trace` | rastreia a classificação de subcategoria |
| `GET /admin/equipes-sem-producao` | equipes ativas sem produção no período |
| `GET /admin/team-search` | busca equipe por nome parcial |
| `GET /admin/wpa-diag` | estado das contas, tokens e breakers |
| `GET /wpa/token-status` | estado do token, sem tocar a rede |
| `GET /wpa/probe` | **proxy autenticado para qualquer path da WPA** — a ferramenta de exploração da API |
| `GET /wpa/nota/:noteId` | detalhe de uma nota, com cache |

⚠️ `GET /wpa/probe` já foi vetor de SSRF que vazava o token da EDP (backlog
P1-4, corrigido). Se mexer nele, releia o item.

### Dados do painel

Leitura: `/teams`, `/teams/historico`, `/teams/:teamId`, `/teams/deslogadas`,
`/equipes`, `/summary`, `/status`, `/totais/subcat`, `/totais/dia`,
`/historico/*`, `/performance/*`, `/ranking/equipes`, `/rejeicoes/*`,
`/deslocamentos/*`, `/carteira/equipes`, `/mapa/equipe`, `/notas/*`,
`/export/historico`, `/metas*`, `/contador-transgressao`, `/settings/:key`.

⚠️ `GET /summary` **não é chamado pelo front** e reintroduz a coleta de 4 setores
em paralelo — o padrão que o `dataService.js` proíbe por escrito. Armadilha
adormecida.

### Rotas de cron (`routes/cron.js`)

`GET /api/cron/warm`, `/snapshot`, `/consolidate` — autenticadas por
`CRON_SECRET`, **não** por JWT de usuário. Montadas antes de `/api` para escapar
do middleware de auth.

---

## 14. Crons

`services/cronService.js:1116-1180`

| Agendamento | Job | O que faz |
|---|---|---|
| `*/45 * * * *` | `runTokenRefresh` | renova o token. ⚠️ `*/45` no campo de minutos é **0 e 45**, não "a cada 45 min" — os intervalos reais alternam 45 e 15 min |
| `*/15 5-23 * * *` | `runSnapshot` | o ciclo principal de coleta |
| `30 0,2,4 * * *` | `runSnapshot` | snapshots de madrugada |
| `0 3 * * *` | `runSyncLogoffs` | fecha sessões cujo logoff apareceu depois |
| `50 23 * * *` | `runConsolidate` | **fechamento do dia** (D e D-1) |
| `5 6-20 * * *` | `runUuidHealthCheck` | invariantes de UUID |
| `25 6-20 * * *` | `runRetryRecentOutros` | reprocessa OUTROS recentes |
| `0 2 * * *` | `runDailyDriftSweep` | varre D-7..D-1 e repara (só adiciona) |
| `5 * * * *` | `runNotasCollect` | notas devolvidas |

⚠️ O log de boot e o RUNBOOK dizem "consolidação 20:30" — **está errado**, o cron
é `50 23`. Registrado no backlog.

Ao fim do `runSnapshot` há caudas disparadas **sem `await`**
(`cronService.js:206-235`): classificação de notas novas, cache de detalhes,
classificação de rejeições, sync de escalas. Elas ficam fora do lock e podem
gerar mais requisições que o próprio snapshot.

---

## 15. Scripts de linha de comando

Todos em `scripts/`. Rodar na VM com `node -r dotenv/config` quando precisarem do
banco (o `DATABASE_URL` vive no `.env`, não no shell).

**Backfill / escrita:**
`backfill-consolidate.js` (o runner **oficial** de re-consolidação — tem advisory
lock e é sequencial por design, depois de um incidente de OOM em 09/07/2026),
`backfill-rejections.js`, `backfill-rejeicoes-sem-data.js`, `backfill-carteira.js`,
`backfill-daily-subcat.js`, `backfill-osrm.js`, `backfill-subcategorias.js`,
`reconsolidar-produtividade.js`, `rebackfill-dd.js`, `rebackfill-md.js`,
`reclassify-*.js`, `migrar-first-cp-at.js`, `criar-indice-snapshots.js`.

**Conferência / leitura:**
`health-check.js` (rodando? dados confiáveis? degradou?), `verify-consolidacao.js`,
`audit-indicadores.js`, `diag-drift-team.js`, `diag-quem-escreveu.js`,
`diag-uuids-do-dia.js`, `diag-impacto-reconsolidacao.js`, `diag-nota-especifica.js`,
`diag-rejeicoes-*.js`, `diag-cobertura-*.js`, `diag-audit*.js`, e outros.

**⚠️ Regra:** todo script `diag-*` é read-only. Todo `backfill-*`, `rebackfill-*`,
`reclassify-*`, `migrar-*` e `criar-*` **escreve** — comece pelo `--dry-run`.

---

## 16. Armadilhas que já custaram incidente

**1. `Sessions/today` usa "hoje" em UTC.** Servidor em UTC + EDP em UTC: depois
das 21h BRT (00h UTC), `today` já devolve as sessões de "amanhã" — só o plantão
noturno, ~17 equipes em vez de 128. Exposto em 08/06/2026 às 21h, quando a
carteira inicial despencou e os KPIs do dia seguiam certos. **Solução:** usar
`Sessions/all/date` com a data BRT explícita (`wpaService.js:1343-1349`).

**2. Coleta em paralelo satura a EDP.** Com 4 setores em paralelo chegava-se a
~240 fetches simultâneos: o pool HTTP do Node (6/origin) enfileirava, dava
timeout, e o `_safeNotes` engolia devolvendo bucket vazio. Sintoma: notas vindo
vazias **intermitentemente** em modo ALL. **A coleta é serial por design** —
3 a 5 segundos mais lenta, resultados consistentes (`dataService.js:~570`).

**3. Datas `*2` da EDP.** A API devolve pares de campos: `ConclusionDate` e
`ConclusionDate2`, `RegisteredAt` e `RegisteredAt2`. A regra
(`notaProcessor.js:110-125`):

- campos **gerados pela EDP** (`IssueDate`, `DesiredConclusionDate`,
  `ImportDate`, `CreationDate`): a versão **2** está corretamente convertida com
  offset `-03:00` → **preferir a 2**;
- campos **vindos do app móvel** (`ConclusionDate`, `TimeStamp`, `cp.TimeStamp`):
  a versão 2 está **corrompida** — a EDP cola `-03:00` no fim da string UTC sem
  converter o valor, adiantando 3h → **usar a versão UTC e marcar com `Z`**.

E os `*2` vêm em `DD/MM/YYYY`, formato que o `new Date()` do JS lê como M/D:
**do dia 13 em diante é `Invalid Date`**. Isso fez a ordenação de checkpoints
virar no-op e os cards de deslocamento imprimirem `NaNmin` até 21/08/2026.

**4. Sentinela de nulo.** A EDP usa `0001-01-01T00:00:00` como data nula. Tratada
em alguns lugares, não em todos.

**5. O portal exibe linhas duplicadas.** Ao conferir contra a tela do WPA,
**conte por UUID, não por linha**. Validado na conferência de julho/2026.

**6. `filterByExhibitionSector=true`** pode ser a causa de precisarmos do
fallback cross-setor. Não confirmado — 1 probe resolve (P2-16).

**7. Comentário que afirma performance sem medida ao lado é suspeito.** Em
21/08/2026, três comentários desatualizados custaram horas: um índice
"que torna isso barato" e não existia; um cache que dizia coalescer as três
chamadas da aba Deslocamento e não coalescia; e o mapeamento de endpoint de
rejeição dizendo "desconhecido" para tipos que a auto-descoberta já resolvia.
Meça antes de confiar.

---

## Como explorar a API sem quebrar nada

```bash
# Estado das contas, tokens e breakers — não toca a rede
curl -s -H "Authorization: Bearer $JWT" localhost:3000/api/admin/wpa-diag | jq

# Probe autenticado em qualquer path (é o que descobriu quase tudo aqui)
curl -s -H "Authorization: Bearer $JWT" \
  "localhost:3000/api/wpa/probe?path=/api/Notes/<uuid>/completeInterruptions" | jq
```

⚠️ **Toda chamada consome orçamento da conta compartilhada.** A conta `es`
(`clarissa.alves`) é a mesma que outro projeto da empresa usa, com volume alto
(backlog P1-25). Antes de varrer endpoints em loop, lembre que 5 logins falhos
travam a conta e param a coleta de GUA, CAC e DEPT.
