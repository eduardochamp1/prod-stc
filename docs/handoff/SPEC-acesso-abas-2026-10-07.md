# SPEC — Acesso por aba: suspender e conceder abas por usuário

> Data: 2026-10-07 · Status: **especificado**, nada implementado.
>
> Item do backlog: **P0-1e**. Quarto incremento da gestão de usuários (P0-1a
> usuários no banco, P0-1b troca de senha, P0-1c excluir, P0-1d incidente da
> migration).
>
> ⚠️ Mexe em **controle de acesso**. Vale tudo o que valeu nos incrementos
> anteriores: os testes de trava são HTTP, não inspeção de código-fonte.

## 1. O pedido

José, 07/10/2026: *"e agora como fazemos para suspender ou conceder acesso as
abas aos usuários"*.

Decisões dele, na mesma data, entre as opções oferecidas:

| pergunta | escolha |
|---|---|
| Só esconder a aba na tela, ou bloquear no servidor também? | **Bloqueio no servidor** |
| Usuário novo nasce com quais abas? | **Com todas** |
| A aba Admin vira caixinha também? | **Não — continua presa ao `role=admin`** |

## 2. O que existe hoje

- Três controles por usuário: `role` (só decide o botão Admin), `regionals`
  (escopo de dados, em todas as abas) e `pode_gerenciar` (quem mexe em usuário).
- **Todo usuário logado vê as 8 abas:** Monitor, Rejeições, Deslocamento,
  Notas, Gráficos, Ranking, Mapa, Histórico (`public/index.html:96-103`; a aba
  `metas` está oculta permanente, `:106` e `:1681`).
- O frontend esconde o botão Admin por `role` (`public/index.html:1676-1683`),
  e o servidor recusa `/admin/*` por `requireAdmin` (`routes/index.js:249`).
  Não existe nada parecido por aba.
- A spec de 21/09 (`SPEC-gestao-usuarios`) deixou "perfis/permissões" fora de
  escopo. Este spec é a reabertura disso, a pedido.

## 3. Decisões

### 3.1 O servidor é quem bloqueia

Esconder o botão sem bloquear a rota é contornável chamando a API direto — e
seria incoerente com o princípio da gestão de usuários: *o token prova quem
você é; o banco diz o que você pode.* A tela esconde por conforto; a API
recusa por segurança.

### 3.2 Guardar as SUSPENSAS, não as concedidas

Coluna `abas_suspensas`, vazia por padrão. Três consequências, todas
desejadas:

- **Usuário novo nasce com todas** (a escolha do José) sem nenhum código a mais:
  vazio = nada suspenso.
- **Os 5 usuários de hoje não mudam nada** no deploy.
- **Tolerância à migration pendente vem de graça** (lição do P0-1d): se a
  coluna não existe, ninguém PODE ter tido aba suspensa, e "nada suspenso" é a
  verdade, não um palpite. Entra no `_COLS_OPCIONAIS`.

**O custo, registrado:** aba criada no futuro aparece para todos, inclusive
para quem tem outras suspensas. Quem criar uma aba sensível decide na hora se
a suspende para alguém. A alternativa (guardar as concedidas) inverte isso, mas
exige que todo usuário existente ganhe a lista completa na migration, e que
toda aba nova seja concedida a mão a cada um.

### 3.3 Uma rota é liberada se a pessoa tem QUALQUER aba que a usa

Várias rotas servem mais de uma aba (ver §5). Suspender o Ranking não pode
quebrar o Monitor só porque os dois leem a mesma rota. Consequência aceita:
quem tem o Monitor consegue, pela API, o dado que essa rota compartilhada
também entrega ao Ranking. Quando isso importar para uma aba específica, a
rota tem de ser separada — decisão por caso, não deste spec.

### 3.4 Rota sem dono quebra a suíte

O risco real deste desenho é **rota nova esquecida no mapa** — ela ficaria
aberta a todos sem ninguém perceber. Por isso:

- o mapa rota → aba vive num lugar só (`services/abas.js`);
- toda rota fora de `/admin/*` tem de estar no mapa **ou** numa lista explícita
  de rotas globais (login, status, troca de senha…), cada uma com o motivo;
- **um teste enumera as rotas registradas no router e falha** se alguma não
  estiver em nenhum dos dois. Rota nova sem dono = suíte vermelha.

### 3.5 Admin vê tudo, sempre

`role=admin` ignora `abas_suspensas`. Coerente com a escolha de manter o Admin
no `role`, e impede o jeito mais fácil de se trancar para fora: um gestor não
consegue suspender de si mesmo a tela onde se concede acesso. A conta de
emergência do `.env` é admin e também não passa por aqui.

### 3.6 Precisa sobrar ao menos uma aba

Suspender todas é desativar — e para isso já existe o Desativar, com as travas
dele. Trava nova: `podeAlterar` recusa `abas_suspensas` com todas as abas.

### 3.7 Vale em até 30s, sem relogin

Mesmo mecanismo da revogação: `abas_suspensas` NÃO vai no token. O
`authMiddleware` já relê o usuário do banco (cache de 30s) a cada requisição; a
lista vem junto. Ao salvar, o cache do usuário é invalidado.

### 3.8 O código da recusa é próprio

`403` com `code: 'ABA_SUSPENSA'` e a aba no corpo. `403` já é "sem permissão"
no painel, e aqui é isso mesmo — o `code` deixa o frontend esconder a aba e
explicar, em vez de mostrar erro genérico.

## 4. Modelo de dados

Uma coluna em `usuarios`:

| coluna | tipo | nota |
|---|---|---|
| `abas_suspensas` | `text NOT NULL DEFAULT ''` | `'ranking\|mapa'` — mesmo formato de `regionals`, de propósito: reusa o parser |

Migration `migrations/add_abas_suspensas.sql`, com OWNER (lição de 21/09) e
replicada no `add_usuarios.sql` (replayable). A trilha não muda: a alteração
entra como `alterar`, com `abas_suspensas` no antes/depois do `detalhe`.

## 5. O mapa rota → aba

Levantado em 07/10/2026 rastreando cada `fetch` do `public/index.html` até a
aba que o dispara (`switchTab`, `:2351-2395`). Linhas citadas são do
`index.html` salvo indicação.

### 5.1 Rotas de UMA aba

| aba | rotas | evidência |
|---|---|---|
| monitor | `/teams`, `/teams/historico`, `/teams/deslogadas`, `/escala/agora`, `POST /notas/subcategorias`, `/wpa/nota/:noteId` | `loadData` :7180-7184; `_fetchDeslogadas` :7573; `renderMetrics` :8403; `enrichSubcategorias` :8548; `openNotaDetail` :9157 (só alcançável pelo modal de equipe do Monitor) |
| rejeicoes | `/rejeicoes/totais`, `/rejeicoes/lista`, `/rejeicoes/motivos` | `loadRejeicoes` :2798-2800 |
| desloc | `/deslocamentos/lista`, `/deslocamentos/ranking`, `/deslocamentos/tendencia`, `/po-reparo` | `loadDeslocamentos` :3270-3272; `loadTma` :5581 (sub-aba TMA) |
| notas | `/notas/kpis`, `/notas/serie`, `/notas/serie-horaria`, `/notas/por-equipe`, `/notas/equipe/:nome` | :2435, :2461-2462, :2549, :2573 |
| graficos | `/performance/equipes`, `/performance/equipes-matriz`, `GET /contador-transgressao` | `loadGraficos` :4253-4255, :4275 |
| ranking | `/ranking/equipes`, `/carteira/equipes` | `loadRanking` :5273, :5290 |
| mapa | `/mapa/equipe` | `loadMapa` :11649 |
| historico | `/historico/sessoes`, `/historico/subcats/mes`, `/historico/subcats/diario`, `/historico/subcats/ranking`, `/he/medicao` | :6711, :6324-6325, :6563, :5971 |

### 5.2 Rotas COMPARTILHADAS (liberadas com qualquer uma das abas — §3.3)

| rota | abas | evidência |
|---|---|---|
| `/totais/subcat` | monitor, graficos | :5085, :8372; :4252-4254 |
| `/export/historico` | historico, graficos | dois botões "Baixar XLSX", :768 e :880 → `_doExportXLSX` :11304 |
| `/equipes` | monitor, rejeicoes, desloc, graficos, ranking, mapa, historico (todas menos notas) | popula os seletores de equipe e o filtro de supervisor (`_supCarregarEquipes` :7609) |

### 5.3 Rotas GLOBAIS (de nenhuma aba)

| rota | por que é global |
|---|---|
| `POST /auth/login`, `POST /auth/senha`, `GET /auth/eu` (nova) | sessão — antes de qualquer aba |
| `GET` e `PUT /settings/:key` | filtros salvos; lida no boot (:7292) e gravada pelo filtro de regional de **qualquer** aba (:7787). O servidor já limita à chave do próprio usuário (`routes/index.js:1106`) |
| `GET /metas`, `GET /metas-diarias` | o modal de Metas é aberto por todos (:1682) e o Gráficos lê o mesmo cache (:4269) |
| `POST /metas`, `POST /metas-diarias` | modal de Metas; quem grava já é decidido por `role` (`routes/index.js:849`) |

### 5.4 Rotas que o frontend NÃO usa

`/teams/:teamId`, `/summary`, `/status`, `/totais/dia`, `/historico/mes`,
`/historico/diario`, `/historico/equipes`, `/equipes/producao`,
`/metas/calculadas` (só pela aba Metas, oculta permanente), `/wpa/login`,
`/wpa/token-status`, `/wpa/probe`.

**Decisão: viram SÓ ADMIN** (grupo `manual` no catálogo). Ninguém as usa pela
tela; deixá-las abertas seria a porta lateral exata que o §3.1 quer fechar —
`/equipes/producao` e `/historico/equipes` entregam dado de produção por
equipe sem passar por aba nenhuma. Admin continua podendo chamá-las à mão
(`/wpa/probe` é usado em diagnóstico, `API-WPA-EDP.md:818`).

`/debug/*`, `/admin/*` e `PUT /contador-transgressao` /
`PUT /deslocamentos/threshold` já são só admin (`routes/index.js:249`, `:498`,
`:1178`, `:4057`) e não mudam.

### 5.5 O Monitor é diferente das outras abas

Ele não carrega quando é aberto: carrega **no boot e a cada 5 minutos, em
qualquer aba** (`init` :9466, `setInterval` :9468-9472), e é a aba padrão
(:96, :110, :2326). Para o Monitor ser suspensível, o frontend precisa:

- não chamar `loadData` nem armar o timer para quem tem o Monitor suspenso;
- abrir na primeira aba liberada;
- **buscar as metas no boot por conta própria.** Hoje o cache de metas só é
  enchido pelo `loadData` (`fetchMetas` :4751, chamado de :7185); o Gráficos e
  o modal de Metas só leem esse cache (:4269, :6975). Sem o Monitor, ficariam
  sem meta — calados, que é o pior jeito.

Sem isso, essa pessoa tomaria `403` a cada 5 minutos, que o interceptador de
fetch não trata (só 401 e 423 — :1497-1515) e viraria "Erro de conexão"
(:7222).

## 6. Arquitetura

### 6.1 `services/abas.js` — o catálogo

- `ABAS`: id, rótulo e as rotas de cada aba (padrões, ex.: `/notas/equipe/:nome`).
- `ROTAS_GLOBAIS`: rotas que não pertencem a aba nenhuma, cada uma com o motivo.
- `abasDaRota(path, method)` → lista de abas, `'global'`, ou `null` (sem dono).
- `podeAcessar(user, path, method)` → `{ ok, aba? }`, PURA.

### 6.2 O bloqueio

Um `router.use` logo depois do `applyScope` (`routes/index.js:245`), antes de
qualquer rota de dados:

- `/admin/*` → segue (já tem `requireAdmin`);
- `role=admin` → segue;
- rota global → segue;
- rota de abas → segue se ao menos uma das abas dela não está suspensa;
- senão `403 ABA_SUSPENSA`.
- **Rota sem dono em produção → segue, com `console.error`** uma vez por rota.
  Negar quebraria o painel por um esquecimento que o teste da §3.4 já devia ter
  pegado; liberar é o comportamento de hoje. O teste é a trava; isto é a rede.

### 6.3 O login e a sessão informam

A resposta de `/auth/login` ganha `abas_suspensas`. E uma rota nova
`GET /auth/eu` devolve o estado atual (role, regionals, abas_suspensas), que o
frontend chama ao carregar a página — senão a sessão restaurada do navegador
mostraria as abas do momento do login, não as de agora.

### 6.4 A tela

- **Editar usuário:** uma caixinha por aba, marcada = liberada. Desmarcar
  suspende. Aviso de que vale em até 30 segundos.
- **Lista:** coluna "Abas" mostrando `todas` ou `6 de 8`, com as suspensas no
  título.
- **Painel do usuário:** botões das abas suspensas escondidos; se a aba aberta
  por padrão estiver suspensa, abre a primeira liberada; `403 ABA_SUSPENSA` no
  interceptador de fetch esconde a aba e avisa.

## 7. Testes

**Puros** (`test/abas.test.js`):
- `abasDaRota` resolve rota com parâmetro (`/notas/equipe/:nome`)
- `podeAcessar`: aba suspensa → nega; rota compartilhada com uma aba liberada →
  libera; admin → libera sempre; rota global → libera
- `podeAlterar` recusa suspender todas as abas; recusa aba inexistente

**Cobertura** (`test/abasCobertura.test.js`):
- toda rota registrada no router, fora de `/admin/*`, está no mapa ou nas
  globais — **verificado que fica vermelho** ao registrar uma rota sem dono

**HTTP** (`test/abasHttp.test.js`):
- usuário com `ranking` suspenso: rota só do Ranking → `403 ABA_SUSPENSA`;
  rota de outra aba → 200
- admin com a coluna preenchida → 200 (ignora)
- conta de emergência → 200
- suspender, invalidar cache, e a mesma sessão passa a tomar 403 (sem relogin)
- coluna `abas_suspensas` inexistente (42703) → login e rotas seguem (P0-1d)
- `GET /auth/eu` devolve `abas_suspensas` e nunca `senha_hash`

**Tela** (`test/abasTela.test.js`):
- o editar mostra uma caixinha por aba do catálogo
- o interceptador trata `ABA_SUSPENSA` pelo `code`

## 8. Rollback

`git revert`. A coluna pode ficar: sem o código, ninguém a lê, e todos voltam a
ver todas as abas (o comportamento de hoje). Para tirar:
`ALTER TABLE usuarios DROP COLUMN abas_suspensas`.

## 9. Fora de escopo

- **Perfis/grupos** ("supervisor vê X, Y"). Com 5 usuários, caixinha por pessoa
  basta; perfil é refazer quando passar de ~15.
- **Permissão por botão dentro da aba** (exportar, editar threshold). A aba é a
  unidade.
- **Separar rotas compartilhadas** para sigilo fino (§3.3).
- **A aba Admin** — continua no `role`, por escolha do José.

## 10. Achados paralelos do levantamento

Fora do escopo deste spec, cada um com item próprio no backlog:

- **P1-52** — `/teams/deslogadas` é engolida por `/teams/:teamId` (registrada
  antes) e responde 404. **Reproduzido.** Ao implementar este spec, a rota
  entra no mapa como `monitor` de qualquer jeito.
- **P2-58** — o patch global de `fetch` manda o JWT para o proxy OSRM no
  workers.dev.
- **P3-20** — "⚡ Acordar WPA" e a recuperação automática de OS chamam
  `/admin/warm`, que só admin pode; para os outros, 403 calado.
