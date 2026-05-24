/**
 * Diagnóstico: descobrir onde fica o motivo da rejeição no WPA.
 * Testa 3 endpoints + dumps detalhados nos campos relevantes.
 *
 * Uso: node scripts/diag-rejeicao-fonte.js <UUID> [sectorId]
 * Ex:  node scripts/diag-rejeicao-fonte.js ed9c5b41-8188-4c16-8a62-9f6ec0796371 DESG
 */

require('dotenv').config();
const { wpaFetch } = require('../services/wpaService');

const ID       = process.argv[2];
const SECTOR   = process.argv[3] || 'DESG';
if (!ID) {
  console.error('Uso: node scripts/diag-rejeicao-fonte.js <UUID> [sectorId]');
  process.exit(1);
}

(async () => {
  console.log(`UUID: ${ID} | sectorId: ${SECTOR}\n`);

  // ── 1) /details/optimized — onde já achamos Activities, Materials, Comments ──
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('1) GET /api/Notes/{id}/details/optimized?sectorId=' + SECTOR);
  console.log('═══════════════════════════════════════════════════════════════');
  try {
    const det = await wpaFetch(`/api/Notes/${ID}/details/optimized?sectorId=${SECTOR}`);
    if (!det.ok) {
      console.log('HTTP', det.status);
    } else {
      const d = (await det.json())?.Data || {};
      console.log(`Total de chaves no payload: ${Object.keys(d).length}`);
      console.log('\n--- Campos com keyword (reject|reason|motiv|histor|status|approve|return|devolv|justif) ---');
      Object.keys(d)
        .filter(k => /reject|reason|motiv|histor|status|approve|return|devolv|justif/i.test(k))
        .forEach(k => {
          const v = d[k];
          if (Array.isArray(v))
            console.log(`  ${k}: array(${v.length})${v.length ? ' — primeiro item: ' + JSON.stringify(v[0]).slice(0, 250) : ''}`);
          else if (v && typeof v === 'object')
            console.log(`  ${k}: ${JSON.stringify(v).slice(0, 250)}`);
          else
            console.log(`  ${k}: ${JSON.stringify(v)}`);
        });

      console.log('\n--- HistoryRejections completo ---');
      const hr = d.HistoryRejections || d.historyRejections;
      console.log(hr ? JSON.stringify(hr, null, 2).slice(0, 1500) : '(ausente)');

      console.log('\n--- Rejection completo ---');
      const r = d.Rejection || d.rejection;
      console.log(r ? JSON.stringify(r, null, 2).slice(0, 800) : '(ausente)');

      console.log('\n--- Status/StatusHistory ---');
      const sh = d.StatusHistory || d.NoteStatusHistory || d.statusHistory;
      console.log(sh ? JSON.stringify(sh, null, 2).slice(0, 800) : '(ausente)');

      console.log('\n--- Top-level: tipo, Code, ConclusionStatus ---');
      console.log({ Type: d.Type, Code: d.Code, ConclusionStatus: d.ConclusionStatus, ExecutionStatus: d.ExecutionStatus });
    }
  } catch (err) {
    console.log('ERRO:', err.message);
  }

  // ── 2) /api/notes/rejected/{id} — endpoint específico (chute) ──
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('2) GET /api/notes/rejected/' + ID);
  console.log('═══════════════════════════════════════════════════════════════');
  try {
    const rej = await wpaFetch(`/api/notes/rejected/${ID}`);
    if (rej.ok) {
      const r = (await rej.json())?.Data || {};
      console.log(`Chaves: ${Object.keys(r).join(', ')}`);
      console.log('\nPayload (primeiros 1500 chars):');
      console.log(JSON.stringify(r, null, 2).slice(0, 1500));
    } else {
      console.log('HTTP', rej.status, '(endpoint pode não existir)');
    }
  } catch (err) {
    console.log('ERRO:', err.message);
  }

  // ── 3) Endpoints alternativos que podem ter dados de rejeição ──
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('3) Tentando outros endpoints alternativos');
  console.log('═══════════════════════════════════════════════════════════════');
  const alt = [
    `/api/notes/rejection/${ID}`,
    `/api/notes/${ID}/rejection`,
    `/api/notes/${ID}/rejections`,
    `/api/notes/${ID}/history`,
    `/api/notes/${ID}/status-history`,
    `/api/notes/md?noteId=${ID}`,    // MD-specific (a UUID de teste é MD)
    `/api/notes/${ID}/comments`,
    `/api/notes/${ID}/approves`,
  ];
  for (const path of alt) {
    try {
      const r = await wpaFetch(path);
      if (r.ok) {
        const j = await r.json();
        const d = j?.Data || j;
        const keys = Array.isArray(d) ? `[array len ${d.length}]` : (d && typeof d === 'object' ? Object.keys(d).join(', ') : typeof d);
        console.log(`  ✓ ${r.status} ${path}`);
        console.log(`     keys: ${keys}`);
        if (d && Object.keys(d).length > 0 && Object.keys(d).length < 30) {
          console.log(`     amostra: ${JSON.stringify(d).slice(0, 300)}`);
        }
      } else {
        console.log(`  ✗ ${r.status} ${path}`);
      }
    } catch (err) {
      console.log(`  ⚠ ${path} → ${err.message}`);
    }
  }
})().catch(e => { console.error('ERRO GERAL:', e.message); process.exit(1); });
