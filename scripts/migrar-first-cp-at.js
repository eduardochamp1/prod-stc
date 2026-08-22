#!/usr/bin/env node
/**
 * scripts/migrar-first-cp-at.js
 *
 * Cria e preenche `note_details.first_cp_at` — o timestamp do PRIMEIRO checkpoint
 * de cada nota, numa coluna indexável.
 *
 * POR QUE: a aba Deslocamento filtra por
 *   (payload->'checkpoints'->0->>'timestamp')::timestamptz
 * que NÃO pode ser indexada (o cast pra timestamptz não é IMMUTABLE — depende do
 * TimeZone da sessão quando a string não traz offset). Sem índice, cada consulta
 * faz varredura COMPLETA de `note_details`, com detoast do jsonb linha a linha,
 * em até 90 dias de payloads inteiros de nota. Medido: 4,3s só no passo 1.
 *
 * O que este script faz, em ordem, tudo idempotente:
 *   1. ALTER TABLE ADD COLUMN IF NOT EXISTS first_cp_at timestamptz  (instantâneo)
 *   2. backfill em lotes, só onde está NULL e há checkpoints
 *   3. CREATE INDEX CONCURRENTLY (não trava a tabela)
 *   4. relatório: quantas linhas ficaram sem valor e por quê
 *
 * ⚠️ A QUERY DA ABA SÓ PASSA A USAR A COLUNA quando você ligar
 * `DESLOC_USE_FIRST_CP=1` no .env. Isso é deliberado: enquanto o backfill não
 * terminar, usar a coluna esconderia notas (as de first_cp_at NULL). Rode este
 * script até `sem_valor` bater com o esperado, e só então ligue a flag.
 *
 * Uso (na VM):
 *   node -r dotenv/config scripts/migrar-first-cp-at.js --dry-run
 *   node -r dotenv/config scripts/migrar-first-cp-at.js
 *   node -r dotenv/config scripts/migrar-first-cp-at.js --lote 5000
 *
 * Reverter: DROP INDEX CONCURRENTLY IF EXISTS idx_note_details_first_cp_at;
 *           ALTER TABLE note_details DROP COLUMN IF EXISTS first_cp_at;
 *           (e tirar a flag do .env)
 */

const flag = n => process.argv.includes(`--${n}`);
function arg(nome, padrao) {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}

const DRY  = flag('dry-run');
const LOTE = Math.min(Math.max(Number(arg('lote', 2000)) || 2000, 100), 20000);
const IDX  = 'idx_note_details_first_cp_at';

async function main() {
  const { _getPool } = require('../services/pgShim');
  const pool = _getPool();
  if (!pool) { console.error('Sem pool. Rode com `node -r dotenv/config` na VM.'); process.exit(1); }

  console.log(`\n=== note_details.first_cp_at ===`);

  const { rows: est } = await pool.query(
    `SELECT count(*)::bigint AS linhas,
            count(*) FILTER (WHERE payload->'checkpoints' IS NOT NULL
                               AND jsonb_array_length(payload->'checkpoints') >= 1)::bigint AS com_cp,
            pg_size_pretty(pg_total_relation_size('public.note_details')) AS tamanho
       FROM public.note_details`);
  console.log(`linhas: ${est[0].linhas}   com checkpoint: ${est[0].com_cp}   tamanho: ${est[0].tamanho}`);

  const { rows: temCol } = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='note_details' AND column_name='first_cp_at'`);
  console.log(`coluna existe: ${temCol.length > 0 ? 'sim' : 'não'}`);

  if (DRY) {
    console.log(`\n--dry-run. O que seria feito:`);
    if (temCol.length === 0) console.log(`  1. ALTER TABLE public.note_details ADD COLUMN first_cp_at timestamptz;`);
    console.log(`  2. backfill de ~${est[0].com_cp} linhas, em lotes de ${LOTE}`);
    console.log(`  3. CREATE INDEX CONCURRENTLY ${IDX} ON note_details (first_cp_at);`);
    console.log(`\nNada foi alterado. A query da aba só usa a coluna com DESLOC_USE_FIRST_CP=1.`);
    await pool.end();
    return;
  }

  // 1. Coluna (instantâneo — nullable, sem default).
  if (temCol.length === 0) {
    await pool.query(`ALTER TABLE public.note_details ADD COLUMN first_cp_at timestamptz`);
    console.log(`✅ coluna criada`);
  }

  // 2. Backfill em lotes. O CAST acontece aqui uma vez por linha, não a cada
  //    consulta da aba — é exatamente o ponto da migração.
  let total = 0, t0 = Date.now();
  for (;;) {
    const { rowCount } = await pool.query(
      `WITH alvo AS (
         SELECT note_id
           FROM public.note_details
          WHERE first_cp_at IS NULL
            AND payload->'checkpoints' IS NOT NULL
            AND jsonb_array_length(payload->'checkpoints') >= 1
            AND payload->'checkpoints'->0->>'timestamp' IS NOT NULL
          LIMIT $1
       )
       UPDATE public.note_details nd
          SET first_cp_at = (nd.payload->'checkpoints'->0->>'timestamp')::timestamptz
         FROM alvo
        WHERE nd.note_id = alvo.note_id`,
      [LOTE]);
    if (rowCount === 0) break;
    total += rowCount;
    console.log(`  backfill: ${total} linhas (${Math.round((Date.now() - t0) / 1000)}s)`);
  }
  console.log(`✅ backfill: ${total} linhas em ${Math.round((Date.now() - t0) / 1000)}s`);

  // 3. Índice, sem lock.
  const { rows: temIdx } = await pool.query(
    `SELECT 1 FROM pg_indexes WHERE tablename='note_details' AND indexname=$1`, [IDX]);
  if (temIdx.length === 0) {
    console.log(`criando índice (CONCURRENTLY — sem lock)…`);
    const ti = Date.now();
    try {
      await pool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${IDX} ON public.note_details (first_cp_at)`);
      console.log(`✅ índice criado em ${Math.round((Date.now() - ti) / 1000)}s`);
    } catch (err) {
      console.error(`FALHOU: ${err.message}`);
      console.error(`CONCURRENTLY que falha deixa índice INVÁLIDO. Limpe com:`);
      console.error(`  DROP INDEX IF EXISTS ${IDX};`);
      await pool.end();
      process.exit(1);
    }
  } else {
    console.log(`índice já existia`);
  }

  // 4. Relatório final — quem ficou sem valor e por quê.
  const { rows: fim } = await pool.query(
    `SELECT count(*) FILTER (WHERE first_cp_at IS NOT NULL)::bigint AS com_valor,
            count(*) FILTER (WHERE first_cp_at IS NULL
                               AND (payload->'checkpoints' IS NULL
                                 OR jsonb_array_length(payload->'checkpoints') = 0))::bigint AS sem_checkpoint,
            count(*) FILTER (WHERE first_cp_at IS NULL
                               AND payload->'checkpoints' IS NOT NULL
                               AND jsonb_array_length(payload->'checkpoints') >= 1)::bigint AS sem_valor
       FROM public.note_details`);
  console.log(`\n── ESTADO FINAL ──`);
  console.log(`  com valor:                        ${fim[0].com_valor}`);
  console.log(`  sem checkpoint (esperado NULL):   ${fim[0].sem_checkpoint}`);
  console.log(`  TEM checkpoint mas sem valor:     ${fim[0].sem_valor}   ← precisa ser 0`);

  if (Number(fim[0].sem_valor) === 0) {
    console.log(`\n✅ Backfill completo. Agora pode ligar a flag:`);
    console.log(`   echo 'DESLOC_USE_FIRST_CP=1' >> .env  &&  pm2 delete wpa-monitor && pm2 start ecosystem.config.js && pm2 save`);
    console.log(`\n   Depois compare o passo 1 no log:`);
    console.log(`   pm2 logs wpa-monitor --lines 200 --nostream | grep "\\[deslocamentos\\] passo 1"`);
  } else {
    console.log(`\n⚠️ Ainda há linhas com checkpoint e sem valor — provavelmente timestamp em`);
    console.log(`   formato que o cast rejeita (ex.: o DD/MM/YYYY antigo do P1-28). NÃO ligue`);
    console.log(`   a flag ainda: essas notas desapareceriam da aba. Me mande o número.`);
  }

  await pool.end();
}

main().catch(err => { console.error('ERRO:', err.message); process.exit(1); });
