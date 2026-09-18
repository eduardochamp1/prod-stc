# SPEC — Categorias de equipe: catálogo único + Equipe Moto (ET) e BT Zero (EB)

> Data: 2026-09-18 · Status: **especificado**, nada implementado.

## 1. O pedido

José, 18/09/2026: *"preciso criar uma nova categoria de equipes, onde as
equipes que começam no EC são comerciais, as EP são plantão e as ET são
Equipe Moto."*

Ao explorar o cadastro apareceu um quarto prefixo que ele não tinha citado —
`EB`, com 4 equipes — e ele decidiu nomeá-lo também, como **BT Zero**.

## 2. O que existe hoje

A categoria da equipe é **derivada do prefixo da sigla**, na leitura. Não é
persistida em lugar nenhum.

Hoje só `EC` e `EP` têm nome; todo o resto cai num balde `OPERACIONAL` com
badge genérico `OP`.

### 2.1 As equipes ET e EB já existem

Contagem de prefixos na whitelist de fallback (`services/equipesOficiais.js`):

```
EC  31      EP  26      ET  14      EB   4
```

**Isto não é criar uma categoria do zero — é nomear dois grupos que já estão
lá, sem nome.** As 14 `ET` são todas `tipo: 'CORTE L0'` no cadastro; as 4 `EB`
são `BTZERO`/`CS`.

### 2.2 A regra está duplicada em 9 sítios

**Backend:**

| Local | O que faz |
|---|---|
| `db/queries.js:1269-1270` | filtra por tipo em `getPerformanceEquipes` (`db/queries.js:1244`) |
| `db/queries.js:1279-1280` | classifica `tipo_equipe` na mesma função |
| `db/queries.js:1323-1324` | filtra por tipo em `_buildEquipeTipoMatrix` (`db/queries.js:1319`) |
| `db/queries.js:1333` | classifica `tipo_equipe` na mesma função |

**Frontend:**

| Local | O que faz |
|---|---|
| `public/index.html:767-768` | as `<option>` do filtro |
| `public/index.html:3693` | traduz categoria → prefixo pra montar a lista de equipes |
| `public/index.html:4233-4237` | classe CSS da barra + badge |
| `public/index.html:4267-4268` | badge |
| `public/index.html:4323` | badge |

Mais o comentário de contrato em `routes/index.js:693`, e o CSS em
`public/css/app.css:4362-4364` (cores da barra) e `:4515-4517` (badges).

**Acrescentar duas categorias nesse esquema são 18 edições manuais**, cada uma
num ternário encadeado. O modo de errar é silencioso: esquecer um sítio de
badge faz a mesma equipe aparecer como "Equipe Moto" numa tabela e "OP" em
outra — o tipo de inconsistência que faz o gestor parar de confiar no painel
inteiro por um detalhe cosmético. Os 9 foram achados por `grep`; não há
garantia de que sejam 9 e não 11.

É o **P3-9** do backlog ("constantes duplicadas em módulo único") aparecendo
na prática.

## 3. O catálogo

| prefixo | chave | rótulo | badge |
|---|---|---|---|
| `EC` | `COMERCIAL` | Comercial | EC |
| `EP` | `PLANTAO` | Plantão | EP |
| `ET` | `MOTO` | Equipe Moto | ET |
| `EB` | `BT_ZERO` | BT Zero | EB |
| *(resto)* | `OPERACIONAL` | Operacional | OP |

Duas decisões de nomenclatura, ambas deliberadas:

**`COMERCIAL` e `PLANTAO` mantêm as chaves atuais.** Elas viajam na URL
(`?tipo=COMERCIAL`); renomear quebraria link e favorito existentes sem ganho.

**A chave do EB é `BT_ZERO`, com underline.** Existe um `tipo: 'BTZERO'` no
cadastro de equipes que é **outra dimensão** — o tipo operacional, editável no
Admin — com a mesma palavra. Sem o underline, quem der `grep BTZERO` daqui a
seis meses acha dois conceitos misturados e conclui a coisa errada.

## 4. Arquitetura

### 4.1 Duas cópias, e um teste que impede a divergência

`services/categoriasEquipe.js` (novo, puro) exporta o catálogo e duas funções:

```
categoriaDaSigla(sigla) → 'COMERCIAL' | 'PLANTAO' | 'MOTO' | 'BT_ZERO' | 'OPERACIONAL'
prefixoDaCategoria(chave) → 'EC' | 'EP' | 'ET' | 'EB' | null
```

O frontend tem a **mesma lista** numa constante do `index.html`, porque são
dois runtimes e o projeto não tem bundler.

Duas cópias é exatamente o problema que este spec resolve, então elas não podem
divergir em silêncio. **A peça central do desenho é um teste que lê a lista do
`index.html`, executa, e compara campo a campo com o módulo do backend.**
Alguém acrescenta uma categoria de um lado só → suíte vermelha antes do push.

Sem esse teste, o catálogo único vira dois catálogos parecidos — que é **pior**
que os 9 ternários, porque parece seguro.

### 4.2 Os 9 sítios passam a ler do catálogo

Todos os `? :` encadeados somem, substituídos por `categoriaDaSigla`,
`prefixoDaCategoria` e um `.map` sobre o catálogo para gerar as `<option>`.

## 5. O filtro multi

### 5.1 O problema que acrescentar categorias cria

O dropdown é multi-select com checkboxes, mas o backend não aceita múltiplos. O
próprio código admite, em `public/index.html:3897`:

> *"Tipo equipe (COMERCIAL/PLANTAO/TODAS) não tem semântica multi — quando ≥2,
> considera TODAS (igual desmarcar tudo)."*

Com **2** categorias isso era inofensivo: marcar as duas é literalmente igual a
marcar todas. Com **4**, marcar "Comercial + Equipe Moto" passa a mostrar as
quatro — silenciosamente, sem erro, com números maiores do que o usuário pediu.

**Acrescentar categorias converte uma esquisitice inócua num defeito real.** Por
isso o filtro multi entra neste spec, e não num item separado.

### 5.2 O contrato

O parâmetro continua sendo **`tipo`**, e passa a aceitar CSV:
`?tipo=COMERCIAL,MOTO`.

Não se cria um `tipos` plural ao lado: dois parâmetros significando a mesma
coisa é ambiguidade de graça. E mantém compatibilidade — `?tipo=COMERCIAL`
sozinho funciona igual, e `TODAS` segue como sentinela de "sem filtro".

Parsing: separa por vírgula, `trim`, maiúsculas, descarta vazio. Lista vazia,
ausente, ou contendo `TODAS` ⇒ **sem filtro**.

Vale para as duas rotas que hoje leem `tipo`:
`/performance/equipes` (`routes/index.js:694`) e `/performance/equipes-matriz`
(`routes/index.js:715`).

### 5.3 O filtro em si

Deixa de ser dois `if` encadeados e passa a: monta o conjunto de prefixos
aceitos a partir das chaves recebidas; a equipe passa se a sigla começar com
**qualquer um** deles.

`OPERACIONAL` é o caso negativo — passa a equipe cujo prefixo **não** está no
catálogo.

### 5.4 "Operacional (outros)" vira opção do filtro

Hoje o dropdown só tem Todas/Comercial/Plantão. Com o catálogo, uma equipe de
prefixo desconhecido cai em `OPERACIONAL` e, sem essa opção, ficaria
**inalcançável por filtro**: visível só em "Todas", invisível em qualquer
recorte.

Nos quatro prefixos que existem hoje esse balde está **vazio**, então a opção
não muda nada agora. Ela existe para o dia em que a EDP criar um prefixo novo —
e nesse dia a equipe aparece em vez de sumir. Este projeto já tem histórico
demais de dado que some sem avisar (P1-39, P2-19), e o custo aqui é uma linha.

### 5.5 O cliente

`public/index.html:3693` hoje traduz uma categoria em um prefixo. Passa a montar
o conjunto dos prefixos selecionados e testar contra todos — mesma lógica do
backend, alimentada pelo mesmo catálogo. E o envio deixa de colapsar ≥2 em
`TODAS`: manda o CSV.

## 6. O que NÃO muda

**Nada é persistido.** O `tipo_equipe` é derivado na leitura, então as ET e EB
aparecem classificadas no **histórico inteiro** assim que subir. Sem backfill,
sem re-consolidação, sem risco sobre número já reportado à EDP.

O campo `equipes_oficiais.tipo` (BTZERO, CS, CORTE L0, COMERCIAL…) — a outra
classificação, a do cadastro — **não é tocado**. São dimensões diferentes e
continuam independentes.

## 7. Testes

**`test/categoriasEquipe.test.js`** (novo):

Sobre `categoriaDaSigla`:
- `ECGPR53` → `COMERCIAL`; `EPGPR01` → `PLANTAO`
- `ETGPR15` → `MOTO`; `EBGPR62` → `BT_ZERO`
- prefixo desconhecido (`EXGPR99`) → `OPERACIONAL`
- minúsculas (`etgpr15`) → `MOTO` (a comparação é case-insensitive)
- sigla vazia, `null`, `undefined` → `OPERACIONAL`, sem estourar

Sobre `prefixoDaCategoria`:
- `MOTO` → `ET`; `BT_ZERO` → `EB`
- `OPERACIONAL` → `null` (não tem prefixo próprio; é o complemento)
- chave desconhecida → `null`

**O teste de acordo entre as duas cópias** (o mais importante):
- extrai a constante do `index.html`, executa, e compara **campo a campo** com
  o catálogo do backend: mesma quantidade, mesma ordem, mesmos prefixo, chave,
  rótulo e badge

Sobre o filtro multi (na função pura que resolve os prefixos aceitos):
- `['COMERCIAL','MOTO']` → aceita `EC` e `ET`, recusa `EP` e `EB`
- `['TODAS']` → aceita tudo
- `[]` e `null` → aceitam tudo
- `['OPERACIONAL']` → aceita só o que **não** casa com nenhum prefixo do
  catálogo
- `['COMERCIAL','TODAS']` → `TODAS` vence, aceita tudo

Sobre a rota (contrato):
- `?tipo=COMERCIAL,MOTO` filtra pelas duas
- `?tipo=COMERCIAL` continua funcionando como hoje (compatibilidade)
- `?tipo=` ausente ⇒ sem filtro

## 8. Rollback

`git revert`. Não há mudança de schema, cron, nem de caminho de escrita. O
efeito é inteiramente de leitura e apresentação.

Os commits são separáveis por camada: catálogo (inerte sozinho), backend,
frontend/CSS.

## 9. Fora de escopo

- **Mudar o campo `equipes_oficiais.tipo`** do cadastro — outra dimensão, ver §6.
- **Tornar a categoria editável no Admin.** Foi oferecido e descartado: exigiria
  preencher 143 linhas e aceitar que cadastro e sigla divirjam, trocando uma
  regra que não pode errar por um cadastro que pode ficar desatualizado.
- **Renomear `COMERCIAL`/`PLANTAO`** — ver §3.
- **Outras abas.** Verificado em 18/09: o filtro de **categoria de equipe**
  existe **só** na aba Gráficos (`graf-tipo-select`, `public/index.html:765`).
  Os filtros chamados "Tipo" nas abas Rejeições (`rej-tipo-select`,
  `public/index.html:312`) e Mapa (`mapa-tipo-select`,
  `public/index.html:457`) são de **tipo de NOTA** — MD, SF, DD, LN, LE, DL,
  RL — outra dimensão, e não são tocados. O nome parecido é a única coisa que
  têm em comum.
