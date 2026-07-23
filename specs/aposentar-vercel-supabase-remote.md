# Spec — Aposentar o Vercel + remover Supabase-remote (Fase 4 + P3-8)

- **Autor:** José Zouain × Claude (via /spec)
- **Data:** 2026-07-22
- **Status:** CONSTRUÍDO (22/07/2026). Ver "Notas de construção" no fim — houve
  1 correção ao spec durante o build.
- **Escopo do backlog:** Fase 4 (cutover/aposentadoria do Vercel) **+** P3-8
  (remover código morto Vercel/Supabase-remote), fundidos.

---

## 1. Objetivo

Consolidar o WPA Monitor num **único caminho de dados**: Postgres self-hosted
(via `pgShim`, modo `wpa` em produção) + `mock` (para testes/dev). Remover TODO
o código, config e dependência ligados ao deploy antigo no **Vercel** e ao
acesso **remoto ao Supabase** — que já são código morto: a migração para
Postgres foi concluída (Fases 1–3) e o deployment do Vercel **já está morto**
(confirmado por José em 22/07 — sem URL pública servindo dado congelado).

Resultado: menos superfície, menos dependências, e impossível o app cair
silenciosamente num backend legado.

---

## 2. Contexto (por quê)

- Produção roda na VM Ubuntu com PM2, `DATA_MODE=wpa`, `DATABASE_URL` apontando
  pro Postgres local. O `pgShim` reimplementa a API do supabase-js sobre `pg`,
  então os ~105 call sites não mudam.
- O `@supabase/supabase-js` real só é usado no **branch legado** do `dbClient`
  (quando NÃO há `DATABASE_URL`) e em 2 scripts one-shot. Nada disso roda em prod.
- O Vercel usava `DATA_MODE=supabase` (lia snapshots do Supabase remoto). Morto.
- **`npm` funciona na VM** (registry acessível apesar do Fortinet) → dá pra
  podar a dependência de verdade do `node_modules`.

---

## 3. Escopo

### DENTRO (o que este spec cobre)
1. Deletar config e branches do **Vercel**.
2. Remover o **branch Supabase-remoto** do `dbClient` + a dependência
   `@supabase/supabase-js` (package.json + lock + node_modules).
3. Remover o modo `DATA_MODE=supabase` e o código morto associado.
4. Deletar os 2 scripts que dependem do Supabase remoto.
5. Atualizar docs (CLAUDE.md/RUNBOOK/ARCHITECTURE) e comentários que descrevem
   Vercel/Supabase como caminho **vivo**.

### FORA (explicitamente não fazer agora)
- **Limpar o `.env` da VM** (`SUPABASE_SERVICE_KEY`, `SUPABASE_URL`). José faz
  depois, manualmente. Após esta mudança essas vars ficam **inertes** (o
  `dbClient` passa a exigir `DATABASE_URL` e ignora as de Supabase).
- Derrubar projeto/deployment no painel do Vercel — **já está morto**.
- Split do JS do `index.html` (P3-2) e demais itens P3.

---

## 4. Requisitos exatos (arquivo por arquivo)

> Validado por grep em 22/07/2026. Reverificar file:line antes de editar (podem
> ter driftado). Comentários **datados** de incidentes são preservados (regra 3
> do CLAUDE.md); só sai código vivo e ponteiro estale de "como funciona hoje".

### 4.1 `vercel.json` (raiz)
- **Deletar o arquivo.** (Buildava `logo.png` + `server.js`, roteava tudo pro
  `server.js` no Vercel.)

### 4.2 `server.js`
- Guard de boot (hoje `if (require.main === module && !process.env.VERCEL)`) →
  simplificar para `if (require.main === module)`. O `!process.env.VERCEL` era
  pra não subir servidor no Vercel serverless; irrelevante agora.

### 4.3 `services/logger.js`
- `IS_PROD` (hoje `NODE_ENV === 'production' || !!process.env.VERCEL`) →
  `NODE_ENV === 'production'` apenas.
- Atualizar o comentário do topo (cita `process.env.VERCEL → JSON`).

### 4.4 `test/logger.test.js`
- Remover/ajustar os testes que exercitam `VERCEL=1 → IS_PROD` (linhas ~99–118).
  Substituir por cobertura equivalente via `NODE_ENV=production` (garantir que
  o modo JSON de log ainda é testado). **A suíte tem que continuar verde.**

### 4.5 `services/dbClient.js`
- Remover o branch `hasSupabase` inteiro: o `require('@supabase/supabase-js')`,
  o `createClient(...)`, a **URL hardcoded** do projeto
  (`iyadtjzehhebwojreudz.supabase.co`) e o modo `'supabase'`.
- `_init()` passa a: se `DATABASE_URL` → pg shim; senão → **lançar erro claro**
  SEM menção a Supabase (ex.: "DATABASE_URL não configurada — defina no .env
  (postgresql://…)").
- `getMode()` só retorna `'pg'` (ou lança). Atualizar o jsdoc do topo (hoje diz
  "Dual-mode … @supabase/supabase-js (modo legado/transição)").

### 4.6 `routes/index.js`
- **Linha ~141:** remover o branch `if (MODE === 'supabase') { teams = await
  sbq().getTeamsFromSupabase(...) } else { … }` — deixar só o caminho
  `getTeams({...})` (wpa/mock).
- **Endpoint de diagnóstico (~2246–2248):** remover os campos `VERCEL` e
  `VERCEL_REGION`. Manter `DATA_MODE`.
- **Comentários legados:** `sbq()` (~100) e `cron()` (~126) têm comentários que
  citam "modo supabase (Vercel)". Atualizar o texto — mas **manter** as funções:
  `sbq()` carrega `db/queries` (usado por wpa nos endpoints de histórico) e o
  `cron()` lazy fica.
- **NÃO tocar** nos branches `MODE === 'mock'` (104, 957) — são de teste/dev.

### 4.7 `db/queries.js`
- Remover `getTeamsFromSupabase` (fica órfão após 4.6) do módulo e do
  `module.exports`.
- Atualizar o comentário do topo (linha ~3: "usadas pelo Vercel
  (DATA_MODE=supabase)") pra refletir só `wpa`/histórico.

### 4.8 `package.json` + `package-lock.json`
- Remover `"@supabase/supabase-js"` das `dependencies`.
- Regenerar/limpar o `package-lock.json` (via `npm install` ou edição).

### 4.9 Scripts mortos (deletar)
- `scripts/migrate-supabase-to-local.js` (Fase 2, migração já concluída).
- `scripts/diag-rejection-endpoints.js` (diagnóstico contra Supabase remoto).
- (Ambos importam `@supabase/supabase-js`; git preserva o histórico.)

### 4.10 Docs
- `CLAUDE.md`, `docs/handoff/RUNBOOK.md`, `docs/handoff/ARCHITECTURE.md`:
  remover Vercel/Supabase-remoto como caminho **vivo**; menções **históricas**
  (ex.: "migramos do Supabase") ficam como registro.
- `docs/handoff/BACKLOG.md`: marcar Fase 4 e P3-8 como `done` com data/commit.

---

## 5. Casos extremos a tratar

1. **Mock sem banco (invariante):** `test/routes.test.js` roda com
   `DATA_MODE=mock` e **sem `DATABASE_URL`**. Após o `dbClient` passar a exigir
   `DATABASE_URL`, o modo mock NÃO pode quebrar — as rotas cobertas em mock não
   podem chamar `getClient()`. Rodar a suíte é o guard; tem que ficar verde.
2. **Erro quando falta `DATABASE_URL` em modo real:** em `wpa` sem
   `DATABASE_URL`, o app deve falhar com erro claro no boot/1ª query (não cair
   num fallback silencioso — o fallback some).
3. **Dependência 100% órfã antes de dropar:** antes de remover do package.json,
   `grep -rn "@supabase/supabase-js" --include=*.js` (fora `node_modules`) tem
   que dar **zero** (após 4.5 + 4.9). Se sobrar 1, o build falha ao rodar.
4. **`.env` com vars de Supabase (inertes):** com `DATABASE_URL` presente, o
   `dbClient` usa pg e ignora `SUPABASE_*`. Confirmar que a presença dessas
   vars não muda nada (não há mais leitura delas no código).
5. **Comentários datados:** preservar qualquer comentário com data que registre
   a migração/incidentes (arqueologia). Só remover código vivo e ponteiros de
   "comportamento atual" que fiquem falsos.
6. **Hook de pre-push:** roda `node --test`; a suíte precisa passar (inclui o
   `logger.test.js` ajustado).

---

## 6. Definição de "concluído" (verificável)

Cada item deve poder ser conferido por comando/observação:

- [ ] `test ! -f vercel.json` (arquivo ausente).
- [ ] `grep -rn "process.env.VERCEL" --include=*.js .` (fora node_modules) →
      **zero branches vivos** (só comentários datados, se houver).
- [ ] `grep -rn "@supabase/supabase-js" package.json` → nada; **`npm ls
      @supabase/supabase-js`** → "not found" (podado do node_modules na VM).
- [ ] `grep -rnE "createClient|@supabase/supabase-js" --include=*.js .` (fora
      node_modules) → **zero**.
- [ ] `grep -rnE "MODE === 'supabase'|DATA_MODE=supabase|getTeamsFromSupabase"`
      → **zero** (paths e função órfã removidos).
- [ ] `dbClient.getMode()` só retorna `'pg'`; mensagem de erro sem "Supabase".
- [ ] `scripts/migrate-supabase-to-local.js` e `scripts/diag-rejection-endpoints.js`
      **deletados**.
- [ ] `node --test` → **tudo verde** (com `logger.test.js` atualizado).
- [ ] **Mock:** a suíte roda sem `DATABASE_URL` (mock intacto).
- [ ] **VM (wpa):** após `git pull` + `npm prune` + restart PM2, o app sobe,
      `curl /health` → `200` com `db:ok`, e o painel + KPIs renderizam normais.
- [ ] Docs sem Vercel/Supabase-remoto como caminho vivo; Fase 4 e P3-8 marcados
      `done` no BACKLOG.

---

## 7. Deploy (VM)

```bash
cd ~/prod-stc && git pull
npm prune                     # remove @supabase/* do node_modules (npm funciona na VM)
pm2 delete wpa-monitor && pm2 start ecosystem.config.js && pm2 save
# valida:
curl -sI http://172.25.3.154:3002/ | head -1        # 200
node -e "require('dotenv').config(); const {getMode}=require('./services/dbClient'); console.log('modo =', getMode())"   # pg
```

---

## 8. Riscos e rollback

- **Risco:** algum caminho de prod dependia do fallback Supabase. **Mitigação:**
  prod é `DATA_MODE=wpa` + `DATABASE_URL` setado — o branch Supabase só disparava
  SEM `DATABASE_URL`, o que não ocorre em prod. Confirmar no boot (`getMode()==='pg'`).
- **Risco:** teste em mock chama `getClient()` e quebra com o novo erro.
  **Mitigação:** rodar a suíte (falha aqui = pegar antes do deploy).
- **Rollback:** reverter o commit; `npm install` restaura a dependência se
  necessário. Sem migração de dados envolvida.

---

## 9. Próximo passo

Construir seguindo os requisitos da seção 4, um commit coeso (ou 2: código +
docs), validando a seção 6 antes do push. Depois deste, a Fase 4 e o P3-8 saem
do backlog.

---

## 10. Notas de construção (22/07/2026)

- **Correção ao spec (4.7 estava errado):** o spec dizia pra DELETAR
  `getTeamsFromSupabase` como órfã. O grep de "concluído" (seção 6) pegou que
  ela NÃO era órfã — além do branch `MODE==='supabase'` (esse sim removido),
  ela é chamada em 2 rotas VIVAS (`routes/index.js` ~831 e ~1365: resolver
  código→UUID e listar quem está logado), e lê a tabela `teams_current` via
  **pgShim** (nada de Supabase remoto). Deletá-la quebraria essas rotas.
  **Resolução:** em vez de deletar, foi **renomeada** para `getTeamsCurrent`
  (nome honesto — sem "Supabase") e os 2 call-sites atualizados. Fecha o
  objetivo (zero referência a Supabase em código vivo) sem quebrar nada.
- Também removidas 2 linhas vestigiais `delete process.env.VERCEL;` em
  `test/logger.test.js` (não referenciavam código vivo; grep de VERCEL agora
  dá zero no repo inteiro).
- Tudo o mais saiu conforme a seção 4. Suíte: 266/266 (removido 1 teste
  `IS_PROD com VERCEL=1`, que testava comportamento aposentado).
