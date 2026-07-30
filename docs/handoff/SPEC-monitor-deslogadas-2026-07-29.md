# SPEC — Monitor: filtro Ativas ⇄ Todas + roster com "última sessão"

> Data: 2026-07-29 · Origem: brainstorm com o José · Status: **aprovado, a implementar**

## 1. Objetivo

Adicionar ao Monitor um alternador **Ativas ⇄ Todas** (ao lado de Cards/Tabela),
valendo nas duas visões:

- **Ativas** — mostra só equipes **em campo agora** (sessão aberta + online).
  Esconde encerradas de hoje e deslogadas.
- **Todas** — mostra **em campo** + **encerradas de hoje** + **deslogadas**
  (equipes do roster oficial que NÃO logaram hoje), estas exibindo a **última
  sessão** (notas exec/rejeição, login/logoff, colaboradores, placa, etc.).
  Ao clicar numa deslogada, o modal de detalhe mostra a última sessão.
  Quando a equipe logar de novo, ela sai das deslogadas e vira ativa (o
  `/api/teams` passa a trazê-la) — sem ação manual.

Preferência (Ativas/Todas) é **pessoal**, salva em `localStorage`
(`wpa-monitor-scope`), como o toggle Cards/Tabela (`wpa-monitor-view`).

## 2. Decisões (fechadas no brainstorm)

- **Roster completo:** "Todas" inclui equipes que não trabalharam hoje, puxando
  a última sessão de **dias anteriores** (não só as encerradas de hoje).
- **Precisão via união:** as notas da última sessão vêm da **união dos snapshots
  do último dia ativo** da equipe (reusa `_unionTeamsFromSnapshots`, P1-13) —
  recupera concluídas que a WPA podou. Não usar "só o último snapshot" (subconta).
- **KPIs intocados:** os indicadores do topo (OS Executadas/Rejeitadas, % carteira
  trabalhada) vêm de `summary.dia`; TOTAL EQUIPES vem da whitelist. **Nenhum**
  deles lê o array renderizado (`renderMonitor`, "FONTE ÚNICA: summary.dia",
  ~public/index.html:6073). Logo, deslogadas entram **só na lista exibida**, sem
  alterar número reportável nenhum. Ficam flagueadas (`deslogada: true`).

## 3. Backend

### 3.1 Novo endpoint

`GET /api/teams/deslogadas?regionals=GUA,CAC,SJC`

- Escopo: `req.scope.regionals` (middleware já resolve). Respeita permissão
  regional como os demais endpoints do Monitor.
- Resposta: `{ teams: [ <team reconstruído> ], date: <hoje> }`.
- Sem `sq`/DB: retorna `{ teams: [] }` (degrada suave, como os outros).

### 3.2 Query/serviço — `getDeslogadasUltimaSessao(regionals)` (db/queries.js)

1. **Roster no escopo:** `siglas = equipesOficiais.getSiglas` por regional do
   escopo (unir as regionais do array). Só ativas.
2. **Último dia ativo por equipe:** `DISTINCT ON (team_name) team_name, date`
   de `snapshots` `WHERE team_name IN (siglas)` `ORDER BY team_name,
   captured_at DESC`. (via `_selectAll` respeitando paginação/tie-breaker.)
3. **Filtrar deslogadas:** manter só as com `date < hoje` (BRT). Quem tem
   snapshot de hoje é ativa/encerrada-hoje → já vem do `/api/teams`, não entra.
4. **União do último dia:** para cada (equipe, últimoDia), buscar TODOS os
   snapshots de `{últimoDia-1, últimoDia}` daquela equipe e chamar
   `_unionTeamsFromSnapshots(snaps, últimoDia, últimoDia-1)`. Pegar a entrada da
   equipe (se relogou naquele dia, unir tudo do dia — mesma lógica da produção).
5. **Reconstruir o team** no shape que o front espera:
   - `id: 'deslog:' + sigla` (estável, único — pro `openModal`).
   - `sigla`/`teamName`, `regional`, `sectorId`, `tipo` (de `getMeta`).
   - `vehiclePlate`, `collaborators`, `sessionBegin`, `sessionBeginReal`,
     `sessionEnd` — do snapshot mais recente do últimoDia (estado final).
   - `notasConcluidas`, `notasRejeitadas`, `notasExecutadas`, `notasBaixadas` —
     da **união** do últimoDia.
   - `isOnline: false`, `relogins: 0`.
   - `deslogada: true`, `ultimaSessaoDate: <últimoDia>` (YYYY-MM-DD).
   - `date: <últimoDia>` (não hoje — é a data da sessão que estamos mostrando).
6. Enriquecer com escala (`getMeta`) se disponível.
7. Só equipes oficiais (`_onlyOficiais`).

### 3.2b Métricas pré-computadas (IMPORTANTE)

Os cards/tabela calculam exec/andam/carteira/reje filtrando as notas pelo
**range do Monitor (hoje)** via `notaPertenceAoRange`. As notas de uma deslogada
são de um **dia anterior** → seriam **zeradas** por esse filtro. Por isso o
backend anexa `metrics` já prontas na deslogada, e o front usa `t.metrics.*`
quando `t.deslogada` (sem passar pelo filtro de range):

```
t.metrics = {
  executadas: <união concluidas>.length,
  rejeitadas: <união rejeitadas>.length,
  andamento:  <último snapshot notasExecutadas>.length,
  inicial:    <último snapshot notasBaixadas>.length,   // carteira do dia
  atual:      max(0, inicial - executadas - rejeitadas - andamento),
}
```

Aproximação honesta: `inicial`/`atual` reconstruídos da carteira baixada do dia
(visão informativa da última sessão, não número reportável). Exec/reje vêm da
UNIÃO (fiéis). O caminho das equipes ativas fica **intocado**.

### 3.3 Função pura testável

`_reconstruirDeslogada(teamUnido, metaSnapshot, meta, ultimaSessaoDate)` →
objeto team no shape acima. Recebe: o resultado da união (notas), o snapshot
mais recente do dia (session/placa/colaboradores), o meta da whitelist, e a data.
Sem I/O — testável com fixtures. Trava: id estável, flags, notas vindas da união,
sessão/placa vindas do snapshot final.

## 4. Frontend (public/index.html + css/app.css)

### 4.1 Estado e alternador

- `let _monitorScope = localStorage.getItem('wpa-monitor-scope') === 'todas' ? 'todas' : 'ativas';`
  **Default = 'ativas'** (comportamento mais enxuto por padrão; hoje o Monitor
  mostra em-campo+encerradas — ver nota de migração abaixo).
- Novo grupo de botões ao lado do toggle Cards/Tabela: `● Ativas` / `◍ Todas`.
  `setMonitorScope(v)` salva no localStorage, e:
  - se 'todas' e ainda não temos deslogadas → dispara o fetch (§4.2);
  - `renderAll()`.

> **Default = 'ativas'** (decidido pelo José, 29/07): abre mostrando só quem
> está em campo agora. Encerradas/deslogadas aparecem ao clicar em "Todas".

### 4.2 Fetch das deslogadas

- `let _deslogadas = null;` (cache). `_fetchDeslogadas()` chama
  `GET /api/teams/deslogadas?regionals=<escopo>` e guarda em `_deslogadas`.
- Chamado quando o scope vira 'todas' (lazy) e re-buscado junto do refresh do
  Monitor **quando** scope==='todas' (não pesar o fetch quando não está em uso).

### 4.3 Composição da lista em `renderAll`

Onde hoje `teams` = `allTeams` filtrado por busca/regional, passa a:

- **scope 'ativas':** `base = allTeams.filter(emCampo)` (sessão aberta + online).
- **scope 'todas':** `base = allTeams.concat(_deslogadas || [])`.

Depois seguem os filtros existentes (busca, tipos/subcats, range, histórico).
Dedup por sigla: se uma sigla estiver em `allTeams` (ativa/encerrada hoje) E em
`_deslogadas`, a de `allTeams` vence (não deve acontecer, pois deslogadas são
`date < hoje`, mas garantimos).

### 4.4 Render (card e tabela)

- Estado visual da deslogada: badge **"⏸ deslogada · última DD/MM"** (usa
  `ultimaSessaoDate`). Cabeçalho/linha em tom "encerrada" (cinza), ponto cinza.
- Card: reusa o render atual; só adiciona o badge quando `t.deslogada`.
- Tabela: coluna Situação = "Deslogada"; badge de data na coluna Equipe.
- Clique → `openModal(t.id)`. Como a deslogada está em `allTeams`/lista, o
  `openModal` acha pelo id e mostra a última sessão (notas, login/logoff,
  colaboradores). Garantir que o modal renderiza com os campos reconstruídos.

### 4.5 Não poluir agregados do dia

- **Alerta de sessão anômala** (`alert-stale-sessions`) e qualquer contagem
  "do dia" **excluem** `t.deslogada` (elas não são sessões de hoje).
- `section-count` reflete o total exibido (pode incluir deslogadas em 'todas') —
  ok, é a contagem da lista, não um KPI.

## 5. Casos de borda

- Equipe sem nenhum snapshot no histórico → não aparece em deslogadas (sem
  última sessão pra mostrar). Ok.
- Equipe que trabalhou hoje → não entra em deslogadas (date == hoje). Aparece
  como ativa/encerrada via `/api/teams`.
- Modo histórico (data passada no filtro do Monitor): deslogadas seguem a data
  atual (última sessão real) — o filtro Ativas/Todas só faz sentido no "hoje".
  Em histórico, ocultar/neutralizar o toggle Ativas/Todas (mostrar como está).
- Whitelist editada (equipe desativada) → não entra (getSiglas só ativas).

## 6. Testes (`node --test`)

- `test/deslogadas.test.js`:
  - `_reconstruirDeslogada`: id estável `deslog:SIGLA`; `deslogada:true`;
    `ultimaSessaoDate` correto; notas vindas da UNIÃO (não do snapshot final);
    placa/colaboradores/sessão vindas do snapshot final; `isOnline:false`.
  - Dedup: sigla ativa hoje não vira deslogada.
- Suíte deve subir e ficar 100% verde.

## 7. Decisões (resolvidas)

1. **Default do filtro:** ✅ **'ativas'** (José, 29/07) — abre só com em-campo.

## 8. Não-objetivos (YAGNI)

- Paginação/ordenação da tabela (fica pra depois).
- Reprocessar/gravar nada — deslogadas é **só leitura** de snapshots.
- Alterar KPIs, produção ou qualquer número reportável.

## 9. Rollback

- Frontend: reverter o commit (toggle some, volta ao comportamento atual).
- Backend: o endpoint é aditivo e read-only; remover a rota + a query.
- Zero migração de dados; nada gravado.
