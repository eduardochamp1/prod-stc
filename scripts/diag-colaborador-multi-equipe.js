#!/usr/bin/env node
/**
 * scripts/diag-colaborador-multi-equipe.js — o MESMO colaborador aparece logado
 * em equipes DIFERENTES no período? Read-only.
 *
 * MOTIVAÇÃO (30/07/2026): na conferência da planilha manual de L0 (01→25/07) os
 * totais batiam (−5%) mas equipe a equipe os desvios eram grandes e nos DOIS
 * sentidos, quase se anulando em pares:
 *   ECTSJ87 −55 × ECTSJ80 +49 · ECTSJ92 −48 × ECTSJ83 +38 · ECTSJ86 −32 × ECTSJ90 +34
 * Já descartamos: regra rejeitada≠executada, buraco de dados, dupla contagem
 * entre equipes (1 em 12.587) e classificação de subcategoria (SF é 100% L0
 * nessas equipes). Sobra a hipótese operacional: a TURMA logou no CÓDIGO DE
 * OUTRA EQUIPE — a produção existe, mas sai atribuída ao crachá errado.
 *
 * Este script cruza os colaboradores dos snapshots com as equipes em que
 * apareceram. Colaborador em 2+ equipes = indício direto dessa troca.
 *
 * USO (na VM):
 *   node scripts/diag-colaborador-multi-equipe.js 2026-07-01 2026-07-25
 *   node scripts/diag-colaborador-multi-equipe.js 2026-07-01 2026-07-25 --equipes=ECTSJ80,ECTSJ87
 */

require('dotenv').config();
const { _getPool } = require('../services/pgShim');
const { getSiglas } = require('../services/equipesOficiais');

async function main() {
  const argv = process.argv.slice(2);
  const datas = argv.filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  if (!datas.length) {
    console.error('✖ Uso: node scripts/diag-colaborador-multi-equipe.js <de> [<ate>] [--equipes=A,B]');
    process.exit(1);
  }
  const de = datas[0], ate = datas[1] || datas[0];
  const eqFlag = argv.find(a => a.startsWith('--equipes='));
  const filtroEquipes = eqFlag ? eqFlag.split('=')[1].split(',').map(s => s.trim().toUpperCase()).filter(Boolean) : null;
  const pool = _getPool();
  const siglas = filtroEquipes || getSiglas();

  // (colaborador, equipe, dia) distintos a partir de collaborators dos snapshots
  const { rows } = await pool.query(`
    WITH colab AS (
      SELECT DISTINCT
             (c->>'matricula') AS matricula,
             (c->>'nome')      AS nome,
             s.team_name,
             s.date
        FROM snapshots s
        CROSS JOIN LATERAL jsonb_array_elements(
               CASE WHEN jsonb_typeof(s.data->'collaborators') = 'array'
                    THEN s.data->'collaborators' ELSE '[]'::jsonb END) c
       WHERE s.date BETWEEN $1::date AND $2::date
         AND s.team_name = ANY($3::text[])
         AND (c->>'matricula') IS NOT NULL AND (c->>'matricula') <> '—'
    )
    SELECT matricula,
           MAX(nome) AS nome,
           COUNT(DISTINCT team_name)::int AS n_equipes,
           COUNT(DISTINCT date)::int      AS n_dias,
           string_agg(DISTINCT team_name, ', ' ORDER BY team_name) AS equipes
      FROM colab
     GROUP BY matricula
     ORDER BY n_equipes DESC, nome`, [de, ate, siglas]);

  const multi = rows.filter(r => r.n_equipes > 1);
  console.log(`\n👷 Colaboradores × equipes · ${de} → ${ate}`);
  console.log(`   (${siglas.length} equipes no recorte)\n`);
  console.log(`   colaboradores distintos ......... ${rows.length}`);
  console.log(`   em 2+ equipes no período ........ ${multi.length}` +
    (rows.length ? ` (${(100 * multi.length / rows.length).toFixed(1)}%)` : ''));
  console.log('');

  if (!multi.length) {
    console.log('✅ Nenhum colaborador apareceu em mais de uma equipe.');
    console.log('   A hipótese "turma logou no código de outra equipe" NÃO se sustenta.\n');
    return;
  }

  console.log('MATRÍCULA'.padEnd(12) + 'NOME'.padEnd(26) + 'EQ'.padStart(3) + 'DIAS'.padStart(6) + '  EQUIPES');
  console.log('-'.repeat(96));
  for (const r of multi.slice(0, 60)) {
    console.log(String(r.matricula).padEnd(12) + String(r.nome || '').slice(0, 24).padEnd(26)
      + String(r.n_equipes).padStart(3) + String(r.n_dias).padStart(6) + '  ' + r.equipes);
  }
  console.log('-'.repeat(96));
  if (multi.length > 60) console.log(`... e mais ${multi.length - 60}.`);
  console.log(`\n→ Colaborador em 2+ equipes NÃO é necessariamente erro: remanejamento e`);
  console.log(`  cobertura de férias são normais. O que interessa é o PAR de equipes com`);
  console.log(`  desvio espelhado na planilha (ex.: ECTSJ87 −55 × ECTSJ80 +49). Se a mesma`);
  console.log(`  turma aparece nesses dois códigos, a produção saiu no crachá errado —`);
  console.log(`  aí é ajuste OPERACIONAL (login correto), não bug do sistema.\n`);
}

main()
  .then(async () => { try { const p = _getPool(); if (p && p.end) await p.end(); } catch (_) {} process.exit(0); })
  .catch(async (e) => { console.error(e); try { const p = _getPool(); if (p && p.end) await p.end(); } catch (_) {} process.exit(1); });
