/**
 * scripts/rebackfill-dd.js
 *
 * Re-classifica APENAS as notas DD usando o classificador corrigido.
 * Usa upsert com onConflict:'note_id' — sobrescreve qualquer linha OUTROS existente.
 * NÃO precisa deletar registros primeiro.
 *
 * Uso:
 *   node scripts/rebackfill-dd.js
 */

require('dotenv').config();

const { getClient }           = require('../services/dbClient');
const { classificarBatch }    = require('../services/classifierService');
const { upsertSubcategorias, getNoteIdsByTipo } = require('../db/subcategoriasQueries');

async function fetchAllDDJobs() {
  const sb = getClient();
  const seen = new Map(); // noteId → sectorId

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
        if (tipo !== 'DD') return;
        if (!seen.has(n.id)) {
          seen.set(n.id, {
            noteId:   n.id,
            tipo:     'DD',
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
  console.log('  Re-backfill DD — classificador com fix de race condition');
  console.log('═══════════════════════════════════════════════════════════════');

  const t0 = Date.now();

  console.log('\n[1/3] Coletando UUIDs DD (snapshots + cache existente)...');
  const snapJobs = await fetchAllDDJobs();
  console.log(`      ${snapJobs.length} UUIDs DD nos snapshots`);

  // Também pega UUIDs já em note_subcategorias — necessário p/ reprocessar
  // notas que saíram da janela ativa dos snapshots mas continuam no cache.
  const cacheRows = await getNoteIdsByTipo('DD');
  console.log(`      ${cacheRows.length} UUIDs DD na tabela note_subcategorias`);

  // Funde as duas fontes deduplicando por noteId. Snapshots têm sectorId real;
  // notas só-no-cache caem no default 'DESG' (sem prejuízo p/ regra de RAMAL,
  // que só consulta /api/notes/dd — endpoint que ignora sectorId).
  const byId = new Map();
  snapJobs.forEach(j => byId.set(j.noteId, j));
  cacheRows.forEach(r => {
    if (!byId.has(r.noteId)) {
      byId.set(r.noteId, {
        noteId:   r.noteId,
        tipo:     'DD',
        sectorId: 'DESG',
        numero:   r.numero || null,
      });
    }
  });
  const jobs = [...byId.values()];
  const onlyInCache = jobs.length - snapJobs.length;
  console.log(`      ${jobs.length} UUIDs únicos após merge (+${onlyInCache} só no cache)`);

  if (jobs.length === 0) {
    console.log('\n✅ Nenhum DD a reprocessar.');
    process.exit(0);
  }

  console.log('\n[2/3] Classificando (concorrência=4, details/optimized)...');
  const CHUNK = 50; // lotes menores — DD é pesado (~1.6 MB cada)
  let processed = 0;
  let saved = 0;
  const dist = { C93: 0, BTZ013: 0, OUTROS: 0 };

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
    console.log(`      ${processed}/${jobs.length} (${pct}%) — lote em ${dt}s — C93=${dist.C93} BTZ013=${dist.BTZ013} OUTROS=${dist.OUTROS}`);
  }

  const totalSec = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n✅ Re-backfill DD concluído em ${totalSec}s — ${saved} linhas gravadas.`);
  console.log(`   C93=${dist.C93}  BTZ013=${dist.BTZ013}  OUTROS=${dist.OUTROS}`);

  process.exit(0);
}

main().catch(err => {
  console.error('\n❌ ERRO:', err.message);
  console.error(err.stack);
  process.exit(1);
});
