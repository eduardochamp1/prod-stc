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
 * resíduo (tabela > união recalculada: +53 no 07-13, espalhado em 21 equipes).
 *
 * HIPÓTESE (a testar aqui): assimetria de janela. `consolidateDay(D)` só monta
 * equipes com sessão em {D-1, D} (_unionTeamsFromSnapshots), MAS wipa e regrava
 * {D-1, D}. Logo o valor GRAVADO de um dia D foi escrito pelo passe de **D+1**,
 * cuja janela inclui sessões de D+1 — e uma nota concluída em D porém transmitida
 * só numa sessão de D+1 (equipe que relogou de manhã) entra ali. O passe centrado
 * em D não vê essas sessões → recalcula MENOS. Se for isso, o GRAVADO é o valor
 * MAIS COMPLETO e é o dryRun(D) que subconta.
 *
 * Por isso o script mostra TRÊS colunas por equipe:
 *   gravado   : team_daily_totals (o que o painel mostra hoje)
 *   uniao_D   : consolidateDay(D,   {dryRun}) filtrado por r.date === D  ← régua do detectDrift
 *   uniao_D+1 : consolidateDay(D+1, {dryRun}) filtrado por r.date === D  ← régua do write-path
 * Se `uniao_D+1` ≈ `gravado` > `uniao_D`, a hipótese está CONFIRMADA e o
 * detectDrift/auto-reparo está estreito demais (derruba produção legítima).
 *
 * NÃO grava nada.
 *
 * USO (na VM):
 *   node scripts/diag-drift-team.js 2026-07-13
 *   node scripts/diag-drift-team.js 2026-07-13 --all   # mostra todas, não só as com gap
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

  // UNIÃO_D: dryRun centrado em D (régua do detectDrift / do auto-reparo)
  const dryD = await consolidateDay(date, { dryRun: true });
  const uniaoD = aggByTeam((dryD?.rows || []).filter(r => r.date === date));

  // UNIÃO_D+1: dryRun centrado em D+1, recortado pelas linhas de notaDate === D.
  // É a régua do WRITE-PATH: foi o passe de D+1 que gravou D por último (ele wipa
  // D-1 e D). A janela dele inclui sessões de D+1, que carregam notas concluídas
  // em D e transmitidas só na manhã seguinte.
  const dNext = new Date(date + 'T12:00:00Z');
  dNext.setUTCDate(dNext.getUTCDate() + 1);
  const dayPlus1 = dNext.toISOString().slice(0, 10);
  const dryN = await consolidateDay(dayPlus1, { dryRun: true });
  const uniaoN = aggByTeam((dryN?.rows || []).filter(r => r.date === date));

  // Universo de equipes dos três lados
  const teams = new Set([...gravado.keys(), ...uniaoD.keys(), ...uniaoN.keys()]);
  const linhas = [];
  for (const t of teams) {
    const g = gravado.get(t) || 0;
    const uD = uniaoD.get(t) || 0;
    const uN = uniaoN.get(t) || 0;
    const diff = g - uD;                // >0: tabela tem MAIS que a régua do detectDrift
    if (diff !== 0 || all) linhas.push({ team: t, gravado: g, uniaoD: uD, uniaoN: uN, diff });
  }
  linhas.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || a.team.localeCompare(b.team));

  const soma = (m) => [...m.values()].reduce((s, v) => s + v, 0);
  const somaG = soma(gravado), somaD = soma(uniaoD), somaN = soma(uniaoN);

  console.log(`\n📊 Drift por equipe — ${date}`);
  console.log(`   GRAVADO   (team_daily_totals)      = ${somaG}`);
  console.log(`   UNIÃO_D   (dryRun ${date})   = ${somaD}   ← régua do detectDrift/auto-reparo`);
  console.log(`   UNIÃO_D+1 (dryRun ${dayPlus1})   = ${somaN}   ← régua do write-path (quem gravou)`);
  console.log(`   diff (gravado - UNIÃO_D)           = ${somaG - somaD}\n`);

  console.log('equipe'.padEnd(16), 'gravado'.padStart(8), 'uniao_D'.padStart(8),
    'uni_D+1'.padStart(8), 'diff'.padStart(8));
  console.log('-'.repeat(54));
  for (const l of linhas) {
    const flag = l.diff !== 0 ? (l.diff < 0 ? ' ⬇' : ' ⬆') : '';
    console.log(l.team.padEnd(16), String(l.gravado).padStart(8), String(l.uniaoD).padStart(8),
      String(l.uniaoN).padStart(8), String(l.diff).padStart(8) + flag);
  }
  console.log('-'.repeat(54));
  const comGap = linhas.filter(l => l.diff !== 0);
  const posit = comGap.filter(l => l.diff > 0).reduce((s, l) => s + l.diff, 0);
  const negat = comGap.filter(l => l.diff < 0).reduce((s, l) => s + l.diff, 0);
  console.log(`\n${comGap.length} equipe(s) com gap · soma +${posit} / ${negat} (líquido ${posit + negat}).`);

  // VEREDITO da hipótese de assimetria de janela.
  const gapD = somaG - somaD;
  const gapN = somaG - somaN;
  if (gapD !== 0 && Math.abs(gapN) <= Math.max(2, Math.round(Math.abs(gapD) * 0.2))) {
    console.log('→ HIPÓTESE CONFIRMADA: UNIÃO_D+1 ≈ GRAVADO > UNIÃO_D.');
    console.log('  O gravado é o valor MAIS COMPLETO (inclui notas de D transmitidas em sessão de D+1).');
    console.log('  A régua do detectDrift (centrada em D) subconta → auto-reparo DERRUBA produção legítima.');
  } else if (gapD !== 0) {
    console.log(`→ HIPÓTESE NÃO EXPLICA TUDO: gravado-UNIÃO_D=${gapD}, gravado-UNIÃO_D+1=${gapN}.`);
    console.log('  Sobra resíduo além da assimetria de janela — investigar (dupla gravação? wipe parcial?).');
  } else {
    console.log('→ Sem gap: tabela == régua do detectDrift (dia provavelmente já auto-reparado).');
  }
  console.log('');
}

main()
  .then(async () => { try { const p = _getPool && _getPool(); if (p && p.end) await p.end(); } catch (_) {} process.exit(0); })
  .catch(async (e) => { console.error(e); try { const p = _getPool && _getPool(); if (p && p.end) await p.end(); } catch (_) {} process.exit(1); });
