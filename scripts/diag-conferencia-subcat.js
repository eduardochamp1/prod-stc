#!/usr/bin/env node
/**
 * scripts/diag-conferencia-subcat.js — EXECUTADO x REJEITADA por equipe numa
 * subcategoria e período. Read-only.
 *
 * Feito pra conferir a planilha de controle manual de um colaborador contra o
 * sistema (questionamento de 30/07/2026, L0 / 01-07 a 25-07). Imprime linha por
 * equipe pra colar lado a lado com a planilha dele.
 *
 * FONTES (as mesmas que o painel usa):
 *   EXECUTADO  = team_daily_subcat_totals (produção consolidada; já aplica a
 *                regra rejeitada > concluída — nota rejeitada NÃO conta aqui)
 *   REJEITADA  = note_rejections × note_subcategorias (rejeição classificada
 *                naquela subcategoria), contada por note_id ÚNICO
 *
 * ⚠️ LER ANTES DE CONCLUIR DIVERGÊNCIA:
 *   1) Semântica: no nosso sistema uma nota rejeitada pela EDP NÃO conta como
 *      executada (regra 20/07/2026). Se a planilha manual conta a mesma nota
 *      nas DUAS colunas, o EXECUTADO dela fica maior por construção.
 *   2) P0-6 (30/07): o auto-reparo do drift derrubou produção real em dias da
 *      janela ~07-17..07-24 e a RE-CONSOLIDAÇÃO AINDA NÃO FOI FEITA. Nesses
 *      dias o sistema está SUBNOTIFICANDO. Ver BACKLOG P0-6.
 *   3) P1-14 (30/07): turno que vira a noite com reconexão tinha a produção
 *      partida entre 2 dias. Código corrigido, histórico NÃO re-consolidado.
 *   4) note_rejections só tem rejeição a partir de quando o coletor começou a
 *      persistir; e a subcategoria depende de note_subcategorias estar
 *      classificada (notas sem classificação caem em OUTROS, não em L0).
 *
 * USO (na VM):
 *   node scripts/diag-conferencia-subcat.js 2026-07-01 2026-07-25 L0
 *   node scripts/diag-conferencia-subcat.js 2026-07-01 2026-07-25 L0 --equipes=ECTSJ80,ECTSJ81
 *   node scripts/diag-conferencia-subcat.js 2026-07-01 2026-07-25 L0 --por-dia
 */

require('dotenv').config();
const { _getPool } = require('../services/pgShim');

function parseArgs(argv) {
  const datas = argv.filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const flags = argv.filter(a => a.startsWith('--'));
  const sub = argv.find(a => !a.startsWith('--') && !/^\d{4}-\d{2}-\d{2}$/.test(a)) || 'L0';
  const eqFlag = flags.find(f => f.startsWith('--equipes='));
  return {
    de: datas[0], ate: datas[1] || datas[0], sub,
    equipes: eqFlag ? eqFlag.split('=')[1].split(',').map(s => s.trim().toUpperCase()).filter(Boolean) : null,
    porDia: flags.includes('--por-dia'),
    error: !datas[0] ? 'informe as datas: <de> <ate> [SUB_CODE]' : null,
  };
}

/**
 * Modo --por-sub: abre as subcategorias de um TIPO por equipe (ex.: SF → L0, L1,
 * OUTROS). Serve pra testar se a divergência da planilha é de CLASSIFICAÇÃO —
 * uma nota que chamamos de L1 sendo contada como L0 no levantamento manual (e
 * vice-versa) produz desvios nos dois sentidos mantendo o total do tipo igual.
 */
async function porSub(pool, de, ate, tipo, equipes) {
  const filtroEq = equipes ? ' AND team_name = ANY($4::text[])' : '';
  const params = equipes ? [de, ate, tipo, equipes] : [de, ate, tipo];
  const { rows } = await pool.query(`
    SELECT team_name, sub_code, SUM(count)::int AS n
      FROM team_daily_subcat_totals
     WHERE date BETWEEN $1::date AND $2::date AND tipo = $3 ${filtroEq}
     GROUP BY team_name, sub_code`, params);

  const subs = [...new Set(rows.map(r => r.sub_code))].sort();
  const porEq = new Map();
  for (const r of rows) {
    if (!porEq.has(r.team_name)) porEq.set(r.team_name, {});
    porEq.get(r.team_name)[r.sub_code] = r.n;
  }
  const equipesOrd = [...porEq.keys()].sort();

  console.log(`\n📊 EXECUTADO por subcategoria · tipo ${tipo} · ${de} → ${ate}\n`);
  console.log('EQUIPE'.padEnd(12) + subs.map(s => s.padStart(9)).join('') + 'TOTAL'.padStart(9));
  console.log('-'.repeat(12 + 9 * (subs.length + 1)));
  const tot = {};
  for (const eq of equipesOrd) {
    const linha = porEq.get(eq);
    const soma = subs.reduce((s, c) => s + (linha[c] || 0), 0);
    subs.forEach(c => { tot[c] = (tot[c] || 0) + (linha[c] || 0); });
    console.log(eq.padEnd(12) + subs.map(c => String(linha[c] || 0).padStart(9)).join('') + String(soma).padStart(9));
  }
  console.log('-'.repeat(12 + 9 * (subs.length + 1)));
  const somaGeral = subs.reduce((s, c) => s + (tot[c] || 0), 0);
  console.log('TOTAL'.padEnd(12) + subs.map(c => String(tot[c] || 0).padStart(9)).join('') + String(somaGeral).padStart(9));
  console.log(`\n→ Compare a coluna da planilha manual com CADA subcategoria e com o TOTAL.`);
  console.log(`  Se o número dele bate melhor com o TOTAL (ou com L0+L1) do que com L0`);
  console.log(`  isolado, a divergência é de CLASSIFICAÇÃO, não de contagem.\n`);
}

async function main() {
  const { de, ate, sub, equipes, porDia, error } = parseArgs(process.argv.slice(2));
  // --por-sub: matriz de subcategorias do tipo (o 3º argumento passa a ser o TIPO)
  if (process.argv.includes('--por-sub')) {
    const pool = _getPool();
    await porSub(pool, de, ate, sub, equipes);
    return;
  }
  if (error) {
    console.error(`✖ ${error}`);
    console.error('Uso: node scripts/diag-conferencia-subcat.js 2026-07-01 2026-07-25 L0 [--equipes=A,B] [--por-dia]');
    process.exit(1);
  }
  const pool = _getPool();

  const filtroEq = equipes ? ' AND team_name = ANY($4::text[])' : '';
  const params = equipes ? [de, ate, sub, equipes] : [de, ate, sub];

  // EXECUTADO — produção consolidada por subcategoria
  const execQ = `
    SELECT team_name, ${porDia ? 'date,' : ''} SUM(count)::int AS executado
      FROM team_daily_subcat_totals
     WHERE date BETWEEN $1::date AND $2::date AND sub_code = $3 ${filtroEq}
     GROUP BY team_name${porDia ? ', date' : ''}`;

  // REJEITADA — rejeições classificadas na subcategoria, por note_id único
  const rejQ = `
    SELECT r.team_name, ${porDia ? 'r.session_date AS date,' : ''} COUNT(DISTINCT r.note_id)::int AS rejeitada
      FROM note_rejections r
      JOIN note_subcategorias s ON s.note_id = r.note_id
     WHERE r.session_date BETWEEN $1::date AND $2::date AND s.sub_code = $3
       ${equipes ? 'AND r.team_name = ANY($4::text[])' : ''}
     GROUP BY r.team_name${porDia ? ', r.session_date' : ''}`;

  const [ex, rj] = await Promise.all([pool.query(execQ, params), pool.query(rejQ, params)]);

  const key = (r) => porDia ? `${r.team_name}|${String(r.date).slice(0, 10)}` : r.team_name;
  const map = new Map();
  for (const r of ex.rows) map.set(key(r), { ...map.get(key(r)), team: r.team_name, dia: porDia ? String(r.date).slice(0, 10) : '', executado: r.executado });
  for (const r of rj.rows) map.set(key(r), { ...map.get(key(r)), team: r.team_name, dia: porDia ? String(r.date).slice(0, 10) : '', rejeitada: r.rejeitada });

  const linhas = [...map.values()]
    .map(l => ({ ...l, executado: l.executado || 0, rejeitada: l.rejeitada || 0 }))
    .sort((a, b) => a.team.localeCompare(b.team) || String(a.dia).localeCompare(String(b.dia)));

  console.log(`\n📋 Conferência ${sub} · ${de} → ${ate}${equipes ? ` · equipes: ${equipes.join(',')}` : ''}`);
  console.log(`   EXECUTADO = team_daily_subcat_totals (rejeitada NÃO conta como executada)`);
  console.log(`   REJEITADA = note_rejections × note_subcategorias (note_id único)\n`);
  console.log('EQUIPE'.padEnd(12) + (porDia ? 'DIA'.padEnd(12) : '') + 'EXECUTADO'.padStart(10) + 'REJEITADA'.padStart(11) + '% REJ'.padStart(8));
  console.log('-'.repeat(porDia ? 53 : 41));
  let tE = 0, tR = 0;
  for (const l of linhas) {
    const tot = l.executado + l.rejeitada;
    const pct = tot > 0 ? Math.round(100 * l.rejeitada / tot) : 0;
    tE += l.executado; tR += l.rejeitada;
    console.log(l.team.padEnd(12) + (porDia ? String(l.dia).padEnd(12) : '')
      + String(l.executado).padStart(10) + String(l.rejeitada).padStart(11) + (pct + '%').padStart(8));
  }
  console.log('-'.repeat(porDia ? 53 : 41));
  const totPct = (tE + tR) > 0 ? Math.round(100 * tR / (tE + tR)) : 0;
  console.log('TOTAL'.padEnd(porDia ? 24 : 12) + String(tE).padStart(10) + String(tR).padStart(11) + (totPct + '%').padStart(8));
  console.log(`\n⚠️  Antes de concluir divergência, ler o cabeçalho deste arquivo:`);
  console.log(`   • rejeitada NÃO conta como executada aqui (regra 20/07) — planilha manual pode contar nas duas;`);
  console.log(`   • dias ~07-17..07-24 estão SUBNOTIFICADOS (P0-6, re-consolidação pendente);`);
  console.log(`   • turno vira-noite com reconexão pode estar partido entre 2 dias (P1-14, histórico não re-consolidado).\n`);
}

main()
  .then(async () => { try { const p = _getPool(); if (p && p.end) await p.end(); } catch (_) {} process.exit(0); })
  .catch(async (e) => { console.error(e); try { const p = _getPool(); if (p && p.end) await p.end(); } catch (_) {} process.exit(1); });
