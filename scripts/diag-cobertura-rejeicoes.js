#!/usr/bin/env node
/**
 * scripts/diag-cobertura-rejeicoes.js — DE QUANDO existe dado de rejeição?
 * Read-only. NÃO grava nada.
 *
 * POR QUE EXISTE (31/07/2026): ao medir o impacto da re-consolidação em JUNHO,
 * o `diag-impacto-reconsolidacao` deu **+717 (+5,5%)** — sinal invertido em
 * relação a julho (−877) e muito errático (23/06 deu +181%). Os eventos
 * `consolidate_rejeicao_por_nota` do próprio dry-run mostraram o porquê:
 *
 *   01/06→4   02/06→0   03/06→5   04/06→14   05/06→27   06/06→22   07/06→24
 *   08/06→273  09/06→253  ... (patamar de centenas daí em diante)
 *
 * Um salto de 70x não é sazonalidade: é o coletor de rejeições que só passou a
 * PERSISTIR em `note_rejections` a partir dali. Antes disso a regra "rejeitada
 * não é produção" **não tem dado pra ser aplicada retroativamente** — re-consolidar
 * aqueles dias corrige a parte estrutural (união de equipes, vira-noite) mas NÃO
 * desconta as rejeições, gerando um número inconsistente com julho.
 *
 * Este script mostra a cobertura real por dia, pra decidir a partir de que data a
 * re-consolidação produz número comparável. Use ANTES de aplicar em qualquer mês
 * antigo.
 *
 * USO (na VM):
 *   node scripts/diag-cobertura-rejeicoes.js                    # visão geral por mês
 *   node scripts/diag-cobertura-rejeicoes.js 2026-06-01 2026-06-30   # dia a dia
 */

require('dotenv').config();
const { _getPool } = require('../services/pgShim');

const ymd = (v) => {
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  return String(v || '').slice(0, 10);
};

async function main() {
  const datas = process.argv.slice(2).filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const pool = _getPool();

  const tot = (await pool.query(
    'SELECT count(*)::int AS n, min(session_date) AS p, max(session_date) AS u FROM note_rejections'
  )).rows[0];

  console.log(`\n📅 Cobertura de note_rejections`);
  console.log(`   ${tot.n} linha(s) · de ${ymd(tot.p)} até ${ymd(tot.u)}\n`);

  if (!datas.length) {
    // Visão por mês: onde a coleta começa a ter volume real.
    const { rows } = await pool.query(`
      SELECT substring(session_date::text, 1, 7) AS mes,
             count(*)::int                        AS linhas,
             count(DISTINCT note_id)::int         AS notas,
             count(DISTINCT session_date)::int    AS dias,
             count(*) FILTER (WHERE rejection_date IS NOT NULL)::int AS com_rejected_at
        FROM note_rejections
       GROUP BY 1 ORDER BY 1`);

    console.log('mês'.padEnd(10) + 'linhas'.padStart(8) + 'notas'.padStart(8)
      + 'dias'.padStart(6) + 'c/RejectedAt'.padStart(14));
    console.log('-'.repeat(46));
    for (const r of rows) {
      console.log(r.mes.padEnd(10) + String(r.linhas).padStart(8) + String(r.notas).padStart(8)
        + String(r.dias).padStart(6) + String(r.com_rejected_at).padStart(14));
    }
    console.log('-'.repeat(46));
    console.log(`\n   Procure o mês em que "linhas" sai de dezenas pra centenas/milhares:`);
    console.log(`   antes dele a regra de rejeição NÃO pode ser aplicada retroativamente.`);
    console.log(`   Rode com um intervalo pra ver dia a dia.\n`);
  } else {
    const de = datas[0], ate = datas[1] || datas[0];
    const { rows } = await pool.query(`
      SELECT session_date AS dia,
             count(*)::int                 AS linhas,
             count(DISTINCT note_id)::int  AS notas,
             count(DISTINCT team_name)::int AS equipes
        FROM note_rejections
       WHERE session_date BETWEEN $1::date AND $2::date
       GROUP BY 1 ORDER BY 1`, [de, ate]);

    console.log(`   ${de} → ${ate}, dia a dia\n`);
    console.log('dia'.padEnd(12) + 'linhas'.padStart(8) + 'notas'.padStart(8) + 'equipes'.padStart(9));
    console.log('-'.repeat(37));
    let vazios = 0;
    for (const r of rows) {
      console.log(ymd(r.dia).padEnd(12) + String(r.linhas).padStart(8)
        + String(r.notas).padStart(8) + String(r.equipes).padStart(9));
    }
    // Dias do intervalo SEM nenhuma linha — é onde a regra não tem dado.
    const presentes = new Set(rows.map(r => ymd(r.dia)));
    const d = new Date(de + 'T12:00:00Z'), fim = new Date(ate + 'T12:00:00Z');
    const faltando = [];
    while (d <= fim) {
      const s = d.toISOString().slice(0, 10);
      if (!presentes.has(s)) { faltando.push(s); vazios++; }
      d.setUTCDate(d.getUTCDate() + 1);
    }
    console.log('-'.repeat(37));
    if (vazios) {
      console.log(`\n⚠️  ${vazios} dia(s) SEM nenhuma rejeição registrada:`);
      console.log(`   ${faltando.join(' ')}`);
      console.log(`   Nesses dias a regra "rejeitada não é produção" não tem dado —`);
      console.log(`   re-consolidar corrige só a parte estrutural. Ver P1-17 no BACKLOG.`);
    } else {
      console.log(`\n✅ Todos os dias do intervalo têm rejeição registrada.`);
    }
    console.log('');
  }
}

main()
  .then(async () => { try { const p = _getPool(); if (p && p.end) await p.end(); } catch (_) {} process.exit(0); })
  .catch(async (e) => { console.error(e); try { const p = _getPool(); if (p && p.end) await p.end(); } catch (_) {} process.exit(1); });
