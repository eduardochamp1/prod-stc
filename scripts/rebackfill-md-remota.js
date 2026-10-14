/**
 * scripts/rebackfill-md-remota.js
 *
 * Acha MD de MEDIDOR REMOTO (texto "Instalar remota" no Comments) entre as notas
 * já classificadas como OUTROS e regrava SÓ essas como sub_code REMOTA.
 *
 * Por que não o rebackfill-md.js: com a regra nova, toda MD precisa do
 * /details/optimized (50-150 KB). Reclassificar as ~34 mil MD seria ~3 GB de
 * tráfego e risco de memória no pm2. Aqui:
 *   - só MD de snapshots com date >= --desde (padrão: 14 dias atrás);
 *   - só as que hoje estão como OUTROS em note_subcategorias;
 *   - concorrência 3;
 *   - NUNCA altera TL11/OBSOLETO nem regrava OUTROS: só grava o que virou REMOTA.
 *
 * Uso (na VM):
 *   node scripts/rebackfill-md-remota.js --dry                  # só conta, não grava
 *   node scripts/rebackfill-md-remota.js --desde=2026-10-01
 *
 * Depois, o total diário (team_daily_subcat_totals) só se corrige quando o dia for
 * re-consolidado.
 */

require('dotenv').config();

const { getClient }        = require('../services/dbClient');
const { classificarBatch } = require('../services/classifierService');
const { upsertSubcategorias } = require('../db/subcategoriasQueries');

const arg = (n) => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=')[1];
const DRY = process.argv.includes('--dry');
const DESDE = arg('desde') ||
  new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);

async function mdJobsDesde(desde) {
  const sb = getClient();
  const seen = new Map();
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await sb
      .from('snapshots')
      .select('date, sector_id, data')
      .gte('date', desde)
      .order('date', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    data.forEach(snap => {
      const t = snap.data;
      if (!t) return;
      [...(t.notasConcluidas || []), ...(t.notasExecutadas || []),
       ...(t.notasBaixadas || []), ...(t.notasRejeitadas || []),
       ...(t.notasVistoriadas || [])].forEach(n => {
        if (!n.id || (n.tipoCode || '').toUpperCase() !== 'MD') return;
        if (!seen.has(n.id)) {
          seen.set(n.id, { noteId: n.id, tipo: 'MD', sectorId: snap.sector_id || 'DESG', numero: n.codigo || null });
        }
      });
    });
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return [...seen.values()];
}

// Mantém só as que o cache marca como OUTROS (ou que nem estão no cache).
async function soOutros(jobs) {
  const sb = getClient();
  const naoOutros = new Set();
  for (let i = 0; i < jobs.length; i += 100) {
    const ids = jobs.slice(i, i + 100).map(j => j.noteId);
    const { data, error } = await sb.from('note_subcategorias')
      .select('note_id, sub_code').in('note_id', ids);
    if (error) throw error;
    (data || []).forEach(r => { if (r.sub_code !== 'OUTROS') naoOutros.add(r.note_id); });
  }
  return jobs.filter(j => !naoOutros.has(j.noteId));
}

async function main() {
  console.log(`Re-backfill MD remota — desde ${DESDE}${DRY ? ' (DRY: não grava)' : ''}`);
  const todas = await mdJobsDesde(DESDE);
  console.log(`  ${todas.length} MD nos snapshots`);
  const jobs = await soOutros(todas);
  console.log(`  ${jobs.length} estão como OUTROS (ou sem cache) → serão consultadas`);

  const CHUNK = 60;
  let achadas = 0, gravadas = 0;
  for (let i = 0; i < jobs.length; i += CHUNK) {
    const classifs = await classificarBatch(jobs.slice(i, i + CHUNK), 3);
    const remotas = classifs.filter(c => c.sub_code === 'REMOTA');
    achadas += remotas.length;
    if (!DRY && remotas.length) gravadas += await upsertSubcategorias(remotas);
    console.log(`  ${Math.min(i + CHUNK, jobs.length)}/${jobs.length} — REMOTA achadas=${achadas}`);
  }
  console.log(`\n✅ Concluído. REMOTA achadas=${achadas}${DRY ? ' (nada gravado)' : `, gravadas=${gravadas}`}`);
  process.exit(0);
}

main().catch(err => { console.error('❌ ERRO:', err.stack || err.message); process.exit(1); });
