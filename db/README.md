# `db/` — schema real e política de schema

## `schema-atual.sql` — fonte de verdade do schema em produção

Snapshot **fiel** do schema do Postgres da VM, gerado por `pg_dump --schema-only`
(sem dados, sem owners/ACL). É **referência**, não roda direto (`public.` prefix,
sem `IF NOT EXISTS`). Serve pra: DR / ambiente novo, revisão de PRs que mexem em
schema, e auditoria (as PKs conferidas no P2-5/P2-7 saíram daqui).

### Regenerar (na VM, após qualquer migração)
```bash
cd ~/prod-stc && DBURL="$(node -e "require('dotenv').config();process.stdout.write(process.env.DATABASE_URL||'')")" \
  && pg_dump "$DBURL" --schema-only --no-owner --no-privileges > db/schema-atual.sql \
  && git add db/schema-atual.sql && git commit -m "chore(db): atualiza schema-atual.sql" && git push
```

## Onde cada tabela é criada (mapa migração → tabela)

O schema NÃO nasce de um arquivo só. `supabase/schema.sql` é a **base**; o resto
vem de migrações incrementais. Ordem de aplicação num ambiente novo:
`supabase/schema.sql` → `supabase/migrations/*` (numeradas, em ordem) →
`migrations/*` (ad-hoc, legado).

| Tabela | Criada em |
|---|---|
| app_settings, daily_totals, daily_subcat_totals, metas, note_details, note_subcategorias, snapshots, team_daily_totals, team_daily_subcat_totals, teams_current, wpa_token | `supabase/schema.sql` (base) |
| note_subcategorias (ajustes) | `supabase/migrations/002` |
| wpa_token | `supabase/migrations/003` |
| daily_subcat_totals / team_daily_subcat_totals | `supabase/migrations/004` |
| equipes_oficiais | `supabase/migrations/006`, `007`, `010` |
| note_rejections | `supabase/migrations/008` |
| osrm_cache | `supabase/migrations/009` |
| **team_daily_carteira** | **`supabase/migrations/011`** (versionada no P2-7 — era órfã) |
| notas_snapshots, notas_daily_agg | `migrations/add_notas_monitor.sql` (+ `add_notas_regional`, `add_notas_equipe_oficial`) |
| equipes_oficiais (escala) | `migrations/add_escala_equipes.sql` |

## Drift conhecido (auditado em 22/07/2026 — P2-7)

Comparação `db/schema-atual.sql` × `supabase/schema.sql` (base):

- **Colunas:** ZERO drift nas 11 tabelas compartilhadas — a base bate 1:1 com o
  banco vivo (inclui as críticas `snapshots`, `team_daily_totals`).
- **Tabelas só no banco (fora da base):** `equipes_oficiais`, `notas_daily_agg`,
  `notas_snapshots`, `note_rejections`, `osrm_cache`, `team_daily_carteira`.
  Todas têm migração de origem (ver tabela acima) — a última (`team_daily_carteira`)
  foi versionada no P2-7.
- **Tabelas só no design (faltando no banco):** nenhuma.
- **Removido no P2-7:** `migrations/add_note_rejections.sql` (obsoleto — definia
  `reason_codes/reason_labels/rejected_at`; o banco real e o código usam
  `motivo_codes/motivo_textos/rejection_date`, de `supabase/migrations/008`).
