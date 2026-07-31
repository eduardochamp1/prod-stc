#!/usr/bin/env node
/**
 * scripts/diag-alcance-rejeicao.js — ALCANCE do bug P1-15 por tipo de nota.
 * Read-only. NÃO grava nada.
 *
 * Mede, por tipo, quanto da produção consolidada é nota que a regra deveria ter
 * excluído (rejeitada no mesmo dia da conclusão ou depois). Serve pra dimensionar
 * o impacto ANTES de decidir re-consolidar — a correção REDUZ produção já
 * reportada à EDP.
 *
 * REGRA (validada no portal da EDP em 31/07/2026, notas 030009946354 e
 * 030009957459 — rejeição no mesmo minuto do "Fim do Trabalho", motivo
 * "1172 - Pix no WPA": cliente pagou, corte NÃO executado):
 *   rejeição no MESMO dia da conclusão  → a visita terminou em rejeição → NÃO é produção
 *   rejeição em dia POSTERIOR           → conclusão recusada            → NÃO é produção
 *   rejeição em dia ANTERIOR            → nota devolvida e REFEITA      → É produção
 *
 * ⚠️ CUSTO: abre o JSONB de todos os snapshots do período. Rode MÊS A MÊS na VM
 * (3.8GB, sem swap). Um mês de cada vez é seguro; o contrato inteiro de uma vez
 * não é recomendado.
 *
 * USO (na VM):
 *   node scripts/diag-alcance-rejeicao.js 2026-07-01 2026-07-25
 *   node scripts/diag-alcance-rejeicao.js 2026-06-01 2026-06-30
 */

require('dotenv').config();
const { _getPool } = require('../services/pgShim');
const { getSiglas } = require('../services/equipesOficiais');

async function main() {
  const datas = process.argv.slice(2).filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  if (!datas.length) {
    console.error('✖ Uso: node scripts/diag-alcance-rejeicao.js <de> [<ate>]   (rode mês a mês)');
    process.exit(1);
  }
  const de = datas[0], ate = datas[1] || datas[0];
  const pool = _getPool();
  const siglas = getSiglas();

  console.error(`⏳ Lendo snapshots de ${de} → ${ate} (${siglas.length} equipes)… pode levar minutos.`);

  const { rows } = await pool.query(`
    WITH conc AS (
      SELECT (n->>'id') AS uuid, upper(coalesce(n->>'tipoCode','?')) AS tipo,
             s.team_name,
             CASE WHEN n->>'conclusionDate' ~ '^\\d{4}-\\d{2}-\\d{2}'
                  THEN substring(n->>'conclusionDate',1,10) ELSE NULL END AS dia
        FROM snapshots s
        CROSS JOIN LATERAL jsonb_array_elements(
               CASE WHEN jsonb_typeof(s.data->'notasConcluidas') = 'array'
                    THEN s.data->'notasConcluidas' ELSE '[]'::jsonb END) n
       WHERE s.date BETWEEN $1::date AND $2::date
         AND s.team_name = ANY($3::text[])
         AND (n->>'id') IS NOT NULL
    ),
    uni AS (   -- 1 linha por nota (dedup por UUID)
      SELECT uuid, MAX(tipo) AS tipo, MIN(team_name) AS team_name, MAX(dia) AS dia
        FROM conc GROUP BY uuid
    ),
    -- só notas cuja CONCLUSÃO caiu no período (mesma atribuição do painel)
    janela AS (
      SELECT * FROM uni WHERE dia IS NOT NULL AND dia::date BETWEEN $1::date AND $2::date
    ),
    marcada AS (
      SELECT j.*,
             EXISTS (SELECT 1 FROM note_rejections r
                      WHERE r.note_id = j.uuid::uuid
                        AND r.session_date >= j.dia::date) AS nao_produz
        FROM janela j
    )
    SELECT tipo,
           COUNT(*)::int                                        AS concluidas,
           COUNT(*) FILTER (WHERE nao_produz)::int              AS rejeitadas,
           COUNT(*) FILTER (WHERE NOT nao_produz)::int          AS esperado
      FROM marcada GROUP BY tipo ORDER BY concluidas DESC`, [de, ate, siglas]);

  const painel = (await pool.query(`
    SELECT tipo_code AS tipo, SUM(count)::int AS n
      FROM team_daily_totals
     WHERE date BETWEEN $1::date AND $2::date AND team_name = ANY($3::text[])
     GROUP BY tipo_code`, [de, ate, siglas])).rows
    .reduce((a, r) => (a[r.tipo] = r.n, a), {});

  console.log(`\n📐 ALCANCE do P1-15 por tipo · ${de} → ${ate}`);
  console.log(`   esperado = concluídas − (rejeitadas no mesmo dia ou depois)\n`);
  console.log('TIPO'.padEnd(7) + 'CONCLUÍDAS'.padStart(11) + 'REJEITADAS'.padStart(11)
    + 'ESPERADO'.padStart(10) + 'PAINEL'.padStart(8) + 'EXCESSO'.padStart(9) + '   %');
  console.log('-'.repeat(64));
  let t = { c: 0, r: 0, e: 0, p: 0 };
  for (const row of rows) {
    const p = painel[row.tipo] || 0;
    const excesso = p - row.esperado;
    t.c += row.concluidas; t.r += row.rejeitadas; t.e += row.esperado; t.p += p;
    console.log(row.tipo.padEnd(7) + String(row.concluidas).padStart(11) + String(row.rejeitadas).padStart(11)
      + String(row.esperado).padStart(10) + String(p).padStart(8) + String(excesso).padStart(9)
      + '   ' + (p > 0 ? Math.round(100 * excesso / p) + '%' : '—'));
  }
  console.log('-'.repeat(64));
  console.log('TOTAL'.padEnd(7) + String(t.c).padStart(11) + String(t.r).padStart(11)
    + String(t.e).padStart(10) + String(t.p).padStart(8) + String(t.p - t.e).padStart(9)
    + '   ' + (t.p > 0 ? Math.round(100 * (t.p - t.e) / t.p) + '%' : '—'));

  console.log(`\n   EXCESSO = quanto o painel conta ACIMA do que a regra manda.`);
  console.log(`   É o tamanho da correção se o histórico for re-consolidado — a produção CAI.`);
  console.log(`\n⚠️  Números para DECISÃO, não para reportar. Antes de aplicar qualquer coisa:`);
  console.log(`   (a) conferir 2 notas por tipo no portal da EDP (o padrão "Pix no WPA" foi`);
  console.log(`       validado só em L0/corte — outros tipos podem ter desfecho diferente);`);
  console.log(`   (b) avaliar a implicação contratual do que já foi reportado;`);
  console.log(`   (c) só então backfill-consolidate em dry-run e, com aprovação, --apply.\n`);
}

main()
  .then(async () => { try { const p = _getPool(); if (p && p.end) await p.end(); } catch (_) {} process.exit(0); })
  .catch(async (e) => { console.error(e); try { const p = _getPool(); if (p && p.end) await p.end(); } catch (_) {} process.exit(1); });
