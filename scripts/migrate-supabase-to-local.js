#!/usr/bin/env node
/**
 * scripts/migrate-supabase-to-local.js
 *
 * Migra dados do Supabase Cloud (IPv6-only) → Postgres local.
 *
 * Estratégia:
 *   - Lê via @supabase/supabase-js (HTTP, funciona em IPv4)
 *   - Pagina em chunks de 1000 linhas usando `.range(from, to)`
 *   - Insere em lote no Postgres local via `pg` (Pool)
 *   - Por tabela, faz TRUNCATE antes (modo clean) ou ON CONFLICT DO NOTHING (modo merge)
 *
 * Tabelas migradas (ordem de prioridade):
 *   1. snapshots (a maior — ~21k+)
 *   2. daily_totals
 *   3. team_daily_totals
 *   4. daily_subcat_totals
 *   5. team_daily_subcat_totals
 *   6. note_subcategorias
 *   7. note_details
 *   8. app_settings
 *   9. metas
 *   10. teams_current
 *   11. equipes_oficiais (merge — local já tem seed)
 *
 * Pulados:
 *   - wpa_token (regenera sozinho)
 *   - note_rejections (ainda vazia, recém-criada)
 *
 * Uso:
 *   cd ~/prod-stc
 *   source ~/.wpa_app_pass     # exporta APP_PASS
 *   export SUPABASE_URL=... SUPABASE_SERVICE_KEY=...  # do .env atual
 *   export LOCAL_DB_URL="postgresql://wpa_app:$APP_PASS@127.0.0.1:5432/wpa_monitor"
 *   node scripts/migrate-supabase-to-local.js [--dry-run] [--only=snapshots,daily_totals]
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');

// ── Config ────────────────────────────────────────────────────────────────────
const PAGE_SIZE          = 1000;       // linhas por página de SELECT
const INSERT_BATCH       = 500;        // linhas por INSERT (param limit do pg)
const TABLES = [
  // [tabela, modo, ordem_natural]
  { name: 'snapshots',                mode: 'truncate', order: 'captured_at' },
  { name: 'daily_totals',             mode: 'truncate', order: 'date' },
  { name: 'team_daily_totals',        mode: 'truncate', order: 'date' },
  { name: 'daily_subcat_totals',      mode: 'truncate', order: 'date' },
  { name: 'team_daily_subcat_totals', mode: 'truncate', order: 'date' },
  { name: 'note_subcategorias',       mode: 'truncate', order: 'note_id' },
  { name: 'note_details',             mode: 'truncate', order: 'fetched_at' },
  { name: 'app_settings',             mode: 'truncate', order: 'key' },
  { name: 'metas',                    mode: 'truncate', order: null },
  { name: 'teams_current',            mode: 'truncate', order: null },
  { name: 'equipes_oficiais',         mode: 'merge',    order: 'sigla' },
];

// ── CLI ───────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ONLY = (args.find(a => a.startsWith('--only=')) || '').slice('--only='.length)
  .split(',').filter(Boolean);

// ── Clients ───────────────────────────────────────────────────────────────────
const cloud = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const local = new Pool({
  connectionString: process.env.LOCAL_DB_URL,
  max: 4,
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function quoteId(name) { return `"${name.replace(/"/g, '""')}"`; }

async function getCloudCount(table) {
  const { count, error } = await cloud
    .from(table)
    .select('*', { count: 'exact', head: true });
  if (error) throw new Error(`cloud count ${table}: ${error.message}`);
  return count || 0;
}

async function getLocalCount(table) {
  const { rows } = await local.query(`SELECT COUNT(*)::int AS c FROM ${quoteId(table)}`);
  return rows[0].c;
}

async function* fetchCloudPages(table, orderCol) {
  let from = 0;
  while (true) {
    let q = cloud.from(table).select('*').range(from, from + PAGE_SIZE - 1);
    if (orderCol) q = q.order(orderCol, { ascending: true });
    const { data, error } = await q;
    if (error) throw new Error(`fetch ${table} page ${from}: ${error.message}`);
    if (!data || data.length === 0) return;
    yield data;
    if (data.length < PAGE_SIZE) return;
    from += PAGE_SIZE;
  }
}

async function insertBatch(table, rows, mode) {
  if (rows.length === 0) return 0;
  const cols = Object.keys(rows[0]);
  const colList = cols.map(quoteId).join(', ');

  // Constroi VALUES paramêtrizado: ($1,$2,...), ($n+1,$n+2,...)
  const params = [];
  const placeholders = rows.map((row, ri) => {
    const ph = cols.map((c, ci) => {
      const val = row[c];
      params.push(val === undefined ? null : val);
      return `$${params.length}`;
    });
    return `(${ph.join(', ')})`;
  });

  let sql = `INSERT INTO ${quoteId(table)} (${colList}) VALUES ${placeholders.join(', ')}`;
  if (mode === 'merge') sql += ' ON CONFLICT DO NOTHING';

  const { rowCount } = await local.query(sql, params);
  return rowCount;
}

async function migrateTable(t) {
  const { name, mode, order } = t;
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📦 ${name} (mode=${mode})`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  let cloudCount = 0;
  try { cloudCount = await getCloudCount(name); }
  catch (e) { console.log(`   ⚠️  count falhou: ${e.message}`); }
  const localBefore = await getLocalCount(name);
  console.log(`   cloud: ${cloudCount}  |  local antes: ${localBefore}`);

  if (cloudCount === 0) {
    console.log(`   ⏭  nada a migrar`);
    return { name, copied: 0, cloudCount, localAfter: localBefore };
  }
  if (DRY_RUN) {
    console.log(`   [dry-run] copiaria ${cloudCount} linhas`);
    return { name, copied: 0, cloudCount, localAfter: localBefore, dryRun: true };
  }

  if (mode === 'truncate') {
    await local.query(`TRUNCATE TABLE ${quoteId(name)} RESTART IDENTITY CASCADE`);
    console.log(`   ✂️  TRUNCATE feito`);
  }

  let totalCopied = 0;
  let totalRead   = 0;
  const t0 = Date.now();

  for await (const page of fetchCloudPages(name, order)) {
    totalRead += page.length;
    // Quebra a página em batches menores pra não estourar param limit (65k do pg)
    for (let i = 0; i < page.length; i += INSERT_BATCH) {
      const chunk = page.slice(i, i + INSERT_BATCH);
      const inserted = await insertBatch(name, chunk, mode);
      totalCopied += inserted;
    }
    const pct = cloudCount ? Math.round((totalRead / cloudCount) * 100) : 100;
    const rate = (totalCopied / Math.max(1, (Date.now() - t0) / 1000)).toFixed(0);
    process.stdout.write(`\r   📥 ${totalRead}/${cloudCount} (${pct}%)  |  inseridas ${totalCopied}  |  ${rate}/s     `);
  }
  console.log('');

  const localAfter = await getLocalCount(name);
  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`   ✅ concluído em ${dur}s  |  local agora: ${localAfter}`);
  if (mode === 'truncate' && localAfter !== cloudCount) {
    console.log(`   ⚠️  divergência: cloud=${cloudCount} local=${localAfter}`);
  }
  return { name, copied: totalCopied, cloudCount, localAfter };
}

(async () => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    throw new Error('SUPABASE_URL e SUPABASE_SERVICE_KEY são obrigatórios no .env');
  }
  if (!process.env.LOCAL_DB_URL) {
    throw new Error('LOCAL_DB_URL é obrigatório (export antes de rodar)');
  }

  console.log(`🚀 Migração Supabase Cloud → Postgres local`);
  console.log(`   cloud: ${process.env.SUPABASE_URL}`);
  console.log(`   local: ${process.env.LOCAL_DB_URL.replace(/\/\/[^@]+@/, '//***:***@')}`);
  console.log(`   dry-run: ${DRY_RUN}`);
  if (ONLY.length) console.log(`   only: ${ONLY.join(', ')}`);

  // Smoke test
  const { rows } = await local.query('SELECT current_user, current_database()');
  console.log(`   ✅ local conectado: ${rows[0].current_user}@${rows[0].current_database}`);

  const tablesToRun = ONLY.length
    ? TABLES.filter(t => ONLY.includes(t.name))
    : TABLES;

  if (tablesToRun.length === 0) {
    console.log(`\n⚠️  Nenhuma tabela selecionada via --only. Tabelas válidas: ${TABLES.map(t => t.name).join(', ')}`);
    process.exit(1);
  }

  const summary = [];
  for (const t of tablesToRun) {
    try {
      summary.push(await migrateTable(t));
    } catch (e) {
      console.error(`\n❌ ${t.name}: ${e.message}`);
      summary.push({ name: t.name, error: e.message });
    }
  }

  console.log(`\n╔════════════════════════════════════════════════════╗`);
  console.log(`║  RESUMO                                            ║`);
  console.log(`╚════════════════════════════════════════════════════╝`);
  for (const s of summary) {
    if (s.error) console.log(`  ❌ ${s.name.padEnd(28)} ERRO: ${s.error}`);
    else if (s.dryRun) console.log(`  🟡 ${s.name.padEnd(28)} [dry-run] cloud=${s.cloudCount}`);
    else {
      const match = s.localAfter === s.cloudCount ? '✅' : '⚠️ ';
      console.log(`  ${match} ${s.name.padEnd(28)} cloud=${s.cloudCount}  local=${s.localAfter}`);
    }
  }

  await local.end();
  process.exit(0);
})().catch(err => {
  console.error('💥 erro fatal:', err);
  local.end().catch(() => {});
  process.exit(1);
});
