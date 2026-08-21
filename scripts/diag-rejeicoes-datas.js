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
 * Este script simula as duas situações com as funções REAIS do dataWriter.
 *
 * ⚠️ CONCLUSÃO DA 1ª RODADA (21/08/2026) — leia antes de interpretar a seção 4:
 * deu 2 divergências em 395, e as 2 são ARTEFATO DESTA SIMULAÇÃO, não bug de
 * produção. Motivo: os dias que a seção 4 junta vêm de `snapshots.date` = "dia em
 * que o coletor VIU a rejeição", e o `_rejIndexByNote` evita justamente isso ao
 * preferir `rejection_date` (o RejectedAt da WPA, autoritativo — ver
 * services/dataWriter.js:256-259). Com 395/395 pares em dias CONSECUTIVOS, o 2º dia
 * é arrasto da mesma rejeição. A linha que a PK deixou sobreviver é a certa.
 *
 * O risco REAL está na seção 6: linhas SEM `rejection_date`, que caem no
 * `session_date` e portanto herdam o dia do arrasto. Nessas o erro é o INVERSO —
 * suprimir produção legítima. E o conserto não é a PK: é obter o RejectedAt (P1-33).
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
    // ⚠️ LEITURA CORRIGIDA (21/08/2026, depois da 1ª rodada): NÃO trate `comTodos`
    // como verdade. Os dias que este script junta vêm de `snapshots.date`, isto é,
    // "dia em que o coletor VIU a rejeição" — exatamente o que o _rejIndexByNote
    // evita de propósito ao preferir `rejection_date` (o RejectedAt da WPA,
    // autoritativo; ver services/dataWriter.js:256-259). Com 395/395 pares em dias
    // CONSECUTIVOS, o 2º dia é arrasto da mesma rejeição, não recusa nova. Logo a
    // linha que sobreviveu à PK é a CERTA, e a divergência abaixo é artefato da
    // simulação, não bug de produção.
    console.log(`
  ⚠️  Não conclua daqui que a PK está errada. Ver o bloco abaixo:`);
    console.log(`  a régua deste script é o dia do SNAPSHOT; a de produção é o`);
    console.log(`  RejectedAt da WPA. Onde as duas discordam, a de produção vence.`);
    console.log(`
── AMOSTRA (até 10) ──`);
    divergem.slice(0, 10).forEach(d => {
      console.log(`  ${d.codigo}  ${d.equipe}`);
      console.log(`    dias em que o coletor viu: ${d.diasRejeicao.join(', ')}`);
      console.log(`    linha autoritativa:        ${d.diaSobrevivente}`);
      console.log(`    conclusão:                 ${d.diaConclusao}`);
      console.log(`    produção? régua-snapshot=${d.comTodos}  autoritativa=${d.soSobrev}`);
    });
  } else {
    console.log(`
→ O dia que sobrevive nunca muda o resultado da regra nesta janela.`);
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

  // ── 6. O RISCO DE VERDADE: quantas linhas NÃO têm o RejectedAt da WPA e por
  //    isso caem no session_date (= dia em que o coletor viu). Nessas, o arrasto
  //    PODE empurrar o dia pra frente e suprimir produção legítima — o inverso
  //    do que a seção 4 sugere. É aqui que mora o impacto, se houver.
  const { rows: cob } = await pool.query(
    `SELECT tipo,
            count(*)::int                                    AS total,
            count(rejection_date)::int                        AS com_rejectedat,
            (count(*) - count(rejection_date))::int           AS sem_rejectedat
       FROM note_rejections
      WHERE session_date BETWEEN $1::date AND $2::date
      GROUP BY tipo ORDER BY sem_rejectedat DESC`,
    [DE, ate]);

  console.log(`
── COBERTURA DO RejectedAt (autoritativo) POR TIPO ──`);
  let tot = 0, semTot = 0;
  for (const r of cob) {
    tot += r.total; semTot += r.sem_rejectedat;
    const pct = r.total ? Math.round(100 * r.sem_rejectedat / r.total) : 0;
    console.log(`  ${String(r.tipo).padEnd(6)} total=${String(r.total).padStart(6)}  ` +
                `sem RejectedAt=${String(r.sem_rejectedat).padStart(6)} (${pct}%)`);
  }
  console.log(`  ----`);
  console.log(`  TOTAL  total=${String(tot).padStart(6)}  sem RejectedAt=${String(semTot).padStart(6)}` +
              ` (${tot ? Math.round(100*semTot/tot) : 0}%)`);

  // Quantas das notas de 2 dias caem justamente nesse grupo sem data autoritativa.
  const { rows: semData } = await pool.query(
    `SELECT count(*)::int AS n FROM note_rejections
      WHERE note_id = ANY($1::uuid[]) AND rejection_date IS NULL`, [ids]);
  console.log(`
  das ${multiDia.length} notas de 2 dias, sem RejectedAt: ${semData[0].n}`);
  if (semData[0].n === 0) {
    console.log(`  → todas têm data autoritativa: o arrasto não afeta a regra. P0-8 sem impacto.`);
  } else {
    console.log(`  → essas dependem do session_date (dia em que o coletor viu). Se o`);
    console.log(`    arrasto empurrou o dia pra frente, produção legítima foi suprimida.`);
    console.log(`    O conserto NÃO é a PK: é obter o RejectedAt — ver backlog P1-33`);
    console.log(`    (/Notes/{id}/completeInterruptions devolve Date por interrupção).`);
  }

  await pool.end();
}

main().catch(err => { console.error('ERRO:', err.message); process.exit(1); });
