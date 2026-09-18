# SPEC — Tabela "Acumulado: perda por rejeição" (aba Gráficos)

> Data: 2026-09-18 · Status: **especificado**, nada implementado.
>
> Tabela nova na aba Gráficos, **abaixo** da matriz "Notas Atendidas por Tipo".
> A matriz existente **não é alterada** — ela permanece exatamente como está.

## 1. Objetivo

Pedido do José em 18/09/2026: *"uma tabela que mede as perdas por notas
rejeitadas das equipes e o acumulado da regional também"*.

Mostrar, por equipe e por regional, quanto da produção atendida no período se
perdeu em rejeição — em **quantidade e em taxa**.

## 2. O que já existe, e por que não serve

`public/index.html:4301` monta o `matrizHTML`, renderizado em
`public/index.html:4384` sob o título "Notas Atendidas por Tipo — EXEC ×
Rejeitadas por Equipe" (`public/index.html:4342`).

Ela já tem os números, mas — nas palavras do José — *"dispersas e espalhadas"*:

- As colunas se repetem **por tipo de nota** (EXEC/REJ/SOMA para cada tipo),
  o que a torna larga e boa pra investigar um tipo específico, não pra ler a
  perda total de uma equipe.
- **Não existe taxa.** Só contagens absolutas, então não dá pra comparar equipe
  grande com equipe pequena.
- O rodapé dá **um** Total. Com o filtro em "Todas as regionais", não há
  subtotal por regional.

A tabela nova responde outra pergunta e por isso é outra tabela, não uma
reforma daquela.

## 3. A fonte de dados já existe

`_buildEquipeTipoMatrix` (`db/queries.js:1319`, chamada em `db/queries.js:1404`)
já devolve, por equipe: `team_name`, **`regional`**, `sector_id`,
`tipo_equipe`, `total_exec`, `total_rej`, e os cortes por tipo.

No front, esse payload está em **`matrizData.equipes`** — a mesma fonte que o
`matrizHTML` consome (`public/index.html:4302`). **Atenção:** existe também uma
variável `equipes` no mesmo escopo, que alimenta a seção "Detalhamento por
Equipe e Tipo de Nota" e **não** carrega `total_exec`/`total_rej`. A tabela nova
lê de `matrizData.equipes`. Confundir as duas produziria uma tabela vazia ou com
`undefined`, e o erro seria silencioso.

Tudo o que a tabela nova precisa **já chega no browser**. Portanto:

- **Zero mudança no backend.** Nenhuma rota, nenhuma query, nada no banco.
- O cálculo é agrupamento e soma sobre um payload que já está em memória —
  custo de rede zero, custo de banco zero.

## 4. Decisões de desenho

### 4.1 Cinco colunas, e a conta fecha na tela

`Equipe · Executadas · Rejeitadas · Atendidas · % Rejeição`

`Atendidas = Executadas + Rejeitadas`, e `% Rejeição = Rejeitadas ÷ Atendidas`.

A coluna "Atendidas" existe pra conta ser conferível de cabeça, em vez de o
leitor ter que confiar no percentual. Isso vale mais aqui do que em outra tela:
pela regra vigente desde **31/07/2026**, execução é de quem finalizou 100% e
rejeição no dia da conclusão ou depois não é produção — cada OS cai em
**exatamente um** dos dois buckets. A aritmética fecha por construção, e a
tabela deixa isso visível.

### 4.2 Agrupado por regional, com o subtotal no cabeçalho do grupo

As equipes ficam sob a regional delas. O subtotal vai **no cabeçalho** do
grupo, não num rodapé: uma linha em vez de duas, e o número aparece onde o olho
já está ao trocar de regional. Total geral no rodapé da tabela.

### 4.3 Ordem: taxa decrescente, sem corte de amostra

Dentro de cada grupo, maior taxa primeiro. Empate resolve por **volume
atendido decrescente**, depois por sigla — ordem estável, e as equipes de 0%
ficam no fim da maior pra menor.

**Não há tratamento de amostra pequena.** Foi levantado que ordenar só por taxa
põe no topo a equipe com 3 notas atendidas e 1 rejeitada (33%), e o José optou
por **nenhum corte** (18/09). A decisão se sustenta porque a coluna "Atendidas"
fica ao lado da taxa: a equipe de volume irrisório se denuncia na própria
linha. Registrado aqui pra ninguém "consertar" isso depois achando que foi
esquecimento.

### 4.4 Ordem diferente da matriz de cima, de propósito

A matriz ordena por volume atendido; esta ordena por taxa. São perguntas
diferentes — "quem produz mais" e "quem perde mais proporcionalmente". Forçar a
mesma ordem estragaria uma das duas.

## 5. Arquitetura

Duas funções **puras** no `public/index.html`, no padrão já usado por
`_filtrarEquipes` e `_detectarCabecalho`: extraídas do HTML e **executadas** no
teste, não conferidas como texto.

```
_agruparPerdaPorRegional(equipes)
  → [{ regional, total_exec, total_rej, total_atend, taxa, equipes: [...] }]

_renderAcumuladoRejeicao(grupos)
  → string HTML
```

A separação importa: a primeira é onde a conta pode errar, e pode ser testada
sem HTML nenhum. Cada equipe dentro do grupo carrega
`{ team_name, total_exec, total_rej, total_atend, taxa }`.

Os grupos saem ordenados por **nome de regional** (ordem previsível entre
recargas), e as equipes dentro de cada um pela regra da §4.3.

## 6. A armadilha: média de percentual

A taxa da regional é `soma(rejeitadas) ÷ soma(atendidas)` do grupo — **nunca**
a média das taxas das equipes.

Parecem a mesma coisa e não são. Uma equipe com 1 rejeição em 2 notas (50%) e
outra com 10 em 1000 (1%) dão média simples de **25,5%**, quando a perda real
do grupo é 11 em 1002 — **1,1%**. Média de percentual é um dos jeitos clássicos
de um número virar mentira num painel que a EDP audita.

Há teste cravando exatamente esse caso (§7).

## 7. Testes

**`test/acumuladoRejeicao.test.js`** (novo), sobre as duas funções extraídas do
`index.html`:

Sobre `_agruparPerdaPorRegional`:
- agrupa equipes de regionais diferentes em grupos distintos
- `total_atend` de cada equipe = `total_exec + total_rej`
- taxa da equipe = `total_rej / total_atend`
- **taxa da regional é ponderada, não média das taxas** — o caso 50% + 1% da
  §6, afirmando 1,1% e **não** 25,5%
- equipe com 0 rejeitadas → taxa 0, sem `NaN`
- equipe com 0 atendidas (defensivo) → taxa 0, sem divisão por zero
- ordem dentro do grupo: taxa desc, empate por volume desc, depois sigla
- grupos ordenados por nome de regional
- lista vazia → devolve `[]`, não estoura

Sobre `_renderAcumuladoRejeicao`:
- a linha da regional traz o subtotal e vem **antes** das equipes dela
- o total geral aparece no rodapé, e é a soma de todos os grupos
- percentual formatado com uma casa e vírgula (padrão pt-BR do painel)
- sigla de equipe é escapada (`escapeHtml`) — dado que veio da EDP não vai cru
  pro `innerHTML`, pela regra do P2-4

## 8. Bordas

- **Sem equipes no período:** a seção não renderiza. Segue o padrão do próprio
  `matrizHTML`, que faz `if (eqs.length === 0) return '';`
  (`public/index.html:4303`) — uma IIFE que devolve string vazia, e não um
  ternário no template como o da seção "Detalhamento".
- **Filtro numa regional só:** um grupo apenas. Funciona sem caso especial.
- **Filtro numa equipe só:** um grupo com uma equipe. O subtotal repete a
  linha dela — redundante, e correto; não vale código pra esconder.

## 9. Rollback

`git revert`. Tudo em `public/index.html` mais um arquivo de teste novo. Nada
de schema, rota, cron ou caminho de leitura. Reverter devolve a aba Gráficos ao
estado atual sem tocar em nada mais.

## 10. Fora de escopo

- **Mexer na matriz existente.** Explicitamente fora: o José circulou a tabela
  pra apontá-la como referência, e pediu a nova **abaixo** dela.
- **Perda em R$.** Foi oferecido e não escolhido; exigiria uma fonte de valor
  por OS que não se confirmou existir.
- **Exportar a tabela nova pro XLSX.** Não pedido. Se vier, o
  `_agruparPerdaPorRegional` já entrega a estrutura pronta.
- **Corte de amostra mínima.** Ver §4.3 — decisão consciente.
