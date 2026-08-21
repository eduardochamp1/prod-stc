# Revisão dos scripts Python de coleta WPA — 14/08/2026

Revisão de `import_wpa_es.py` (gqo_db) e `monitor_stc_es.py` (stc_es), cruzada
com o que o **WPA Monitor** (`prod-stc`) tem em produção desde abr/2026.

Base de comparação: `services/wpaService.js`, `services/dataWriter.js` e o
BACKLOG do `prod-stc`.

> Cada apontamento tem um "por quê" vindo de incidente real em produção, não de
> preferência de estilo.

---

## 1. O mapeamento de endpoints está CORRETO

Confirmado contra o que usamos em produção. Podem confiar nestes:

| endpoint | uso |
|---|---|
| `POST /identity/signin` | login → Bearer token |
| `POST /Sessions/all/date?sectorId=&date=MM/DD/YYYY` | sessões do dia |
| `GET /notes/{downloaded|executed|rejected}/{sessionId}/session` | notas da sessão |
| `GET /Notes/{noteId}/details/optimized?sectorId=` | detalhe (comentários, checkpoints, interrupções) |
| `GET /Notes/{noteId}/completeInterruptions` | interrupções completas |
| `GET /Notes/{noteId}/historic` | **janela de posse da nota por equipe** |
| `GET /sessions/{sessionId}/break` | intervalos/paradas |
| `GET /Sessions/{sessionId}/collaborators` | colaboradores da sessão |
| `GET /collaboratorshifts/{setor}/{mes}/{ano}` | escala do SGE |
| `GET /teamsstatus/V2?sectorId=` | status online + notas embutidas |

Os nomes de campo também batem (PascalCase da API): `Team.Name/Description/
SectorId/CompanyId`, `BeginTime/EndTime/SessionEndBy/LastStatusUpdate`,
`Number/Address/Neighborhood/City/DesiredConclusionDate/ConclusionDate/Type`,
`Checkpoints[].Event/Try/RegisteredAt`, `Interruptions[].Date/Try/Notes`,
`Collaborators[].Scale[].Day/Date/ScaleCategoryName`.

**Nós vamos aproveitar de vocês:** `/Notes/{id}/historic`,
`/Sessions/{id}/collaborators`, `/sessions/{id}/break`, a lista `ESCALA_EXCLUIR` e
a ideia de comparar escala cadastrada × `ShiftType`. Obrigado — está registrado no
nosso backlog como **P1-23** e **P2-14**.

---

## 2. BLOQUEADORES — corrigir antes de confiar nos números

### 2.1 `item.get("id")` colapsa a Gestão Online (`import_wpa_es.py`, Seção 12)

```python
item_id = item.get("id", "")            # a API é PascalCase e o id é ANINHADO
id_dia  = f"{item_id}_{inicio[:10]}"
```

Retorna `""` **sempre** → `id_dia` fica `"_2026-08-14"` para todas as equipes → o
`ON CONFLICT (id_dia)` faz cada equipe sobrescrever a anterior. **Resultado: 1
linha por dia em vez de ~140.**

Como lemos no `prod-stc`:

```js
const id = item.Session?.Team?.Id || item.Session?.TeamId;
```

### 2.2 Falta o filtro `CompanyId` — entram equipes de outras empreiteiras

`/Sessions/all/date` devolve as sessões de **todas as empresas** do setor.
`import_wpa_es.py` não filtra → `session` e tudo derivado (projetos, detalhes,
interrupções) mistura terceiros, inflando qualquer agregado.

```js
// prod-stc
const engelmig = sessions.filter(s => s.Team?.CompanyId === ENGELMIG_COMPANY_ID);
```

`monitor_stc_es.py` escapa disso por filtrar contra `public.equipes` — mas só
porque tem um cadastro interno; o filtro por `CompanyId` é mais barato e direto.

### 2.3 Status da nota é NÃO-DETERMINÍSTICO (`import_wpa_es.py`, Seção 7)

```python
unicos[reg[0]] = reg    # "o último status coletado prevalece"
```

A coleta é paralela (`as_completed`) → a ordem é **aleatória**. Uma nota que está
em `downloaded` **e** `rejected` grava status **diferente a cada execução**.

Nós resolvemos com **prioridade explícita de bucket** (decisão de negócio de
20/07, refinada em 31/07): `rejeitada > concluída > em andamento`. Cada nota cai
em **exatamente 1 bucket**, sempre o mesmo.

### 2.4 `Downloaded` gravado como `"Executado"` (`monitor_stc_es.py`, Seção 7)

O autor já marcou como comportamento preservado, mas vale o peso: **nota baixada
não é nota executada** — isso infla execução na tabela `servicos`. No mesmo script
o endpoint equivalente vira `"Atribuida"` no laço das sessões: a mesma nota tem
dois status dependendo do caminho.

### 2.5 `delete` + `insert` em transações separadas = perda de dado

```python
apagar_por_ids("checkpoint_projeto", ...)   # abre conexão, COMMITA, fecha
inserir_lote(SQL_CHECKPOINT, ...)           # abre OUTRA conexão
```

Se falhar entre as duas, o delete já foi commitado e **os dados se foram**. Vale
para intervalos, checkpoints e `interrupcao_detalhe`. Precisa ser **uma**
transação — o `upsert_dataframe` do `monitor_stc_es.py` já faz certo com
`engine.begin()`; vale replicar o padrão.

### 2.6 `Sessions/{id}/collaborators` recebendo id de NOTA (`monitor_stc_es.py`, Seção 13)

```python
serv = row["Id do serviço"]                        # id de NOTA
sessao = cliente.get_data(f"Sessions/{serv}/collaborators")
```

O endpoint é de **sessão**. Deveria receber `id_sessao` (de `df_sessao`), 1 chamada
por sessão — não uma por serviço (centenas redundantes). Se está retornando algo,
é coincidência; o provável é vir vazio sem ninguém notar.

---

## 3. FUSO — o dia errado depois das 21h

```python
d = datetime.today()                  # import_wpa_es.py
hoje = datetime.now()                 # monitor_stc_es.py (escala_do_dia)
```

Usa a hora **local do servidor**. Se a VM roda em UTC, às 21h BRT já é meia-noite
UTC → coleta **o dia seguinte** e o dia corrente vem vazio.

Tivemos esse bug exato — está comentado no nosso código: *"Bug exposto em
08/06/2026 às 21h BRT quando carteira inicial do dia caiu pra valor minúsculo
enquanto KPIs do dia inteiro ainda apareciam corretos."*

Solução: calcular a data de referência sempre em **BRT explícito** (UTC-3), nunca
no fuso do host.

---

## 4. CONTA EDP — risco de travar a coleta (de vocês E a nossa)

**A conta WPA bloqueia após 5 tentativas de login falhas.** Nenhum dos dois
scripts tem proteção. Incidente de 13/08 no `prod-stc`: a EDP rotacionou a senha,
o sistema seguiu tentando a cada ciclo e a conta ficou **bloqueada até 03:30** —
coleta parada a noite toda.

O que fizemos, e recomendamos replicar:

1. **Conta EDP própria por sistema.** Se `monitor_stc_es.py` usa
   `clarissa.alves@...`, é a **mesma conta que o WPA Monitor usa para GUA/CAC** —
   os dois disputam o orçamento de 5 tentativas e podem se travar mutuamente.
   Isso precisa ser resolvido.
2. **Token em cache, renovado proativamente** (~45 min). Nunca login por request.
   O `ClienteWPA` já reaproveita o token e faz relogin em 401/403 — bom; falta só
   não logar de novo quando a credencial é ruim.
3. **Circuit breaker:** em "usuário ou senha inválidos" ou "bloqueado, aguarde até
   HH:MM", **pare de tentar** por uma janela longa. Credencial errada não se
   conserta tentando de novo — só queima o orçamento. Erro transiente
   (rede / cold-start do Azure) é diferente: aí retry curto é ok.
4. **Nunca reiniciar em loop** para tentar logar com senha errada.

**Gotcha do `.env` que custou 40 min:** senha com `#`, espaço, `$` ou aspas
**precisa de aspas duplas** — `WPA_PASSWORD="ab#cd1234"`. Sem aspas, o dotenv
corta no `#` e trunca a senha **em silêncio**. Valide o tamanho carregado antes de
subir o serviço.

---

## 5. DESEMPENHO

**`import_wpa_es.py` — `MAX_WORKERS=10`, uma requisição por nota.** O pool HTTP
satura em ~6 conexões por origin e a EDP tem rate limit. Nós fomos para **serial
por setor com 2 chamadas paralelas dentro do setor** justamente por isso — o
comentário no nosso código: *"com 4 setores em paralelo chegava-se a ~240 fetches
simultâneos → notas vinham vazias intermitentemente"*. Sugestão: baixar para ~5.

**`monitor_stc_es.py` — sem paralelismo.** `iterrows()` sequencial nas etapas de
detalhe, intervalo, histórico e colaboradores, e `rota.apply(..., axis=1)` que é
O(n×m) contra o histórico. Com janela padrão de 15 dias isso escala mal. Caminho:
paralelismo com teto (~5) nas coletas, e merge por intervalo em vez de `apply`
linha a linha.

**Delta em vez de varredura — o maior ganho.** O detalhe da nota
(`details/optimized`) é o endpoint caro. Guardem o que já foi baixado e **não
re-baixem o que não mudou**: o endpoint leve (`teamsstatus/V2` / sessões) diz o
que mudou. É a diferença entre um ciclo de 30 min e um de segundos.

---

## 6. Pontos menores

- **`ESCALA_EXCLUIR` é dead code no `import_wpa_es.py`** (declarado, nunca usado).
  No `monitor_stc_es.py` é usado corretamente.
- **Header `host` manual** é ignorado pela `requests` — inofensivo, mas inútil.
- **PK da `rota_dia` sem o horário** (já marcado pelo autor): eventos do mesmo
  tipo/tentativa no mesmo dia colapsam num registro só, o que anula o propósito de
  uma tabela de linha do tempo. Incluir `registro` na chave.
- **`df_servico_detalhes_comentario` coletado e nunca gravado** (já marcado).
- **`intervalos.id` = `equipe + inicio + descricao`** — se `inicio` vier nulo, a
  concatenação gera `NaN` e a linha se perde no `drop_duplicates`.
- **Dedup por UUID:** a WPA repete a mesma nota em vários payloads (e o portal
  exibe linhas duplicadas). Contem sempre por **identificador único**, nunca por
  linha — num incidente nosso, 18 OS reais viraram 143 contagens.

---

## 7. O que fizeram melhor que nós

Registrando porque vamos copiar:

- **`converter_data_robusta`** — trata `'0001-01-01T00:00:00'` como nulo de forma
  centralizada, com cascata de formatos. Nós tratamos isso espalhado em 2 arquivos.
- **Relogin reativo em 401/403** no `ClienteWPA`. Nós renovamos proativamente mas
  não temos esse fallback.
- **`upsert_dataframe` genérico** — substituiu 6 funções quase idênticas.
- **Seção 0 documentando os bugs preservados** em vez de escondê-los. Foi isso que
  permitiu esta revisão ser rápida e específica.

---

## Prioridade sugerida

1. `item.get("id")` da Gestão Online (2.1) — **está corrompendo dado agora**
2. Conta EDP própria + circuit breaker (4) — **risco de travar a coleta**
3. Filtro `CompanyId` (2.2) e status não-determinístico (2.3)
4. `delete` + `insert` na mesma transação (2.5)
5. Fuso BRT explícito (3)
6. `Sessions/{id}/collaborators` com id de sessão (2.6)
7. Desempenho: delta + paralelismo com teto (5)
