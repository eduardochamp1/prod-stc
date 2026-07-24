#!/usr/bin/env node
/**
 * scripts/diag-drift-team.js — Diagnóstico do drift residual POR EQUIPE.
 *
 * Read-only. Para um dia, compara EQUIPE A EQUIPE:
 *   - GRAVADO : sum(count) de team_daily_totals (o que o painel mostra hoje)
 *   - UNIÃO   : consolidateDay(date, {dryRun}) recalculado AGORA (mesma lógica
 *               P1-13 que gravou), recortado por r.date === date
 *
 * Motivação (23/07/2026): depois do fix do detectDrift (que passou a usar a
 * união, commit a4b2a00), o snapshot=união ficou PERTO da tabela, mas sobrou um
 * resíduo (tabela > união recalculada: -53..-172 em julho, sendo 07-22 o maior).
 * Hipótese: é o efeito do wipe de ±1 dia — o valor GRAVADO de um dia foi escrito
 * pela consolidação do dia SEGUINTE (dia como date-1, janela deslocada), enquanto
 * o dryRun recalcula o dia como CENTRO (janela D-1,D,D+1). Bordas diferentes →
 * atribuição diferente de notas vira-noite/spillover.
 *
 * Este script mostra ONDE está o gap: se vem de poucas equipes (vira-noite →
 * benigno) ou espalhado (over-count real → investigar). NÃO grava nada.
 *
 * USO (na VM):
 *   node scripts/diag-drift-team.js 2026-07-22
 *   node scripts/diag-drift-team.js 2026-07-22 --all   # mostra todas, não só as com gap
 */

require('dotenv').config();
const { consolidateDay } = require('../services/dataWriter');
const { getClient } = require('../services/dbClient');
const { _getPool } = require('../services/pgShim');

function parseArgs(argv) {
  const date = argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const all = argv.includes('--all');
  return { date, all };
}

/** Agrega {team_name -> count} a partir de linhas {team_name, tipo_code, count}. */
function aggByTeam(rows) {
  const m = new Map();
  for (const r of rows) {
    m.set(r.team_name, (m.get(r.team_name) || 0) + (Number(r.count) || 0));
  }
  return m;
}

async function main() {
  const { date, all } = parseArgs(process.argv.slice(2));
  if (!date) {
    console.error('✖ informe uma data YYYY-MM-DD. Ex.: node scripts/diag-drift-team.js 2026-07-22');
    process.exit(1);
  }

  // GRAVADO: team_daily_totals do dia
  const sb = getClient();
  const { data: stored, error } = await sb
    .from('team_daily_totals')
    .select('team_name, tipo_code, count')
    .eq('date', date);
  if (error) throw error;
  const gravado = aggByTeam(stored || []);

  // UNIÃO: dryRun recalculado agora, recortado por r.date === date
  const dry = await consolidateDay(date, { dryRun: true });
  const uniRows = (dry?.rows || []).filter(r => r.date === date);
  const uniao = aggByTeam(uniRows);

  // Universo de equipes dos dois lados
  const teams = new Set([...gravado.keys(), ...uniao.keys()]);
  const linhas = [];
  for (const t of teams) {
    const g = gravado.get(t) || 0;
    const u = uniao.get(t) || 0;
    const diff = g - u;                 // >0: tabela tem MAIS que a união recalculada
    if (diff !== 0 || all) linhas.push({ team: t, gravado: g, uniao: u, diff });
  }
  linhas.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || a.team.localeCompare(b.team));

  const somaG = [...gravado.values()].reduce((s, v) => s + v, 0);
  const somaU = [...uniao.values()].reduce((s, v) => s + v, 0);

  console.log(`\n📊 Drift por equipe — ${date}`);
  console.log(`   GRAVADO (team_daily_totals) = ${somaG}`);
  console.log(`   UNIÃO   (dryRun recalc)     = ${somaU}`);
  console.log(`   diff (gravado - união)      = ${somaG - somaU}\n`);

  console.log('equipe'.padEnd(16), 'gravado'.padStart(8), 'uniao'.padStart(8), 'diff'.padStart(8));
  console.log('-'.repeat(44));
  for (const l of linhas) {
    const flag = l.diff !== 0 ? (l.diff < 0 ? ' ⬇' : ' ⬆') : '';
    console.log(l.team.padEnd(16), String(l.gravado).padStart(8), String(l.uniao).padStart(8),
      String(l.diff).padStart(8) + flag);
  }
  console.log('-'.repeat(44));
  const comGap = linhas.filter(l => l.diff !== 0);
  const posit = comGap.filter(l => l.diff > 0).reduce((s, l) => s + l.diff, 0);
  const negat = comGap.filter(l => l.diff < 0).reduce((s, l) => s + l.diff, 0);
  console.log(`\n${comGap.length} equipe(s) com gap · soma +${posit} / ${negat} (líquido ${posit + negat}).`);
  console.log(comGap.length <= 6
    ? '→ Gap concentrado em poucas equipes: provável vira-noite/borda (benigno). Cheque essas no portal.'
    : '→ Gap espalhado por muitas equipes: pode ser over-count sistêmico. Investigar a fundo.');
  console.log('');
}

main()
  .then(async () => { try { const p = _getPool && _getPool(); if (p && p.end) await p.end(); } catch (_) {} process.exit(0); })
  .catch(async (e) => { console.error(e); try { const p = _getPool && _getPool(); if (p && p.end) await p.end(); } catch (_) {} process.exit(1); });
