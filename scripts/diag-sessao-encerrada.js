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
 *   node scripts/diag-sessao-encerrada.js --dias 14 --excluir 2026-10-16,2026-10-17,2026-10-18   (sem o P0-10)
 *
 * 1ª rodada na VM (19/10/2026, 14 dias, versão 1): 1845 encerradas, 735
 * "mudaram" (39,8%), máximo +1395 min. Número inflado por falha de coleta lida
 * como mudança — ver o comentário de `analisar`. Por isso a versão 2.
 */

'use strict';

require('dotenv').config({ override: true });

const FAIXAS_MIN = [15, 30, 45, 60, 90, 120, 180, 240];

// ─────────────────────────────────────────────────────────────────────────────
// FUNÇÃO PURA (exportada pra teste)
// ─────────────────────────────────────────────────────────────────────────────

const _ids = (s) => new Set(String(s || '').split(',').filter(Boolean));
const _igual = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
const _menos = (a, b) => [...a].filter(x => !b.has(x)).length;

/**
 * 19/10/2026 — 2ª versão. A 1ª media "a última vez que a assinatura mudou" e deu
 * 39,8% das sessões mudando até 23h depois de encerradas, porque FALHA de coleta
 * parece mudança: o `_safeNotes` devolve bucket vazio em timeout, e a sessão ia
 * de "3 notas" → vazio → "3 notas". Os 14 dias também pegavam o P0-10 (16–18/10,
 * EDP devolvendo vazio para tudo). Agora:
 *   - linha com executadas E rejeitadas vazias, depois de a sessão já ter tido
 *     nota, é FALHA (transitória se volta, "esvaziou no fim" se não volta) — fica
 *     fora da comparação;
 *   - a régua é o valor FINAL (última linha válida): o risco do congelamento é
 *     o valor congelado ≠ o final. O atraso medido é quando a sessão chegou no
 *     valor final e não saiu mais;
 *   - e diz O QUE mudou (ganhou/perdeu executada, ganhou/perdeu rejeitada), que
 *     é o que decide se a mudança é produção.
 *
 * @param {Array<{captured_at, sid, team_name, sector_id, session_end, exec, rej}>} rows
 *        `exec`/`rej` = ids separados por vírgula.
 */
function analisar(rows) {
  const porSessao = new Map();
  for (const r of rows) {
    if (!r.sid) continue;
    let s = porSessao.get(r.sid);
    if (!s) { s = []; porSessao.set(r.sid, s); }
    s.push(r);
  }

  let encerradas = 0, mudaram = 0, reabertas = 0, comFalhaTransitoria = 0, esvaziaramNoFim = 0;
  const tipos = { ganhouExec: 0, perdeuExec: 0, ganhouRej: 0, perdeuRej: 0 };
  const atrasosMin = [];
  const exemplos = [];

  for (const [sid, linhas] of porSessao) {
    linhas.sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at));
    const i0 = linhas.findIndex(l => l.session_end);
    if (i0 < 0) continue;
    encerradas++;

    // Sequência encerrada (para no 1º ciclo em que reabre).
    let seq = [];
    for (const l of linhas.slice(i0)) {
      if (!l.session_end) { reabertas++; break; }
      const exec = _ids(l.exec), rej = _ids(l.rej);
      seq.push({ t: new Date(l.captured_at).getTime(), exec, rej, vazia: exec.size === 0 && rej.size === 0 });
    }
    // Falha: vazia depois de já ter tido nota.
    const teveNota = seq.findIndex(x => !x.vazia);
    if (teveNota >= 0) {
      const ultimaCheia = seq.length - 1 - [...seq].reverse().findIndex(x => !x.vazia);
      const transit = seq.some((x, i) => x.vazia && i > teveNota && i < ultimaCheia);
      if (transit) comFalhaTransitoria++;
      if (ultimaCheia < seq.length - 1) esvaziaramNoFim++;
      seq = seq.filter((x, i) => !(x.vazia && i > teveNota));
    }
    if (seq.length === 0) continue;

    const t0 = seq[0].t;
    const fim = seq[seq.length - 1];
    let k = seq.length - 1;
    while (k > 0 && _igual(seq[k - 1].exec, fim.exec) && _igual(seq[k - 1].rej, fim.rej)) k--;
    const atraso = (seq[k].t - t0) / 60_000;
    if (atraso <= 0) continue;

    mudaram++;
    atrasosMin.push(atraso);
    const d = {
      ganhouExec: _menos(fim.exec, seq[0].exec), perdeuExec: _menos(seq[0].exec, fim.exec),
      ganhouRej:  _menos(fim.rej,  seq[0].rej),  perdeuRej:  _menos(seq[0].rej,  fim.rej),
    };
    for (const kTipo of Object.keys(tipos)) if (d[kTipo] > 0) tipos[kTipo]++;
    exemplos.push({ sid, equipe: linhas[i0].team_name, setor: linhas[i0].sector_id,
      vistaEncerrada: linhas[i0].captured_at, atrasoMin: Math.round(atraso), ...d });
  }
  exemplos.sort((a, b) => b.atrasoMin - a.atrasoMin);
  return { sessoes: porSessao.size, encerradas, mudaram, reabertas, comFalhaTransitoria,
           esvaziaramNoFim, tipos, atrasosMin, exemplos };
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
  const argStr = (k) => { const i = args.indexOf(k); return i >= 0 ? String(args[i + 1] || '') : ''; };
  const dias = arg('--dias', 7);
  const nEx = arg('--exemplos', 15);
  // Dias (data BRT do snapshot) fora da conta — ex.: o incidente P0-10 de 16–18/10.
  const excluir = new Set(argStr('--excluir').split(',').map(s => s.trim()).filter(Boolean));

  let pool;
  try {
    pool = require('../services/pgShim')._getPool();
  } catch (err) {
    console.error('\n[diag-sessao-encerrada] Não consegui abrir o pool Postgres:', err.message);
    process.exit(1);
  }

  const ate = new Date();
  const de = new Date(ate.getTime() - dias * 86400_000);
  // Os ids saem prontos do banco, sem trazer o jsonb inteiro.
  const ids = (campo) => `coalesce((SELECT string_agg(coalesce(n->>'id', n->>'codigo'), ',' ORDER BY coalesce(n->>'id', n->>'codigo'))
                        FROM jsonb_array_elements(coalesce(s.data->'${campo}', '[]'::jsonb)) n), '')`;
  const { rows: brutas } = await pool.query(
    `SELECT s.captured_at, s.team_name, s.sector_id, s.session_end,
            s.data->>'id' AS sid,
            ${ids('notasExecutadas')} AS exec,
            ${ids('notasRejeitadas')} AS rej
       FROM snapshots s
      WHERE s.captured_at >= $1 AND s.captured_at < $2
      ORDER BY s.captured_at`, [de.toISOString(), ate.toISOString()]);
  const { dateBRT } = require('../services/timeUtil');
  const rows = excluir.size ? brutas.filter(r => !excluir.has(dateBRT(new Date(r.captured_at)))) : brutas;

  const r = analisar(rows);
  const pct = (n, d) => d ? `${(100 * n / d).toFixed(1)}%` : '—';

  console.log(`\nSessões encerradas × notas depois de encerradas — últimos ${dias} dias (${rows.length} linhas de snapshot` +
    (excluir.size ? `, sem ${[...excluir].join(', ')}` : '') + ')\n');
  console.log(`  sessões vistas:                     ${r.sessoes}`);
  console.log(`  encerradas:                         ${r.encerradas}`);
  console.log(`  com falha transitória (vazio no meio, ignorado): ${r.comFalhaTransitoria}`);
  console.log(`  esvaziaram no fim (falha, ignorado): ${r.esvaziaramNoFim}`);
  console.log(`  reabertas depois de encerrar:       ${r.reabertas}`);
  console.log(`  ➜ MUDARAM DE VERDADE depois de encerradas: ${r.mudaram} (${pct(r.mudaram, r.encerradas)})`);
  if (r.mudaram > 0) {
    console.log('\n  o que mudou (sessões; uma pode ter mais de um tipo):');
    console.log(`    ganhou executada:  ${r.tipos.ganhouExec}`);
    console.log(`    perdeu executada:  ${r.tipos.perdeuExec}`);
    console.log(`    ganhou rejeitada:  ${r.tipos.ganhouRej}`);
    console.log(`    perdeu rejeitada:  ${r.tipos.perdeuRej}`);
    console.log('\n  quando chegou no valor FINAL do dia, contado do 1º ciclo encerrado:');
    for (const f of FAIXAS_MIN) {
      const n = r.atrasosMin.filter(a => a <= f).length;
      console.log(`    ≤ ${String(f).padStart(3)} min: ${String(n).padStart(4)}  (${pct(n, r.mudaram)})`);
    }
    console.log(`    máximo:     ${Math.round(Math.max(...r.atrasosMin))} min`);
    console.log(`\n  ➜ janela que cobre 100% do visto: ${janelaQueCobre(r.atrasosMin)} min (some uma folga antes de usar)`);
    console.log(`\n  maiores atrasos (+exec/-exec/+rej/-rej):`);
    for (const e of r.exemplos.slice(0, nEx)) {
      console.log(`    ${e.setor} ${String(e.equipe).padEnd(14)} vista encerrada ${new Date(e.vistaEncerrada).toISOString()}  +${e.atrasoMin} min` +
        `  [+${e.ganhouExec}/-${e.perdeuExec}/+${e.ganhouRej}/-${e.perdeuRej}]  (${e.sid})`);
    }
  } else {
    console.log('\n  ➜ nenhuma sessão mudou de verdade depois de encerrada no período.');
  }
  console.log('');
  await pool.end?.();
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { analisar, janelaQueCobre, FAIXAS_MIN };
