#!/usr/bin/env node
/**
 * scripts/diag-lag-rejeicoes.js
 *
 * Mede o ATRASO entre o dia da rejeição e o momento em que ela foi coletada, e
 * quantas chegaram DEPOIS da consolidação que selou o dia. READ-ONLY.
 *
 * POR QUE EXISTE: o dry-run de 21/08/2026 mostrou que os dias 14/08 e 17→20/08
 * ficariam ~10% MENORES se re-consolidados (−102 a −202), enquanto 11→13/08 dão
 * positivos pequenos (+9 a +17, a assinatura conhecida do P2-13). O backfill de
 * `rejection_date` foi descartado como causa: mexeu em 3 notas
 * (`diag-rejeicoes-data-mudou.js`).
 *
 * A hipótese a testar é o mecanismo do P1-15: uma rejeição coletada DEPOIS da
 * consolidação que selou o dia não entra naquele valor. O dia fica gravado com
 * menos rejeições do que a realidade → produção INFLADA. E como o reparo do
 * drift é monotônico desde o P0-7 (só ADICIONA, nunca subtrai — decisão correta,
 * tomada depois de o reparo apagar produção legítima no P0-6), esse tipo de
 * inflação NÃO se autocorrige.
 *
 * Quando um dia é "selado": `runConsolidate` roda às 23:50 BRT e o
 * `consolidateDay(D+1)` wipa e reescreve `{D, D+1}`. Então o valor final do dia D
 * é escrito por volta de **D+1 23:50 BRT**. Depois disso, só o drift sweep toca o
 * dia — e ele só adiciona.
 *
 * ⚠️ LIMITAÇÃO conhecida: o backfill de 21/08 gravou `fetched_at = now()` em 1266
 * linhas, apagando o `fetched_at` original delas. Este script EXCLUI as linhas
 * tocadas naquele dia (`--excluir-dia`), senão elas apareceriam falsamente como
 * "chegou muito atrasada". Efeito colateral do backfill que vale registrar: ele
 * destruiu informação forense, sem afetar número nenhum.
 *
 * Uso (na VM):
 *   node -r dotenv/config scripts/diag-lag-rejeicoes.js
 *   node -r dotenv/config scripts/diag-lag-rejeicoes.js --de 2026-08-05 --ate 2026-08-20
 *   node -r dotenv/config scripts/diag-lag-rejeicoes.js --excluir-dia 2026-08-21
 */

function arg(nome, padrao = null) {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}

const DE      = arg('de',  '2026-08-01');
const ATE     = arg('ate', '2026-08-20');
const EXCLUIR = arg('excluir-dia', '2026-08-21');   // dia do backfill

async function main() {
  const { _getPool } = require('../services/pgShim');
  const pool = _getPool();
  if (!pool) {
    console.error('Sem pool. Rode com `node -r dotenv/config` na VM.');
    process.exit(1);
  }

  console.log(`\n=== Atraso de coleta das rejeições ===`);
  console.log(`janela: ${DE} → ${ATE}   (excluindo linhas tocadas em ${EXCLUIR})\n`);

  // Selo do dia D = D+1 às 23:50 BRT = D+2 02:50 UTC.
  const { rows } = await pool.query(
    `WITH base AS (
       SELECT session_date,
              fetched_at,
              (session_date + INTERVAL '1 day' + INTERVAL '23 hours 50 minutes'
               + INTERVAL '3 hours') AS selo_utc
         FROM note_rejections
        WHERE session_date BETWEEN $1::date AND $2::date
          AND NOT (fetched_at >= $3::date AND fetched_at < ($3::date + 1))
     )
     SELECT session_date::text                                            AS dia,
            count(*)::int                                                  AS rejeicoes,
            count(*) FILTER (WHERE fetched_at >  selo_utc)::int             AS pos_selo,
            count(*) FILTER (WHERE fetched_at <= selo_utc)::int             AS no_prazo,
            round(avg(EXTRACT(EPOCH FROM (fetched_at - session_date))/3600)::numeric, 1) AS lag_medio_h
       FROM base
      GROUP BY session_date
      ORDER BY session_date`,
    [DE, ATE, EXCLUIR]);

  if (rows.length === 0) {
    console.log('Sem linhas na janela.');
    await pool.end();
    return;
  }

  console.log('dia          rejeições   no prazo   APÓS O SELO   % após   lag médio (h)');
  console.log('---------------------------------------------------------------------------');
  let T = { rejeicoes: 0, pos_selo: 0 };
  for (const r of rows) {
    const pct = r.rejeicoes ? Math.round(100 * r.pos_selo / r.rejeicoes) : 0;
    const flag = pct >= 20 ? '  ⚠️' : '';
    console.log(`${r.dia}   ${String(r.rejeicoes).padStart(9)}   ${String(r.no_prazo).padStart(8)}   ` +
                `${String(r.pos_selo).padStart(11)}   ${String(pct).padStart(5)}%   ` +
                `${String(r.lag_medio_h).padStart(12)}${flag}`);
    T.rejeicoes += r.rejeicoes; T.pos_selo += r.pos_selo;
  }
  console.log('---------------------------------------------------------------------------');
  console.log(`TOTAL        ${String(T.rejeicoes).padStart(9)}   ` +
              `${String(T.rejeicoes - T.pos_selo).padStart(8)}   ${String(T.pos_selo).padStart(11)}   ` +
              `${String(T.rejeicoes ? Math.round(100*T.pos_selo/T.rejeicoes) : 0).padStart(5)}%`);

  console.log(`\n── LEITURA ──`);
  console.log(`"APÓS O SELO" = rejeição coletada depois de o dia já ter sido consolidado`);
  console.log(`pela última vez que o reescreve (D+1 23:50 BRT). Essas NÃO entraram no`);
  console.log(`valor gravado, e o reparo do drift — monotônico desde o P0-7 — não as`);
  console.log(`aplica, porque aplicá-las SUBTRAIRIA produção.`);
  console.log(`\nSe os dias com muitas "após o selo" forem os mesmos que o dry-run quer`);
  console.log(`baixar (14/08 e 17→20/08), a causa está identificada e o valor gravado é`);
  console.log(`que está inflado. Se NÃO coincidirem, a causa é outra — não aplicar nada.`);

  // Contexto: volume de equipes por dia. O SJC voltou em 14/08 (64 → 122 equipes),
  // e é justamente aí que o sinal do dry-run vira. Vale ver se o volume explica.
  const { rows: eq } = await pool.query(
    `SELECT date::text AS dia, count(DISTINCT team_name)::int AS equipes
       FROM snapshots WHERE date BETWEEN $1::date AND $2::date
      GROUP BY date ORDER BY date`, [DE, ATE]);
  console.log(`\n── EQUIPES POR DIA (contexto: SJC voltou em 14/08) ──`);
  eq.forEach(r => console.log(`  ${r.dia}  ${String(r.equipes).padStart(4)} equipes`));

  await pool.end();
}

main().catch(err => { console.error('ERRO:', err.message); process.exit(1); });
