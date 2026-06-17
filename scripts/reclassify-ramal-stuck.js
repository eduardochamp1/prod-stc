#!/usr/bin/env node
/**
 * scripts/reclassify-ramal-stuck.js
 * Reclassifica notas DD/OUTROS que são RAMAL (C93) mas ficaram presas em OUTROS.
 *
 * Causa raiz (achada na auditoria 17/06/2026): notas CAPEX "RAMAL DE LIGACAO"
 * sincronizam Activities[]/Address na WPA com atraso. O cron de classificação
 * vê a nota cedo (Address ainda sem "RAMAL BT") e grava OUTROS no cache imutável.
 * O cron `retry-outros` só reprocessa os últimos 7 dias — notas mais antigas que
 * isso ficam presas em OUTROS pra sempre, subnotificando "Subs Ramal".
 *
 * Este script mira APENAS os candidatos a ramal (não os 1500+ OUTROS legítimos
 * de poda/manutenção), então faz poucas chamadas à WPA. Reusa o classificador
 * autoritativo (re-busca details/optimized AO VIVO → pega o Address atual).
 *
 * Uso (na VM, DATA_MODE=wpa):
 *   node scripts/reclassify-ramal-stuck.js           # DRY-RUN (não grava nada)
 *   node scripts/reclassify-ramal-stuck.js --apply    # grava + reconsolida datas
 *
 * Read-only por padrão. Só escreve com --apply.
 */

require('dotenv').config({ override: true });

const APPLY = process.argv.includes('--apply');
const MODE  = (process.env.DATA_MODE || 'mock').toLowerCase();

const { dateBRT, dateBRTMinusDays } = require('../services/timeUtil');

let pool;
try {
  pool = require('../services/pgShim')._getPool();
} catch (err) {
  console.error('\n[reclassify-ramal] sem pool Postgres:', err.message);
  console.error('[reclassify-ramal] exige DATABASE_URL no .env.\n');
  process.exit(1);
}

const log = (s) => console.log(s);
const H   = (s) => console.log(`\n${'═'.repeat(70)}\n  ${s}\n${'═'.repeat(70)}`);

async function main() {
  H(`RECLASSIFICAÇÃO DE RAMAIS PRESOS EM OUTROS  ${APPLY ? '(APPLY)' : '(DRY-RUN)'}`);
  if (MODE !== 'wpa') {
    log(`  ⚠️  DATA_MODE=${MODE} — a reclassificação ao vivo precisa de DATA_MODE=wpa (acesso à WPA).`);
    log('  Abortando: rode na VM interna.\n');
    return;
  }

  // ── 1. Candidatos: DD/OUTROS que cheiram a ramal ──────────────────────────
  // Critério: descrição menciona "ramal", OU Code top-level = C93, OU raw guardou
  // uma atividade C93. Junta o Address do note_details pra diagnóstico.
  const cands = await q(
    `SELECT ns.note_id, ns.numero, ns.code, ns.code_text,
            to_char(ns.classified_at,'YYYY-MM-DD') AS classified_at,
            COALESCE(nd.payload->'endereco'->>'logradouro','') AS address,
            COALESCE(nd.payload->'datas'->>'conclusao','')     AS conclusao
     FROM note_subcategorias ns
     LEFT JOIN note_details nd ON nd.note_id = ns.note_id
     WHERE ns.tipo = 'DD' AND ns.sub_code = 'OUTROS'
       AND (
         ns.code_text ILIKE '%ramal%'
         OR upper(COALESCE(ns.code,'')) = 'C93'
         OR ns.raw->'activities' @> '[{"Code":"C93"}]'::jsonb
       )
     ORDER BY ns.classified_at`);

  log(`\n  ${cands.length} candidato(s) DD/OUTROS com cara de ramal:\n`);
  if (cands.length === 0) {
    log('  Nada a fazer — nenhum ramal preso em OUTROS. 🎉\n');
    return;
  }

  const cutoff30 = dateBRTMinusDays(30);
  for (const c of cands) {
    const tem = /ramal\s+bt/i.test(c.address);
    const velha = c.classified_at < cutoff30;
    log(`  • ${c.numero || c.note_id}  classif=${c.classified_at}` +
        `  code=${c.code || '-'}  "${(c.code_text || '').slice(0, 40)}"`);
    log(`      address="${c.address.slice(0, 55) || '(sem note_details)'}"` +
        `  ${tem ? '✓ TEM ramal bt' : '· sem ramal bt'}` +
        `  ${velha ? '⚠ snapshot pode ter expirado (>30d)' : ''}`);
  }

  // ── 2. Reclassifica AO VIVO (re-busca details/optimized → Address atual) ───
  const { classificarBatch } = require('../services/classifierService');
  const jobs = cands.map(c => ({ noteId: c.note_id, tipo: 'DD', sectorId: 'DESG', numero: c.numero }));
  log(`\n  Reclassificando ${jobs.length} nota(s) ao vivo na WPA (concorrência 4)…`);
  const t0 = Date.now();
  const classifs = await classificarBatch(jobs, 4);
  log(`  feito em ${((Date.now() - t0) / 1000).toFixed(1)}s.\n`);

  const changed = classifs.filter(c => c.sub_code && c.sub_code !== 'OUTROS');
  if (changed.length === 0) {
    log('  Nenhuma mudou de OUTROS — ou ainda sem "ramal bt" no Address, ou já corretas.');
    log('  (Se você esperava mudanças, o Address dessas notas realmente não tem "RAMAL BT".)\n');
    return;
  }

  log(`  ${changed.length} nota(s) mudariam de OUTROS:`);
  changed.forEach(c => log(`    → ${c.numero || c.note_id}: OUTROS → ${c.sub_code} (${c.sub_categoria}) qtd=${c.quantidade ?? '-'}`));

  if (!APPLY) {
    log('\n  DRY-RUN — nada gravado. Rode com --apply pra persistir + reconsolidar.\n');
    return;
  }

  // ── 3. APPLY: grava no cache e reconsolida as datas afetadas ───────────────
  const { upsertSubcategorias } = require('../db/subcategoriasQueries');
  const { consolidateDay }      = require('../services/dataWriter');
  await upsertSubcategorias(changed);
  log(`\n  ✅ ${changed.length} classificação(ões) atualizada(s) em note_subcategorias.`);

  // Datas a reconsolidar: vêm da conclusão da nota (note_details). Sem isso,
  // não dá pra saber o dia operacional — loga e pula.
  const byId = Object.fromEntries(cands.map(c => [c.note_id, c]));
  const datas = new Set();
  let semData = 0;
  for (const c of changed) {
    const conc = byId[c.note_id]?.conclusao || '';
    const d = conc.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) datas.add(d);
    else semData++;
  }
  if (semData > 0) log(`  ⚠️  ${semData} nota(s) sem data de conclusão no cache — total agregado dessas não será reconsolidado automaticamente.`);

  const hoje = dateBRT();
  for (const d of [...datas].sort()) {
    if (d < dateBRTMinusDays(30)) {
      log(`  ⚠️  ${d}: fora da janela de snapshots (30d) — agregado histórico não pode ser reconstruído daqui (precisaria backfill via WPA).`);
      continue;
    }
    try {
      await consolidateDay(d);
      log(`  ✅ reconsolidado ${d}`);
    } catch (e) {
      log(`  🔴 falha ao reconsolidar ${d}: ${e.message}`);
    }
  }
  log('\n  Concluído.\n');
}

async function q(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

main()
  .catch(err => { console.error('\n[reclassify-ramal] erro fatal:', err.message); process.exitCode = 1; })
  .finally(async () => { try { await pool.end(); } catch (_) {} });
