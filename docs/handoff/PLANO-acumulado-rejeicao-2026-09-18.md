# Acumulado — Perda por Rejeição — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tabela nova na aba Gráficos, abaixo da matriz existente, mostrando por equipe e por regional quanto da produção atendida se perdeu em rejeição — em quantidade e em taxa.

**Architecture:** Duas funções puras no `public/index.html` — uma faz a conta (agrupa por regional, soma, calcula taxas), outra monta o HTML. Ambas extraídas e **executadas** no teste. Zero mudança no backend: o payload que a tabela precisa já chega no browser.

**Tech Stack:** JavaScript vanilla no monólito `public/index.html`, CSS em `public/css/app.css`, testes com `node --test` (built-in, sem framework).

**Spec:** `docs/handoff/SPEC-acumulado-rejeicao-2026-09-18.md`

---

## Contexto que o executor precisa saber

**1. A fonte é `matrizData.equipes`, NÃO `equipes`.** Existem duas variáveis no
mesmo escopo do `renderGraficos`. Só `matrizData.equipes` tem `total_exec`,
`total_rej` e `regional` (vem do `_buildEquipeTipoMatrix`, `db/queries.js:1319`).
A outra alimenta a seção "Detalhamento por Equipe e Tipo" e **não** tem esses
campos. Usar a errada dá tabela vazia ou com `undefined`, em silêncio.

**2. A matriz existente NÃO se altera.** O José circulou a tabela "Notas
Atendidas por Tipo" (`public/index.html:4342`) pra apontá-la como referência, e
pediu a nova **abaixo** dela. Não mexa no `matrizHTML`.

**3. Taxa de grupo é PONDERADA.** `soma(rej) ÷ soma(atendidas)`, nunca a média
das taxas das equipes. Ver §6 do spec — tem teste cravando isso.

**4. Seção expansível sai de graça.** Qualquer `div.perf-section` com um
`.perf-section-title` vira recolhível: existe handler delegado em
`public/index.html:4020` e o estado é persistido. Basta usar essa estrutura.

**Como rodar os testes:** `node --test` (suíte inteira, ~14s) ou
`node --test test/arquivo.test.js`. O hook `pre-push` bloqueia push com teste
vermelho.

**Commits:** convenção do `CLAUDE.md`, terminando com
`Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `public/index.html` **(modificar)** | `_agruparPerdaPorRegional` (a conta), `_renderAcumuladoRejeicao` (o HTML), e a chamada no template. |
| `public/css/app.css` **(modificar)** | Classes `.acum-*` da tabela nova. |
| `test/acumuladoRejeicao.test.js` **(novo)** | As duas funções, extraídas e executadas. |
| `docs/handoff/BACKLOG.md` **(modificar)** | Item P2-52. |

---

## Task 1: `_agruparPerdaPorRegional` — a conta

**Files:**
- Modify: `public/index.html` (antes de `function renderEquipesTabela`)
- Test: `test/acumuladoRejeicao.test.js` (criar)

- [ ] **Step 1: Escrever o teste que falha**

Crie `test/acumuladoRejeicao.test.js`:

```js
/**
 * test/acumuladoRejeicao.test.js
 *
 * Tabela "Acumulado — Perda por Rejeição" da aba Gráficos.
 *
 * Não há harness de frontend (risco H11), mas as duas funções são PURAS —
 * então aqui elas são extraídas do index.html e EXECUTADAS, não conferidas
 * como texto. Mesmo padrão do test/equipesAdminTela.test.js.
 *
 * Spec: docs/handoff/SPEC-acumulado-rejeicao-2026-09-18.md
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/**
 * Extrai uma função do index.html casando as chaves.
 *
 * A lista de parâmetros é pulada casando os PARÊNTESES primeiro. Sem isso, um
 * parâmetro desestruturado — `function f(a, { b, c })` — faz o casamento de
 * chaves começar na chave do destructuring e terminar nela, devolvendo só a
 * assinatura, com um `SyntaxError` que não aponta a causa.
 */
function extrairFuncao(nome) {
  const marca = `function ${nome}(`;
  const ini   = SRC.indexOf(marca);
  assert.ok(ini > -1, `não achei ${marca} no index.html`);

  let paren = 0, fimParams = -1;
  for (let i = ini + marca.length - 1; i < SRC.length; i++) {
    if (SRC[i] === '(') paren++;
    else if (SRC[i] === ')') { paren--; if (paren === 0) { fimParams = i; break; } }
  }
  assert.ok(fimParams > -1, `parênteses não fecharam em ${nome}`);

  const abre = SRC.indexOf('{', fimParams);
  let nivel = 0;
  for (let i = abre; i < SRC.length; i++) {
    if (SRC[i] === '{') nivel++;
    else if (SRC[i] === '}') { nivel--; if (nivel === 0) return SRC.slice(ini, i + 1); }
  }
  throw new Error(`chaves não fecharam em ${nome}`);
}

/**
 * Carrega a função sob demanda, DENTRO de cada teste.
 *
 * Não faça isso no escopo do módulo: enquanto a função não existe no
 * index.html — que é o estado esperado na fase vermelha —, o `assert` do
 * extrairFuncao derruba o ARQUIVO inteiro no load, e os testes que já passavam
 * ficam vermelhos junto, parecendo regressão.
 */
function agrupar(...args) {
  const fn = new Function(
    `${extrairFuncao('_agruparPerdaPorRegional')}; return _agruparPerdaPorRegional;`)();
  return fn(...args);
}

/** Equipe no formato que o _buildEquipeTipoMatrix devolve. */
function eq(team_name, regional, total_exec, total_rej) {
  return { team_name, regional, total_exec, total_rej };
}

test('agrupa equipes de regionais diferentes em grupos distintos', () => {
  const g = agrupar([
    eq('EBGPR62', 'GUA', 100, 10),
    eq('ECACH50', 'CAC', 200, 20),
  ]);

  assert.equal(g.length, 2);
  assert.deepEqual(g.map(x => x.regional), ['CAC', 'GUA'], 'grupos vêm por nome');
});

test('atendidas = executadas + rejeitadas, por equipe e por grupo', () => {
  const [g] = agrupar([eq('EBGPR62', 'GUA', 90, 10)]);

  assert.equal(g.equipes[0].total_atend, 100);
  assert.equal(g.total_exec, 90);
  assert.equal(g.total_rej, 10);
  assert.equal(g.total_atend, 100);
});

test('taxa da equipe é rejeitadas ÷ atendidas', () => {
  const [g] = agrupar([eq('EBGPR62', 'GUA', 75, 25)]);
  assert.equal(g.equipes[0].taxa, 0.25);
});

test('A TAXA DA REGIONAL É PONDERADA — nunca a média das taxas das equipes', () => {
  // Armadilha da §6 do spec. Uma equipe com 1 rejeição em 2 notas (50%) e
  // outra com 10 em 1000 (1%) dão média simples de 25,5% — mas a perda real do
  // grupo é 11 em 1002, ou 1,1%. Média de percentual é um dos jeitos clássicos
  // de um número virar mentira num painel que a EDP audita.
  const [g] = agrupar([
    eq('EPEQUENA', 'GUA',   1,  1),   // 50,0%
    eq('EGRANDE',  'GUA', 990, 10),   //  1,0%
  ]);

  assert.equal(g.total_rej, 11);
  assert.equal(g.total_atend, 1002);
  assert.equal((g.taxa * 100).toFixed(1), '1.1');
  assert.notEqual((g.taxa * 100).toFixed(1), '25.5', 'caiu na média das taxas');
});

test('equipe sem rejeição tem taxa 0, não NaN', () => {
  const [g] = agrupar([eq('EBGPR62', 'GUA', 50, 0)]);
  assert.equal(g.equipes[0].taxa, 0);
  assert.ok(!Number.isNaN(g.taxa));
});

test('equipe sem nenhuma nota não gera divisão por zero', () => {
  const [g] = agrupar([eq('EVAZIA1', 'GUA', 0, 0)]);
  assert.equal(g.equipes[0].taxa, 0);
  assert.equal(g.taxa, 0);
  assert.ok(!Number.isNaN(g.taxa));
});

test('dentro do grupo: taxa desc, empate por volume desc, depois sigla', () => {
  const [g] = agrupar([
    eq('EBAIXA',  'GUA', 95,  5),   // 5,0%
    eq('EALTA',   'GUA', 70, 30),   // 30,0%
    eq('EMEDIA2', 'GUA', 40, 10),   // 20,0% — 50 atendidas
    eq('EMEDIA1', 'GUA', 80, 20),   // 20,0% — 100 atendidas (vem antes)
  ]);

  assert.deepEqual(g.equipes.map(e => e.team_name),
    ['EALTA', 'EMEDIA1', 'EMEDIA2', 'EBAIXA']);
});

test('empate total de taxa E volume resolve por sigla', () => {
  const [g] = agrupar([
    eq('EZZZ', 'GUA', 90, 10),
    eq('EAAA', 'GUA', 90, 10),
  ]);
  assert.deepEqual(g.equipes.map(e => e.team_name), ['EAAA', 'EZZZ']);
});

test('lista vazia devolve [] em vez de estourar', () => {
  assert.deepEqual(agrupar([]), []);
  assert.deepEqual(agrupar(null), []);
  assert.deepEqual(agrupar(undefined), []);
});

test('equipe sem regional cai num grupo próprio, não some', () => {
  // Esconder dado é contra a regra da casa. Se a regional vier vazia, a equipe
  // aparece num grupo "—" em vez de desaparecer da tabela.
  const g = agrupar([eq('ESEMREG', null, 10, 2)]);
  assert.equal(g.length, 1);
  assert.equal(g[0].equipes[0].team_name, 'ESEMREG');
});
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `node --test test/acumuladoRejeicao.test.js`
Expected: FAIL — `não achei function _agruparPerdaPorRegional( no index.html`

- [ ] **Step 3: Implementar**

Em `public/index.html`, imediatamente **antes** de
`function renderEquipesTabela(eqs) {`:

```js
    // ── ACUMULADO: PERDA POR REJEIÇÃO ─────────────────────────────────────────
    /**
     * Agrupa as equipes por regional e calcula a perda por rejeição. PURA —
     * por isso é testável (test/acumuladoRejeicao.test.js extrai e executa).
     *
     * Entrada: `matrizData.equipes`, como o _buildEquipeTipoMatrix devolve
     * (db/queries.js:1319) — NÃO a variável `equipes`, que é outra coisa e não
     * tem total_exec/total_rej.
     *
     * ⚠️ A taxa do grupo é PONDERADA: soma(rej) ÷ soma(atendidas). NUNCA a
     * média das taxas das equipes. Uma equipe 1/2 (50%) e outra 10/1000 (1%)
     * dariam média 25,5%, quando a perda real do grupo é 11/1002 = 1,1%.
     * Média de percentual é um dos jeitos clássicos de um número virar mentira
     * num painel que a EDP audita. Ver §6 da SPEC-acumulado-rejeicao.
     *
     * @returns {Array} [{ regional, total_exec, total_rej, total_atend, taxa,
     *                     equipes: [{ team_name, total_exec, total_rej,
     *                                 total_atend, taxa }] }]
     */
    function _agruparPerdaPorRegional(equipesMatriz) {
      const porReg = new Map();

      (equipesMatriz || []).forEach(e => {
        const reg = e.regional || '—';
        if (!porReg.has(reg)) {
          porReg.set(reg, {
            regional: reg, total_exec: 0, total_rej: 0, total_atend: 0,
            taxa: 0, equipes: [],
          });
        }
        const g     = porReg.get(reg);
        const exec  = Number(e.total_exec) || 0;
        const rej   = Number(e.total_rej)  || 0;
        const atend = exec + rej;

        g.total_exec  += exec;
        g.total_rej   += rej;
        g.total_atend += atend;
        g.equipes.push({
          team_name: e.team_name,
          total_exec: exec, total_rej: rej, total_atend: atend,
          taxa: atend > 0 ? rej / atend : 0,
        });
      });

      const grupos = [...porReg.values()];
      grupos.forEach(g => {
        g.taxa = g.total_atend > 0 ? g.total_rej / g.total_atend : 0;
        // Maior taxa primeiro; empate por volume atendido desc, depois sigla.
        // Sem corte de amostra mínima, por decisão do José em 18/09 — a coluna
        // "Atendidas" fica ao lado e denuncia volume irrisório na própria
        // linha. Ver §4.3 do spec: foi escolha, não esquecimento.
        g.equipes.sort((a, b) =>
          b.taxa - a.taxa ||
          b.total_atend - a.total_atend ||
          String(a.team_name).localeCompare(String(b.team_name)));
      });
      grupos.sort((a, b) => String(a.regional).localeCompare(String(b.regional)));
      return grupos;
    }

    function renderEquipesTabela(eqs) {
```

(A última linha acima é a função que já existe — não duplique, apenas insira o
bloco novo antes dela.)

- [ ] **Step 4: Rodar e verificar que passa**

Run: `node --test test/acumuladoRejeicao.test.js`
Expected: PASS — 10 testes

- [ ] **Step 5: Commit**

```bash
git add public/index.html test/acumuladoRejeicao.test.js
git commit -m "feat(graficos): _agruparPerdaPorRegional — a conta da perda por rejeicao

  Agrupa as equipes por regional, soma e calcula as taxas. Funcao pura,
  testada por extracao do index.html.

  A taxa do grupo e PONDERADA: soma(rej) / soma(atendidas), nunca a media das
  taxas das equipes. Uma equipe 1/2 (50%) e outra 10/1000 (1%) dariam media
  25,5% quando a perda real e 11/1002 = 1,1%. Ha teste cravando exatamente
  esse caso.

  Sem corte de amostra minima, por decisao do Jose — a coluna Atendidas fica
  ao lado da taxa e denuncia volume irrisorio na propria linha.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: `_renderAcumuladoRejeicao` — o HTML

**Files:**
- Modify: `public/index.html` (logo após `_agruparPerdaPorRegional`)
- Test: `test/acumuladoRejeicao.test.js`

- [ ] **Step 1: Escrever os testes que falham**

Acrescente ao fim de `test/acumuladoRejeicao.test.js`:

```js
// ─────────────────────────────────────────────────────────────────────────────
// _renderAcumuladoRejeicao — o HTML
// ─────────────────────────────────────────────────────────────────────────────

/**
 * _renderAcumuladoRejeicao depende de escapeHtml. Carregada sob demanda pelo
 * mesmo motivo do `agrupar` acima: extração no escopo do módulo derrubaria o
 * arquivo inteiro na fase vermelha.
 */
function render(...args) {
  const fn = new Function(`
    ${extrairFuncao('escapeHtml')}
    ${extrairFuncao('_renderAcumuladoRejeicao')}
    return _renderAcumuladoRejeicao;
  `)();
  return fn(...args);
}

test('a linha da regional vem ANTES das equipes dela', () => {
  const html = render(agrupar([
    eq('EBGPR62', 'GUA', 90, 10),
    eq('ECGPR53', 'GUA', 80, 20),
  ]));

  const iReg = html.indexOf('GUA');
  const iEq  = html.indexOf('ECGPR53');
  assert.ok(iReg > -1 && iEq > -1);
  assert.ok(iReg < iEq, 'o subtotal da regional tem de encabeçar o grupo');
});

test('o subtotal da regional aparece com os valores somados', () => {
  const html = render(agrupar([
    eq('EBGPR62', 'GUA', 90, 10),
    eq('ECGPR53', 'GUA', 80, 20),
  ]));

  assert.ok(html.includes('170'), 'executadas somadas');
  assert.ok(html.includes('200'), 'atendidas somadas');
});

test('o total geral no rodapé é a soma de todos os grupos', () => {
  const html = render(agrupar([
    eq('EBGPR62', 'GUA', 100, 10),
    eq('ECACH50', 'CAC', 200, 20),
  ]));

  assert.ok(html.includes('TOTAL GERAL'));
  assert.ok(html.includes('330'), 'atendidas totais = 110 + 220');
});

test('percentual com uma casa e vírgula (padrão pt-BR)', () => {
  const html = render(agrupar([eq('EBGPR62', 'GUA', 75, 25)]));
  assert.ok(html.includes('25,0%'), `esperava 25,0% no HTML`);
  assert.ok(!html.includes('25.0%'), 'ponto decimal não é o padrão do painel');
});

test('sigla da equipe é escapada — dado da EDP não vai cru pro innerHTML', () => {
  // Regra do P2-4. O team_name vem da EDP; um caractere de marcação quebraria
  // a tabela em silêncio, ou pior.
  const html = render(agrupar([eq('<img src=x onerror=alert(1)>', 'GUA', 1, 0)]));
  assert.ok(!html.includes('<img src=x'), 'HTML cru vazou pra tela');
  assert.ok(html.includes('&lt;img'), 'tem de vir escapado');
});

test('lista vazia não renderiza a seção', () => {
  assert.equal(render([]), '');
  assert.equal(render(null), '');
});

test('a seção usa perf-section + perf-section-title (fica expansível de graça)', () => {
  const html = render(agrupar([eq('EBGPR62', 'GUA', 90, 10)]));
  assert.ok(html.includes('class="perf-section"'));
  assert.ok(html.includes('class="perf-section-title"'));
});
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `node --test test/acumuladoRejeicao.test.js`
Expected: FAIL — `não achei function _renderAcumuladoRejeicao( no index.html`

- [ ] **Step 3: Implementar**

Em `public/index.html`, imediatamente **após** a função
`_agruparPerdaPorRegional` que a Task 1 criou:

```js
    /**
     * Monta a tabela "Acumulado — Perda por Rejeição". PURA.
     *
     * Estrutura: uma linha de subtotal por regional encabeçando as equipes
     * dela, e o total geral no rodapé. O subtotal vai no CABEÇALHO do grupo
     * (não num rodapé por grupo): uma linha em vez de duas, e o número aparece
     * onde o olho já está ao trocar de regional.
     */
    function _renderAcumuladoRejeicao(grupos) {
      if (!grupos || grupos.length === 0) return '';

      const esc = s => escapeHtml(String(s === null || s === undefined ? '' : s));
      const num = v => Number(v || 0).toLocaleString('pt-BR');
      const pct = v => (Number(v || 0) * 100).toFixed(1).replace('.', ',') + '%';

      const linhas = grupos.map(g => {
        const cab = `<tr class="acum-grp">
          <td class="acum-team">${esc(g.regional)}</td>
          <td>${num(g.total_exec)}</td>
          <td>${num(g.total_rej)}</td>
          <td>${num(g.total_atend)}</td>
          <td>${pct(g.taxa)}</td>
        </tr>`;
        const eqs = g.equipes.map(e => `<tr>
          <td class="acum-team acum-eq">${esc(e.team_name)}</td>
          <td class="acum-exec">${num(e.total_exec)}</td>
          <td class="${e.total_rej > 0 ? 'acum-rej-hot' : 'acum-zero'}">${num(e.total_rej)}</td>
          <td>${num(e.total_atend)}</td>
          <td class="acum-taxa">${pct(e.taxa)}</td>
        </tr>`).join('');
        return cab + eqs;
      }).join('');

      const tExec  = grupos.reduce((s, g) => s + g.total_exec, 0);
      const tRej   = grupos.reduce((s, g) => s + g.total_rej, 0);
      const tAtend = tExec + tRej;
      const tTaxa  = tAtend > 0 ? tRej / tAtend : 0;

      return `
<div class="perf-section">
  <div class="perf-section-title">Acumulado — Perda por Rejeição (equipe e regional)</div>
  <div style="background:var(--branco);border-radius:var(--radius-lg);box-shadow:var(--shadow-sm);overflow:auto;max-height:560px">
    <table class="acum-table">
      <thead>
        <tr>
          <th style="text-align:left">Equipe</th>
          <th>Executadas</th>
          <th>Rejeitadas</th>
          <th title="Executadas + Rejeitadas">Atendidas</th>
          <th title="Rejeitadas ÷ Atendidas">% Rejeição</th>
        </tr>
      </thead>
      <tbody>${linhas}</tbody>
      <tfoot>
        <tr class="acum-foot">
          <td class="acum-team">TOTAL GERAL</td>
          <td>${num(tExec)}</td>
          <td>${num(tRej)}</td>
          <td>${num(tAtend)}</td>
          <td>${pct(tTaxa)}</td>
        </tr>
      </tfoot>
    </table>
  </div>
</div>`;
    }
```

- [ ] **Step 4: Rodar e verificar que passa**

Run: `node --test test/acumuladoRejeicao.test.js`
Expected: PASS — 17 testes

- [ ] **Step 5: Commit**

```bash
git add public/index.html test/acumuladoRejeicao.test.js
git commit -m "feat(graficos): _renderAcumuladoRejeicao — a tabela

  Subtotal da regional encabeca o grupo (uma linha em vez de duas, e o numero
  aparece onde o olho ja esta), total geral no rodape.

  A coluna Atendidas existe pra conta fechar na tela: exec+rej, e cada OS cai
  em exatamente um dos dois pela regra de 31/07. Sigla da EDP escapada (P2-4).

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: CSS e ligar na tela

**Files:**
- Modify: `public/css/app.css` (fim do arquivo)
- Modify: `public/index.html` (no `renderGraficos`, junto do `matrizHTML`)
- Test: `test/acumuladoRejeicao.test.js`

- [ ] **Step 1: Escrever o teste que falha**

Acrescente ao fim de `test/acumuladoRejeicao.test.js`:

```js
// ─────────────────────────────────────────────────────────────────────────────
// Ligação na tela
// ─────────────────────────────────────────────────────────────────────────────

test('a seção nova é renderizada DEPOIS da matriz existente', () => {
  // O José pediu a tabela nova ABAIXO da matriz, que fica intocada.
  const iMatriz = SRC.indexOf('${matrizHTML}');
  const iAcum   = SRC.indexOf('${acumuladoHTML}');
  assert.ok(iMatriz > -1, 'não achei ${matrizHTML} no template');
  assert.ok(iAcum > -1, 'não achei ${acumuladoHTML} no template');
  assert.ok(iAcum > iMatriz, 'a tabela nova tem de vir depois da matriz');
});

test('a ligação lê de matrizData.equipes, não da variável `equipes`', () => {
  // São duas variáveis no mesmo escopo e só a primeira tem total_exec/
  // total_rej/regional. Usar a errada dá tabela vazia, em silêncio.
  const i = SRC.indexOf('const acumuladoHTML');
  assert.ok(i > -1, 'não achei a atribuição de acumuladoHTML');
  const bloco = SRC.slice(i, i + 220);
  assert.ok(bloco.includes('matrizData'),
    `a ligação tem de partir de matrizData.equipes. Bloco:\n${bloco}`);
});

test('a matriz existente continua intacta', () => {
  assert.ok(SRC.includes('Notas Atendidas por Tipo — EXEC × Rejeitadas por Equipe'),
    'o título da matriz existente sumiu — ela não devia ser tocada');
});
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `node --test test/acumuladoRejeicao.test.js`
Expected: FAIL — `não achei ${acumuladoHTML} no template`

- [ ] **Step 3: Calcular o HTML junto do `matrizHTML`**

Em `public/index.html`, logo **depois** do fechamento da IIFE do `matrizHTML`
(a linha `})();` que fecha `const matrizHTML = (() => {`), acrescente:

```js
      // Tabela "Acumulado — Perda por Rejeição": mesma fonte da matriz acima
      // (matrizData.equipes — NÃO a variável `equipes`, que não tem os totais).
      // Vai ABAIXO da matriz; ela não é alterada.
      const acumuladoHTML = _renderAcumuladoRejeicao(
        _agruparPerdaPorRegional((matrizData && matrizData.equipes) || []));
```

- [ ] **Step 4: Inserir no template**

No mesmo arquivo, o template de retorno do `renderGraficos` termina com:

```js
${matrizHTML}
`;
```

Troque por:

```js
${matrizHTML}
${acumuladoHTML}
`;
```

- [ ] **Step 5: Acrescentar o CSS**

No fim de `public/css/app.css`:

```css
    /* ── Acumulado — Perda por Rejeição ──────────────────────────────────────
       Tabela da aba Gráficos que mede a perda por rejeição por equipe, com
       subtotal por regional. Criada em 18/09/2026 (SPEC-acumulado-rejeicao). */
    .acum-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .acum-table th, .acum-table td { padding: 6px 10px; text-align: right; }
    .acum-table td.acum-team { text-align: left; }

    .acum-table thead th {
      position: sticky; top: 0; z-index: 1;
      background: var(--verde); color: #fff;
      font-size: 10px; font-weight: 700; letter-spacing: .05em;
      text-transform: uppercase; white-space: nowrap;
    }

    /* Linha da regional: encabeça o grupo e carrega o subtotal. */
    .acum-table tr.acum-grp td {
      background: var(--cinza1); font-weight: 700;
      border-top: 2px solid var(--verde);
      text-transform: uppercase; letter-spacing: .03em;
    }

    .acum-table tbody tr td { border-bottom: 1px solid var(--cinza2); }
    .acum-table td.acum-eq { padding-left: 24px; font-family: monospace; }
    .acum-table td.acum-exec { color: var(--verde2); font-weight: 600; }
    .acum-table td.acum-rej-hot { color: var(--vermelho); font-weight: 700; }
    .acum-table td.acum-zero { color: var(--cinza3); opacity: .5; }
    .acum-table td.acum-taxa { font-weight: 700; }

    .acum-table tfoot tr.acum-foot td {
      background: var(--cinza2); font-weight: 700;
      border-top: 2px solid var(--preto);
    }
```

- [ ] **Step 6: Rodar e verificar que passa**

Run: `node --test test/acumuladoRejeicao.test.js`
Expected: PASS — 20 testes

- [ ] **Step 7: Rodar a suíte inteira**

Run: `node --test`
Expected: 0 falhas. O `test/htmlScriptSintaxe.test.js` valida a sintaxe do
`<script>` — erro de digitação no JS aparece aqui.

- [ ] **Step 8: Commit**

```bash
git add public/index.html public/css/app.css test/acumuladoRejeicao.test.js
git commit -m "feat(graficos): tabela Acumulado — Perda por Rejeicao na tela

  Ligada abaixo da matriz "Notas Atendidas por Tipo", que fica intocada — foi
  o que o Jose pediu. Le de matrizData.equipes (a outra variavel do escopo,
  `equipes`, nao tem os totais e daria tabela vazia em silencio).

  Vira expansivel de graca por usar perf-section + perf-section-title.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Backlog

**Files:**
- Modify: `docs/handoff/BACKLOG.md`
- Modify: `docs/handoff/SPEC-acumulado-rejeicao-2026-09-18.md` (cabeçalho)

- [ ] **Step 1: Linha no índice**

Em `docs/handoff/BACKLOG.md`, após a linha do `P2-51` na tabela de índice:

```markdown
| P2-52 | Não havia como ler a perda por rejeição: a matriz por tipo tem os números espalhados, sem taxa, e com um Total único — não dava pra comparar equipes nem ver o acumulado da regional | Produto/Frontend | **done** (18/09) — tabela nova abaixo da matriz; 20 testes; **falta confirmar em prod** |
```

- [ ] **Step 2: Item completo**

No fim do `docs/handoff/BACKLOG.md`:

```markdown

---

## P2-52 — Tabela "Acumulado — Perda por Rejeição"

- **Categoria:** Produto / Frontend
- **Status:** **done** (18/09/2026) — **falta confirmar em produção**
- **Fonte:** pedido do José em 18/09/2026: *"uma tabela que mede as perdas por
  notas rejeitadas das equipes e o acumulado da regional também"*.
- **Evidência do que faltava:** a matriz "Notas Atendidas por Tipo"
  (`public/index.html:4342`) já tinha os números, mas — nas palavras dele —
  *"dispersas e espalhadas"*: colunas repetidas por tipo de nota, **sem taxa**
  (só contagem absoluta, então equipe grande e pequena não se comparam) e com
  **um** Total no rodapé, sem subtotal por regional.
- **Ação:** tabela nova ABAIXO da matriz, que **não foi alterada**. Colunas
  `Equipe · Executadas · Rejeitadas · Atendidas · % Rejeição`, equipes
  agrupadas sob a regional com o subtotal encabeçando o grupo, e total geral
  no rodapé. Ordem: taxa decrescente.
- **Custo:** zero no backend. O `_buildEquipeTipoMatrix` (`db/queries.js:1319`)
  já devolvia `total_exec`, `total_rej` e `regional` por equipe — é
  agrupamento sobre payload que já estava no browser.
- **Decisões registradas (pra ninguém "consertar" depois):**
  - **Taxa de regional é PONDERADA**, `soma(rej) ÷ soma(atendidas)`, nunca a
    média das taxas das equipes. Uma equipe 1/2 (50%) e outra 10/1000 (1%)
    dariam média 25,5% quando a perda real do grupo é 11/1002 = **1,1%**. Há
    teste cravando esse caso exato.
  - **Sem corte de amostra mínima**, por decisão do José. Foi levantado que
    ordenar só por taxa põe no topo a equipe de 3 notas com 33%; a coluna
    "Atendidas" fica ao lado e denuncia o volume na própria linha. Foi escolha,
    não esquecimento.
  - **Ordem diferente da matriz de cima** (taxa × volume), de propósito: são
    perguntas diferentes.
- **Aceite:**
  - [x] 20 testes; as duas funções são puras e são EXECUTADAS no teste.
  - [x] Suíte verde.
  - [ ] **Em produção:** a seção aparece abaixo da matriz e recolhe/expande.
  - [ ] **Em produção:** conferir um subtotal de regional à mão contra a soma
        das equipes do grupo.
- **Esforço:** ~2h (spec, plano e execução).
- **Rollback:** `git revert`. Só `public/index.html`, `public/css/app.css` e um
  teste novo. Nada de schema, rota, cron ou caminho de leitura.
- **Fora de escopo:** perda em R$ (não há fonte de valor por OS confirmada);
  exportar a tabela nova pro XLSX (não pedido — o `_agruparPerdaPorRegional`
  já entrega a estrutura pronta se vier).
```

- [ ] **Step 3: Atualizar o status do spec**

Em `docs/handoff/SPEC-acumulado-rejeicao-2026-09-18.md`, troque a linha de
status do cabeçalho por:

```markdown
> Data: 2026-09-18 · Status: **implementado** — falta confirmar em produção.
> Ver P2-52 no BACKLOG e `PLANO-acumulado-rejeicao-2026-09-18.md`.
```

- [ ] **Step 4: Rodar a suíte inteira**

Run: `node --test`
Expected: 0 falhas

- [ ] **Step 5: Commit**

```bash
git add docs/handoff/BACKLOG.md docs/handoff/SPEC-acumulado-rejeicao-2026-09-18.md
git commit -m "docs: P2-52 no backlog e spec marcada como implementada

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Verificação final (manual, na VM)

Depois do deploy (`git pull && pm2 delete wpa-monitor && pm2 start ecosystem.config.js && pm2 save`):

- [ ] A aba Gráficos mostra a seção "Acumulado — Perda por Rejeição" **abaixo**
      da matriz "Notas Atendidas por Tipo", e a matriz continua igual
- [ ] Clicar no título recolhe e expande, como as seções vizinhas
- [ ] Com o filtro em "Todas as regionais", aparece um grupo por regional, cada
      um com seu subtotal
- [ ] **Conferir uma conta à mão:** somar as executadas das equipes de um grupo
      e comparar com o subtotal da regional; fazer o mesmo com as rejeitadas
- [ ] A equipe com maior % de rejeição está no topo do grupo dela
- [ ] Com o filtro numa regional só, aparece um grupo apenas
