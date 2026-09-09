#!/usr/bin/env node
/**
 * scripts/recuperar-logoffs.js
 *
 * Recupera da API da EDP os logoffs que o cron das 03:00 perdeu.
 *
 * ── A OBSERVAÇÃO DO JOSÉ, 09/09/2026 ────────────────────────────────────────
 * "não faz sentido termos sessão em aberto de um dia fechado".
 *
 * Está certo, e reenquadra o problema. Sessão de um dia fechado TEM fim — a
 * equipe foi pra casa. Se o logoff não está no banco, é falha de CAPTURA, não
 * estado real. Não é algo a decidir na fatura: é dado a recuperar.
 *
 * ── A CAUSA ─────────────────────────────────────────────────────────────────
 * `runSyncLogoffs` (`services/cronService.js:1562`) roda às **03:00** e
 * processa **o dia anterior**, filtrando só sessões que já têm `EndTime`:
 *
 *     const fechadas = sessions.filter(s => ... s.EndTime && ...)
 *
 * Um turno que entra 20:00 e sai 05:00 AINDA ESTÁ ABERTO às 03:00. O job o vê
 * sem fim, pula — e nunca volta àquela data. O logoff existe na EDP; nós
 * simplesmente paramos de perguntar.
 *
 * Medido em 09/09/2026, período 16–31/08: 113 sessões sem logoff, e as cinco
 * equipes mais reincidentes são todas de turno noturno — EPGPR30 (login 20:00),
 * EPPTE04 (21:00), EPAVP38 (21:11), EPCIT33 (17:00), EPCIT32.
 *
 * ⚠️ ESTE SCRIPT ESCREVE. Ele chama o job de produção `runSyncLogoffs` para
 * datas passadas. O job é idempotente por construção: só preenche onde
 * `sessionEnd` está null, e nunca sobrescreve logoff existente.
 *
 * ⚠️ Grava no jsonb `data`, não na coluna `session_end` — é o que o job faz, e
 * a medição já lê os dois via COALESCE (`db/heQueries.js`). A dessincronia
 * entre coluna e payload é outro item, registrado no backlog.
 *
 *   node scripts/recuperar-logoffs.js --de 2026-08-16 --ate 2026-08-31
 *   node scripts/recuperar-logoffs.js --de 2026-08-16 --ate 2026-08-31 --apply
 */

'use strict';

require('dotenv').config();

const { _getPool } = require('../services/pgShim');

function arg(nome, padrao) {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}

const DE    = arg('de', '2026-08-16');
const ATE   = arg('ate', '2026-08-31');
const APPLY = process.argv.includes('--apply');
// Pausa entre datas. Cada data são 4 chamadas (uma por setor) à API da EDP, e
// a conta é compartilhada com o cron e com outro sistema (P1-25). Não é medo
// de bloqueio — o bloqueio é por LOGIN falho, não por volume — é pra não
// competir com a coleta de 15 min.
const PAUSA_MS = Number(arg('pausa', 1500)) || 1500;

const dorme = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(DE) || !/^\d{4}-\d{2}-\d{2}$/.test(ATE)) {
    console.error('✖ datas em YYYY-MM-DD');
    process.exit(1);
  }

  const pool = _getPool();

  // Quais datas têm sessão sem logoff. Só essas precisam ser re-perguntadas —
  // varrer o período todo gastaria chamada à EDP sem motivo.
  const { rows } = await pool.query(
    `WITH ultimo AS (
       SELECT DISTINCT ON (team_name, session_begin)
              team_name, session_begin,
              COALESCE(session_end, data->>'sessionEnd', data->>'session_end') AS fim
         FROM public.snapshots
        WHERE date BETWEEN $1::date AND ($2::date + 7)
          AND session_begin IS NOT NULL
        ORDER BY team_name, session_begin, captured_at DESC
     )
     SELECT substring(session_begin, 1, 10) AS dia, count(*)::int AS abertas
       FROM ultimo
      WHERE fim IS NULL
        AND substring(session_begin, 1, 10) BETWEEN $3 AND $4
      GROUP BY 1
      ORDER BY 1`,
    [DE, ATE, DE, ATE]);

  if (!rows.length) {
    console.log('\n✔ Nenhuma sessão sem logoff no período. Nada a recuperar.\n');
    return;
  }

  const total = rows.reduce((s, r) => s + r.abertas, 0);
  console.log(`\n${total} sessão(ões) sem logoff em ${rows.length} data(s):\n`);
  for (const r of rows) {
    console.log(`  ${r.dia}  ${String(r.abertas).padStart(3)} aberta(s)`);
  }

  if (!APPLY) {
    console.log('\n── DRY-RUN. Nada foi chamado nem escrito. ──');
    console.log(`   Com --apply, o job runSyncLogoffs roda para essas ${rows.length} data(s),`);
    console.log('   consultando a EDP e preenchendo só onde o fim está ausente.');
    console.log('   Idempotente: rodar de novo não altera o que já foi preenchido.\n');
    return;
  }

  const { runSyncLogoffs } = require('../services/cronService');
  console.log(`\n→ recuperando ${rows.length} data(s), pausa de ${PAUSA_MS}ms entre elas…\n`);

  let atualizados = 0;
  const falhas = [];
  for (const r of rows) {
    try {
      const res = await runSyncLogoffs(r.dia);
      const n = (res && res.updated) || 0;
      atualizados += n;
      console.log(`  ${r.dia}  ${String(n).padStart(3)} logoff(s) recuperado(s) `
        + `de ${r.abertas} aberta(s)`);
    } catch (err) {
      falhas.push({ dia: r.dia, erro: err.message });
      console.error(`  ${r.dia}  ✖ ${err.message}`);
    }
    await dorme(PAUSA_MS);
  }

  console.log(`\n✔ ${atualizados} logoff(s) recuperado(s) de ${total} sessão(ões).`);
  if (falhas.length) {
    console.log(`\n⚠️  ${falhas.length} data(s) falharam:`);
    for (const f of falhas) console.log(`   ${f.dia}: ${f.erro}`);
  }

  const resto = total - atualizados;
  if (resto > 0) {
    console.log(`\n${resto} sessão(ões) seguem sem logoff. Duas leituras possíveis:`);
    console.log('  • A EDP não tem o fim tampouco — a equipe nunca deslogou no app.');
    console.log('    Aí é dado que não existe, e a prorrogação é imensurável.');
    console.log('  • A coleta estava fora naquele dia e a sessão nem chegou');
    console.log('    completa ao banco. Ver P1-39 (incidente SJC de 24-25/08).');
    console.log('\nRode o diag-he-sessoes-abertas.js pra ver quais sobraram.');
  }
  console.log('\nA Medição HE já lê o jsonb via COALESCE — recarregue a aba pra');
  console.log('ver a prorrogação recuperada entrar no total.\n');
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error('\n✖', err.message); process.exit(1); });
