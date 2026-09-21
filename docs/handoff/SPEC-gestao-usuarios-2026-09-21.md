# SPEC — Gestão de usuários: conceder e retirar acesso pela tela

> Data: 2026-09-21 · Status: **especificado**, nada implementado.
>
> Incremento **1 de 2**. O incremento 2 — troca obrigatória de senha no
> primeiro login — tem spec própria e vem depois, ver §11.
>
> ⚠️ Este spec mexe em **autenticação**. Cinco itens do backlog já foram furos
> de controle de acesso neste código: P0-4, P1-12, P1-18, P1-38, P1-42. Aqui
> teste que só lê o código-fonte não basta — cada trava precisa de teste HTTP.

## 1. O pedido

José, 21/09/2026: *"quero montar uma estrutura de fornecer acesso aos usuários,
e no caso teríamos acesso a retirar acessos também."*

Confirmado que o escopo é **os dois**: criar e desativar contas, **e** controlar
o que cada uma enxerga.

## 2. O que existe hoje

**Os usuários vivem só na variável `AUTH_USERS` do `.env` da VM.** Não existe
tabela de usuários no banco (conferido no `schema-atual.sql`: 17 tabelas,
nenhuma de usuário).

Formato: `usuario:hash:role:GUA|CAC|SJC` (`.env.example:55`). O `role` só
distingue `admin` de resto. O hash aceita dois formatos — `scrypt$salt$hash`
(preferido) e SHA-256 legado.

**Conceder ou retirar acesso hoje** = entrar na VM por SSH, editar o `.env` à
mão, e `pm2 delete && pm2 start`. Só o José faz. É o **P0-1** (bus factor) na
prática: não existe como dar acesso a ninguém sem ele.

**Raio de alcance pequeno:** `getUsers()` (`middleware/auth.js:65`) é chamado em
**um único lugar** do código de produção — `login()`, em
`middleware/auth.js:147`. O resto do sistema só vê o JWT.

## 3. Decisões tomadas

### 3.1 A migração não pede a senha de ninguém

As senhas em texto puro **não existem em lugar nenhum** — o `.env` só guarda
hashes. E não precisamos delas: o `_verifyPassword` já aceita os dois formatos,
então a migração **copia os hashes como estão**.

Ninguém precisa saber a senha de ninguém, e ninguém perde acesso. Isso é o que
torna a migração segura de rodar num sábado.

### 3.2 `regionals` fica como texto, no formato de hoje

`GUA|CAC`, e não um array do Postgres.

Não é elegante, e é deliberado: reusa o parser e as validações que já existem no
`auth.js` — inclusive as que recusam `ALL` e grupos como `ES`, que foram
endurecidas por incidente. Um formato novo significaria um segundo parser, e é
assim que as duas metades divergem.

### 3.3 Conta de emergência no `.env`, com nome reservado

O `getUsers()` passa a devolver *os usuários do banco* **mais** a conta de
emergência do `.env`. Com o Postgres fora, só ela entra.

Motivo: hoje o login depende só do processo Node estar de pé. Indo pro banco,
passa a depender do Postgres — e em **09/07/2026 o Postgres caiu em produção**
(P0-0, ainda aberto: a VM segue sem swap). Sem a conta reserva, um repeteco
tranca todo mundo para fora, inclusive de descobrir que o banco caiu.

**Qual conta é essa, concretamente:** não se cria variável nova. Depois da
migração (§8), o `AUTH_USERS` fica com **uma única entrada** — a de emergência.
A regra então é mecânica e sem nome mágico no código:

> **Todo username presente em `AUTH_USERS` é reservado**, e o banco recusa
> criar ou alterar usuário com esse nome.

E a precedência é explícita: **em caso de colisão, a entrada do `.env` vence.**
Sem essa regra, quem tem permissão de gestão criaria um homônimo, e qual das
duas contas responde viraria detalhe de implementação decidindo quem entra.

**A conta de emergência não é gerenciável pela tela**: não aparece na lista,
não pode ser desativada nem editada por ali. Ela vive no `.env` e só o José a
altera — que é exatamente o ponto de ser a chave reserva.

### 3.4 O token prova quem você é; o banco diz o que você pode

É o princípio que amarra o resto.

Hoje o JWT carrega `role` e `regionals`, e o painel confia neles pelas 8 horas
de sessão. Isso significa que **retirar acesso não derruba quem já está
logado**: desativar alguém às 9h, tendo a pessoa entrado às 8h59, a deixa
usando o painel até as 16h59.

O José decidiu que **desativar tem efeito imediato**. Então o `authMiddleware`
passa a conferir o usuário no banco, e o token vira só identidade.

Consequência boa, de graça: **mudança de permissão também passa a valer na
hora**. Trocar alguém de regional deixa de esperar o próximo login.

### 3.5 Com o banco fora: vale o cache, sem cache nega

O cache é um `Map` em memória por usuário, com TTL de **30 segundos** (§6.2) —
sem ele, cada requisição do painel vira uma consulta a mais, e o painel faz
muitas. Esse TTL é o teto de quanto tempo um acesso retirado pode sobreviver.

Se o banco estiver fora: **vale a última entrada conhecida do cache; sem
entrada, nega.** Quem estava ativo há instantes continua; quem o processo nunca
viu não entra; e a conta de emergência é o caminho de volta.

É o oposto de *fail-open* — que é literalmente o defeito que o **P1-32**
consertou no breaker de login.

### 3.6 Senha gerada, mostrada uma vez

Ao criar a conta, o painel gera uma senha forte e a exibe **uma única vez**,
com aviso explícito. Não fica guardada em lugar nenhum: esquecida, só gerando
outra.

Não há envio de e-mail no projeto — a entrega é na mão, pelo José.

## 4. Modelo de dados

### 4.1 `usuarios`

| coluna | tipo | nota |
|---|---|---|
| `username` | `text` PK | minúsculo, sem espaço |
| `senha_hash` | `text NOT NULL` | `scrypt$salt$hash` |
| `role` | `text NOT NULL` | `admin` ou `user` |
| `regionals` | `text NOT NULL` | `GUA\|CAC` — §3.2 |
| `ativo` | `boolean NOT NULL DEFAULT true` | desativar é soft, nunca DELETE |
| `pode_gerenciar` | `boolean NOT NULL DEFAULT false` | a permissão de conceder acesso |
| `criado_em` / `atualizado_em` | `timestamptz NOT NULL DEFAULT now()` | |
| `criado_por` | `text` | username de quem criou |

**Desativar é `ativo = false`, nunca `DELETE`.** O username aparece na trilha de
auditoria e em `criado_por` de outras contas; apagar a linha deixaria a
auditoria apontando para o nada.

### 4.2 `usuarios_log` — a trilha

| coluna | tipo |
|---|---|
| `id` | `bigserial` PK |
| `ts` | `timestamptz NOT NULL DEFAULT now()` |
| `ator` | `text NOT NULL` — quem fez |
| `acao` | `text NOT NULL` — `criar`, `desativar`, `reativar`, `alterar`, `resetar_senha` |
| `alvo` | `text NOT NULL` — em quem |
| `detalhe` | `jsonb` — o antes/depois dos campos que mudaram |

**Só escrita e leitura.** Não há rota de edição nem de exclusão. Acesso
concedido e retirado é o tipo de coisa que alguém pergunta seis meses depois, e
"acho que fui eu" não é resposta num contrato auditado.

`detalhe` **nunca** contém senha nem hash.

## 5. As travas

Cinco, cada uma contra um jeito específico de dar errado:

1. **Não pode desativar a si mesmo**, nem tirar a própria `pode_gerenciar`.
   Trava contra se trancar do lado de fora com um clique.
2. **Nunca pode sobrar zero gestores ativos.** A anterior não cobre dois
   gestores se removendo em ordem.
3. **`pode_gerenciar` é concedida por quem já a tem**, e toda concessão é
   registrada. É como o José adiciona a segunda pessoa quando for atacar o
   P0-1 — sem refazer nada.
4. **Um gestor só concede regionais que ele próprio tem.** Hoje não muda nada
   (o José tem todas); existe para o dia em que houver gestor de escopo menor,
   e é a diferença entre delegar e abrir mão.
5. **`senha_hash` nunca sai numa resposta de API.** Óbvio, e com teste próprio
   mesmo assim — este código já vazou stack trace (P1-10) e dado de outra
   regional (P1-38) por caminhos que também pareciam óbvios.

## 6. Arquitetura

### 6.1 `services/usuarios.js` — novo

Leitura, escrita e o cache. A parte **pura** (validação de payload, checagem
das travas contra um estado dado) fica em funções sem I/O, testáveis sem banco:

```
validarNovoUsuario(payload, ator)      → string[] de erros
podeDesativar(alvo, ator, todos)       → { ok, motivo }
podeAlterar(payload, alvo, ator, todos)→ { ok, motivo }
gerarSenha()                            → string forte
```

As travas da §5 vivem aqui, não espalhadas pelas rotas.

### 6.2 `middleware/auth.js` — modificado

- `getUsers()` passa a ser **assíncrono** e a unir banco + conta de emergência.
- `login()` vira assíncrono por consequência.
- `authMiddleware` passa a consultar o usuário (via cache) e a **sobrescrever
  `role` e `regionals` com o que está no banco**, ignorando o que o token diz.
  **Exceção:** a conta de emergência não tem linha no banco — para ela valem os
  valores do `.env`, e ela nunca é "desativada" por ausência de registro. Sem
  essa exceção, a chave reserva seria negada justamente quando é necessária.

**O cache:** `Map` em memória, chaveado por username, **TTL de 30 segundos**.
O número não é arbitrário — é o teto de quanto tempo um acesso retirado pode
sobreviver. Meio minuto é curto o bastante para "na hora" ser verdade, e longo
o bastante para o painel não consultar o banco a cada clique.

**Consequência a declarar:** `login()` síncrono → assíncrono obriga o handler da
rota `/auth/login` (`routes/index.js:125`, chamada em `:148`) a virar `async`.
É contido — uma função e uma rota — mas passa exatamente pelo trecho do rate
limit do P1-42, então entra na lista do que precisa de teste HTTP.

### 6.3 Rotas — sob `/admin`, e com guarda própria

Não basta `requireAdmin`: as rotas de usuário exigem `pode_gerenciar`.

```
GET    /api/admin/usuarios           lista (sem senha_hash)
POST   /api/admin/usuarios           cria; devolve a senha gerada UMA vez
PUT    /api/admin/usuarios/:username altera role, regionals, pode_gerenciar
POST   /api/admin/usuarios/:username/desativar
POST   /api/admin/usuarios/:username/reativar
POST   /api/admin/usuarios/:username/senha   gera nova; devolve UMA vez
GET    /api/admin/usuarios/log       a trilha, só leitura
```

### 6.4 `scripts/migrar-usuarios.js` — novo

Lê o `AUTH_USERS` do ambiente e insere na tabela, copiando os hashes.
**Idempotente**: rodar duas vezes não duplica nem sobrescreve senha. Tem
`--dry-run` que imprime o que faria sem gravar — que é como se confere antes de
mexer em quem entra no painel.

**Exige `--gestor=<username>`, e recusa rodar sem.** Alguém precisa sair da
migração com `pode_gerenciar`, senão a tela nasce inútil: ninguém pode criar
ninguém, e o único caminho de volta é editar o banco à mão — que é o problema
que este spec existe para acabar. O script valida que o username passado está
de fato entre os migrados, e que ele é `admin`.

### 6.5 Tela

No Admin, ao lado de Equipes Oficiais: lista com situação e permissões, botão de
criar, e por linha as ações de desativar e editar. A senha gerada aparece uma
vez, num aviso que diz que não será mostrada de novo.

## 7. Testes

O peso vai nos testes **HTTP**, porque o risco é de controle de acesso.

**Puros** (`test/usuarios.test.js`), sobre `services/usuarios.js`:
- `validarNovoUsuario`: username inválido, role inválida, regional inválida,
  regional fora do escopo do ator, nome reservado da conta de emergência
- `podeDesativar`: o próprio ator → recusa; último gestor ativo → recusa;
  outro usuário qualquer → aceita
- `podeAlterar`: tirar a própria `pode_gerenciar` → recusa; conceder regional
  que o ator não tem → recusa
- `gerarSenha`: comprimento, alfabeto, e duas chamadas não colidem

**HTTP** (`test/usuariosHttp.test.js`), com o app real:
- sem token → 401 em todas as sete rotas
- admin **sem** `pode_gerenciar` → 403 em todas as sete
- `pode_gerenciar` → 200
- **`senha_hash` não aparece em nenhuma resposta** — varre o JSON inteiro
- criar devolve a senha **uma vez**; buscar o usuário depois não a traz
- desativar a si mesmo → 400 com motivo legível
- payload malformado → 400, nunca 500

**Auth** (`test/authBanco.test.js`):
- `getUsers()` une banco + conta de emergência
- o nome reservado no banco é ignorado em favor da conta do `.env`
- banco fora, com cache quente → o usuário passa
- banco fora, sem cache → **nega** (não é fail-open)
- **banco fora, conta de emergência → passa** (a exceção da §6.2; sem este
  teste, a chave reserva pode ser negada justamente quando é necessária)
- usuário desativado no banco → a requisição seguinte cai, mesmo com token válido
- `regionals` alterado no banco vence o que está no token
- passados os 30s de TTL, a alteração aparece; antes disso, o cache responde

**Migração** (`test/migrarUsuarios.test.js`), sobre a parte pura do script:
- sem `--gestor` → recusa, com mensagem dizendo por quê
- `--gestor` apontando para username que não está no `AUTH_USERS` → recusa
- rodar duas vezes não duplica nem sobrescreve `senha_hash`
- os hashes chegam à tabela **idênticos** aos do `.env` — é o que garante que
  ninguém perde acesso

## 8. Ordem de implantação

A migração é a única parte com ordem obrigatória, porque mexe em quem entra:

1. Sobe o código com a tabela criada e **vazia**. O `getUsers()` une banco +
   `.env`; com a tabela vazia, o comportamento é idêntico ao de hoje.
2. Roda `scripts/migrar-usuarios.js --dry-run` e confere a saída.
3. Roda sem `--dry-run`. Agora as contas existem nos dois lugares — e, como os
   hashes são os mesmos, tanto faz qual responde.
4. Confere login de cada conta.
5. Só então remove do `.env` as contas migradas, **mantendo a de emergência**,
   e reinicia.

Cada passo é reversível sozinho, e em nenhum momento existe uma janela em que
alguém legítimo fica sem entrar.

## 9. Rollback

`git revert` + restaurar o `AUTH_USERS` completo no `.env`. A tabela pode ficar:
sem o código novo, ninguém a lê.

O que **não** é reversível por `git` é a senha de quem for criado depois da
migração — essas contas só existem no banco. Antes de reverter, ou se
recria no `.env`, ou se aceita que elas param de entrar.

## 10. O que NÃO muda

- **O JWT continua o mesmo formato** (`v: 2`). Sessão aberta não cai por causa
  do deploy — cai só se o usuário for desativado.
- **Nenhum dado de produção é tocado.** Isto é autenticação; não encosta em
  nota, equipe, snapshot ou número reportado à EDP.
- **`equipes_oficiais` não tem relação com isto.** Equipe é a turma de campo;
  usuário é quem abre o painel.

## 11. Fora de escopo

- **Troca obrigatória de senha no 1º login** — incremento 2, decidido junto com
  o José. Tem tela e estado próprios (senha provisória). Até ele chegar, a
  senha gerada funciona até a pessoa trocar por conta própria.
- **Autoatendimento de senha** (a própria pessoa trocar a sua). Vem junto com o
  incremento 2, que já cria a tela.
- **Recuperação por e-mail.** Não há envio de e-mail no projeto.
- **Perfis/grupos de permissão.** Com 5 contas, `role` + `regionals` +
  `pode_gerenciar` bastam. Grupos resolvem um problema de escala que não existe.
- **Trocar `role` por permissões finas por aba.** Não pedido, e multiplicaria a
  superfície de teste de um caminho que é de segurança.
