#!/usr/bin/env node
/**
 * scripts/diag-notas-multi-equipe.js — a MESMA nota concluída está sendo
 * contada para MAIS DE UMA equipe? Read-only.
 *
 * PERGUNTA DE NEGÓCIO (José, 30/07/2026): "a nota tem que contar para a equipe
 * que EXECUTOU a nota — essa nota conta como executada para as duas equipes?"
 *
 * COMO O SISTEMA FUNCIONA HOJE: _aggregateTeamDailyTotals agrupa por
 * (notaDate, equipe, tipo) e deduplica por UUID DENTRO dessa chave — isso
 * resolve o relogin (mesma nota reaparecendo em várias sessões da MESMA equipe).
 * NÃO há dedup ENTRE equipes: se o UUID aparecer no payload de duas equipes,
 * ele conta para as duas. Este script mede se isso acontece de fato e qual o
 * impacto (contagens extras).
 *
 * Precedente: a carteira inicial JÁ passou por isso — task "deduplicar
 * carteiraInicialReal via UUIDs (446 OS fantasma)" existiu porque notas
 * transferidas entre equipes apareciam em duas.
 *
 * USO (na VM):
 *   node scripts/diag-notas-multi-equipe.js 2026-07-01 2026-07-25
 *   node scripts/diag-notas-multi-equipe.js 2026-07-20 2026-07-20 --exemplos=30
 */

require('dotenv').config();
const { _getPool } = require('../services/pgShim');
const { getSiglas } = require('../services/equipesOficiais');

async function main() {
  const argv = process.argv.slice(2);
  const datas = argv.filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  if (!datas.length) {
    console.error('✖ Uso: node scripts/diag-notas-multi-equipe.js <de> [<ate>] [--exemplos=N]');
    process.exit(1);
  }
  const de = datas[0], ate = datas[1] || datas[0];
  const exFlag = argv.find(a => a.startsWith('--exemplos='));
  const nEx = exFlag ? Math.max(1, parseInt(exFlag.split('=')[1], 10) || 20) : 20;

  const pool = _getPool();
  const siglas = getSiglas();            // whitelist (mesmo recorte do painel)

  // Notas CONCLUÍDAS no período (só equipes oficiais).
  // ⚠️ n_eq usa COUNT(DISTINCT team_name). A 1ª versão deste script fazia
  // SELECT DISTINCT (team_name, uuid, numero) e contava linhas — quando o mesmo
  // (equipe, uuid) vinha com `codigo` diferente entre snapshots (um vazio, outro
  // preenchido) saíam 2 linhas e a MESMA equipe aparecia como "2 equipes",
  // gerando falso positivo de dupla contagem (visto em 30/07/2026:
  // "EPMRT31, EPMRT31"). Contar equipes DISTINTAS é o certo.
  const base = `
    WITH conc AS (
      SELECT s.team_name, (n->>'id') AS uuid, (n->>'codigo') AS numero
        FROM snapshots s
        CROSS JOIN LATERAL jsonb_array_elements(
               CASE WHEN jsonb_typeof(s.data->'notasConcluidas') = 'array'
                    THEN s.data->'notasConcluidas' ELSE '[]'::jsonb END) n
       WHERE s.date BETWEEN $1::date AND $2::date
         AND s.team_name = ANY($3::text[])
         AND (n->>'id') IS NOT NULL
    ),
    porNota AS (
      SELECT uuid,
             MAX(numero) AS numero,
             COUNT(DISTINCT team_name)::int AS n_eq,
             string_agg(DISTINCT team_name, ', ' ORDER BY team_name) AS equipes
        FROM conc GROUP BY uuid
    )`;

  const resumo = (await pool.query(`${base}
    SELECT COUNT(*)::int AS notas_distintas,
           COUNT(*) FILTER (WHERE n_eq > 1)::int AS notas_em_2_ou_mais,
           COALESCE(SUM(n_eq - 1) FILTER (WHERE n_eq > 1), 0)::int AS contagens_extras,
           COALESCE(SUM(n_eq), 0)::int AS total_contagens
      FROM porNota`, [de, ate, siglas])).rows[0];

  const exemplos = (await pool.query(`${base}
    SELECT numero, uuid, n_eq, equipes FROM porNota
     WHERE n_eq > 1 ORDER BY n_eq DESC, numero LIMIT ${nEx}`, [de, ate, siglas])).rows;

  const { notas_distintas, notas_em_2_ou_mais, contagens_extras, total_contagens } = resumo;
  const pct = total_contagens > 0 ? (100 * contagens_extras / total_contagens) : 0;

  console.log(`\n🔎 Notas concluídas contadas para MAIS DE UMA equipe · ${de} → ${ate}`);
  console.log(`   (whitelist: ${siglas.length} equipes oficiais)\n`);
  console.log(`   notas distintas (por UUID) ............ ${notas_distintas}`);
  console.log(`   notas em 2+ equipes .................. ${notas_em_2_ou_mais}`);
  console.log(`   CONTAGENS EXTRAS (inflação) .......... ${contagens_extras}`);
  console.log(`   total de contagens equipe×nota ....... ${total_contagens}`);
  console.log(`   → inflação sobre o total ............. ${pct.toFixed(2)}%\n`);

  if (exemplos.length) {
    console.log(`Exemplos (até ${nEx}):`);
    console.log('NOTA'.padEnd(14) + 'EQ'.padStart(3) + '  EQUIPES');
    console.log('-'.repeat(60));
    exemplos.forEach(r => console.log(String(r.numero || r.uuid).padEnd(14) + String(r.n_eq).padStart(3) + '  ' + r.equipes));
    console.log('-'.repeat(60));
    // Dimensiona antes de concluir: 1 caso em 12 mil é ruído; % alto é sistêmico.
    if (pct >= 1) {
      console.log(`\n→ DUPLA CONTAGEM SIGNIFICATIVA (${pct.toFixed(2)}% do total).`);
      console.log(`  Viola a regra "a nota conta pra quem EXECUTOU" e pode explicar desvios`);
      console.log(`  por equipe nos dois sentidos. Definir critério de desempate + re-consolidar.`);
    } else {
      console.log(`\n→ Casos ISOLADOS (${notas_em_2_ou_mais} em ${notas_distintas} = ${pct.toFixed(2)}%).`);
      console.log(`  A atribuição é praticamente exclusiva: NÃO explica desvios grandes por`);
      console.log(`  equipe. Vale investigar as notas acima uma a uma, mas a causa de uma`);
      console.log(`  divergência de dezenas de OS está em outro lugar.`);
    }
  } else {
    console.log(`✅ Nenhuma nota concluída aparece em 2+ equipes no período.`);
    console.log(`   A atribuição é exclusiva — a divergência da planilha vem de outro lugar.`);
  }
  console.log('');
}

main()
  .then(async () => { try { const p = _getPool(); if (p && p.end) await p.end(); } catch (_) {} process.exit(0); })
  .catch(async (e) => { console.error(e); try { const p = _getPool(); if (p && p.end) await p.end(); } catch (_) {} process.exit(1); });
