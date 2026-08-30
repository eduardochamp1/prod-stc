# SPEC — Sub-aba "TMA (PO)": reparo apontado × fim do trabalho

> Data: 2026-08-30 · Status: **Fase 1 no ar** (`85fab65`); Fases 2 e 3 pendentes.
>
> Segunda sub-aba da aba Deslocamentos. A primeira ("Deslocamento Elevado") está
> no ar em `83d5217`; o lugar desta já existe, dizendo "Em construção".
>
> ⚠️ **"TMA (PO)" NÃO é o TMA regulatório.** O TMA da ANEEL é
> `IssueDate → ConclusionDate` (knowledge base §75.3) e teve a spec **cancelada**
> em 29/08 (`SPEC-subaba-tma-2026-08-29-CANCELADA.md`). Esta aba mede outra
> coisa: a distância entre o **reparo apontado** e o **fim do trabalho** numa nota
> PO. Nome escolhido pelo José; a ambiguidade fica registrada aqui e numa legenda
> fixa na tela, pra ninguém somar os dois daqui a seis meses.

## 1. Objetivo

Nas notas **PO**, medir o intervalo entre o **"Horário do Reparo"** e o
checkpoint **"Finalizando Trabalho"**. Pelo critério da operação a diferença tem
de ser de **no mínimo 10 minutos**; abaixo disso indica problema no método de
preenchimento e apontamento da equipe — e esses minutos entram no **CHI** do CSD
que as equipes atendem.

## 2. O que a medição mostrou — base completa

**Base completa.** O backfill de 30/08/2026 mediu as **8.402 notas PO** em cache
(94min, **zero erros**). Não é amostra — é o universo:

```
Total 8.405 · MEDIDAS 6.034 (71,8% de cobertura)
  sem RepairTime  2.367 (28,2%)    HasRepair=false  137
  sem evento 4  4 em 8.402         erros  0

mínimo -293,1   p10 0,0   mediana 6,0   p90 15,8   máximo 293,5

                         notas    % das medidas
negativo (reparo DEPOIS)   422        7,0%
0 a 2 min                1.733       28,7%
2 a 5 min                  655       10,9%
5 a 10 min               1.207       20,0%
10 a 30 min              1.883       31,2%
30 a 60 min                 95        1,6%
60 min ou mais              39        0,6%

ABAIXO de 10 min: 4.017 de 6.034 — 66,6%
```

**Isso define o desenho.** A mediana é 6,0 — a distribuição está centrada bem
abaixo do critério. Não é "a maioria cumpre e alguns violam": é a operação
inteira apontando em torno de 6 minutos. Uma lista de exceções listaria **dois
terços** da base e não serviria pra nada — por isso a tela é **distribuição +
tendência**, não semáforo.

**O p10 é 0,0 e a faixa 0–2 min sozinha é 28,7%** — quase um terço das notas
medidas tem o reparo apontado praticamente junto com o fim do trabalho. É o
sintoma mais forte de preenchimento sem critério, e é o grupo qualitativamente
distinto dentro do "abaixo de 10".

Os **422 negativos** são a evidência indefensável: reparo apontado *depois* de
encerrar o trabalho é fisicamente impossível. O pior chega a **−293 minutos**,
quase cinco horas.

**A cobertura de 71,8% é ela mesma um achado.** 2.367 notas PO sem `RepairTime`
preenchido — se o campo alimenta o CHI, faltar é tão grave quanto estar errado.
Fica fora do indicador (D5) mas fixa na tela (§7.1).

### 2.1 O apontamento vem melhorando — três amostras encaixadas dizem o mesmo

| recorte | mediana | abaixo de 10 min | cobertura |
|---|---|---|---|
| 200 mais recentes | 9,0 | 58,2% | 79,0% |
| 1.000 mais recentes | 7,1 | 61,0% | 74,4% |
| **base completa (8.402)** | **6,0** | **66,6%** | **71,8%** |

Três recortes encaixados, e os três indicadores caminham **monotonicamente** na
mesma direção: quanto mais para trás no tempo, pior o apontamento *e* pior o
preenchimento do campo.

Não é prova — são amostras sobrepostas, não série temporal, e o efeito pode vir
de outra coisa que mudou junto. Mas é forte o bastante para uma expectativa
concreta: **o gráfico de tendência da §7.2 deve mostrar uma curva subindo**. Se
mostrar uma reta, é sinal de que a leitura aqui está errada e vale investigar
antes de apresentar o indicador a alguém.

## 3. As duas fontes

Descobertas em 30/08/2026 depois de sondar 21 endpoints — ver
`docs/handoff/API-WPA-EDP.md` §6.2.2.

```
Horário do Reparo    → GET /api/notes/po?noteId={uuid}
                       Execution.PowerOnExecution.RepairTime      (UTC, "+00:00")
Finalizando Trabalho → GET /api/Notes/{uuid}/details/optimized
                       Checkpoints[] com Event === 4, RegisteredAt2  (local, "-03:00")
```

**O evento 4 é "Finalizando Trabalho"** — a doc antiga dizia "Interrupção/pausa";
corrigido em `1138da7`.

### ⚠️ 3.1 O fuso é a armadilha central desta spec

Medido com os valores reais da nota 104875481:

```
TZ=America/Sao_Paulo   RegisteredAt2 → +7,03 min    RegisteredAt → +7,03 min
TZ=UTC   (a VM)        RegisteredAt2 → +7,03 min    RegisteredAt → −172,97 min
```

`RepairTime` vem em UTC; `RegisteredAt` vem **sem marcador de fuso nenhum**. Usar
o campo cru **funciona na máquina do dev e quebra em produção**, com 3h de erro
que ainda **inverte o sinal** — viraria "reparo 3h depois do fim do trabalho",
absurdo plausível o bastante pra passar por anomalia de campo em vez de bug.

**Regra da spec:** só `RegisteredAt2` é aceito. Nota sem ele **não é medida**,
nunca estimada.

## 4. Decisões

| # | Decisão | Escolha |
|---|---|---|
| D1 | Escopo | só notas **PO** (`note_details.tipo`) |
| D2 | Enquadramento | 10 min como régua + **distribuição e tendência** |
| D3 | Nome da sub-aba | **"TMA (PO)"** — ver aviso do topo |
| D4 | Equipe | **filtro + ranking**, com piso de N (§7.3) |
| D5 | Notas sem `RepairTime` | **só na linha de cobertura**, fora do indicador |
| D6 | Campo do checkpoint | **`RegisteredAt2`**, jamais `RegisteredAt` |
| D7 | Qual evento 4, se houver vários | o **último** (fecha a execução que concluiu) |
| D8 | Eixo do tempo | **`finalizando_em`** — ver §5.2 |

## 5. Fase 1 — ingestão

### 5.1 `wpaService`

```js
// GET /api/notes/po?noteId={uuid} — execução das notas PO.
async function getNotePoExecution(noteId) { ... }
```

Devolve `Execution.PowerOnExecution` normalizado. Só PO: chamar para outro tipo
gasta request à toa.

### 5.2 Tabela `note_po_reparo`

```sql
CREATE TABLE public.note_po_reparo (
  note_id           uuid PRIMARY KEY,
  numero            text,
  sector_id         text,          -- regional sai daqui via REGIONAL_MAP
  team_id           uuid,          -- Execution.ExecutedById
  repair_time       timestamptz,
  has_repair        boolean,
  finalizando_em    timestamptz,   -- checkpoint Event=4, RegisteredAt2
  delta_seg         integer,       -- finalizando_em − repair_time
  prediction_repair timestamptz,
  confirmation_date timestamptz,
  classe            text,          -- CCC
  causa             text,
  clima             text,
  atualizado_em     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_note_po_reparo_finalizando ON public.note_po_reparo (finalizando_em);
```

`delta_seg` fica **gravado**, não calculado na leitura: é o número que a gestão vê,
e o cálculo depende da regra de fuso da §3.1. Gravar garante que uma consulta
futura não refaça a conta errado.

**Por que o eixo é `finalizando_em` e não a conclusão da nota (D8):** é o evento
que está sendo medido, e faltou em apenas **4 de 8.402** notas. A `conclusao`
seria consistente com o resto do painel, mas some quando a nota não fecha — e aí
o caso justamente mais suspeito sairia do gráfico.

`classe`/`causa`/`clima` e `prediction_repair` vêm de graça na mesma resposta.
Não entram na tela agora (§9), mas jogar fora exigiria re-buscar 8.402 notas
depois.

### 5.3 `notaProcessor` — guardar `RegisteredAt2`

O mapeamento de checkpoint ganha `registradoEm: cp.RegisteredAt2`. **Aditivo:**
`_cpTs` não muda, então deslocamento e o resto do painel seguem idênticos.

### 5.4 Cron e backfill

- Nota PO nova → busca e grava. ~91/dia, custo baixo.
- `scripts/migrar-po-reparo.js` para as 8.402 já cacheadas: lotes, idempotente,
  com throttle, e relatório final no molde do `migrar-first-cp-at.js`.
- **2 requests por nota** no backfill (`/notes/po` + `details/optimized`), porque
  `RegisteredAt2` não está no cache. ~4,7 h a 1 nota/s. Rodar em background.
- ⚠️ Se a extração lançar, **não pode derrubar** o upsert do payload: `try/catch`
  com log, como em qualquer derivada.

## 6. Fase 2 — endpoint

`GET /api/po-reparo?de=&ate=&regionals=&team=`

Recorte por `finalizando_em`. Regional via `REGIONAL_MAP[sector_id]`, respeitando
`req.scope.regionals`. Cache 5 min + single-flight, como os deslocamentos.

```
{ cobertura:   { total, medidas, sem_repair_time, has_repair_false },
  resumo:      { mediana_min, p10, p90, abaixo_10_pct, negativos },
  faixas:      [ { rotulo, de, ate, quantidade } ],
  porDia:      [ { data, mediana_min, abaixo_10_pct, total } ],
  porEquipe:   [ { team_id, sigla, total, mediana_min, abaixo_10_pct } ],
  casos:       [ { numero, delta_min, finalizando_em, equipe, regional } ] }
```

## 7. Fase 3 — tela

Dentro de `#desloc-sub-tma`, que hoje diz "Em construção". Reusa as classes da
sub-aba vizinha.

### 7.1 Cartões

**Mediana (min)** · **% abaixo de 10 min** · **Negativos** · **Cobertura**.

A cobertura vai **fixa nos cartões**, não escondida: com **28,2%** sem `RepairTime`,
mostrar "67% abaixo" sem dizer que fala de 72% da base seria apresentar um recorte
como se fosse o total — o mesmo erro que o painel já cometeu duas vezes.

### 7.2 Histograma e tendência

Faixas da §2, com a divisa dos 10 min marcada. Tendência diária da **mediana** e
do **% abaixo** — é o gráfico que responde *"a cobrança adiantou?"*, e é o coração
do enquadramento escolhido (D2).

### 7.3 Ranking por equipe — com piso

⚠️ Equipe com 3 notas no período vira 100% de violação e lidera o ranking sem
significar nada. **Piso de 10 notas medidas** para aparecer, e a contagem sempre
visível ao lado do percentual. Quem ficar abaixo do piso vai para um rodapé
"equipes com poucas notas no período", não some.

Ordenar por **% abaixo de 10 min**, não por mediana: é a régua do D2.

### 7.4 Legenda fixa

> *"Mede a distância entre o Horário do Reparo apontado pela equipe e o
> checkpoint Finalizando Trabalho. Não é o TMA regulatório (emissão → conclusão).
> Notas sem Horário do Reparo preenchido não entram no cálculo — ver Cobertura."*

Sem isso alguém vai comparar com o TMA da EDP e achar que um contradiz o outro.

## 8. Testes (`node --test`)

Baseline em 30/08/2026: **681 testes / 45 suites / 0 falhas**.

1. **Fuso — o teste que importa.** Com os valores reais da nota 104875481, e com
   `TZ=UTC` forçado: `RegisteredAt2` dá +7,03 min. Um teste que **falha** se
   alguém trocar para `RegisteredAt` (daria −172,97).
2. Vários `Event=4` → vence o último (D7).
3. Checkpoint sem `RegisteredAt2` → nota **não medida**, contada em cobertura.
4. `HasRepair=false` e `RepairTime` nulo → fora do indicador, dentro da cobertura.
5. `delta_seg` negativo é preservado, não zerado nem descartado.
6. Faixas: fronteiras exatas em 0, 2, 5, 10, 30, 60 — sem buraco nem sobreposição.
7. Ranking: equipe abaixo do piso não aparece na lista principal.
8. Continuidade do calendário na série diária: dia sem nota vira zero.

**Limite explícito:** nada disso prova que a tela renderiza. Conferência visual é
manual.

## 9. Não-objetivos (YAGNI)

- **Não** calcular CHI. A tela mede apontamento, não o indicador regulatório.
- **Não** usar `classe`/`causa`/`clima` na tela agora — só gravar.
- **Não** medir outros tipos de nota. Só PO (D1).
- **Não** consertar o `_cpTs` (que usa `TimeStamp` e zera deslocamentos). É bug
  real e sério, mas de outra aba — item de backlog próprio.
- **Não** criar alerta/notificação sobre violação.

## 10. Riscos

- **Volume de requests no backfill:** 16.804 chamadas para as 8.402 notas. Com
  throttle e em background, sem risco de bloqueio (a conta trava por falha de
  **login**, não por volume de leitura) — mas roda uma vez só, com acompanhamento.
- **Toca o write path do cron.** Mitigado pelo `try/catch` da §5.4.
- **Número novo e desconfortável.** 67% abaixo do critério vai gerar discussão.
  A cobertura fixa (§7.1) e a legenda (§7.4) existem pra que a conversa seja
  sobre a operação, não sobre a credibilidade do painel.
- **Os números da §2 são da base completa**, não de amostra — mas descrevem o
  passado. A §2.1 sugere melhora no tempo, então o recorte que a tela exibir
  (últimos 30 dias, por exemplo) tende a ser melhor que o histórico.

## 11. Rollback

- Fase 1: `DROP TABLE note_po_reparo` + revert. `note_details` intocado; o campo
  novo no checkpoint é aditivo e ninguém mais o lê.
- Fases 2 e 3: revert. A sub-aba volta a "Em construção"; a rota some.
- Sem dado existente reescrito em nenhuma fase.
