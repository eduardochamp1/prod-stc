#!/usr/bin/env node
/**
 * scripts/diag-quem-escreveu.js
 *
 * Para um dia, separa as linhas de `team_daily_totals` pelas FAIXAS DE ID da
 * sequência, para dizer QUEM escreveu o quê. READ-ONLY.
 *
 * POR QUE ISSO FUNCIONA: a tabela não tem `updated_at`, mas tem `id bigint` de
 * sequência. O `consolidateDay` DELETA todas as linhas de `{D-1, D}` e reinsere
 * (`services/dataWriter.js` ~770), então o selo do dia produz uma faixa de ids
 * CONTÍGUA. E como o upsert tem `onConflict (date, team_name, tipo_code)`, uma
 * escrita posterior em par já existente faz UPDATE e **preserva o id antigo**.
 *
 * Daí a leitura, que separa os DOIS mecanismos do P2-13 sem hipótese nenhuma:
 *
 *   • linha com id ACIMA da faixa do selo  → foi CRIADA depois do selo, por um
 *     par (equipe, tipo) que o passe selador não produziu. É a linha órfã.
 *   • linha DENTRO da faixa                → pode ter sido sobrescrita depois com
 *     visão parcial; o id não mostra isso, mas o total da faixa comparado com a
 *     régua mostra.
 *
 * Contexto (21/08/2026): 17/08 tem GRAVADO 1185 contra régua do write-path 983,
 * e o `diag-drift-team.js` mostrou os +211 espalhados em 48 equipes com gaps de
 * +1 a +15 — difuso, não concentrado, o que NÃO é a cara de linha órfã. Este
 * script decide entre as duas explicações.
 *
 * Uso (na VM):
 *   node -r dotenv/config scripts/diag-quem-escreveu.js 2026-08-17
 *   node -r dotenv/config scripts/diag-quem-escreveu.js 2026-08-17 --gap 500
 */

const DATA = process.argv[2];
function arg(nome, padrao) {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}
const GAP = Number(arg('gap', 200));   // salto de id que separa lotes

if (!DATA || !/^\d{4}-\d{2}-\d{2}$/.test(DATA)) {
  console.error('Uso: node -r dotenv/config scripts/diag-quem-escreveu.js YYYY-MM-DD');
  process.exit(2);
}

async function main() {
  const { _getPool } = require('../services/pgShim');
  const pool = _getPool();
  if (!pool) { console.error('Sem pool. Rode com `node -r dotenv/config` na VM.'); process.exit(1); }

  const { rows } = await pool.query(
    `SELECT id, team_name, tipo_code, count, regional
       FROM team_daily_totals WHERE date = $1::date ORDER BY id`, [DATA]);

  if (rows.length === 0) { console.log(`Sem linhas para ${DATA}.`); await pool.end(); return; }

  console.log(`\n=== Quem escreveu team_daily_totals de ${DATA} ===`);
  console.log(`linhas: ${rows.length}   soma: ${rows.reduce((a, r) => a + r.count, 0)}\n`);

  // Segmenta em lotes por salto de id.
  const lotes = [];
  let atual = [rows[0]];
  for (let i = 1; i < rows.length; i++) {
    if (Number(rows[i].id) - Number(rows[i - 1].id) > GAP) { lotes.push(atual); atual = []; }
    atual.push(rows[i]);
  }
  lotes.push(atual);

  console.log(`lote   linhas    soma    faixa de id`);
  console.log(`------------------------------------------------------------`);
  lotes.forEach((l, i) => {
    const soma = l.reduce((a, r) => a + r.count, 0);
    console.log(`${String(i + 1).padStart(4)}   ${String(l.length).padStart(6)}   ` +
                `${String(soma).padStart(5)}    ${l[0].id} … ${l[l.length - 1].id}`);
  });

  // Âncora temporal: as faixas de id dos dias VIZINHOS dizem quando cada lote
  // deste dia foi escrito, porque cada dia foi selado numa noite diferente.
  const { rows: viz } = await pool.query(
    `SELECT date::text AS dia, min(id) AS min_id, max(id) AS max_id, count(*)::int AS linhas
       FROM team_daily_totals
      WHERE date BETWEEN ($1::date - 8) AND ($1::date + 3)
      GROUP BY date ORDER BY date`, [DATA]);

  console.log(`\n── ÂNCORA: faixas de id dos dias vizinhos ──`);
  console.log(`(cada dia foi selado numa noite diferente, então a ordem dos ids é a`);
  console.log(` ordem no tempo. Um lote de ${DATA} com id > max_id de um dia POSTERIOR`);
  console.log(` foi escrito depois daquele dia.)\n`);
  viz.forEach(v => {
    const marca = v.dia === DATA ? '  ← este dia' : '';
    console.log(`  ${v.dia}   linhas=${String(v.linhas).padStart(4)}   ` +
                `id ${v.min_id} … ${v.max_id}${marca}`);
  });

  // Quanto veio de lote posterior ao selo. O selo do dia D acontece em D+1 23:50,
  // logo o lote do selo é o ÚLTIMO lote cujo id ainda é menor que o min_id do dia
  // D+2 (que foi selado depois).
  const proxProx = viz.find(v => v.dia > DATA && v.dia !== DATA);
  if (proxProx) {
    const corte = Number(proxProx.min_id);
    const posteriores = rows.filter(r => Number(r.id) > corte);
    const soma = posteriores.reduce((a, r) => a + r.count, 0);
    console.log(`\n── LINHAS CRIADAS APÓS O SELO ──`);
    console.log(`corte = min(id) de ${proxProx.dia} = ${corte}`);
    console.log(`linhas de ${DATA} com id acima disso: ${posteriores.length}   soma: ${soma}`);
    if (posteriores.length > 0) {
      console.log(`\n  equipe        tipo   count        id`);
      posteriores.slice(0, 25).forEach(r =>
        console.log(`  ${String(r.team_name).padEnd(12)}  ${String(r.tipo_code).padEnd(5)}  ` +
                    `${String(r.count).padStart(5)}   ${r.id}`));
      if (posteriores.length > 25) console.log(`  … +${posteriores.length - 25} linhas`);
      console.log(`\n→ São LINHAS ÓRFÃS: pares (equipe, tipo) que o passe selador não`);
      console.log(`  produziu e que ficaram. Explicam ${soma} do excesso.`);
    } else {
      console.log(`\n→ NENHUMA linha criada após o selo. Então o excesso NÃO é linha órfã:`);
      console.log(`  as linhas do selo foram SOBRESCRITAS com valores maiores depois.`);
      console.log(`  Isso aponta pro upsert intraday (upsertTeamDailyTotals, chamado a`);
      console.log(`  cada snapshot), que atribui nota ao dia da conclusão via _notaDate e`);
      console.log(`  NÃO aplica a injeção de rejeições do consolidateDay (P1-16). Ou seja:`);
      console.log(`  um snapshot de um dia posterior que ainda carrega notas concluídas em`);
      console.log(`  ${DATA} regrava aquele dia SEM o filtro de rejeição. Verificar com o`);
      console.log(`  log 'team_daily_totals_upserted' (ele lista os 'dates' escritos).`);
    }
  }

  await pool.end();
}

main().catch(err => { console.error('ERRO:', err.message); process.exit(1); });
