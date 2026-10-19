#!/usr/bin/env node
/**
 * scripts/diag-sessao-encerrada.js
 *
 * ⚠️ ESTRITAMENTE READ-ONLY. Só SELECT em `snapshots`. Não escreve nada e não
 * chama a API da EDP (a conta é compartilhada — P1-25).
 *
 * ── A PERGUNTA (19/10/2026, backlog P0-11 item 3b) ──────────────────────────
 * Toda sessão encerrada do dia é rebuscada na EDP a cada ciclo até 23h45. Para
 * parar de rebuscar sem perder nota, o congelamento (WPA_ENCERRADA_CONGELA_MIN,
 * services/coletaIncremental.js) espera uma JANELA depois que o coletor viu a
 * sessão encerrada. Qual janela? Este script mede no histórico: para cada
 * sessão, o 1º snapshot em que ela aparece encerrada (o "visto encerrada" — o
 * mesmo relógio do congelamento, NÃO o EndTime da EDP, cujo fuso é ambíguo), e
 * se as notas executadas/rejeitadas dela mudaram em algum snapshot DEPOIS disso,
 * e quanto tempo depois.
 *
 * Os snapshots são retidos para sempre (decisão de 07/07/2026), então a
 * validação não custa uma requisição sequer.
 *
 * Como ler a saída:
 *   - "mudou depois de encerrada": quantas sessões tiveram nota nova/alterada
 *     depois do 1º ciclo encerrado, e a distribuição do atraso;
 *   - "janela que cobre 100%": o menor atraso que cobre TODAS as mudanças vistas
 *     — o mínimo aceitável para WPA_ENCERRADA_CONGELA_MIN. Some uma folga.
 *   - reaberta: a sessão voltou a aparecer aberta depois de encerrada; o
 *     congelamento já trata (a janela recomeça), mas fica listado.
 *
 * Uso (na VM):
 *   cd ~/prod-stc && node scripts/diag-sessao-encerrada.js            (7 dias)
 *   node scripts/diag-sessao-encerrada.js --dias 14
 *   node scripts/diag-sessao-encerrada.js --dias 14 --exemplos 30
 */

'use strict';

require('dotenv').config({ override: true });

const FAIXAS_MIN = [15, 30, 45, 60, 90, 120, 180, 240];

// ─────────────────────────────────────────────────────────────────────────────
// FUNÇÃO PURA (exportada pra teste)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Array<{captured_at, sid, team_name, sector_id, session_end, assinatura}>} rows
 *        em ordem de captured_at. `assinatura` = ids das executadas + rejeitadas.
 * @returns {{sessoes, encerradas, mudaram, reabertas, atrasosMin:number[], exemplos:object[]}}
 */
function analisar(rows) {
  const porSessao = new Map();
  for (const r of rows) {
    if (!r.sid) continue;
    let s = porSessao.get(r.sid);
    if (!s) { s = []; porSessao.set(r.sid, s); }
    s.push(r);
  }

  let encerradas = 0, mudaram = 0, reabertas = 0;
  const atrasosMin = [];
  const exemplos = [];

  for (const [sid, linhas] of porSessao) {
    linhas.sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at));
    const i0 = linhas.findIndex(l => l.session_end);
    if (i0 < 0) continue;
    encerradas++;
    const t0 = new Date(linhas[i0].captured_at).getTime();
    const base = linhas[i0].assinatura || '';
    let ultimaMudancaMin = null;
    let anterior = base;
    let reabriu = false;
    for (const l of linhas.slice(i0 + 1)) {
      if (!l.session_end) { reabriu = true; break; }   // reabriu: a janela recomeça no congelamento
      const a = l.assinatura || '';
      if (a !== anterior) {
        ultimaMudancaMin = (new Date(l.captured_at).getTime() - t0) / 60_000;
        anterior = a;
      }
    }
    if (reabriu) reabertas++;
    if (ultimaMudancaMin !== null) {
      mudaram++;
      atrasosMin.push(ultimaMudancaMin);
      exemplos.push({ sid, equipe: linhas[i0].team_name, setor: linhas[i0].sector_id,
        vistaEncerrada: linhas[i0].captured_at, atrasoMin: Math.round(ultimaMudancaMin) });
    }
  }
  exemplos.sort((a, b) => b.atrasoMin - a.atrasoMin);
  return { sessoes: porSessao.size, encerradas, mudaram, reabertas, atrasosMin, exemplos };
}

/** Menor faixa que cobre todos os atrasos (ou o máximo arredondado para cima). */
function janelaQueCobre(atrasosMin) {
  if (atrasosMin.length === 0) return 0;
  const max = Math.max(...atrasosMin);
  return FAIXAS_MIN.find(f => f >= max) || Math.ceil(max / 30) * 30;
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d; };
  const dias = arg('--dias', 7);
  const nEx = arg('--exemplos', 15);

  let pool;
  try {
    pool = require('../services/pgShim')._getPool();
  } catch (err) {
    console.error('\n[diag-sessao-encerrada] Não consegui abrir o pool Postgres:', err.message);
    process.exit(1);
  }

  const ate = new Date();
  const de = new Date(ate.getTime() - dias * 86400_000);
  // A assinatura sai pronta do banco: só os ids, sem trazer o jsonb inteiro.
  const { rows } = await pool.query(
    `SELECT s.captured_at, s.team_name, s.sector_id, s.session_end,
            s.data->>'id' AS sid,
            coalesce((SELECT string_agg(coalesce(n->>'id', n->>'codigo'), ',' ORDER BY coalesce(n->>'id', n->>'codigo'))
                        FROM jsonb_array_elements(coalesce(s.data->'notasExecutadas', '[]'::jsonb)) n), '')
            || '#' ||
            coalesce((SELECT string_agg(coalesce(n->>'id', n->>'codigo'), ',' ORDER BY coalesce(n->>'id', n->>'codigo'))
                        FROM jsonb_array_elements(coalesce(s.data->'notasRejeitadas', '[]'::jsonb)) n), '')
            AS assinatura
       FROM snapshots s
      WHERE s.captured_at >= $1 AND s.captured_at < $2
      ORDER BY s.captured_at`, [de.toISOString(), ate.toISOString()]);

  const r = analisar(rows);
  const pct = (n, d) => d ? `${(100 * n / d).toFixed(1)}%` : '—';

  console.log(`\nSessões encerradas × notas depois de encerradas — últimos ${dias} dias (${rows.length} linhas de snapshot)\n`);
  console.log(`  sessões vistas:              ${r.sessoes}`);
  console.log(`  encerradas:                  ${r.encerradas}`);
  console.log(`  mudou depois de encerrada:   ${r.mudaram} (${pct(r.mudaram, r.encerradas)})`);
  console.log(`  reabertas depois de encerrar: ${r.reabertas}`);
  if (r.mudaram > 0) {
    console.log('\n  atraso da ÚLTIMA mudança, contado do 1º ciclo encerrado:');
    for (const f of FAIXAS_MIN) {
      const n = r.atrasosMin.filter(a => a <= f).length;
      console.log(`    ≤ ${String(f).padStart(3)} min: ${String(n).padStart(4)}  (${pct(n, r.mudaram)})`);
    }
    console.log(`    máximo:     ${Math.round(Math.max(...r.atrasosMin))} min`);
    console.log(`\n  ➜ janela que cobre 100% do visto: ${janelaQueCobre(r.atrasosMin)} min (some uma folga antes de usar)`);
    console.log(`\n  maiores atrasos:`);
    for (const e of r.exemplos.slice(0, nEx)) {
      console.log(`    ${e.setor} ${e.equipe.padEnd(14)} vista encerrada ${new Date(e.vistaEncerrada).toISOString()}  +${e.atrasoMin} min  (${e.sid})`);
    }
  } else {
    console.log('\n  ➜ nenhuma sessão mudou de notas depois de encerrada no período.');
  }
  console.log('');
  await pool.end?.();
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { analisar, janelaQueCobre, FAIXAS_MIN };
