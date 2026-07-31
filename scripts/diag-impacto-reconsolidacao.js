#!/usr/bin/env node
/**
 * scripts/diag-impacto-reconsolidacao.js — impacto da re-consolidação SOBRE O
 * NÚMERO REPORTÁVEL (só equipes da whitelist). Read-only.
 *
 * POR QUE ESTE SCRIPT EXISTE (31/07/2026): o `backfill-consolidate` em dry-run
 * mede o impacto na TABELA INTEIRA (todas as equipes). Ex.: julho 01→25 deu
 * 21.711 → 19.368 (−2.343). Mas o painel/EDP conta só as equipes OFICIAIS
 * (~12.080 no mesmo período) — então aquele número superestima o efeito no que é
 * de fato reportado. Aqui a comparação é feita com o MESMO recorte do painel.
 *
 * Usa a própria lógica do sistema (consolidateDay em dryRun), então é
 * apples-to-apples: mesma união, mesma atribuição de dia (_notaDate/_effDate),
 * mesma regra de rejeição — a diferença é só o fix do P1-15 (o índice de
 * rejeições persistidas, que estava morto por Date × string).
 *
 * ⚠️ CORREÇÃO DA RÉGUA (31/07/2026 — depois do apply de julho).
 * A 1ª versão deste script media o "depois" com `consolidateDay(D)` filtrado em
 * `r.date === D`. Essa é a MESMA régua errada que causou o P0-6: quem grava o
 * valor final do dia D é o passe de **D+1** (consolidateDay(D) apaga {D-1,D} e
 * o passe seguinte reescreve D vendo mais sessões). A régua de D subconta ~5%,
 * então o script acusava uma queda permanente de −5,1% que NUNCA colapsava —
 * mesmo depois do apply, comparando tabela-correta contra régua-subcontada.
 * Medição direta do apply de julho/2026: 15.005 → 14.917 = −88 (−0,6%), e não
 * os −847 (−5,6%) que a régua de D previa. Agora usamos D+1, igual detectDrift.
 *
 * USO (na VM):
 *   node scripts/diag-impacto-reconsolidacao.js 2026-07-01 2026-07-25
 */

require('dotenv').config();
const { consolidateDay, _addDays } = require('../services/dataWriter');
const { getClient } = require('../services/dbClient');
const { _getPool } = require('../services/pgShim');
const { getSiglas } = require('../services/equipesOficiais');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function rangeDatas(de, ate) {
  const out = [];
  const d = new Date(de + 'T12:00:00Z'), fim = new Date(ate + 'T12:00:00Z');
  while (d <= fim) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

async function main() {
  const datas = process.argv.slice(2).filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  if (!datas.length) {
    console.error('✖ Uso: node scripts/diag-impacto-reconsolidacao.js <de> [<ate>]');
    process.exit(1);
  }
  const de = datas[0], ate = datas[1] || datas[0];
  const dias = rangeDatas(de, ate);
  const sb = getClient();
  const oficiais = new Set(getSiglas().map(s => String(s).toUpperCase()));

  console.log(`\n📊 Impacto da re-consolidação no NÚMERO REPORTÁVEL (whitelist: ${oficiais.size} equipes)`);
  console.log(`   ${de} → ${ate} · dry-run, nada é gravado\n`);
  console.log('data'.padEnd(12) + 'antes'.padStart(8) + 'depois'.padStart(8) + 'diff'.padStart(8) + '     %');
  console.log('-'.repeat(46));

  let tA = 0, tD = 0, erros = 0;
  for (const dia of dias) {
    try {
      // ANTES: team_daily_totals do dia, só equipes oficiais (recorte do painel)
      const { data } = await sb.from('team_daily_totals').select('team_name, count').eq('date', dia);
      const antes = (data || [])
        .filter(r => oficiais.has(String(r.team_name).toUpperCase()))
        .reduce((s, r) => s + (Number(r.count) || 0), 0);

      // DEPOIS: o que a consolidação gravaria HOJE (com o fix), mesmo recorte.
      // Régua = passe de D+1, que é QUEM grava o valor final de D (ver P0-6 e
      // detectDrift). Usar consolidateDay(dia) aqui subconta e inventa queda.
      const dry = await consolidateDay(_addDays(dia, 1), { dryRun: true });
      const depois = (dry?.rows || [])
        .filter(r => r.date === dia && oficiais.has(String(r.team_name).toUpperCase()))
        .reduce((s, r) => s + r.count, 0);

      tA += antes; tD += depois;
      const d = depois - antes;
      console.log(dia.padEnd(12) + String(antes).padStart(8) + String(depois).padStart(8)
        + String(d).padStart(8) + (antes > 0 ? `   ${(100 * d / antes).toFixed(1)}%` : ''));
      await sleep(200);   // gentil com o Postgres (VM 3.8GB)
    } catch (err) {
      erros++;
      console.log(dia.padEnd(12) + `  ✖ ${err.message}`);
    }
  }

  console.log('-'.repeat(46));
  const d = tD - tA;
  console.log('TOTAL'.padEnd(12) + String(tA).padStart(8) + String(tD).padStart(8) + String(d).padStart(8)
    + (tA > 0 ? `   ${(100 * d / tA).toFixed(1)}%` : ''));
  if (erros) console.log(`\n⚠️  ${erros} dia(s) com erro.`);
  console.log(`\n   Este É o número pra decisão contratual: quanto a produção REPORTADA muda`);
  console.log(`   se o histórico for re-consolidado. Negativo = cai.`);
  console.log(`   Régua = passe de D+1 (a que de fato grava o dia D). Se você vê aqui uma`);
  console.log(`   queda constante de ~5% que não colapsa depois de aplicar, a régua voltou`);
  console.log(`   a estar errada — ver o comentário do topo (P0-6).`);
  console.log(`   O saldo é dominado pelo P1-16 (exclusão da rejeitada casada pela NOTA e não`);
  console.log(`   pela sessão) — veja os eventos "consolidate_rejeicao_por_nota" acima: cada um`);
  console.log(`   é a contagem de notas que voltavam a contar como produção naquele passe.`);
  console.log(`   Carrega também o P1-15 (chave Date × string) e o P1-14 (vira-noite), este`);
  console.log(`   último só deslocando notas ENTRE dias, quase se anulando dentro do mês.\n`);
}

main()
  .then(async () => { try { const p = _getPool(); if (p && p.end) await p.end(); } catch (_) {} process.exit(0); })
  .catch(async (e) => { console.error(e); try { const p = _getPool(); if (p && p.end) await p.end(); } catch (_) {} process.exit(1); });
