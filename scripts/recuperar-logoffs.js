#!/usr/bin/env node
/**
 * scripts/recuperar-logoffs.js
 *
 * Recupera da EDP os logoffs de um período passado.
 *
 * ── QUANDO USAR ─────────────────────────────────────────────────────────────
 * Depois do conserto do P1-47 (09/09/2026), o cron das 03:00 passou a
 * processar D-1 **e** D-2, o que cobre o turno noturno. Este script existe pra:
 *
 *   • recuperar HISTÓRICO anterior ao conserto;
 *   • fechar a lacuna de um dia em que a coleta esteve fora (P1-39);
 *   • conferir, num período fechado, se sobrou sessão sem fim.
 *
 * ── POR QUE ELE NÃO TEM LÓGICA PRÓPRIA ──────────────────────────────────────
 * Ele tinha, e foi o problema. A 1ª versão delegava pro `runSyncLogoffs` e
 * recuperou **0 de 113** (o job não é agnóstico de data); a 2ª implementou o
 * casamento por conta e recuperou 113 de 113 — mas aí eram DUAS
 * implementações, e a divergência entre elas era exatamente o bug.
 *
 * Agora as duas usam `db/logoffSync.js`. Uma implementação, testada.
 *
 * ⚠️ ESCREVE com `--apply`. Idempotente: só preenche onde o fim está ausente e
 * nunca sobrescreve logoff conhecido.
 *
 *   node scripts/recuperar-logoffs.js --de 2026-08-16 --ate 2026-08-31
 *   node scripts/recuperar-logoffs.js --de 2026-08-16 --ate 2026-08-31 --apply
 */

'use strict';

require('dotenv').config();

const { _getPool } = require('../services/pgShim');
const { sessoesSemFim, sincronizarDia } = require('../db/logoffSync');
const { dateBRT } = require('../services/timeUtil');

function arg(nome, padrao) {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}

const DE    = arg('de', '2026-08-16');
const ATE   = arg('ate', '2026-08-31');
const APPLY = process.argv.includes('--apply');
// Pausa entre dias. A conta da EDP é compartilhada com o cron de 15 min e com
// outro sistema (P1-25). O bloqueio é por LOGIN falho, não por volume — a
// pausa é pra não competir com a coleta.
const PAUSA_MS = Number(arg('pausa', 800)) || 800;

const dorme = ms => new Promise(r => setTimeout(r, ms));

function listaDeDias(de, ate) {
  const out = [];
  const d = new Date(de + 'T12:00:00Z');
  const fim = new Date(ate + 'T12:00:00Z');
  while (d <= fim) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

async function main() {
  for (const [rot, v] of [['de', DE], ['ate', ATE]]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      console.error(`✖ --${rot} precisa ser YYYY-MM-DD`);
      process.exit(1);
    }
  }
  if (DE > ATE) { console.error('✖ --de depois de --ate'); process.exit(1); }

  const pool = _getPool();
  const dias = listaDeDias(DE, ATE);

  // ── Levantamento (sempre, sem escrever) ───────────────────────────────────
  const pendentes = [];
  for (const dia of dias) {
    const abertas = await sessoesSemFim(pool, dia);
    if (abertas.length) pendentes.push({ dia, abertas });
  }

  if (!pendentes.length) {
    console.log(`\n✔ Nenhuma sessão sem logoff entre ${DE} e ${ATE}.\n`);
    return;
  }

  // ⚠️ HOJE SEMPRE TEM SESSÃO ABERTA — e não é defeito.
  //
  // O dia não acabou: as equipes estão em campo e a sessão está legitimamente
  // sem fim. Em 09/09/2026 eu mandei o José conferir o conserto do P1-47 com
  // um intervalo que INCLUÍA hoje, ele viu 35 sessões abertas e o número
  // parecia falha do conserto. Era o esperado. Marcar aqui evita a leitura
  // errada — e o dia de HOJE nunca deveria entrar num juízo sobre captura.
  const HOJE = dateBRT();
  const total = pendentes.reduce((s, p) => s + p.abertas.length, 0);
  const deHoje = pendentes.filter(p => p.dia >= HOJE)
    .reduce((s, p) => s + p.abertas.length, 0);

  console.log(`\n${total} sessão(ões) sem logoff em ${pendentes.length} dia(s):\n`);
  for (const p of pendentes) {
    const porSetor = new Map();
    for (const a of p.abertas) porSetor.set(a.sector_id, (porSetor.get(a.sector_id) || 0) + 1);
    const detalhe = [...porSetor.entries()].sort()
      .map(([s, n]) => `${s} ${n}`).join(' · ');
    const marca = p.dia >= HOJE ? '  ← HOJE, em curso' : '';
    console.log(`  ${p.dia}  ${String(p.abertas.length).padStart(3)}   ${detalhe}${marca}`);
  }

  if (deHoje > 0) {
    console.log(`\n⚠️  ${deHoje} de ${total} são de HOJE (${HOJE}) — sessão em curso,`);
    console.log('   esperado, não é falha de captura. Pra julgar a captura, use');
    console.log('   um intervalo que termine ONTEM ou antes.');
    if (deHoje === total) {
      console.log('\n✔ Fora de hoje, nenhuma sessão sem logoff no período.\n');
      return;
    }
  }

  if (!APPLY) {
    console.log('\n── DRY-RUN. Nada foi consultado nem escrito. ──');
    console.log('   Com --apply: consulta a EDP só nos setores com pendência,');
    console.log('   casa por (equipe, instante do início) e grava o fim na coluna');
    console.log('   e no jsonb. Idempotente.\n');
    return;
  }

  const { getSessionsByDate, isSectorDisabled } = require('../services/wpaService');
  const ENGELMIG = process.env.WPA_COMPANY_ID
    || '92a2f98e-8877-433e-8358-173b94c13a54';

  console.log(`\n→ ${pendentes.length} dia(s), pausa de ${PAUSA_MS}ms…\n`);
  let gravadas = 0, semPar = 0;
  const falhas = [];

  for (const p of pendentes) {
    try {
      const r = await sincronizarDia(pool, getSessionsByDate, p.dia, {
        companyId: ENGELMIG,
        setorDesabilitado: isSectorDisabled,
        log: msg => console.log(`  ${msg}`),
      });
      gravadas += r.gravadas;
      semPar   += r.semPar;
      if (r.falhas.length) falhas.push(...r.falhas.map(f => ({ dia: p.dia, ...f })));
    } catch (err) {
      falhas.push({ dia: p.dia, erro: err.message });
      console.error(`  ${p.dia}: ✖ ${err.message}`);
    }
    await dorme(PAUSA_MS);
  }

  console.log(`\n✔ ${gravadas} de ${total} sessão(ões) com o fim recuperado.`);
  if (semPar) console.log(`  ${semPar} sem par na EDP.`);
  if (falhas.length) {
    console.log(`\n⚠️  ${falhas.length} falha(s):`);
    for (const f of falhas) console.log(`   ${f.dia}${f.setor ? ' ' + f.setor : ''}: ${f.erro}`);
  }

  if (semPar > 0) {
    console.log('\n"Sem par" significa que a própria EDP não tem o fim:');
    console.log('  • a equipe nunca deslogou no app — dado que não existe; ou');
    console.log('  • a sessão é de um dia em que a coleta esteve fora e nem');
    console.log('    chegou completa ao banco (ver P1-39).');
  }
  if (gravadas > 0) {
    console.log('\nRecarregue a Medição HE: a prorrogação recuperada entra no total.');
  }
  console.log('');
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error('\n✖', err.message); process.exit(1); });
