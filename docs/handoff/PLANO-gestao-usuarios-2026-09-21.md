# Gestão de Usuários — Plano de Implementação

> **EXECUTADO em 21/09/2026** — o código. A implantação (migration, migração,
> redução do `.env`) é do José e está na última seção. Suíte ao fim:
> **1221 testes, 0 falhas** (eram 1196).
>
> | Tarefa | Commit |
> |---|---|
> | 1 — tabelas | `6a18051` |
> | 2 — travas puras | `f37bf3d` |
> | 3 — leitura do banco + cache | `0a1d26a` |
> | 4 — login lê do banco | `f30c5e8` |
> | 5 — revogação imediata | `3d27ca2` |
> | 6 — as sete rotas | `c3c7349` |
> | 7 — script de migração | `8503210` |
> | 8 — a tela | `0e6b335` |
> | 9 — documentação | (este commit) |
>
> **Três achados durante a execução, e NENHUM veio de teste vermelho:**
>
> 1. **Escalonamento de privilégio na janela da migração.** Dar
>    `pode_gerenciar` a toda conta do `.env` é inofensivo *depois* da migração
>    e perigoso *durante* — as cinco contas antigas virariam gestoras de uma
>    vez. E no sentido inverso, a conta marcada como gestora pela migração é
>    sombreada pela homônima do `.env`, deixando a tela inacessível para quem
>    devia usá-la. Veio de olhar o código e perguntar "o que isso faz **durante**
>    a migração, não depois dela".
> 2. **`gerarSenha` dependia de sorte** para ter dígito. O teste probabilístico
>    acusou; a correção foi na implementação, não no teste.
> 3. **O pool fake não distinguia tabela**, e o teste de vazamento acusava a
>    rota de log por estar recebendo linhas de usuário do próprio mock.
>
> Dois testes foram verificados **vermelhos de propósito**: o de vazamento de
> `senha_hash` (removendo o filtro da rota) e os de trava.
>
> Os aceites de **produção** seguem em aberto — ver P0-1a no BACKLOG.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Conceder e retirar acesso ao painel pela tela, em vez de editar o `.env` na VM por SSH — com efeito imediato e trilha de auditoria.

**Architecture:** Os usuários saem do `.env` e vão para o banco, menos UMA conta de emergência que fica como chave reserva. O token passa a provar só identidade; o banco diz o que a pessoa pode. As travas ficam num módulo puro, e cada uma tem teste HTTP.

**Tech Stack:** Node 24, Express 4, Postgres via `services/pgShim.js`, `node --test`, `crypto.scryptSync` (já usado).

**Spec:** `docs/handoff/SPEC-gestao-usuarios-2026-09-21.md`

---

## Contexto que o executor precisa saber

**⚠️ Isto é autenticação.** Cinco itens do backlog já foram furos de controle de
acesso neste código: P0-4, P1-12, P1-18, P1-38, P1-42. Teste que só lê o
código-fonte **não basta** aqui — cada trava tem teste HTTP com o app real.

**1. A migração copia HASHES, não senhas.** As senhas em texto puro não existem
em lugar nenhum; o `.env` só tem hashes, e o `_verifyPassword`
(`middleware/auth.js:126`) já aceita os dois formatos. Ninguém precisa saber a
senha de ninguém.

**2. `authMiddleware` é síncrono hoje** (`middleware/auth.js:165`) e vai virar
assíncrono. **Envolva o corpo em `try/catch`**: o Express 4 não captura rejeição
de middleware `async`, e não existe handler de `unhandledRejection` no projeto
(é o P2-41, ainda aberto) — uma promise solta derruba o processo.

**3. Não há runner de migration.** Os `.sql` de `migrations/` são aplicados à
mão com `psql`. O passo de aplicar está explícito na Task 1.

**4. Fail-open é proibido.** Com o banco fora: vale o cache; **sem cache,
nega**. O P1-32 existe porque uma classificação fail-open deixou um breaker sem
efeito. Não repita.

**5. A conta de emergência não tem linha no banco.** O `authMiddleware` precisa
de exceção explícita para ela, senão a chave reserva é negada justamente quando
é necessária.

**Como rodar:** `node --test`. O hook `pre-push` bloqueia push com teste vermelho.

**Commits:** convenção do `CLAUDE.md`, terminando com
`Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `migrations/add_usuarios.sql` **(novo)** | As duas tabelas. |
| `services/usuarios.js` **(novo)** | Travas e validações (**puras**), leitura/escrita, cache. |
| `middleware/auth.js` **(modificar)** | `getUsers` e `login` assíncronos; `authMiddleware` consulta o banco; `requireGerenciarUsuarios`. |
| `routes/index.js` **(modificar)** | As 7 rotas de usuário. |
| `scripts/migrar-usuarios.js` **(novo)** | Migra o `AUTH_USERS` para a tabela. |
| `public/index.html` **(modificar)** | A tela. |
| `test/usuarios.test.js` **(novo)** | As travas, puras. |
| `test/usuariosHttp.test.js` **(novo)** | Contrato HTTP das 7 rotas. |
| `test/authBanco.test.js` **(novo)** | Login do banco, cache, revogação, conta de emergência. |

---

## Task 1: As tabelas

**Files:**
- Create: `migrations/add_usuarios.sql`
- Modify: `db/schema-atual.sql` (regenerado depois de aplicar)

- [ ] **Step 1: Escrever a migration**

Crie `migrations/add_usuarios.sql`:

```sql
-- ===========================================================================
-- Migration: tabelas de usuários do painel
-- Aplicar em 21/09/2026
--
-- Tira os usuários do AUTH_USERS do .env e põe no banco, pra conceder e
-- retirar acesso pela tela em vez de por SSH. Ver
-- docs/handoff/SPEC-gestao-usuarios-2026-09-21.md
--
-- ⚠️ Esta migration NÃO migra os dados. Ela cria as tabelas VAZIAS, e o
-- comportamento do login segue idêntico ao de hoje (o getUsers une banco +
-- .env; com a tabela vazia, só o .env responde). A migração dos dados é o
-- scripts/migrar-usuarios.js, rodado depois e conferido com --dry-run.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS usuarios (
  username        text PRIMARY KEY,
  senha_hash      text        NOT NULL,
  role            text        NOT NULL DEFAULT 'user',
  -- Mesmo formato do .env ('GUA|CAC'), de propósito: reusa o parser e as
  -- validações que já existem no auth.js, inclusive as que recusam 'ALL' e
  -- grupos como 'ES'. Um formato novo seria um segundo parser.
  regionals       text        NOT NULL,
  ativo           boolean     NOT NULL DEFAULT true,
  -- A permissão de CONCEDER acesso. Separada de role='admin' de propósito:
  -- admin abre o /admin inteiro; esta diz quem mexe em quem entra.
  pode_gerenciar  boolean     NOT NULL DEFAULT false,
  criado_em       timestamptz NOT NULL DEFAULT now(),
  criado_por      text,
  atualizado_em   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usuarios_role_check      CHECK (role IN ('admin', 'user')),
  CONSTRAINT usuarios_username_check  CHECK (username ~ '^[a-z0-9_]{3,32}$')
);

-- Trilha de auditoria. SÓ escrita e leitura — não há rota de edição nem de
-- exclusão. Acesso concedido e retirado é o tipo de coisa que alguém pergunta
-- seis meses depois, e "acho que fui eu" não é resposta num contrato auditado.
CREATE TABLE IF NOT EXISTS usuarios_log (
  id       bigserial   PRIMARY KEY,
  ts       timestamptz NOT NULL DEFAULT now(),
  ator     text        NOT NULL,
  acao     text        NOT NULL,
  alvo     text        NOT NULL,
  -- NUNCA contém senha nem hash.
  detalhe  jsonb,
  CONSTRAINT usuarios_log_acao_check CHECK (
    acao IN ('criar','desativar','reativar','alterar','resetar_senha'))
);

CREATE INDEX IF NOT EXISTS usuarios_log_ts_idx   ON usuarios_log (ts DESC);
CREATE INDEX IF NOT EXISTS usuarios_log_alvo_idx ON usuarios_log (alvo, ts DESC);
```

- [ ] **Step 2: Aplicar na VM**

Não há runner de migration — aplica-se à mão:

```bash
psql -d wpa_monitor -f migrations/add_usuarios.sql
```

Confira que as duas tabelas existem e estão vazias:

```bash
psql -d wpa_monitor -c "SELECT count(*) FROM usuarios; SELECT count(*) FROM usuarios_log;"
```

Esperado: `0` nas duas.

> ⚠️ Tabela nova precisa de `OWNER wpa_app` neste projeto. Se o app reclamar de
> permissão depois, rode:
> `psql -d wpa_monitor -c "ALTER TABLE usuarios OWNER TO wpa_app; ALTER TABLE usuarios_log OWNER TO wpa_app; ALTER SEQUENCE usuarios_log_id_seq OWNER TO wpa_app;"`

- [ ] **Step 3: Regenerar o schema commitado**

O projeto mantém `db/schema-atual.sql` em dia (P2-7):

```bash
pg_dump --schema-only --no-owner -d wpa_monitor > db/schema-atual.sql
```

- [ ] **Step 4: Commit**

```bash
git add migrations/add_usuarios.sql db/schema-atual.sql
git commit -m "feat(usuarios): tabelas usuarios e usuarios_log

  Cria as tabelas VAZIAS. O comportamento do login segue identico ao de hoje —
  a migracao dos dados e um script separado, rodado depois e conferido com
  --dry-run. Ver secao 8 da SPEC-gestao-usuarios.

  regionals fica como texto no formato do .env ('GUA|CAC') de proposito:
  reusa o parser e as validacoes que ja existem, inclusive as que recusam
  'ALL' e grupos. Formato novo seria um segundo parser.

  usuarios_log e so escrita e leitura: nao ha rota de edicao nem de exclusao.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: As travas, puras

**Files:**
- Create: `services/usuarios.js`
- Test: `test/usuarios.test.js` (criar)

- [ ] **Step 1: Escrever o teste que falha**

Crie `test/usuarios.test.js`:

```js
/**
 * test/usuarios.test.js
 *
 * As TRAVAS da gestão de usuários, na forma pura — sem banco, sem HTTP.
 *
 * Cada uma existe contra um jeito específico de dar errado, e o comentário de
 * cada teste diz qual. O contrato HTTP está em test/usuariosHttp.test.js.
 *
 * Spec: docs/handoff/SPEC-gestao-usuarios-2026-09-21.md §5
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const {
  validarNovoUsuario, podeDesativar, podeAlterar, gerarSenha,
} = require('../services/usuarios');

/** Um usuário como a tabela devolve. */
function u(over = {}) {
  return {
    username: 'fulano', role: 'user', regionals: ['GUA'],
    ativo: true, pode_gerenciar: false, ...over,
  };
}

const JOSE = u({ username: 'jose', role: 'admin', regionals: ['GUA','CAC','SJC'], pode_gerenciar: true });

// ─────────────────────────────────────────────────────────────────────────────
// validarNovoUsuario
// ─────────────────────────────────────────────────────────────────────────────

test('aceita um usuário válido', () => {
  const erros = validarNovoUsuario(
    { username: 'novo_user', role: 'user', regionals: ['GUA'] }, JOSE, new Set());
  assert.deepEqual(erros, []);
});

test('recusa username fora do formato', () => {
  ['ab', 'COM_MAIUSCULA', 'com espaco', 'com-hifen', ''].forEach(nome => {
    const erros = validarNovoUsuario(
      { username: nome, role: 'user', regionals: ['GUA'] }, JOSE, new Set());
    assert.ok(erros.length > 0, `"${nome}" devia ser recusado`);
    assert.ok(erros.some(e => /username/i.test(e)));
  });
});

test('recusa role fora de admin|user', () => {
  const erros = validarNovoUsuario(
    { username: 'novo_user', role: 'superadmin', regionals: ['GUA'] }, JOSE, new Set());
  assert.ok(erros.some(e => /role/i.test(e)));
});

test('recusa regional inválida, ALL e grupo ES', () => {
  ['XYZ', 'ALL', 'ES'].forEach(r => {
    const erros = validarNovoUsuario(
      { username: 'novo_user', role: 'user', regionals: [r] }, JOSE, new Set());
    assert.ok(erros.length > 0, `regional "${r}" devia ser recusada`);
  });
});

test('recusa lista de regionais vazia', () => {
  const erros = validarNovoUsuario(
    { username: 'novo_user', role: 'user', regionals: [] }, JOSE, new Set());
  assert.ok(erros.some(e => /regional/i.test(e)));
});

test('TRAVA 4: gestor não concede regional que ele próprio não tem', () => {
  // É a diferença entre delegar e abrir mão. Hoje não muda nada (o José tem
  // todas); existe pro dia em que houver gestor de escopo menor.
  const gestorGua = u({ username: 'gestor_gua', regionals: ['GUA'], pode_gerenciar: true });
  const erros = validarNovoUsuario(
    { username: 'novo_user', role: 'user', regionals: ['GUA','CAC'] }, gestorGua, new Set());
  assert.ok(erros.some(e => /CAC/.test(e)), `esperava recusa por CAC; veio: ${erros}`);
});

test('recusa username reservado pela conta de emergência', () => {
  // Sem isso, quem gerencia criaria um homônimo da chave reserva, e qual das
  // duas responde viraria detalhe de implementação decidindo quem entra.
  const erros = validarNovoUsuario(
    { username: 'emergencia', role: 'user', regionals: ['GUA'] },
    JOSE, new Set(['emergencia']));
  assert.ok(erros.some(e => /reservado/i.test(e)));
});

// ─────────────────────────────────────────────────────────────────────────────
// podeDesativar
// ─────────────────────────────────────────────────────────────────────────────

test('TRAVA 1: não pode desativar a si mesmo', () => {
  // Trava contra se trancar do lado de fora com um clique.
  const r = podeDesativar('jose', JOSE, [JOSE]);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /si mesmo|pr[óo]prio/i);
});

test('TRAVA 2: não pode deixar zero gestores ativos', () => {
  // A trava 1 não cobre dois gestores se removendo em ordem.
  const outro = u({ username: 'gestor2', pode_gerenciar: true });
  const r = podeDesativar('gestor2', JOSE, [JOSE, outro]);
  assert.equal(r.ok, true, 'com dois gestores, desativar um é permitido');

  const soUm = podeDesativar('gestor2', u({ username: 'gestor2', pode_gerenciar: true }),
    [u({ username: 'gestor2', pode_gerenciar: true })]);
  assert.equal(soUm.ok, false);
});

test('desativar um usuário comum é permitido', () => {
  const alvo = u({ username: 'fulano' });
  const r = podeDesativar('fulano', JOSE, [JOSE, alvo]);
  assert.equal(r.ok, true);
});

test('desativar quem não existe é recusado, não ignorado', () => {
  const r = podeDesativar('fantasma', JOSE, [JOSE]);
  assert.equal(r.ok, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// podeAlterar
// ─────────────────────────────────────────────────────────────────────────────

test('TRAVA 1b: não pode tirar a própria permissão de gerenciar', () => {
  const r = podeAlterar({ pode_gerenciar: false }, JOSE, JOSE, [JOSE]);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /pr[óo]pria|si mesmo/i);
});

test('TRAVA 2b: não pode tirar a permissão do último gestor', () => {
  const soUm = u({ username: 'gestor2', pode_gerenciar: true });
  const r = podeAlterar({ pode_gerenciar: false }, soUm, JOSE, [JOSE, soUm]);
  assert.equal(r.ok, true, 'ainda sobra o José');

  const r2 = podeAlterar({ pode_gerenciar: false }, JOSE, soUm, [JOSE, soUm]);
  assert.equal(r2.ok, true, 'ainda sobra o gestor2');
});

test('TRAVA 3: conceder pode_gerenciar exige que o ator a tenha', () => {
  const naoGestor = u({ username: 'admin2', role: 'admin', pode_gerenciar: false });
  const alvo = u({ username: 'fulano' });
  const r = podeAlterar({ pode_gerenciar: true }, alvo, naoGestor, [JOSE, naoGestor, alvo]);
  assert.equal(r.ok, false);
});

test('TRAVA 4b: alterar regionais respeita o escopo do ator', () => {
  const gestorGua = u({ username: 'gestor_gua', regionals: ['GUA'], pode_gerenciar: true });
  const alvo = u({ username: 'fulano' });
  const r = podeAlterar({ regionals: ['GUA','SJC'] }, alvo, gestorGua, [gestorGua, alvo]);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /SJC/);
});

// ─────────────────────────────────────────────────────────────────────────────
// gerarSenha
// ─────────────────────────────────────────────────────────────────────────────

test('gerarSenha produz senha longa e de alfabeto amplo', () => {
  const s = gerarSenha();
  assert.ok(s.length >= 16, `senha curta demais: ${s.length}`);
  assert.match(s, /[a-z]/);
  assert.match(s, /[A-Z]/);
  assert.match(s, /[0-9]/);
});

test('gerarSenha não repete', () => {
  const vistas = new Set(Array.from({ length: 200 }, () => gerarSenha()));
  assert.equal(vistas.size, 200);
});

test('gerarSenha evita caracteres ambíguos', () => {
  // A senha é transcrita à mão por uma pessoa pra outra. O/0 e l/1/I trocados
  // viram "não consigo entrar" e um reset desnecessário.
  const amostra = Array.from({ length: 200 }, () => gerarSenha()).join('');
  ['O', '0', 'l', '1', 'I'].forEach(c =>
    assert.ok(!amostra.includes(c), `caractere ambíguo "${c}" apareceu`));
});
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `node --test test/usuarios.test.js`
Expected: FAIL — `Cannot find module '../services/usuarios'`

- [ ] **Step 3: Criar o módulo (só a parte pura)**

Crie `services/usuarios.js`:

```js
/**
 * services/usuarios.js
 *
 * Gestão de usuários do painel: as TRAVAS (puras) e o acesso ao banco.
 *
 * ⚠️ Isto é autenticação. Cinco itens do backlog já foram furos de controle de
 * acesso neste código (P0-4, P1-12, P1-18, P1-38, P1-42). As travas ficam aqui,
 * num lugar só — não espalhadas pelas rotas, onde uma seria esquecida.
 *
 * Spec: docs/handoff/SPEC-gestao-usuarios-2026-09-21.md
 */

'use strict';

const crypto = require('crypto');
const { isValidRegional } = require('./regionals');

const RE_USERNAME = /^[a-z0-9_]{3,32}$/;
const ROLES = ['admin', 'user'];

/**
 * Alfabeto da senha gerada, SEM caracteres ambíguos (O/0, l/1/I).
 * A senha é transcrita à mão de uma pessoa pra outra; um zero lido como "ó"
 * vira "não consigo entrar" e um reset desnecessário.
 */
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*';
const SENHA_LEN = 20;

/** Senha forte, aleatória por crypto. Mostrada UMA vez e nunca guardada. */
function gerarSenha() {
  const bytes = crypto.randomBytes(SENHA_LEN * 2);
  let s = '';
  for (let i = 0; s.length < SENHA_LEN && i < bytes.length; i++) {
    const v = bytes[i];
    // Descarta o resto do módulo pra não enviesar o alfabeto.
    if (v >= Math.floor(256 / ALFABETO.length) * ALFABETO.length) continue;
    s += ALFABETO[v % ALFABETO.length];
  }
  return s.length === SENHA_LEN ? s : s + gerarSenha().slice(0, SENHA_LEN - s.length);
}

/** Normaliza a lista de regionais vinda do payload. */
function _regs(v) {
  if (Array.isArray(v)) return v.map(s => String(s || '').trim().toUpperCase()).filter(Boolean);
  return String(v === null || v === undefined ? '' : v)
    .split('|').map(s => s.trim().toUpperCase()).filter(Boolean);
}

/**
 * Valida o payload de criação.
 *
 * @param payload     { username, role, regionals }
 * @param ator        quem está criando — { username, regionals, pode_gerenciar }
 * @param reservados  Set de usernames do AUTH_USERS (conta de emergência)
 * @returns string[]  vazio = válido
 */
function validarNovoUsuario(payload, ator, reservados) {
  const erros = [];
  const p = payload || {};
  const username = String(p.username || '').trim().toLowerCase();

  if (!RE_USERNAME.test(username)) {
    erros.push('username inválido (3 a 32 caracteres: minúsculas, números ou _)');
  }
  if ((reservados || new Set()).has(username)) {
    erros.push(`username "${username}" é reservado pela conta de emergência do .env`);
  }
  if (!ROLES.includes(p.role)) erros.push("role deve ser 'admin' ou 'user'");

  const regs = _regs(p.regionals);
  if (regs.length === 0) {
    erros.push('informe ao menos uma regional');
  } else {
    const invalidas = regs.filter(r => !isValidRegional(r));
    if (invalidas.length) erros.push(`regionais inválidas: ${invalidas.join(', ')}`);

    // TRAVA 4: um gestor só concede o que ele próprio tem.
    const doAtor = new Set(_regs(ator && ator.regionals));
    const fora = regs.filter(r => !doAtor.has(r));
    if (fora.length) {
      erros.push(`você não pode conceder regionais que não tem: ${fora.join(', ')}`);
    }
  }
  return erros;
}

/** Quantos gestores ATIVOS sobrariam se `mudanca` fosse aplicada. */
function _gestoresAtivos(todos, excluir, tirarGerenciaDe) {
  return (todos || []).filter(u =>
    u.ativo &&
    u.pode_gerenciar &&
    u.username !== excluir &&
    u.username !== tirarGerenciaDe).length;
}

/**
 * TRAVAS 1 e 2 na desativação.
 * @returns {{ok: boolean, motivo?: string}}
 */
function podeDesativar(alvoUsername, ator, todos) {
  const alvo = (todos || []).find(u => u.username === alvoUsername);
  if (!alvo) return { ok: false, motivo: `usuário "${alvoUsername}" não existe` };

  if (ator && alvo.username === ator.username) {
    return { ok: false, motivo: 'você não pode desativar a si mesmo' };
  }
  if (alvo.pode_gerenciar && _gestoresAtivos(todos, alvoUsername, null) === 0) {
    return { ok: false, motivo: 'precisa sobrar ao menos um gestor ativo' };
  }
  return { ok: true };
}

/**
 * TRAVAS 1b, 2b, 3 e 4b na alteração.
 * @returns {{ok: boolean, motivo?: string}}
 */
function podeAlterar(payload, alvo, ator, todos) {
  const p = payload || {};

  if (p.pode_gerenciar === false && ator && alvo.username === ator.username) {
    return { ok: false, motivo: 'você não pode tirar a própria permissão de gerenciar' };
  }
  if (p.pode_gerenciar === true && !(ator && ator.pode_gerenciar)) {
    return { ok: false, motivo: 'só quem pode gerenciar concede essa permissão' };
  }
  if (p.pode_gerenciar === false && alvo.pode_gerenciar
      && _gestoresAtivos(todos, null, alvo.username) === 0) {
    return { ok: false, motivo: 'precisa sobrar ao menos um gestor ativo' };
  }
  if (p.regionals !== undefined) {
    const regs = _regs(p.regionals);
    if (regs.length === 0) return { ok: false, motivo: 'informe ao menos uma regional' };
    const invalidas = regs.filter(r => !isValidRegional(r));
    if (invalidas.length) return { ok: false, motivo: `regionais inválidas: ${invalidas.join(', ')}` };
    const doAtor = new Set(_regs(ator && ator.regionals));
    const fora = regs.filter(r => !doAtor.has(r));
    if (fora.length) {
      return { ok: false, motivo: `você não pode conceder regionais que não tem: ${fora.join(', ')}` };
    }
  }
  if (p.role !== undefined && !ROLES.includes(p.role)) {
    return { ok: false, motivo: "role deve ser 'admin' ou 'user'" };
  }
  return { ok: true };
}

module.exports = {
  validarNovoUsuario, podeDesativar, podeAlterar, gerarSenha,
  RE_USERNAME, ROLES,
};
```

- [ ] **Step 4: Rodar e verificar que passa**

Run: `node --test test/usuarios.test.js`
Expected: PASS — 17 testes

- [ ] **Step 5: Rodar a suíte inteira**

Run: `node --test`
Expected: 0 falhas

- [ ] **Step 6: Commit**

```bash
git add services/usuarios.js test/usuarios.test.js
git commit -m "feat(usuarios): as travas de gestao de acesso, puras

  As cinco travas num lugar so, testaveis sem banco e sem HTTP — nao
  espalhadas pelas rotas, onde uma seria esquecida:

   1. nao desativa a si mesmo        (trava contra se trancar pra fora)
   2. nunca sobra zero gestor ativo  (a 1 nao cobre dois se removendo em ordem)
   3. so quem gerencia concede a permissao de gerenciar
   4. gestor so concede regional que ele proprio tem
   5. username reservado pela conta de emergencia e recusado

  A senha gerada evita O/0 e l/1/I: ela e transcrita a mao de uma pessoa pra
  outra, e um zero lido como 'o' vira um reset desnecessario.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Leitura e escrita no banco, com cache

**Files:**
- Modify: `services/usuarios.js`
- Test: `test/usuarios.test.js`

- [ ] **Step 1: Escrever o teste que falha**

Acrescente ao fim de `test/usuarios.test.js`:

```js
// ─────────────────────────────────────────────────────────────────────────────
// Cache — o TTL é o teto de quanto tempo um acesso retirado sobrevive
// ─────────────────────────────────────────────────────────────────────────────

const { _cache, CACHE_TTL_MS } = require('../services/usuarios');

test('o TTL do cache é 30s — é o teto do "na hora"', () => {
  assert.equal(CACHE_TTL_MS, 30_000);
});

test('cache guarda e devolve dentro do TTL', () => {
  _cache.limpar();
  _cache.por('fulano', { username: 'fulano', ativo: true });
  assert.equal(_cache.ler('fulano').ativo, true);
});

test('cache expira depois do TTL', () => {
  _cache.limpar();
  _cache.por('fulano', { username: 'fulano', ativo: true });
  _cache.envelhecer('fulano', CACHE_TTL_MS + 1);
  assert.equal(_cache.ler('fulano'), null);
});

test('cache expirado ainda pode ser lido como ÚLTIMO CONHECIDO', () => {
  // É o que sustenta a §3.5 do spec: com o banco fora, vale a última entrada
  // conhecida. Sem isso, banco fora = todo mundo cai, que é pior que hoje.
  _cache.limpar();
  _cache.por('fulano', { username: 'fulano', ativo: true });
  _cache.envelhecer('fulano', CACHE_TTL_MS + 1);
  assert.equal(_cache.ler('fulano'), null, 'leitura normal respeita o TTL');
  assert.equal(_cache.ultimoConhecido('fulano').ativo, true, 'o fallback ignora o TTL');
});

test('sem entrada, ultimoConhecido devolve null — e quem chama NEGA', () => {
  // Fail-open é proibido. É o defeito que o P1-32 consertou no breaker.
  _cache.limpar();
  assert.equal(_cache.ultimoConhecido('nunca_visto'), null);
});
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `node --test test/usuarios.test.js`
Expected: FAIL — `Cannot read properties of undefined (reading 'limpar')`

- [ ] **Step 3: Implementar**

Em `services/usuarios.js`, antes do `module.exports`:

```js
/**
 * Cache de usuário em memória.
 *
 * TTL de 30s: é o TETO de quanto tempo um acesso retirado pode sobreviver.
 * Meio minuto é curto o bastante pra "na hora" ser verdade, e longo o bastante
 * pra o painel não consultar o banco a cada clique.
 *
 * `ler` respeita o TTL. `ultimoConhecido` ignora o TTL de propósito: é o
 * fallback de quando o banco está fora (spec §3.5). Sem entrada nenhuma, os
 * dois devolvem null — e quem chama NEGA. Fail-open é proibido aqui; é o
 * defeito que o P1-32 consertou no breaker de login.
 */
const CACHE_TTL_MS = 30_000;

const _mapa = new Map();   // username → { dados, ts }

const _cache = {
  por(username, dados) { _mapa.set(username, { dados, ts: Date.now() }); },
  ler(username) {
    const e = _mapa.get(username);
    if (!e) return null;
    return (Date.now() - e.ts) > CACHE_TTL_MS ? null : e.dados;
  },
  ultimoConhecido(username) {
    const e = _mapa.get(username);
    return e ? e.dados : null;
  },
  invalidar(username) { _mapa.delete(username); },
  limpar() { _mapa.clear(); },
  /** Só pra teste: empurra a entrada pro passado. */
  envelhecer(username, ms) {
    const e = _mapa.get(username);
    if (e) e.ts -= ms;
  },
};
```

E acrescente ao `module.exports`: `_cache, CACHE_TTL_MS,`

- [ ] **Step 4: Rodar e verificar que passa**

Run: `node --test test/usuarios.test.js`
Expected: PASS — 22 testes

- [ ] **Step 5: Acrescentar o acesso ao banco**

Ainda em `services/usuarios.js`, antes do `module.exports`:

```js
/** Linha da tabela → objeto de usuário, com regionals já em array. */
function _daLinha(row) {
  if (!row) return null;
  return {
    username:       row.username,
    senha_hash:     row.senha_hash,
    role:           row.role,
    regionals:      _regs(row.regionals),
    ativo:          row.ativo,
    pode_gerenciar: row.pode_gerenciar,
    criado_em:      row.criado_em,
    criado_por:     row.criado_por,
  };
}

/** Todos os usuários do banco. Lança se o banco estiver fora. */
async function listarDoBanco() {
  const sb = require('./dbClient').getClient();
  const { data, error } = await sb.from('usuarios')
    .select('username, senha_hash, role, regionals, ativo, pode_gerenciar, criado_em, criado_por')
    .order('username');
  if (error) throw error;
  return (data || []).map(_daLinha);
}

/**
 * Um usuário, pelo cache quando possível.
 *
 * Com o banco fora, cai no último conhecido. Sem último conhecido, devolve
 * null — e quem chama NEGA.
 */
async function buscar(username) {
  const doCache = _cache.ler(username);
  if (doCache) return doCache;

  try {
    const sb = require('./dbClient').getClient();
    const { data, error } = await sb.from('usuarios')
      .select('username, senha_hash, role, regionals, ativo, pode_gerenciar, criado_em, criado_por')
      .eq('username', username);
    if (error) throw error;
    const achado = _daLinha((data || [])[0]);
    if (achado) _cache.por(username, achado);
    return achado;
  } catch (err) {
    console.warn('[usuarios] banco indisponível, usando último conhecido:', err.message);
    return _cache.ultimoConhecido(username);
  }
}

/** Registra na trilha. NUNCA recebe senha nem hash em `detalhe`. */
async function registrarLog(ator, acao, alvo, detalhe) {
  try {
    const sb = require('./dbClient').getClient();
    const { error } = await sb.from('usuarios_log')
      .insert({ ator, acao, alvo, detalhe: detalhe || null });
    if (error) throw error;
  } catch (err) {
    // A trilha não pode derrubar a operação, mas o silêncio também não serve.
    console.error('[usuarios] FALHA ao gravar auditoria:', { ator, acao, alvo }, err.message);
  }
}
```

E acrescente ao `module.exports`: `listarDoBanco, buscar, registrarLog,`

- [ ] **Step 6: Rodar a suíte inteira**

Run: `node --test`
Expected: 0 falhas

- [ ] **Step 7: Commit**

```bash
git add services/usuarios.js test/usuarios.test.js
git commit -m "feat(usuarios): leitura do banco com cache de 30s

  O TTL de 30s e o TETO de quanto tempo um acesso retirado pode sobreviver.

  `ler` respeita o TTL; `ultimoConhecido` ignora de proposito — e o fallback
  de quando o banco esta fora. Sem entrada nenhuma, os dois devolvem null e
  quem chama NEGA. Fail-open e proibido aqui: e o defeito que o P1-32
  consertou no breaker de login.

  A falha ao gravar auditoria nao derruba a operacao, mas vai pro log como
  error — silencio tambem nao serve numa trilha de acesso.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: O login passa a ler do banco

**Files:**
- Modify: `middleware/auth.js:65` (`getUsers`), `:147` (`login`)
- Modify: `routes/index.js:125` (a rota vira `async`)
- Test: `test/authBanco.test.js` (criar)

- [ ] **Step 1: Escrever o teste que falha**

Crie `test/authBanco.test.js`:

```js
/**
 * test/authBanco.test.js
 *
 * O login lendo do banco, a conta de emergência e a revogação imediata.
 *
 * ⚠️ A parte mais sensível do trabalho: é o caminho onde um erro não dá tela
 * feia, dá acesso indevido.
 *
 * Spec: docs/handoff/SPEC-gestao-usuarios-2026-09-21.md §3.3, §3.4, §3.5
 */

'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-secret-authbanco';

const { hashPassword } = require('../middleware/auth');
const { _cache } = require('../services/usuarios');
const { _setPool } = require('../services/pgShim');

process.env.DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://test:test@localhost:5432/test';

/** Pool fake: devolve as linhas dadas, ou lança se `erro` for true. */
function mockPool(rows, erro) {
  _setPool({
    query: async () => {
      if (erro) throw new Error('banco fora');
      return { rows, rowCount: rows.length };
    },
    on: () => {},
  });
}

const SENHA = 'senha-de-teste';
const HASH  = hashPassword(SENHA);

function linha(over = {}) {
  return {
    username: 'fulano', senha_hash: HASH, role: 'user', regionals: 'GUA',
    ativo: true, pode_gerenciar: false, criado_em: new Date(), criado_por: 'jose',
    ...over,
  };
}

beforeEach(() => _cache.limpar());

test('getUsers une os do banco com a conta de emergência do .env', async () => {
  process.env.AUTH_USERS = `emergencia:${HASH}:admin:GUA|CAC|SJC`;
  mockPool([linha()]);

  const { getUsers } = require('../middleware/auth');
  const users = await getUsers();
  const nomes = users.map(u => u.username).sort();

  assert.deepEqual(nomes, ['emergencia', 'fulano']);
});

test('em colisão de nome, a conta do .env VENCE', async () => {
  // Sem isso, quem gerencia criaria um homônimo da chave reserva e qual das
  // duas responde viraria detalhe de implementação decidindo quem entra.
  const hashOutro = hashPassword('outra-senha');
  process.env.AUTH_USERS = `emergencia:${HASH}:admin:GUA|CAC|SJC`;
  mockPool([linha({ username: 'emergencia', senha_hash: hashOutro, role: 'user' })]);

  const { getUsers } = require('../middleware/auth');
  const users = await getUsers();
  const emerg = users.filter(u => u.username === 'emergencia');

  assert.equal(emerg.length, 1, 'não pode haver duas entradas com o mesmo nome');
  assert.equal(emerg[0].role, 'admin', 'venceu a do banco, deveria ser a do .env');
  assert.equal(emerg[0].passwordHash, HASH);
});

test('login de usuário do banco funciona', async () => {
  process.env.AUTH_USERS = `emergencia:${HASH}:admin:GUA`;
  mockPool([linha()]);

  const { login } = require('../middleware/auth');
  const r = await login('fulano', SENHA);

  assert.ok(r, 'esperava login bem-sucedido');
  assert.equal(r.username, 'fulano');
  assert.deepEqual(r.regionals, ['GUA']);
});

test('usuário DESATIVADO no banco não loga', async () => {
  process.env.AUTH_USERS = `emergencia:${HASH}:admin:GUA`;
  mockPool([linha({ ativo: false })]);

  const { login } = require('../middleware/auth');
  assert.equal(await login('fulano', SENHA), null);
});

test('com o banco FORA, a conta de emergência ainda loga', async () => {
  // É a razão inteira de ela existir. Em 09/07/2026 o Postgres caiu em
  // produção (P0-0, ainda aberto: a VM segue sem swap).
  process.env.AUTH_USERS = `emergencia:${HASH}:admin:GUA|CAC|SJC`;
  mockPool([], true);

  const { login } = require('../middleware/auth');
  const r = await login('emergencia', SENHA);

  assert.ok(r, 'a chave reserva tem de funcionar justamente quando o banco cai');
  assert.equal(r.username, 'emergencia');
});

test('com o banco FORA, usuário do banco NÃO loga (não é fail-open)', async () => {
  process.env.AUTH_USERS = `emergencia:${HASH}:admin:GUA`;
  mockPool([], true);

  const { login } = require('../middleware/auth');
  assert.equal(await login('fulano', SENHA), null);
});

test('senha errada continua não logando', async () => {
  process.env.AUTH_USERS = `emergencia:${HASH}:admin:GUA`;
  mockPool([linha()]);

  const { login } = require('../middleware/auth');
  assert.equal(await login('fulano', 'errada'), null);
});
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `node --test test/authBanco.test.js`
Expected: FAIL — `getUsers` é síncrono e não conhece o banco; vários testes
quebram.

- [ ] **Step 3: Tornar `getUsers` assíncrono e unir as duas fontes**

Em `middleware/auth.js`, renomeie a função atual para `_usuariosDoEnv` (o corpo
não muda) e acrescente logo abaixo:

```js
/**
 * Usuários do `.env` (conta de emergência) UNIDOS aos do banco.
 *
 * A conta do `.env` é a chave reserva: com o Postgres fora, é a única que
 * entra. Em 09/07/2026 o Postgres caiu em produção (P0-0, ainda aberto: a VM
 * segue sem swap) — sem ela, um repeteco tranca todo mundo pra fora, inclusive
 * de descobrir que o banco caiu.
 *
 * ⚠️ Em colisão de nome, a entrada do `.env` VENCE, e o banco recusa criar
 * usuário com nome do `.env` (services/usuarios.js). Sem as duas regras, quem
 * gerencia criaria um homônimo e qual das duas responde viraria detalhe de
 * implementação decidindo quem entra.
 *
 * Banco fora ⇒ devolve só a conta de emergência. Não é fail-open: o usuário
 * comum simplesmente não é encontrado, e o login falha.
 */
async function getUsers() {
  const doEnv = _usuariosDoEnv();
  const reservados = new Set(doEnv.map(u => u.username));

  let doBanco = [];
  try {
    const { listarDoBanco } = require('../services/usuarios');
    doBanco = (await listarDoBanco())
      .filter(u => u.ativo)                       // desativado não loga
      .filter(u => !reservados.has(u.username))   // o .env vence a colisão
      .map(u => ({
        username:     u.username,
        passwordHash: u.senha_hash,
        role:         u.role,
        regionals:    u.regionals,
      }));
  } catch (err) {
    console.warn('[auth] banco indisponível; só a conta de emergência pode entrar:', err.message);
  }
  return [...doEnv, ...doBanco];
}
```

E torne o `login` assíncrono — troque a primeira linha do corpo:

```js
async function login(username, password) {
  const users = await getUsers();
```

(o resto da função não muda).

- [ ] **Step 3b: Apontar o `test/auth.test.js` para `_usuariosDoEnv`**

`test/auth.test.js` chama `getUsers()` em **9 lugares**, e em **4** deles com
`assert.throws(() => getUsers(), ...)`. Com `getUsers` assíncrono, essas quatro
falham de um jeito que não explica nada — `assert.throws` não captura promise
rejeitada, e a mensagem vira "Missing expected exception".

Esses testes são sobre **o parsing do formato do `.env`**, que é exatamente o
que `_usuariosDoEnv` faz e continua síncrono. Então a correção não é envolver
tudo em `await`: é apontar para a função certa.

1. Exporte `_usuariosDoEnv` no `module.exports` do `middleware/auth.js`.
2. Em `test/auth.test.js`, troque o import e as 9 chamadas de `getUsers` por
   `_usuariosDoEnv`.
3. Acrescente ao cabeçalho do arquivo de teste:

```js
/**
 * 21/09/2026: estes testes falavam com `getUsers()`, que virou ASSÍNCRONO ao
 * passar a ler do banco. Eles são sobre o parsing do formato do `.env`, então
 * passaram a falar com `_usuariosDoEnv()`, que é essa parte e segue síncrona.
 * A cobertura é a mesma; mudou o nome do que ela cobre.
 */
```

Run: `node --test test/auth.test.js`
Expected: PASS — a mesma quantidade de testes de antes.

- [ ] **Step 4: Tornar a rota de login assíncrona**

Em `routes/index.js`, localize `router.post('/auth/login', (req, res) => {` e
troque por `router.post('/auth/login', async (req, res) => {`.

Na linha da chamada, troque `const result = authLogin(username, password);` por:

```js
    const result = await authLogin(username, password);
```

> ⚠️ Confira que o corpo do handler está dentro de um `try/catch`. Se não
> estiver, envolva: o Express 4 não captura rejeição de handler `async`, e não
> há handler de `unhandledRejection` no projeto (P2-41) — uma promise solta
> derruba o processo.

- [ ] **Step 5: Rodar e verificar que passa**

Run: `node --test test/authBanco.test.js`
Expected: PASS — 7 testes

- [ ] **Step 6: Rodar a suíte inteira**

Run: `node --test`
Expected: 0 falhas. Repare em `test/auth.test.js` e `test/routes.test.js`: se
algum ficar vermelho porque `login` virou assíncrono, o teste precisa de
`await` — e isso é atualização legítima, não conserto de teste. Registre no
commit.

- [ ] **Step 7: Commit**

```bash
git add middleware/auth.js routes/index.js test/authBanco.test.js
git commit -m "feat(auth): login le do banco, com conta de emergencia no .env

  getUsers une os usuarios do banco com a conta de emergencia do .env. Em
  colisao de nome, o .env VENCE — e o banco recusa criar usuario com nome do
  .env. Sem as duas regras, quem gerencia criaria um homonimo e qual das duas
  responde viraria detalhe de implementacao decidindo quem entra.

  Banco fora: so a conta de emergencia entra. Nao e fail-open — o usuario
  comum simplesmente nao e encontrado. Em 09/07 o Postgres caiu em producao
  (P0-0 segue aberto, VM sem swap), e sem a chave reserva um repeteco trancaria
  todo mundo pra fora, inclusive de descobrir que o banco caiu.

  login() e a rota /auth/login viram assincronos por consequencia.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Revogação imediata

**O princípio:** o token prova quem você é; o banco diz o que você pode.

**Files:**
- Modify: `middleware/auth.js:165` (`authMiddleware`) e `:188` (novo guard)
- Test: `test/authBanco.test.js`

- [ ] **Step 1: Escrever o teste que falha**

Acrescente ao fim de `test/authBanco.test.js`:

```js
// ─────────────────────────────────────────────────────────────────────────────
// Revogação imediata — o token prova QUEM, o banco diz O QUE
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');

/** Sobe um app mínimo com o authMiddleware real e uma rota que ecoa req.user. */
async function appComAuth() {
  const { authMiddleware } = require('../middleware/auth');
  const app = express();
  app.get('/eco', authMiddleware, (req, res) => res.json(req.user));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function tokenDe(username, senha) {
  const { login } = require('../middleware/auth');
  const r = await login(username, senha);
  return r && r.token;
}

test('usuário desativado no banco CAI na requisição seguinte', async () => {
  // O ponto inteiro do trabalho: "retirar acesso" tem de significar agora, não
  // "daqui a até 8 horas, quando o token expirar".
  process.env.AUTH_USERS = `emergencia:${HASH}:admin:GUA`;
  mockPool([linha()]);
  const token = await tokenDe('fulano', SENHA);
  assert.ok(token);

  // Desativa e limpa o cache (o TTL faria o mesmo em 30s).
  mockPool([linha({ ativo: false })]);
  _cache.limpar();

  const { server, base } = await appComAuth();
  const res = await fetch(base + '/eco', { headers: { Authorization: 'Bearer ' + token } });
  server.close();
  assert.equal(res.status, 401);
});

test('regionals alterado no banco VENCE o que está no token', async () => {
  process.env.AUTH_USERS = `emergencia:${HASH}:admin:GUA`;
  mockPool([linha({ regionals: 'GUA' })]);
  const token = await tokenDe('fulano', SENHA);

  mockPool([linha({ regionals: 'GUA|CAC' })]);
  _cache.limpar();

  const { server, base } = await appComAuth();
  const res = await fetch(base + '/eco', { headers: { Authorization: 'Bearer ' + token } });
  const body = await res.json();
  server.close();

  assert.deepEqual(body.regionals, ['GUA', 'CAC'], 'o banco manda, não o token');
});

test('banco fora COM cache quente: o usuário passa', async () => {
  process.env.AUTH_USERS = `emergencia:${HASH}:admin:GUA`;
  mockPool([linha()]);
  const token = await tokenDe('fulano', SENHA);

  const { buscar } = require('../services/usuarios');
  await buscar('fulano');           // esquenta o cache
  mockPool([], true);               // banco cai

  const { server, base } = await appComAuth();
  const res = await fetch(base + '/eco', { headers: { Authorization: 'Bearer ' + token } });
  server.close();
  assert.equal(res.status, 200);
});

test('banco fora SEM cache: NEGA (não é fail-open)', async () => {
  process.env.AUTH_USERS = `emergencia:${HASH}:admin:GUA`;
  mockPool([linha()]);
  const token = await tokenDe('fulano', SENHA);

  mockPool([], true);
  _cache.limpar();

  const { server, base } = await appComAuth();
  const res = await fetch(base + '/eco', { headers: { Authorization: 'Bearer ' + token } });
  server.close();
  assert.equal(res.status, 401, 'sem cache e sem banco, nega — P1-32');
});

test('banco fora: a conta de EMERGÊNCIA passa mesmo sem linha no banco', async () => {
  // Sem esta exceção, a chave reserva seria negada por "usuário não
  // encontrado" justamente quando é necessária.
  process.env.AUTH_USERS = `emergencia:${HASH}:admin:GUA|CAC|SJC`;
  mockPool([], true);
  const token = await tokenDe('emergencia', SENHA);
  assert.ok(token);

  _cache.limpar();
  const { server, base } = await appComAuth();
  const res = await fetch(base + '/eco', { headers: { Authorization: 'Bearer ' + token } });
  server.close();
  assert.equal(res.status, 200);
});
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `node --test test/authBanco.test.js`
Expected: FAIL — o `authMiddleware` ainda confia no token.

- [ ] **Step 3: Implementar**

Em `middleware/auth.js`, substitua o `authMiddleware` inteiro por:

```js
/**
 * ⚠️ ASSÍNCRONO desde 21/09/2026. O corpo está em try/catch de propósito: o
 * Express 4 não captura rejeição de middleware `async`, e não existe handler de
 * `unhandledRejection` no projeto (P2-41) — uma promise solta derruba o
 * processo.
 *
 * O PRINCÍPIO: o token prova QUEM você é; o banco diz O QUE você pode.
 *
 * Antes, `role` e `regionals` vinham do token e valiam pelas 8h de sessão —
 * então desativar alguém só surtia efeito no próximo login. Agora o middleware
 * consulta o usuário (via cache de 30s) e SOBRESCREVE role/regionals com o que
 * está no banco. De quebra, mudança de permissão também passa a valer na hora.
 *
 * A conta de emergência do `.env` não tem linha no banco: para ela valem os
 * valores do token, e ela nunca é negada por "não encontrada". Sem esta
 * exceção, a chave reserva falharia justamente quando é necessária.
 */
async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers['authorization'] || '';
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Não autenticado', code: 'NO_TOKEN' });
    }

    const payload = verifyToken(authHeader.slice(7));
    if (!payload) {
      return res.status(401).json({
        error: 'Sessão expirada, inválida ou desatualizada',
        code: 'EXPIRED',
        relogin: true,
      });
    }

    // Conta de emergência: vive no .env, não tem linha no banco.
    const doEnv = _usuariosDoEnv().find(u => u.username === payload.username);
    if (doEnv) {
      req.user = { ...payload, role: doEnv.role, regionals: doEnv.regionals };
      return next();
    }

    const { buscar } = require('../services/usuarios');
    const atual = await buscar(payload.username);

    // Não achou (inclusive: banco fora E sem cache) ⇒ NEGA. Fail-open aqui é
    // o defeito que o P1-32 consertou no breaker de login.
    if (!atual || !atual.ativo) {
      return res.status(401).json({
        error: 'Acesso revogado ou sessão inválida',
        code: 'REVOKED',
        relogin: true,
      });
    }

    req.user = {
      ...payload,
      role:           atual.role,
      regionals:      atual.regionals,
      pode_gerenciar: atual.pode_gerenciar,
    };
    next();
  } catch (err) {
    console.error('[auth] erro no authMiddleware:', err.message);
    return res.status(500).json({ error: 'Falha na autenticação' });
  }
}

/**
 * Exige a permissão de GERENCIAR usuários — separada de role='admin'.
 * `admin` abre o /admin inteiro; esta diz quem mexe em quem entra.
 *
 * A conta de emergência do .env é gestora por definição: é a chave reserva.
 */
function requireGerenciarUsuarios(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Não autenticado', code: 'NO_TOKEN' });
  }
  const doEnv = _usuariosDoEnv().some(u => u.username === req.user.username);
  if (!doEnv && !req.user.pode_gerenciar) {
    return res.status(403).json({
      error: 'Você não tem permissão para gerenciar usuários',
      code: 'FORBIDDEN',
    });
  }
  next();
}
```

E acrescente `requireGerenciarUsuarios` ao `module.exports`.

- [ ] **Step 4: Rodar e verificar que passa**

Run: `node --test test/authBanco.test.js`
Expected: PASS — 12 testes

- [ ] **Step 5: Rodar a suíte inteira**

Run: `node --test`
Expected: 0 falhas. **Aqui é o ponto de maior risco do plano**: todo teste que
bate em rota autenticada passa agora pelo `authMiddleware` assíncrono. Se algum
ficar vermelho, entenda antes de mexer — pode ser o teste precisando de mock de
banco, ou pode ser um caminho real que quebrou.

- [ ] **Step 6: Commit**

```bash
git add middleware/auth.js test/authBanco.test.js
git commit -m "feat(auth): revogacao imediata — o banco manda, nao o token

  O token prova QUEM voce e; o banco diz O QUE voce pode.

  Antes, role e regionals vinham do token e valiam pelas 8h de sessao: desativar
  alguem as 9h, tendo a pessoa entrado as 8h59, a deixava usando o painel ate
  as 16h59. Agora o middleware consulta (cache de 30s) e sobrescreve. De quebra,
  mudanca de permissao tambem passa a valer na hora.

  Banco fora COM cache: passa. Banco fora SEM cache: NEGA. A conta de
  emergencia e excecao explicita — sem ela, a chave reserva seria negada por
  "usuario nao encontrado" justamente quando e necessaria.

  O corpo esta em try/catch porque o Express 4 nao captura rejeicao de
  middleware async e nao ha handler de unhandledRejection no projeto (P2-41).

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: As sete rotas

**Files:**
- Modify: `routes/index.js`
- Test: `test/usuariosHttp.test.js` (criar)

- [ ] **Step 1: Escrever o teste que falha**

Crie `test/usuariosHttp.test.js`:

```js
/**
 * test/usuariosHttp.test.js
 *
 * Contrato HTTP das rotas de usuário. O peso do teste vai AQUI, e não em
 * inspeção de código-fonte, porque o risco é de controle de acesso: cinco
 * itens do backlog já foram furos disso (P0-4, P1-12, P1-18, P1-38, P1-42).
 *
 * Spec: docs/handoff/SPEC-gestao-usuarios-2026-09-21.md §7
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

process.env.NODE_ENV   = 'test';
process.env.DATA_MODE  = 'mock';
process.env.JWT_SECRET = 'test-secret-usuarios';
process.env.AUTH_USERS = [
  `emergencia:${sha256('emerg')}:admin:GUA|CAC|SJC`,
  `adminsimples:${sha256('adm')}:admin:GUA`,
].join(',');

const app = require('../server');

let server, base;

before(async () => {
  await new Promise(r => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { if (server) server.close(); });

async function req(metodo, caminho, token, corpo) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(base + caminho, {
    method: metodo, headers, body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function loginAs(u, p) {
  const { json } = await req('POST', '/api/auth/login', null, { username: u, password: p });
  return json.token;
}

/** As sete rotas, com método e um corpo mínimo válido. */
const ROTAS = [
  ['GET',  '/api/admin/usuarios',                    null],
  ['POST', '/api/admin/usuarios',                    { username: 'novo_user', role: 'user', regionals: ['GUA'] }],
  ['PUT',  '/api/admin/usuarios/fulano',             { role: 'user' }],
  ['POST', '/api/admin/usuarios/fulano/desativar',   {}],
  ['POST', '/api/admin/usuarios/fulano/reativar',    {}],
  ['POST', '/api/admin/usuarios/fulano/senha',       {}],
  ['GET',  '/api/admin/usuarios/log',                null],
];

test('sem token → 401 nas SETE rotas', async () => {
  for (const [metodo, caminho, corpo] of ROTAS) {
    const { status } = await req(metodo, caminho, null, corpo);
    assert.equal(status, 401, `${metodo} ${caminho} devia ser 401`);
  }
});

test('admin SEM pode_gerenciar → 403 nas SETE rotas', async () => {
  // role=admin abre o /admin inteiro, mas NÃO mexe em quem entra. É a
  // separação que o José pediu ("só você, por enquanto").
  const token = await loginAs('adminsimples', 'adm');
  assert.ok(token, 'esperava login do admin simples');

  for (const [metodo, caminho, corpo] of ROTAS) {
    const { status } = await req(metodo, caminho, token, corpo);
    assert.equal(status, 403, `${metodo} ${caminho} devia ser 403 pra admin sem gestão`);
  }
});

test('a conta de emergência PODE gerenciar — é a chave reserva', async () => {
  const token = await loginAs('emergencia', 'emerg');
  const { status } = await req('GET', '/api/admin/usuarios', token);
  assert.notEqual(status, 401);
  assert.notEqual(status, 403);
});

test('senha_hash NÃO aparece em nenhuma resposta', async () => {
  // Este código já vazou stack trace (P1-10) e dado de outra regional (P1-38)
  // por caminhos que também pareciam óbvios.
  const token = await loginAs('emergencia', 'emerg');
  for (const [metodo, caminho, corpo] of ROTAS) {
    const { json } = await req(metodo, caminho, token, corpo);
    const texto = JSON.stringify(json);
    assert.ok(!/senha_hash/.test(texto), `${metodo} ${caminho} vazou senha_hash`);
    assert.ok(!/scrypt\$/.test(texto),   `${metodo} ${caminho} vazou um hash`);
  }
});

test('payload malformado → 400, nunca 500', async () => {
  const token = await loginAs('emergencia', 'emerg');
  const casos = [
    {},
    { username: 'ok_user' },
    { username: 'AA', role: 'user', regionals: ['GUA'] },
    { username: 'ok_user', role: 'deus', regionals: ['GUA'] },
    { username: 'ok_user', role: 'user', regionals: [] },
    { username: 'ok_user', role: 'user', regionals: 'ALL' },
  ];
  for (const corpo of casos) {
    const { status } = await req('POST', '/api/admin/usuarios', token, corpo);
    assert.ok(status === 400 || status === 503,
      `corpo ${JSON.stringify(corpo)} devolveu ${status}; esperava 400`);
  }
});

test('desativar a si mesmo → 400 com motivo legível', async () => {
  const token = await loginAs('emergencia', 'emerg');
  const { status, json } = await req(
    'POST', '/api/admin/usuarios/emergencia/desativar', token, {});
  assert.ok(status === 400 || status === 403,
    `esperava recusa ao autodesativar; veio ${status}`);
  assert.ok(json.error, 'a recusa tem de explicar o motivo');
});
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `node --test test/usuariosHttp.test.js`
Expected: FAIL — as rotas não existem (404 onde se espera 401/403).

- [ ] **Step 3: Implementar as rotas**

Em `routes/index.js`, importe o guard junto dos outros (linha 65):

```js
const { login: authLogin, authMiddleware, requireAdmin, requireGerenciarUsuarios,
        compatRegionalParam, applyScope } = require('../middleware/auth');
```

E acrescente o bloco de rotas, **depois** do `router.use('/admin', requireAdmin)`:

```js
// ── USUÁRIOS DO PAINEL ───────────────────────────────────────────────────────
//
// Conceder e retirar acesso pela tela, em vez de editar o .env por SSH.
//
// ⚠️ Guarda DUPLA: `requireAdmin` (herdado do router.use('/admin')) mais
// `requireGerenciarUsuarios`. role=admin abre o /admin inteiro; gerenciar
// usuário é permissão à parte — foi decisão explícita do José em 21/09
// ("só você, por enquanto").
//
// `senha_hash` NUNCA sai daqui. Há teste varrendo o JSON de todas as rotas.
//
// Spec: docs/handoff/SPEC-gestao-usuarios-2026-09-21.md
const _usuariosSvc = require('../services/usuarios');
// `hashPassword` já vem do mesmo módulo do topo (linha 65) — acrescente-o
// àquele destructuring em vez de criar um require novo aqui.
const { hashPassword } = require('../middleware/auth');

/** Tira senha_hash e devolve regionals como array. */
function _semSegredo(u) {
  if (!u) return null;
  const { senha_hash, ...resto } = u;   // eslint-disable-line no-unused-vars
  return resto;
}

/** Usernames do .env — reservados, e não gerenciáveis pela tela. */
function _reservados() {
  return new Set(String(process.env.AUTH_USERS || '')
    .split(',').map(e => e.trim().split(':')[0]).filter(Boolean));
}

router.get('/admin/usuarios', requireGerenciarUsuarios, async (_req, res) => {
  try {
    const todos = await _usuariosSvc.listarDoBanco();
    res.json({ usuarios: todos.map(_semSegredo), count: todos.length });
  } catch (err) {
    res.status(503).json({ error: 'Banco indisponível: ' + err.message });
  }
});

router.post('/admin/usuarios', requireGerenciarUsuarios, async (req, res) => {
  try {
    const erros = _usuariosSvc.validarNovoUsuario(req.body, req.user, _reservados());
    if (erros.length) return res.status(400).json({ error: erros.join('; ') });

    const sb = require('../services/dbClient').getClient();
    const username = String(req.body.username).trim().toLowerCase();
    const senha = _usuariosSvc.gerarSenha();

    const { error } = await sb.from('usuarios').insert({
      username,
      senha_hash:     hashPassword(senha),
      role:           req.body.role,
      regionals:      (Array.isArray(req.body.regionals) ? req.body.regionals : [req.body.regionals])
                        .map(r => String(r).toUpperCase()).join('|'),
      pode_gerenciar: false,     // nunca na criação; concede-se depois, e fica no log
      criado_por:     req.user.username,
    });
    if (error) {
      if (/duplicate|unique/i.test(error.message)) {
        return res.status(409).json({ error: `usuário "${username}" já existe` });
      }
      throw error;
    }

    await _usuariosSvc.registrarLog(req.user.username, 'criar', username,
      { role: req.body.role, regionals: req.body.regionals });

    // A senha vai na resposta UMA vez. Não fica guardada em lugar nenhum.
    res.status(201).json({ ok: true, username, senha });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/admin/usuarios/:username', requireGerenciarUsuarios, async (req, res) => {
  try {
    const username = String(req.params.username || '').toLowerCase();
    if (_reservados().has(username)) {
      return res.status(400).json({ error: 'a conta de emergência não é gerenciável pela tela' });
    }
    const todos = await _usuariosSvc.listarDoBanco();
    const alvo  = todos.find(u => u.username === username);
    if (!alvo) return res.status(404).json({ error: 'usuário não encontrado' });

    const r = _usuariosSvc.podeAlterar(req.body, alvo, req.user, todos);
    if (!r.ok) return res.status(400).json({ error: r.motivo });

    const upd = { atualizado_em: new Date().toISOString() };
    if (req.body.role !== undefined)           upd.role = req.body.role;
    if (req.body.pode_gerenciar !== undefined) upd.pode_gerenciar = !!req.body.pode_gerenciar;
    if (req.body.regionals !== undefined) {
      upd.regionals = (Array.isArray(req.body.regionals) ? req.body.regionals : [req.body.regionals])
        .map(x => String(x).toUpperCase()).join('|');
    }

    const sb = require('../services/dbClient').getClient();
    const { error } = await sb.from('usuarios').update(upd).eq('username', username);
    if (error) throw error;

    _usuariosSvc._cache.invalidar(username);
    await _usuariosSvc.registrarLog(req.user.username, 'alterar', username, {
      de:   { role: alvo.role, regionals: alvo.regionals, pode_gerenciar: alvo.pode_gerenciar },
      para: { role: upd.role, regionals: upd.regionals, pode_gerenciar: upd.pode_gerenciar },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** desativar e reativar compartilham o corpo; só muda o valor e a trava. */
async function _mudarAtivo(req, res, novoAtivo) {
  try {
    const username = String(req.params.username || '').toLowerCase();
    if (_reservados().has(username)) {
      return res.status(400).json({ error: 'a conta de emergência não é gerenciável pela tela' });
    }
    const todos = await _usuariosSvc.listarDoBanco();

    if (!novoAtivo) {
      const r = _usuariosSvc.podeDesativar(username, req.user, todos);
      if (!r.ok) return res.status(400).json({ error: r.motivo });
    } else if (!todos.some(u => u.username === username)) {
      return res.status(404).json({ error: 'usuário não encontrado' });
    }

    const sb = require('../services/dbClient').getClient();
    const { error } = await sb.from('usuarios')
      .update({ ativo: novoAtivo, atualizado_em: new Date().toISOString() })
      .eq('username', username);
    if (error) throw error;

    // Invalidar o cache é o que faz a revogação valer ANTES dos 30s de TTL.
    _usuariosSvc._cache.invalidar(username);
    await _usuariosSvc.registrarLog(
      req.user.username, novoAtivo ? 'reativar' : 'desativar', username, null);
    res.json({ ok: true, ativo: novoAtivo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

router.post('/admin/usuarios/:username/desativar', requireGerenciarUsuarios,
  (req, res) => _mudarAtivo(req, res, false));
router.post('/admin/usuarios/:username/reativar', requireGerenciarUsuarios,
  (req, res) => _mudarAtivo(req, res, true));

router.post('/admin/usuarios/:username/senha', requireGerenciarUsuarios, async (req, res) => {
  try {
    const username = String(req.params.username || '').toLowerCase();
    if (_reservados().has(username)) {
      return res.status(400).json({ error: 'a conta de emergência não é gerenciável pela tela' });
    }
    const todos = await _usuariosSvc.listarDoBanco();
    if (!todos.some(u => u.username === username)) {
      return res.status(404).json({ error: 'usuário não encontrado' });
    }

    const senha = _usuariosSvc.gerarSenha();
    const sb = require('../services/dbClient').getClient();
    const { error } = await sb.from('usuarios')
      .update({ senha_hash: hashPassword(senha), atualizado_em: new Date().toISOString() })
      .eq('username', username);
    if (error) throw error;

    _usuariosSvc._cache.invalidar(username);
    // O log registra QUE houve reset — nunca a senha nem o hash.
    await _usuariosSvc.registrarLog(req.user.username, 'resetar_senha', username, null);
    res.json({ ok: true, username, senha });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/usuarios/log', requireGerenciarUsuarios, async (req, res) => {
  try {
    const sb = require('../services/dbClient').getClient();
    const { data, error } = await sb.from('usuarios_log')
      .select('id, ts, ator, acao, alvo, detalhe')
      .order('ts', { ascending: false })
      .limit(Math.min(Number(req.query.limit) || 200, 500));
    if (error) throw error;
    res.json({ log: data || [] });
  } catch (err) {
    res.status(503).json({ error: 'Banco indisponível: ' + err.message });
  }
});
```

> ⚠️ **Ordem das rotas importa.** `GET /admin/usuarios/log` tem de ser
> declarada, ou o Express a casa contra `PUT /admin/usuarios/:username`? Não —
> métodos diferentes não colidem. Mas se algum dia surgir
> `GET /admin/usuarios/:username`, ela precisa vir DEPOIS de `/log`, senão
> `log` vira o `:username`.

- [ ] **Step 4: Rodar e verificar que passa**

Run: `node --test test/usuariosHttp.test.js`
Expected: PASS — 6 testes

- [ ] **Step 5: Rodar a suíte inteira**

Run: `node --test`
Expected: 0 falhas

- [ ] **Step 6: Commit**

```bash
git add routes/index.js test/usuariosHttp.test.js
git commit -m "feat(usuarios): as sete rotas de gestao de acesso

  Guarda DUPLA: requireAdmin (herdado do router.use) mais
  requireGerenciarUsuarios. role=admin abre o /admin inteiro; gerenciar usuario
  e permissao a parte — decisao explicita do Jose ("so voce, por enquanto").

  Ha teste varrendo o JSON das SETE rotas atras de senha_hash e de 'scrypt$'.
  Este codigo ja vazou stack trace (P1-10) e dado de outra regional (P1-38) por
  caminhos que tambem pareciam obvios.

  A senha gerada vai na resposta UMA vez, na criacao e no reset. O log registra
  QUE houve reset, nunca a senha nem o hash.

  Desativar invalida o cache na hora — e o que faz a revogacao valer antes dos
  30s de TTL.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: O script de migração

**Files:**
- Create: `scripts/migrar-usuarios.js`
- Test: `test/migrarUsuarios.test.js` (criar)

- [ ] **Step 1: Escrever o teste que falha**

Crie `test/migrarUsuarios.test.js`:

```js
/**
 * test/migrarUsuarios.test.js
 *
 * A parte PURA do script de migração: qual linha vira qual, e as recusas.
 *
 * O script copia os HASHES, nunca senhas — elas não existem em lugar nenhum.
 * É o que garante que ninguém perde acesso.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { planejarMigracao } = require('../scripts/migrar-usuarios');

const AUTH = 'jose:scrypt$aa$bb:admin:GUA|CAC|SJC,guarapari:scrypt$cc$dd:user:GUA';

test('monta uma linha por usuário do AUTH_USERS, copiando o hash', () => {
  const p = planejarMigracao(AUTH, 'jose', []);
  assert.equal(p.erros.length, 0);
  assert.equal(p.inserir.length, 2);

  const jose = p.inserir.find(u => u.username === 'jose');
  assert.equal(jose.senha_hash, 'scrypt$aa$bb', 'o hash tem de ir IDÊNTICO');
  assert.equal(jose.regionals, 'GUA|CAC|SJC');
  assert.equal(jose.role, 'admin');
});

test('o --gestor sai com pode_gerenciar; os demais, não', () => {
  const p = planejarMigracao(AUTH, 'jose', []);
  assert.equal(p.inserir.find(u => u.username === 'jose').pode_gerenciar, true);
  assert.equal(p.inserir.find(u => u.username === 'guarapari').pode_gerenciar, false);
});

test('sem --gestor, recusa — senão a tela nasce inútil', () => {
  // Ninguém poderia criar ninguém, e o único caminho de volta seria editar o
  // banco à mão, que é o problema que este trabalho existe pra acabar.
  const p = planejarMigracao(AUTH, null, []);
  assert.ok(p.erros.some(e => /gestor/i.test(e)));
  assert.equal(p.inserir.length, 0);
});

test('--gestor apontando pra quem não está no AUTH_USERS → recusa', () => {
  const p = planejarMigracao(AUTH, 'fantasma', []);
  assert.ok(p.erros.some(e => /fantasma/.test(e)));
});

test('--gestor apontando pra quem não é admin → recusa', () => {
  const p = planejarMigracao(AUTH, 'guarapari', []);
  assert.ok(p.erros.some(e => /admin/i.test(e)));
});

test('idempotente: quem já está no banco é pulado, não sobrescrito', () => {
  const p = planejarMigracao(AUTH, 'jose', [{ username: 'jose' }]);
  assert.equal(p.inserir.length, 1);
  assert.equal(p.inserir[0].username, 'guarapari');
  assert.equal(p.pulados.length, 1);
  assert.equal(p.pulados[0], 'jose');
});

test('AUTH_USERS vazio → recusa em vez de migrar nada em silêncio', () => {
  const p = planejarMigracao('', 'jose', []);
  assert.ok(p.erros.length > 0);
});
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `node --test test/migrarUsuarios.test.js`
Expected: FAIL — `Cannot find module '../scripts/migrar-usuarios'`

- [ ] **Step 3: Implementar**

Crie `scripts/migrar-usuarios.js`:

```js
/**
 * scripts/migrar-usuarios.js — move o AUTH_USERS do .env para a tabela.
 *
 * ⚠️ COPIA OS HASHES, nunca senhas. As senhas em texto puro não existem em
 * lugar nenhum — o .env só guarda hashes, e o _verifyPassword já aceita os dois
 * formatos. Ninguém precisa saber a senha de ninguém, e ninguém perde acesso.
 *
 * COMO USAR (na VM):
 *   node scripts/migrar-usuarios.js --gestor=jose --dry-run   # confere
 *   node scripts/migrar-usuarios.js --gestor=jose             # grava
 *
 * `--gestor` é OBRIGATÓRIO: alguém precisa sair da migração podendo gerenciar,
 * senão a tela nasce inútil — ninguém pode criar ninguém, e o único caminho de
 * volta é editar o banco à mão, que é o problema que isto existe pra acabar.
 *
 * Idempotente: rodar duas vezes não duplica nem sobrescreve senha.
 *
 * Spec: docs/handoff/SPEC-gestao-usuarios-2026-09-21.md §8
 */

'use strict';

/**
 * Parte PURA: decide o que inserir. Sem banco, sem I/O — é o que o teste cobre.
 *
 * @param authUsers  o conteúdo cru do AUTH_USERS
 * @param gestor     username que sai com pode_gerenciar
 * @param jaNoBanco  [{ username }] dos que já existem
 */
function planejarMigracao(authUsers, gestor, jaNoBanco) {
  const erros = [], inserir = [], pulados = [];
  const existentes = new Set((jaNoBanco || []).map(u => u.username));

  const entradas = String(authUsers || '').split(',').map(s => s.trim()).filter(Boolean);
  if (entradas.length === 0) {
    erros.push('AUTH_USERS está vazio — nada a migrar. Confira o .env.');
    return { erros, inserir, pulados };
  }

  const parsed = entradas.map(e => {
    const [username, senha_hash, role, regionals] = e.split(':');
    return { username, senha_hash, role: role || 'user', regionals: regionals || '' };
  });

  if (!gestor) {
    erros.push('--gestor=<username> é obrigatório: alguém precisa sair da migração '
      + 'podendo gerenciar usuários, senão a tela nasce inútil.');
    return { erros, inserir, pulados };
  }
  const oGestor = parsed.find(u => u.username === gestor);
  if (!oGestor) {
    erros.push(`--gestor="${gestor}" não está no AUTH_USERS. Presentes: `
      + parsed.map(u => u.username).join(', '));
    return { erros, inserir, pulados };
  }
  if (oGestor.role !== 'admin') {
    erros.push(`--gestor="${gestor}" não é admin. O gestor inicial tem de ser admin.`);
    return { erros, inserir, pulados };
  }

  parsed.forEach(u => {
    if (existentes.has(u.username)) { pulados.push(u.username); return; }
    inserir.push({
      username:       u.username,
      senha_hash:     u.senha_hash,     // IDÊNTICO ao do .env — não re-hasheia
      role:           u.role,
      regionals:      u.regionals,
      ativo:          true,
      pode_gerenciar: u.username === gestor,
      criado_por:     'migracao',
    });
  });

  return { erros, inserir, pulados };
}

async function main() {
  require('dotenv').config();
  const args   = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const gestor = (args.find(a => a.startsWith('--gestor=')) || '').split('=')[1] || null;

  const { getClient } = require('../services/dbClient');
  const sb = getClient();

  const { data: jaNoBanco, error } = await sb.from('usuarios').select('username');
  if (error) { console.error('✗ não consegui ler a tabela usuarios:', error.message); process.exit(1); }

  const plano = planejarMigracao(process.env.AUTH_USERS, gestor, jaNoBanco || []);

  if (plano.erros.length) {
    plano.erros.forEach(e => console.error('✗', e));
    process.exit(1);
  }

  console.log(`\nA inserir (${plano.inserir.length}):`);
  plano.inserir.forEach(u => console.log(
    `  ${u.username.padEnd(16)} role=${u.role.padEnd(5)} ` +
    `regionals=${u.regionals.padEnd(14)} gerencia=${u.pode_gerenciar}`));
  if (plano.pulados.length) {
    console.log(`\nJá no banco, pulados (${plano.pulados.length}): ${plano.pulados.join(', ')}`);
  }

  if (dryRun) { console.log('\n--dry-run: nada foi gravado.\n'); return; }
  if (plano.inserir.length === 0) { console.log('\nNada a inserir.\n'); return; }

  const { error: insErr } = await sb.from('usuarios').insert(plano.inserir);
  if (insErr) { console.error('✗ falha ao inserir:', insErr.message); process.exit(1); }

  console.log(`\n✓ ${plano.inserir.length} usuário(s) migrado(s).`);
  console.log('  PRÓXIMO PASSO: confira o login de CADA conta antes de limpar o .env.');
  console.log('  Ver seção 8 da SPEC-gestao-usuarios-2026-09-21.md\n');
}

if (require.main === module) {
  main().catch(err => { console.error('✗', err.message); process.exit(1); });
}

module.exports = { planejarMigracao };
```

- [ ] **Step 4: Rodar e verificar que passa**

Run: `node --test test/migrarUsuarios.test.js`
Expected: PASS — 7 testes

- [ ] **Step 5: Rodar a suíte inteira e commitar**

Run: `node --test`
Expected: 0 falhas

```bash
git add scripts/migrar-usuarios.js test/migrarUsuarios.test.js
git commit -m "feat(usuarios): script de migracao do AUTH_USERS

  COPIA OS HASHES, nunca senhas — elas nao existem em lugar nenhum, e o
  _verifyPassword ja aceita os dois formatos. E o que garante que ninguem
  perde acesso na migracao.

  --gestor e obrigatorio: alguem precisa sair da migracao podendo gerenciar,
  senao a tela nasce inutil e o unico caminho de volta e editar o banco a mao.
  O script valida que o username existe no AUTH_USERS e que e admin.

  Idempotente: quem ja esta no banco e pulado, nao sobrescrito. A parte de
  decisao e pura e testada; o I/O fica no main().

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: A tela

**Files:**
- Modify: `public/index.html` (seção nova no Admin, junto de Equipes Oficiais)

- [ ] **Step 1: Markup**

Em `public/index.html`, depois do bloco "Equipes Oficiais":

```html
          <!-- Usuários do painel (SPEC-gestao-usuarios-2026-09-21) -->
          <div>
            <div class="modal-section-title">👤 Usuários do Painel</div>
            <div style="font-size:12px;color:var(--text2);margin-bottom:12px">
              Conceder e retirar acesso. Desativar tem efeito <b>em até 30 segundos</b> —
              a pessoa cai na ação seguinte, não precisa esperar a sessão expirar.
              A conta de emergência do servidor não aparece aqui de propósito.
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
              <button class="btn-refresh" onclick="loadUsuarios()" style="height:36px;padding:0 16px;font-size:12px">↻ Listar</button>
              <button class="btn-refresh" onclick="abrirNovoUsuario()" style="height:36px;padding:0 16px;font-size:12px;background:var(--verde);color:#fff">+ Novo</button>
              <button class="btn-refresh" onclick="loadUsuariosLog()" style="height:36px;padding:0 16px;font-size:12px">📜 Auditoria</button>
              <span id="usr-status" style="font-size:11px;color:var(--text2)"></span>
            </div>
            <div id="usr-tabela" style="display:none;max-height:340px;overflow-y:auto;border:1px solid var(--cinza2);border-radius:6px"></div>
            <div id="usr-form" style="display:none;margin-top:12px;padding:12px;background:var(--cinza1);border:1px solid var(--cinza2);border-radius:6px"></div>
            <div id="usr-senha" style="display:none;margin-top:12px"></div>
            <div id="usr-log" style="display:none;margin-top:12px;max-height:280px;overflow-y:auto;border:1px solid var(--cinza2);border-radius:6px"></div>
          </div>
```

- [ ] **Step 2: As funções**

Acrescente junto das funções de Equipes Oficiais:

```js
    // ── USUÁRIOS DO PAINEL ────────────────────────────────────────────────────
    let _usrCache = [];

    async function loadUsuarios() {
      const cont = document.getElementById('usr-tabela');
      cont.style.display = 'block';
      cont.innerHTML = '<div style="padding:12px;font-size:12px;color:var(--text2)">⏳ Carregando…</div>';
      try {
        const res  = await fetch(`${API}/admin/usuarios`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'erro');
        _usrCache = data.usuarios || [];
        document.getElementById('usr-status').textContent =
          `${_usrCache.length} usuários (${_usrCache.filter(u => u.ativo).length} ativos)`;
        cont.innerHTML = _renderUsuarios(_usrCache);
      } catch (err) {
        cont.innerHTML = `<div style="padding:12px;color:var(--vermelho);font-size:12px">✗ ${err.message}</div>`;
      }
    }

    /** PURA — por isso é testável. */
    function _renderUsuarios(usrs) {
      if (!usrs || usrs.length === 0) {
        return '<div style="padding:12px;font-size:12px;color:var(--text2)">Nenhum usuário cadastrado.</div>';
      }
      const esc = s => escapeHtml(String(s === null || s === undefined ? '' : s));
      const linhas = usrs.map(u => `<tr style="${u.ativo ? '' : 'opacity:.45'};border-top:1px solid var(--cinza2)">
        <td style="padding:6px 8px;font-family:monospace;font-weight:600">${esc(u.username)}</td>
        <td style="padding:6px 8px;font-size:11px">${esc(u.role)}</td>
        <td style="padding:6px 8px;font-size:11px">${(u.regionals || []).map(esc).join(', ')}</td>
        <td style="padding:6px 8px;font-size:11px">${u.pode_gerenciar ? '✓ gestor' : '—'}</td>
        <td style="padding:6px 8px;font-size:11px">${u.ativo
          ? '<span style="color:var(--verde)">Ativo</span>'
          : '<span style="color:var(--vermelho)">Inativo</span>'}</td>
        <td style="padding:6px 8px;text-align:right;white-space:nowrap">
          <button onclick="editarUsuario('${esc(u.username)}')" style="background:none;border:1px solid var(--cinza2);border-radius:4px;padding:3px 8px;font-size:11px;cursor:pointer;margin-right:4px">✎</button>
          <button onclick="resetarSenhaUsuario('${esc(u.username)}')" style="background:none;border:1px solid var(--cinza2);border-radius:4px;padding:3px 8px;font-size:11px;cursor:pointer;margin-right:4px">🔑</button>
          <button onclick="alternarUsuarioAtivo('${esc(u.username)}', ${!u.ativo})" style="background:none;border:1px solid var(--cinza2);border-radius:4px;padding:3px 8px;font-size:11px;cursor:pointer">${u.ativo ? '↓ Desativar' : '↑ Ativar'}</button>
        </td></tr>`).join('');

      return `<table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead style="background:var(--cinza1);position:sticky;top:0">
          <tr style="text-transform:uppercase;letter-spacing:.04em;color:var(--text2);font-size:10px">
            <th style="padding:6px 8px;text-align:left">Usuário</th>
            <th style="padding:6px 8px;text-align:left">Papel</th>
            <th style="padding:6px 8px;text-align:left">Regionais</th>
            <th style="padding:6px 8px;text-align:left">Gestão</th>
            <th style="padding:6px 8px;text-align:left">Situação</th>
            <th style="padding:6px 8px;text-align:right">Ações</th>
          </tr>
        </thead><tbody>${linhas}</tbody></table>`;
    }

    /**
     * Mostra a senha gerada. UMA vez — não fica guardada em lugar nenhum.
     * O aviso é explícito de propósito: esquecida, o caminho é gerar outra.
     */
    function _mostrarSenhaGerada(username, senha) {
      const el = document.getElementById('usr-senha');
      el.style.display = 'block';
      el.innerHTML = `
        <div style="padding:12px;border:2px solid var(--amarelo);border-radius:6px;background:#fff8e1">
          <div style="font-size:12px;font-weight:700;margin-bottom:6px">
            🔑 Senha de <span style="font-family:monospace">${escapeHtml(username)}</span>
          </div>
          <div style="font-family:monospace;font-size:16px;font-weight:700;letter-spacing:.05em;
                      padding:8px;background:#fff;border:1px solid var(--cinza2);border-radius:4px;
                      user-select:all">${escapeHtml(senha)}</div>
          <div style="font-size:11px;color:var(--text2);margin-top:8px">
            <b>Copie agora.</b> Ela não será mostrada de novo e não fica guardada em lugar
            nenhum — se perder, o caminho é gerar outra.
          </div>
          <button class="btn-refresh" onclick="document.getElementById('usr-senha').style.display='none'"
            style="margin-top:8px;height:28px;padding:0 12px;font-size:11px">Já copiei</button>
        </div>`;
    }

    function abrirNovoUsuario() {
      const form = document.getElementById('usr-form');
      form.style.display = 'block';
      form.innerHTML = `
        <div style="font-size:12px;font-weight:600;margin-bottom:8px">Novo usuário</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1.6fr;gap:8px;margin-bottom:8px">
          <div>
            <label style="font-size:10px;color:var(--text2);text-transform:uppercase">Usuário</label>
            <input id="usr-f-username" placeholder="nome_de_usuario"
              style="width:100%;padding:6px;border:1px solid var(--cinza2);border-radius:4px;font-family:monospace;font-size:13px" />
          </div>
          <div>
            <label style="font-size:10px;color:var(--text2);text-transform:uppercase">Papel</label>
            <select id="usr-f-role" style="width:100%;padding:6px;border:1px solid var(--cinza2);border-radius:4px;font-size:13px">
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <div>
            <label style="font-size:10px;color:var(--text2);text-transform:uppercase">Regionais</label>
            <div style="display:flex;gap:10px;padding-top:6px">
              ${REGIONAIS_ATIVAS.map(r => `<label style="font-size:12px;display:flex;gap:4px;align-items:center">
                <input type="checkbox" class="usr-f-reg" value="${r}" />${r}</label>`).join('')}
            </div>
          </div>
        </div>
        <div style="font-size:11px;color:var(--text2);margin-bottom:8px">
          A senha é gerada pelo sistema e mostrada uma única vez ao salvar.
        </div>
        <div style="display:flex;gap:8px">
          <button onclick="salvarNovoUsuario()" class="btn-refresh" style="height:32px;padding:0 16px;font-size:12px;background:var(--verde);color:#fff">Criar</button>
          <button onclick="document.getElementById('usr-form').style.display='none'" class="btn-refresh" style="height:32px;padding:0 16px;font-size:12px">Cancelar</button>
          <span id="usr-f-msg" style="font-size:11px;align-self:center"></span>
        </div>`;
    }

    async function salvarNovoUsuario() {
      const msg = document.getElementById('usr-f-msg');
      const corpo = {
        username:  document.getElementById('usr-f-username').value.trim().toLowerCase(),
        role:      document.getElementById('usr-f-role').value,
        regionals: [...document.querySelectorAll('.usr-f-reg:checked')].map(c => c.value),
      };
      msg.textContent = '⏳ Criando…';
      msg.style.color = 'var(--text2)';
      try {
        const res  = await fetch(`${API}/admin/usuarios`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(corpo),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        document.getElementById('usr-form').style.display = 'none';
        _mostrarSenhaGerada(data.username, data.senha);
        await loadUsuarios();
      } catch (err) {
        msg.textContent = '✗ ' + err.message;
        msg.style.color = 'var(--vermelho)';
      }
    }

    function editarUsuario(username) {
      const u = _usrCache.find(x => x.username === username);
      if (!u) return;
      const form = document.getElementById('usr-form');
      form.style.display = 'block';
      form.innerHTML = `
        <div style="font-size:12px;font-weight:600;margin-bottom:8px">Editar ${escapeHtml(username)}</div>
        <div style="display:grid;grid-template-columns:1fr 1.6fr 1fr;gap:8px;margin-bottom:8px">
          <div>
            <label style="font-size:10px;color:var(--text2);text-transform:uppercase">Papel</label>
            <select id="usr-e-role" style="width:100%;padding:6px;border:1px solid var(--cinza2);border-radius:4px;font-size:13px">
              <option value="user" ${u.role === 'user' ? 'selected' : ''}>user</option>
              <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>admin</option>
            </select>
          </div>
          <div>
            <label style="font-size:10px;color:var(--text2);text-transform:uppercase">Regionais</label>
            <div style="display:flex;gap:10px;padding-top:6px">
              ${REGIONAIS_ATIVAS.map(r => `<label style="font-size:12px;display:flex;gap:4px;align-items:center">
                <input type="checkbox" class="usr-e-reg" value="${r}" ${(u.regionals || []).includes(r) ? 'checked' : ''} />${r}</label>`).join('')}
            </div>
          </div>
          <div>
            <label style="font-size:10px;color:var(--text2);text-transform:uppercase">Gestão</label>
            <label style="font-size:12px;display:flex;gap:6px;align-items:center;padding-top:6px">
              <input type="checkbox" id="usr-e-gerenciar" ${u.pode_gerenciar ? 'checked' : ''} />
              pode gerenciar usuários
            </label>
          </div>
        </div>
        <div style="display:flex;gap:8px">
          <button onclick="salvarEdicaoUsuario('${escapeHtml(username)}')" class="btn-refresh" style="height:32px;padding:0 16px;font-size:12px;background:var(--verde);color:#fff">Salvar</button>
          <button onclick="document.getElementById('usr-form').style.display='none'" class="btn-refresh" style="height:32px;padding:0 16px;font-size:12px">Cancelar</button>
          <span id="usr-e-msg" style="font-size:11px;align-self:center"></span>
        </div>`;
    }

    async function salvarEdicaoUsuario(username) {
      const msg = document.getElementById('usr-e-msg');
      msg.textContent = '⏳ Salvando…';
      try {
        const res = await fetch(`${API}/admin/usuarios/${encodeURIComponent(username)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            role:           document.getElementById('usr-e-role').value,
            regionals:      [...document.querySelectorAll('.usr-e-reg:checked')].map(c => c.value),
            pode_gerenciar: document.getElementById('usr-e-gerenciar').checked,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        document.getElementById('usr-form').style.display = 'none';
        await loadUsuarios();
      } catch (err) {
        msg.textContent = '✗ ' + err.message;
        msg.style.color = 'var(--vermelho)';
      }
    }

    async function alternarUsuarioAtivo(username, novoAtivo) {
      const acao = novoAtivo ? 'REATIVAR' : 'DESATIVAR';
      if (!confirm(`${acao} o acesso de ${username}?`)) return;
      try {
        const res = await fetch(
          `${API}/admin/usuarios/${encodeURIComponent(username)}/${novoAtivo ? 'reativar' : 'desativar'}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'erro');
        await loadUsuarios();
      } catch (err) { alert('✗ ' + err.message); }
    }

    async function resetarSenhaUsuario(username) {
      if (!confirm(`Gerar uma senha NOVA para ${username}? A atual deixa de funcionar.`)) return;
      try {
        const res = await fetch(`${API}/admin/usuarios/${encodeURIComponent(username)}/senha`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'erro');
        _mostrarSenhaGerada(data.username, data.senha);
      } catch (err) { alert('✗ ' + err.message); }
    }

    async function loadUsuariosLog() {
      const el = document.getElementById('usr-log');
      el.style.display = 'block';
      el.innerHTML = '<div style="padding:12px;font-size:12px;color:var(--text2)">⏳ Carregando…</div>';
      try {
        const res  = await fetch(`${API}/admin/usuarios/log`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'erro');
        const esc = s => escapeHtml(String(s === null || s === undefined ? '' : s));
        el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:11px">
          <thead style="background:var(--cinza1);position:sticky;top:0">
            <tr style="text-transform:uppercase;letter-spacing:.04em;color:var(--text2);font-size:10px">
              <th style="padding:6px 8px;text-align:left">Quando</th>
              <th style="padding:6px 8px;text-align:left">Quem</th>
              <th style="padding:6px 8px;text-align:left">Ação</th>
              <th style="padding:6px 8px;text-align:left">Em quem</th>
              <th style="padding:6px 8px;text-align:left">Detalhe</th>
            </tr></thead>
          <tbody>${(data.log || []).map(l => `<tr style="border-top:1px solid var(--cinza2)">
            <td style="padding:4px 8px;white-space:nowrap">${new Date(l.ts).toLocaleString('pt-BR')}</td>
            <td style="padding:4px 8px;font-family:monospace">${esc(l.ator)}</td>
            <td style="padding:4px 8px">${esc(l.acao)}</td>
            <td style="padding:4px 8px;font-family:monospace">${esc(l.alvo)}</td>
            <td style="padding:4px 8px;color:var(--text2)">${l.detalhe ? esc(JSON.stringify(l.detalhe)) : '—'}</td>
          </tr>`).join('')}</tbody></table>`;
      } catch (err) {
        el.innerHTML = `<div style="padding:12px;color:var(--vermelho);font-size:12px">✗ ${err.message}</div>`;
      }
    }
```

- [ ] **Step 3: Rodar a suíte inteira**

Run: `node --test`
Expected: 0 falhas. O `test/htmlScriptSintaxe.test.js` pega erro de digitação
no `<script>`.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat(usuarios): tela de gestao de acesso no Admin

  Lista com papel, regionais, quem gerencia e situacao. Criar, editar, resetar
  senha, desativar e reativar, mais a aba de auditoria.

  A senha gerada aparece num aviso destacado que diz, com todas as letras, que
  nao sera mostrada de novo e nao fica guardada em lugar nenhum. A conta de
  emergencia do servidor nao aparece na lista de proposito — ela vive no .env
  e so o Jose a altera.

  O texto do cabecalho diz que desativar vale em ATE 30 SEGUNDOS, que e o TTL
  do cache. Prometer 'imediato' seria mentira por meio minuto.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 9: Backlog e documentação

**Files:**
- Modify: `docs/handoff/BACKLOG.md`, `docs/handoff/RUNBOOK.md`
- Modify: `docs/handoff/SPEC-gestao-usuarios-2026-09-21.md` (status)
- Modify: `.env.example`

- [ ] **Step 1: `.env.example`**

Substitua o bloco do `AUTH_USERS` por:

```
# ⚠️ DEPOIS DA MIGRAÇÃO (21/09/2026), esta variável guarda APENAS a conta de
# EMERGÊNCIA. Os demais usuários vivem na tabela `usuarios` e são gerenciados
# em Admin → Usuários do Painel.
#
# A conta daqui é a chave reserva: com o Postgres fora, é a ÚNICA que entra.
# Todo username listado aqui é RESERVADO — o banco recusa criar homônimo — e,
# em colisão, esta entrada vence.
#
# NÃO acrescente usuários comuns aqui. Use a tela.
AUTH_USERS=emergencia:HASH_SCRYPT:admin:GUA|CAC|SJC
```

- [ ] **Step 2: Linha no índice do BACKLOG**

Depois da linha do `P2-53`:

```markdown
| P0-1a | Conceder e retirar acesso exigia SSH na VM, editar o `.env` e reiniciar — só o José fazia. Nenhum usuário existia no banco | Governança/Segurança | **done** (21/09) — usuários no banco + tela + revogação imediata + auditoria; 40+ testes; **falta migrar e confirmar em prod** |
```

- [ ] **Step 3: Item completo no fim do BACKLOG**

```markdown

---

## P0-1a — Gestão de usuários: conceder e retirar acesso pela tela

- **Categoria:** Governança / Segurança
- **Status:** **done** (21/09/2026) — **falta rodar a migração e confirmar em produção**
- **Relação com o P0-1:** é uma fatia dele. Não resolve o bus factor inteiro
  (senhas da EDP, Cloudflare e o `.env` seguem só com o José), mas tira do
  caminho crítico a única operação que **impedia outra pessoa de entrar no
  painel**. E reduz de cinco para **uma** as credenciais de login que precisam
  sobreviver num cofre.
- **Fonte:** pedido do José em 21/09/2026: *"quero montar uma estrutura de
  fornecer acesso aos usuários, e no caso teríamos acesso a retirar acessos
  também."*
- **O que existia:** usuários só na variável `AUTH_USERS` do `.env` da VM.
  Nenhuma tabela de usuário no banco. Conceder acesso = SSH + editar arquivo +
  `pm2 delete && pm2 start`.
- **Ação:** tabelas `usuarios` e `usuarios_log`; o login passa a ler do banco;
  sete rotas sob guarda dupla; tela no Admin; script de migração.
- **Decisões registradas:**
  - **A migração copia HASHES, não senhas.** As senhas em texto puro não
    existem em lugar nenhum, e o `_verifyPassword` já aceitava os dois
    formatos. Ninguém perdeu acesso.
  - **Conta de emergência no `.env`.** O login passou a depender do Postgres, e
    em 09/07/2026 ele caiu em produção (P0-0 segue aberto, VM sem swap). Sem a
    chave reserva, um repeteco trancaria todo mundo para fora — inclusive de
    descobrir que o banco caiu. Todo username no `AUTH_USERS` é reservado, e em
    colisão o `.env` vence.
  - **"O token prova quem você é; o banco diz o que você pode."** Desativar tem
    efeito em até 30s (o TTL do cache), não em até 8h. De quebra, mudança de
    permissão também passa a valer na hora.
  - **Banco fora: vale o cache; sem cache, NEGA.** É o oposto do fail-open que
    o P1-32 consertou no breaker de login.
  - **`pode_gerenciar` é separada de `role=admin`.** Admin abre o `/admin`
    inteiro; gerenciar usuário é permissão à parte — decisão explícita do José
    ("só você, por enquanto"), e é como uma segunda pessoa entra depois sem
    refazer nada.
  - **A senha gerada evita `O/0` e `l/1/I`**, porque é transcrita à mão de uma
    pessoa para outra.
- **Aceite:**
  - [x] Suíte verde, com os testes HTTP das sete rotas.
  - [x] Teste varrendo o JSON de todas as rotas atrás de `senha_hash` e `scrypt$`.
  - [x] Teste de que, com o banco fora e sem cache, o acesso é **negado**.
  - [ ] **Migration aplicada na VM** (`psql -f migrations/add_usuarios.sql`).
  - [ ] **`migrar-usuarios.js --dry-run` conferido**, depois rodado.
  - [ ] **Login de CADA conta testado** antes de limpar o `.env`.
  - [ ] `.env` reduzido à conta de emergência, e reiniciado.
  - [ ] **Em produção:** criar um usuário de teste, entrar com ele, desativar, e
        confirmar que ele cai em menos de 30s.
- **Rollback:** `git revert` + restaurar o `AUTH_USERS` completo no `.env`. A
  tabela pode ficar: sem o código novo, ninguém a lê. **O que `git` não desfaz**
  é a senha de quem for criado depois da migração — essas contas só existem no
  banco.
- **Fora de escopo:** troca obrigatória de senha no 1º login (incremento 2);
  autoatendimento de senha; recuperação por e-mail (não há envio no projeto);
  perfis/grupos de permissão.
```

- [ ] **Step 4: RUNBOOK**

Acrescente uma seção ao `docs/handoff/RUNBOOK.md`:

```markdown
## Dar ou tirar acesso ao painel

**Pelo painel:** Admin → Usuários do Painel. Criar gera a senha e a mostra uma
vez. Desativar tem efeito em até 30 segundos.

**Se o painel estiver fora do ar**, entre com a conta de emergência do `.env`
(a única que resta lá). Ela funciona mesmo com o Postgres fora — é a razão de
existir.

**Se NEM a conta de emergência entrar**, o problema não é de acesso: é o
processo ou o `.env`. Ver a seção de reinício.

⚠️ **Não acrescente usuário comum no `AUTH_USERS`.** Todo nome listado lá é
reservado e não pode ser criado pela tela — e, em colisão, o `.env` vence, o
que produz uma conta que a tela mostra mas que não é a que entra.
```

- [ ] **Step 5: Status do spec**

```markdown
> Data: 2026-09-21 · Status: **implementado** — falta migrar e confirmar em
> produção. Ver P0-1a no BACKLOG e `PLANO-gestao-usuarios-2026-09-21.md`.
```

- [ ] **Step 6: Rodar a suíte e commitar**

Run: `node --test`
Expected: 0 falhas

```bash
git add docs/handoff/ .env.example
git commit -m "docs: P0-1a no backlog, RUNBOOK e .env.example

  Registra a relacao com o P0-1: nao resolve o bus factor inteiro, mas tira do
  caminho critico a unica operacao que IMPEDIA outra pessoa de entrar no
  painel, e reduz de cinco pra UMA as credenciais de login que precisam
  sobreviver num cofre.

  O .env.example passa a avisar que aquela variavel guarda APENAS a conta de
  emergencia, e que acrescentar usuario comum ali produz uma conta que a tela
  mostra mas que nao e a que entra.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Implantação — a ordem importa

**Esta é a única parte com ordem obrigatória, porque mexe em quem entra.** Cada
passo é reversível sozinho, e em nenhum momento existe janela em que alguém
legítimo fica sem entrar.

- [ ] **1.** `git pull` e deploy normal. A tabela ainda não existe; o
      `getUsers` cai no `catch` e serve só o `.env` — **comportamento idêntico
      ao de hoje**.
- [ ] **2.** Aplicar a migration:
      `psql -d wpa_monitor -f migrations/add_usuarios.sql`
- [ ] **3.** Conferir o plano sem gravar:
      `node scripts/migrar-usuarios.js --gestor=<seu_usuario> --dry-run`
- [ ] **4.** Gravar: o mesmo comando sem `--dry-run`.
- [ ] **5.** **Testar o login de CADA conta.** Os hashes são os mesmos, então
      tanto faz se responde o `.env` ou o banco — mas é aqui que se descobre se
      algo saiu torto, enquanto as duas fontes ainda existem.
- [ ] **6.** Reduzir o `AUTH_USERS` à conta de emergência e reiniciar com
      `pm2 delete wpa-monitor && pm2 start ecosystem.config.js && pm2 save`.
- [ ] **7.** Testar de novo o login de cada conta — agora valendo só o banco.
- [ ] **8.** Criar um usuário de teste pela tela, entrar com ele, desativar, e
      confirmar que ele cai em menos de 30 segundos. Depois, desativá-lo de vez.

> Se algo der errado entre 4 e 6, o caminho de volta é simplesmente **não**
> reduzir o `.env`: as contas continuam lá e continuam entrando.
