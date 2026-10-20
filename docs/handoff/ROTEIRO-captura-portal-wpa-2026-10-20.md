# Roteiro — capturar o portal WPA para achar um jeito mais barato de coletar

> **Contexto:** P0-11. A EDP reclamou de volume de requisições (19/10/2026).
> A maior parte do nosso custo é **por sessão**: a cada ciclo de 15 min,
> cada sessão Engelmig faz `notes/rejected/{id}/session` e
> `notes/executed/{id}/session` (API-WPA-EDP.md, seções 6.1 e 10). São
> ~2 × 80–100 sessões × ~79 ciclos/dia. Os endpoints por setor
> (`Sessions/all/date`, `teamsstatus/V2`) custam pouco perto disso.
>
> **Pergunta deste roteiro:** como o **portal** mostra executadas e
> rejeitadas de um setor inteiro? Se ele faz isso em 1–2 chamadas por setor,
> e não em uma por sessão, trocar a nossa coleta por essa chamada corta a
> maior parte do volume.
>
> **Pista forte:** até 30/05/2026 o `teamsstatus/V2` trazia `Rejected[]` e
> `Executed[]`. Naquele dia a EDP esvaziou os dois e o dado passou para os
> endpoints por sessão (`wpaService.js`, nota da breaking change). Se a tela
> Gestão Online do portal continua mostrando rejeitadas e executadas, ela
> passou a buscar isso em **algum lugar** depois de 30/05. Esse lugar é o
> principal alvo.
>
> Escrito em 20/10/2026. **Executado no mesmo dia (seções 1.1 a 1.5, DESG):
> não existe atalho por setor ligado à sessão. O portal busca as notas sessão
> a sessão, como nós.** O único endpoint por setor e por data é o
> `Notes/archived` (tela Notas Arquivadas): concluídas por data de
> arquivamento, sem sessão. Serve para auditoria, não para coleta. Resultado em `API-WPA-EDP.md` seção 9.1. A seção 1.6 (WebSocket) não
> foi olhada: nenhuma tela mostrou executadas/rejeitadas atualizando sozinhas,
> e a Gestão Online atualiza por consulta ao V2 a cada 60 s.

---

## 0. Antes de começar

**Gravação:** qualquer uma das duas serve.

- **DevTools (mais simples, nada sai da máquina):** F12 → aba **Network** →
  marcar **Preserve log** → filtro **Fetch/XHR**. No fim, botão de download
  ("Export HAR").
- **Postman Interceptor** (o mesmo de 30/08/2026): grava direto numa
  collection. Se usar, veja o cuidado com o token abaixo.

**Onde salvar o que capturar:** em `_local/` (gitignored). **Nunca** em
`docs/handoff/` nem em qualquer pasta versionada. O HAR leva o
`Authorization: Bearer …`, cookies, nomes de colaboradores e endereços de
clientes.

**Token no Postman:** variáveis de ambiente sincronizam com o workspace na
nuvem do Postman. Guarde o token só no **current value** (fica local), nunca
no **initial value**. Collection compartilhada, só depois de tirar o token.

**Volume:** navegar no portal é uso normal e não soma nada ao que já
consumimos. O que **soma** é reenviar requisições pelo Postman. Reenvie à mão,
poucas vezes, e **nunca** use Runner nem Monitor do Postman. Lembre que a
conta `es` é compartilhada e trava com 5 logins falhos (seção 2 do
API-WPA-EDP.md).

**Escolha de momento:** expediente, com equipes em campo e algumas já com
nota rejeitada no dia. Sem dado na tela, a chamada vem vazia e não dá para
saber o que ela traz.

---

## 1. Telas a abrir, em ordem

Para cada tela: limpar o Network (🚫), abrir a tela, esperar carregar,
**esperar mais 2–3 min parado** (para pegar atualização automática) e
anotar.

### 1.1 Gestão Online — um setor (DESG, por exemplo), dia de hoje

O alvo principal. Responder:

- Quais chamadas a tela faz ao abrir? Ainda é `teamsstatus/V2`? Existe um
  `V3`, ou outra rota parecida?
- Parado na tela, ela atualiza sozinha? De quanto em quanto tempo, e
  chamando o quê?
- Ela mostra contagem de rejeitadas/executadas por equipe **sem clicar** na
  equipe? Se mostra, de qual resposta sai esse número?
- Há chamada por equipe ou por sessão (uma URL repetida com ids diferentes)?
  Se há, o portal paga o mesmo custo que nós, e o ganho vai ter de vir de
  outro lugar.

### 1.2 Gestão Online — clicar numa equipe que já tem rejeitada

- Que chamadas saem no clique? É `notes/rejected/{id}/session` (o que usamos)
  ou outra?

### 1.3 Tela de Sessões

- Lista o dia inteiro do setor? Com quais contagens?

### 1.4 `/Notes/StatusNotes` (notas devolvidas)

Já conhecemos o `POST /api/Notes/NotesStatusFilterBySector` (seção 8).
Responder:

- Tem filtro por data ou por status no corpo? Experimente os filtros da tela
  e veja o que muda no corpo do POST.
- Dá para pedir só rejeitadas, ou só executadas, do dia, do setor inteiro?

### 1.5 Qualquer tela com exportação (Excel, CSV, relatório)

- Exportação costuma ser **uma** chamada que traz tudo de um período.
  Anote a URL e os parâmetros, mesmo que o arquivo venha em Excel.

### 1.6 Push em vez de consulta

Na Gestão Online, troque o filtro do Network para **WS** (WebSocket).

- Aparece alguma conexão? Procure `negotiate`, `/hub`, `signalr` nas URLs
  (filtro **All**).
- Se aparecer: anote a URL do hub, e na aba **Messages** dessa conexão, o
  nome das mensagens que chegam (ex.: `TeamStatusUpdated`). Se o portal
  recebe as atualizações por push, ele não precisa consultar, e esse seria o
  caminho mais barato de todos.

---

## 2. O que anotar de cada chamada interessante

Uma linha por chamada, em `_local/captura-wpa-AAAA-MM-DD.md`:

| Campo | Exemplo |
|---|---|
| Método e path | `GET /api/teamsstatus/V3` |
| Query / corpo | `sectorId=DESG&date=10/20/2026` |
| Headers fora do comum | `Wpa-Data-Context`, `X-Requested-With` |
| Escopo | setor / sessão / nota |
| Tamanho da resposta | 340 kB |
| Traz `Id` da nota? E o `Id` da sessão? | sim / sim |
| Campos de status | `ExecutionStatus`, `ConclusionStatus`, `RegisteredAt` |
| Tem parâmetro "desde"? | `lastUpdate=`, `since=`, `modifiedAfter=` |
| Quando a tela chama | ao abrir / a cada 60 s / no clique |

Guarde também **uma resposta inteira** de cada candidato (em `_local/`).

---

## 3. Como saber se um candidato serve

Um endpoint por setor só substitui os dois por sessão se trouxer **as mesmas
notas, pelo `Id`**, para executadas **e** rejeitadas. Contar linhas não vale:
as telas do portal já mostraram linhas duplicadas, então conte por UUID.

1. **Comparação sem custo de rede do nosso lado.** Os snapshots guardam o
   objeto completo da equipe (`snapshots.data`, `dataWriter.js:saveSnapshot`),
   com `notasExecutadas` e `notasRejeitadas`. Pegue a resposta capturada do
   candidato e compare os `Id` com o snapshot do **mesmo setor no ciclo mais
   próximo** do horário da captura. Diferença pequena de borda (nota que
   chegou entre a captura e o ciclo) é esperada. Nota que falta de um lado em
   vários ciclos não é.
2. **Executada em andamento.** Hoje `executadas` junta `notes/executed` com o
   `Downloaded[]` do V2 com `ExecutionStatus` 3/6/7 (seção 10, passo 4).
   Conferir de onde o candidato tira isso.
3. **Sessão encerrada.** 40,6% das sessões encerradas ganham executada ou
   rejeitada horas depois (diag v2 do P0-11). O candidato precisa trazer
   sessão **já encerrada** também, não só equipe online.
4. **Equipe visitante.** O V2 com `filterByExhibitionSector=true` perde
   equipe que está em outro setor (P2-16). Ver se o candidato tem o mesmo
   problema.

Se passar nos quatro, o próximo passo é código em **modo sombra**: o
candidato roda junto com a coleta atual por alguns dias úteis, comparando por
`Id` e registrando divergência, no mesmo molde do item 5 do P0-11. Número
reportado à EDP só muda depois de `divergiu = 0` (regra 7 do CLAUDE.md).

---

## 4. Em paralelo: perguntar à EDP

O item 3 da ação do P0-11 já prevê responder a EDP com o volume medido. Na
mesma resposta, perguntar:

> Existe endpoint por setor, ou com filtro de data de alteração, que vocês
> recomendem para não consultarmos as notas sessão a sessão?

A resposta deles vale mais que qualquer captura: vem com o aval de quem
reclamou do volume.

---

## 5. Depois da captura

- Endpoint novo vai para a **seção 9** do `API-WPA-EDP.md` (ou para a seção
  certa, se for usado), com a data da captura.
- Se o candidato passar na seção 3, abrir item no `BACKLOG.md` ligado ao
  P0-11, com a evidência (resposta guardada em `_local/`, comparação feita).
- Se nada servir, registrar isso também no P0-11 ("Gestão Online do portal
  faz uma chamada por sessão, como nós", por exemplo), para ninguém repetir a
  captura.
