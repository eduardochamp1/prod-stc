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
 * ── DOIS DEFEITOS, INDEPENDENTES (ver P1-47) ────────────────────────────────
 *
 * 1. HORÁRIO. `runSyncLogoffs` roda às 03:00 e processa o dia anterior,
 *    filtrando só sessão que JÁ tem `EndTime`. Turno que entra 20:00 e sai
 *    05:00 ainda está aberto às 03:00 — o job o vê sem fim, pula, e nunca
 *    volta àquela data.
 *
 * 2. JANELA DE BUSCA — e é por isso que este script NÃO reusa o job.
 *    O job procura o snapshot com
 *        .gte('date', date).order('captured_at', DESC).limit(20)
 *    Para "ontem" isso funciona: os 20 mais recentes são os do dia certo. Para
 *    uma data antiga, os 20 mais recentes são de SEMANAS DEPOIS, e o snapshot
 *    alvo nunca entra na janela.
 *
 *    A 1ª versão deste script delegava pro job e recuperou 0 de 113 em 16
 *    datas, mesmo com a API devolvendo dezenas de sessões fechadas por dia.
 *    Eu reusei a função assumindo que fosse agnóstica de data. Não é.
 *
 * Aqui o casamento é feito por (equipe, session_begin) direto, sem janela, e o
 * instante é comparado NORMALIZADO — o job compara string exata
 * (`sb1 === beginTime`), o que quebra se a EDP mudar milissegundo ou offset.
 *
 * ⚠️ ESTE SCRIPT ESCREVE. Preenche `session_end` E `data->>'sessionEnd'`,
 * mantendo os dois em sincronia — o job de produção grava só o jsonb, e foi
 * essa dessincronia que fez a medição ler o campo errado. Idempotente: o UPDATE
 * só atinge linha cujo fim está ausente, e nunca sobrescreve logoff existente.
 *
 *   node scripts/recuperar-logoffs.js --de 2026-08-16 --ate 2026-08-31
 *   node scripts/recuperar-logoffs.js --de 2026-08-16 --ate 2026-08-31 --apply
 */

'use strict';

require('dotenv').config();

const { _getPool } = require('../services/pgShim');
const { msParede } = require('../db/heQueries');

function arg(nome, padrao) {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}

const DE    = arg('de', '2026-08-16');
const ATE   = arg('ate', '2026-08-31');
const APPLY = process.argv.includes('--apply');
// Pausa entre chamadas à EDP. A conta é compartilhada com o cron de 15 min e
// com outro sistema (P1-25). O bloqueio da conta é por LOGIN falho, não por
// volume — a pausa é pra não competir com a coleta.
const PAUSA_MS = Number(arg('pausa', 800)) || 800;

const dorme = ms => new Promise(r => setTimeout(r, ms));
const norm  = v => String(v || '').toUpperCase().trim();
const VAZIO = '0001-01-01T00:00:00';

async function main() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(DE) || !/^\d{4}-\d{2}-\d{2}$/.test(ATE)) {
    console.error('✖ datas em YYYY-MM-DD');
    process.exit(1);
  }

  const pool = _getPool();

  // Sessões sem fim, com o setor — precisamos dele pra saber qual conta WPA
  // consultar.
  const { rows: abertas } = await pool.query(
    `WITH ultimo AS (
       SELECT DISTINCT ON (team_name, session_begin)
              upper(btrim(team_name)) AS equipe, sector_id, session_begin,
              COALESCE(session_end, data->>'sessionEnd', data->>'session_end') AS fim
         FROM public.snapshots
        WHERE date BETWEEN $1::date AND ($2::date + 7)
          AND session_begin IS NOT NULL
        ORDER BY team_name, session_begin, captured_at DESC
     )
     SELECT equipe, sector_id, session_begin,
            substring(session_begin, 1, 10) AS dia
       FROM ultimo
      WHERE fim IS NULL
        AND substring(session_begin, 1, 10) BETWEEN $3 AND $4
      ORDER BY dia, equipe`,
    [DE, ATE, DE, ATE]);

  if (!abertas.length) {
    console.log('\n✔ Nenhuma sessão sem logoff no período. Nada a recuperar.\n');
    return;
  }

  // Pares (dia, setor) a consultar — uma chamada por par, não por sessão.
  const pares = new Map();
  for (const a of abertas) {
    const k = `${a.dia}|${a.sector_id}`;
    pares.set(k, (pares.get(k) || 0) + 1);
  }

  console.log(`\n${abertas.length} sessão(ões) sem logoff, `
    + `em ${pares.size} par(es) dia×setor:\n`);
  for (const [k, n] of [...pares.entries()].sort()) {
    const [dia, setor] = k.split('|');
    console.log(`  ${dia}  ${String(setor).padEnd(5)} ${String(n).padStart(3)} aberta(s)`);
  }

  if (!APPLY) {
    console.log('\n── DRY-RUN. Nada foi consultado nem escrito. ──');
    console.log('   Com --apply: consulta a EDP por par dia×setor, casa por');
    console.log('   (equipe, início da sessão) e grava o fim onde estiver ausente.');
    console.log('   Idempotente — rodar de novo não altera o que já foi preenchido.\n');
    return;
  }

  const { getSessionsByDate } = require('../services/wpaService');
  const ENGELMIG = process.env.WPA_COMPANY_ID
    || '92a2f98e-8877-433e-8358-173b94c13a54';

  console.log(`\n→ consultando ${pares.size} par(es), pausa de ${PAUSA_MS}ms…\n`);

  // Índice: 'SETOR|DIA' → Map('EQUIPE|msDoInicio' → EndTime)
  const indice = new Map();
  const falhas = [];
  for (const k of [...pares.keys()].sort()) {
    const [dia, setor] = k.split('|');
    try {
      const sessoes = await getSessionsByDate(setor, dia);
      const mapa = new Map();
      for (const s of (sessoes || [])) {
        if (s.Team?.CompanyId !== ENGELMIG) continue;
        if (!s.EndTime || s.EndTime === VAZIO) continue;
        const ms = msParede(s.BeginTime);
        const nome = norm(s.Team?.Name || s.Team?.ExternalReference);
        if (ms == null || !nome) continue;
        mapa.set(`${nome}|${ms}`, s.EndTime);
      }
      indice.set(k, mapa);
      console.log(`  ${dia} ${String(setor).padEnd(5)} `
        + `${String(mapa.size).padStart(3)} sessão(ões) fechada(s) na EDP`);
    } catch (err) {
      falhas.push({ k, erro: err.message });
      console.error(`  ${dia} ${String(setor).padEnd(5)} ✖ ${err.message}`);
    }
    await dorme(PAUSA_MS);
  }

  // ── Casamento e escrita ───────────────────────────────────────────────────
  console.log('\n→ casando e gravando…\n');
  let gravadas = 0, semPar = 0;
  const naoCasaram = [];

  for (const a of abertas) {
    const mapa = indice.get(`${a.dia}|${a.sector_id}`);
    if (!mapa) continue;                     // consulta daquele par falhou
    const ms = msParede(a.session_begin);
    const fim = ms == null ? null : mapa.get(`${a.equipe}|${ms}`);
    if (!fim) {
      semPar++;
      if (naoCasaram.length < 12) {
        naoCasaram.push(`${a.dia} ${a.equipe} ${String(a.session_begin).slice(0, 19)}`);
      }
      continue;
    }

    // Preenche COLUNA e JSONB. O WHERE garante idempotência e impede
    // sobrescrever logoff que já exista.
    const { rowCount } = await pool.query(
      `UPDATE public.snapshots
          SET session_end = $3,
              data = jsonb_set(COALESCE(data, '{}'::jsonb), '{sessionEnd}',
                               to_jsonb($3::text), true)
        WHERE upper(btrim(team_name)) = $1
          AND session_begin = $2
          AND COALESCE(session_end, data->>'sessionEnd', data->>'session_end') IS NULL`,
      [a.equipe, a.session_begin, fim]);
    if (rowCount > 0) gravadas++;
  }

  console.log(`✔ ${gravadas} sessão(ões) com o fim recuperado da EDP.`);
  console.log(`  ${semPar} sem par na EDP.`);
  if (naoCasaram.length) {
    console.log('\n  Amostra das que não casaram:');
    for (const s of naoCasaram) console.log(`    ${s}`);
  }
  if (falhas.length) {
    console.log(`\n⚠️  ${falhas.length} consulta(s) falharam:`);
    for (const f of falhas) console.log(`   ${f.k}: ${f.erro}`);
  }

  if (semPar > 0) {
    console.log('\nSem par na EDP significa que a própria EDP não tem o fim:');
    console.log('  • a equipe nunca deslogou no app — dado que não existe; ou');
    console.log('  • a sessão é de um dia em que a coleta estava fora e nem');
    console.log('    chegou completa ao banco (P1-39, incidente SJC 24-25/08).');
  }
  console.log('\nRecarregue a Medição HE: a prorrogação recuperada entra no total.\n');
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error('\n✖', err.message); process.exit(1); });
