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
           rj.n_rej, rj.rej_at, to_char(rj.rej_day,'YYYY-MM-DD') AS rej_day,
           CASE WHEN u.cd ~ '^\\d{4}-\\d{2}-\\d{2}' THEN u.cd::timestamptz ELSE NULL END AS conc_at
      FROM uni u
      JOIN note_subcategorias sc ON sc.note_id = u.uuid::uuid
      LEFT JOIN LATERAL (   -- agregado: 1 linha por nota, sem multiplicar
        -- ⚠️ rej_at = SÓ rejection_date real. NÃO cair pra session_date: ele é
        -- DATE (meia-noite) e faria toda rejeição sem hora parecer ANTERIOR a
        -- uma conclusão às 22:40 — foi o erro da versão anterior (REJ_APOS=0 em
        -- tudo). Sem hora, o dia (rej_day) decide; empate no dia = indeterminado.
        SELECT COUNT(*)::int AS n_rej,
               MAX(r.rejection_date) AS rej_at,
               MAX(r.session_date)   AS rej_day
          FROM note_rejections r WHERE r.note_id = u.uuid::uuid
      ) rj ON TRUE
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
  // Classifica pela ORDEM NO TEMPO (o ponto central):
  //   EXECUTADA  = nunca teve rejeição → produção
  //   REJ_ANTES  = rejeição ANTERIOR à conclusão → nota devolvida e REFEITA,
  //                terminou executada → CONTA como produção (painel está certo)
  //   REJ_APOS   = rejeição POSTERIOR à conclusão → concluiu e a EDP rejeitou
  //                depois → NÃO é produção. Se o consolidado já contou, o painel
  //                está SUPERESTIMANDO (rejeição tardia nunca descontada).
  //   REJ_S_DATA = tem rejeição mas falta data pra decidir → investigar à mão
  const classificar = (r) => {
    if (!r.n_rej) return 'EXECUTADA';
    // 1) Melhor evidência: horário real da rejeição × horário da conclusão.
    if (r.rej_at && r.conc_at) {
      return (new Date(r.rej_at) > new Date(r.conc_at)) ? 'REJ_APOS' : 'REJ_ANTES';
    }
    // 2) Sem horário da rejeição: compara só os DIAS. Mesmo dia → indeterminado.
    if (r.rej_day && r.dia_conclusao) {
      if (r.rej_day > r.dia_conclusao) return 'REJ_APOS';
      if (r.rej_day < r.dia_conclusao) return 'REJ_ANTES';
      return 'REJ_S_DATA';               // mesmo dia, sem hora → não dá pra saber
    }
    return 'REJ_S_DATA';
  };

  console.log('equipe;numero;dia_conclusao;dia_snapshot;classificacao;n_rejeicoes;uuid');
  for (const r of rows) {
    console.log([r.team_name, r.numero || '', r.dia_conclusao || '', r.dia_snapshot,
      classificar(r), r.n_rej || 0, r.uuid].join(';'));
  }
  // Resumo no stderr pra não sujar o CSV quando redirecionar pra arquivo
  const agg = {};
  for (const r of rows) {
    const a = agg[r.team_name] || (agg[r.team_name] = { exec: 0, antes: 0, apos: 0, semData: 0 });
    const c = classificar(r);
    if (c === 'EXECUTADA') a.exec++;
    else if (c === 'REJ_ANTES') a.antes++;
    else if (c === 'REJ_APOS') a.apos++;
    else a.semData++;
  }
  // Quão resolvível é a ordem? (rejeição com horário real × só com dia)
  const comRej = rows.filter(r => r.n_rej > 0);
  const comHora = comRej.filter(r => r.rej_at).length;
  console.error(`\n🕐 Rejeições: ${comRej.length} nota(s) com registro · ${comHora} com HORÁRIO`
    + ` (${comRej.length ? Math.round(100 * comHora / comRej.length) : 0}%)`
    + ` · ${comRej.length - comHora} só com o dia`);

  console.error(`\n📄 ${rows.length} nota(s) ${sub} concluídas · ${de} → ${ate}`);
  console.error('   EQUIPE'.padEnd(15) + 'S/REJ'.padStart(7) + 'REFEITA'.padStart(8)
    + 'REJ_APOS'.padStart(9) + 'S/DATA'.padStart(7) + ' | ' + 'ESPERADO'.padStart(9)
    + 'PAINEL'.padStart(7) + '   Δ');
  let tot = { exec: 0, antes: 0, apos: 0, semData: 0, esp: 0, pnl: 0 };
  Object.entries(agg).sort().forEach(([eq, a]) => {
    const esperado = a.exec + a.antes;      // produção: nunca rejeitada + refeita
    const p = painel[eq] || 0;
    tot.exec += a.exec; tot.antes += a.antes; tot.apos += a.apos; tot.semData += a.semData;
    tot.esp += esperado; tot.pnl += p;
    console.error('   ' + eq.padEnd(12) + String(a.exec).padStart(7) + String(a.antes).padStart(8)
      + String(a.apos).padStart(9) + String(a.semData).padStart(7) + ' | ' + String(esperado).padStart(9)
      + String(p).padStart(7) + '   ' + (p - esperado > 0 ? '+' : '') + (p - esperado));
  });
  console.error('   ' + '-'.repeat(70));
  console.error('   ' + 'TOTAL'.padEnd(12) + String(tot.exec).padStart(7) + String(tot.antes).padStart(8)
    + String(tot.apos).padStart(9) + String(tot.semData).padStart(7) + ' | ' + String(tot.esp).padStart(9)
    + String(tot.pnl).padStart(7) + '   ' + (tot.pnl - tot.esp > 0 ? '+' : '') + (tot.pnl - tot.esp));

  console.error(`\n   S/REJ    = concluída, nunca rejeitada → produção`);
  console.error(`   REFEITA  = rejeitada ANTES de concluir (devolvida e refeita) → produção`);
  console.error(`   REJ_APOS = concluída e rejeitada DEPOIS → NÃO é produção`);
  console.error(`   S/DATA   = tem rejeição mas falta data pra decidir → conferir à mão`);
  console.error(`   ESPERADO = S/REJ + REFEITA · PAINEL = team_daily_subcat_totals`);
  if (tot.apos > 0) {
    console.error(`\n⚠️  ${tot.apos} nota(s) concluídas foram REJEITADAS DEPOIS.`);
    if (tot.pnl - tot.esp > 0) {
      console.error(`   E o painel está ${tot.pnl - tot.esp} acima do esperado → parte dessas`);
      console.error(`   rejeições tardias NÃO foi descontada da produção consolidada. O sweep`);
      console.error(`   noturno só reprocessa D-1..D-7, então rejeição que chega depois fica`);
      console.error(`   fora. Isso SUPERESTIMA o executado reportado. Confirmar e re-consolidar.`);
    } else {
      console.error(`   Mas o painel NÃO está acima do esperado — as rejeições tardias já`);
      console.error(`   foram descontadas na consolidação. Nada a corrigir aqui.`);
    }
  }
  if (tot.semData > 0) {
    console.error(`\n   ⚠️ ${tot.semData} nota(s) sem data pra decidir a ordem — não entram em`);
    console.error(`      nenhuma conclusão acima. Ver classificacao=REJ_S_DATA no CSV.`);
  }
  console.error(`\n→ Redirecione pra CSV e abra no Excel ao lado da folha do colaborador:`);
  console.error(`   node scripts/diag-listar-notas-subcat.js ${de} ${ate} ${sub} --equipes=EQ > /tmp/eq.csv`);
  console.error(`   Compare pelo NÚMERO da OS: o que ele tem e não está aqui (e vice-versa)`);
  console.error(`   é o que precisa de explicação — e vira caso concreto, não discussão de total.\n`);
}

main()
  .then(async () => { try { const p = _getPool(); if (p && p.end) await p.end(); } catch (_) {} process.exit(0); })
  .catch(async (e) => { console.error(e); try { const p = _getPool(); if (p && p.end) await p.end(); } catch (_) {} process.exit(1); });
