#!/usr/bin/env node
/**
 * scripts/diag-concluidas-gap.js
 * Diagnóstico READ-ONLY da folga entre os dois "concluídas do dia":
 *   - A) agregação (team_daily_totals / team_daily_subcat_totals) = o "OS Executadas"
 *        do card. Atribui por _notaDate (exclui conclusão de dia anterior) e conta
 *        POR EQUIPE.
 *   - B) _buildDiaSummary = usado no fluxo/canceladas. Conta concluídas do ÚLTIMO
 *        retrato do dia, DEDUPLICADO por UUID global, sem excluir carry-over.
 *
 * Quebra a diferença B−A em componentes pra sabermos o que é corrigível
 * (carry-over de dia anterior) e o que é legítimo (dedup por equipe).
 *
 * Uso (VM): node scripts/diag-concluidas-gap.js [YYYY-MM-DD]
 *   sem data → hoje BRT.
 */

require('dotenv').config({ override: true });
const { dateBRT } = require('../services/timeUtil');

let pool;
try { pool = require('../services/pgShim')._getPool(); }
catch (err) { console.error('\n[gap] sem pool:', err.message, '\n'); process.exit(1); }

const arg = process.argv[2];
const DIA = /^\d{4}-\d{2}-\d{2}$/.test(arg || '') ? arg : dateBRT();

// Espelha a EXCEÇÃO de _notaDate: só conclusionDate ISO (YYYY-MM-DD...) e < dia
// é atribuída a dia anterior. BR (DD/MM/YYYY) cai no dia da sessão (= hoje).
function isPriorDayISO(cd) {
  if (!cd) return false;
  const s = String(cd);
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return false;
  return s.slice(0, 10) < DIA;
}

// Espelha _sessionDate / _notaDate de services/dataWriter.js (entrada do consolidateDay).
function shiftDay(iso, delta) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
function sessionDateOf(data) {
  const sb = data && data.sessionBegin ? String(data.sessionBegin) : '';
  return /^\d{4}-\d{2}-\d{2}/.test(sb) ? sb.slice(0, 10) : null;
}
function notaDateOf(n, sessDate) {
  if (!n.conclusionDate) return sessDate;
  const cd = String(n.conclusionDate).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}/.test(cd)) return sessDate;
  return cd < sessDate ? cd : sessDate;
}

async function main() {
  console.log(`\n${'═'.repeat(64)}\n  FOLGA DE CONCLUÍDAS — ${DIA} (BRT)\n${'═'.repeat(64)}`);

  // A) agregações (fontes do card "OS Executadas")
  const [aTipo, aSub] = await Promise.all([
    pool.query(`SELECT COALESCE(sum(count),0)::int AS n FROM team_daily_totals WHERE date=$1`, [DIA]),
    pool.query(`SELECT COALESCE(sum(count),0)::int AS n FROM team_daily_subcat_totals WHERE date=$1`, [DIA]),
  ]);
  const A_tipo = aTipo.rows[0].n;
  const A_sub  = aSub.rows[0].n;

  // B) último snapshot por equipe → notasConcluidas
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (team_name) team_name, data->'notasConcluidas' AS conc
     FROM snapshots WHERE date=$1 ORDER BY team_name, captured_at DESC`, [DIA]);

  const seen = new Set();          // UUIDs distintos (dedup global = base do summary)
  let bRows = 0;                   // contagem por equipe (com dups entre equipes)
  let carryRows = 0;               // linhas com conclusão de dia anterior (ISO)
  const carryIds = new Set();
  let noTipoRows = 0;              // linhas sem tipoCode (agregação ignora)
  let effRows = 0;                 // linhas que a agregação CONTARIA (tipo + não-carry)

  for (const r of rows) {
    const arr = Array.isArray(r.conc) ? r.conc : [];
    for (const n of arr) {
      if (!n || !n.id) continue;
      bRows++;
      seen.add(n.id);
      const tipo  = n.tipoCode || n.tipo_code;
      const carry = isPriorDayISO(n.conclusionDate);
      if (carry) { carryRows++; carryIds.add(n.id); }
      if (!tipo) noTipoRows++;
      if (tipo && !carry) effRows++;
    }
  }
  const bDedup = seen.size;
  const crossTeamDups = bRows - bDedup;

  console.log(`\n  Card "OS Executadas":`);
  console.log(`    team_daily_subcat (1169 esperado) ......... ${A_sub}`);
  console.log(`    team_daily_totals ......................... ${A_tipo}${A_tipo !== A_sub ? '  ⚠️ difere do subcat!' : ''}`);
  console.log(`\n  _buildDiaSummary (fluxo/canceladas):`);
  console.log(`    concluídas distintas (UUID, dedup global) . ${bDedup}   ← o "1184"`);
  console.log(`    linhas por equipe (com dups) .............. ${bRows}`);
  console.log(`\n  Composição da folga (B_dedup ${bDedup}  vs  A_sub ${A_sub}):`);
  console.log(`    carry-over (conclusão de dia anterior) .... ${carryRows} linhas / ${carryIds.size} UUIDs`);
  console.log(`       → summary CONTA em hoje, agregação JOGA no dia anterior (agg mais correta)`);
  console.log(`    sem tipoCode (agregação ignora) ........... ${noTipoRows} linhas`);
  console.log(`    duplicatas entre equipes (dedup global) ... ${crossTeamDups} linhas`);
  console.log(`       → mesma nota em 2+ equipes; agg conta por equipe, summary dedup`);
  console.log(`\n  Sanity: linhas que a agregação contaria (tipo & não-carry) = ${effRows}`);
  console.log(`          (deveria bater ~com A_sub ${A_sub}; diferença = dups entre equipes / timing)\n`);

  // ── Por que team_daily_totals != team_daily_subcat? ───────────────────────
  // Replica a entrada do consolidateDay (snapshots de [DIA-1, DIA, DIA+1],
  // último por (team, sessionBegin) com _sessionDate in {DIA, DIA-1}) e conta
  // as concluídas atribuídas a DIA via _notaDate. Mede duplicatas (equipe,tipo,id)
  // — que totals conta e subcat dedup — e notas SEM id (subcat ignora).
  const dM1 = shiftDay(DIA, -1), dP1 = shiftDay(DIA, +1);
  const snapAll = await pool.query(
    `SELECT team_name, data FROM snapshots
     WHERE date = ANY($1::date[]) ORDER BY captured_at DESC`, [[dM1, DIA, dP1]]);
  const latest = new Map();
  for (const r of snapAll.rows) {
    const data = r.data; if (!data) continue;
    const sd = sessionDateOf(data);
    if (sd !== DIA && sd !== dM1) continue;
    const key = `${r.team_name}|${data.sessionBegin}`;
    if (!latest.has(key)) latest.set(key, { team: r.team_name, sd, data });
  }
  let entriesTipo = 0, noId = 0, dupPairs = 0;
  const pairSeen = new Set();
  for (const { team, sd, data } of latest.values()) {
    const conc = Array.isArray(data.notasConcluidas) ? data.notasConcluidas : [];
    for (const n of conc) {
      if (notaDateOf(n, sd) !== DIA) continue;
      const tipo = n.tipoCode || n.tipo_code;
      if (!tipo) continue;
      entriesTipo++;
      if (!n.id) { noId++; continue; }
      const k = `${team}|${tipo}|${n.id}`;
      if (pairSeen.has(k)) dupPairs++; else pairSeen.add(k);
    }
  }
  console.log(`  Por que totals(${A_tipo}) vs subcat(${A_sub}) — entrada do consolidateDay:`);
  console.log(`    entradas concluídas c/ tipo atribuídas a ${DIA} .. ${entriesTipo}  (~team_daily_totals)`);
  console.log(`    distintas por (equipe,tipo,id) ................... ${pairSeen.size}  (~team_daily_subcat)`);
  console.log(`    duplicatas (equipe,tipo,id) ..................... ${dupPairs}  ← totals conta, subcat dedup`);
  console.log(`    sem id (subcat ignora, totals conta) ............ ${noId}`);
  console.log(`    ➤ se dups>>sem-id: subcat (card) é o correto, totals infla → corrigir upsertTeamDailyTotals.`);
  console.log(`    ➤ se sem-id>>dups: totals é o correto, subcat (card) subnotifica.\n`);

  if (carryIds.size > 0)
    console.log(`  ➤ Corrigível: excluir os ${carryIds.size} UUIDs carry-over do "concluídas" e do "inicial" do summary alinha com a agregação e mantém a invariante.`);
  if (crossTeamDups > 0)
    console.log(`  ➤ Legítimo: ${crossTeamDups} dups entre equipes — o fluxo DEVE deduplicar; o card conta por equipe. Essa parte não "fecha na unidade" por design.`);
  console.log('');
}

main()
  .catch(e => { console.error('[gap] erro:', e.message); process.exitCode = 1; })
  .finally(async () => { try { await pool.end(); } catch (_) {} });
