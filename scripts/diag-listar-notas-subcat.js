#!/usr/bin/env node
/**
 * scripts/diag-listar-notas-subcat.js — lista NOTA A NOTA (número + UUID) as
 * concluídas de uma subcategoria, por equipe e dia. Read-only. Saída CSV.
 *
 * PARA QUE SERVE (30/07/2026): encerrar o questionamento da planilha manual de
 * L0 (01→25/07). Já verificamos que nossos números são internamente
 * consistentes — sem buraco de dados, sem dupla contagem entre equipes (1 em
 * 12.587) e sem ambiguidade de subcategoria (SF é 100% L0 nessas equipes). O que
 * resta é comparar NOTA POR NOTA com a folha do colaborador: com o número da OS
 * na mão, a conversa deixa de ser "meu total x seu total".
 *
 * A nota conta 1x (dedup por UUID). `dia_conclusao` vem do conclusionDate da
 * própria nota; `dia_snapshot` é o dia em que ela apareceu no payload — quando
 * divergem, é nota concluída num dia e carregada no payload de outro
 * (vira-noite / equipe que relogou).
 *
 * USO (na VM):
 *   node scripts/diag-listar-notas-subcat.js 2026-07-01 2026-07-25 L0 --equipes=ECTSJ87
 *   node scripts/diag-listar-notas-subcat.js 2026-07-01 2026-07-25 L0 --equipes=ECTSJ87 > /tmp/ectsj87.csv
 */

require('dotenv').config();
const { _getPool } = require('../services/pgShim');
const { getSiglas } = require('../services/equipesOficiais');

async function main() {
  const argv = process.argv.slice(2);
  const datas = argv.filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const sub = argv.find(a => !a.startsWith('--') && !/^\d{4}-\d{2}-\d{2}$/.test(a)) || 'L0';
  if (!datas.length) {
    console.error('✖ Uso: node scripts/diag-listar-notas-subcat.js <de> [<ate>] [SUB_CODE] [--equipes=A,B]');
    process.exit(1);
  }
  const de = datas[0], ate = datas[1] || datas[0];
  const eqFlag = argv.find(a => a.startsWith('--equipes='));
  const siglas = eqFlag
    ? eqFlag.split('=')[1].split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    : getSiglas();

  const pool = _getPool();
  const { rows } = await pool.query(`
    WITH conc AS (
      SELECT (n->>'id') AS uuid, (n->>'codigo') AS numero, s.team_name,
             s.date AS snap_date, (n->>'conclusionDate') AS cd
        FROM snapshots s
        CROSS JOIN LATERAL jsonb_array_elements(
               CASE WHEN jsonb_typeof(s.data->'notasConcluidas') = 'array'
                    THEN s.data->'notasConcluidas' ELSE '[]'::jsonb END) n
       WHERE s.date BETWEEN $1::date AND $2::date
         AND s.team_name = ANY($3::text[])
         AND (n->>'id') IS NOT NULL
    ),
    uni AS (   -- 1 linha por nota (dedup por UUID)
      SELECT uuid, MAX(numero) AS numero, MIN(team_name) AS team_name,
             MIN(snap_date) AS snap_date, MAX(cd) AS cd
        FROM conc GROUP BY uuid
    )
    SELECT u.numero, u.uuid, u.team_name,
           CASE WHEN u.cd ~ '^\\d{4}-\\d{2}-\\d{2}' THEN substring(u.cd,1,10) ELSE NULL END AS dia_conclusao,
           to_char(u.snap_date,'YYYY-MM-DD') AS dia_snapshot,
           EXISTS (SELECT 1 FROM note_rejections r WHERE r.note_id = u.uuid::uuid) AS rejeitada
      FROM uni u
      JOIN note_subcategorias sc ON sc.note_id = u.uuid::uuid
     WHERE sc.sub_code = $4
     ORDER BY u.team_name, dia_conclusao NULLS LAST, u.numero`, [de, ate, siglas, sub]);
  // ⚠️ EXISTS (não LEFT JOIN): note_rejections pode ter mais de uma linha por
  // note_id (re-rejeição), e o JOIN multiplicava a nota na lista — inflando
  // CRUAS. Bug da 1ª versão, corrigido em 30/07/2026.

  // Painel (team_daily_subcat_totals) pra AUTO-VALIDAÇÃO: se a coluna EXECUTADA
  // desta lista divergir do painel, a causa mais provável é REJEIÇÃO TARDIA —
  // a EDP rejeitou depois da consolidação do dia, e o consolidado não foi
  // refeito (o sweep noturno só reprocessa D-1..D-7). Ver nota no rodapé.
  const painel = (await pool.query(`
    SELECT team_name, SUM(count)::int AS n
      FROM team_daily_subcat_totals
     WHERE date BETWEEN $1::date AND $2::date AND sub_code = $3
       AND team_name = ANY($4::text[])
     GROUP BY team_name`, [de, ate, sub, siglas])).rows
    .reduce((a, r) => (a[r.team_name] = r.n, a), {});

  // CSV com ; (Excel pt-BR abre direto).
  // conta_como reproduz a regra do painel (20/07/2026): nota concluída que a EDP
  // REJEITOU não é produção — conta só em Rejeitadas. Por isso a soma de
  // "EXECUTADA" aqui bate com o EXECUTADO do painel, e o total de linhas (todas
  // as concluídas cruas) é MAIOR. É exatamente aqui que um levantamento manual
  // divergir se contar a mesma nota nas duas colunas.
  console.log('equipe;numero;dia_conclusao;dia_snapshot;conta_como;uuid');
  for (const r of rows) {
    console.log([r.team_name, r.numero || '', r.dia_conclusao || '', r.dia_snapshot,
      r.rejeitada ? 'REJEITADA' : 'EXECUTADA', r.uuid].join(';'));
  }
  // Resumo no stderr pra não sujar o CSV quando redirecionar pra arquivo
  const agg = {};
  for (const r of rows) {
    const a = agg[r.team_name] || (agg[r.team_name] = { exec: 0, rej: 0 });
    r.rejeitada ? a.rej++ : a.exec++;
  }
  console.error(`\n📄 ${rows.length} nota(s) ${sub} concluídas (cruas) · ${de} → ${ate}`);
  console.error('   EQUIPE'.padEnd(15) + 'EXEC_HOJE'.padStart(10) + 'REJEITADA'.padStart(11)
    + 'CRUAS'.padStart(8) + 'PAINEL'.padStart(8) + '  Δ(painel−exec_hoje)');
  let divergentes = 0;
  Object.entries(agg).sort().forEach(([eq, a]) => {
    const p = painel[eq] || 0;
    const d = p - a.exec;
    if (d !== 0) divergentes++;
    console.error('   ' + eq.padEnd(12) + String(a.exec).padStart(10) + String(a.rej).padStart(11)
      + String(a.exec + a.rej).padStart(8) + String(p).padStart(8)
      + '  ' + (d > 0 ? '+' : '') + d);
  });
  console.error(`\n   EXEC_HOJE = concluídas que NÃO constam em note_rejections HOJE.`);
  console.error(`   REJEITADA = concluídas que constam em note_rejections (a qualquer tempo).`);
  console.error(`   CRUAS     = todas as concluídas (EXEC_HOJE + REJEITADA).`);
  console.error(`   PAINEL    = team_daily_subcat_totals (o que o painel/EDP mostra hoje).`);
  if (divergentes) {
    console.error(`\n⚠️  ${divergentes} equipe(s) com PAINEL > EXEC_HOJE. Causa mais provável:`);
    console.error(`   REJEIÇÃO TARDIA — a EDP rejeitou a nota DEPOIS da consolidação do dia.`);
    console.error(`   O consolidado guarda o estado do dia e o sweep noturno só reprocessa`);
    console.error(`   D-1..D-7, então rejeição que chega mais tarde nunca é descontada da`);
    console.error(`   produção. Ou seja: o painel pode estar SUPERESTIMANDO o executado.`);
    console.error(`   Verificar e, se confirmado, re-consolidar o período (muda número EDP).`);
  }
  console.error(`\n→ Redirecione pra CSV e abra no Excel ao lado da folha do colaborador:`);
  console.error(`   node scripts/diag-listar-notas-subcat.js ${de} ${ate} ${sub} --equipes=EQ > /tmp/eq.csv`);
  console.error(`   Compare pelo NÚMERO da OS: o que ele tem e não está aqui (e vice-versa)`);
  console.error(`   é o que precisa de explicação — e vira caso concreto, não discussão de total.\n`);
}

main()
  .then(async () => { try { const p = _getPool(); if (p && p.end) await p.end(); } catch (_) {} process.exit(0); })
  .catch(async (e) => { console.error(e); try { const p = _getPool(); if (p && p.end) await p.end(); } catch (_) {} process.exit(1); });
