#!/usr/bin/env node
/**
 * scripts/diag-uuids-do-dia.js
 *
 * A pergunta da casa: QUANTOS UUIDs distintos de verdade pertencem a este dia?
 * READ-ONLY. Não grava nada.
 *
 * POR QUE EXISTE (21/08/2026): em 17/08 a tabela diz 1185, a régua do write-path
 * (`consolidateDay(D+1)`) diz 983, e a decomposição por faixa de id mostrou que
 * ~170 do excesso vem de linhas CRIADAS depois do selo. A tentação é chamar isso
 * de lixo e re-consolidar — mas o `diag-drift-team` mostra casos como o EPAVP38,
 * cujas 4 linhas nasceram muito depois do selo E aparecem na régua de hoje: é
 * produção que chegou tarde, não duplicidade.
 *
 * E o `verify-consolidacao.js` já registra, no próprio cabeçalho, que confundir
 * régua estreita com erro de dados foi o que gerou o **P0-6**, onde o auto-reparo
 * "corrigia" pra baixo e APAGAVA produção legítima. A régua de D subconta ~5%.
 * Aqui a suspeita é que até a régua de D+1 é estreita: ela só olha snapshots de
 * {D, D+1}, e uma nota concluída em D que só aparece num snapshot de D+2 em
 * diante fica fora dela — mas É produção de D.
 *
 * Então este script não usa régua nenhuma. Ele conta UUIDs distintos, que é o
 * invariante do projeto ("cada UUID em exatamente 1 bucket"), varrendo uma janela
 * LARGA de snapshots e aplicando as mesmas regras do agregador:
 *   - atribuição do dia igual ao `_notaDate` (conclusionDate só quando aponta pra
 *     dia ANTERIOR ao da sessão; senão o dia da sessão);
 *   - exclusão de rejeitada>concluída por (nota, equipe) via `note_rejections`,
 *     com `_contaComoExecutada`.
 *
 * Leitura do resultado:
 *   UUIDs ≈ TABELA  → a tabela está certa e a régua é estreita. NÃO re-consolidar:
 *                     seria repetir o P0-6.
 *   UUIDs ≈ RÉGUA   → a tabela conta em duplicidade e a re-consolidação corrige.
 *
 * Uso (na VM):
 *   node -r dotenv/config scripts/diag-uuids-do-dia.js 2026-08-17
 *   node -r dotenv/config scripts/diag-uuids-do-dia.js 2026-08-17 --janela 10
 */

const DATA = process.argv[2];
function arg(nome, padrao) {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}
const JANELA = Number(arg('janela', 7));   // dias DEPOIS de DATA a varrer

if (!DATA || !/^\d{4}-\d{2}-\d{2}$/.test(DATA)) {
  console.error('Uso: node -r dotenv/config scripts/diag-uuids-do-dia.js YYYY-MM-DD');
  process.exit(2);
}

const ymd = v => (v instanceof Date
  ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  : String(v || '').slice(0, 10));

// Espelha services/dataWriter.js:_notaDate
function notaDate(n, sessDate) {
  if (!n.conclusionDate) return sessDate;
  const cd = String(n.conclusionDate).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}/.test(cd)) return sessDate;
  if (cd < sessDate) return cd;
  return sessDate;
}

async function main() {
  const { _getPool } = require('../services/pgShim');
  const { _contaComoExecutada } = require('../services/dataWriter');
  const pool = _getPool();
  if (!pool) { console.error('Sem pool. Rode com `node -r dotenv/config` na VM.'); process.exit(1); }

  console.log(`\n=== UUIDs distintos que pertencem a ${DATA} ===`);
  console.log(`janela varrida: ${DATA} .. ${DATA} +${JANELA} dias   (read-only)\n`);

  // 1. Todas as notasConcluidas de qualquer snapshot da janela. A atribuição do
  //    dia é feita aqui, igual ao agregador — não filtramos por s.date.
  const { rows } = await pool.query(
    `SELECT s.date AS sess_date, s.team_name, s.regional,
            n->>'id'             AS note_id,
            n->>'codigo'         AS codigo,
            n->>'tipoCode'       AS tipo_code,
            n->>'conclusionDate' AS conclusion_date
       FROM snapshots s,
            jsonb_array_elements(COALESCE(s.data->'notasConcluidas','[]'::jsonb)) AS n
      WHERE s.date BETWEEN ($1::date - 1) AND ($1::date + $2::int)
        AND n->>'id' IS NOT NULL`,
    [DATA, JANELA]);

  // 2. Fica só com o que o agregador atribuiria a DATA.
  const doDia = new Map();   // note_id → { team, tipo }
  const porOrigem = {};      // dia do snapshot que revelou → quantos UUIDs novos
  for (const r of rows) {
    const sess = ymd(r.sess_date);
    const dia = notaDate({ conclusionDate: r.conclusion_date }, sess);
    if (dia !== DATA) continue;
    if (!doDia.has(r.note_id)) {
      doDia.set(r.note_id, { team: r.team_name, tipo: r.tipo_code, revelado: sess });
      porOrigem[sess] = (porOrigem[sess] || 0) + 1;
    }
  }

  console.log(`UUIDs distintos atribuídos a ${DATA} (antes da regra): ${doDia.size}`);

  // 3. Aplica rejeitada>concluída por (nota, equipe), como o consolidateDay.
  const ids = [...doDia.keys()];
  const rejPorChave = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const { rows: rj } = await pool.query(
      `SELECT note_id::text AS note_id, team_name,
              COALESCE((rejection_date AT TIME ZONE 'America/Sao_Paulo')::date,
                       session_date)::text AS dia
         FROM note_rejections WHERE note_id = ANY($1::uuid[])`, [chunk]);
    for (const r of rj) {
      const k = `${r.note_id}|${r.team_name}`;
      if (!rejPorChave.has(k)) rejPorChave.set(k, []);
      rejPorChave.get(k).push(r.dia);
    }
  }

  let produtivas = 0, excluidas = 0;
  for (const [id, v] of doDia) {
    const dias = rejPorChave.get(`${id}|${v.team}`);
    if (_contaComoExecutada(dias, DATA)) produtivas++; else excluidas++;
  }

  console.log(`excluídas pela regra rejeitada>concluída:                ${excluidas}`);
  console.log(`\n>>> PRODUÇÃO REAL de ${DATA}, contada por UUID: ${produtivas}\n`);

  // 4. Compara com a tabela.
  const { rows: tab } = await pool.query(
    `SELECT COALESCE(sum(count),0)::int AS total FROM team_daily_totals WHERE date = $1::date`, [DATA]);
  const tabela = tab[0].total;

  console.log(`── COMPARAÇÃO ──`);
  console.log(`  UUIDs distintos (esta medição): ${String(produtivas).padStart(6)}`);
  console.log(`  team_daily_totals (a tabela):   ${String(tabela).padStart(6)}   diff ${tabela - produtivas >= 0 ? '+' : ''}${tabela - produtivas}`);
  console.log(`  (compare também com a régua do diag-drift-team desse dia)`);

  // 5. De onde vieram os UUIDs: qual snapshot os revelou. Se muitos foram
  //    revelados em D+2 ou depois, a régua de D+1 é estreita POR CONSTRUÇÃO.
  console.log(`\n── QUAL SNAPSHOT REVELOU CADA UUID ──`);
  const limiteRegua = new Date(Date.parse(DATA + "T00:00:00Z") + 86400000)
    .toISOString().slice(0, 10);   // D+1: último dia que a régua enxerga
  Object.keys(porOrigem).sort().forEach(d => {
    const fora = d > limiteRegua ? "   <-- FORA da janela da regua D+1" : "";
    console.log(`  revelados por snapshot de ${d}: ${String(porOrigem[d]).padStart(5)}${fora}`);
  });
  const foraTotal = Object.entries(porOrigem)
    .filter(([d]) => d > limiteRegua).reduce((a, [, v]) => a + v, 0);
  console.log(`
  total revelado FORA da janela da régua (> ${limiteRegua}): ${foraTotal}`);

  console.log(`\n── LEITURA ──`);
  console.log(`Se o total revelado FORA da janela tiver volume, a régua de D+1 não`);
  console.log(`PODE ver essas notas — e re-consolidar APAGARIA produção legítima.`);
  console.log(`Foi esse raciocínio invertido que gerou o P0-6 (auto-reparo "corrigindo"`);
  console.log(`pra baixo). Nesse caso: a tabela está certa, a régua é estreita, e o que`);
  console.log(`precisa mudar é o detectDrift/verify, não os dados.`);

  await pool.end();
}

main().catch(err => { console.error('ERRO:', err.message); process.exit(1); });
