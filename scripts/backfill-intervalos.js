#!/usr/bin/env node
/**
 * scripts/backfill-intervalos.js
 *
 * Popula `sessao_intervalo` retroativamente, dia a dia.
 *
 * ── POR QUE ELE PRECISOU EXISTIR ────────────────────────────────────────────
 * 10/09/2026. A coluna de retorno à base passou a sair do apontamento
 * `29 - Retorno da equipe à base`, que vive em `sessao_intervalo` (P2-15). Só
 * que `runSyncIntervalos` roda 1x/dia sobre D-1 e **só existe desde
 * 22/08/2026**: medido no dia, 22 de 41 dias do período não tinham NENHUM
 * intervalo coletado — 01/08 a 21/08 inteiro, mais o próprio dia corrente
 * (que o cron das 03:10 só pega amanhã, e isso é normal).
 *
 * Sem este backfill a coluna nasce vazia em todo agosto, exatamente como
 * aconteceu com o `registradoEm` (ver `scripts/backfill-note-details.js`).
 *
 * ── POR QUE ELE NÃO TEM LÓGICA PRÓPRIA ──────────────────────────────────────
 * Ele chama `runSyncIntervalos(dia)`, que já é agnóstico de data (ao contrário
 * do `runSyncLogoffs`, que não era — foi o P1-47, 113 logoffs perdidos porque
 * o script tinha uma 2ª implementação). Aqui é só o laço de dias.
 *
 * ⚠️ CUSTO. É **1 request por SESSÃO** (~130/dia), o motivo de a cadência
 * normal ser diária e não no ciclo de 15min. 21 dias ≈ 2.700 requests na conta
 * compartilhada com outro projeto da empresa (P1-25). Rode fora do horário de
 * pico e prefira fatiar em dois dias se puder.
 *
 * ⚠️ ESCREVE só com `--apply`. Idempotente: o upsert é por
 * (session_id, inicio), então repetir não duplica.
 *
 *   node scripts/backfill-intervalos.js --de 2026-08-01 --ate 2026-08-21
 *   node scripts/backfill-intervalos.js --de 2026-08-01 --ate 2026-08-21 --apply
 */

'use strict';

require('dotenv').config();

const { _getPool } = require('../services/pgShim');
const { dateBRT } = require('../services/timeUtil');

function arg(nome, padrao) {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}
const DE    = arg('de', '2026-08-01');
const ATE   = arg('ate', dateBRT());
const APPLY = process.argv.includes('--apply');

if (!/^\d{4}-\d{2}-\d{2}$/.test(DE) || !/^\d{4}-\d{2}-\d{2}$/.test(ATE)) {
  console.error('Datas em YYYY-MM-DD.'); process.exit(1);
}

function diasDoPeriodo(de, ate) {
  const out = [];
  const d = new Date(de + 'T12:00:00Z');
  const fim = new Date(ate + 'T12:00:00Z');
  while (d <= fim) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

(async () => {
  const pool = _getPool();
  const dias = diasDoPeriodo(DE, ATE);

  console.log(`\n=== BACKFILL sessao_intervalo — ${DE} a ${ATE} (${dias.length} dia(s)) ===`);
  console.log(APPLY ? 'APPLY (escreve e chama a EDP)\n' : 'simulacao — nada e buscado\n');

  // Quanto já existe, por dia. Dia que já tem intervalo não precisa de nada:
  // pular é o que torna seguro rodar de novo depois de uma interrupção.
  const { rows } = await pool.query(
    `SELECT to_char(data, 'YYYY-MM-DD') AS dia, count(*) AS n
       FROM public.sessao_intervalo
      WHERE data BETWEEN $1::date AND $2::date
      GROUP BY data`, [DE, ATE]);
  const jaTem = new Map(rows.map(r => [r.dia, Number(r.n)]));

  const faltam = dias.filter(d => !jaTem.get(d));
  console.log('  dia          ja coletado');
  for (const d of dias) {
    const n = jaTem.get(d) || 0;
    console.log(`  ${d}   ${String(n).padStart(10)}`
      + (n ? '' : '   <- vai buscar')
      + (d === dateBRT() ? '   (HOJE: o cron das 03:10 pega amanha)' : ''));
  }
  console.log(`\n${faltam.length} de ${dias.length} dia(s) sem coleta.`);

  if (!faltam.length) { console.log('Nada a fazer.'); process.exit(0); }

  if (!APPLY) {
    console.log(`\nSimulacao. Pra preencher: --apply`);
    console.log(`Custo estimado: ~${faltam.length * 130} requests `
      + `(1 por sessao, ~130 sessoes/dia).`);
    process.exit(0);
  }

  // `runSyncIntervalos` ja aceita a data e faz tudo: lista sessoes por setor,
  // filtra as nossas pelo CompanyId, busca os breaks e faz upsert.
  const { runSyncIntervalos } = require('../services/cronService');

  let ok = 0, erro = 0;
  for (const d of faltam) {
    process.stdout.write(`  ${d} ... `);
    try {
      const r = await runSyncIntervalos(d);
      const s = r && typeof r === 'object'
        ? `${r.sessoes} sessoes, ${r.intervalos} intervalos, ${r.gravados} gravados`
        : 'ok';
      console.log(s);
      ok++;
    } catch (err) {
      console.log('FALHOU: ' + err.message);
      erro++;
    }
  }

  console.log(`\n${ok} dia(s) processado(s), ${erro} com falha.`);
  console.log('Recarregue a Medicao HE e confira o aviso de "sem coleta".');
  process.exit(0);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
