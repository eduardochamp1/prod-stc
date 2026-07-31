#!/usr/bin/env node
/**
 * scripts/diag-cobertura-rejeicoes.js — DE QUANDO existe dado de rejeição?
 * Read-only. NÃO grava nada.
 *
 * POR QUE EXISTE (31/07/2026): ao medir o impacto da re-consolidação em JUNHO,
 * o `diag-impacto-reconsolidacao` deu **+717 (+5,5%)** — sinal invertido em
 * relação a julho (−877) e muito errático (23/06 deu +181%).
 *
 * ⚠️ ATENÇÃO — DUAS HIPÓTESES MINHAS SOBRE ESTE SCRIPT DERAM ERRADAS. Leia antes
 * de tirar conclusão a partir dele:
 *
 *   1) "a coleta começa em 08/06" — ERRADO. A cobertura vai de 25/04 a 31/07;
 *      os dias de volume baixo são FIM DE SEMANA (13/14, 20/21, 27/28).
 *   2) "dia sem rejeição registrada infla na re-consolidação, então exclua do
 *      apply" — ERRADO, e a recomendação que saiu disso era pior que inútil.
 *      `_unionTeamsFromSnapshots` une `notasRejeitadas` de **TODOS os snapshots
 *      do dia** (um a cada 15min), então a rejeição capturada em qualquer
 *      snapshot sobrevive à re-consolidação. `note_rejections` é **suplemento**
 *      (pega o que a WPA limpou antes de qualquer snapshot), não fonte única.
 *      Verificado em 10/06/2026 (dia com 1 linha em note_rejections): depois de
 *      re-consolidar, `GRAVADO = UNIÃO_D+1 = 1106` exato e **nenhuma equipe
 *      zerada** — o "+88" que eu havia chamado de regressão era só a diferença
 *      entre a régua de D e a de D+1 (o mesmo engano do P0-6).
 *      E excluir dias do backfill não funciona de todo jeito: o passe do 1º dia
 *      do intervalo wipa {1ºdia-1, 1ºdia}.
 *
 * O QUE ESTE SCRIPT AINDA SERVE PRA FAZER: mostrar onde o COLETOR falhou, que é
 * informação operacional real (dia útil com ~0 rejeição = coleta furada, ex.:
 * 09 e 10/06 com 1 linha numa terça e numa quarta). Se um dia desses tiver
 * REJEITADAS zeradas no painel, aí sim há perda — confira na matriz de Gráficos
 * antes de concluir. Ver P1-17 no BACKLOG.
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
    console.log(`\n   Rode com um intervalo pra ver dia a dia — o que importa não é o`);
    console.log(`   volume do mês, e sim DIA ÚTIL com zero (ou quase) rejeição: nesses,`);
    console.log(`   re-consolidar devolve nota rejeitada pra produção. Ver o topo.\n`);
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

    // Dia ÚTIL com volume suspeito de falha de coleta. O corte de 5 é grosseiro
    // de propósito: fim de semana tem dezenas, dia útil normal tem centenas —
    // 1 linha numa terça (10/06/2026) é falha, não baixa demanda.
    const suspeitos = rows
      .filter(r => r.linhas <= 5 && ![0, 6].includes(new Date(ymd(r.dia) + 'T12:00:00Z').getUTCDay()))
      .map(r => `${ymd(r.dia)} (${r.linhas})`);

    if (vazios) {
      console.log(`\n⚠️  ${vazios} dia(s) SEM nenhuma rejeição registrada:`);
      console.log(`   ${faltando.join(' ')}`);
    }
    if (suspeitos.length) {
      console.log(`\n⚠️  dia(s) ÚTEIS com volume perto de zero (falha de coleta):`);
      console.log(`   ${suspeitos.join('  ')}`);
    }
    if (vazios || suspeitos.length) {
      console.log(`\n   ℹ️  Isso indica falha do COLETOR, não necessariamente perda de dado:`);
      console.log(`      a re-consolidação também lê notasRejeitadas dos snapshots do dia.`);
      console.log(`      NÃO é motivo pra excluir o dia do backfill (verificado em 10/06/2026).`);
      console.log(`      Confira REJEITADAS desses dias na matriz de Gráficos: se estiver`);
      console.log(`      zerado, aí houve perda real. Ver o topo deste arquivo e P1-17.`);
    } else {
      console.log(`\n✅ Todos os dias úteis do intervalo têm rejeição registrada.`);
    }
    console.log('');
  }
}

main()
  .then(async () => { try { const p = _getPool(); if (p && p.end) await p.end(); } catch (_) {} process.exit(0); })
  .catch(async (e) => { console.error(e); try { const p = _getPool(); if (p && p.end) await p.end(); } catch (_) {} process.exit(1); });
