/**
 * scripts/reconsolidar-produtividade.js
 *
 * Re-consolida team_daily_totals / team_daily_subcat_totals aplicando a regra
 * rejeitada > concluída (decisão 20/07/2026 — ver commit da correção e
 * docs/handoff/BACKLOG.md). Notas concluídas pela equipe mas rejeitadas pela EDP
 * deixam de contar como produção. Corrige dias JÁ gravados antes do fix.
 *
 * ⚠️ SINGLE-PROCESS SEQUENCIAL. NUNCA rode N cópias em paralelo — a lição do
 * incidente de 09/07/2026 é que 60 processos node concorrentes derrubaram o
 * Postgres por OOM (VM 3.8GB sem swap). Este script processa 1 dia por vez,
 * com pausa entre eles.
 *
 * USO (na VM):
 *   # DRY-RUN (padrão) — só mede antes/depois, NÃO grava:
 *   node scripts/reconsolidar-produtividade.js 2026-07-19
 *   node scripts/reconsolidar-produtividade.js 2026-07-01 2026-07-19
 *
 *   # APLICAR de verdade (re-consolida = wipe + reagrega o dia):
 *   node scripts/reconsolidar-produtividade.js 2026-07-01 2026-07-19 --apply
 *
 * Cada linha mostra: data, produção ANTES (na tabela), DEPOIS (regra nova) e a
 * diferença. Diferença negativa = notas rejeitadas que estavam infladas como
 * executadas e saíram.
 */

require('dotenv').config();
const { consolidateDay } = require('../services/dataWriter');
const { getClient } = require('../services/dbClient');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Soma atual de produtividade (count) gravada em team_daily_totals para o dia.
async function currentCount(date) {
  const sb = getClient();
  const { data, error } = await sb
    .from('team_daily_totals')
    .select('count')
    .eq('date', date);
  if (error) throw error;
  return (data || []).reduce((s, r) => s + (Number(r.count) || 0), 0);
}

// Gera lista de datas YYYY-MM-DD de `de` até `ate` (inclusive), ordem crescente.
function rangeDatas(de, ate) {
  const out = [];
  const d = new Date(de + 'T12:00:00Z');
  const fim = new Date(ate + 'T12:00:00Z');
  while (d <= fim) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const datasArg = argv.filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));

  if (datasArg.length === 0) {
    console.error('Uso: node scripts/reconsolidar-produtividade.js <data> [<data-fim>] [--apply]');
    process.exit(1);
  }
  const de  = datasArg[0];
  const ate = datasArg[1] || datasArg[0];
  const datas = rangeDatas(de, ate);

  console.log(`\n${apply ? '⚙️  APLICANDO' : '🔍 DRY-RUN (não grava)'} — ${datas.length} dia(s): ${de} → ${ate}\n`);
  console.log('data'.padEnd(12), 'antes'.padStart(8), 'depois'.padStart(8), 'diff'.padStart(8), 'equipes'.padStart(8));
  console.log('-'.repeat(50));

  let totAntes = 0, totDepois = 0;
  for (const date of datas) {
    try {
      const antes = await currentCount(date);
      // dryRun calcula o "depois" sem gravar (mesma lógica do apply).
      // IMPORTANTE: consolidateDay processa sessões de D e D-1 e gera linhas pra
      // VÁRIOS notaDate (D-2..D). Pra comparar maçã com maçã, o "depois" é só a
      // soma das linhas cuja data === D (mesmo recorte que o `antes`). Somar
      // dry.newCount (todas as datas) daria um total inflado e enganoso.
      const dry = await consolidateDay(date, { dryRun: true });
      const depois = dry ? (dry.rows || [])
        .filter(r => r.date === date)
        .reduce((s, r) => s + r.count, 0) : 0;
      const equipes = dry ? dry.teams : 0;
      const diff = depois - antes;
      totAntes += antes; totDepois += depois;
      const flag = diff !== 0 ? (diff < 0 ? ' ⬇' : ' ⬆') : '';
      console.log(
        date.padEnd(12),
        String(antes).padStart(8),
        String(depois).padStart(8),
        String(diff).padStart(8) + flag,
        String(equipes).padStart(8)
      );

      if (apply) {
        await consolidateDay(date);          // grava de verdade (wipe + reagrega)
        await sleep(400);                    // gentil com o Postgres (single-process)
      }
    } catch (err) {
      console.error(`  ✖ ${date}: ${err.message}`);
    }
  }

  console.log('-'.repeat(50));
  console.log('TOTAL'.padEnd(12), String(totAntes).padStart(8), String(totDepois).padStart(8),
    String(totDepois - totAntes).padStart(8));
  console.log(`\n${apply ? '✅ Aplicado.' : 'ℹ️  Dry-run. Rode com --apply pra gravar.'}\n`);

  // Encerra o pool pra o processo não ficar pendurado.
  try {
    const { _getPool } = require('../services/pgShim');
    const pool = _getPool && _getPool();
    if (pool && pool.end) await pool.end();
  } catch (_) { /* ignore */ }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
