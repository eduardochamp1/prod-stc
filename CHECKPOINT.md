# CHECKPOINT — Migração Supabase → Postgres self-hosted

> Última atualização: 25/05/2026
> Próxima sessão: começa lendo este arquivo + `POSTGRES-MIGRATION.md`

---

## Onde paramos

Estamos no meio da **Fase 1** (setup Postgres no servidor novo). Resumo do
estado das 4 fases:

| Fase | Descrição                                       | Status                |
|-----:|--------------------------------------------------|-----------------------|
|   1  | Setup Postgres no servidor (`app-jose-zouain`)   | 🟡 quase concluída    |
|   2  | Migrar dados do Supabase pro PG local            | ⚪ aguarda Fase 1     |
|   3  | Shim `pg` (substituir @supabase/supabase-js)     | ✅ entregue + testado |
|   4  | Cutover + aposentadoria do Vercel                | ⚪ pendente           |

---

## Estado do servidor (validado, podem ser retomados)

- **Host:** `app-jose-zouain` (172.25.3.154) — Ubuntu 24.04.4 LTS
- **RAM:** 3.8 GiB (efetivos ~2.4 GiB livres pra app+PG)
- **Node:** v24.14.1, npm 11.11
- **Repo:** clonado em `~/prod-stc`, `npm install` feito
- **Testes:** `npm test` → **89/89 pass** (20 do shim + 69 dos existentes)
- **Postgres:** 16.14 já instalado, cluster `postgresql@16-main` na porta 5432
- **Usuário do SO `usr_jose`:** SUPERUSER no Postgres, autenticação por senha via TCP localhost
- **Sudo:** RESTRITO — não usa sudo pra setup do PG (tudo via SQL)

## Database & role já criados

```
DATABASE: wpa_monitor   (owner = wpa_app, timezone = America/Sao_Paulo)
ROLE    : wpa_app       (senha definida, conhecida só pelo usr_jose)
```

Comando de validação:

```bash
psql -h localhost -U wpa_app -d wpa_monitor -c "SELECT current_user, current_database();"
# Esperado: wpa_app | wpa_monitor
```

## Tuning aplicado (sem restart necessário)

23 parâmetros `ALTER SYSTEM` rodados como `usr_jose`. `pg_reload_conf()` →
`t`. `pg_settings.pending_restart` → 0 rows. **Tudo em vigor.**

Principais valores (ver POSTGRES-MIGRATION.md Fase 1.2 pra lista completa):

```
shared_buffers          = 768MB
effective_cache_size    = 2GB
work_mem                = 16MB
maintenance_work_mem    = 192MB
max_connections         = 30
max_worker_processes    = 4
log_min_duration_statement = 500ms
```

---

## ⏭️ Próximo comando (retomar daqui)

**Aplicar os schemas no `wpa_monitor`.** Antes preciso mapear todos os
`.sql` do repo pra montar a ordem certa de aplicação. Rode:

```bash
find ~/prod-stc -name "*.sql" -type f 2>/dev/null | grep -v node_modules | sort
```

Cole o output e eu monto o loop de aplicação dos schemas + migrations
(provavelmente: `supabase/schema.sql` → `supabase/migrations/001-007` →
`migrations/add_*` se existirem).

Após aplicar tudo, validar com:

```bash
psql -h localhost -U wpa_app -d wpa_monitor -c "\dt"
# Esperado: ~13-14 tabelas (snapshots, teams_current, equipes_oficiais,
#           team_daily_totals, team_daily_subcat_totals, daily_totals,
#           daily_subcat_totals, note_subcategorias, note_details,
#           note_rejections, metas, wpa_token, app_settings)
```

---

## Depois da Fase 1, sequência:

### Fase 2 (migrar dados — script pronto)

```bash
cd ~/prod-stc
cp scripts/.env.migration.example scripts/.env.migration
chmod 600 scripts/.env.migration
nano scripts/.env.migration   # preenche SUPABASE_PASSWORD e LOCAL_PASSWORD

# PARA O PM2 DO SERVIDOR ANTIGO antes de rodar este script
# (pra não rodar 2 crons em paralelo durante o dump)

source scripts/.env.migration
./scripts/migrate-from-supabase.sh
```

Detalhes: `POSTGRES-MIGRATION.md` seção Fase 2 (com troubleshoot completo).

### Fase 3 (já entregue — só configurar)

```bash
# Adiciona ao .env do app:
DATABASE_URL=postgresql://wpa_app:SENHA@localhost:5432/wpa_monitor
```

E `pm2 restart`. Boot vai mostrar `[supabaseClient] modo=pg`.

### Fase 4 (cutover)

A documentar quando chegar a hora. Inclui:
- Reativar PM2 no servidor novo apontando pro PG local
- Reconfigurar webhook GitHub pro IP do servidor novo
- Smoke test funcional (Monitor, Rejeições, Gráficos, Mapa, Histórico)
- Após 1 semana estável, desativar projeto Supabase

---

## ⚠️ Notas de segurança importantes

1. **Senha `usr_jose` vazou em chat antes** — usuário trocou. Nunca colar
   senhas em texto plano em screenshots/transcript. Use `*****` ou `<senha>`.
2. **Senha `wpa_app`** está real e segura — definida diretamente no
   `psql \password` (não vazou em chat).
3. `gseq` é um database de teste do `usr_jose`, deixar como está — não
   conflita com `wpa_monitor`.

---

## Arquivos relevantes no repo

| Arquivo                                      | Função                                       |
|----------------------------------------------|----------------------------------------------|
| `POSTGRES-MIGRATION.md`                      | Guia completo das 4 fases                    |
| `DEPLOY.md`                                  | Guia de deploy do servidor (PM2, .env, etc.) |
| `scripts/migrate-from-supabase.sh`           | Script automatizado da Fase 2                |
| `scripts/.env.migration.example`             | Template das credenciais de migração         |
| `services/pgShim.js`                         | Query builder compatível supabase-js → pg    |
| `services/supabaseClient.js`                 | Dual-mode (DATABASE_URL → shim, senão Supabase)|
| `test/pgShim.test.js`                        | 20 testes unitários do shim                  |
| `supabase/schema.sql`                        | Schema inicial consolidado                   |
| `supabase/migrations/001-007*.sql`           | Migrations incrementais                      |
