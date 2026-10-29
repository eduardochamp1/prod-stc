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
9. [Endpoints secundários: os que já usamos e os que não usamos](#9-endpoints-secundários-os-que-já-usamos-e-os-que-não-usamos)
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
3. **injeta** `Authorization: Bearer` e `Accept: application/json` — e o
   `User-Agent` próprio vem do `services/wpaHttp.js`, por onde sai TODO HTTP
   pra EDP, login incluso (ver armadilha 8 da §16);
4. **timeout de 45s** (`WPA_HTTP_TIMEOUT_MS`);
5. **retry** com backoff `[3s, 6s]`, até 3 tentativas, **só** para erro de rede
   e cold-start do Azure. **Timeout não é retentado** — o cold-start real chega
   como resposta HTTP, e 3 tentativas de 45s só multiplicariam a espera.

Erros legítimos da API (401, 404, 500 com JSON) são **propagados sem retry**,
para não esconder problema real.

**Contador (19/10/2026, P0-11):** todo HTTP que sai pelo `services/wpaHttp.js`
(login, Web API e retries, cada tentativa uma vez) é contado em
`services/wpaContador.js` por hora BRT, endpoint e origem (`painel:…`,
`cron:<job>`, `cron-http:…`, `interno`). Para ler: `GET /api/admin/wpa-requisicoes`
(memória, 48 h) ou `grep wpa_requisicoes_hora logs/out.log` (sobrevive a restart).

**Limite em voo (19/10/2026, P0-11 item 4 / P2-30):** o `wpaHttp.js` também
passa toda chamada pela fila de `services/wpaFila.js` — no máximo
`WPA_MAX_EM_VOO` (6) ao mesmo tempo contra a EDP, somando tudo do processo, com
o painel na frente. A vaga envolve só a chamada HTTP; o timeout conta a partir
de quando ela sai.

**Sessão encerrada (19/10/2026, P0-11 item 3):** colaboradores buscados 1 vez
por sessão; notas congelam depois de `WPA_ENCERRADA_CONGELA_MIN` (desligado por
padrão — escolha pelo `scripts/diag-sessao-encerrada.js`). Ver
`services/coletaIncremental.js`.

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

### 6.2.2 `GET /api/notes/po?noteId={uuid}` — a execução das notas PO

**Achado em 30/08/2026** depois de sondar 21 endpoints. É a seção "Detalhes da
Execução" do portal, e a **única** fonte do **"Horário do Reparo"**. Não existe em
lugar nenhum do `details/optimized`.

```
Execution.PowerOnExecution.RepairTime            "2026-08-29T20:18:45+00:00"
Execution.PowerOnExecution.PredictionRepairDate  "2026-08-29T21:10:25+00:00"
Execution.PowerOnExecution.ConfirmationDate      "2026-08-29T20:25:25+00:00"
Execution.PowerOnExecution.HasRepair             true
Execution.PowerOnExecution.IncidentDevice        "C 0000844791"
Execution.PowerOnExecution.Class / Reason / Climate   "350" / "329" / "1"
Execution.PowerOnExecution.TeamOnTargetResult    "confirmado"
Execution.PowerOnExecution.ActionServices[]      { Action, Phases, Comments }
Execution.Circuit / InstallationPlace / Observation / Try / SessionId
POIncidents[].POIncidentHierarchies[]            dispositivos e clientes protegidos
```

Mapeamento com o que o portal exibe: `RepairTime` = **Horário do Reparo**,
`PredictionRepairDate` = Tempo Estimado, `ConfirmationDate` = Data,
`IncidentDevice` = Dispositivo, `Class`/`Reason`/`Climate` = o bloco **CCC**.

#### ⚠️ Fusos DIFERENTES na mesma comparação

Este é o ponto que mais facilmente vira erro de 3h:

| campo | formato | exemplo | instante real |
|---|---|---|---|
| `RepairTime` | **UTC**, com `+00:00` | `2026-08-29T20:18:45+00:00` | 17:18:45 BRT |
| checkpoint `RegisteredAt` | **local, SEM marcador** | `2026-08-29T17:25:47` | 17:25:47 BRT |
| checkpoint `RegisteredAt2` | local, com `-03:00` | `2026-08-29T17:25:47-03:00` | 17:25:47 BRT |

Comparar `RepairTime` com `RegisteredAt` **cru** dá 3h de erro — um vem em UTC e
o outro sem fuso nenhum. **Use `RegisteredAt2`**, que traz o offset explícito;
aí os dois viram instante absoluto e a subtração fecha:

```
20:25:47Z (evento 4) − 20:18:45Z (RepairTime) = 7m02s
```

E o erro **depende do fuso do processo**, o que o torna pior: medido com os
valores reais da nota 104875481,

```
TZ=America/Sao_Paulo   RegisteredAt2 → +7,03 min    RegisteredAt → +7,03 min
TZ=UTC   (a VM)        RegisteredAt2 → +7,03 min    RegisteredAt → −172,97 min
```

Ou seja: usar o campo cru **funciona na máquina do dev e quebra em produção**,
com 3h de erro que ainda inverte o sinal. Viraria "reparo apontado 3h depois de
terminar o trabalho" — absurdo plausível o bastante pra passar por anomalia de
campo em vez de bug de código.

`HasRepair` diz se houve reparo — nota com `false` não entra no indicador.

#### Custo de ingestão

**Uma requisição por nota PO.** São ~91 notas PO/dia (8.402 em 92 dias, medido em
30/08/2026), então o custo corrente é baixo; o backfill das 8.402 já cacheadas é
um one-off que precisa de throttle.

**Onde é chamado (conferido no código em 20/10/2026).** O wrapper é
`getNotePoExecution` (`services/wpaService.js:1105`), que devolve o
`PowerOnExecution` já normalizado (`repairTime`, `hasRepair`, `classe`,
`causa`, `clima`…). Dois chamadores:

- **ao vivo:** `cachearNota` (`services/noteDetailCacher.js:90`), na cauda do
  snapshot (`runCacheNotaDetails`, `services/cronService.js:382`, sem `await`).
  Só para `Type === 'PO'`, depois de gravar o `details/optimized`. Se falhar, a
  nota **não** é marcada como falha: o backfill pega depois;
- **backfill:** `scripts/migrar-po-reparo.js`, que retoma por ausência de linha.

Grava em `note_po_reparo` (`db/poReparoQueries.js:116`).

> Até 20/10/2026 este parágrafo dizia que nenhum caminho do cron chamava o
> endpoint e que não existia wrapper. Era verdade em 30/08; o código andou e o
> documento não acompanhou (backlog P3-22).

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

## 9. Endpoints secundários: os que já usamos e os que não usamos

Levantados na revisão de 20/08/2026 comparando com outro projeto que consome a
mesma API. **Até 20/10/2026 esta seção dizia que nenhum estava implementado.**
Conferido no código em 20/10/2026: todos ganharam wrapper em
`services/wpaService.js` entre 22 e 23/08/2026 (`87072f5`, `7c47055`, `56a0b80`,
`098dcfe`), e quatro dos cinco têm chamador em produção (backlog P3-22).

### 9.0 Já implementados

| Endpoint | O que traz | Wrapper | Quem chama | Backlog |
|---|---|---|---|---|
| `GET /api/Notes/{id}/historic` | **janela de posse da nota por equipe** — `Team.Name`, `CreatedAt`, `RemovedAt` | `getNoteHistoric` (`wpaService.js:1003`) | **só** `scripts/diag-nota-posse.js`. Nenhum caminho de produção: a posse segue inferida por data de sessão | P1-23 |
| `GET /api/Notes/{id}/completeInterruptions` | interrupções com `Id`, `TeamName`, `Date`, `Try` e `RejectionReasonId` (que traz o **texto** do motivo), sem `sectorId` | `getNoteInterruptions` (`:1057`) | `runColetaInterrupcoes` (`services/interrupcaoService.js:238`), na cauda do snapshot (`cronService.js:395`) → `note_interrupcoes`. Usar como motivo de rejeição uniforme segue pendente | P1-33 |
| `GET /api/collaborators/{sessionId}/session` | colaboradores da sessão, com `Code` e `Name` | `getSessionCollaborators` (`:2165`) | coleta ao vivo (`_getTeamsBySectorUncached`, `:2558`), só quando a lista de sessões e o V2 vieram sem colaboradores | P2-14, P2-28 |
| `GET /api/sessions/{id}/break` | **intervalos** da sessão, com `SessionBreakReason.Text` e `.Responsible` (quem autorizou a parada) | `getSessionBreaks` (`:1137`) | `runSyncIntervalos` (`cronService.js:674`, cron 03:10, sessões de ontem → `sessao_intervalo`); `desviosAoVivo` (`db/rotinaQueries.js:558`, tela de uma equipe no dia de hoje); `runAlertaProdutividade` (`cronService.js:209`, cauda do snapshot) | P2-15 |
| `GET /api/collaboratorshifts/{setor}/{mes}/{ano}` | **escala do mês** por colaborador, com `ScaleCategoryName`. Códigos que não são dia trabalhado: `FOL, DR, DES, FER, DIS, AFO, NA, SAV, SIN, TRE` | `getCollaboratorShifts` (`:1221`) | `runSyncEscalaDia` (`cronService.js:579`, crons `20 5-22` e `50 5-21`) → `escala_dia` | P1-26, P2-24, P2-65 |

⚠️ **O path dos colaboradores estava errado aqui.** Esta tabela listava
`GET /api/Sessions/{id}/collaborators`. Com id de **sessão** ela devolve
`Data: null` sem erro HTTP: espera o id do serviço, apesar do nome (medido por
outro projeto, comentário em `wpaService.js:2154-2160`). O que usamos é
`collaborators/{sessionId}/session`, o mesmo que o portal chama (§9.1).

⚠️ **Fuso, pendente (P1-48).** `getNoteHistoric` e `getSessionBreaks` passam as
datas por `_instanteWpa` → `_normTzIso` (`wpaService.js:963-976`), que anexa `Z`.
Para o `break`, o P1-48 mediu que a EDP manda hora de **parede**: a
`sessao_intervalo` está gravada 3h adiantada. O `completeInterruptions` já foi
corrigido em 07/10/2026 e anexa `-03:00`.

### 9.0.1 Também em uso, e que não estavam neste documento

| Endpoint | Wrapper | Quem chama |
|---|---|---|
| `GET /api/scaletypes/matches?sectorId={X}` | `getScaleTypes` (`wpaService.js:1341`), cache de 12h | coleta ao vivo via `_safeScaleTypes` (`:2323`; o fim real do turno, que sem ele volta a ser inferido como início + 9h); `runSyncEscalaCatalogo` (`cronService.js:495`, cauda do snapshot) → `escalas_catalogo` |
| `GET /api/search/SearchNotesByNumber?noteNumber={N}` | `searchNoteByNumber` (`:945`) | `GET /api/wpa/nota/:noteId` (`routes/index.js:1582`), quando chega o número humano da nota e o banco não resolveu; `scripts/diag-nota-posse.js` |

### 9.0.2 Ainda sem uso

Os que existem e seguem sem chamador estão em §6.2.1 (endpoints da nota) e §9.1
(captura do portal de 20/10/2026): `Notes/archived`, `Sessions/all/online`,
`Notes/interruptedFilter`, `Notes/v2/operation/{setor}`,
`sessions/{id}/walletlocklog`, `sessions/{id}/logsworker`,
`callback-information` e os que vieram vazios na nota testada.

E campos que chegam nos payloads que **já baixamos** e jogamos fora (levantamento
de 20/08/2026, não reconferido em 20/10):
`ConclusionStatus` e `DesiredConclusionDate` nas listas baratas de nota (KPI de
pontualidade a custo zero de rede), `Checkpoints[].Try`, `Team.Description`,
`Team.LastUpdateWallet`, `LastLocationComunication`, `Assigned[]`.

### 9.1 Captura do portal em 20/10/2026 (P0-11): não há atalho por setor

Objetivo: achar no portal uma chamada **por setor** que trouxesse executadas e
rejeitadas do dia, para substituir os `notes/{rejected,executed}/{id}/session`
que fazemos sessão a sessão (o grosso do nosso volume, P0-11). Roteiro em
[ROTEIRO-captura-portal-wpa-2026-10-20.md](ROTEIRO-captura-portal-wpa-2026-10-20.md).
Capturado por DevTools (HAR), DESG, 07h37–07h47 BRT, conta `es`.

**Resultado: nenhuma tela do portal traz executadas/rejeitadas ligadas à
sessão.** Quando precisa disso, o portal chama os mesmos endpoints por sessão
que nós. O único endpoint por setor e por data é o `Notes/archived` (última
linha da tabela). Ele traz concluídas por **data de arquivamento**, sem
sessão: serve para auditoria, não para coleta (veredito abaixo da tabela).

| Tela | Chamadas | O que importa |
|---|---|---|
| Gestão Online | `GET /api/Teams?sectorId=X&status=1&filterByExhibitionSector=true` (1×) e `GET /api/teamsstatus/V2?sectorId=X` **a cada 60 s exatos** | Só colunas Atribuídas/Em Campo/Concluídas, de `Assigned`/`Downloaded`/`Concluded`. `Rejected` = `null` e `Executed` = `[]`, como desde 30/05. **O portal chama o V2 SEM `filterByExhibitionSector`** (P2-16). O V2 do portal veio só com equipes Engelmig: aparentemente a EDP já recorta pela empresa da conta. |
| Sessões | `GET /api/Sessions/all/online?sectorId=X` | Lista das sessões abertas (Team, Vehicle, Device, `BeginTime` + `BeginTime2` com offset). **Sem contagem de notas.** |
| Sessões → clique | `Sessions/{id}`, `notes/{rejected,executed,surveyed,downloaded}/{id}/session`, `collaborators/{id}/session`, `sessions/{id}/break`, `sessions/{id}/walletlocklog`, `sessions/{id}/logsworker?date_s=AAAA-MM-DD` | **O mesmo padrão por sessão que nós.** |
| Notas Interrompidas | `POST /api/Notes/interruptedFilter`, form `sectorId=X`, headers `Wpa-Data-Context: default` + `X-Requested-With` | É a **fila atual** de notas interrompidas (`Status 0`, voltaram ao pool), não o histórico do dia: sem filtro de data, sem `SessionId`, sem `TeamId`. Nota redistribuída sai da lista. Não substitui `notes/rejected`. ⚠️ `InterruptedDate` veio 3h à frente do `completeInterruptions.Date` da mesma nota (família do P1-48). |
| Notas Interrompidas → abrir nota | 34 chamadas (detalhes, histórico, materiais, formulários…) | Abrir uma nota no portal custa mais que coletar uma sessão inteira. |
| Operação → Buscar | `POST /api/Notes/v2/operation/{setor}`, form com `startDate`, `endDate`, `scheduledDate`, `noteTypeList[]`, `viewTypeList[]` (2–5), `pageNumber`, `pageLength=50`, `userId`, `export=false` | Grade geral do setor, **todas as empresas**, paginada (4043 notas sem filtro de data; 50 por página, 240 kB). Sem `SessionId`. Não tem como atribuir execução/rejeição a sessão, que é o que a regra rejeitada × concluída exige. Não testamos `viewTypeList` nem filtro de data: varrer isso custaria requisição e o problema da sessão continuaria. A cada troca de filtro a tela recarrega ~9 listas de apoio. |
| Notas Arquivadas → Buscar | `POST /api/Notes/archived`, form `startDate=AAAA-MM-DD&endDate=AAAA-MM-DD&sectorId=X&pageNumber=0&pageLength=0&executed=true&rejected=true` | **O único candidato por setor e por data.** Devolve `Data.{RejectedReasons[], RejectedNotesByTeam[], ExecutedNotesByTeam[], Notes[]}`, agrupado por `Key` (nome da equipe) com `DebtsTotal` e `Values[]` (as notas). Às 07h50 de 20/10 vieram 5 notas, todas `Status 6` + `ExecutionStatus 5`, com `ConclusionDate` do dia, **`Team` = `null`**, sem `Sessions`. Por isso caíram na chave `Auto`. Os motivos (`Baixa via Sistema`, `Poste/pontalete resist.mec inadequada`…) indicam rejeição. Uma chamada por setor e dia: 6,9 kB. **Não sabemos ainda** se a nota executada por equipe vem com `Team` preenchido, se a data é de conclusão ou de arquivamento, e se o setor traz só Engelmig. Ver a próxima captura abaixo. |

**Dia fechado (19/10, DESG, só `executed=true`, capturado 20/10 07h50):**

- **170 notas em 35 equipes**, com o nome da equipe na `Key` e em `Team.Name`
  (EBGPR63, ECGPR90, ETMRT16, EPMRT31, PPMFL01…). Todas são nomes que já
  aparecem no nosso repo, o que indica que o recorte é por empresa da conta,
  como no V2. `TeamId`, `Sessions` e `SessionId` vêm nulos.
- **Todas com `Status 6` + `ExecutionStatus 4`**: são **concluídas**, o mesmo
  que já vem de graça no `V2.Concluded`. Não é a categoria "executadas" do
  painel (`notes/executed` + `Downloaded` com 3/6/7, seção 10).
- **O filtro de data é o de ARQUIVAMENTO, não o de conclusão:** 159 das 170
  têm `ConclusionDate` em 19/10, e 11 foram concluídas entre 28/09 e 15/10 e
  arquivadas em 19/10. E as notas concluídas em 19/10 mas arquivadas depois
  não aparecem. Para conferir produção, filtre por `ConclusionDate`, e saiba
  que a última semana fica incompleta até tudo ser arquivado.
- **Pesado:** 1,8 MB para um setor e um dia, porque cada nota vem com o
  objeto inteiro.

**Veredito sobre o `Notes/archived`:** não substitui nada da coleta ao vivo.
Não tem sessão, as executadas dele são as concluídas, e as rejeitadas do dia
vieram sem equipe (`Auto`). Serve como **segunda fonte para auditoria de
concluídas por equipe** num dia já arquivado, 1 chamada por setor. É uma
conferência independente do V2 para quando a EDP questionar um número
(ao lado do `scripts/audit-indicadores.js`). Não implementado.

**Para a resposta à EDP (P0-11 item 3):** usamos os mesmos endpoints que o
próprio portal usa para sessão e nota. O que pesava era a **frequência**
(cron de 15 min + painel por aba), não o endpoint escolhido.

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

**Cache do painel (19/10/2026, P0-11):** a coleta de cada setor fica guardada
5 min (`WPA_PAINEL_CACHE_MS`). Só o `/api/teams` lê o guardado; o snapshot do
cron sempre coleta fresco e grava. O Monitor não atualiza com a aba escondida.

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

**8. A EDP filtra o User-Agent do node-fetch — e responde com SUCESSO vazio.**
Desde 16/10/2026 (~21:30 BRT), requisição com
`node-fetch/1.0 (+https://github.com/bitinn/node-fetch)` recebe **HTTP 200** com
`{"Message":"Nenhum dado encontrado."}`, em todo setor e toda data, inclusive
dias passados que tinham dados. Com qualquer outro UA, mesmo token, mesma VM:
dados normais. Sem 403 e sem 500, nada de token/cold-start dispara e o painel
fica zerado **sem um erro no log** — foi o que aconteceu de 16 a 18/10 (P0-10).
**Solução:** todo HTTP para a EDP sai por `services/wpaHttp.js`, com
`User-Agent` próprio (`WPA_USER_AGENT`; default `EngelmigWpaMonitor/1.0` até
28/10/2026, desde então o UA do Edge 156 no Windows). Não importe `node-fetch`
direto em código que fala com a EDP (`test/wpaUserAgent.test.js` falha). Para
reproduzir: `curl -A 'node-fetch/1.0 (+https://github.com/bitinn/node-fetch)'`
→ "Nenhum dado encontrado"; `curl` com o UA padrão dele → dados. E zero sessões
em todos os setores, em expediente, agora é `snapshot_vazio_suspeito` (erro),
não mais `snapshot_skipped_empty`.

---

## Como explorar a API sem quebrar nada

Para descobrir endpoint novo pelo portal (DevTools ou Interceptor do Postman),
siga [ROTEIRO-captura-portal-wpa-2026-10-20.md](ROTEIRO-captura-portal-wpa-2026-10-20.md):
quais telas abrir, o que anotar e como validar um candidato sem gastar
requisição.

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
