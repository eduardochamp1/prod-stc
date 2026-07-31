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
           (r.note_id IS NOT NULL) AS rejeitada
      FROM uni u
      JOIN note_subcategorias sc ON sc.note_id = u.uuid::uuid
      LEFT JOIN note_rejections r ON r.note_id = u.uuid::uuid
     WHERE sc.sub_code = $4
     ORDER BY u.team_name, dia_conclusao NULLS LAST, u.numero`, [de, ate, siglas, sub]);

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
  console.error('   EQUIPE'.padEnd(15) + 'EXECUTADA'.padStart(10) + 'REJEITADA'.padStart(11) + 'CRUAS'.padStart(8));
  Object.entries(agg).sort().forEach(([eq, a]) =>
    console.error('   ' + eq.padEnd(12) + String(a.exec).padStart(10) + String(a.rej).padStart(11) + String(a.exec + a.rej).padStart(8)));
  console.error(`\n   EXECUTADA = o que o painel mostra como executado (exclui rejeitadas).`);
  console.error(`   CRUAS = todas as concluídas, incluindo as que foram rejeitadas depois.`);
  console.error(`\n→ Redirecione pra CSV e abra no Excel ao lado da folha do colaborador:`);
  console.error(`   node scripts/diag-listar-notas-subcat.js ${de} ${ate} ${sub} --equipes=EQ > /tmp/eq.csv`);
  console.error(`   Compare pelo NÚMERO da OS: o que ele tem e não está aqui (e vice-versa)`);
  console.error(`   é o que precisa de explicação — e vira caso concreto, não discussão de total.\n`);
}

main()
  .then(async () => { try { const p = _getPool(); if (p && p.end) await p.end(); } catch (_) {} process.exit(0); })
  .catch(async (e) => { console.error(e); try { const p = _getPool(); if (p && p.end) await p.end(); } catch (_) {} process.exit(1); });
