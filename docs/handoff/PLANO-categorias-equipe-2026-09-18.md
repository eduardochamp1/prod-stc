# Categorias de Equipe — Plano de Implementação

> **EXECUTADO em 18/09/2026.** As 5 tarefas foram concluídas em TDD. Suíte ao
> fim: **1155 testes, 0 falhas**.
>
> | Tarefa | Commit |
> |---|---|
> | 1 — catálogo e funções puras | `d4994f9` |
> | 2 — backend usa o catálogo | `8fc05af` |
> | 3 — catálogo espelhado + teste de acordo | `4cae22b` |
> | 4 — front usa o catálogo, filtro multi | `b10b74e` |
> | 5 — backlog e spec | (este commit) |
>
> **Três coisas que a execução revelou:**
>
> 1. **Um teste existente ficou vermelho, e estava certo.**
>    `equipeTipoMatrix.test.js` afirmava `ETGPR15 → OPERACIONAL`, o que era
>    verdade antes deste trabalho. Não era regressão: era a cobertura provando
>    que é real. A expectativa foi atualizada com o porquê, e ganhou um caso
>    `EXGPR99` provando que o balde genérico sobrevive.
> 2. **O teste-guarda do colapso pegou uma segunda ocorrência do padrão — que
>    era o próprio comentário citando o código antigo.** O comentário passou a
>    DESCREVER em vez de CITAR, e diz por que está assim.
> 3. **O teste de acordo foi verificado vermelho de propósito**, trocando
>    'Equipe Moto' por 'Equipe Motocicleta' num lado só. A mensagem aponta
>    índice, chave, campo e os dois valores.
>
> Os aceites de **produção** seguem em aberto — ver P2-53 no BACKLOG.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nomear `ET` como "Equipe Moto" e `EB` como "BT Zero", tirando a regra de classificação dos 9 ternários espalhados e pondo num catálogo único por runtime — e fazer o filtro multi de tipo funcionar de verdade, porque com 4 categorias ele passa a mentir.

**Architecture:** Um módulo puro no backend (`services/categoriasEquipe.js`) e uma constante espelhada no `index.html`, com um teste que compara as duas campo a campo. Os 9 sítios passam a ler do catálogo. O parâmetro `tipo` da API passa a aceitar CSV.

**Tech Stack:** Node 24, Express 4, JavaScript vanilla no monólito `public/index.html`, `node --test`.

**Spec:** `docs/handoff/SPEC-categorias-equipe-2026-09-18.md`

---

## Contexto que o executor precisa saber

**1. A categoria NÃO é persistida.** É derivada do prefixo da sigla na leitura.
Consequência boa: as ET e EB aparecem classificadas no histórico inteiro assim
que subir, sem backfill. Consequência a respeitar: não existe migration aqui, e
nenhum número já reportado à EDP muda.

**2. Há DUAS classificações com nomes parecidos.** `equipes_oficiais.tipo`
(BTZERO, CS, CORTE L0, COMERCIAL…) é o tipo operacional do cadastro, editável
no Admin — **não se mexe nele**. `tipo_equipe` é o derivado do prefixo, que é o
deste plano. É por isso que a chave do EB é `BT_ZERO` com underline: sem ele,
`grep BTZERO` mistura os dois conceitos.

**3. O teste de acordo entre as duas cópias é a peça central.** Sem ele,
"catálogo único" vira dois catálogos parecidos — pior que os 9 ternários,
porque parece seguro. Ele é a Task 3.

**4. Chaves que viajam na URL não podem ser renomeadas.** `COMERCIAL` e
`PLANTAO` vão em `?tipo=`; trocar quebra link e favorito existentes.

**5. Limite conhecido da cobertura.** O spec (§7) pede teste de contrato da
rota — `?tipo=COMERCIAL,MOTO` filtrando pelas duas. Os testes deste plano
exercitam isso na **função** (`_buildEquipeTipoMatrix` recebendo a string CSV),
não por HTTP: a rota precisa de banco, e a suíte roda em `DATA_MODE=mock`, onde
ela responde 503 antes de chegar na lógica. A rota só repassa `req.query.tipo`
sem tocar, então o risco residual é baixo — mas está aqui escrito em vez de
fingir que a cobertura é ponta a ponta. A verificação na VM (última seção)
fecha essa lacuna.

**Como rodar:** `node --test`. O hook `pre-push` bloqueia push com teste
vermelho.

**Commits:** convenção do `CLAUDE.md`, terminando com
`Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `services/categoriasEquipe.js` **(novo)** | O catálogo e as funções derivadas. Puro. |
| `db/queries.js` **(modificar)** | 4 sítios passam a usar o módulo. |
| `public/index.html` **(modificar)** | Catálogo espelhado, 5 sítios, e o envio em CSV. |
| `public/css/app.css` **(modificar)** | Badges e cores de barra para ET e EB. |
| `test/categoriasEquipe.test.js` **(novo)** | O módulo, o acordo entre cópias, e o filtro. |
| `docs/handoff/BACKLOG.md` **(modificar)** | Item P2-53. |

---

## Task 1: O catálogo e as funções puras

**Files:**
- Create: `services/categoriasEquipe.js`
- Test: `test/categoriasEquipe.test.js` (criar)

- [ ] **Step 1: Escrever o teste que falha**

Crie `test/categoriasEquipe.test.js`:

```js
/**
 * test/categoriasEquipe.test.js
 *
 * Catálogo de categorias de equipe (derivadas do PREFIXO da sigla) e o filtro
 * multi que a API passou a aceitar.
 *
 * ⚠️ Não confundir com `equipes_oficiais.tipo` — o tipo operacional do
 * cadastro (BTZERO, CS, CORTE L0…), editável no Admin. É outra dimensão. Por
 * isso a chave do prefixo EB aqui é `BT_ZERO`, com underline.
 *
 * Spec: docs/handoff/SPEC-categorias-equipe-2026-09-18.md
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const {
  CATEGORIAS, OPERACIONAL,
  categoriaDaSigla, prefixoDaCategoria, filtroDeCategorias,
} = require('../services/categoriasEquipe');

// ─────────────────────────────────────────────────────────────────────────────
// categoriaDaSigla — o prefixo manda
// ─────────────────────────────────────────────────────────────────────────────

test('classifica os quatro prefixos conhecidos', () => {
  assert.equal(categoriaDaSigla('ECGPR53'), 'COMERCIAL');
  assert.equal(categoriaDaSigla('EPGPR01'), 'PLANTAO');
  assert.equal(categoriaDaSigla('ETGPR15'), 'MOTO');
  assert.equal(categoriaDaSigla('EBGPR62'), 'BT_ZERO');
});

test('prefixo desconhecido cai em OPERACIONAL', () => {
  assert.equal(categoriaDaSigla('EXGPR99'), 'OPERACIONAL');
  assert.equal(categoriaDaSigla('ZZZZ01'),  'OPERACIONAL');
});

test('a comparação ignora a caixa', () => {
  assert.equal(categoriaDaSigla('etgpr15'), 'MOTO');
  assert.equal(categoriaDaSigla('eBgPr62'), 'BT_ZERO');
});

test('sigla vazia, null ou undefined não estoura', () => {
  assert.equal(categoriaDaSigla(''),        'OPERACIONAL');
  assert.equal(categoriaDaSigla(null),      'OPERACIONAL');
  assert.equal(categoriaDaSigla(undefined), 'OPERACIONAL');
});

// ─────────────────────────────────────────────────────────────────────────────
// prefixoDaCategoria — o caminho inverso
// ─────────────────────────────────────────────────────────────────────────────

test('devolve o prefixo de cada categoria nomeada', () => {
  assert.equal(prefixoDaCategoria('COMERCIAL'), 'EC');
  assert.equal(prefixoDaCategoria('PLANTAO'),   'EP');
  assert.equal(prefixoDaCategoria('MOTO'),      'ET');
  assert.equal(prefixoDaCategoria('BT_ZERO'),   'EB');
});

test('OPERACIONAL não tem prefixo próprio — é o complemento', () => {
  assert.equal(prefixoDaCategoria('OPERACIONAL'), null);
});

test('chave desconhecida devolve null', () => {
  assert.equal(prefixoDaCategoria('INVENTADA'), null);
  assert.equal(prefixoDaCategoria(null),        null);
});

// ─────────────────────────────────────────────────────────────────────────────
// O catálogo em si
// ─────────────────────────────────────────────────────────────────────────────

test('o catálogo tem os cinco campos em toda entrada', () => {
  CATEGORIAS.forEach(c => {
    ['prefixo', 'chave', 'rotulo', 'badge', 'cssBarra'].forEach(campo =>
      assert.ok(c[campo], `categoria ${c.chave} sem o campo ${campo}`));
  });
  assert.ok(OPERACIONAL.chave && OPERACIONAL.badge && OPERACIONAL.cssBarra);
});

test('as chaves que viajam na URL não mudaram', () => {
  // ?tipo=COMERCIAL está em link e favorito de gente. Renomear quebra sem ganho.
  const chaves = CATEGORIAS.map(c => c.chave);
  assert.ok(chaves.includes('COMERCIAL'));
  assert.ok(chaves.includes('PLANTAO'));
});

// ─────────────────────────────────────────────────────────────────────────────
// filtroDeCategorias — o multi que a API passou a aceitar
// ─────────────────────────────────────────────────────────────────────────────

test('duas categorias: aceita as duas, recusa as outras', () => {
  const passa = filtroDeCategorias(['COMERCIAL', 'MOTO']);
  assert.equal(passa('ECGPR53'), true);
  assert.equal(passa('ETGPR15'), true);
  assert.equal(passa('EPGPR01'), false);
  assert.equal(passa('EBGPR62'), false);
});

test('aceita CSV além de array — é o que vem na query string', () => {
  const passa = filtroDeCategorias('COMERCIAL, MOTO');
  assert.equal(passa('ECGPR53'), true);
  assert.equal(passa('EPGPR01'), false);
});

test('TODAS, vazio, null e undefined não filtram nada', () => {
  [['TODAS'], 'TODAS', [], '', null, undefined].forEach(entrada => {
    const passa = filtroDeCategorias(entrada);
    assert.equal(passa('ECGPR53'), true, `entrada ${JSON.stringify(entrada)}`);
    assert.equal(passa('EXGPR99'), true, `entrada ${JSON.stringify(entrada)}`);
  });
});

test('TODAS vence quando vem junto de outra', () => {
  const passa = filtroDeCategorias(['COMERCIAL', 'TODAS']);
  assert.equal(passa('EPGPR01'), true);
});

test('OPERACIONAL aceita só o que NÃO casa com prefixo do catálogo', () => {
  // Sem esta opção, equipe de prefixo novo ficaria inalcançável por filtro:
  // visível só em "Todas". Este projeto já tem histórico demais de dado que
  // some sem avisar (P1-39, P2-19).
  const passa = filtroDeCategorias(['OPERACIONAL']);
  assert.equal(passa('EXGPR99'), true);
  assert.equal(passa('ECGPR53'), false);
  assert.equal(passa('ETGPR15'), false);
});

test('chave inventada não deixa passar tudo por engano', () => {
  const passa = filtroDeCategorias(['NAOEXISTE']);
  assert.equal(passa('ECGPR53'), false);
  assert.equal(passa('EXGPR99'), false);
});
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `node --test test/categoriasEquipe.test.js`
Expected: FAIL — `Cannot find module '../services/categoriasEquipe'`

- [ ] **Step 3: Criar o módulo**

Crie `services/categoriasEquipe.js`:

```js
/**
 * services/categoriasEquipe.js
 *
 * Catálogo das categorias de equipe, derivadas do PREFIXO da sigla.
 *
 * Antes de 18/09/2026 esta regra vivia em 9 ternários encadeados espalhados
 * (4 em db/queries.js, 5 em public/index.html). Acrescentar as categorias
 * `ET` (Equipe Moto) e `EB` (BT Zero) seriam 18 edições manuais, e o modo de
 * errar era silencioso: esquecer um sítio de badge faz a mesma equipe aparecer
 * como "Equipe Moto" numa tabela e "OP" em outra.
 *
 * ⚠️ NÃO confundir com `equipes_oficiais.tipo` — o tipo OPERACIONAL do
 * cadastro (BTZERO, CS, CORTE L0, COMERCIAL…), editável no Admin. É outra
 * dimensão, e não se mexe nela por aqui. Por isso a chave do prefixo `EB` é
 * `BT_ZERO`, com underline: sem ele, um `grep BTZERO` daqui a seis meses acha
 * os dois conceitos misturados e conclui a coisa errada.
 *
 * ⚠️ Existe uma CÓPIA desta lista em public/index.html (dois runtimes, sem
 * bundler). `test/categoriasEquipe.test.js` compara as duas campo a campo —
 * se divergirem, a suíte fica vermelha antes do push.
 *
 * Nada aqui é persistido: a categoria é calculada na leitura, então vale
 * retroativamente para todo o histórico, sem backfill.
 *
 * Spec: docs/handoff/SPEC-categorias-equipe-2026-09-18.md
 */

'use strict';

/**
 * As categorias nomeadas, na ordem em que aparecem no filtro.
 *
 * `COMERCIAL` e `PLANTAO` mantêm as chaves antigas de propósito: elas viajam
 * na URL (`?tipo=COMERCIAL`) e renomeá-las quebraria link e favorito
 * existentes, sem ganho nenhum.
 */
const CATEGORIAS = [
  { prefixo: 'EC', chave: 'COMERCIAL', rotulo: 'Comercial',   badge: 'EC', cssBarra: 'tipo-comercial' },
  { prefixo: 'EP', chave: 'PLANTAO',   rotulo: 'Plantão',     badge: 'EP', cssBarra: 'tipo-plantao'   },
  { prefixo: 'ET', chave: 'MOTO',      rotulo: 'Equipe Moto', badge: 'ET', cssBarra: 'tipo-moto'      },
  { prefixo: 'EB', chave: 'BT_ZERO',   rotulo: 'BT Zero',     badge: 'EB', cssBarra: 'tipo-bt-zero'   },
];

/** O complemento: toda sigla que não casa com nenhum prefixo acima. */
const OPERACIONAL = {
  prefixo: null, chave: 'OPERACIONAL', rotulo: 'Operacional',
  badge: 'OP', cssBarra: 'tipo-operacional',
};

/** Sentinela de "sem filtro" — o que o front manda quando nada está marcado. */
const TODAS = 'TODAS';

/** Sigla → chave da categoria. Nunca estoura; o que não casa vira OPERACIONAL. */
function categoriaDaSigla(sigla) {
  const u = String(sigla === null || sigla === undefined ? '' : sigla).toUpperCase();
  const achada = CATEGORIAS.find(c => u.startsWith(c.prefixo));
  return achada ? achada.chave : OPERACIONAL.chave;
}

/** Chave → prefixo. OPERACIONAL devolve null: é o complemento, não um prefixo. */
function prefixoDaCategoria(chave) {
  const achada = CATEGORIAS.find(c => c.chave === chave);
  return achada ? achada.prefixo : null;
}

/** Chave → a entrada inteira do catálogo (ou a do OPERACIONAL). */
function categoriaPorChave(chave) {
  return CATEGORIAS.find(c => c.chave === chave) || OPERACIONAL;
}

/**
 * Monta o predicado do filtro multi.
 *
 * Aceita array (`['COMERCIAL','MOTO']`) ou CSV (`'COMERCIAL,MOTO'`) — o
 * segundo é o que chega na query string.
 *
 * Sem seleção, ou com `TODAS` presente, não filtra nada. Antes de 18/09 o
 * front colapsava ≥2 categorias em `TODAS`, o que era inofensivo com duas
 * categorias (marcar as duas = marcar todas) e virou defeito real com quatro.
 *
 * @returns {(sigla: string) => boolean}
 */
function filtroDeCategorias(chaves) {
  const lista = (Array.isArray(chaves) ? chaves : String(chaves === null || chaves === undefined ? '' : chaves).split(','))
    .map(s => String(s === null || s === undefined ? '' : s).trim().toUpperCase())
    .filter(Boolean);

  if (lista.length === 0 || lista.includes(TODAS)) return () => true;

  const prefixos = lista.map(prefixoDaCategoria).filter(Boolean);
  const querOperacional = lista.includes(OPERACIONAL.chave);

  return (sigla) => {
    const u = String(sigla === null || sigla === undefined ? '' : sigla).toUpperCase();
    if (prefixos.some(p => u.startsWith(p))) return true;
    if (querOperacional && categoriaDaSigla(u) === OPERACIONAL.chave) return true;
    return false;
  };
}

module.exports = {
  CATEGORIAS, OPERACIONAL, TODAS,
  categoriaDaSigla, prefixoDaCategoria, categoriaPorChave, filtroDeCategorias,
};
```

- [ ] **Step 4: Rodar e verificar que passa**

Run: `node --test test/categoriasEquipe.test.js`
Expected: PASS — 15 testes

- [ ] **Step 5: Commit**

```bash
git add services/categoriasEquipe.js test/categoriasEquipe.test.js
git commit -m "feat(categorias): catalogo unico de categorias de equipe

  A classificacao por prefixo da sigla vivia em 9 ternarios encadeados
  espalhados. Acrescentar ET (Equipe Moto) e EB (BT Zero) seriam 18 edicoes
  manuais, e o modo de errar era silencioso.

  Modulo puro, sem I/O. Inclui o filtroDeCategorias, que aceita array ou CSV e
  resolve o caso negativo do OPERACIONAL (o que nao casa com nenhum prefixo).

  A chave do EB e BT_ZERO com underline de proposito: existe um tipo 'BTZERO'
  no cadastro de equipes que e outra dimensao, e sem o underline um grep acha
  os dois conceitos misturados.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Backend passa a usar o catálogo

**Files:**
- Modify: `db/queries.js:1269-1280` (`getPerformanceEquipes`)
- Modify: `db/queries.js:1323-1333` (`_buildEquipeTipoMatrix`)
- Modify: `routes/index.js:693` (comentário de contrato)
- Test: `test/categoriasEquipe.test.js`

- [ ] **Step 1: Escrever o teste que falha**

Acrescente ao fim de `test/categoriasEquipe.test.js`:

```js
// ─────────────────────────────────────────────────────────────────────────────
// O backend usa o catálogo — nada de ternário sobrevivendo
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('node:fs');
const path = require('node:path');

const QUERIES = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'queries.js'), 'utf8');

test('db/queries.js não tem mais startsWith de prefixo solto', () => {
  // Era a duplicacao que este trabalho eliminou. Se voltar, o catálogo deixou
  // de ser único sem ninguém perceber.
  assert.ok(!/startsWith\(['"]E[CPTB]['"]\)/.test(QUERIES),
    'voltou um startsWith de prefixo hard-coded em db/queries.js');
});

test('db/queries.js importa o catálogo', () => {
  assert.ok(QUERIES.includes("require('../services/categoriasEquipe')"),
    'db/queries.js tem de ler do módulo, não reimplementar');
});

test('_buildEquipeTipoMatrix classifica ET e EB', () => {
  const { _buildEquipeTipoMatrix } = require('../db/queries');
  const { equipes } = _buildEquipeTipoMatrix([
    { team_name: 'ETGPR15', regional: 'GUA', sector_id: 'DESG', tipo_code: 'DL', count: 5 },
    { team_name: 'EBGPR62', regional: 'GUA', sector_id: 'DESG', tipo_code: 'LN', count: 3 },
  ], [], 'TODAS');

  const porNome = Object.fromEntries(equipes.map(e => [e.team_name, e.tipo_equipe]));
  assert.equal(porNome.ETGPR15, 'MOTO');
  assert.equal(porNome.EBGPR62, 'BT_ZERO');
});

test('_buildEquipeTipoMatrix filtra por DUAS categorias', () => {
  // O ganho concreto do filtro multi: antes, pedir duas devolvia todas.
  const { _buildEquipeTipoMatrix } = require('../db/queries');
  const rows = [
    { team_name: 'ECGPR53', regional: 'GUA', sector_id: 'DESG', tipo_code: 'LN', count: 1 },
    { team_name: 'EPGPR01', regional: 'GUA', sector_id: 'DESG', tipo_code: 'LN', count: 1 },
    { team_name: 'ETGPR15', regional: 'GUA', sector_id: 'DESG', tipo_code: 'LN', count: 1 },
  ];
  const { equipes } = _buildEquipeTipoMatrix(rows, [], 'COMERCIAL,MOTO');

  assert.deepEqual(equipes.map(e => e.team_name).sort(), ['ECGPR53', 'ETGPR15']);
});

test('_buildEquipeTipoMatrix com TODAS continua devolvendo tudo', () => {
  const { _buildEquipeTipoMatrix } = require('../db/queries');
  const rows = [
    { team_name: 'ECGPR53', regional: 'GUA', sector_id: 'DESG', tipo_code: 'LN', count: 1 },
    { team_name: 'EPGPR01', regional: 'GUA', sector_id: 'DESG', tipo_code: 'LN', count: 1 },
  ];
  const { equipes } = _buildEquipeTipoMatrix(rows, [], 'TODAS');
  assert.equal(equipes.length, 2);
});
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `node --test test/categoriasEquipe.test.js`
Expected: FAIL — os testes de `startsWith`, do `require` e da classificação
ET/EB ficam vermelhos.

Se `_buildEquipeTipoMatrix` não estiver exportado, o `require` falha — o
próximo passo resolve.

- [ ] **Step 3: Importar o catálogo em `db/queries.js`**

No topo de `db/queries.js`, junto dos outros `require`, acrescente:

```js
const { categoriaDaSigla, filtroDeCategorias } = require('../services/categoriasEquipe');
```

- [ ] **Step 4: Substituir o sítio de `getPerformanceEquipes`**

Em `db/queries.js`, localize:

```js
  const teams = {};
  _onlyOficiais(data, 'team_name').forEach(row => {
    const name  = row.team_name;
    const upper = name.toUpperCase();
    if (tipo === 'COMERCIAL' && !upper.startsWith('EC')) return;
    if (tipo === 'PLANTAO'   && !upper.startsWith('EP')) return;
    if (!teams[name]) {
```

Substitua por:

```js
  const teams = {};
  // Categoria vem do catálogo único (services/categoriasEquipe.js) desde
  // 18/09/2026. `tipo` aceita CSV: 'COMERCIAL,MOTO'.
  const passaCategoria = filtroDeCategorias(tipo);
  _onlyOficiais(data, 'team_name').forEach(row => {
    const name  = row.team_name;
    if (!passaCategoria(name)) return;
    if (!teams[name]) {
```

E, logo abaixo, localize:

```js
        tipo_equipe: upper.startsWith('EC') ? 'COMERCIAL'
                   : upper.startsWith('EP') ? 'PLANTAO'
                   : 'OPERACIONAL',
```

Substitua por:

```js
        tipo_equipe: categoriaDaSigla(name),
```

> ⚠️ A variável `upper` era usada só por esses dois trechos. Se o `node --test`
> acusar `upper is not defined` em outro ponto da função, mantenha a linha
> `const upper = name.toUpperCase();`; caso contrário, remova-a.

- [ ] **Step 5: Substituir o sítio de `_buildEquipeTipoMatrix`**

Em `db/queries.js`, localize:

```js
  const teams = {};
  const passaTipo = (name) => {
    const u = String(name).toUpperCase();
    if (tipoEquipe === 'COMERCIAL' && !u.startsWith('EC')) return false;
    if (tipoEquipe === 'PLANTAO'   && !u.startsWith('EP')) return false;
    return true;
  };
```

Substitua por:

```js
  const teams = {};
  // Catálogo único desde 18/09/2026. `tipoEquipe` aceita CSV: 'COMERCIAL,MOTO'.
  const passaTipo = filtroDeCategorias(tipoEquipe);
```

E localize:

```js
        tipo_equipe: u.startsWith('EC') ? 'COMERCIAL' : u.startsWith('EP') ? 'PLANTAO' : 'OPERACIONAL',
```

Substitua por:

```js
        tipo_equipe: categoriaDaSigla(name),
```

> ⚠️ O `const u = String(name).toUpperCase();` dentro de `ensure` também pode
> ficar órfão. Remova-o só se nada mais na função o usar.

- [ ] **Step 6: Exportar `_buildEquipeTipoMatrix` se ainda não estiver**

Confira com `grep -n "_buildEquipeTipoMatrix" db/queries.js`. Se ele não
aparecer no `module.exports`, acrescente-o à lista — o teste da Task 2 o
importa diretamente.

- [ ] **Step 7: Atualizar o comentário de contrato da rota**

Em `routes/index.js`, localize:

```js
// tipo: TODAS | COMERCIAL (EC*) | PLANTAO (EP*)
```

Substitua por:

```js
// tipo: TODAS, ou CSV de categorias — COMERCIAL (EC*), PLANTAO (EP*),
//       MOTO (ET*), BT_ZERO (EB*), OPERACIONAL (o resto).
//       Ex.: ?tipo=COMERCIAL,MOTO  ·  catálogo em services/categoriasEquipe.js
```

- [ ] **Step 8: Rodar e verificar que passa**

Run: `node --test test/categoriasEquipe.test.js`
Expected: PASS — 20 testes

- [ ] **Step 9: Rodar a suíte inteira**

Run: `node --test`
Expected: 0 falhas. Repare especialmente em `test/equipeTipoMatrix.test.js`, que
já cobre a matriz — se ele ficar vermelho, a substituição mudou comportamento
que alguém depende, e isso precisa ser entendido antes de seguir.

- [ ] **Step 10: Commit**

```bash
git add db/queries.js routes/index.js test/categoriasEquipe.test.js
git commit -m "refactor(backend): db/queries le as categorias do catalogo

  Os 4 sitios de ternario encadeado somem. O filtro passa a aceitar CSV, entao
  ?tipo=COMERCIAL,MOTO devolve as duas em vez de devolver todas.

  Ha teste afirmando que nao voltou nenhum startsWith de prefixo hard-coded —
  se voltar, o catalogo deixou de ser unico sem ninguem perceber.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: O catálogo espelhado no front, e o teste de acordo

**Esta é a peça central do desenho.** Sem ela, "catálogo único" vira dois
catálogos parecidos — pior que os 9 ternários, porque parece seguro.

**Files:**
- Modify: `public/index.html` (antes de `function renderGraficosHTML`, ou junto
  das outras constantes de topo do `<script>`)
- Test: `test/categoriasEquipe.test.js`

- [ ] **Step 1: Escrever o teste que falha**

Acrescente ao fim de `test/categoriasEquipe.test.js`:

```js
// ─────────────────────────────────────────────────────────────────────────────
// As duas cópias não podem divergir
// ─────────────────────────────────────────────────────────────────────────────

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** Extrai e executa o literal do catálogo que vive no index.html. */
function catalogoDoFront() {
  const marca = 'const CATEGORIAS_EQUIPE = [';
  const ini = SRC.indexOf(marca);
  assert.ok(ini > -1, `não achei "${marca}" no index.html`);
  const fim = SRC.indexOf('];', ini);
  assert.ok(fim > -1, 'o literal do catálogo não fechou');
  const literal = SRC.slice(ini + marca.length - 1, fim + 1);
  // eslint-disable-next-line no-new-func
  return new Function(`return ${literal};`)();
}

test('o catálogo do front tem as MESMAS entradas do backend, na mesma ordem', () => {
  // Duas cópias existem porque são dois runtimes e o projeto não tem bundler.
  // Este teste é o que impede as duas de divergirem em silêncio: acrescentar
  // uma categoria de um lado só deixa a suíte vermelha antes do push.
  const front = catalogoDoFront();

  assert.equal(front.length, CATEGORIAS.length,
    `front tem ${front.length} categorias e o backend tem ${CATEGORIAS.length}`);

  CATEGORIAS.forEach((back, i) => {
    ['prefixo', 'chave', 'rotulo', 'badge', 'cssBarra'].forEach(campo => {
      assert.equal(front[i][campo], back[campo],
        `categoria ${i} (${back.chave}): campo "${campo}" difere — ` +
        `front="${front[i][campo]}" backend="${back[campo]}"`);
    });
  });
});

test('o front também conhece o OPERACIONAL, com os mesmos rótulo e badge', () => {
  const i = SRC.indexOf('const CATEGORIA_OPERACIONAL');
  assert.ok(i > -1, 'não achei CATEGORIA_OPERACIONAL no index.html');
  const fim = SRC.indexOf('};', i);
  const literal = SRC.slice(SRC.indexOf('{', i), fim + 1);
  // eslint-disable-next-line no-new-func
  const front = new Function(`return ${literal};`)();

  ['chave', 'rotulo', 'badge', 'cssBarra'].forEach(campo =>
    assert.equal(front[campo], OPERACIONAL[campo], `campo "${campo}" difere`));
});
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `node --test test/categoriasEquipe.test.js`
Expected: FAIL — `não achei "const CATEGORIAS_EQUIPE = [" no index.html`

- [ ] **Step 3: Implementar**

Em `public/index.html`, dentro do `<script>` e **antes** de qualquer função que
o use (junto das outras constantes de topo, como `_TIPOS_EQUIPE`):

```js
    // ── CATEGORIAS DE EQUIPE (derivadas do PREFIXO da sigla) ──────────────────
    //
    // ⚠️ CÓPIA ESPELHADA de services/categoriasEquipe.js. São dois runtimes e
    // o projeto não tem bundler, então a lista existe duas vezes.
    // test/categoriasEquipe.test.js compara as duas CAMPO A CAMPO: mexeu aqui,
    // mexa lá — senão a suíte fica vermelha antes do push.
    //
    // ⚠️ Não confundir com `_TIPOS_EQUIPE` (BTZERO, CS, COMERCIAL…), que é o
    // tipo operacional do CADASTRO. Outra dimensão. Por isso a chave do EB
    // aqui é BT_ZERO, com underline.
    const CATEGORIAS_EQUIPE = [
      { prefixo: 'EC', chave: 'COMERCIAL', rotulo: 'Comercial',   badge: 'EC', cssBarra: 'tipo-comercial' },
      { prefixo: 'EP', chave: 'PLANTAO',   rotulo: 'Plantão',     badge: 'EP', cssBarra: 'tipo-plantao'   },
      { prefixo: 'ET', chave: 'MOTO',      rotulo: 'Equipe Moto', badge: 'ET', cssBarra: 'tipo-moto'      },
      { prefixo: 'EB', chave: 'BT_ZERO',   rotulo: 'BT Zero',     badge: 'EB', cssBarra: 'tipo-bt-zero'   },
    ];
    const CATEGORIA_OPERACIONAL = {
      prefixo: null, chave: 'OPERACIONAL', rotulo: 'Operacional',
      badge: 'OP', cssBarra: 'tipo-operacional',
    };

    /** Chave da categoria → a entrada do catálogo (ou a do OPERACIONAL). */
    function _categoriaPorChave(chave) {
      return CATEGORIAS_EQUIPE.find(c => c.chave === chave) || CATEGORIA_OPERACIONAL;
    }
```

- [ ] **Step 4: Rodar e verificar que passa**

Run: `node --test test/categoriasEquipe.test.js`
Expected: PASS — 22 testes

- [ ] **Step 5: Provar que o teste de acordo tem dentes**

Troque temporariamente, **no `index.html`**, o rótulo `'Equipe Moto'` por
`'Equipe Motocicleta'` e rode:

Run: `node --test test/categoriasEquipe.test.js`
Expected: FAIL com a mensagem
`categoria 2 (MOTO): campo "rotulo" difere — front="Equipe Motocicleta" backend="Equipe Moto"`

Desfaça a alteração e rode de novo — tem de voltar a passar. Um teste de acordo
que nunca foi visto vermelho não protege nada.

- [ ] **Step 6: Commit**

```bash
git add public/index.html test/categoriasEquipe.test.js
git commit -m "feat(front): catalogo de categorias espelhado + teste de acordo

  Sao dois runtimes sem bundler, entao a lista existe duas vezes. O teste le o
  literal do index.html, executa, e compara campo a campo com o modulo do
  backend — acrescentar categoria de um lado so deixa a suite vermelha.

  Verificado que o teste tem dentes: trocar um rotulo num lado o deixa
  vermelho com mensagem apontando o campo e os dois valores.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Frontend usa o catálogo, e o filtro multi passa a valer

**Files:**
- Modify: `public/index.html:766-769` (as `<option>`)
- Modify: `public/index.html:3693` (prefixo → conjunto)
- Modify: `public/index.html:3901` (o envio que colapsava em TODAS)
- Modify: `public/index.html:4233-4237`, `:4267-4268`, `:4323` (badges)
- Modify: `public/css/app.css` (badges e barras novas)
- Test: `test/categoriasEquipe.test.js`

- [ ] **Step 1: Escrever o teste que falha**

Acrescente ao fim de `test/categoriasEquipe.test.js`:

```js
// ─────────────────────────────────────────────────────────────────────────────
// A tela usa o catálogo
// ─────────────────────────────────────────────────────────────────────────────

test('as <option> do filtro saem do catálogo, não são escritas à mão', () => {
  const i = SRC.indexOf('id="graf-tipo-select"');
  assert.ok(i > -1, 'não achei o select de tipo de equipe');
  const bloco = SRC.slice(i, SRC.indexOf('</select>', i));

  assert.ok(!bloco.includes('<option value="COMERCIAL">'),
    'as <option> ainda estão hard-coded no HTML');
  assert.ok(SRC.includes('function _montarOpcoesCategoria('),
    'esperava a função que monta as <option> a partir do catálogo');
});

test('o envio do filtro não colapsa mais duas categorias em TODAS', () => {
  // Era o defeito que 4 categorias tornaram real: marcar duas mostrava quatro.
  assert.ok(!/tipos\.length\s*!==\s*1\s*\?\s*'TODAS'/.test(SRC),
    'o colapso de ≥2 em TODAS voltou — marcar duas categorias mostraria todas');
});

test('não sobrou ternário de categoria hard-coded no index.html', () => {
  assert.ok(!/tipo_equipe === 'COMERCIAL'/.test(SRC),
    'voltou um ternário de categoria no front; ele tem de ler do catálogo');
});

test('o CSS tem badge e barra para as quatro categorias e o operacional', () => {
  const CSS = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');

  ['EC', 'EP', 'ET', 'EB', 'OP'].forEach(b =>
    assert.ok(CSS.includes(`.perf-tipo-badge.${b}`), `falta o badge .${b}`));

  [...CATEGORIAS.map(c => c.cssBarra), OPERACIONAL.cssBarra].forEach(cls =>
    assert.ok(CSS.includes(`.perf-bar-fill.${cls}`), `falta a barra .${cls}`));
});
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `node --test test/categoriasEquipe.test.js`
Expected: FAIL — os quatro testes novos.

- [ ] **Step 3: As `<option>` saem do catálogo**

Em `public/index.html`, localize:

```html
            <select class="filter-select" id="graf-tipo-select" onchange="loadGraficos()">
              <option value="TODAS">Todas</option>
              <option value="COMERCIAL">Comercial (EC)</option>
              <option value="PLANTAO">Plantão (EP)</option>
            </select>
```

Substitua por:

```html
            <select class="filter-select" id="graf-tipo-select" onchange="loadGraficos()">
              <!-- Preenchido por _montarOpcoesCategoria() a partir do catálogo
                   CATEGORIAS_EQUIPE. Escrever as <option> à mão aqui foi o que
                   espalhou a regra por 9 sítios. A opção "Todas" fica no HTML
                   pro select não nascer vazio se o script falhar. -->
              <option value="TODAS">Todas</option>
            </select>
```

E acrescente, junto do `_categoriaPorChave` da Task 3:

```js
    /**
     * Preenche o <select> de categoria a partir do catálogo. Chamado no boot.
     *
     * "Operacional (outros)" entra de propósito: sem ela, equipe de prefixo
     * desconhecido ficaria INALCANÇÁVEL por filtro — visível só em "Todas".
     * Hoje esse balde está vazio; a opção existe para o dia em que a EDP criar
     * um prefixo novo, e nesse dia a equipe aparece em vez de sumir.
     */
    function _montarOpcoesCategoria() {
      const sel = document.getElementById('graf-tipo-select');
      if (!sel) return;
      sel.innerHTML =
        `<option value="TODAS">Todas</option>` +
        CATEGORIAS_EQUIPE.map(c =>
          `<option value="${c.chave}">${c.rotulo} (${c.prefixo})</option>`).join('') +
        `<option value="${CATEGORIA_OPERACIONAL.chave}">${CATEGORIA_OPERACIONAL.rotulo} (outros)</option>`;
    }
```

Chame `_montarOpcoesCategoria()` no boot, **antes** do
`MultiSelect.init('graf-tipo-select', …)` — localize essa chamada com
`grep -n "graf-tipo-select'" public/index.html` e insira a linha logo acima.

- [ ] **Step 4: O envio passa a mandar CSV**

Localize, em `public/index.html`:

```js
      const tipo     = tipos.length !== 1     ? 'TODAS' : tipos[0];
```

Substitua por:

```js
      // 18/09/2026: antes era `tipos.length !== 1 ? 'TODAS' : tipos[0]` — ≥2
      // categorias colapsavam em TODAS. Com 2 categorias isso era inofensivo
      // (marcar as duas = marcar todas); com 4 virou defeito silencioso, que
      // mostrava MAIS do que o usuário pediu. O backend agora aceita CSV.
      const tipo     = tipos.length === 0 ? 'TODAS' : tipos.join(',');
```

E o comentário logo acima, que dizia que tipo não tem semântica multi, deve ser
substituído por:

```js
      // Regional/team: backend aceita CSV via IN. Tipo equipe também aceita CSV
      // desde 18/09/2026 (?tipo=COMERCIAL,MOTO) — ver services/categoriasEquipe.js.
```

- [ ] **Step 5: O filtro da lista de equipes aceita vários prefixos**

Localize:

```js
      const prefixo = tipoEq === 'COMERCIAL' ? 'EC' : tipoEq === 'PLANTAO' ? 'EP' : null;

      const eqs = _grafAllEquipes
        .filter(e => scope.has(e.regional))
        .filter(e => !prefixo || String(e.sigla).toUpperCase().startsWith(prefixo))
```

Substitua por:

```js
      // Mesma lógica do backend (services/categoriasEquipe.js), alimentada pelo
      // mesmo catálogo: monta o conjunto de prefixos aceitos e testa contra
      // todos. Antes traduzia UMA categoria em UM prefixo.
      const _semFiltro = tipoSel.length === 0 || tipoSel.includes('TODAS');
      const _prefixos  = _semFiltro ? []
        : tipoSel.map(k => (CATEGORIAS_EQUIPE.find(c => c.chave === k) || {}).prefixo).filter(Boolean);
      const _querOp    = !_semFiltro && tipoSel.includes(CATEGORIA_OPERACIONAL.chave);
      const _passa = (sigla) => {
        if (_semFiltro) return true;
        const u = String(sigla).toUpperCase();
        if (_prefixos.some(p => u.startsWith(p))) return true;
        return _querOp && !CATEGORIAS_EQUIPE.some(c => u.startsWith(c.prefixo));
      };

      const eqs = _grafAllEquipes
        .filter(e => scope.has(e.regional))
        .filter(e => _passa(e.sigla))
```

> A linha `const tipoEq = tipoSel.length === 1 ? tipoSel[0] : 'TODAS';`
> imediatamente acima deixa de ser usada aqui. Remova-a se nada mais na função
> a usar; confirme com `grep -n "tipoEq" public/index.html`.

- [ ] **Step 6: Os três sítios de badge**

Localize e substitua, um a um:

```js
        const tipoCls = e.tipo_equipe === 'COMERCIAL' ? 'tipo-comercial'
                     : e.tipo_equipe === 'PLANTAO'    ? 'tipo-plantao'
                     : 'tipo-operacional';
        const badge   = e.tipo_equipe === 'COMERCIAL' ? 'EC'
                     : e.tipo_equipe === 'PLANTAO'    ? 'EP' : 'OP';
```

vira:

```js
        const _cat    = _categoriaPorChave(e.tipo_equipe);
        const tipoCls = _cat.cssBarra;
        const badge   = _cat.badge;
```

```js
        const badge = e.tipo_equipe === 'COMERCIAL' ? 'EC'
                    : e.tipo_equipe === 'PLANTAO'   ? 'EP' : 'OP';
```

vira:

```js
        const badge = _categoriaPorChave(e.tipo_equipe).badge;
```

```js
          const badge = e.tipo_equipe === 'COMERCIAL' ? 'EC' : e.tipo_equipe === 'PLANTAO' ? 'EP' : 'OP';
```

vira:

```js
          const badge = _categoriaPorChave(e.tipo_equipe).badge;
```

- [ ] **Step 7: CSS dos badges e barras novos**

Em `public/css/app.css`, localize:

```css
    .perf-tipo-badge.EC { background: #fff3cd; color: #856404; }
    .perf-tipo-badge.EP { background: #cce5ff; color: #004085; }
    .perf-tipo-badge.OP { background: #d4edda; color: #155724; }
```

Substitua por:

```css
    .perf-tipo-badge.EC { background: #fff3cd; color: #856404; }
    .perf-tipo-badge.EP { background: #cce5ff; color: #004085; }
    /* ET (Equipe Moto) e EB (BT Zero) nomeados em 18/09/2026 — antes caíam no
       balde OP. Cores escolhidas pra não colidir com as três já em uso. */
    .perf-tipo-badge.ET { background: #f8d7da; color: #721c24; }
    .perf-tipo-badge.EB { background: #e2d9f3; color: #432874; }
    .perf-tipo-badge.OP { background: #d4edda; color: #155724; }
```

E localize:

```css
    .perf-bar-fill.tipo-operacional { background: var(--verde); }
```

Acrescente logo abaixo:

```css
    .perf-bar-fill.tipo-moto    { background: #d9534f; }
    .perf-bar-fill.tipo-bt-zero { background: #7a5ea8; }
```

- [ ] **Step 8: Rodar e verificar que passa**

Run: `node --test test/categoriasEquipe.test.js`
Expected: PASS — 26 testes

- [ ] **Step 9: Rodar a suíte inteira**

Run: `node --test`
Expected: 0 falhas. O `test/htmlScriptSintaxe.test.js` pega erro de digitação
no `<script>`, e o `test/multiSelectEscopo.test.js` cobre o componente do
dropdown — se ele ficar vermelho, a montagem dinâmica das `<option>` quebrou
alguma premissa dele.

- [ ] **Step 10: Commit**

```bash
git add public/index.html public/css/app.css test/categoriasEquipe.test.js
git commit -m "feat(front): tela usa o catalogo, e o filtro multi passa a valer

  As <option> passam a ser montadas a partir do catalogo, e os tres sitios de
  badge leem dele. Nenhum ternario de categoria sobra no index.html — ha teste
  afirmando isso.

  O envio deixa de colapsar >=2 categorias em TODAS. Era inofensivo com duas
  (marcar as duas = marcar todas) e virou defeito silencioso com quatro:
  mostrava MAIS do que o usuario pediu.

  Entra "Operacional (outros)" como opcao: sem ela, equipe de prefixo
  desconhecido ficaria inalcancavel por filtro, visivel so em Todas. O balde
  esta vazio hoje; a opcao existe pro dia em que a EDP criar prefixo novo.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Backlog

**Files:**
- Modify: `docs/handoff/BACKLOG.md`
- Modify: `docs/handoff/SPEC-categorias-equipe-2026-09-18.md` (cabeçalho)

- [ ] **Step 1: Linha no índice**

Após a linha do `P2-52` na tabela de índice do `docs/handoff/BACKLOG.md`:

```markdown
| P2-53 | Só EC e EP tinham nome: as 14 equipes ET e as 4 EB caíam num balde genérico "OP". E a regra vivia em 9 ternários duplicados, onde acrescentar 2 categorias seriam 18 edições manuais | Produto/Backend | **done** (18/09) — catálogo único + Equipe Moto e BT Zero + filtro multi de verdade; 26 testes; **falta confirmar em prod** |
```

- [ ] **Step 2: Item completo**

No fim do `docs/handoff/BACKLOG.md`:

```markdown

---

## P2-53 — Catálogo de categorias de equipe: Equipe Moto (ET) e BT Zero (EB)

- **Categoria:** Produto / Backend
- **Status:** **done** (18/09/2026) — **falta confirmar em produção**
- **Fonte:** pedido do José em 18/09/2026: *"as equipes que começam no EC são
  comerciais, as EP são plantão e as ET são Equipe Moto"*. O prefixo `EB`
  apareceu na exploração e ele decidiu nomeá-lo **BT Zero**.
- **Evidência:** as equipes já existiam sem nome — contagem de prefixos na
  whitelist: `EC 31 · EP 26 · ET 14 · EB 4`. As 14 `ET` e as 4 `EB` caíam em
  `OPERACIONAL`, com badge genérico `OP`.
- **A duplicação:** a regra vivia em **9 sítios** — 4 em `db/queries.js`
  (`getPerformanceEquipes` e `_buildEquipeTipoMatrix`, filtro e classificação
  em cada) e 5 em `public/index.html` (as `<option>`, o filtro da lista de
  equipes, e três sítios de badge). Acrescentar 2 categorias seriam **18
  edições manuais** em ternários encadeados, com modo de errar silencioso:
  esquecer um sítio de badge faz a mesma equipe aparecer como "Equipe Moto"
  numa tabela e "OP" em outra. É o **P3-9** aparecendo na prática.
- **Ação:** catálogo único em `services/categoriasEquipe.js`, espelhado numa
  constante do `index.html` (dois runtimes, sem bundler). **Teste compara as
  duas cópias campo a campo** — divergir deixa a suíte vermelha antes do push.
  Sem esse teste, catálogo único vira dois catálogos parecidos, que é pior que
  os 9 ternários porque parece seguro.
- **O filtro multi entrou junto, e não por escopo solto:** o dropdown é
  multi-select, mas o backend não aceitava múltiplos — o próprio código
  documentava que ≥2 colapsava em `TODAS`. Com **2** categorias isso era
  inofensivo (marcar as duas = marcar todas); com **4**, marcar duas passou a
  mostrar quatro, em silêncio, com números maiores do que o usuário pediu.
  Acrescentar categorias converteu uma esquisitice inócua num defeito real,
  então o conserto pertencia a este item. `?tipo=` passou a aceitar CSV.
- **"Operacional (outros)" virou opção do filtro.** Sem ela, equipe de prefixo
  desconhecido ficaria inalcançável por filtro — visível só em "Todas". O balde
  está vazio hoje; a opção existe pro dia em que a EDP criar um prefixo novo, e
  nesse dia a equipe aparece em vez de sumir (P1-39, P2-19 são o histórico que
  justifica o cuidado).
- **Nada foi persistido.** A categoria é derivada na leitura, então as ET e EB
  aparecem classificadas no histórico inteiro, sem backfill e sem risco sobre
  número já reportado à EDP. O campo `equipes_oficiais.tipo` do cadastro —
  outra dimensão — não foi tocado.
- **Aceite:**
  - [x] 26 testes, incluindo o de acordo entre as duas cópias.
  - [x] Verificado que o teste de acordo fica vermelho ao divergir um rótulo.
  - [x] Suíte verde.
  - [ ] **Em produção:** o filtro mostra Equipe Moto (ET) e BT Zero (EB), e as
        equipes aparecem com o badge certo nas três tabelas.
  - [ ] **Em produção:** marcar duas categorias mostra **só** essas duas.
- **Esforço:** ~3h (spec, plano e execução).
- **Rollback:** `git revert`. Sem schema, sem cron, sem caminho de escrita.
  Commits separados por camada: catálogo (inerte sozinho), backend, front/CSS.
- **Fora de escopo:** tornar a categoria editável no Admin (exigiria preencher
  143 linhas e aceitar que cadastro e sigla divirjam); mexer em
  `equipes_oficiais.tipo`.
```

- [ ] **Step 3: Atualizar o status do spec**

Em `docs/handoff/SPEC-categorias-equipe-2026-09-18.md`, troque a linha de
status por:

```markdown
> Data: 2026-09-18 · Status: **implementado** — falta confirmar em produção.
> Ver P2-53 no BACKLOG e `PLANO-categorias-equipe-2026-09-18.md`.
```

- [ ] **Step 4: Rodar a suíte inteira**

Run: `node --test`
Expected: 0 falhas

- [ ] **Step 5: Commit**

```bash
git add docs/handoff/BACKLOG.md docs/handoff/SPEC-categorias-equipe-2026-09-18.md
git commit -m "docs: P2-53 no backlog e spec marcada como implementada

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Verificação final (manual, na VM)

Depois do deploy (`git pull && pm2 delete wpa-monitor && pm2 start ecosystem.config.js && pm2 save`):

- [ ] O filtro "Tipo Equipe" da aba Gráficos lista: Todas, Comercial (EC),
      Plantão (EP), Equipe Moto (ET), BT Zero (EB), Operacional (outros)
- [ ] Marcar **só** "Equipe Moto" mostra apenas siglas `ET*`
- [ ] Marcar **"Comercial + Equipe Moto"** mostra `EC*` e `ET*` — **e mais
      nada**. É o defeito que este item consertou; se aparecer `EP*`, o CSV não
      está chegando ao backend
- [ ] As equipes `ET` aparecem com badge **ET** nas três tabelas da aba
      (barra de média, detalhamento por tipo, e a matriz) — o mesmo badge nas
      três, que é o que a duplicação quebrava
- [ ] Um período antigo (ex.: maio) já mostra as ET e EB classificadas, sem
      nenhum backfill ter sido rodado
