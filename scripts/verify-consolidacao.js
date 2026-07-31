#!/usr/bin/env node
/**
 * scripts/verify-consolidacao.js — a tabela BATE com o que o código produz hoje?
 * Read-only. NÃO grava nada.
 *
 * POR QUE EXISTE (31/07/2026): depois de um `backfill-consolidate --apply` é
 * preciso confirmar que o histórico ficou consistente. O jeito ERRADO — que eu
 * usei e que gerou um alarme falso — é comparar a tabela contra
 * `consolidateDay(D, {dryRun})`: essa é a régua de D, e quem grava o valor final
 * de D é o passe de **D+1** (consolidateDay apaga {D-1,D} e o passe seguinte
 * reescreve D vendo as sessões que só aparecem nos snapshots de D+1). A régua de
 * D subconta ~5%, então a comparação acusa uma divergência permanente que nunca
 * colapsa — foi exatamente essa confusão que produziu o P0-6, onde o auto-reparo
 * "corrigia" a tabela pra baixo e APAGAVA produção legítima.
 *
 * Aqui a verificação usa `detectDrift`, que já foi corrigido pra régua de D+1.
 * drift 0 (ou dentro do limiar) em todos os dias = histórico consolidado.
 *
 * USO (na VM):
 *   node scripts/verify-consolidacao.js 2026-07-01 2026-07-31
 *   node scripts/verify-consolidacao.js 2026-07-13            # 1 dia
 *
 * ⚠️ O ÚLTIMO dia de um backfill sempre aparece com drift negativo se nenhum
 * passe de D+1 rodou depois dele. Não é erro de dados — é o dia ainda não selado.
 */

require('dotenv').config();
const { detectDrift } = require('../services/dataWriter');
const { _getPool } = require('../services/pgShim');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function rangeDatas(de, ate) {
  const out = [];
  const d = new Date(de + 'T12:00:00Z'), fim = new Date(ate + 'T12:00:00Z');
  while (d <= fim) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

async function main() {
  const datas = process.argv.slice(2).filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  if (!datas.length) {
    console.error('✖ Uso: node scripts/verify-consolidacao.js <de> [<ate>]');
    process.exit(1);
  }
  const de = datas[0], ate = datas[1] || datas[0];
  const dias = rangeDatas(de, ate);

  console.log(`\n🔎 Verificação da consolidação · ${de} → ${ate} (${dias.length} dia(s))`);
  console.log(`   régua = passe de D+1 (detectDrift). Read-only.\n`);
  console.log('data'.padEnd(12) + 'tabela'.padStart(9) + 'régua'.padStart(9)
    + 'diff'.padStart(8) + 'limiar'.padStart(8) + '  status');
  console.log('-'.repeat(56));

  let comDrift = 0, erros = 0, somaAbs = 0;
  for (const dia of dias) {
    try {
      const r = await detectDrift(dia);
      if (r.has_drift) comDrift++;
      somaAbs += r.abs_diff;
      console.log(dia.padEnd(12) + String(r.table_count).padStart(9) + String(r.snapshot_count).padStart(9)
        + String(r.diff).padStart(8) + String(r.threshold).padStart(8)
        + '  ' + (r.has_drift ? '⚠️  DRIFT' : 'ok'));
      await sleep(200);   // gentil com o Postgres (VM 3.8GB, sem swap)
    } catch (err) {
      erros++;
      console.log(dia.padEnd(12) + `  ✖ ${err.message}`);
    }
  }

  console.log('-'.repeat(56));
  if (comDrift === 0 && !erros) {
    console.log(`✅ Nenhum dia com drift acima do limiar — histórico consolidado.`);
    console.log(`   Soma dos desvios absolutos: ${somaAbs} OS (ruído de dedup é normal).`);
  } else {
    console.log(`⚠️  ${comDrift} dia(s) com drift acima do limiar${erros ? ` · ${erros} erro(s)` : ''}.`);
    console.log(`   Se for o ÚLTIMO dia de um backfill, é só o dia não-selado (ver topo).`);
    console.log(`   Senão, re-consolide o dia: node scripts/backfill-consolidate.js <dia> <dia+1> --apply`);
  }
  console.log('');
}

main()
  .then(async () => { try { const p = _getPool(); if (p && p.end) await p.end(); } catch (_) {} process.exit(0); })
  .catch(async (e) => { console.error(e); try { const p = _getPool(); if (p && p.end) await p.end(); } catch (_) {} process.exit(1); });
