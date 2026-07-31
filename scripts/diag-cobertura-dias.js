#!/usr/bin/env node
/**
 * scripts/diag-cobertura-dias.js — COBERTURA por dia: snapshot × consolidado.
 * Read-only.
 *
 * Para cada dia do período mostra:
 *   eq_snap  = equipes com SNAPSHOT no dia   (matéria-prima, retida pra sempre)
 *   eq_prod  = equipes em team_daily_totals  (produção consolidada)
 *   eq_sub   = equipes em team_daily_subcat_totals (subcategorias)
 *
 * Se eq_snap >> eq_prod/eq_sub, o dia tem BURACO no consolidado que a
 * re-consolidação (`scripts/backfill-consolidate.js <dia>`) pode recuperar —
 * porque a matéria-prima ainda está lá.
 *
 * Motivação (30/07/2026): conferência da planilha manual de L0 (01→25/07)
 * mostrou 08 e 09/07 com 8-9 equipes contra ~20 dos dias normais (09/07 é o dia
 * do incidente P0-0, OOM do Postgres), e nenhuma sexta-feira no mês. Este
 * script separa "buraco de dado" de "dia sem trabalho".
 *
 * USO (na VM):
 *   node scripts/diag-cobertura-dias.js 2026-07-01 2026-07-25
 */

require('dotenv').config();
const { _getPool } = require('../services/pgShim');

const DOW = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

async function main() {
  const datas = process.argv.slice(2).filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  if (!datas.length) {
    console.error('✖ Uso: node scripts/diag-cobertura-dias.js <de> [<ate>]');
    process.exit(1);
  }
  const de = datas[0], ate = datas[1] || datas[0];
  const pool = _getPool();

  const q = async (sql) => (await pool.query(sql, [de, ate])).rows;
  const [snap, prod, sub] = await Promise.all([
    q(`SELECT date, COUNT(DISTINCT team_name)::int n FROM snapshots
        WHERE date BETWEEN $1::date AND $2::date GROUP BY date`),
    q(`SELECT date, COUNT(DISTINCT team_name)::int n, SUM(count)::int total FROM team_daily_totals
        WHERE date BETWEEN $1::date AND $2::date GROUP BY date`),
    q(`SELECT date, COUNT(DISTINCT team_name)::int n, SUM(count)::int total FROM team_daily_subcat_totals
        WHERE date BETWEEN $1::date AND $2::date GROUP BY date`),
  ]);

  const ymd = (d) => String(d instanceof Date ? d.toISOString().slice(0, 10) : d).slice(0, 10);
  const idx = (rows) => new Map(rows.map(r => [ymd(r.date), r]));
  const S = idx(snap), P = idx(prod), U = idx(sub);

  // Todos os dias do range (inclui os sem nenhum registro)
  const dias = [];
  for (let d = new Date(de + 'T12:00:00Z'); d <= new Date(ate + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    dias.push(d.toISOString().slice(0, 10));
  }

  console.log(`\n📅 Cobertura por dia · ${de} → ${ate}`);
  console.log('   eq_snap = equipes com snapshot (matéria-prima) · eq_prod/eq_sub = consolidado\n');
  console.log('DIA'.padEnd(12) + 'DOW'.padEnd(5) + 'eq_snap'.padStart(8) + 'eq_prod'.padStart(8)
    + 'prod'.padStart(7) + 'eq_sub'.padStart(8) + 'sub'.padStart(7) + '   status');
  console.log('-'.repeat(74));

  const recuperaveis = [];
  for (const dia of dias) {
    const s = S.get(dia), p = P.get(dia), u = U.get(dia);
    const nS = s ? s.n : 0, nP = p ? p.n : 0, nU = u ? u.n : 0;
    const dow = DOW[new Date(dia + 'T12:00:00Z').getUTCDay()];
    let status = '';
    if (nS === 0) {
      status = 'sem snapshot (dia sem operação?)';
    } else if (nP === 0) {
      status = '🔴 BURACO: tem snapshot, produção ZERADA → re-consolidar';
      recuperaveis.push(dia);
    } else if (nP < nS * 0.7) {
      status = `🟠 PARCIAL: ${nP}/${nS} equipes no consolidado → re-consolidar`;
      recuperaveis.push(dia);
    } else {
      status = 'ok';
    }
    console.log(dia.padEnd(12) + dow.padEnd(5) + String(nS).padStart(8) + String(nP).padStart(8)
      + String(p ? p.total : 0).padStart(7) + String(nU).padStart(8) + String(u ? u.total : 0).padStart(7)
      + '   ' + status);
  }
  console.log('-'.repeat(74));
  if (recuperaveis.length) {
    console.log(`\n🔧 ${recuperaveis.length} dia(s) com dado recuperável: ${recuperaveis.join(', ')}`);
    console.log(`   Medir ANTES de aplicar (dry-run):`);
    console.log(`   node scripts/backfill-consolidate.js ${recuperaveis[0]} ${recuperaveis[recuperaveis.length - 1]}`);
  } else {
    console.log('\n✅ Nenhum buraco: todo dia com snapshot tem consolidado coerente.');
  }
  console.log('');
}

main()
  .then(async () => { try { const p = _getPool(); if (p && p.end) await p.end(); } catch (_) {} process.exit(0); })
  .catch(async (e) => { console.error(e); try { const p = _getPool(); if (p && p.end) await p.end(); } catch (_) {} process.exit(1); });
