#!/usr/bin/env node
/**
 * scripts/diag-rejeicoes-data-mudou.js
 *
 * Isola o efeito do backfill de `rejection_date` sobre a regra
 * rejeitada>concluída. READ-ONLY.
 *
 * POR QUE EXISTE: o dry-run da re-consolidação de 21/08/2026 (01/06 → 20/08) deu
 * TOTAL −308, mas com duas populações opostas: junho/julho com positivos pequenos
 * (+1 a +26) e 14/08 + 17→20/08 com negativos grandes (−102 a −202). O dry-run
 * rodou DEPOIS do backfill, então não existe linha de base — os dois efeitos
 * estão somados e não dá pra atribuir nada. Erro de método: a medição antes do
 * backfill não foi tirada.
 *
 * Este script separa os dois de forma exata, sem precisar refazer nada:
 * o backfill gravou `fetched_at = now()` em cada linha que tocou, então as 1.266
 * linhas afetadas são identificáveis por `fetched_at::date = hoje`.
 *
 * E o efeito do backfill sobre a regra depende SÓ de uma coisa: o dia mudou?
 *   - `date(rejection_date)` == `session_date`  → a regra vê o mesmo dia. ZERO efeito.
 *   - `date(rejection_date)` <  `session_date`  → rejeição foi pra TRÁS. Fica menos
 *     provável de cobrir a conclusão → MAIS produção (diff positivo).
 *   - `date(rejection_date)` >  `session_date`  → foi pra FRENTE → MENOS produção.
 *
 * Se agosto tiver ~0 linhas com dia alterado, os negativos de agosto NÃO vêm do
 * backfill e precisam de outra explicação (a hipótese é o P1-15: dias
 * consolidados antes de as rejeições serem coletadas).
 *
 * Uso (na VM):
 *   node -r dotenv/config scripts/diag-rejeicoes-data-mudou.js
 *   node -r dotenv/config scripts/diag-rejeicoes-data-mudou.js --dia 2026-08-21
 */

function arg(nome, padrao = null) {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}
const DIA_BACKFILL = arg('dia', null);   // null = hoje BRT

async function main() {
  const { _getPool } = require('../services/pgShim');
  const pool = _getPool();
  if (!pool) {
    console.error('Sem pool. Rode com `node -r dotenv/config` na VM.');
    process.exit(1);
  }

  const dia = DIA_BACKFILL || new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);

  console.log(`\n=== Efeito ISOLADO do backfill de rejection_date ===`);
  console.log(`linhas tocadas em: ${dia} (fetched_at)   — read-only\n`);

  // BRT explícito: rejection_date é timestamptz, session_date é date. Comparar
  // sem converter o fuso jogaria as rejeições da noite pro dia seguinte.
  const SQL_DIA_REJ = `(rejection_date AT TIME ZONE 'America/Sao_Paulo')::date`;

  const { rows } = await pool.query(
    `SELECT to_char(session_date, 'YYYY-MM')                        AS mes,
            count(*)::int                                            AS linhas,
            count(*) FILTER (WHERE ${SQL_DIA_REJ} = session_date)::int AS dia_igual,
            count(*) FILTER (WHERE ${SQL_DIA_REJ} < session_date)::int AS foi_pra_tras,
            count(*) FILTER (WHERE ${SQL_DIA_REJ} > session_date)::int AS foi_pra_frente
       FROM note_rejections
      WHERE rejection_date IS NOT NULL
        AND fetched_at >= $1::date AND fetched_at < ($1::date + 1)
      GROUP BY 1 ORDER BY 1`,
    [dia]);

  if (rows.length === 0) {
    console.log('Nenhuma linha com fetched_at nesse dia. Confira a data com --dia.');
    await pool.end();
    return;
  }

  console.log('mês       linhas   dia igual   → trás (+prod)   → frente (-prod)');
  console.log('------------------------------------------------------------------');
  let T = { linhas: 0, dia_igual: 0, foi_pra_tras: 0, foi_pra_frente: 0 };
  for (const r of rows) {
    console.log(`${r.mes}   ${String(r.linhas).padStart(6)}   ${String(r.dia_igual).padStart(9)}   ` +
                `${String(r.foi_pra_tras).padStart(14)}   ${String(r.foi_pra_frente).padStart(16)}`);
    for (const k of Object.keys(T)) T[k] += r[k];
  }
  console.log('------------------------------------------------------------------');
  console.log(`TOTAL    ${String(T.linhas).padStart(6)}   ${String(T.dia_igual).padStart(9)}   ` +
              `${String(T.foi_pra_tras).padStart(14)}   ${String(T.foi_pra_frente).padStart(16)}`);

  const mexeram = T.foi_pra_tras + T.foi_pra_frente;
  console.log(`\n── LEITURA ──`);
  console.log(`linhas em que o dia NÃO mudou: ${T.dia_igual}/${T.linhas} → efeito ZERO na regra.`);
  console.log(`linhas em que o dia mudou:     ${mexeram}`);
  console.log(`\nO backfill só pode ter mexido em produção nessas ${mexeram} — e no máximo`);
  console.log(`1 nota cada. Qualquer diferença do dry-run acima desse teto vem de OUTRA`);
  console.log(`causa (hipótese: P1-15, dia consolidado antes de as rejeições existirem).`);

  // Detalhe por mês das que mudaram, pra cruzar com os dias do dry-run.
  if (mexeram > 0) {
    const { rows: det } = await pool.query(
      `SELECT session_date::text AS dia_sessao,
              ${SQL_DIA_REJ}::text AS dia_rejeicao,
              tipo, team_name, numero
         FROM note_rejections
        WHERE rejection_date IS NOT NULL
          AND fetched_at >= $1::date AND fetched_at < ($1::date + 1)
          AND ${SQL_DIA_REJ} <> session_date
        ORDER BY session_date
        LIMIT 40`, [dia]);
    console.log(`\n── AS QUE MUDARAM (até 40) ──`);
    det.forEach(d => console.log(
      `  ${d.dia_sessao} → ${d.dia_rejeicao}   ${d.tipo.padEnd(3)} ${String(d.team_name).padEnd(9)} ${d.numero || ''}`));
  }

  await pool.end();
}

main().catch(err => { console.error('ERRO:', err.message); process.exit(1); });
