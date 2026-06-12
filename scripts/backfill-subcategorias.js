/**
 * scripts/backfill-subcategorias.js
 *
 * Varre snapshots históricos no Supabase, coleta todos os UUIDs únicos
 * de notas MD/SF/DD que ainda não estão classificados em note_subcategorias,
 * e classifica em batch chamando os endpoints leves do WPA.
 *
 * Uso:
 *   node scripts/backfill-subcategorias.js                # todos os snapshots
 *   node scripts/backfill-subcategorias.js 2026-04-01     # a partir desta data
 *   node scripts/backfill-subcategorias.js 2026-04-01 2026-04-27   # intervalo
 *
 * Pré-requisitos no .env:
 *   DATA_MODE=wpa
 *   WPA_USERNAME, WPA_PASSWORD
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

require('dotenv').config();

const { getClient }       = require('../services/dbClient');
const { classificarBatch } = require('../services/classifierService');
const { getClassifiedIds, upsertSubcategorias } = require('../db/subcategoriasQueries');

// Lê argumentos: [dataInicial?] [dataFinal?]
const argDe  = process.argv[2] || null;
const argAte = process.argv[3] || null;

async function fetchSnapshotsRange(de, ate) {
  const sb = getClient();
  let query = sb
    .from('snapshots')
    .select('date, sector_id, data')
    .order('date', { ascending: true });
  if (de)  query = query.gte('date', de);
  if (ate) query = query.lte('date', ate);

  // Paginação manual (Supabase limita 1000 por requisição)
  const all = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await query.range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

function coletarJobs(snapshots) {
  const seen = new Set();
  const jobs = [];
  snapshots.forEach(snap => {
    const t = snap.data;
    if (!t) return;
    const todas = [
      ...(t.notasConcluidas  || []),
      ...(t.notasExecutadas  || []),
      ...(t.notasBaixadas    || []),
      ...(t.notasRejeitadas  || []),
      ...(t.notasVistoriadas || []),
    ];
    todas.forEach(n => {
      if (!n.id || seen.has(n.id)) return;
      const tipo = (n.tipoCode || '').toUpperCase();
      if (!['MD','SF','DD'].includes(tipo)) return;
      seen.add(n.id);
      jobs.push({
        noteId:   n.id,
        tipo,
        sectorId: snap.sector_id || 'DESG',
        numero:   n.codigo || null,
      });
    });
  });
  return jobs;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Backfill de Subcategorias — Engelmig WPA Monitor');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Período: ${argDe || '(início)'} → ${argAte || '(hoje)'}`);

  const t0 = Date.now();

  console.log('\n[1/4] Carregando snapshots do Supabase...');
  const snaps = await fetchSnapshotsRange(argDe, argAte);
  console.log(`      ${snaps.length} snapshots encontrados`);

  console.log('\n[2/4] Coletando UUIDs únicos de MD/SF/DD...');
  const jobs = coletarJobs(snaps);
  console.log(`      ${jobs.length} UUIDs únicos`);

  console.log('\n[3/4] Filtrando os já classificados...');
  const known = await getClassifiedIds();
  const todo  = jobs.filter(j => !known.has(j.noteId));
  console.log(`      ${todo.length} UUIDs a classificar (${jobs.length - todo.length} já em cache)`);

  if (todo.length === 0) {
    console.log('\n✅ Nada a fazer.');
    process.exit(0);
  }

  // Distribuição por tipo (para estimar tempo)
  const dist = todo.reduce((acc, j) => { acc[j.tipo] = (acc[j.tipo]||0)+1; return acc; }, {});
  console.log(`      Distribuição: MD=${dist.MD||0}  SF=${dist.SF||0}  DD=${dist.DD||0}`);
  // Estimativa: MD/SF/DD leves ~150ms; DD/C93|BTZ013 +500ms (details/optimized)
  const estSec = Math.ceil(todo.length * 0.2);
  console.log(`      Estimativa: ~${estSec}s (${Math.ceil(estSec/60)} min)`);

  console.log('\n[4/4] Classificando em lotes de 10 paralelos...');
  const CHUNK = 200; // grava no Supabase a cada 200 classificações para resiliência
  let processed = 0;
  let saved = 0;
  for (let i = 0; i < todo.length; i += CHUNK) {
    const batch = todo.slice(i, i + CHUNK);
    const tBatch = Date.now();
    const classifs = await classificarBatch(batch, 10);
    if (classifs.length > 0) {
      const n = await upsertSubcategorias(classifs);
      saved += n;
    }
    processed += batch.length;
    const pct = ((processed / todo.length) * 100).toFixed(1);
    const dt  = ((Date.now() - tBatch) / 1000).toFixed(1);
    console.log(`      ${processed}/${todo.length} (${pct}%) — lote em ${dt}s — saved=${saved}`);
  }

  const totalSec = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n✅ Backfill concluído em ${totalSec}s — ${saved} subcategorias gravadas.`);

  // Sumário final
  const { getCountsBySubcode } = require('../db/subcategoriasQueries');
  const counts = await getCountsBySubcode();
  console.log('\nDistribuição na tabela note_subcategorias:');
  Object.entries(counts).sort((a,b) => b[1]-a[1]).forEach(([code, n]) => {
    console.log(`  ${code.padEnd(12)} ${n}`);
  });

  process.exit(0);
}

main().catch(err => {
  console.error('\n❌ ERRO:', err.message);
  console.error(err.stack);
  process.exit(1);
});
