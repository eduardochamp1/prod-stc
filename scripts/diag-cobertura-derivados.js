#!/usr/bin/env node
/**
 * scripts/diag-cobertura-derivados.js — COBERTURA por dia: produção × o que
 * deveria existir junto dela. Read-only, não chama a EDP.
 *
 * 10/11/2026 (P0-16). De 20/10 a 09/11/2026 os dias foram fechados por
 * backfill, que só gravava a produção; rejeições, detalhes, intervalos, saída
 * da nota, carteira e notas devolvidas ficaram vazios e ninguém viu. Este
 * script é a tabela que faltou. As regras e a consulta vivem em
 * services/cobertura.js (o mesmo radar que roda depois do fechamento das 05h).
 *
 * Complementa scripts/diag-cobertura-dias.js (snapshot × consolidado).
 *
 * USO (na VM):
 *   node scripts/diag-cobertura-derivados.js 2026-10-12 2026-11-09
 *   node scripts/diag-cobertura-derivados.js 2026-11-09          # um dia
 *   node scripts/diag-cobertura-derivados.js                     # últimos 7 dias
 */

'use strict';

require('dotenv').config();
const { _getPool } = require('../services/pgShim');
const { dateBRT } = require('../services/timeUtil');
const cobertura = require('../services/cobertura');

const DOW = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

async function main() {
  const datas = process.argv.slice(2).filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const hoje = dateBRT();
  const menos = (n) => new Date(Date.parse(`${hoje}T12:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
  const de = datas[0] || menos(7), ate = datas[1] || datas[0] || menos(1);

  const medidos = await cobertura.medir(_getPool(), de, ate, { hoje });
  console.log(`\nCobertura por dia · ${de} → ${ate} (só dias fechados)`);
  console.log('vivo = coletas ao vivo · rej = gravadas/no snapshot · det = concluídas com detalhe/concluídas\n');
  const cab = ['DIA', 'DOW', 'prod', 'vivo', 'rej', 'det', 'interv', 'saida', 'cart', 'notas', 'escala', 'interr'];
  const larg = [11, 4, 6, 5, 10, 11, 7, 6, 5, 6, 7, 7];
  const linha = (cols) => cols.map((c, i) => (i < 2 ? String(c).padEnd(larg[i]) : String(c).padStart(larg[i]))).join(' ');
  console.log(linha(cab));
  console.log('-'.repeat(98));
  const faltas = [];
  for (const d of medidos) {
    const a = cobertura.avaliarDia(d);
    const marca = a.buracos.length ? ' 🔴' : (a.avisos.length ? ' 🟠' : '');
    console.log(linha([d.dia, DOW[new Date(d.dia + 'T12:00:00Z').getUTCDay()], d.producao, d.coletas_ao_vivo,
      `${d.rej_gravadas}/${d.rej_snapshot}`, `${d.concluidas_com_detalhe}/${d.concluidas}`,
      d.intervalos, d.saida_nota, d.carteira, d.notas_devolvidas, d.escala, d.interrupcoes]) + marca);
    if (a.buracos.length || a.avisos.length) faltas.push(a);
  }
  console.log('-'.repeat(98));
  if (!faltas.length) { console.log('\n✅ Nenhum dia com falta.\n'); return; }
  const comBuraco = faltas.filter(f => f.buracos.length);
  console.log(`\n🔴 ${comBuraco.length} dia(s) com buraco recarregável · 🟠 ${faltas.length - comBuraco.length} só com aviso (sem retroativo)\n`);
  for (const f of faltas) {
    console.log(`${f.dia}:`);
    f.buracos.forEach(t => console.log(`   🔴 ${t}`));
    f.avisos.forEach(t => console.log(`   🟠 ${t}`));
  }
  console.log('\nRecarga: ver RUNBOOK, "Dia fechado com buraco nas tabelas derivadas (P0-16)".\n');
}

main()
  .then(async () => { try { const p = _getPool(); if (p && p.end) await p.end(); } catch (_) {} process.exit(0); })
  .catch(async (e) => { console.error(e); try { const p = _getPool(); if (p && p.end) await p.end(); } catch (_) {} process.exit(1); });
