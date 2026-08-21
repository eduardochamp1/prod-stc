#!/usr/bin/env node
/**
 * scripts/diag-rejeicoes-datas.js
 *
 * SEGUNDA medição do P0-8. READ-ONLY.
 *
 * Por que existe: o `diag-rejeicoes-multiplas.js` mediu a hipótese "nota
 * rejeitada pela equipe A e concluída pela equipe B" e achou **zero** casos em
 * 19.573 notas rejeitadas (jun–ago/2026). Mas aquele script testou só metade do
 * problema. O que ele encontrou foi outra coisa: 395 notas rejeitadas em DOIS
 * dias distintos, sempre pela MESMA equipe.
 *
 * E isso ainda pode mudar número, por um caminho diferente do que eu supus:
 *
 *   `_contaComoExecutada(diasRejeicao, notaDate)` devolve produção quando
 *   NENHUM dia de rejeição é >= o dia da nota. Com a PK = (note_id), só UM dos
 *   dois dias de rejeição sobrevive em `note_rejections`. Se o dia que sobreviveu
 *   é o mais ANTIGO e a conclusão caiu depois dele, a função vê
 *   "rejeição antes da conclusão" → conta como PRODUÇÃO. Com os dois dias
 *   presentes, o dia mais recente poderia suprimir a mesma nota.
 *
 * Este script simula as duas situações com as funções REAIS do dataWriter e
 * conta em quantas notas o resultado difere. Esse é o número que decide se a
 * migração do P0-8 é corretiva (exige re-consolidação) ou preventiva.
 *
 * Uso (na VM):
 *   node -r dotenv/config scripts/diag-rejeicoes-datas.js
 *   node -r dotenv/config scripts/diag-rejeicoes-datas.js --de 2026-06-01 --ate 2026-08-21
 */

function arg(nome, padrao = null) {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}

const DE  = arg('de',  '2026-06-01');
const ATE = arg('ate', null);

const ymd = d => (d ? (typeof d === 'string' ? d.slice(0, 10)
                                             : new Date(d).toISOString().slice(0, 10)) : null);

async function main() {
  const { _getPool } = require('../services/pgShim');
  const { _contaComoExecutada } = require('../services/dataWriter');
  const pool = _getPool();
  if (!pool) {
    console.error('Sem pool. Rode com `node -r dotenv/config` na VM.');
    process.exit(1);
  }

  const ate = ATE || new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  console.log(`\n=== P0-8 (2ª medição) — qual dia de rejeição sobreviveu à PK ===`);
  console.log(`janela: ${DE} → ${ate}  (read-only)\n`);

  // ── 1. Dias de rejeição por (nota, equipe), vindos dos snapshots.
  const { rows: rejRows } = await pool.query(
    `SELECT DISTINCT (n->>'id') AS note_id, s.team_name, s.date::text AS dia,
            (n->>'codigo') AS codigo
       FROM snapshots s,
            jsonb_array_elements(coalesce(s.data->'notasRejeitadas','[]'::jsonb)) AS n
      WHERE s.date BETWEEN $1::date AND $2::date AND n->>'id' IS NOT NULL`,
    [DE, ate]);

  const rej = new Map();   // note_id → { codigo, equipes:Set, dias:Set }
  for (const r of rejRows) {
    let e = rej.get(r.note_id);
    if (!e) { e = { codigo: r.codigo, equipes: new Set(), dias: new Set() }; rej.set(r.note_id, e); }
    e.equipes.add(r.team_name);
    e.dias.add(ymd(r.dia));
  }

  const multiDia = [...rej.entries()].filter(([, v]) => v.dias.size > 1);
  console.log(`notas rejeitadas em 2+ dias: ${multiDia.length}`);
  if (multiDia.length === 0) { await pool.end(); return; }

  const ids = multiDia.map(([id]) => id);

  // ── 2. Dias de CONCLUSÃO por nota. Usa o conclusionDate da própria nota quando
  //      existe (é o que o _notaDate prefere), senão o dia do snapshot.
  const { rows: concRows } = await pool.query(
    `SELECT DISTINCT (n->>'id') AS note_id, s.team_name, s.date::text AS dia_snap,
            (n->>'conclusionDate') AS conc_date
       FROM snapshots s,
            jsonb_array_elements(coalesce(s.data->'notasConcluidas','[]'::jsonb)) AS n
      WHERE s.date BETWEEN $1::date AND $2::date AND (n->>'id') = ANY($3::text[])`,
    [DE, ate, ids]);

  const conc = new Map();   // note_id → Set de dias de conclusão
  for (const r of concRows) {
    if (!conc.has(r.note_id)) conc.set(r.note_id, new Set());
    conc.get(r.note_id).add(ymd(r.conc_date) || ymd(r.dia_snap));
  }

  // ── 3. A linha que SOBREVIVEU na tabela.
  const { rows: nrRows } = await pool.query(
    `SELECT note_id::text AS note_id, team_name,
            coalesce(rejection_date::text, session_date::text) AS dia
       FROM note_rejections WHERE note_id = ANY($1::uuid[])`,
    [ids]);
  const sobrevivente = new Map(nrRows.map(r => [r.note_id, ymd(r.dia)]));

  // ── 4. Simula a regra com TODOS os dias × só com o sobrevivente.
  let semLinha = 0, semConclusao = 0, iguais = 0;
  const divergem = [];

  for (const [id, v] of multiDia) {
    const diaSobrev = sobrevivente.get(id);
    if (!diaSobrev) { semLinha++; continue; }
    const diasConc = conc.get(id);
    if (!diasConc || diasConc.size === 0) { semConclusao++; continue; }

    const todos = [...v.dias].sort();
    let houveDiferenca = false;
    for (const diaConc of diasConc) {
      const comTodos   = _contaComoExecutada(todos,       diaConc);
      const soSobrev   = _contaComoExecutada([diaSobrev], diaConc);
      if (comTodos !== soSobrev) {
        houveDiferenca = true;
        divergem.push({
          codigo: v.codigo, id, equipe: [...v.equipes][0],
          diasRejeicao: todos, diaSobrevivente: diaSobrev, diaConclusao: diaConc,
          comTodos, soSobrev,
        });
      }
    }
    if (!houveDiferenca) iguais++;
  }

  console.log(`\n── RESULTADO ──`);
  console.log(`sem linha em note_rejections:        ${semLinha}`);
  console.log(`sem conclusão na janela:             ${semConclusao}`);
  console.log(`regra dá o MESMO resultado:          ${iguais}`);
  console.log(`regra dá resultado DIFERENTE:        ${divergem.length}  ← este é o número que decide`);

  if (divergem.length > 0) {
    const infla = divergem.filter(d => d.soSobrev === true && d.comTodos === false).length;
    const deflaciona = divergem.length - infla;
    console.log(`\n  conta como produção e NÃO deveria:  ${infla}   (PK inflando)`);
    console.log(`  não conta e DEVERIA contar:         ${deflaciona} (PK subcontando)`);
    console.log(`\n── AMOSTRA (até 10) ──`);
    divergem.slice(0, 10).forEach(d => {
      console.log(`  ${d.codigo}  ${d.equipe}`);
      console.log(`    rejeições reais: ${d.diasRejeicao.join(', ')}`);
      console.log(`    sobreviveu:      ${d.diaSobrevivente}`);
      console.log(`    conclusão:       ${d.diaConclusao}`);
      console.log(`    produção? com todos=${d.comTodos}  só sobrevivente=${d.soSobrev}`);
    });
    console.log(`\n→ Migração do P0-8 é CORRETIVA. Medir o delta em dry-run antes de aplicar.`);
  } else {
    console.log(`\n→ A PK colapsa linhas, mas o dia que sobrevive NUNCA muda o resultado da`);
    console.log(`  regra nesta janela. Migração do P0-8 é PREVENTIVA: entra sem re-consolidar.`);
  }

  // ── 5. Bônus: os "2 dias" são rejeição de verdade ou a mesma rejeição aparecendo
  //      em dois snapshots consecutivos? Dias colados sugerem arrasto, não recusa nova.
  const colados = multiDia.filter(([, v]) => {
    const d = [...v.dias].sort();
    if (d.length !== 2) return false;
    return (new Date(d[1]) - new Date(d[0])) === 86400000;
  }).length;
  console.log(`\n── NATUREZA DOS 2 DIAS ──`);
  console.log(`pares de dias CONSECUTIVOS: ${colados}/${multiDia.length}`);
  if (colados / multiDia.length > 0.8) {
    console.log(`→ predominam dias colados: provável ARRASTO da mesma rejeição entre dois`);
    console.log(`  snapshots (a nota permanece no payload), não uma segunda recusa.`);
  }

  await pool.end();
}

main().catch(err => { console.error('ERRO:', err.message); process.exit(1); });
