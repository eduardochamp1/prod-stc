# Importar equipes de planilha — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cadastrar equipes oficiais em lote a partir de planilha `.xlsx`, com prévia que mostra linha a linha o que vai acontecer, mais busca/filtro na lista de 138 equipes.

**Architecture:** Toda a decisão vive numa função pura (`services/equipesImport.js`), testável sem banco e sem DOM. Uma rota fina (`POST /api/admin/equipes/importar`) a envolve e serve as duas fases — prévia e gravação — pelo mesmo caminho de validação. O browser só lê bytes do arquivo e renderiza. A gravação é **um** `INSERT … ON CONFLICT DO UPDATE`, atômico por ser statement único.

**Tech Stack:** Node 24, Express 4, `pg` via `services/pgShim.js` (shim com API estilo PostgREST), `node --test` (built-in, sem framework), SheetJS já vendorizado em `public/vendor/xlsx.full.min.js`.

**Spec:** `docs/handoff/SPEC-import-equipes-2026-09-17.md`

---

## Contexto que o executor precisa saber

Leia antes de começar. Três armadilhas deste código base já custaram incidente.

**1. `pgShim.upsert` transforma chave ausente em `NULL`.** Em `services/pgShim.js:293`, as colunas do INSERT são a **união** das chaves de todas as linhas, e `row[c] === undefined ? null : row[c]`. Um lote em que algumas linhas têm `ativo` e outras não gera `ativo = NULL` nas que não têm — e `ativo` é `NOT NULL`. O statement inteiro morre.
→ **Regra:** `ativo` vai em **todas** as linhas ou em **nenhuma**. Nunca misture. (É o P3-14 do backlog.)

**2. Não existe transação.** Nenhum `BEGIN`/`COMMIT`, nenhum `pool.connect()`. A atomicidade vem de o upsert ser **um único statement**. Se alguém trocar por um laço de `insert` por linha, o lote deixa de ser tudo-ou-nada em silêncio. A Tarefa 9 tem um teste que trava isso.

**3. Sigla repetida aborta o upsert.** `services/dataWriter.js:89` documenta: *"ON CONFLICT DO UPDATE command cannot affect row a second time"*. Duplicata tem de virar erro **antes** de montar SQL.

**Como rodar os testes:** `node --test` (suíte inteira, ~14s) ou `node --test test/arquivo.test.js`. A suíte tem de ficar verde — o hook `pre-push` bloqueia push com teste vermelho.

**Commits:** convenção do `CLAUDE.md`. Termine a mensagem com `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `services/equipesImport.js` **(novo)** | Regras de validação (movidas de `routes/index.js`) e `montarPlano` — a função pura que decide o destino de cada linha. Sem I/O. |
| `routes/index.js` **(modificar)** | Expor `setor` no GET; importar os validadores do módulo novo; acrescentar `POST /admin/equipes/importar`. |
| `public/index.html` **(modificar)** | `DSSJ` nos seletores; busca/filtro na lista; bloco de importação. |
| `test/equipesImport.test.js` **(novo)** | `montarPlano`, exaustivo. Sem banco. |
| `test/equipesImportRota.test.js` **(novo)** | Contrato da rota + forma do SQL gerado. |
| `test/equipesAdminTela.test.js` **(novo)** | Funções puras do front, extraídas e executadas. |

---

## Task 1: Expor `setor` no `GET /admin/equipes`

**Por que é a primeira:** `montarPlano` compara o cadastro atual com a planilha. Sem `setor` no payload, **toda** equipe existente apareceria como "setor mudando". A importação não funciona antes disto.

E conserta um defeito real: hoje a coluna "Setor" da tabela mostra `—` para todas, e o formulário cai no fallback `e.setor || (e.regional === 'CAC' ? 'DESC' : 'DESG')` (`public/index.html:9481`) e **reescreve o setor ao salvar** — DEPT vira DESG, DSSJ vira DESG.

**Files:**
- Modify: `routes/index.js:1975`
- Test: `test/equipesImportRota.test.js` (criar)

- [ ] **Step 1: Escrever o teste que falha**

Crie `test/equipesImportRota.test.js`:

```js
/**
 * test/equipesImportRota.test.js
 *
 * Contrato das rotas de equipes oficiais: o GET tem de devolver `setor`, e a
 * importação em lote tem de validar do lado que grava.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const ROTAS = fs.readFileSync(
  path.join(__dirname, '..', 'routes', 'index.js'), 'utf8');

test('GET /admin/equipes seleciona a coluna setor', () => {
  // Sem `setor` no SELECT, a tabela do Admin mostra "—" pra todas as equipes e
  // o formulário reescreve o setor ao salvar (fallback do index.html:9481).
  // E montarPlano veria TODA equipe existente como "setor mudando".
  const i = ROTAS.indexOf('const _COLS_BASE');
  assert.ok(i > -1, 'não achei _COLS_BASE em routes/index.js');
  const bloco = ROTAS.slice(i, i + 300);
  assert.ok(
    /\bsetor\b/.test(bloco),
    `_COLS_BASE precisa incluir "setor". Bloco atual:\n${bloco.slice(0, 200)}`
  );
});
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `node --test test/equipesImportRota.test.js`
Expected: FAIL — `_COLS_BASE precisa incluir "setor"`

- [ ] **Step 3: Implementar**

Em `routes/index.js`, localize:

```js
    const _COLS_BASE = 'sigla, regional, tipo, placa, ativo, escala_inicio, escala_fim, '
                     + 'created_at, updated_at';
```

Substitua por:

```js
    // `setor` entrou em 17/09/2026: sem ele a coluna Setor da tabela mostrava
    // "—" pra todas as equipes, e o formulário caía no fallback do
    // index.html:9481 (`e.setor || (regional==='CAC' ? 'DESC' : 'DESG')`) e
    // REESCREVIA o setor ao salvar — DEPT virava DESG, DSSJ virava DESG com
    // regional SJC. Também é pré-requisito do montarPlano: sem o setor atual,
    // toda equipe existente apareceria como "setor mudando" na prévia.
    const _COLS_BASE = 'sigla, setor, regional, tipo, placa, ativo, escala_inicio, escala_fim, '
                     + 'created_at, updated_at';
```

- [ ] **Step 4: Rodar e verificar que passa**

Run: `node --test test/equipesImportRota.test.js`
Expected: PASS — 1 teste

- [ ] **Step 5: Rodar a suíte inteira**

Run: `node --test`
Expected: 0 falhas

- [ ] **Step 6: Commit**

```bash
git add routes/index.js test/equipesImportRota.test.js
git commit -m "fix(admin): GET /admin/equipes nao devolvia setor — form reescrevia o campo

  A coluna Setor da tabela mostrava '—' pra todas as equipes, e o formulario
  caia no fallback do index.html:9481 e mandava o palpite no PUT: editar uma
  equipe DEPT a tornava DESG, e uma DSSJ virava DESG mantendo regional SJC.

  Tambem e pre-requisito da importacao em lote: sem o setor atual, montarPlano
  veria TODA equipe existente como 'setor mudando'.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Módulo puro — mover as regras de validação

**Files:**
- Create: `services/equipesImport.js`
- Modify: `routes/index.js:1856-1876`
- Test: `test/equipesImport.test.js` (criar)

- [ ] **Step 1: Escrever o teste que falha**

Crie `test/equipesImport.test.js`:

```js
/**
 * test/equipesImport.test.js
 *
 * `montarPlano` e as regras de validação de equipe oficial.
 *
 * Função pura: sem banco, sem DOM, sem rede. É onde mora toda a decisão da
 * importação em lote — ver docs/handoff/SPEC-import-equipes-2026-09-17.md.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { validateEquipe, MAX_LINHAS } = require('../services/equipesImport');

test('validateEquipe aceita uma equipe completa e válida', () => {
  const erros = validateEquipe({
    sigla: 'EBGPR62', setor: 'DESG', regional: 'GUA',
    tipo: 'BTZERO', placa: 'ABC-1234',
  });
  assert.deepEqual(erros, []);
});

test('validateEquipe recusa sigla curta, setor e regional inválidos', () => {
  const erros = validateEquipe({
    sigla: 'EB', setor: 'XXXX', regional: 'ZZZ', tipo: 'BTZERO',
  });
  assert.equal(erros.length, 3);
  assert.ok(erros.some(e => /sigla/.test(e)));
  assert.ok(erros.some(e => /setor/.test(e)));
  assert.ok(erros.some(e => /regional/.test(e)));
});

test('validateEquipe aceita DSSJ como setor', () => {
  const erros = validateEquipe({
    sigla: 'ESJSP01', setor: 'DSSJ', regional: 'SJC', tipo: 'COMERCIAL',
  });
  assert.deepEqual(erros, []);
});

test('validateEquipe trata placa como opcional', () => {
  assert.deepEqual(validateEquipe({
    sigla: 'EBGPR62', setor: 'DESG', regional: 'GUA', tipo: 'CS',
  }), []);
});

test('MAX_LINHAS é 500', () => {
  assert.equal(MAX_LINHAS, 500);
});
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `node --test test/equipesImport.test.js`
Expected: FAIL — `Cannot find module '../services/equipesImport'`

- [ ] **Step 3: Criar o módulo**

Crie `services/equipesImport.js`:

```js
/**
 * services/equipesImport.js
 *
 * Importação de equipes oficiais a partir de planilha, e as regras de
 * validação de equipe — que viviam em routes/index.js:1856 e vieram pra cá
 * em 17/09/2026 pra existirem UMA vez só (a rota passa a importar daqui).
 *
 * Tudo aqui é PURO: sem banco, sem DOM, sem rede. A rota fina que envolve este
 * módulo está em routes/index.js (POST /admin/equipes/importar).
 *
 * Spec: docs/handoff/SPEC-import-equipes-2026-09-17.md
 */

'use strict';

const RE_SIGLA = /^[A-Z0-9]{4,12}$/i;
const RE_TIPO  = /^[A-Z0-9 ÁÉÍÓÚÃÕÇ-]{1,30}$/i;  // tipo é livre (operacional)
const RE_PLACA = /^[A-Z0-9 -]{4,16}$/i;
const RE_REG   = /^(GUA|CAC|SJC)$/;                // SJC adicionado 08/06/2026
const RE_SETOR = /^(DESG|DEPT|DESC|DSSJ)$/;        // DSSJ = CSD São José
const RE_TIME  = /^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

/**
 * Teto de linhas por lote. O cadastro tem ~138 equipes; um arquivo com
 * milhares de linhas é engano, não uso. Recusamos antes de montar SQL.
 */
const MAX_LINHAS = 500;

/** Validação de UMA equipe. Comportamento idêntico ao antigo _validateEquipe. */
function validateEquipe(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return ['body inválido'];
  if (!RE_SIGLA.test(body.sigla || ''))      errors.push('sigla inválida (4-12 alfanuméricos)');
  if (!RE_SETOR.test(body.setor || ''))      errors.push('setor deve ser DESG, DEPT, DESC ou DSSJ');
  if (!RE_REG.test(body.regional || ''))     errors.push('regional deve ser GUA, CAC ou SJC');
  if (!RE_TIPO.test(body.tipo || ''))        errors.push('tipo inválido (alfanumérico, máx 30)');
  // placa é opcional
  if (body.placa && !RE_PLACA.test(body.placa)) errors.push('placa inválida');
  // Escala opcional: aceita "HH:MM" ou "HH:MM:SS"
  if (body.escala_inicio && !RE_TIME.test(String(body.escala_inicio))) errors.push('escala_inicio inválido (use HH:MM)');
  if (body.escala_fim    && !RE_TIME.test(String(body.escala_fim)))    errors.push('escala_fim inválido (use HH:MM)');
  return errors;
}

module.exports = {
  validateEquipe,
  MAX_LINHAS,
  RE_SIGLA, RE_TIPO, RE_PLACA, RE_REG, RE_SETOR, RE_TIME,
};
```

- [ ] **Step 4: Rodar e verificar que passa**

Run: `node --test test/equipesImport.test.js`
Expected: PASS — 5 testes

- [ ] **Step 5: Fazer a rota usar o módulo**

Em `routes/index.js`, apague o bloco das linhas 1856-1876 (as cinco `const _RE_*` e a função `_validateEquipe` inteira) e ponha no lugar:

```js
// As regras de validação de equipe moram em services/equipesImport.js desde
// 17/09/2026 — a importação em lote precisa das MESMAS regras, e duas cópias
// divergiriam. Os nomes locais ficam pra não mexer nos 9 pontos que já usam.
const {
  validateEquipe: _validateEquipe,
  RE_SIGLA: _RE_SIGLA,
  RE_TIPO:  _RE_TIPO,
  RE_PLACA: _RE_PLACA,
  RE_REG:   _RE_REG,
  RE_SETOR: _RE_SETOR,
} = require('../services/equipesImport');
```

- [ ] **Step 6: Rodar a suíte inteira**

Run: `node --test`
Expected: 0 falhas. Se algo quebrar aqui, é sinal de que `_RE_*` era usado num
ponto que a busca não pegou — procure com `grep -n "_RE_" routes/index.js`.

- [ ] **Step 7: Commit**

```bash
git add services/equipesImport.js routes/index.js test/equipesImport.test.js
git commit -m "refactor(equipes): regras de validacao num modulo so

  A importacao em lote precisa das MESMAS regras que o POST/PUT de equipe
  unica. Duas copias divergiriam — a rota agora importa de
  services/equipesImport.js. Comportamento das rotas existentes: identico.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: `montarPlano` — novas, idênticas e alteradas

**Files:**
- Modify: `services/equipesImport.js`
- Test: `test/equipesImport.test.js`

- [ ] **Step 1: Escrever os testes que falham**

Acrescente ao fim de `test/equipesImport.test.js`:

```js
const { montarPlano } = require('../services/equipesImport');

/** Opções de lote válidas, para os testes não repetirem isso. */
const LOTE = { regional: 'GUA', setor: 'DESG', tipoPadrao: 'COMERCIAL' };

/** Uma equipe como o GET /admin/equipes devolve. */
function equipe(over = {}) {
  return {
    sigla: 'EBGPR62', setor: 'DESG', regional: 'GUA',
    tipo: 'BTZERO', placa: 'ABC-1234', ativo: true, ...over,
  };
}

test('sigla que não existe no cadastro vira "nova"', () => {
  const p = montarPlano(
    [{ linhaPlanilha: 2, sigla: 'ENOVA01', tipo: 'CS', placa: 'XYZ-9999' }],
    [], LOTE);

  assert.equal(p.novas.length, 1);
  assert.equal(p.alteradas.length, 0);
  assert.equal(p.identicas, 0);
  assert.deepEqual(p.erros, []);
  assert.deepEqual(p.novas[0], {
    linhaPlanilha: 2, sigla: 'ENOVA01', setor: 'DESG',
    regional: 'GUA', tipo: 'CS', placa: 'XYZ-9999',
  });
});

test('sigla existente com tudo igual conta como idêntica, não alterada', () => {
  const p = montarPlano(
    [{ linhaPlanilha: 2, sigla: 'EBGPR62', tipo: 'BTZERO', placa: 'ABC-1234' }],
    [equipe()], LOTE);

  assert.equal(p.identicas, 1);
  assert.equal(p.alteradas.length, 0);
  assert.equal(p.novas.length, 0);
});

test('só a placa muda → alterada, com SÓ o campo placa em mudancas', () => {
  const p = montarPlano(
    [{ linhaPlanilha: 2, sigla: 'EBGPR62', tipo: 'BTZERO', placa: 'NOV-0001' }],
    [equipe()], LOTE);

  assert.equal(p.alteradas.length, 1);
  assert.deepEqual(p.alteradas[0].mudancas, [
    { campo: 'placa', de: 'ABC-1234', para: 'NOV-0001' },
  ]);
});

test('equipe no cadastro e AUSENTE da planilha não aparece em lugar nenhum', () => {
  // Trava a §3.1 do spec: a importação NUNCA desativa. Pelo P2-20, a leitura do
  // histórico usa a whitelist de HOJE — desativar apaga produção já reportada
  // à EDP. Planilha chega incompleta; isso não pode virar exclusão.
  const p = montarPlano(
    [{ linhaPlanilha: 2, sigla: 'ENOVA01', tipo: 'CS', placa: null }],
    [equipe({ sigla: 'EANTIGA9' })], LOTE);

  assert.equal(p.novas.length, 1);
  assert.equal(p.alteradas.length, 0);
  assert.equal(p.identicas, 0);
  const todas = JSON.stringify(p);
  assert.ok(!todas.includes('EANTIGA9'), 'a equipe ausente da planilha vazou pro plano');
});

test('normaliza minúsculas e espaços nas pontas', () => {
  const p = montarPlano(
    [{ linhaPlanilha: 2, sigla: '  enova01 ', tipo: ' cs ', placa: ' xyz-9999 ' }],
    [], LOTE);

  assert.equal(p.novas[0].sigla, 'ENOVA01');
  assert.equal(p.novas[0].tipo, 'CS');
  assert.equal(p.novas[0].placa, 'XYZ-9999');
});

test('célula de tipo vazia usa o tipo padrão do lote', () => {
  const p = montarPlano(
    [{ linhaPlanilha: 2, sigla: 'ENOVA01', tipo: '', placa: null }],
    [], LOTE);

  assert.equal(p.novas[0].tipo, 'COMERCIAL');
});

test('placa vazia vira null, não string vazia', () => {
  const p = montarPlano(
    [{ linhaPlanilha: 2, sigla: 'ENOVA01', tipo: 'CS', placa: '  ' }],
    [], LOTE);

  assert.equal(p.novas[0].placa, null);
});

test('linha inteiramente vazia é descartada sem virar erro', () => {
  // Planilha tem linha em branco no fim. Isso não é problema do usuário.
  const p = montarPlano(
    [{ linhaPlanilha: 9, sigla: '', tipo: '', placa: '' }],
    [], LOTE);

  assert.deepEqual(p.erros, []);
  assert.equal(p.novas.length, 0);
});
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `node --test test/equipesImport.test.js`
Expected: FAIL — `montarPlano is not a function`

- [ ] **Step 3: Implementar**

Em `services/equipesImport.js`, antes do `module.exports`, acrescente:

```js
/** Normaliza célula de planilha: string, sem espaço nas bordas, maiúscula. */
function _norm(v) {
  return String(v === null || v === undefined ? '' : v).trim().toUpperCase();
}

/**
 * Decide o destino de cada linha da planilha. PURA.
 *
 * @param {Array}  linhas         [{ linhaPlanilha, sigla, tipo, placa }]
 * @param {Array}  equipesAtuais  como o GET /admin/equipes devolve
 * @param {object} opts           { regional, setor, tipoPadrao, reativar }
 * @returns {{novas:Array, alteradas:Array, identicas:number,
 *            inativas:Array, erros:Array}}
 */
function montarPlano(linhas, equipesAtuais, opts = {}) {
  const { regional, setor, tipoPadrao, reativar = false } = opts;
  const out = { novas: [], alteradas: [], identicas: 0, inativas: [], erros: [] };

  const atuais = new Map();
  (equipesAtuais || []).forEach(e => atuais.set(_norm(e.sigla), e));

  const vistas = new Map();   // sigla → linhaPlanilha da 1ª ocorrência

  for (const l of (linhas || [])) {
    const linhaPlanilha = l && l.linhaPlanilha;
    const siglaCrua = l && l.sigla;
    const sigla     = _norm(siglaCrua);
    const tipoCrua  = _norm(l && l.tipo);
    const tipo      = tipoCrua || _norm(tipoPadrao);
    const placaCrua = _norm(l && l.placa);
    const placa     = placaCrua || null;

    // Linha inteiramente vazia: planilha tem linha em branco no fim.
    if (!sigla && !tipoCrua && !placaCrua) continue;

    const erro = (campo, valor, motivo) =>
      out.erros.push({ linhaPlanilha, siglaCrua: siglaCrua || null, campo, valor, motivo });

    if (!RE_SIGLA.test(sigla)) {
      erro('sigla', siglaCrua, `sigla precisa ter de 4 a 12 letras ou números (leu ${sigla.length})`);
      continue;
    }
    if (vistas.has(sigla)) {
      erro(null, null, `sigla repetida: já aparece na linha ${vistas.get(sigla)} desta planilha`);
      continue;
    }
    vistas.set(sigla, linhaPlanilha);

    if (!RE_TIPO.test(tipo)) {
      erro('tipo', tipoCrua || tipoPadrao, 'tipo inválido (alfanumérico, máx 30)');
      continue;
    }
    if (placa && !RE_PLACA.test(placa)) {
      erro('placa', l && l.placa, `placa inválida (4 a 16 letras, números, espaço ou hífen — leu ${placa.length})`);
      continue;
    }

    const atual = atuais.get(sigla);

    if (!atual) {
      out.novas.push({ linhaPlanilha, sigla, setor, regional, tipo, placa });
      continue;
    }

    if (atual.ativo === false) out.inativas.push({ linhaPlanilha, sigla });

    const mudancas = [];
    const cmp = (campo, de, para) => {
      if (de !== para) mudancas.push({ campo, de, para });
    };
    cmp('setor',    _norm(atual.setor)    || null, setor);
    cmp('regional', _norm(atual.regional) || null, regional);
    cmp('tipo',     _norm(atual.tipo)     || null, tipo);
    cmp('placa',    _norm(atual.placa)    || null, placa);
    if (reativar && atual.ativo === false) mudancas.push({ campo: 'ativo', de: false, para: true });

    if (mudancas.length === 0) out.identicas++;
    else out.alteradas.push({ linhaPlanilha, sigla, setor, regional, tipo, placa, mudancas });
  }

  return out;
}
```

E acrescente `montarPlano` ao `module.exports`:

```js
module.exports = {
  validateEquipe,
  montarPlano,
  MAX_LINHAS,
  RE_SIGLA, RE_TIPO, RE_PLACA, RE_REG, RE_SETOR, RE_TIME,
};
```

- [ ] **Step 4: Rodar e verificar que passa**

Run: `node --test test/equipesImport.test.js`
Expected: PASS — 13 testes

- [ ] **Step 5: Commit**

```bash
git add services/equipesImport.js test/equipesImport.test.js
git commit -m "feat(equipes): montarPlano — novas, identicas e alteradas

  Funcao pura que decide o destino de cada linha da planilha. Equipe ausente
  da planilha NAO entra no plano (spec 3.1): pelo P2-20 a leitura do historico
  usa a whitelist de hoje, entao desativar apagaria producao ja reportada.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: `montarPlano` — erros que apontam a linha

**Exigência explícita do José:** *"tem que indicar quais linhas estão erradas"*.

**Files:**
- Modify: `services/equipesImport.js` (só o teto de linhas; o resto já veio na Task 3)
- Test: `test/equipesImport.test.js`

- [ ] **Step 1: Escrever os testes que falham**

Acrescente ao fim de `test/equipesImport.test.js`:

```js
test('sigla curta vira erro com linha, valor lido e motivo', () => {
  const p = montarPlano(
    [{ linhaPlanilha: 7, sigla: 'EBG', tipo: 'CS', placa: null }],
    [], LOTE);

  assert.equal(p.erros.length, 1);
  assert.equal(p.erros[0].linhaPlanilha, 7, 'o número tem de ser o do Excel');
  assert.equal(p.erros[0].campo, 'sigla');
  assert.equal(p.erros[0].valor, 'EBG', 'o valor lido tem de aparecer');
  assert.match(p.erros[0].motivo, /4 a 12/);
});

test('sigla repetida no arquivo erra e aponta a linha anterior', () => {
  // Não é preciosismo: dataWriter.js:89 documenta que o Postgres aborta o
  // upsert inteiro com "ON CONFLICT DO UPDATE command cannot affect row a
  // second time". Sem pegar aqui, o lote de 40 linhas morre por causa de 2.
  const p = montarPlano([
    { linhaPlanilha: 9,  sigla: 'ECGPR51', tipo: 'COMERCIAL', placa: null },
    { linhaPlanilha: 12, sigla: 'ECGPR51', tipo: 'COMERCIAL', placa: null },
  ], [], LOTE);

  assert.equal(p.novas.length, 1, 'a primeira ocorrência entra');
  assert.equal(p.erros.length, 1);
  assert.equal(p.erros[0].linhaPlanilha, 12);
  assert.match(p.erros[0].motivo, /linha 9/, 'tem de citar a linha da 1ª ocorrência');
});

test('placa inválida vira erro sem derrubar as outras linhas', () => {
  const p = montarPlano([
    { linhaPlanilha: 2,  sigla: 'EBOA0001', tipo: 'CS', placa: 'ABC-1234' },
    { linhaPlanilha: 19, sigla: 'EMGPR70',  tipo: 'CS', placa: 'A-1' },
    { linhaPlanilha: 20, sigla: 'EBOA0002', tipo: 'CS', placa: 'DEF-5678' },
  ], [], LOTE);

  assert.equal(p.novas.length, 2, 'as linhas boas seguem');
  assert.equal(p.erros.length, 1);
  assert.equal(p.erros[0].linhaPlanilha, 19);
  assert.equal(p.erros[0].campo, 'placa');
  assert.equal(p.erros[0].valor, 'A-1');
});

test('lote acima de MAX_LINHAS é recusado inteiro', () => {
  const muitas = Array.from({ length: MAX_LINHAS + 1 }, (_, i) => ({
    linhaPlanilha: i + 2,
    sigla: `E${String(i).padStart(6, '0')}`,
    tipo: 'CS', placa: null,
  }));
  const p = montarPlano(muitas, [], LOTE);

  assert.equal(p.novas.length, 0);
  assert.equal(p.erros.length, 1);
  assert.match(p.erros[0].motivo, /500/);
});

test('regional ou setor de lote inválidos recusam o lote inteiro', () => {
  const p = montarPlano(
    [{ linhaPlanilha: 2, sigla: 'ENOVA01', tipo: 'CS', placa: null }],
    [], { regional: 'ZZZ', setor: 'DESG', tipoPadrao: 'CS' });

  assert.equal(p.novas.length, 0);
  assert.equal(p.erros.length, 1);
  assert.match(p.erros[0].motivo, /regional/i);
});

test('tipo padrão ausente recusa o lote (tipo é NOT NULL no schema)', () => {
  const p = montarPlano(
    [{ linhaPlanilha: 2, sigla: 'ENOVA01', tipo: '', placa: null }],
    [], { regional: 'GUA', setor: 'DESG', tipoPadrao: '' });

  assert.equal(p.novas.length, 0);
  assert.equal(p.erros.length, 1);
  assert.match(p.erros[0].motivo, /tipo padrão/i);
});
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `node --test test/equipesImport.test.js`
Expected: FAIL nos 3 últimos (teto e validação de lote ainda não existem)

- [ ] **Step 3: Implementar a validação de lote**

Em `services/equipesImport.js`, dentro de `montarPlano`, logo depois da linha
`const out = { ... };`, insira:

```js
  // Validação do LOTE: um erro aqui invalida tudo, então sai cedo. Repare que
  // o erro não tem `linhaPlanilha` — não é de linha, é da configuração.
  const loteErro = (motivo) => {
    out.erros.push({ linhaPlanilha: null, siglaCrua: null, campo: null, valor: null, motivo });
    return out;
  };
  if (!RE_REG.test(regional || ''))   return loteErro('regional do lote inválida (use GUA, CAC ou SJC)');
  if (!RE_SETOR.test(setor || ''))    return loteErro('setor do lote inválido (use DESG, DEPT, DESC ou DSSJ)');
  if (!RE_TIPO.test(_norm(tipoPadrao))) {
    return loteErro('tipo padrão é obrigatório: `tipo` é NOT NULL no schema, '
      + 'e célula de tipo vazia precisa de um valor pra onde cair');
  }
  if ((linhas || []).length > MAX_LINHAS) {
    return loteErro(`lote tem ${linhas.length} linhas; o máximo é ${MAX_LINHAS}. `
      + 'O cadastro tem ~138 equipes — um arquivo maior que isso é engano.');
  }
```

- [ ] **Step 4: Rodar e verificar que passa**

Run: `node --test test/equipesImport.test.js`
Expected: PASS — 19 testes

- [ ] **Step 5: Commit**

```bash
git add services/equipesImport.js test/equipesImport.test.js
git commit -m "feat(equipes): erros do plano apontam a linha, o valor e o motivo

  Exigencia do Jose em 17/09: "tem que indicar quais linhas estao erradas".
  Cada erro carrega linhaPlanilha (numero do Excel), o valor cru lido e o
  motivo. Sigla repetida cita a linha da primeira ocorrencia — sem isso o
  Postgres abortaria o upsert inteiro (dataWriter.js:89) com mensagem inutil.

  Linha ruim nao derruba o lote: as boas seguem.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: `montarPlano` — inativas e o payload do upsert

**A armadilha:** `pgShim.upsert` põe `null` onde a chave falta (`services/pgShim.js:294`), e `ativo` é `NOT NULL`. Portanto `ativo` vai em **todas** as linhas ou em **nenhuma**.

**Files:**
- Modify: `services/equipesImport.js`
- Test: `test/equipesImport.test.js`

- [ ] **Step 1: Escrever os testes que falham**

Acrescente ao fim de `test/equipesImport.test.js`:

```js
const { linhasParaUpsert } = require('../services/equipesImport');

test('sigla inativa presente na planilha cai em `inativas`', () => {
  const p = montarPlano(
    [{ linhaPlanilha: 2, sigla: 'EBGPR62', tipo: 'BTZERO', placa: 'ABC-1234' }],
    [equipe({ ativo: false })], LOTE);

  assert.equal(p.inativas.length, 1);
  assert.equal(p.inativas[0].sigla, 'EBGPR62');
});

test('sem reativar, o payload NÃO contém a chave ativo em nenhuma linha', () => {
  // Spec 3.3: linha nova pega o DEFAULT true do schema; linha existente mantém
  // o valor. Reativar mexe em número reportado (P2-20 ao contrário) e é decisão.
  const p = montarPlano([
    { linhaPlanilha: 2, sigla: 'EBGPR62', tipo: 'BTZERO', placa: 'NOV-0001' },
    { linhaPlanilha: 3, sigla: 'ENOVA01', tipo: 'CS',     placa: null },
  ], [equipe({ ativo: false })], { ...LOTE, reativar: false });

  const rows = linhasParaUpsert(p, { reativar: false });
  assert.equal(rows.length, 2);
  rows.forEach(r => assert.ok(!('ativo' in r), 'nenhuma linha pode trazer `ativo`'));
});

test('com reativar, TODAS as linhas trazem ativo:true — nunca um lote misto', () => {
  // pgShim.upsert monta as colunas pela UNIÃO das chaves e põe null onde falta
  // (services/pgShim.js:294). Como `ativo` é NOT NULL, lote misto derruba o
  // statement inteiro. É o P3-14 do backlog.
  const p = montarPlano([
    { linhaPlanilha: 2, sigla: 'EBGPR62', tipo: 'BTZERO', placa: 'ABC-1234' },
    { linhaPlanilha: 3, sigla: 'ENOVA01', tipo: 'CS',     placa: null },
  ], [equipe({ ativo: false })], { ...LOTE, reativar: true });

  const rows = linhasParaUpsert(p, { reativar: true });
  assert.equal(rows.length, 2);
  rows.forEach(r => assert.equal(r.ativo, true, 'todas as linhas têm de trazer ativo'));

  const chaves = new Set(rows.flatMap(r => Object.keys(r)));
  rows.forEach(r => assert.equal(
    Object.keys(r).length, chaves.size,
    'todas as linhas têm de ter EXATAMENTE as mesmas chaves'));
});

test('linhasParaUpsert junta novas e alteradas, e ignora idênticas e erros', () => {
  const p = montarPlano([
    { linhaPlanilha: 2, sigla: 'EBGPR62', tipo: 'BTZERO', placa: 'NOV-0001' }, // alterada
    { linhaPlanilha: 3, sigla: 'ENOVA01', tipo: 'CS',     placa: null },       // nova
    { linhaPlanilha: 4, sigla: 'EIGUAL1', tipo: 'CS',     placa: null },       // idêntica
    { linhaPlanilha: 5, sigla: 'EB',      tipo: 'CS',     placa: null },       // erro
  ], [
    equipe(),
    equipe({ sigla: 'EIGUAL1', tipo: 'CS', placa: null }),
  ], LOTE);

  const rows = linhasParaUpsert(p, { reativar: false });
  const siglas = rows.map(r => r.sigla).sort();
  assert.deepEqual(siglas, ['EBGPR62', 'ENOVA01']);
});

test('toda linha do upsert carrega as colunas do schema, com updated_at', () => {
  const p = montarPlano(
    [{ linhaPlanilha: 2, sigla: 'ENOVA01', tipo: 'CS', placa: null }],
    [], LOTE);

  const [row] = linhasParaUpsert(p, { reativar: false });
  assert.deepEqual(Object.keys(row).sort(),
    ['placa', 'regional', 'setor', 'sigla', 'tipo', 'updated_at']);
  assert.ok(!Number.isNaN(Date.parse(row.updated_at)));
});
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `node --test test/equipesImport.test.js`
Expected: FAIL — `linhasParaUpsert is not a function`

- [ ] **Step 3: Implementar**

Em `services/equipesImport.js`, antes do `module.exports`:

```js
/**
 * Converte o plano nas linhas do upsert. Novas + alteradas; idênticas e erros
 * ficam de fora.
 *
 * ⚠️ TODAS as linhas devolvidas têm EXATAMENTE as mesmas chaves. O
 * `pgShim.upsert` monta as colunas do INSERT pela UNIÃO das chaves de todas as
 * linhas e põe `null` onde a chave falta (services/pgShim.js:294). Como `ativo`
 * é NOT NULL no schema, um lote misto — algumas linhas com `ativo`, outras sem
 * — derrubaria o statement inteiro. É a armadilha do P3-14.
 *
 * Por isso `ativo` entra em todas as linhas (quando reativar) ou em nenhuma.
 * Com `reativar: true`, marcar ativo=true no lote inteiro é correto: quem já
 * estava ativo não muda, e quem estava inativo é exatamente quem se quer de
 * volta. Equipe fora da planilha não entra no upsert, então não é tocada.
 */
function linhasParaUpsert(plano, opts = {}) {
  const { reativar = false } = opts;
  const agora = new Date().toISOString();

  return [...(plano.novas || []), ...(plano.alteradas || [])].map(e => {
    const row = {
      sigla:      e.sigla,
      setor:      e.setor,
      regional:   e.regional,
      tipo:       e.tipo,
      placa:      e.placa,
      updated_at: agora,
    };
    if (reativar) row.ativo = true;
    return row;
  });
}
```

E acrescente ao `module.exports`: `linhasParaUpsert,`

- [ ] **Step 4: Rodar e verificar que passa**

Run: `node --test test/equipesImport.test.js`
Expected: PASS — 24 testes

- [ ] **Step 5: Commit**

```bash
git add services/equipesImport.js test/equipesImport.test.js
git commit -m "feat(equipes): payload do upsert homogeneo + categoria de inativas

  Equipe inativa que reaparece na planilha nao reativa sozinha (spec 3.3):
  vira categoria propria no plano, e so com reativar:true o ativo entra.

  E entra em TODAS as linhas ou em NENHUMA: o pgShim monta as colunas pela
  uniao das chaves e poe null onde falta (pgShim.js:294); como ativo e NOT
  NULL, lote misto derrubaria o statement inteiro. Armadilha do P3-14.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Rota `POST /admin/equipes/importar`

**Files:**
- Modify: `routes/index.js` (logo após o `POST /admin/equipes`, ~linha 2040)
- Test: `test/equipesImportRota.test.js`

- [ ] **Step 1: Escrever os testes que falham**

Acrescente ao fim de `test/equipesImportRota.test.js`:

```js
test('a rota de importação existe e fica sob /admin (requireAdmin)', () => {
  assert.ok(
    ROTAS.includes("router.post('/admin/equipes/importar'"),
    'não achei POST /admin/equipes/importar em routes/index.js'
  );
  // O guard é o router.use('/admin', requireAdmin) da linha 178 — qualquer
  // rota sob /admin herda. Este teste trava o prefixo: mudar pra /equipes/...
  // tiraria a rota de baixo do guard sem ninguém notar.
  assert.ok(ROTAS.includes("router.use('/admin', requireAdmin)"));
});

test('o apply RECALCULA o plano — não confia no que o cliente mandou', () => {
  const i = ROTAS.indexOf("router.post('/admin/equipes/importar'");
  const bloco = ROTAS.slice(i, i + 2600);
  assert.ok(
    bloco.includes('montarPlano('),
    'o handler tem de chamar montarPlano no servidor, nas duas fases'
  );
  assert.ok(
    !/req\.body\.plano/.test(bloco),
    'o handler não pode usar um plano vindo do cliente'
  );
});

test('dryRun é o padrão seguro: só grava com dryRun === false explícito', () => {
  const i = ROTAS.indexOf("router.post('/admin/equipes/importar'");
  const bloco = ROTAS.slice(i, i + 2600);
  assert.ok(
    /dryRun\s*!==\s*false/.test(bloco),
    'payload sem dryRun tem de cair na prévia, nunca na gravação'
  );
});

test('a gravação é UM upsert, não um laço de inserts', () => {
  // É o que sustenta a atomicidade: o pgShim não tem transação (nenhum BEGIN,
  // nenhum pool.connect), então o lote só é tudo-ou-nada por ser um statement
  // único. Trocar por N inserts quebraria isso em silêncio.
  const i = ROTAS.indexOf("router.post('/admin/equipes/importar'");
  const bloco = ROTAS.slice(i, i + 2600);
  assert.ok(bloco.includes(".upsert(rows, { onConflict: 'sigla' })"));
  assert.ok(!/for\s*\(.*\)\s*\{[^}]*\.insert\(/s.test(bloco),
    'não pode existir laço de insert por linha');
});

test('a importação chama forceRefresh depois de gravar', () => {
  const i = ROTAS.indexOf("router.post('/admin/equipes/importar'");
  const bloco = ROTAS.slice(i, i + 2600);
  assert.ok(bloco.includes('forceRefresh'),
    'sem isso o cache de 60s serve a whitelist velha depois da importação');
});
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `node --test test/equipesImportRota.test.js`
Expected: FAIL — `não achei POST /admin/equipes/importar`

- [ ] **Step 3: Implementar**

Em `routes/index.js`, logo **depois** do bloco `router.post('/admin/equipes', …)`
(que termina por volta da linha 2039), insira:

```js
// POST /api/admin/equipes/importar — cadastro em lote a partir de planilha
//
// Serve as DUAS fases pela mesma porta: `dryRun: true` devolve o plano e para;
// `dryRun: false` grava. Assim a validação existe uma vez só.
//
// Atomicidade: o pgShim não tem transação (nenhum BEGIN/COMMIT, nenhum
// pool.connect — é por isso que o P1-11 segue pendente). Não precisamos: o
// upsert monta UM único INSERT ... ON CONFLICT (sigla) DO UPDATE, e um
// statement é atômico por definição no Postgres. O lote inteiro entra ou nada
// entra. NÃO troque por um laço de inserts.
//
// Spec: docs/handoff/SPEC-import-equipes-2026-09-17.md
router.post('/admin/equipes/importar', async (req, res) => {
  try {
    // Validação de forma ANTES da checagem de banco: é barata, e sem essa ordem
    // um payload malformado responderia 503 em vez de 400 (e o teste de
    // contrato HTTP, que roda em DATA_MODE=mock, não conseguiria distinguir).
    const body = req.body || {};
    const { dryRun, regional, setor, tipoPadrao, reativar, linhas } = body;
    if (!Array.isArray(linhas)) {
      return res.status(400).json({ error: 'linhas deve ser um array' });
    }

    const sq = sbq();
    if (!sq) return res.status(503).json({ error: 'Supabase indisponível' });

    const { montarPlano, linhasParaUpsert } = require('../services/equipesImport');
    const sb = require('../services/dbClient').getClient();

    const { data: atuais, error } = await sb
      .from('equipes_oficiais')
      .select('sigla, setor, regional, tipo, placa, ativo');
    if (error) throw error;

    // Recalculado SEMPRE no servidor, nas duas fases. O cliente pode mandar
    // qualquer coisa; a validação tem de estar do lado que grava.
    const plano = montarPlano(linhas, atuais || [], {
      regional, setor, tipoPadrao, reativar: !!reativar,
    });

    // Padrão seguro: só grava com `dryRun === false` explícito. Payload sem o
    // campo cai na prévia.
    if (dryRun !== false) return res.json({ plano });

    const rows = linhasParaUpsert(plano, { reativar: !!reativar });
    if (rows.length === 0) {
      return res.json({ ok: true, gravadas: 0, ignoradas: plano.erros.length, plano });
    }

    const { error: upErr } = await sb
      .from('equipes_oficiais')
      .upsert(rows, { onConflict: 'sigla' });
    if (upErr) throw upErr;

    // Invalida o cache em memória (TTL de 60s), como o POST de equipe única faz.
    const { forceRefresh } = require('../services/equipesOficiais');
    await forceRefresh();

    res.json({
      ok: true,
      gravadas:  rows.length,
      novas:     plano.novas.length,
      alteradas: plano.alteradas.length,
      identicas: plano.identicas,
      ignoradas: plano.erros.length,
      plano,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Rodar e verificar que passa**

Run: `node --test test/equipesImportRota.test.js`
Expected: PASS — 6 testes

- [ ] **Step 5: Rodar a suíte inteira**

Run: `node --test`
Expected: 0 falhas

- [ ] **Step 6: Commit**

```bash
git add routes/index.js test/equipesImportRota.test.js
git commit -m "feat(equipes): POST /admin/equipes/importar — previa e gravacao em lote

  Mesma porta pras duas fases (dryRun), entao a validacao existe uma vez so.
  O plano e SEMPRE recalculado no servidor: o cliente nao manda plano.
  dryRun e o padrao seguro — payload sem o campo cai na previa.

  Grava com UM upsert unico: o pgShim nao tem transacao, e a atomicidade vem
  de ser um statement so. Ha teste travando isso.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6b: Contrato HTTP da rota (401 / 403 / 400)

**Por que é tarefa própria:** os testes da Task 6 leem o código-fonte, o que
prova a forma mas não o comportamento. O spec §9 pede 401/403/400 de verdade.
O harness já existe em `test/routes.test.js`: sobe o app real em porta aleatória
com `DATA_MODE=mock` e bate com `fetch`. Arquivo separado porque os hooks
`before`/`after` são do arquivo inteiro.

**Files:**
- Create: `test/equipesImportHttp.test.js`

- [ ] **Step 1: Escrever os testes que falham**

```js
/**
 * test/equipesImportHttp.test.js
 *
 * Contrato HTTP de POST /api/admin/equipes/importar — a rota grava cadastro
 * que muda número reportado, então quem pode chamá-la importa tanto quanto o
 * que ela faz.
 *
 * Sobe o app real em porta aleatória, no molde do test/routes.test.js. Roda em
 * DATA_MODE=mock: não exercita o caminho de banco (isso é o
 * test/equipesImport.test.js, sobre a função pura), só o portão.
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Env ANTES de importar o app — middleware/auth lê no load, e NODE_ENV=test
// desliga o override do dotenv (senão o .env da VM clobba estas credenciais).
process.env.NODE_ENV   = 'test';
process.env.DATA_MODE  = 'mock';
process.env.JWT_SECRET = 'test-secret-import';
process.env.AUTH_USERS = [
  `admin:${sha256('adminpass')}:admin:GUA|CAC|SJC`,
  `guarapari:${sha256('guapass')}:user:GUA`,
].join(',');

const app = require('../server');

let server, base;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => { if (server) server.close(); });

async function post(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res  = await fetch(base + path, {
    method: 'POST', headers, body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function loginAs(username, password) {
  const { json } = await post('/api/auth/login', { username, password });
  return json.token;
}

const CORPO_OK = {
  dryRun: true, regional: 'GUA', setor: 'DESG', tipoPadrao: 'CS', linhas: [],
};

test('sem token → 401', async () => {
  const { status } = await post('/api/admin/equipes/importar', CORPO_OK);
  assert.equal(status, 401);
});

test('usuário não-admin → 403', async () => {
  // A rota grava whitelist, que decide o que entra no número reportado à EDP.
  // O portão é o router.use('/admin', requireAdmin).
  const token = await loginAs('guarapari', 'guapass');
  const { status } = await post('/api/admin/equipes/importar', CORPO_OK, token);
  assert.equal(status, 403);
});

test('admin com `linhas` ausente → 400, não 500', async () => {
  const token = await loginAs('admin', 'adminpass');
  const { status, json } = await post('/api/admin/equipes/importar',
    { dryRun: true, regional: 'GUA', setor: 'DESG', tipoPadrao: 'CS' }, token);
  assert.equal(status, 400);
  assert.match(json.error, /linhas/);
});

test('admin com `linhas` que não é array → 400', async () => {
  const token = await loginAs('admin', 'adminpass');
  const { status } = await post('/api/admin/equipes/importar',
    { ...CORPO_OK, linhas: 'EBGPR62' }, token);
  assert.equal(status, 400);
});
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `node --test test/equipesImportHttp.test.js`
Expected: FAIL nos dois últimos — hoje a rota responderia 503 (mock não tem
banco) antes de olhar o payload. Os de 401/403 devem passar já, porque o guard
é o `router.use('/admin', requireAdmin)` que já existe.

- [ ] **Step 3: Confirmar a ordem no handler**

A Task 6 já põe a validação de `linhas` **antes** do `sbq()`. Se os testes de
400 falharem, é porque essa ordem se perdeu — conserte em `routes/index.js`,
movendo o bloco `if (!Array.isArray(linhas))` para antes de `const sq = sbq();`.

- [ ] **Step 4: Rodar e verificar que passa**

Run: `node --test test/equipesImportHttp.test.js`
Expected: PASS — 4 testes

- [ ] **Step 5: Rodar a suíte inteira**

Run: `node --test`
Expected: 0 falhas

- [ ] **Step 6: Commit**

```bash
git add test/equipesImportHttp.test.js
git commit -m "test(equipes): contrato HTTP da rota de importacao — 401, 403 e 400

  Os testes da tarefa anterior leem o codigo-fonte: provam a forma, nao o
  comportamento. Estes sobem o app real e batem com fetch, no molde do
  routes.test.js. A rota grava whitelist, que decide o que entra no numero
  reportado a EDP — quem pode chama-la importa tanto quanto o que ela faz.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Front — `DSSJ` nos seletores de setor

**Files:**
- Modify: `public/index.html:9492`
- Modify: `public/index.html:9543` (`_setorChanged`)
- Test: `test/equipesAdminTela.test.js` (criar)

- [ ] **Step 1: Escrever o teste que falha**

Crie `test/equipesAdminTela.test.js`:

```js
/**
 * test/equipesAdminTela.test.js
 *
 * Tela de Equipes Oficiais no Admin. Não há harness de frontend (risco H11),
 * então valem as invariantes estruturais e as funções PURAS, que são extraídas
 * do index.html e executadas — no estilo do test/healthCardErro.test.js.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** Extrai o corpo de uma função do index.html casando as chaves. */
function extrairFuncao(nome) {
  const marca = `function ${nome}(`;
  const ini   = SRC.indexOf(marca);
  assert.ok(ini > -1, `não achei ${marca} no index.html`);
  const abre = SRC.indexOf('{', ini);
  let nivel = 0;
  for (let i = abre; i < SRC.length; i++) {
    if (SRC[i] === '{') nivel++;
    else if (SRC[i] === '}') { nivel--; if (nivel === 0) return SRC.slice(ini, i + 1); }
  }
  throw new Error(`chaves não fecharam em ${nome}`);
}

test('o seletor de setor oferece DSSJ', () => {
  // O banco e o validateEquipe aceitam DSSJ desde 08/06/2026, mas o select só
  // tinha DESG/DEPT/DESC — cadastrar equipe de SJC pela tela não funcionava.
  const i = SRC.indexOf('id="eq-form-setor"');
  assert.ok(i > -1, 'não achei o select de setor');
  const bloco = SRC.slice(i, SRC.indexOf('</select>', i));
  ['DESG', 'DEPT', 'DESC', 'DSSJ'].forEach(s =>
    assert.ok(bloco.includes(`value="${s}"`), `falta a opção ${s}`));
});

test('_setorChanged deriva a regional dos QUATRO setores', () => {
  const fn = new Function(`
    const doc = {};
    const document = { getElementById: (id) => doc[id] };
    ${extrairFuncao('_setorChanged')}
    return (setor) => {
      doc['eq-form-setor'] = { value: setor };
      doc['eq-form-regional'] = { value: null };
      _setorChanged();
      return doc['eq-form-regional'].value;
    };
  `)();

  assert.equal(fn('DESG'), 'GUA');
  assert.equal(fn('DEPT'), 'GUA');
  assert.equal(fn('DESC'), 'CAC');
  assert.equal(fn('DSSJ'), 'SJC', 'DSSJ tem de derivar SJC, não GUA');
});
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `node --test test/equipesAdminTela.test.js`
Expected: FAIL — `falta a opção DSSJ`

- [ ] **Step 3: Implementar**

Em `public/index.html`, no `<select id="eq-form-setor">`, acrescente a quarta
opção depois da de `DESC`:

```html
              <option value="DSSJ" ${setor === 'DSSJ' ? 'selected' : ''}>DSSJ</option>
```

E substitua a função `_setorChanged` inteira por:

```js
    // Auto-deriva regional ao trocar setor. O mapa é o mesmo do
    // REGIONAL_MAP de services/wpaService.js:1863 — manter alinhado.
    //
    // 17/09/2026: antes era `(setor === 'DESC') ? 'CAC' : 'GUA'`, que jogava
    // DSSJ pra GUA — e o select nem oferecia DSSJ. Cadastrar equipe de SJC
    // pela tela não funcionava, apesar de banco e validação aceitarem.
    const _SETOR_REGIONAL = { DESG: 'GUA', DEPT: 'GUA', DESC: 'CAC', DSSJ: 'SJC' };
    function _setorChanged() {
      const setor = document.getElementById('eq-form-setor').value;
      const reg   = document.getElementById('eq-form-regional');
      reg.value = _SETOR_REGIONAL[setor] || 'GUA';
    }
```

- [ ] **Step 4: Rodar e verificar que passa**

Run: `node --test test/equipesAdminTela.test.js`
Expected: PASS — 2 testes

- [ ] **Step 5: Commit**

```bash
git add public/index.html test/equipesAdminTela.test.js
git commit -m "fix(admin): DSSJ faltava no seletor de setor — SJC nao cadastrava

  O banco e o validateEquipe aceitam DSSJ desde 08/06/2026, mas o select so
  oferecia DESG/DEPT/DESC e a derivacao mandava tudo que nao era DESC pra GUA.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: Front — busca e filtro na lista

**Files:**
- Modify: `public/index.html:873-882` (barra de botões) e `9407` (`loadEquipesOficiais`)
- Test: `test/equipesAdminTela.test.js`

- [ ] **Step 1: Escrever o teste que falha**

Acrescente ao fim de `test/equipesAdminTela.test.js`:

```js
test('_filtrarEquipes filtra por texto, regional e situação', () => {
  const filtrar = new Function(`${extrairFuncao('_filtrarEquipes')}; return _filtrarEquipes;`)();

  const eqs = [
    { sigla: 'EBGPR62', placa: 'ABC-1234', regional: 'GUA', ativo: true },
    { sigla: 'ECACH50', placa: 'DEF-5678', regional: 'CAC', ativo: true },
    { sigla: 'EMGPR70', placa: null,       regional: 'GUA', ativo: false },
  ];

  // Sem filtro: tudo
  assert.equal(filtrar(eqs, { texto: '', regional: 'ALL', situacao: 'ALL' }).length, 3);

  // Texto casa sigla, sem depender de caixa
  assert.deepEqual(
    filtrar(eqs, { texto: 'gpr', regional: 'ALL', situacao: 'ALL' }).map(e => e.sigla),
    ['EBGPR62', 'EMGPR70']);

  // Texto casa placa
  assert.deepEqual(
    filtrar(eqs, { texto: 'def', regional: 'ALL', situacao: 'ALL' }).map(e => e.sigla),
    ['ECACH50']);

  // Placa nula não quebra
  assert.doesNotThrow(() => filtrar(eqs, { texto: 'zzz', regional: 'ALL', situacao: 'ALL' }));

  // Regional
  assert.equal(filtrar(eqs, { texto: '', regional: 'CAC', situacao: 'ALL' }).length, 1);

  // Situação
  assert.deepEqual(
    filtrar(eqs, { texto: '', regional: 'ALL', situacao: 'INATIVAS' }).map(e => e.sigla),
    ['EMGPR70']);
  assert.equal(filtrar(eqs, { texto: '', regional: 'ALL', situacao: 'ATIVAS' }).length, 2);

  // Combinado
  assert.deepEqual(
    filtrar(eqs, { texto: 'gpr', regional: 'GUA', situacao: 'ATIVAS' }).map(e => e.sigla),
    ['EBGPR62']);
});
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `node --test test/equipesAdminTela.test.js`
Expected: FAIL — `não achei function _filtrarEquipes(`

- [ ] **Step 3: Implementar a função pura**

Em `public/index.html`, imediatamente **antes** de `function renderEquipesTabela(eqs) {`:

```js
    // Filtro da lista de equipes. PURO — por isso é testável
    // (test/equipesAdminTela.test.js extrai e executa esta função).
    // Roda no cliente sobre a lista que o GET já traz inteira: sem ida ao
    // servidor a cada tecla.
    function _filtrarEquipes(eqs, { texto, regional, situacao }) {
      const t = String(texto || '').trim().toUpperCase();
      return (eqs || []).filter(e => {
        if (regional && regional !== 'ALL' && e.regional !== regional) return false;
        if (situacao === 'ATIVAS'   && !e.ativo) return false;
        if (situacao === 'INATIVAS' &&  e.ativo) return false;
        if (!t) return true;
        const sigla = String(e.sigla || '').toUpperCase();
        const placa = String(e.placa || '').toUpperCase();
        return sigla.includes(t) || placa.includes(t);
      });
    }
```

- [ ] **Step 4: Rodar e verificar que passa**

Run: `node --test test/equipesAdminTela.test.js`
Expected: PASS — 3 testes

- [ ] **Step 5: Ligar na tela**

Em `public/index.html`, dentro do `<div style="display:flex;gap:8px;…">` da
seção "Equipes Oficiais" (linha ~873), depois do `<span id="eq-status">`:

```html
              <input id="eq-busca" type="search" placeholder="Buscar sigla ou placa…"
                oninput="_aplicarFiltroEquipes()"
                style="height:36px;padding:0 10px;border:1px solid var(--cinza2);border-radius:6px;font-size:12px;min-width:200px" />
              <select id="eq-filtro-regional" onchange="_aplicarFiltroEquipes()"
                style="height:36px;padding:0 8px;border:1px solid var(--cinza2);border-radius:6px;font-size:12px">
                <option value="ALL">Todas as regionais</option>
                <option value="GUA">GUA</option>
                <option value="CAC">CAC</option>
                <option value="SJC">SJC</option>
              </select>
              <select id="eq-filtro-situacao" onchange="_aplicarFiltroEquipes()"
                style="height:36px;padding:0 8px;border:1px solid var(--cinza2);border-radius:6px;font-size:12px">
                <option value="ALL">Todas</option>
                <option value="ATIVAS">Ativas</option>
                <option value="INATIVAS">Inativas</option>
              </select>
```

Substitua `loadEquipesOficiais` inteira por:

```js
    let _eqCache = [];   // lista completa do último GET; o filtro roda sobre ela

    async function loadEquipesOficiais() {
      const cont = document.getElementById('eq-tabela');
      cont.style.display = 'block';
      cont.innerHTML = '<div style="padding:12px;font-size:12px;color:var(--text2)">⏳ Carregando…</div>';
      try {
        const res = await fetch(`${API}/admin/equipes`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'erro');
        _eqCache = data.equipes || [];
        _aplicarFiltroEquipes();
      } catch (err) {
        cont.innerHTML = `<div style="padding:12px;color:var(--vermelho);font-size:12px">✗ ${err.message}</div>`;
      }
    }

    function _aplicarFiltroEquipes() {
      const cont   = document.getElementById('eq-tabela');
      const status = document.getElementById('eq-status');
      if (!cont || cont.style.display === 'none') return;
      const filtradas = _filtrarEquipes(_eqCache, {
        texto:    document.getElementById('eq-busca')?.value || '',
        regional: document.getElementById('eq-filtro-regional')?.value || 'ALL',
        situacao: document.getElementById('eq-filtro-situacao')?.value || 'ALL',
      });
      if (status) {
        status.textContent = filtradas.length === _eqCache.length
          ? `${_eqCache.length} equipes (${_eqCache.filter(e => e.ativo).length} ativas)`
          : `${filtradas.length} de ${_eqCache.length} equipes`;
      }
      cont.innerHTML = renderEquipesTabela(filtradas);
    }
```

- [ ] **Step 6: Rodar a suíte inteira**

Run: `node --test`
Expected: 0 falhas

- [ ] **Step 7: Commit**

```bash
git add public/index.html test/equipesAdminTela.test.js
git commit -m "feat(admin): busca e filtro na lista de equipes oficiais

  138 equipes numa caixa com scroll e sem busca era o segundo atrito relatado
  pelo Jose em 17/09. Texto casa sigla ou placa; filtros por regional e por
  situacao. Tudo no cliente, sobre a lista que o GET ja traz inteira.

  O contador passa a refletir o filtro: "12 de 138 equipes".

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 9: Front — detecção de cabeçalho da planilha

**Files:**
- Modify: `public/index.html`
- Test: `test/equipesAdminTela.test.js`

- [ ] **Step 1: Escrever o teste que falha**

Acrescente ao fim de `test/equipesAdminTela.test.js`:

```js
test('_detectarCabecalho acha a linha de cabeçalho e mapeia as colunas', () => {
  const detectar = new Function(`${extrairFuncao('_detectarCabecalho')}; return _detectarCabecalho;`)();

  // Planilha real tem título e linha em branco antes da tabela.
  const matriz = [
    ['RELAÇÃO DE EQUIPES — SETEMBRO', null, null],
    [null, null, null],
    ['Sigla', 'Tipo', 'Placa'],
    ['EBGPR62', 'BTZERO', 'ABC-1234'],
  ];
  const r = detectar(matriz);

  assert.equal(r.linhaCabecalho, 2, 'índice 0-based da linha de cabeçalho');
  assert.deepEqual(r.mapa, { sigla: 0, tipo: 1, placa: 2 });
});

test('_detectarCabecalho aceita sinônimos e ignora acento e caixa', () => {
  const detectar = new Function(`${extrairFuncao('_detectarCabecalho')}; return _detectarCabecalho;`)();

  const r = detectar([['EQUIPE', 'SERVIÇO', 'VEÍCULO'], ['EBGPR62', 'CS', 'ABC-1234']]);
  assert.deepEqual(r.mapa, { sigla: 0, tipo: 1, placa: 2 });
});

test('_detectarCabecalho devolve mapa vazio quando não acha sigla', () => {
  const detectar = new Function(`${extrairFuncao('_detectarCabecalho')}; return _detectarCabecalho;`)();

  const r = detectar([['Coluna A', 'Coluna B'], ['x', 'y']]);
  assert.equal(r.linhaCabecalho, -1);
  assert.equal(r.mapa.sigla, undefined);
});

test('_detectarCabecalho só olha as 10 primeiras linhas', () => {
  const detectar = new Function(`${extrairFuncao('_detectarCabecalho')}; return _detectarCabecalho;`)();

  const matriz = Array.from({ length: 12 }, () => ['lixo', 'lixo']);
  matriz.push(['Sigla', 'Tipo']);
  assert.equal(detectar(matriz).linhaCabecalho, -1);
});
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `node --test test/equipesAdminTela.test.js`
Expected: FAIL — `não achei function _detectarCabecalho(`

- [ ] **Step 3: Implementar**

Em `public/index.html`, logo depois de `_filtrarEquipes`:

```js
    // Sinônimos de cabeçalho aceitos na importação. Planilha corporativa não
    // tem nome de coluna padronizado entre quem manda.
    const _CAB_SINONIMOS = {
      sigla: ['sigla', 'equipe', 'time', 'turma', 'cod', 'codigo'],
      tipo:  ['tipo', 'tiposervico', 'servico', 'atividade'],
      placa: ['placa', 'veiculo', 'carro'],
    };

    /** "Tipo Serviço" → "tiposervico" (minúscula, sem acento, sem espaço). */
    function _normCabecalho(v) {
      return String(v === null || v === undefined ? '' : v)
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    /**
     * Acha a linha de cabeçalho e mapeia as colunas. PURO.
     *
     * Varre só as 10 primeiras linhas: planilha corporativa tem título, logo ou
     * linha em branco antes da tabela, mas não 30. A detecção é chute educado —
     * a prévia mostra o resultado com selects pra você corrigir.
     *
     * @returns {{ linhaCabecalho:number, mapa:{sigla?:number,tipo?:number,placa?:number} }}
     *          linhaCabecalho é índice 0-based na matriz, ou -1 se não achou.
     */
    function _detectarCabecalho(matriz) {
      const limite = Math.min((matriz || []).length, 10);
      for (let i = 0; i < limite; i++) {
        const linha = matriz[i] || [];
        const mapa = {};
        linha.forEach((celula, idx) => {
          const n = _normCabecalho(celula);
          if (!n) return;
          Object.keys(_CAB_SINONIMOS).forEach(campo => {
            if (mapa[campo] === undefined && _CAB_SINONIMOS[campo].includes(n)) {
              mapa[campo] = idx;
            }
          });
        });
        // Sem a coluna de sigla não há tabela — é o único campo indispensável.
        if (mapa.sigla !== undefined) return { linhaCabecalho: i, mapa };
      }
      return { linhaCabecalho: -1, mapa: {} };
    }
```

- [ ] **Step 4: Rodar e verificar que passa**

Run: `node --test test/equipesAdminTela.test.js`
Expected: PASS — 7 testes

- [ ] **Step 5: Commit**

```bash
git add public/index.html test/equipesAdminTela.test.js
git commit -m "feat(admin): deteccao do cabecalho da planilha de equipes

  Varre as 10 primeiras linhas procurando a que tem um sinonimo de sigla —
  planilha corporativa vem com titulo e linha em branco antes da tabela.
  Sinonimos por campo, ignorando acento e caixa. Funcao pura, testada.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 10: Front — bloco de importação e prévia

**Files:**
- Modify: `public/index.html` (markup na seção Equipes Oficiais + funções)

- [ ] **Step 1: Markup**

Em `public/index.html`, depois do `<div id="eq-form" …></div>` da seção
"Equipes Oficiais":

```html
            <div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--cinza2)">
              <div style="font-size:12px;font-weight:600;margin-bottom:6px">📥 Importar de planilha</div>
              <div style="font-size:11px;color:var(--text2);margin-bottom:8px">
                A planilha precisa ter uma coluna de sigla. Tipo e placa são opcionais.
                Nada é gravado antes de você conferir a prévia.
              </div>
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
                <select id="eq-imp-regional" style="height:32px;padding:0 8px;border:1px solid var(--cinza2);border-radius:4px;font-size:12px">
                  <option value="GUA">GUA</option>
                  <option value="CAC">CAC</option>
                  <option value="SJC">SJC</option>
                </select>
                <select id="eq-imp-setor" style="height:32px;padding:0 8px;border:1px solid var(--cinza2);border-radius:4px;font-size:12px">
                  <option value="DESG">DESG</option>
                  <option value="DEPT">DEPT</option>
                  <option value="DESC">DESC</option>
                  <option value="DSSJ">DSSJ</option>
                </select>
                <!-- Sem `list=`: o datalist `tipos-equipe-datalist` só existe
                     DENTRO do HTML que _renderEquipeForm gera, então não existe
                     até o formulário de equipe única ser aberto — o atributo
                     apontaria pro nada. Ligar os dois exigiria mover o datalist
                     pra markup estática e gerenciar quando preenchê-lo, o que
                     não se paga: o tipo padrão é digitado uma vez por lote. -->
                <input id="eq-imp-tipo" placeholder="Tipo padrão (obrigatório)"
                  style="height:32px;padding:0 8px;border:1px solid var(--cinza2);border-radius:4px;font-size:12px;text-transform:uppercase;min-width:190px" />
                <input id="eq-imp-arquivo" type="file" accept=".xlsx,.xls,.csv"
                  onchange="_importarPlanilhaEscolhida()" style="font-size:12px" />
              </div>
              <div id="eq-imp-plano"></div>
            </div>
```

- [ ] **Step 2: Leitura do arquivo e prévia**

Depois de `_detectarCabecalho`, acrescente:

```js
    let _impLinhas = [];   // linhas cruas lidas do arquivo

    /**
     * Lê o arquivo escolhido e pede a prévia ao servidor.
     *
     * O browser só extrai bytes: toda normalização, validação e diff acontece
     * em services/equipesImport.js, onde é testável sem DOM.
     */
    async function _importarPlanilhaEscolhida() {
      const alvo = document.getElementById('eq-imp-plano');
      const arq  = document.getElementById('eq-imp-arquivo').files[0];
      if (!arq) return;

      alvo.innerHTML = '<div style="font-size:12px;color:var(--text2)">⏳ Lendo a planilha…</div>';
      try {
        const buf = await arq.arrayBuffer();
        const wb  = XLSX.read(buf, { type: 'array' });
        const ws  = wb.Sheets[wb.SheetNames[0]];

        // `range` dá o número REAL da linha no Excel. Usar o índice do array
        // faria o erro apontar pra linha errada quando a planilha tem título.
        const range  = XLSX.utils.decode_range(ws['!ref']);
        const matriz = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: null });

        const { linhaCabecalho, mapa } = _detectarCabecalho(matriz);
        if (linhaCabecalho < 0) {
          alvo.innerHTML = '<div style="font-size:12px;color:var(--vermelho)">'
            + '✗ Não achei uma coluna de sigla nas 10 primeiras linhas. '
            + 'Confira se a planilha tem cabeçalho com "Sigla" (ou Equipe, Turma, Código).</div>';
          return;
        }

        _impLinhas = matriz.slice(linhaCabecalho + 1).map((linha, i) => ({
          // +1 porque o Excel conta a partir de 1, e o range começa onde a
          // planilha realmente começa (pode não ser a linha 1).
          linhaPlanilha: range.s.r + linhaCabecalho + 1 + i + 1,
          sigla: mapa.sigla !== undefined ? linha[mapa.sigla] : null,
          tipo:  mapa.tipo  !== undefined ? linha[mapa.tipo]  : null,
          placa: mapa.placa !== undefined ? linha[mapa.placa] : null,
        }));

        await _pedirPlanoImportacao();
      } catch (err) {
        alvo.innerHTML = `<div style="font-size:12px;color:var(--vermelho)">✗ ${err.message}</div>`;
      }
    }

    /** Pede o plano ao servidor (dryRun) e renderiza. */
    async function _pedirPlanoImportacao(reativar) {
      const alvo = document.getElementById('eq-imp-plano');
      alvo.innerHTML = '<div style="font-size:12px;color:var(--text2)">⏳ Montando a prévia…</div>';
      const corpo = {
        dryRun:     true,
        regional:   document.getElementById('eq-imp-regional').value,
        setor:      document.getElementById('eq-imp-setor').value,
        tipoPadrao: document.getElementById('eq-imp-tipo').value.trim().toUpperCase(),
        reativar:   !!reativar,
        linhas:     _impLinhas,
      };
      try {
        const res  = await fetch(`${API}/admin/equipes/importar`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(corpo),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        alvo.innerHTML = _renderPlanoImportacao(data.plano, !!reativar);
      } catch (err) {
        alvo.innerHTML = `<div style="font-size:12px;color:var(--vermelho)">✗ ${err.message}</div>`;
      }
    }

    /** Aplica o plano. Só aqui `dryRun: false`. */
    async function _gravarImportacao(reativar) {
      const alvo = document.getElementById('eq-imp-plano');
      alvo.innerHTML = '<div style="font-size:12px;color:var(--text2)">⏳ Gravando…</div>';
      try {
        const res = await fetch(`${API}/admin/equipes/importar`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dryRun:     false,
            regional:   document.getElementById('eq-imp-regional').value,
            setor:      document.getElementById('eq-imp-setor').value,
            tipoPadrao: document.getElementById('eq-imp-tipo').value.trim().toUpperCase(),
            reativar:   !!reativar,
            linhas:     _impLinhas,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        alvo.innerHTML = `<div style="font-size:12px;color:var(--verde)">
          ✓ Gravadas ${data.gravadas} — ${data.novas} novas, ${data.alteradas} alteradas,
          ${data.identicas} sem mudança, ${data.ignoradas} ignoradas por erro.</div>`;
        document.getElementById('eq-imp-arquivo').value = '';
        _impLinhas = [];
        await loadEquipesOficiais();
      } catch (err) {
        alvo.innerHTML = `<div style="font-size:12px;color:var(--vermelho)">✗ ${err.message}</div>`;
      }
    }
```

- [ ] **Step 3: Renderização do plano**

Acrescente:

```js
    /** Monta o HTML do plano. Erros primeiro — é o que exige ação. */
    function _renderPlanoImportacao(plano, reativar) {
      if (!plano) return '';
      const esc = s => escapeHtml(String(s === null || s === undefined ? '' : s));
      const bloco = (titulo, corpo, cor) => `
        <div style="margin-top:10px">
          <div style="font-size:11px;font-weight:600;color:${cor || 'var(--text)'};margin-bottom:4px">${titulo}</div>
          ${corpo}
        </div>`;
      const tabela = (cabs, linhas) => `
        <div style="max-height:200px;overflow-y:auto;border:1px solid var(--cinza2);border-radius:4px">
          <table style="width:100%;border-collapse:collapse;font-size:11px">
            <thead style="background:var(--cinza1);position:sticky;top:0"><tr>
              ${cabs.map(c => `<th style="padding:4px 8px;text-align:left">${c}</th>`).join('')}
            </tr></thead>
            <tbody>${linhas}</tbody>
          </table>
        </div>`;

      let html = '';

      if (plano.erros.length > 0) {
        html += bloco(`✗ ${plano.erros.length} linha(s) com problema`,
          tabela(['Linha', 'Sigla', 'Campo', 'Valor lido', 'Problema'],
            plano.erros.map(e => `<tr style="border-top:1px solid var(--cinza2)">
              <td style="padding:4px 8px;font-family:monospace">${e.linhaPlanilha ?? '—'}</td>
              <td style="padding:4px 8px;font-family:monospace">${esc(e.siglaCrua) || '—'}</td>
              <td style="padding:4px 8px">${esc(e.campo) || '—'}</td>
              <td style="padding:4px 8px;font-family:monospace">${esc(e.valor) || '—'}</td>
              <td style="padding:4px 8px">${esc(e.motivo)}</td></tr>`).join('')),
          'var(--vermelho)');
      }

      if (plano.novas.length > 0) {
        html += bloco(`+ ${plano.novas.length} nova(s)`,
          tabela(['Linha', 'Sigla', 'Tipo', 'Placa'],
            plano.novas.map(n => `<tr style="border-top:1px solid var(--cinza2)">
              <td style="padding:4px 8px;font-family:monospace">${n.linhaPlanilha}</td>
              <td style="padding:4px 8px;font-family:monospace;font-weight:600">${esc(n.sigla)}</td>
              <td style="padding:4px 8px">${esc(n.tipo)}</td>
              <td style="padding:4px 8px;font-family:monospace">${esc(n.placa) || '—'}</td></tr>`).join('')),
          'var(--verde)');
      }

      if (plano.alteradas.length > 0) {
        html += bloco(`✎ ${plano.alteradas.length} alterada(s)`,
          tabela(['Linha', 'Sigla', 'Mudanças'],
            plano.alteradas.map(a => `<tr style="border-top:1px solid var(--cinza2)">
              <td style="padding:4px 8px;font-family:monospace">${a.linhaPlanilha}</td>
              <td style="padding:4px 8px;font-family:monospace;font-weight:600">${esc(a.sigla)}</td>
              <td style="padding:4px 8px">${a.mudancas.map(m =>
                `${esc(m.campo)}: <s style="color:var(--text2)">${esc(m.de) || '—'}</s> → <b>${esc(m.para) || '—'}</b>`
              ).join('<br>')}</td></tr>`).join('')),
          'var(--amarelo)');
      }

      if (plano.inativas.length > 0) {
        html += bloco(`⚠ ${plano.inativas.length} sigla(s) da planilha estão INATIVAS no cadastro`,
          `<div style="font-size:11px;color:var(--text2)">
             ${plano.inativas.map(i => esc(i.sigla)).join(', ')}
           </div>
           <label style="font-size:11px;display:flex;gap:6px;align-items:center;margin-top:6px">
             <input type="checkbox" ${reativar ? 'checked' : ''}
               onchange="_pedirPlanoImportacao(this.checked)" />
             Reativar essas ${plano.inativas.length} — elas voltam a contar no histórico
           </label>`,
          'var(--amarelo)');
      }

      if (plano.identicas > 0) {
        html += `<div style="font-size:11px;color:var(--text2);margin-top:8px">
          ${plano.identicas} sem nenhuma mudança — serão ignoradas.</div>`;
      }

      const grava = plano.novas.length + plano.alteradas.length;
      const rotulo = grava === 0
        ? 'Nada a gravar'
        : `💾 Gravar ${grava} equipe(s)` + (plano.erros.length > 0
            ? ` — ${plano.erros.length} linha(s) com erro serão ignoradas` : '');

      html += `<button onclick="_gravarImportacao(${reativar})" class="btn-refresh"
        ${grava === 0 ? 'disabled' : ''}
        style="margin-top:12px;height:32px;padding:0 16px;font-size:12px;background:${grava === 0 ? 'var(--cinza2)' : 'var(--verde)'};color:#fff">
        ${rotulo}</button>`;

      return html;
    }
```

- [ ] **Step 4: Rodar a suíte inteira**

Run: `node --test`
Expected: 0 falhas. O `test/htmlScriptSintaxe.test.js` valida a sintaxe do
`<script>` — se houver erro de digitação no JS, ele pega aqui.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat(admin): bloco de importacao de planilha com previa

  Escolhe o arquivo, define regional/setor/tipo padrao do lote e ve o plano
  antes de gravar: erros primeiro (com a linha do Excel, o valor lido e o
  motivo), depois novas, alteradas com de/para por campo, inativas com o
  checkbox de reativar, e a contagem de identicas.

  O botao diz o que vai fazer e fica desabilitado quando nao ha o que gravar.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 11: Documentação — backlog e spec

**Files:**
- Modify: `docs/handoff/BACKLOG.md`
- Modify: `docs/handoff/SPEC-import-equipes-2026-09-17.md` (cabeçalho de status)

- [ ] **Step 1: Registrar o achado do `setor` como item de backlog**

Na tabela de índice do `BACKLOG.md`, depois da linha do `P1-51`:

```markdown
| P1-52 | `GET /admin/equipes` não devolvia `setor`: a coluna da tabela mostrava `—` pra todas e o formulário REESCREVIA o campo ao salvar (DEPT→DESG, DSSJ→DESG com regional SJC) | Dados/Frontend | **done** (17/09) — `setor` no SELECT + DSSJ no seletor; falta medir linhas já corrompidas |
```

E no fim do arquivo, o item completo:

```markdown

---

## P1-52 — `GET /admin/equipes` não devolvia `setor`, e o formulário reescrevia o campo

- **Categoria:** Dados / Frontend
- **Status:** **done** (17/09/2026) — falta medir e reparar linhas já corrompidas
- **Fonte:** achado em 17/09/2026 ao especificar a importação em lote
  (`SPEC-import-equipes-2026-09-17.md`).
- **Evidência:**
  - `routes/index.js:1974` — `_COLS_BASE` listava
    `sigla, regional, tipo, placa, ativo, escala_inicio, escala_fim, created_at, updated_at`.
    **Sem `setor`.**
  - `public/index.html:9433` — a tabela renderiza `e.setor || '—'`, então a
    coluna "Setor" mostrava `—` pra todas as 138 equipes.
  - `public/index.html:9481` — o formulário caía no fallback
    `e.setor || (e.regional === 'CAC' ? 'DESC' : 'DESG')`.
  - `salvarEquipe` enviava esse palpite, e o `PUT` (`routes/index.js:2049`)
    gravava sem questionar.
- **Impacto:** editar qualquer equipe pelo formulário reescrevia o `setor`.
  Uma equipe **DEPT** virava **DESG**; uma **DSSJ** virava **DESG** mantendo
  `regional: SJC` — linha que passa nos dois CHECKs isolados e é incoerente.
  O `setor` mapeia pro CSD da EDP (`REGIONAL_MAP` em `wpaService.js:1863`) e
  alimenta o `getMeta` da whitelist.
- **Ação:** `setor` entrou no `_COLS_BASE`. O `DSSJ` entrou no seletor e o
  `_setorChanged` passou a usar o mapa dos quatro setores.
- **Aceite:**
  - [x] `GET /admin/equipes` devolve `setor`; teste trava o SELECT.
  - [x] Seletor oferece os 4 setores; teste executa `_setorChanged`.
  - [ ] **Medir linhas já corrompidas** na VM:
        `psql -d wpa_monitor -c "SELECT setor, regional, count(*) FROM equipes_oficiais GROUP BY 1,2 ORDER BY 1,2;"`
        Combinação `DESG|SJC`, `DESG|CAC` ou `DESC|GUA` indica linha reescrita
        por edição passada.
  - [ ] Reparar as linhas encontradas (ação manual, uma a uma, pelo formulário
        já corrigido).
- **Esforço:** 30min o código; a medição depende da VM.
- **Rollback:** `git revert`. Nenhuma mudança de schema.
```

- [ ] **Step 2: Atualizar o status do spec**

Em `docs/handoff/SPEC-import-equipes-2026-09-17.md`, troque a linha de status
do cabeçalho por:

```markdown
> Data: 2026-09-17 · Status: **implementado** — falta confirmar em produção.
```

- [ ] **Step 3: Rodar a suíte inteira**

Run: `node --test`
Expected: 0 falhas

- [ ] **Step 4: Commit**

```bash
git add docs/handoff/BACKLOG.md docs/handoff/SPEC-import-equipes-2026-09-17.md
git commit -m "docs: P1-52 (setor ausente no GET) e status do spec de importacao

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Verificação final (manual, na VM)

Depois do deploy (`git pull && pm2 delete wpa-monitor && pm2 start ecosystem.config.js && pm2 save`):

- [ ] A coluna **Setor** da tabela mostra DESG/DEPT/DESC/DSSJ, não `—`
- [ ] Buscar por parte de uma sigla filtra a lista; o contador vira "N de 138"
- [ ] Importar uma planilha de teste com **1 linha nova, 1 já existente com
      placa diferente e 1 sigla curta** produz: 1 nova, 1 alterada mostrando
      `placa: X → Y`, e 1 erro apontando o número de linha certo do Excel
- [ ] Gravar e conferir que a lista recarrega com as equipes novas
- [ ] Rodar de novo a **mesma** planilha: tudo cai em "idênticas", nada é
      gravado (idempotência)
- [ ] Medir as linhas corrompidas do P1-52 com o `psql` da §Aceite
