#!/usr/bin/env node
/**
 * scripts/reclassify-cs-quantidade.js — corrige a quantidade das notas BTZ013
 * (Substituição CS) JÁ GRAVADAS em note_subcategorias (23/07/2026).
 *
 * CONTEXTO: até 23/07/2026 a quantidade do BTZ013 vinha de "TOTAL CLIENTES: N"
 * do Comments (nº de CLIENTES), inflando o indicador "Substituição CS". O
 * correto é a "Quantidade" da Atividade no portal WPA = Activity.Amount (nº de
 * CS). O classifier já foi corrigido; este script conserta o HISTÓRICO.
 *
 * COMO: recomputa a quantidade a partir do `raw.activities` JÁ ARMAZENADO em
 * note_subcategorias (Code/Amount/IsPrimary) — NÃO re-busca a WPA (a WPA poda
 * notas antigas). Pega o Amount da atividade BTZ013 (prioriza IsPrimary),
 * default 1 se não houver activities no raw.
 *
 * ⚠️ Isto só corrige note_subcategorias. Pra refletir no card/gráfico é preciso
 * RE-CONSOLIDAR os dias afetados (team_daily_subcat_totals) — o script imprime o
 * comando do backfill-consolidate no fim.
 *
 * USO (na VM):
 *   node scripts/reclassify-cs-quantidade.js            # DRY-RUN (não grava)
 *   node scripts/reclassify-cs-quantidade.js --apply    # aplica
 */

require('dotenv').config();
const { getClient } = require('../services/dbClient');

// Amount da atividade BTZ013 no raw (prioriza IsPrimary). Default 1 (1 CS/nota).
function amountFromRaw(raw) {
  const acts = (raw && Array.isArray(raw.activities)) ? raw.activities : [];
  const btz = acts.find(a => a.Code === 'BTZ013' && a.IsPrimary)
           || acts.find(a => a.Code === 'BTZ013');
  const amt = btz && btz.Amount != null ? Number(btz.Amount) : 1;
  return Number.isFinite(amt) && amt > 0 ? amt : 1;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const sb = getClient();

  const { data, error } = await sb
    .from('note_subcategorias')
    .select('note_id, numero, quantidade, raw')
    .eq('sub_code', 'BTZ013');
  if (error) throw error;

  const rows = data || [];
  const changes = [];   // { note_id, numero, de, para }
  for (const r of rows) {
    const novo = amountFromRaw(r.raw);
    const atual = r.quantidade != null ? Number(r.quantidade) : null;
    if (atual !== novo) changes.push({ note_id: r.note_id, numero: r.numero, de: atual, para: novo });
  }

  console.log(`\n${apply ? '⚙️  APLICANDO' : '🔍 DRY-RUN (não grava)'} — BTZ013/Substituição CS`);
  console.log(`  ${rows.length} notas BTZ013 no total · ${changes.length} a ajustar\n`);
  for (const c of changes.slice(0, 20)) {
    console.log(`  ${c.numero}: ${c.de} → ${c.para}`);
  }
  if (changes.length > 20) console.log(`  … (+${changes.length - 20})`);

  if (apply && changes.length) {
    // Agrupa por valor-alvo → um UPDATE ... IN (...) por valor (quase tudo = 1).
    const byTarget = new Map();
    for (const c of changes) {
      if (!byTarget.has(c.para)) byTarget.set(c.para, []);
      byTarget.get(c.para).push(c.note_id);
    }
    for (const [para, ids] of byTarget) {
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        const { error: e2 } = await sb.from('note_subcategorias')
          .update({ quantidade: para }).in('note_id', chunk);
        if (e2) throw e2;
      }
      console.log(`  ✓ ${ids.length} nota(s) → quantidade=${para}`);
    }
    console.log('\n✅ note_subcategorias corrigido. AGORA re-consolide os dias afetados:');
    console.log('   node scripts/backfill-consolidate.js <de> <ate> --apply');
    console.log('   (ex.: o período em que houve Substituição CS — team_daily_subcat_totals só');
    console.log('    reflete o novo valor após re-consolidar.)');
  } else if (!apply) {
    console.log('\nℹ️  Dry-run. Rode com --apply pra gravar. Depois: backfill-consolidate.');
  } else {
    console.log('\nNada a ajustar.');
  }

  try { const { _getPool } = require('../services/pgShim'); const p = _getPool && _getPool(); if (p && p.end) await p.end(); } catch (_) {}
}

main().then(() => process.exit(0)).catch(e => { console.error('ERRO:', e.message); process.exit(1); });
