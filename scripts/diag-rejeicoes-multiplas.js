#!/usr/bin/env node
/**
 * scripts/diag-rejeicoes-multiplas.js
 *
 * MEDE o tamanho do P0-8 antes de migrar nada. READ-ONLY.
 *
 * O problema: `note_rejections` tem PK = (note_id). Uma nota rejeitada por DUAS
 * equipes (ou pela mesma equipe em dois dias) guarda UMA linha só — a última
 * gravada sobrescreve a anterior. Isso importa porque `_rejIndexByNote`
 * (services/dataWriter.js) monta a chave `note_id|team_name` como se pudesse
 * haver várias equipes por nota, e a regra vigente (31/07/2026) diz que a
 * rejeição conta para a equipe que rejeitou, e a execução só para quem
 * finalizou 100%. Com uma linha só, a rejeição da primeira equipe desaparece e
 * a nota volta a contar como produção dela.
 *
 * Como medir, então, se a tabela não guarda o caso? Pelos SNAPSHOTS, que são
 * retidos para sempre (decisão 07/07/2026): cada snapshot traz
 * `data->notasRejeitadas` por equipe/dia, então a evidência do caso está lá.
 *
 * O que este script responde:
 *   1. quantas notas foram rejeitadas por 2+ EQUIPES distintas;
 *   2. quantas foram rejeitadas em 2+ DIAS distintos (mesma equipe ou não);
 *   3. quantas dessas foram depois CONCLUÍDAS, e por quem — o subconjunto que
 *      de fato distorce produção;
 *   4. quantas linhas `note_rejections` existem hoje para essas notas (deve ser
 *      1 por nota — é a confirmação do sobrescrito).
 *
 * Uso (na VM, onde o .env vive):
 *   node -r dotenv/config scripts/diag-rejeicoes-multiplas.js
 *   node -r dotenv/config scripts/diag-rejeicoes-multiplas.js --de 2026-06-01 --ate 2026-08-20
 *   node -r dotenv/config scripts/diag-rejeicoes-multiplas.js --csv /tmp/rej-multiplas.csv
 *
 * Não escreve nada no banco. Só SELECT.
 */

const fs = require('fs');

function arg(nome, padrao = null) {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}

const DE  = arg('de',  '2026-04-25');   // início da cobertura de coleta
const ATE = arg('ate', null);           // null = hoje
const CSV = arg('csv', null);

function ymd(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  return new Date(d).toISOString().slice(0, 10);
}

async function main() {
  const { _getPool } = require('../services/pgShim');
  const pool = _getPool();
  if (!pool) {
    console.error('Sem pool Postgres. Rode com `node -r dotenv/config` na VM (DATABASE_URL vive no .env).');
    process.exit(1);
  }

  const ate = ATE || new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  console.log(`\n=== P0-8 — rejeições múltiplas por nota ===`);
  console.log(`janela: ${DE} → ${ate}  (read-only)\n`);

  // ── 1. Varre os snapshots extraindo (note_id, team_name, dia) das rejeitadas.
  //    jsonb_array_elements no servidor: evita trazer o payload inteiro pra cá.
  const { rows: rejRows } = await pool.query(
    `SELECT DISTINCT
            (n->>'id')      AS note_id,
            s.team_name     AS team_name,
            s.date::text    AS dia,
            (n->>'codigo')  AS codigo
       FROM snapshots s,
            jsonb_array_elements(coalesce(s.data->'notasRejeitadas', '[]'::jsonb)) AS n
      WHERE s.date BETWEEN $1::date AND $2::date
        AND n->>'id' IS NOT NULL`,
    [DE, ate]
  );
  console.log(`pares (nota, equipe, dia) distintos em notasRejeitadas: ${rejRows.length}`);

  // ── 2. Agrupa por nota.
  const porNota = new Map();   // note_id → { codigo, equipes:Set, dias:Set, pares:[] }
  for (const r of rejRows) {
    let e = porNota.get(r.note_id);
    if (!e) {
      e = { codigo: r.codigo, equipes: new Set(), dias: new Set(), pares: [] };
      porNota.set(r.note_id, e);
    }
    e.equipes.add(r.team_name);
    e.dias.add(ymd(r.dia));
    e.pares.push({ equipe: r.team_name, dia: ymd(r.dia) });
  }
  console.log(`notas distintas com rejeição: ${porNota.size}`);

  const multiEquipe = [...porNota.entries()].filter(([, v]) => v.equipes.size > 1);
  const multiDia    = [...porNota.entries()].filter(([, v]) => v.dias.size > 1);

  console.log(`\n── ACHADO PRINCIPAL ──`);
  console.log(`notas rejeitadas por 2+ EQUIPES distintas: ${multiEquipe.length}`);
  console.log(`notas rejeitadas em 2+ DIAS distintos:     ${multiDia.length}`);

  const afetadas = new Map([...multiEquipe, ...multiDia]);
  if (afetadas.size === 0) {
    console.log(`\nNenhuma nota com rejeição múltipla na janela. O P0-8 é um risco`);
    console.log(`ESTRUTURAL (o schema não representa o caso) mas ainda sem impacto`);
    console.log(`medido — a migração pode ser tratada como preventiva.\n`);
    await pool.end();
    return;
  }

  // ── 3. Dessas, quais foram CONCLUÍDAS depois — e por quem.
  const ids = [...afetadas.keys()];
  const { rows: concRows } = await pool.query(
    `SELECT DISTINCT
            (n->>'id')   AS note_id,
            s.team_name  AS team_name,
            s.date::text AS dia
       FROM snapshots s,
            jsonb_array_elements(coalesce(s.data->'notasConcluidas', '[]'::jsonb)) AS n
      WHERE s.date BETWEEN $1::date AND $2::date
        AND (n->>'id') = ANY($3::text[])`,
    [DE, ate, ids]
  );
  const concPorNota = new Map();
  for (const r of concRows) {
    if (!concPorNota.has(r.note_id)) concPorNota.set(r.note_id, []);
    concPorNota.get(r.note_id).push({ equipe: r.team_name, dia: ymd(r.dia) });
  }

  // Distorção real = a nota foi concluída por UMA equipe, e OUTRA equipe a
  // rejeitou — a rejeição dessa outra é que pode ter sido sobrescrita.
  let distorcem = 0;
  for (const [id, v] of afetadas) {
    const conc = concPorNota.get(id) || [];
    if (conc.length === 0) continue;
    const equipesConc = new Set(conc.map(c => c.equipe));
    const rejDeOutra = [...v.equipes].some(eq => !equipesConc.has(eq));
    if (rejDeOutra) distorcem++;
  }
  console.log(`\ndessas, também CONCLUÍDAS na janela:        ${concPorNota.size}`);
  console.log(`com rejeição de equipe ≠ da que concluiu:  ${distorcem}  ← distorcem produção`);

  // ── 4. Confirma o sobrescrito: quantas linhas note_rejections existem hoje.
  const { rows: nrRows } = await pool.query(
    `SELECT note_id, count(*)::int AS linhas
       FROM note_rejections
      WHERE note_id = ANY($1::uuid[])
      GROUP BY note_id`,
    [ids]
  );
  const comLinha = nrRows.length;
  const comMaisDeUma = nrRows.filter(r => r.linhas > 1).length;
  console.log(`\n── CONFIRMAÇÃO DO SOBRESCRITO ──`);
  console.log(`notas afetadas presentes em note_rejections: ${comLinha}/${ids.length}`);
  console.log(`dessas, com mais de 1 linha:                 ${comMaisDeUma} (esperado: 0, pela PK)`);
  if (comMaisDeUma === 0 && comLinha > 0) {
    console.log(`→ confirmado: a PK (note_id) está colapsando ${comLinha} casos em 1 linha cada.`);
  }

  // ── 5. Amostra pra conferir no portal WPA.
  console.log(`\n── AMOSTRA (até 15, pra conferir no portal) ──`);
  let i = 0;
  for (const [id, v] of afetadas) {
    if (i++ >= 15) break;
    const conc = concPorNota.get(id) || [];
    const rej = v.pares.map(p => `${p.equipe}@${p.dia}`).join(', ');
    const cc  = conc.map(c => `${c.equipe}@${c.dia}`).join(', ') || '—';
    console.log(`  ${v.codigo || id}`);
    console.log(`    rejeitada: ${rej}`);
    console.log(`    concluída: ${cc}`);
  }

  if (CSV) {
    const linhas = ['codigo,note_id,equipes_rejeicao,dias_rejeicao,equipes_conclusao'];
    for (const [id, v] of afetadas) {
      const conc = (concPorNota.get(id) || []).map(c => c.equipe);
      linhas.push([
        v.codigo || '',
        id,
        `"${[...v.equipes].join('|')}"`,
        `"${[...v.dias].sort().join('|')}"`,
        `"${[...new Set(conc)].join('|')}"`,
      ].join(','));
    }
    fs.writeFileSync(CSV, linhas.join('\n') + '\n');
    console.log(`\nCSV: ${CSV} (${afetadas.size} linhas)`);
  }

  console.log(`\n── LEITURA DO RESULTADO ──`);
  console.log(`Se "distorcem produção" > 0, a migração do P0-8 (PK composta) é`);
  console.log(`corretiva e exige re-consolidação dos meses afetados — meça o delta`);
  console.log(`em dry-run ANTES de aplicar, como fizemos no P1-16.`);
  console.log(`Se for 0, a migração é preventiva e pode entrar sem re-consolidar.\n`);

  await pool.end();
}

main().catch(err => {
  console.error('ERRO:', err.message);
  process.exit(1);
});
