# SPEC — Troca de senha: obrigatória no 1º acesso, e voluntária depois

> Data: 2026-09-22 · Status: **especificado**, nada implementado.
>
> Incremento **2 de 2** da gestão de usuários. O incremento 1 (P0-1a) está no ar
> e verificado desde 22/09/2026.
>
> ⚠️ Mexe em **autenticação**. Vale tudo o que vale para o incremento 1: os
> testes de trava são HTTP, não inspeção de código-fonte.

## 1. O pedido

José, 22/09/2026, depois de usar a tela nova: *"deu certo criar, ele gera uma
senha aleatória, porém não tem opção de mudar a senha no primeiro acesso ou
mudar a senha só, logo essa senha gerada é facilmente esquecida."*

É exatamente o que ele havia escolhido em 21/09 quando perguntei sobre o fluxo
de senha ("gerada + troca obrigatória no 1º login"), e que eu separei para não
empilhar duas mudanças de autenticação no mesmo spec. Ele chegou ao mesmo ponto
**usando**, não especulando.

## 2. O que existe hoje

- A senha é gerada (20 caracteres, alfabeto sem ambíguos) e mostrada **uma
  vez** ao criar ou resetar.
- **Não existe rota para a pessoa trocar a própria senha** (conferido:
  `grep 'auth/senha' routes/index.js` não retorna nada).
- O login devolve `token, v, username, role, regionals, exp` — nenhuma marca de
  que a senha é provisória.

Consequência prática: a pessoa recebe 20 caracteres aleatórios e ou os anota
num papel, ou pede reset toda vez — que volta a cair no colo do José.

## 3. Decisões

### 3.1 O bloqueio é no servidor, não só na tela

Com a senha provisória, a API recusa tudo exceto a troca. Fazer só no frontend
seria incoerente com o princípio do incremento 1 — *o token prova quem você é,
o banco diz o que você pode* — e seria contornável chamando a API direto.

### 3.2 `423 Locked`, não `403`

`403` já significa "você não tem permissão" no painel, e reusá-lo faria a tela
de troca competir com a de acesso negado. Um código distinto deixa o frontend
decidir sem adivinhar.

O corpo carrega `code: 'SENHA_PROVISORIA'` — é por ele que o frontend decide,
não pelo número.

### 3.3 Resetar a senha de alguém também marca como provisória

Senão o gestor gera uma senha nova e a pessoa fica com a sequência aleatória
para sempre, que é o problema que originou este spec.

### 3.4 Depois de trocar, a sessão continua

Sem relogin. O token segue válido — só o hash mudou. Menos atrito, e não há
ganho de segurança em forçar o contrário: quem trocou já provou quem é.

### 3.5 A conta de emergência não entra nisso

Ela não tem linha no banco, então não tem como ser provisória. Coerente com ela
ser a chave reserva: **se o fluxo de troca quebrar, ela continua entrando.**

### 3.6 A regra da senha: mínimo 8, e mais nada

Decisão do José. Sem exigência de maiúscula, número ou símbolo.

Registrado que eu recomendei mínimo 12 sem composição (orientação atual do
NIST: comprimento supera composição, e regras de composição produzem
"Senha@2026" repetida em todo lugar). Ele escolheu 8 simples, e é a escolha
dele — num painel de rede interna, com rate limit por IP e por usuário (P1-42),
o risco é menor.

**Duas checagens que NÃO são política e sim sanidade:**

- **A nova não pode ser igual à atual.** Sem isso, a pessoa "troca" para a
  mesma sequência provisória, a marca some, e nada mudou. É a diferença entre o
  fluxo funcionar e ser teatro.
- **A atual tem de ser conferida** antes de gravar a nova. Sem isso, quem pegar
  uma sessão aberta troca a senha sem saber a antiga.

## 4. Modelo de dados

Uma coluna em `usuarios`:

| coluna | tipo | nota |
|---|---|---|
| `senha_provisoria` | `boolean NOT NULL DEFAULT false` | `true` na criação e no reset |

`DEFAULT false` de propósito: os **cinco usuários já migrados** não são forçados
a trocar. Eles têm senhas que já usam e conhecem; obrigá-los seria atrito sem
motivo — a senha deles nunca foi gerada pelo sistema.

## 5. Arquitetura

### 5.1 A rota nova

```
POST /api/auth/senha     { atual, nova }
```

Fica **acima** do bloqueio (é a única saída dele), e **abaixo** do
`authMiddleware` (exige estar logado). Troca a senha de `req.user.username` —
nunca de outro; não aceita `username` no corpo.

Devolve `400` com motivo legível para: nova com menos de 8, nova igual à atual,
atual incorreta. Nunca `500` por payload ruim.

A conta de emergência recebe `400` explicando que a senha dela se altera no
`.env` — senão a troca gravaria numa linha que não existe, ou criaria uma, e a
pessoa acharia que funcionou.

### 5.2 O bloqueio

No `authMiddleware`, depois de resolver o usuário: se `senha_provisoria`, e o
caminho não for a rota de troca nem o logout, responde `423`.

### 5.3 O login informa

A resposta de `/auth/login` ganha `senha_provisoria: true|false`, para o
frontend já abrir na tela certa em vez de tentar carregar o painel e tomar
`423`.

### 5.4 A tela

Um overlay como o de login, exibido quando `senha_provisoria` vem `true` ou
quando alguma chamada devolve `SENHA_PROVISORIA`. Três campos: senha atual,
nova, e confirmação.

E um acesso voluntário: um item no menu do usuário abre o mesmo overlay, com a
diferença de poder ser fechado. É o *"ou mudar a senha só"* do pedido.

## 6. Testes

**Puros** (`services/usuarios.js`):
- `validarTrocaSenha`: nova com 7 → erro; com 8 → ok; igual à atual → erro;
  vazia/nula → erro

**HTTP** (`test/trocaSenhaHttp.test.js`):
- sem token → 401
- com senha provisória, qualquer rota → **423 com `code: SENHA_PROVISORIA`**
- com senha provisória, a rota de troca → **passa** (é a saída)
- atual incorreta → 400, e a senha **não muda**
- nova com menos de 8 → 400
- nova igual à atual → 400
- troca bem-sucedida → 200, e `senha_provisoria` vira false
- o corpo não aceita `username` de outra pessoa (troca só a própria)
- conta de emergência → 400 explicando que é no `.env`
- **a senha nova não aparece em nenhuma resposta nem no log de auditoria**

**Fluxo completo** (`test/trocaSenhaFluxo.test.js`):
- criar usuário → login com a gerada → 423 em rota comum → troca → 200 na
  mesma rota → login de novo com a NOVA senha funciona e a antiga não

## 7. Rollback

`git revert` + `ALTER TABLE usuarios DROP COLUMN senha_provisoria`.

Ninguém perde acesso: sem a coluna, o bloqueio não existe e todos entram como
hoje. Quem já tiver trocado a senha continua com a nova — é a única coisa que
não volta, e é a que se quer preservar mesmo.

## 8. Fora de escopo

- **Recuperação por e-mail.** Não há envio de e-mail no projeto.
- **Histórico de senhas** (impedir reuso das últimas N). Com 5 usuários, resolve
  um problema que não existe.
- **Expiração periódica de senha.** Orientação atual é contra: força troca
  ritual, que produz senha incremental (`Senha1`, `Senha2`).
- **Forçar os 5 usuários migrados a trocar.** Ver §4.
