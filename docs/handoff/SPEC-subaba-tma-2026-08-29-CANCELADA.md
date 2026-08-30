# SPEC — Sub-aba TMA (Tempo Médio de Atendimento)

> # ⛔ CANCELADA em 29/08/2026 — NÃO IMPLEMENTAR
>
> **Nunca saiu do papel.** Foi desenhada e aprovada no mesmo dia, e cancelada
> horas depois pelo José, antes de qualquer linha de implementação.
>
> **Motivo:** mudança de prioridade do negócio. O indicador que a operação
> precisa não é o TMA regulatório (`emissao → conclusao`, todas as notas), e sim
> uma medição específica das notas **PO**: o intervalo entre o **"Horário do
> Reparo"** e o checkpoint **"Finalizando Trabalho"**, que pelo critério da
> operação tem de ser de **no mínimo 10 minutos**. Abaixo disso, indica problema
> no método de preenchimento e apontamento da equipe — e esses minutos entram no
> **CHI** do CSD que as equipes atendem.
>
> São indicadores diferentes: o TMA olha o ciclo inteiro da nota do ponto de
> vista do cliente; o novo olha a coerência do apontamento dentro da execução.
> Nenhuma decisão daqui se aproveita direto — nem o recorte, nem o agrupamento,
> nem os KPIs.
>
> **O que continua valendo desta spec** (não repetir o levantamento):
> - **§3 — a medição dos dados.** Cobertura de `emissao`/`conclusao` é 99,995%
>   (78.649 de 78.653), e `sector_id` é **confiável** (DSSJ 31.021, DESC 23.795,
>   DESG 23.735, DEPT 102) — o `sectorId: 'DESG'` literal do cron **não**
>   contaminou a coluna, então regional sai de `note_details` sem join.
> - **§4.1 — a armadilha do fuso.** ~8 mil notas anteriores a 08/06/2026 têm a
>   conclusão **3h adiantada dentro do jsonb**; o conserto só existe na leitura
>   em JS (`fixCachedPayloadTz`). Vale para QUALQUER consulta SQL nova sobre
>   datas de nota, inclusive a do indicador novo.
> - **§5.1 — a regra executada × rejeitada.** `_contaComoExecutada` tem de ser
>   reusada, nunca reimplementada: rejeição *antes* da conclusão é nota
>   reprogramada e refeita, e conta como executada.
> - **§10 —** `snapshots[].conclusionDate` usa `ConclusionDate2 || ConclusionDate`,
>   o campo que o `notaProcessor` proíbe. As duas fontes podem divergir em 3h.
>
> **O que NÃO foi desperdiçado:** a retenção ilimitada de `note_details`
> (`8aa9928`, P2-18), levantada por causa desta spec, ficou **mais** necessária
> com a mudança — o indicador novo depende de checkpoints, que era exatamente o
> que o TTL de 90 dias apagava.
>
> **Sucessora:** levantamento em `scripts/diag-po-reparo.js` (`6a532a1`). Antes
> de desenhar, dois fatos precisam de resposta: qual código de `Event` é
> "Finalizando Trabalho" (o repo tem duas listas que discordam entre si, e
> nenhuma prevê esse evento), e se o "Horário do Reparo" sequer vem na resposta
> da EDP (não está no nosso payload hoje).

---

> Data: 2026-08-29 · Parte 2 de 2 das sub-abas da aba Deslocamentos. A parte 1
> (estrutura + a tela de hoje virando "Deslocamento Elevado") já está no ar em
> `83d5217`. Status: **cancelada — ver o bloco acima**.
>
> Depende de `8aa9928` (retenção ilimitada de `note_details`, P2-18) — sem ela
> a matéria-prima do TMA some aos 90 dias.

## 1. Objetivo

Segunda sub-aba da aba Deslocamentos: **TMA = tempo entre a emissão da nota
(`IssueDate`) e a conclusão dela (`ConclusionDate`)**, que é a definição ANEEL
usada pela EDP.

Hoje o painel mede produção (quantas OS) e deslocamento (quanto tempo indo). Não
mede **quanto o cliente esperou**. É o indicador que falta.

## 2. Decisões (fechadas no levantamento de 28–29/08/2026)

| # | Decisão | Escolha |
|---|---|---|
| D1 | Qual TMA | **`emissao → conclusao`** (ANEEL), não tempo em obra |
| D2 | Conteúdo da tela | KPIs + tendência diária + **ranking por TIPO** |
| D3 | Recorte do período | notas **concluídas** no intervalo |
| D4 | Rejeitadas | calculadas **separadas**, com corte na tela |
| D5 | Relógio | **horas corridas** |
| D6 | Fonte da regional | `note_details.sector_id` + `REGIONAL_MAP` |
| D7 | Datas | **colunas indexadas**, não leitura de jsonb |

**Por que D2 ranqueia TIPO e não EQUIPE:** o TMA regulatório inclui o tempo em
que a nota ficou **na fila, antes de qualquer equipe pegá-la**. Ranquear equipe
por esse número as culparia por tempo que não é delas. Tipo de serviço, sim,
explica o TMA — há serviço que naturalmente demora mais. É o mesmo erro que já
existe na aba vizinha (ranking de desvio médio), e não vamos repetir.

**Por que D3 e não "emitidas no período":** conclusão fecha o número. Uma vez
encerrado, agosto nunca mais muda — dá pra comparar mês a mês e levar a reunião.
"Emitidas no período" deixaria de fora as notas ainda abertas, e como as
demoradas são justamente as que ficam abertas, o TMA sairia otimista e pioraria
sozinho conforme os atrasados fechassem.

**Por que D5:** subtração pura, sem premissa contestável. Horas úteis exigiriam
calendário de feriados e jornada por regional, que o sistema não tem — e
emergência de plantão roda 24h, então a jornada não é uniforme. Cada premissa
vira ponto discutível em auditoria de contrato. Ver §9.

## 3. Dados — medido na VM em 29/08/2026

**Cobertura é praticamente total** (78.653 notas):

| | |
|---|---|
| com `emissao` | 78.653 (**100%**) |
| com `conclusao` | 78.649 |
| com as duas | 78.649 (**99,995%**) |

Só 4 notas ficam de fora. Não precisa de aviso de recorte incompleto — mas o
endpoint devolve a contagem de descartadas de qualquer forma (§5.3), porque
"parece completo" não é o mesmo que "é completo".

**`sector_id` é confiável**, e isso decidiu D6:

| setor | notas | regional |
|---|---|---|
| DSSJ | 31.021 | SJC |
| DESC | 23.795 | CAC |
| DESG | 23.735 | GUA |
| DEPT | 102 | GUA |

A suspeita era que o `sectorId: 'DESG'` literal de `cronService.js:1060` e
`:1152` tivesse contaminado a coluna. Não contaminou — DESG é 30% e DSSJ é o
maior. Aqueles caminhos alimentam o classificador, não o cache. **A regional sai
direto de `note_details`, sem join com `snapshots`.**

## 4. Fase 1 — colunas indexadas (pré-requisito)

Ler `payload->'datas'->>'conclusao'` em SQL é inviável por **dois** motivos
independentes, e os dois somem com a mesma mudança:

**4.1 O fuso.** A EDP entrega `ConclusionDate2` com `-03:00` colado numa string
UTC sem converter — instante **3h adiantado** (probe de 08/06/2026). O conserto
(`fixCachedPayloadTz` / `_fixConclusaoCorrompida`) roda **na leitura, em JS**.
Payloads gravados antes de 08/06/2026 têm o valor errado **dentro do jsonb**, e
o mais antigo vivo é 28/05 — cerca de **11 dias, ~8 mil notas**. Uma consulta SQL
crua erraria 3h nelas. Num indicador medido em horas, isso é o próprio número.

**4.2 A escala.** É o mesmo buraco que custou 8s no passo 1 da aba Deslocamento
em 28/08, resolvido lá com a coluna `first_cp_at`. Com a retenção agora
ilimitada, a tabela só cresce.

**Solução — terceira aplicação do mesmo padrão:**

```sql
ALTER TABLE public.note_details ADD COLUMN IF NOT EXISTS emissao   timestamptz;
ALTER TABLE public.note_details ADD COLUMN IF NOT EXISTS conclusao timestamptz;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_note_details_conclusao
  ON public.note_details (conclusao);
```

- **Escrita:** em `setNoteDetailCache` ([db/queries.js:952](../../db/queries.js)),
  ao lado de `first_cp_at`. Recebe `payload.datas.emissao` e
  `payload.datas.conclusao`, que **já vêm corrigidos** pelo `notaProcessor` —
  nunca `ConclusionDate2`. A correção passa a acontecer uma vez, na gravação.
- **Backfill:** `scripts/migrar-tma-datas.js`, no molde de
  `migrar-first-cp-at.js`: lotes, idempotente, índice `CONCURRENTLY`, relatório
  final `TEM payload mas sem valor: N ← precisa ser 0`.
  ⚠️ **Tem de aplicar `fixCachedPayloadTz` antes de extrair** — ler o jsonb cru
  gravaria o erro de 3h dentro da coluna nova, que é justamente a confiável.

**Sem flag de leitura.** O `first_cp_at` precisou de uma porque trocava o
comportamento de uma consulta que já existia. Aqui a consulta é nova: basta não
publicar a Fase 3 antes de o backfill reportar zero pendências. Menos peça móvel.

## 5. Fase 2 — endpoint

`GET /api/tma?de=&ate=&regionals=&tipo=`

Recorte: `conclusao >= de AND conclusao < ate+1dia`. Regional via
`REGIONAL_MAP[sector_id]`, respeitando `req.scope.regionals` como as outras
rotas. Cache de 5 min + single-flight (`memoCache`), como os deslocamentos.

### 5.1 A separação executada × rejeitada (D4)

**Reusar `_contaComoExecutada`** ([services/dataWriter.js:292](../../services/dataWriter.js)),
não reimplementar. A regra (José, 31/07/2026) **não é um join simples** com
`note_rejections`:

- rejeição no **mesmo dia** da conclusão → a visita terminou em rejeição → não conta
- rejeição **depois** da conclusão → a EDP recusou → não conta
- rejeição **antes** da conclusão → nota reprogramada e refeita → **conta**

Comparação por **dia**, não por minuto. Se a TMA reimplementasse isso, as duas
telas divergiriam no primeiro caso de borda — e a divergência apareceria como
"o painel está errado", não como "as definições são diferentes".

Fonte dos dias de rejeição: tabela `note_rejections` (persistente, `note_id` +
`session_date`).

### 5.2 Agregações

Todas calculadas **duas vezes**, uma para cada bucket (executadas / rejeitadas):

- **KPIs:** média, **mediana**, **p90**, contagem de notas.
- **Tendência diária:** TMA médio por dia de conclusão, com continuidade de
  calendário (dia sem nota vira zero), igual à tendência dos deslocamentos.
- **Ranking por tipo:** TMA médio por `note_details.tipo`, desc, com a contagem
  ao lado.

**Por que mediana e p90 junto da média:** a média sozinha é frágil aqui. Uma nota
emitida há um ano e concluída ontem entra com ~8.760h e desloca o número inteiro.
A mediana mostra o caso típico; o p90 mostra a cauda sem depender de um único
outlier — que é por isso que **não** usamos o máximo. É a lição direta do ranking
de 98.628% da aba vizinha: um número certo, agregado de um jeito que engana.

### 5.3 Contrato de resposta

```
{ executadas: { total, media_h, mediana_h, p90_h, porDia[], porTipo[] },
  rejeitadas: { ...mesma forma... },
  descartadas: <int>,     // sem emissao ou sem conclusao
  periodo: { de, ate } }
```

`descartadas` existe para a tela poder dizer a verdade se um dia a cobertura
piorar. Truncar/descartar em silêncio é o modo de falha que este painel já teve
duas vezes (P1-41 e o teto de 20.000 da aba Deslocamento).

## 6. Fase 3 — tela

Dentro de `#desloc-sub-tma`, que já existe dizendo "Em construção"
([public/index.html](../../public/index.html)). Reusa as classes visuais da
sub-aba vizinha (`.desloc-kpis`, `.desloc-panel`, `.desloc-bar-row`), para as
duas sub-abas se lerem igual.

- Barra de filtros própria: **De**, **Até**, **Regional**. Sem "Equipe" e sem
  "Acima" — nenhum dos dois faz sentido para TMA (ver D2).
- Corte executada × rejeitada: um seletor de 2 opções ao lado do filtro,
  default **Executadas**.
- 4 cartões: TMA médio, mediana, p90, notas no período.
- Tendência diária (mesmo SVG da vizinha, uma série só).
- Ranking por tipo (mesmas barras horizontais).
- **Legenda fixa** sob os cartões: *"TMA = da emissão da nota até a conclusão,
  em horas corridas. Inclui o tempo em fila antes de a equipe receber a nota."*
  Sem isso, alguém vai comparar TMA com tempo de deslocamento e achar que um
  contradiz o outro.

`loadTma()` entra em `FAB_RECARREGAR`? **Não** — a chave `desloc` já existe e o
balão despacha por `currentTab`, que não muda entre sub-abas. `fabRecarregar()`
passa a olhar `_deslocSubAtiva` e chamar `loadTma()` quando a sub-aba TMA estiver
ativa. Uma linha, e o Atualizar continua funcionando nas duas.

## 7. Testes (`node --test`)

Baseline em 29/08/2026: **681 testes / 45 suites / 0 falhas**.

Funções puras, testáveis sem banco:

1. **TMA de uma nota:** emissão e conclusão conhecidas → horas corridas exatas,
   inclusive atravessando fim de semana e virada de mês.
2. **Fuso:** payload com `-03:00` corrompido → o valor extraído bate com o UTC
   correto, **não** com o adiantado em 3h. É o teste que protege as ~8 mil notas
   antigas.
3. **Bucket:** rejeição antes da conclusão → **executada**; no mesmo dia →
   rejeitada; depois → rejeitada. Espelha os casos de `_contaComoExecutada`.
4. **Reuso, não cópia:** o módulo do TMA importa `_contaComoExecutada` do
   `dataWriter` — teste falha se alguém reimplementar a regra localmente.
5. **Mediana e p90:** conjunto conhecido, incluindo n par, n=1 e um outlier
   gigante que a média sente e a mediana não.
6. **Continuidade do calendário:** dia sem nota vira zero, não some da série.
7. **`descartadas`:** nota sem emissão não entra em nenhum bucket e é contada.

**Limite explícito:** nada disso prova que a tela renderiza. A conferência visual
das duas sub-abas é manual, no navegador.

## 8. Ordem de entrega

1. Fase 1 (colunas + backfill) → deploy → backfill reporta **0 pendentes**.
2. Fases 2 e 3 → deploy.

Dois deploys de propósito: a Fase 1 sozinha não muda nada que o usuário vê, então
se algo der errado o raio de dano é zero.

## 9. Não-objetivos (YAGNI)

- **Horas úteis.** Registrado como decisão (D5), não como esquecimento. Se a
  gestão pedir, vira item novo — e vai precisar de calendário de feriados e
  definição de jornada, que não existem hoje.
- **Ranking por equipe no TMA.** Ver D2.
- **TMP** (tempo médio de pendência / backlog) — indicador vizinho, outro ciclo.
- **ICC** (% dentro do prazo desejado). A `payload.datas.desejada` existe e
  habilita isso de graça depois, mas não entra agora.
- **Consertar o ranking de desvio médio** da sub-aba vizinha (os 98.628%).
  Continua pendente e continua merecendo item próprio.
- Mexer no cálculo de qualquer número existente.

## 10. Riscos

- **Toca o write path** (`setNoteDetailCache`), que o cron usa a cada ciclo. Se
  a extração das datas lançar, não pode derrubar o upsert do payload:
  `try/catch` com log. O payload é a fonte de verdade; as colunas são derivadas
  e re-backfilláveis.
- **Número novo visível à gestão.** TMA vai ser comparado com o que a EDP mede.
  Divergência é esperada na borda (recorte de período, tratamento de rejeitada) —
  a legenda da §6 e o corte da §5.1 existem para que a conversa seja sobre
  definição, não sobre bug.
- **`ConclusionDate2` × `ConclusionDate`.** `snapshots[].conclusionDate` usa
  `ConclusionDate2 || ConclusionDate` ([wpaService.js](../../services/wpaService.js)),
  ou seja, **prefere** o campo que o `notaProcessor` proíbe. Esta spec lê só de
  `note_details`, então não mistura — mas quem for cruzar as duas fontes um dia
  precisa saber que elas podem divergir em 3h.

## 11. Rollback

- Fase 1: `DROP` das duas colunas e do índice; revert do commit. Nada existente
  muda de comportamento (as colunas são só escritas, ninguém lê ainda).
- Fases 2 e 3: revert. A sub-aba volta a dizer "Em construção"; a rota some.
- Sem dado reescrito em nenhuma das duas.
