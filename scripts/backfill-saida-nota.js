#!/usr/bin/env node
/**
 * scripts/backfill-saida-nota.js — preenche `saida_nota` (P2-70) para dias passados.
 *
 * O job noturno (services/cronService.js, 04:30) só faz D-1. Este script é o
 * mesmo cálculo (services/saidaNotaJob.js) para um período: no dia do deploy,
 * para reconstruir o que der; e depois de a operação cadastrar placas no gseq,
 * para recalcular o período afetado (o cadastro é por vigência e vale para trás).
 *
 * ⚠️ A trilha do gseq é apagada com 60 DIAS — dia mais antigo que isso volta
 * todo como `sem_trilha`. O script recusa período além disso.
 *
 * ⚠️ ESCREVE só com --apply. Sem ele, avalia e mostra o resumo de cada dia.
 * Idempotente: upsert por note_id, rodar de novo substitui.
 *
 *   node scripts/backfill-saida-nota.js --de 2026-09-01 --ate 2026-10-18
 *   node scripts/backfill-saida-nota.js --de 2026-09-01 --ate 2026-10-18 --apply
 *
 * Precisa de GSEQ_DATABASE_URL no .env (SPEC §5). Um dia por vez (o jsonb dos
 * snapshots é pesado — P2-46); não rode duas cópias em paralelo.
 */

'use strict';

const { dateBRT } = require('../services/timeUtil');

const RETENCAO_TRILHA_DIAS = 60;

/** Lê --de, --ate, --apply. Pura. */
function lerArgs(argv, hoje = dateBRT()) {
  const val = (nome) => { const i = argv.indexOf(`--${nome}`); return i > -1 ? argv[i + 1] : null; };
  const out = { de: val('de'), ate: val('ate'), apply: argv.includes('--apply'), erros: [] };
  if (!out.de || !/^\d{4}-\d{2}-\d{2}$/.test(out.de)) out.erros.push('--de YYYY-MM-DD obrigatório');
  if (!out.ate || !/^\d{4}-\d{2}-\d{2}$/.test(out.ate)) out.erros.push('--ate YYYY-MM-DD obrigatório');
  if (out.erros.length) return out;
  if (out.de > out.ate) out.erros.push('--de depois de --ate');
  if (out.ate >= hoje) out.erros.push(`--ate tem de ser antes de hoje (${hoje}): o dia corrente não fechou`);
  const limite = new Date(Date.parse(`${hoje}T12:00:00Z`) - RETENCAO_TRILHA_DIAS * 86400000).toISOString().slice(0, 10);
  if (out.de < limite) out.erros.push(`--de antes de ${limite}: a trilha do gseq só guarda ${RETENCAO_TRILHA_DIAS} dias`);
  return out;
}

function diasEntre(de, ate) {
  const out = [];
  for (let t = Date.parse(`${de}T12:00:00Z`); t <= Date.parse(`${ate}T12:00:00Z`); t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

async function main() {
  const args = lerArgs(process.argv.slice(2));
  if (args.erros.length) { console.error(args.erros.join('\n')); process.exit(2); }
  require('dotenv').config();
  const { _getPool } = require('../services/pgShim');
  const { getGseqPool } = require('../services/gseqPool');
  const { getSetting } = require('../db/queries');
  const { runSaidaNota } = require('../services/saidaNotaJob');
  const pool = _getPool();
  const poolGseq = getGseqPool();
  if (!poolGseq) { console.error('GSEQ_DATABASE_URL não configurada no .env (SPEC §5).'); process.exit(2); }

  console.log(`${args.apply ? 'GRAVANDO' : 'SÓ AVALIANDO (sem --apply)'} ${args.de} → ${args.ate}`);
  try {
    for (const data of diasEntre(args.de, args.ate)) {
      await runSaidaNota({ data, pool, poolGseq, getSetting, gravar: args.apply });
    }
  } finally {
    try { await pool.end(); } catch (_) { /* já fechado */ }
    try { await poolGseq.end(); } catch (_) { /* já fechado */ }
  }
}

module.exports = { lerArgs, diasEntre, RETENCAO_TRILHA_DIAS };

if (require.main === module) {
  main().then(() => process.exit(0)).catch(err => { console.error('ERRO:', err.message); process.exit(1); });
}
