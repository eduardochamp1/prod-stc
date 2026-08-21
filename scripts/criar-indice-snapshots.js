#!/usr/bin/env node
/**
 * scripts/criar-indice-snapshots.js
 *
 * Cria o índice `(date, team_name, captured_at)` em `snapshots`, que o código
 * afirma existir mas NÃO existe. Usa CREATE INDEX CONCURRENTLY — não trava a
 * tabela, então pode rodar com o painel no ar.
 *
 * POR QUE (achado da revisão paralela de 20/08/2026, backlog P3-14 item 1):
 *   `services/dataService.js:480` diz, em comentário:
 *      "índice em (date, team_name, captured_at) torna isso barato"
 *   Os índices reais de `snapshots` são só `(captured_at DESC)` e
 *   `(date, team_name)` (`db/schema-atual.sql:766` e `:773`).
 *
 *   Sem a terceira coluna, todo `DISTINCT ON (team_name) ... ORDER BY team_name,
 *   captured_at` precisa ORDENAR dentro de cada grupo. E esses queries estão no
 *   caminho de CADA carregamento do Monitor:
 *     services/dataService.js:232   (carteira inicial — primeiro snapshot do dia)
 *     services/dataService.js:344   (sessionBeginReal)
 *     services/dataService.js:354
 *     services/dataService.js:478   (último snapshot por equipe)
 *     services/dataWriter.js:989    (team_daily_carteira)
 *   Numa tabela retida PARA SEMPRE, crescendo ~16MB/dia, o custo sobe todo dia —
 *   o que casa com "algumas páginas estão lentas" sem nada ter mudado nelas.
 *
 * READ-ONLY? NÃO. Este script CRIA um índice. É a única mudança de banco aqui.
 * Reversível com um DROP INDEX (o comando é impresso no fim).
 *
 * Uso (na VM):
 *   node -r dotenv/config scripts/criar-indice-snapshots.js --dry-run
 *   node -r dotenv/config scripts/criar-indice-snapshots.js
 */

const flag = n => process.argv.includes(`--${n}`);
const DRY = flag('dry-run');

const NOME = 'idx_snapshots_date_team_captured';
const DDL  = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${NOME} ` +
             `ON public.snapshots USING btree (date, team_name, captured_at)`;

async function main() {
  const { _getPool } = require('../services/pgShim');
  const pool = _getPool();
  if (!pool) { console.error('Sem pool. Rode com `node -r dotenv/config` na VM.'); process.exit(1); }

  // Estado atual: tamanho da tabela e índices existentes.
  const { rows: tam } = await pool.query(
    `SELECT pg_size_pretty(pg_total_relation_size('public.snapshots')) AS total,
            pg_size_pretty(pg_indexes_size('public.snapshots'))        AS indices,
            (SELECT count(*)::bigint FROM public.snapshots)            AS linhas`);
  console.log(`\n=== snapshots ===`);
  console.log(`linhas: ${tam[0].linhas}   tamanho total: ${tam[0].total}   índices: ${tam[0].indices}`);

  const { rows: idx } = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'snapshots' ORDER BY indexname`);
  console.log(`\níndices atuais:`);
  idx.forEach(i => console.log(`  ${i.indexname}${i.indexname === NOME ? '   ← o que queremos' : ''}`));

  if (idx.some(i => i.indexname === NOME)) {
    console.log(`\n✅ O índice já existe. Nada a fazer.`);
    await pool.end();
    return;
  }

  if (DRY) {
    console.log(`\n--dry-run. O comando que seria executado:\n\n  ${DDL};\n`);
    console.log(`CONCURRENTLY não trava a tabela (não bloqueia leitura nem escrita),`);
    console.log(`mas leva mais tempo e faz uma varredura completa. Numa tabela deste`);
    console.log(`tamanho, conte alguns minutos. Rode fora do pico, por segurança.`);
    await pool.end();
    return;
  }

  console.log(`\nCriando (CONCURRENTLY — sem lock)…`);
  const t0 = Date.now();
  try {
    await pool.query(DDL);
  } catch (err) {
    console.error(`\nFALHOU: ${err.message}`);
    console.error(`\n⚠️ Um CREATE INDEX CONCURRENTLY que falha deixa índice INVÁLIDO.`);
    console.error(`Confira e limpe, se for o caso:`);
    console.error(`  SELECT indexrelid::regclass, indisvalid FROM pg_index`);
    console.error(`   WHERE indexrelid::regclass::text = '${NOME}';`);
    console.error(`  DROP INDEX IF EXISTS ${NOME};`);
    await pool.end();
    process.exit(1);
  }
  console.log(`✅ criado em ${Math.round((Date.now() - t0) / 1000)}s`);

  const { rows: dep } = await pool.query(
    `SELECT pg_size_pretty(pg_indexes_size('public.snapshots')) AS indices`);
  console.log(`índices agora ocupam: ${dep[0].indices}`);
  console.log(`\nReverter, se preciso:\n  DROP INDEX CONCURRENTLY IF EXISTS ${NOME};`);
  console.log(`\nDepois disso, compare a latência das páginas no log:`);
  console.log(`  pm2 logs wpa-monitor --lines 500 | grep slow_request`);

  await pool.end();
}

main().catch(err => { console.error('ERRO:', err.message); process.exit(1); });
