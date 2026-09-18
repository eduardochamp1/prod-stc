# SPEC — Importar equipes oficiais de planilha (com prévia) + busca na lista

> Data: 2026-09-17 · Status: **implementado** em 18/09/2026 — falta confirmar
> em produção. Ver P2-51 no BACKLOG e `PLANO-import-equipes-2026-09-17.md`.
>
> Incremento **1 de 2** do trabalho de otimizar o cadastro de equipes no Admin.
> O incremento 2 (tabela editável no lugar da lista) tem spec própria e vem
> depois — ver §11.

## 1. O problema

Reportado pelo José em 17/09/2026: *"adicionei equipes novas mas foi um processo
bem complicado"*. Quando perguntado o que pesou, apontou dois atritos:

1. **Uma de cada vez.** A lista de equipes novas chega em **planilha**, com
   sigla, tipo e placa. O cadastro só aceita uma equipe por vez.
2. **Achar equipe na lista.** 138 equipes numa caixa com scroll, sem busca.

As duas outras hipóteses que levantei — não saber o que preencher, e o bug do
setor `DSSJ` — ele **não** marcou. O `DSSJ` entra mesmo assim (§5.3), porque o
lote precisa de um seletor de setor e o defeito está no caminho.

## 2. O que existe hoje

- **Tela:** `public/index.html:866` — bloco "Equipes Oficiais" no modal Admin.
  Dois botões (`↻ Listar`, `+ Nova`), uma tabela e um formulário.
- **Formulário:** `_renderEquipeForm` (`public/index.html:9478`) — 7 campos
  (sigla, setor, regional, tipo, placa, escala início/fim).
- **Ao salvar:** `salvarEquipe` (`public/index.html:9549`) faz
  `document.getElementById('eq-form').style.display = 'none'` e recarrega a
  tabela inteira. **O formulário some a cada gravação.** Cadastrar 10 equipes são
  10 ciclos de: achar o botão `+ Nova` → preencher 7 campos → salvar → o form
  desaparece → repetir. É a causa mecânica do atrito 1.
- **Tabela:** `renderEquipesTabela` (`public/index.html:9424`) despeja todas as
  linhas. Sem busca, sem filtro. É o atrito 2.
- **Rotas:** `POST /admin/equipes` (`routes/index.js:2005`),
  `PUT /admin/equipes/:sigla` (`routes/index.js:2042`),
  `DELETE` soft (`routes/index.js:2159`). Todas de uma equipe por vez.
- **Validação:** `_validateEquipe` + `_RE_*` em `routes/index.js:1856-1876`.
- **Schema:** `equipes_oficiais` — PK `sigla`; `tipo` é `NOT NULL`; `setor` tem
  CHECK `DESG|DEPT|DESC|DSSJ`; `regional` tem CHECK `GUA|CAC|SJC`.

### 2.1 Duas verificações que mudaram o desenho

**Não existe transação no pgShim.** Nenhum `BEGIN`/`COMMIT`/`ROLLBACK`, nenhum
`pool.connect()` — tudo passa por `pool.query()` no pool, com auto-commit por
statement. É por isso que o **P1-11** (`consolidateDay` transacional) segue
pendente. Prometer "grava numa transação" exigiria mexer num componente
compartilhado, o que está fora do escopo deste item.

**E não é preciso.** A PK é `sigla`, e o `upsert()` do pgShim monta **um único**
`INSERT … VALUES (…),(…),(…) ON CONFLICT (sigla) DO UPDATE` (ver `_build()` em
`services/pgShim.js:262`, com o `ON CONFLICT` montado na linha 311 — o statement
é um só porque `_payload` é o array inteiro de linhas, não uma por chamada).
Um statement só é atômico por definição no Postgres:
o lote inteiro entra ou nada entra. Também satisfaz a regra de idempotência do
projeto — reexecutar o mesmo lote não duplica.

**O `xlsx.full.min.js` vendorizado lê, não só escreve.** `sheet_to_json` está
presente no bundle (`public/vendor/xlsx.full.min.js`, 951 KB, vendorizado em
07/07 para o export). Nenhuma dependência nova, nenhum CDN — o Fortinet não é
obstáculo aqui.

## 3. Decisões de desenho

### 3.1 A importação NUNCA desativa equipe

Se uma sigla está no cadastro e **não** veio na planilha, o plano a ignora. Não
propõe desativar, não marca como órfã.

Motivo: o **P2-20** registra que a leitura do histórico depende da whitelist de
**hoje** — desativar uma equipe apaga produção **já reportada à EDP**. Planilha
chega incompleta; é da natureza dela. Uma importação que desativasse o ausente
apagaria meses de número num clique, e o erro só apareceria numa auditoria.

Desativar continua sendo o que é hoje: ação deliberada, uma equipe por vez, com
`confirm()`.

### 3.2 Linha inválida não derruba o lote

Cada linha ruim vai para `erros[]` com o número da linha **do Excel** e o motivo;
as válidas seguem. O botão declara o que fará: *"Gravar 38 equipes — 2 linhas com
erro serão ignoradas"*.

Bloquear tudo por um erro de digitação significa que uma planilha de 40 linhas
nunca entra. Ignorar em silêncio significa equipe faltando que só reaparece
semanas depois como produção sumida. O meio-termo honesto é gravar o que dá e
dizer alto o que ficou de fora.

### 3.3 Equipe inativa que reaparece na planilha: nunca reativa sozinha

Caso real: uma equipe foi desativada e volta a operar, então reaparece na
planilha. O `ativo` **não** entra no upsert por padrão — linhas novas pegam o
`DEFAULT true` do schema, e linhas existentes mantêm o valor que já tinham.

Mas ficar inativa em silêncio também surpreende: o José importa 40 equipes, e 3
delas continuam fora dos cálculos sem nada avisar. Então o plano ganha uma
categoria própria — *"3 siglas da planilha estão INATIVAS no cadastro"* — com um
checkbox **"reativar essas 3"**, desmarcado por padrão. Marcado, o `ativo: true`
entra no upsert só para essas linhas.

Conservador por padrão e explícito nos dois sentidos, porque reativar **também**
mexe em número reportado: pelo P2-20, a leitura do histórico usa a whitelist de
hoje, então reativar faz produção antiga voltar a contar. Isso pode ser
exatamente o desejado — mas é decisão, não efeito colateral.

### 3.4 O julgamento é do servidor; o browser só lê bytes

O `index.html` extrai a matriz de células e manda. Toda normalização, validação
e diff acontece numa função pura no servidor, onde é testável sem DOM. É o
padrão do `bucketMath` (P2-2) aplicado aqui.

### 3.5 Uma porta, duas fases

O mesmo endpoint serve prévia e gravação, distinguidas por `dryRun`. Assim a
validação existe **uma vez**. Quando o incremento 2 chegar, "salvar as 6 células
que editei" é uma chamada para essa mesma porta.

## 4. Arquitetura

### 4.1 `services/equipesImport.js` — novo, puro

```
montarPlano(linhas, equipesAtuais, { regional, setor, tipoPadrao, reativar })
  → { novas[], alteradas[], identicas: n, inativas[], erros[] }
```

Sem banco, sem DOM, sem rede. Entrada e saída são dados.

- `linhas` — `[{ linhaPlanilha, sigla, tipo, placa }]`, cru, como veio do arquivo
- `equipesAtuais` — o que `GET /admin/equipes` já devolve
- `novas[]` — `{ linhaPlanilha, sigla, setor, regional, tipo, placa }`
- `alteradas[]` — `{ linhaPlanilha, sigla, mudancas: [{ campo, de, para }] }`,
  contendo **só** os campos que mudam
- `identicas` — contagem; listar 90 linhas que não mudam nada é ruído
- `inativas[]` — `{ linhaPlanilha, sigla }` das siglas da planilha que existem no
  cadastro com `ativo: false` (§3.3). Com `reativar: true`, essas linhas passam a
  carregar `ativo: true` no upsert; com `false` (o padrão), o campo `ativo` não
  entra no payload e o valor atual é preservado
- `erros[]` — `{ linhaPlanilha, siglaCrua, campo, valor, motivo }`

Para este módulo migram também `_RE_SIGLA`, `_RE_TIPO`, `_RE_PLACA`, `_RE_REG`,
`_RE_SETOR` e `_validateEquipe`, hoje em `routes/index.js:1856`. A rota passa a
importá-los. Sem isso haveria duas cópias das regras de validação, contra a regra
de fonte única do projeto. O POST e o PUT de equipe única mantêm comportamento
**idêntico** — é movimentação, não mudança.

### 4.2 `POST /api/admin/equipes/importar` — nova rota

Sob o `router.use('/admin', requireAdmin)` que já existe.

```
{ dryRun: boolean, regional, setor, tipoPadrao, reativar: boolean, linhas: [...] }
```

- Carrega o cadastro atual, chama `montarPlano`
- `dryRun: true` → devolve o plano e **para**
- `dryRun: false` → recalcula o plano (não confia no cliente), aplica o `upsert`
  único com `onConflict: 'sigla'`, chama `forceRefresh()` do cache em memória
  (como o POST atual já faz), e devolve as contagens do que realmente entrou

O recálculo no apply não é paranoia: o cliente pode mandar qualquer coisa, e a
validação tem de estar do lado que grava.

**Teto de tamanho:** 500 linhas por lote. O cadastro tem 138 equipes; um arquivo
com milhares de linhas é engano, não uso. Acima disso a rota recusa com mensagem
explícita, antes de montar SQL.

### 4.3 Frontend — `public/index.html`

Bloco novo dentro de "Equipes Oficiais", recolhido por padrão:
`<input type="file" accept=".xlsx,.xls,.csv">`. Ao escolher o arquivo:
`XLSX.read` → `sheet_to_json(ws, { header: 1 })` → detecção de cabeçalho (§5.1)
→ POST com `dryRun: true` → renderiza o plano (§7).

## 5. Entrada: formato e mapeamento

### 5.1 Achar o cabeçalho

`sheet_to_json(ws, { header: 1 })` devolve matriz de células cruas. Varre as
**primeiras 10 linhas** procurando a que tenha alguma célula batendo com um
sinônimo de sigla. Absorve planilha com título, logo ou linha em branco antes da
tabela — que é o formato normal de planilha corporativa.

### 5.2 Sinônimos (normalizando: minúscula, sem acento, sem espaço)

| Campo | Aceita |
|---|---|
| sigla | `sigla`, `equipe`, `time`, `turma`, `cod`, `codigo` |
| tipo | `tipo`, `tiposervico`, `servico`, `atividade` |
| placa | `placa`, `veiculo`, `carro` |

A detecção é **chute educado**, e aparece na prévia com um `<select>` por campo
listando as colunas reais do arquivo, para você confirmar ou corrigir. Se a
`sigla` não for identificada, nada avança até você apontar a coluna.

### 5.3 Os três campos do lote

Escolhidos uma vez, valendo para todas as linhas, porque a planilha não os traz:

- **regional** — GUA / CAC / SJC
- **setor** — DESG / DEPT / DESC / **DSSJ**
- **tipo padrão** — **obrigatório**, usado quando a planilha não tem coluna de
  tipo ou a célula vem vazia. É obrigatório porque `tipo` é `NOT NULL` no
  schema: sem ele, uma célula vazia não teria para onde cair e a linha viraria
  erro por um motivo que o usuário não causou. A prévia não é gerada enquanto
  ele estiver em branco

O `<select>` de setor da tela atual oferece só DESG/DEPT/DESC
(`public/index.html:9492`), e o `_setorChanged()` joga tudo que não é DESC para
GUA — então **cadastrar equipe de SJC pela tela não funciona hoje**, apesar de o
banco e o `_validateEquipe` aceitarem. O seletor novo nasce com DSSJ, e o
seletor do formulário de equipe única é corrigido junto, já que é a mesma falha e
está no caminho.

### 5.4 Normalização

- `sigla`, `tipo` — `trim()` + maiúsculas
- `placa` — `trim()` + maiúsculas; vazia vira `null`
- Linha inteiramente vazia é **descartada sem virar erro** — planilha tem linha
  em branco no fim, e isso não é problema do usuário
- `escala_inicio` / `escala_fim` não entram na importação; seguem no formulário
  de equipe única

## 6. Erros: apontar QUAL linha

Exigência explícita do José em 17/09: *"tem que indicar quais linhas estão
erradas"*.

### 6.1 O número é o do Excel

Ao ler, o parser guarda o índice real de cada linha a partir do range da
planilha (`XLSX.utils.decode_range`), **não** a posição no array. Se a tabela
começa na linha 4 porque tem título e logo em cima, o erro diz "linha 7" e o
José abre o arquivo e vai direto na linha 7.

Um número que não bate com o arquivo é pior que nenhum número: manda procurar no
lugar errado.

### 6.2 Mostra o valor lido

O motivo sozinho ("sigla inválida") obriga a conferir a planilha inteira. Com o
valor cru ao lado, o espaço sobrando ou o dígito faltando aparece na hora.

### 6.3 Sigla repetida no próprio arquivo é erro, e aponta as duas linhas

Não é preciosismo. O `services/dataWriter.js:89` documenta que o Postgres aborta
o upsert inteiro com *"ON CONFLICT DO UPDATE command cannot affect row a second
time"*. Deixar passar mataria o lote de 40 linhas por causa de 2, com uma
mensagem que não explica nada. O plano pega antes.

"Repetida" sem dizer repetida **de onde** obriga a caçar a outra ocorrência — por
isso a mensagem cita a linha anterior.

### 6.4 Forma da tabela

| Linha | Sigla | Campo | Valor lido | Problema |
|---|---|---|---|---|
| 7 | `EBGPR6` | sigla | `EBGPR6` | sigla tem 6 caracteres (mínimo 4, máximo 12) |
| 12 | `ECGPR51` | — | — | sigla repetida: já aparece na linha 9 desta planilha |
| 19 | `EMGPR70` | placa | `ABC-1` | placa tem 5 caracteres (mínimo 4) |

Vai **acima** das listas de sucesso, não no rodapé.

## 7. A prévia

De cima para baixo:

1. **Mapeamento de colunas** + os três campos do lote — editáveis, para corrigir
   e re-processar **sem escolher o arquivo de novo**
2. **Erros** (§6), se houver
3. **Novas** — tabela do que será criado
4. **Alteradas** — uma linha por equipe, só os campos que mudam, no formato
   `tipo: COMERCIAL → RAMAL`
5. **Inativas** (§3.3) — as siglas da planilha que estão desativadas no cadastro,
   com o checkbox **"reativar essas N"** desmarcado. Marcar re-gera o plano
6. **Idênticas** — só a contagem

O botão de gravar fica **desabilitado até o plano existir**, e o rótulo declara a
ação: *"Gravar 38 equipes — 2 linhas com erro serão ignoradas"*. Depois de
gravar, a resposta traz as contagens do que entrou e a lista recarrega.

## 8. Busca e filtro na lista

Independente do resto e entregável sozinho.

- Campo de texto filtrando por **sigla ou placa**, conforme digita
- **Regional** — Todas / GUA / CAC / SJC
- **Situação** — Todas / Ativas / Inativas
- Contador reflete o filtro: *"12 de 138 equipes"*

Tudo no cliente, sobre a lista que o `GET /admin/equipes` já traz inteira. Sem
ida ao servidor a cada tecla.

## 9. Testes

O módulo puro carrega o peso — é o que permite testar exaustivamente sem banco
nem browser.

**`test/equipesImport.test.js`** — sobre `montarPlano`:
- sigla nova → `novas`
- sigla existente com tipo/placa iguais → `identicas`, não `alteradas`
- sigla existente com placa diferente → `alteradas`, com **só** o campo placa em
  `mudancas`
- equipe no cadastro e ausente da planilha → **não aparece em lugar nenhum**
  (trava a §3.1 — é o teste que protege produção já reportada)
- sigla inativa presente na planilha, `reativar: false` → cai em `inativas`, e o
  payload do upsert **não** contém a chave `ativo` (trava a §3.3)
- a mesma, com `reativar: true` → o payload carrega `ativo: true` **só** para
  essas linhas, não para o lote inteiro
- sigla repetida no arquivo → erro nas duas linhas, citando a primeira
- sigla/tipo/placa inválidos → erro com `linhaPlanilha`, `valor` e motivo
- linha vazia → descartada, sem erro
- célula de tipo vazia → usa `tipoPadrao`
- normalização: minúsculas e espaços viram maiúsculas sem borda
- lote com erro **e** linhas boas → as boas seguem em `novas`/`alteradas`
- acima de 500 linhas → recusa

**`test/equipesImportRota.test.js`** — sobre a rota:
- sem auth → 401; com auth não-admin → 403
- `dryRun: true` **não** grava (conferido relendo o cadastro)
- `dryRun: false` grava e devolve contagens
- o apply **recalcula** o plano, ignorando o que o cliente mandou como plano
- payload malformado → 400 com mensagem, não 500

**Contrato do SQL** — que o apply monta **um** `INSERT … ON CONFLICT (sigla)`,
não N statements. É o que sustenta a atomicidade da §2.1; se alguém trocar por
um laço de inserts, o lote deixa de ser tudo-ou-nada em silêncio. Testável com
o pool fake do `test/pgShim.test.js`.

**Front** — no estilo do `test/heTela.test.js` e do `test/healthCardErro.test.js`:
as funções de detecção de cabeçalho e de filtro da lista são puras, então são
extraídas do `index.html` e **executadas**. Limite explícito: isso não prova que
a tela renderiza nem que o Excel abre.

## 10. Rollback

`git revert`. As três peças são independentes e devem ir em commits separados:

1. módulo puro + extração dos `_RE_*` (sem efeito visível sozinho)
2. rota de importação
3. front: bloco de importação, busca/filtro e o `DSSJ` nos dois seletores

Reverter o 3 devolve a tela ao estado atual mantendo o backend novo inerte —
nenhuma rota nova é chamada por ninguém. Nada aqui altera schema, cron ou
caminho de leitura de produção.

## 11. Fora de escopo

- **Tabela editável no lugar (incremento 2).** Spec própria. Herdará a gravação
  em lote desta, já testada.
- **Colar da planilha (TSV).** Descartada pelo José em favor do upload. Se
  voltar, é só outra origem para a mesma matriz de células — o resto do fluxo
  não muda.
- **Desativar em lote.** Ver §3.1.
- **Escala início/fim na importação.** Ver §5.4.
- **Validar a sigla contra o que a EDP conhece.** É o **P2-47** (10 equipes da
  whitelist não existem na escala do SGE) e merece item próprio: exige decidir o
  que fazer quando a planilha e a EDP discordam, que é pergunta de negócio, não
  de tela.
- **Transação de verdade no pgShim.** É o P1-11. A §2.1 mostra por que esta
  entrega não precisa dela.
