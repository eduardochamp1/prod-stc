# SPEC — Reconexão vira-noite pertence ao dia do início do turno (P1-14)

> Data: 2026-07-30 · Decisão de negócio travada (José): a continuação de um
> turno após reconexão que cruza a meia-noite pertence ao **dia do início do
> turno**. Status: **a implementar (spec em revisão)**.

## 1. Problema (evidência EPGPR30, 29–30/07/2026)

Uma equipe de plantão trabalhou **uma noite só**, mas a produção ficou partida:

| Sessão | begin | end | concluídas | gravada em |
|---|---|---|---|---|
| A | 2026-07-29 20:05 | 2026-07-30 01:08 | 6 | `date=2026-07-29` |
| B | 2026-07-30 01:10 | 2026-07-30 04:00 | 3 | `date=2026-07-30` |

Gap A→B = **2 minutos** → é uma **reconexão** (relogin), não um turno novo. Mas
como o `sessionBegin` da B caiu depois da meia-noite, a atribuição por data de
início de sessão (`_sessionDate`) jogou a B (e as 3 concluídas) pro dia 30/07.
No Monitor, o modal de 30/07 mostra "início 01:10" — o rabo da noite.

## 2. Objetivo

Fazer a **continuação (reconexão) herdar o dia operacional da sessão anterior**,
mesmo cruzando a meia-noite. Resultado esperado no caso EPGPR30: a noite inteira
(20:05 → 04:00, 9 concluídas) atribuída a **29/07**; no modal, início 20:05 com
um relogin às 01:10.

## 3. Regra de linkagem (o coração)

**Data operacional efetiva de uma sessão.** Para as sessões de UMA equipe,
ordenadas por `begin` crescente (s0, s1, s2, …):

```
effDate(s0) = _sessionDate(s0)                       // dia do próprio begin
para i > 0:
  gap = s_i.begin - s_{i-1}.end                      // precisa de s_{i-1}.end
  se (s_{i-1}.end existe) E (0 <= gap <= LIMITE):
      effDate(s_i) = effDate(s_{i-1})                // reconexão → herda o dia
  senão:
      effDate(s_i) = _sessionDate(s_i)               // turno genuinamente novo
```

- Encadeia: reconexão de reconexão herda o dia original.
- `gap` negativo (sobreposição) ou `end` ausente → NÃO linka (conservador).
- **LIMITE (a confirmar):** proposto **60 min**. O caso real foi 2 min. 60 min
  cobre reconexões e pequenas quedas sem linkar turnos distintos (ex.: logoff
  05:00 → logon 20:00 = 15h, não linka). Configurável via env
  `RECONEXAO_MAX_GAP_MIN` (default 60). **NÃO** reusar `RELOGIN_MAX_GAP_HORAS`
  (esse tem default 0 = desligado, de propósito, pro `_resolveLogon`).

Função **pura** `_effectiveSessionDates(sessions, limiteMin)` → `Map<sessionKey, ymd>`.
Testável isolada, sem I/O.

## 4. Onde aplicar

### 4.1 Consolidação (produção — o que importa pra EDP)

`consolidateDay(D)` já busca snapshots de `{D-1, D, D+1}` e monta as sessões via
`_unionTeamsFromSnapshots`. Hoje a atribuição usa `_sessionDate`. Muda para:

1. No `_unionTeamsFromSnapshots` (ou num passo logo após), agrupar as sessões de
   cada equipe, calcular `effDate` de cada uma pela regra §3, e usar **effDate**
   no lugar de `_sessionDate` para (a) o filtro da janela `{D-1, D}` e (b) a
   atribuição de nota (`_notaDate` passa a receber effDate como `sessDate`).
2. Consistência entre dias (invariante): como a janela é de 3 dias e a regra é
   determinística (depende só da cadeia de sessões da equipe), `consolidateDay(29)`
   e `consolidateDay(30)` **concordam** que a sessão B pertence a 29. Logo B conta
   em 29 e é excluída de 30 — sem dupla contagem, sem buraco.
   - ⚠️ Testar explicitamente essa invariante (o caso EPGPR30 nos dois sentidos).
3. Edge: cadeia que sai da janela de 3 dias (reconexões em série por >1 dia). Raro;
   documentar e, se necessário, ampliar a janela de busca de snapshots só o
   suficiente para fechar a cadeia (medir antes de complicar).

### 4.2 Exibição (Monitor + modal)

Objetivo secundário (o número é o primário). Duas frentes:

- **Modal / histórico de conexões:** mostrar a noite como 1 turno — início 20:05,
  relogin às 01:10 (gap "desconectado por 2 min"). Isso exige que o objeto team
  do dia 29/07 conheça a sessão B. No caminho **consolidado/persistido** isso sai
  de graça (a produção já estará em 29). No **ao-vivo** (WPA do dia), a sessão B
  aparece no dia 30 e o front não tem a A — aceitar essa limitação no ao-vivo e
  resolver na visão consolidada, OU (fase 2) o backend anexar as sessões linkadas.
- **Não** duplicar a equipe entre 29 e 30 na lista.

> **Faseamento:** Fase 1 = atribuição na consolidação + re-consolidação (fecha o
> número reportável). Fase 2 = polimento da exibição ao-vivo. Entregar a Fase 1
> primeiro, validada, antes de mexer no front ao-vivo.

## 5. Re-consolidação (move número — disciplina P1-13)

- Após o código, rodar `scripts/backfill-consolidate.js <de> <ate>` em **dry-run**
  para MEDIR o quanto de produção migra entre dias, revisar com o José, e só
  então `--apply`. Guardar o "antes" (pg_dump da madrugada) pra comparar/reverter.
- Escopo inicial: os dias com times noturnos + reconexão pós-meia-noite. Um
  diagnóstico (`scripts/diag-*`) pode listar os candidatos (sessões com begin
  logo após um end de sessão anterior cruzando 00:00) antes de re-consolidar em massa.

## 6. Testes (`node --test`)

- `_effectiveSessionDates` (pura):
  - 1 sessão → effDate = próprio dia.
  - reconexão gap ≤ limite cruzando meia-noite → herda o dia da anterior (EPGPR30).
  - gap > limite → dia próprio (turno novo).
  - gap negativo / `end` ausente → não linka.
  - cadeia A→B→C (2 reconexões) → B e C herdam o dia de A.
- Consolidação (fixtures de snapshots): o caso EPGPR30 rende as 9 concluídas em
  29/07 e **zero** em 30/07, consolidando por 29 E por 30 (invariante).

## 7. Não-objetivos

- Mudar o comportamento de `_resolveLogon` / `RELOGIN_MAX_GAP_HORAS` (fica como
  está, default 0). A linkagem usa o threshold NOVO e dedicado.
- Re-atribuir carteira/subcats fora do que a re-consolidação já refaz.
- Fase 2 (exibição ao-vivo) não bloqueia a Fase 1.

## 8. Decisões (resolvidas)

1. **LIMITE de gap:** ✅ **60 min** (José, 30/07). `RECONEXAO_MAX_GAP_MIN=60`
   default. Configurável via env se precisar ajustar sem deploy de código.

## 9. Rollback

- Reverter os commits do código. Re-consolidar os dias de volta (o dry-run/antes
  guarda o estado anterior). Nada é destrutivo além da re-agregação, que é idempotente.
