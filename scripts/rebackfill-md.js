/**
 * scripts/rebackfill-md.js
 *
 * Re-classifica APENAS as notas MD usando o classificador atualizado.
 * Útil quando a regra de MD muda (ex: migração SubProject → Comments).
 *
 * Funde 2 fontes de UUIDs (igual rebackfill-dd.js):
 *   1. snapshots ativos (DDs/MDs em sessões recentes — pega notas novas)
 *   2. tabela note_subcategorias com tipo='MD' (pega notas que saíram da
 *      janela ativa dos snapshots mas continuam classificadas em cache)
 *
 * Upsert com onConflict:'note_id' — sobrescreve qualquer linha MD existente.
 *
 * Uso:
 *   node scripts/rebackfill-md.js
 */

require('dotenv').config();

const { getClient }           = require('../services/dbClient');
const { classificarBatch }    = require('../services/classifierService');
const { upsertSubcategorias, getNoteIdsByTipo } = require('../db/subcategoriasQueries');

async function fetchAllMDJobsFromSnapshots() {
  const sb = getClient();
  const seen = new Map();

  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await sb
      .from('snapshots')
      .select('date, sector_id, data')
      .order('date', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;

    data.forEach(snap => {
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
        if (!n.id) return;
        const tipo = (n.tipoCode || '').toUpperCase();
        if (tipo !== 'MD') return;
        if (!seen.has(n.id)) {
          seen.set(n.id, {
            noteId:   n.id,
            tipo:     'MD',
            sectorId: snap.sector_id || 'DESG',
            numero:   n.codigo || null,
          });
        }
      });
    });

    if (data.length < PAGE) break;
    from += PAGE;
  }

  return [...seen.values()];
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Re-backfill MD — classificador com regra Comments-based');
  console.log('═══════════════════════════════════════════════════════════════');

  const t0 = Date.now();

  console.log('\n[1/3] Coletando UUIDs MD (snapshots + cache existente)...');
  const snapJobs = await fetchAllMDJobsFromSnapshots();
  console.log(`      ${snapJobs.length} UUIDs MD nos snapshots`);

  const cacheRows = await getNoteIdsByTipo('MD');
  console.log(`      ${cacheRows.length} UUIDs MD na tabela note_subcategorias`);

  // Funde por noteId, dedupe. Notas só-no-cache caem em sectorId='DESG'
  // (sectorId não importa pra classificarMD — não consulta details/optimized).
  const byId = new Map();
  snapJobs.forEach(j => byId.set(j.noteId, j));
  cacheRows.forEach(r => {
    if (!byId.has(r.noteId)) {
      byId.set(r.noteId, {
        noteId:   r.noteId,
        tipo:     'MD',
        sectorId: 'DESG',
        numero:   r.numero || null,
      });
    }
  });
  const jobs = [...byId.values()];
  const onlyInCache = jobs.length - snapJobs.length;
  console.log(`      ${jobs.length} UUIDs únicos após merge (+${onlyInCache} só no cache)`);

  if (jobs.length === 0) {
    console.log('\n✅ Nenhum MD a reprocessar.');
    process.exit(0);
  }

  console.log('\n[2/3] Classificando (concorrência=10, /api/notes/md leve)...');
  const CHUNK = 200;
  let processed = 0;
  let saved = 0;
  const dist = { TL11: 0, OBSOLETO: 0, OUTROS: 0 };

  for (let i = 0; i < jobs.length; i += CHUNK) {
    const batch = jobs.slice(i, i + CHUNK);
    const tBatch = Date.now();
    const classifs = await classificarBatch(batch, 10);

    classifs.forEach(c => {
      dist[c.sub_code] = (dist[c.sub_code] || 0) + 1;
    });

    if (classifs.length > 0) {
      const n = await upsertSubcategorias(classifs);
      saved += n;
    }
    processed += batch.length;
    const pct = ((processed / jobs.length) * 100).toFixed(1);
    const dt  = ((Date.now() - tBatch) / 1000).toFixed(1);
    console.log(`      ${processed}/${jobs.length} (${pct}%) — lote em ${dt}s — TL11=${dist.TL11} OBSOLETO=${dist.OBSOLETO} OUTROS=${dist.OUTROS}`);
  }

  console.log('\n[3/3] Sumário final:');
  const totalSec = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n✅ Re-backfill MD concluído em ${totalSec}s — ${saved} linhas gravadas.`);
  console.log(`   TL11=${dist.TL11}  OBSOLETO=${dist.OBSOLETO}  OUTROS=${dist.OUTROS}`);

  process.exit(0);
}

main().catch(err => {
  console.error('\n❌ ERRO:', err.message);
  console.error(err.stack);
  process.exit(1);
});
