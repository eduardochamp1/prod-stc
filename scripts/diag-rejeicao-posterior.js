#!/usr/bin/env node
/**
 * scripts/diag-rejeicao-posterior.js
 *
 * Conta, por DIA DE CONCLUSÃO, as notas que foram rejeitadas DEPOIS daquele dia.
 * READ-ONLY.
 *
 * POR QUE EXISTE — e por que o script anterior errou o alvo:
 *
 * O `diag-lag-rejeicoes.js` mediu se a rejeição chegou depois do selo do dia da
 * PRÓPRIA rejeição. Deu 0% em todos os dias, lag uniforme de ~13h. Refutou a
 * hipótese como formulada, mas o join estava errado: o que decide a produção do
 * dia D é a rejeição comparada com o selo de **D**, e uma rejeição do dia D+2,
 * coletada pontualmente, chega DEPOIS do selo de D sem nunca estar "atrasada".
 *
 * A regra vigente (31/07/2026): *rejeição DEPOIS da conclusão → a EDP recusou o
 * serviço → NÃO conta como produção*. E o `consolidateDay` consulta
 * `note_rejections` por `note_id` **sem janela de data** (P1-16), então
 * re-consolidar hoje aplica rejeições que nem existiam quando o dia foi selado.
 *
 * Consequência: uma nota concluída em 17/08 e rejeitada em 19/08 contava como
 * produção no valor gravado (selado em 18/08 23:50, antes de a rejeição existir)
 * e deixa de contar ao re-consolidar. Como o reparo do drift é **monotônico**
 * desde o P0-7 (só ADICIONA), essa inflação nunca se autocorrige.
 *
 * Isso também explica por que junho/julho mostram só o P2-13 (+~5/dia) e agosto
 * mostra −100 a −200: **junho e julho FORAM re-consolidados em 31/07**, então já
 * absorveram as rejeições posteriores conhecidas até ali. Agosto nunca foi.
 *
 * O número que este script produz deve BATER, em ordem de grandeza, com os diffs
 * negativos do dry-run (`backfill-consolidate.js`). Se não bater, a causa é outra.
 *
 * Uso (na VM):
 *   node -r dotenv/config scripts/diag-rejeicao-posterior.js
 *   node -r dotenv/config scripts/diag-rejeicao-posterior.js --de 2026-06-01 --ate 2026-08-20
 */

function arg(nome, padrao = null) {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}

const DE  = arg('de',  '2026-08-01');
const ATE = arg('ate', '2026-08-20');

async function main() {
  const { _getPool } = require('../services/pgShim');
  const pool = _getPool();
  if (!pool) {
    console.error('Sem pool. Rode com `node -r dotenv/config` na VM.');
    process.exit(1);
  }

  console.log(`\n=== Notas rejeitadas DEPOIS do dia em que foram concluídas ===`);
  console.log(`janela: ${DE} → ${ATE}   (read-only)\n`);

  const DIA_REJ = `(r.rejection_date AT TIME ZONE 'America/Sao_Paulo')::date`;

  // Dia da conclusão: preferimos o conclusionDate da própria nota (é o que o
  // _notaDate usa); cai pro dia do snapshot quando ausente. Par (nota, equipe),
  // porque a regra é por equipe — mesma chave do _rejIndexByNote.
  const { rows } = await pool.query(
    `WITH conc AS (
       SELECT DISTINCT
              (n->>'id')::uuid AS note_id,
              s.team_name,
              COALESCE(
                (NULLIF(n->>'conclusionDate','') AT TIME ZONE 'UTC'
                   AT TIME ZONE 'America/Sao_Paulo')::date,
                s.date
              ) AS dia_conc
         FROM snapshots s,
              jsonb_array_elements(COALESCE(s.data->'notasConcluidas','[]'::jsonb)) AS n
        WHERE s.date BETWEEN $1::date AND ($2::date + 2)
          AND n->>'id' IS NOT NULL
     )
     SELECT c.dia_conc::text AS dia,
            count(*)::int AS concluidas,
            count(r.note_id)::int AS com_rejeicao_dessa_equipe,
            count(*) FILTER (WHERE ${DIA_REJ} > c.dia_conc)::int AS rej_posterior,
            count(*) FILTER (WHERE ${DIA_REJ} = c.dia_conc)::int AS rej_mesmo_dia,
            count(*) FILTER (WHERE ${DIA_REJ} > c.dia_conc
                               AND r.fetched_at > (c.dia_conc + INTERVAL '1 day'
                                   + INTERVAL '23 hours 50 minutes' + INTERVAL '3 hours')
                            )::int AS posterior_e_pos_selo
       FROM conc c
       LEFT JOIN note_rejections r
              ON r.note_id = c.note_id AND r.team_name = c.team_name
      WHERE c.dia_conc BETWEEN $1::date AND $2::date
      GROUP BY c.dia_conc
      ORDER BY c.dia_conc`,
    [DE, ATE]);

  if (rows.length === 0) { console.log('Sem linhas.'); await pool.end(); return; }

  console.log('dia          concluídas   rej. mesmo dia   REJ. POSTERIOR   dessas, após o selo de D');
  console.log('--------------------------------------------------------------------------------------');
  let T = { concluidas: 0, rej_mesmo_dia: 0, rej_posterior: 0, posterior_e_pos_selo: 0 };
  for (const r of rows) {
    const flag = r.posterior_e_pos_selo >= 50 ? '  ⚠️' : '';
    console.log(`${r.dia}   ${String(r.concluidas).padStart(10)}   ${String(r.rej_mesmo_dia).padStart(14)}   ` +
                `${String(r.rej_posterior).padStart(14)}   ${String(r.posterior_e_pos_selo).padStart(23)}${flag}`);
    for (const k of Object.keys(T)) T[k] += r[k];
  }
  console.log('--------------------------------------------------------------------------------------');
  console.log(`TOTAL        ${String(T.concluidas).padStart(10)}   ${String(T.rej_mesmo_dia).padStart(14)}   ` +
              `${String(T.rej_posterior).padStart(14)}   ${String(T.posterior_e_pos_selo).padStart(23)}`);

  console.log(`\n── LEITURA ──`);
  console.log(`"REJ. POSTERIOR"  = nota concluída no dia D e rejeitada DEPOIS de D pela`);
  console.log(`                    mesma equipe. Pela regra de 31/07 não é produção.`);
  console.log(`"após o selo de D" = a rejeição foi COLETADA depois de D já ter sido`);
  console.log(`                    selado (D+1 23:50 BRT). O valor gravado não podia`);
  console.log(`                    conhecê-la; a re-consolidação de hoje conhece.`);
  console.log(`\nA última coluna é a estimativa do quanto cada dia CAIRIA ao re-consolidar.`);
  console.log(`Compare com os diffs negativos do dry-run do backfill-consolidate.js:`);
  console.log(`  14/08 −108 · 17/08 −202 · 18/08 −124 · 19/08 −109 · 20/08 −102`);
  console.log(`Se a ordem de grandeza bater, a causa está identificada e o valor GRAVADO`);
  console.log(`é que está inflado. Se não bater, é outra coisa — não aplicar nada.`);

  await pool.end();
}

main().catch(err => { console.error('ERRO:', err.message); process.exit(1); });
