#!/usr/bin/env node
/**
 * scripts/diag-retorno-base.js
 *
 * O apontamento "29 - Retorno da equipe à base" existe? Onde? Em que fuso?
 *
 * ── CONTEXTO (10/09/2026) ───────────────────────────────────────────────────
 * A coluna de deslocamento pra base foi entregue com uma RÉGUA INFERIDA (do
 * fim do trabalho da última nota até o logoff), porque eu tinha concluído que
 * "NÃO EXISTE DADO DE BASE NO SISTEMA" — os checkpoints documentados são 0..4
 * e todos pertencem a uma NOTA. Estava errado: o José informou que existe
 * apontamento próprio, `29 - Retorno da equipe à base`, e que ele entra nos
 * apontamentos da SESSÃO — ou seja, em `sessao_intervalo.motivo`, na mesma
 * família de `15 - Horário de Refeição`.
 *
 * Antes de trocar a régua, três perguntas que decidem se a troca é útil:
 *
 *   1. O motivo aparece mesmo, e com que texto exato? (o código pode variar)
 *   2. Qual a COBERTURA? `runSyncIntervalos` roda 1x/dia sobre D-1 e só existe
 *      desde 22/08/2026. Dia anterior a isso pode não ter nenhum intervalo —
 *      e aí a coluna nasce vazia no histórico, exatamente como aconteceu com o
 *      `registradoEm` (ver o cabeçalho de `scripts/backfill-note-details.js`).
 *   3. Em que FUSO está gravado? `sessao_intervalo.inicio` é TIMESTAMPTZ e o
 *      normalizador anexa 'Z' ("a EDP manda UTC sem dizer"), enquanto
 *      `snapshots.session_begin` é lido como HORA DE PAREDE, sem converter.
 *      Se os dois lados discordam, a duração erra 3h — a armadilha que já
 *      pegou o TMA, o KPI de escala e a própria medição de HE.
 *
 * A pergunta 3 tem um oráculo: a REFEIÇÃO. Almoço acontece entre 11h e 14h de
 * parede. A leitura que colocar a moda do `15 - Horário de Refeição` nessa
 * faixa é a leitura certa; a outra joga tudo pra 14h-17h.
 *
 * ⚠️ ESTRITAMENTE READ-ONLY. Só SELECT. Não escreve nada, em nenhuma tabela.
 *
 *   node scripts/diag-retorno-base.js --de 2026-08-01 --ate 2026-09-09
 */

'use strict';

require('dotenv').config();

const { _getPool } = require('../services/pgShim');
const { dateBRT } = require('../services/timeUtil');

function arg(nome, padrao) {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}
const DE  = arg('de', '2026-08-01');
const ATE = arg('ate', dateBRT());

if (!/^\d{4}-\d{2}-\d{2}$/.test(DE) || !/^\d{4}-\d{2}-\d{2}$/.test(ATE)) {
  console.error('Datas em YYYY-MM-DD.'); process.exit(1);
}

const pad = (v, n) => String(v == null ? '' : v).padStart(n);

// Postgres: motivo que começa com "29". `\y` é fronteira de palavra — sem ela,
// "290" também casaria.
const RE_29 = '^\\s*29\\y';

(async () => {
  const pool = _getPool();
  console.log(`\n=== DIAG retorno à base — ${DE} a ${ATE} ===\n`);

  // ── 1. A tabela existe? ───────────────────────────────────────────────────
  try {
    await pool.query('SELECT 1 FROM public.sessao_intervalo LIMIT 1');
  } catch (err) {
    console.log('sessao_intervalo INDISPONIVEL:', err.message);
    console.log('Rode supabase/migrations/014_sessao_intervalo.sql antes.');
    process.exit(0);
  }

  // ── 2. Que motivos existem, e quantos ─────────────────────────────────────
  const { rows: motivos } = await pool.query(
    `SELECT motivo, count(*) AS n, count(*) FILTER (WHERE fim IS NULL) AS abertos
       FROM public.sessao_intervalo
      WHERE data BETWEEN $1::date AND $2::date
      GROUP BY motivo ORDER BY n DESC`, [DE, ATE]);

  console.log('MOTIVOS NO PERIODO');
  console.log('      n  abertos  motivo');
  for (const m of motivos) {
    console.log(`${pad(m.n, 7)} ${pad(m.abertos, 8)}  ${m.motivo || '(nulo)'}`);
  }
  if (!motivos.length) console.log('  (nenhum intervalo no periodo)');

  const alvo = motivos.find(m => /^\s*29\b/.test(m.motivo || ''));
  console.log(`\n>> "29 - Retorno..." ${alvo
    ? `ENCONTRADO: ${alvo.n} apontamentos ("${alvo.motivo}"), ${alvo.abertos} sem fim`
    : 'NAO aparece no periodo — a regua nova nasceria vazia'}`);

  // ── 3. Cobertura por dia ──────────────────────────────────────────────────
  // Sessão com HE e sessão com intervalo são conjuntos diferentes; o que
  // interessa aqui é se o DIA foi coletado. Dia com sessões no snapshot e
  // NENHUM intervalo é dia que o cron não varreu.
  const { rows: cob } = await pool.query(
    `WITH dias AS (
       SELECT DISTINCT date AS dia FROM public.snapshots
        WHERE date BETWEEN $1::date AND $2::date AND session_begin IS NOT NULL),
     iv AS (
       SELECT data AS dia, count(*) AS n,
              count(*) FILTER (WHERE motivo ~ $3) AS n29
         FROM public.sessao_intervalo
        WHERE data BETWEEN $1::date AND $2::date
        GROUP BY data)
     SELECT to_char(d.dia, 'YYYY-MM-DD') AS dia,
            COALESCE(iv.n, 0) AS n, COALESCE(iv.n29, 0) AS n29
       FROM dias d LEFT JOIN iv ON iv.dia = d.dia
      ORDER BY d.dia`, [DE, ATE, RE_29]);

  console.log('\nCOBERTURA POR DIA (intervalos coletados / dos quais "29")');
  console.log('  dia          intervalos    "29"');
  let semNada = 0;
  for (const r of cob) {
    if (Number(r.n) === 0) semNada++;
    console.log(`  ${r.dia}   ${pad(r.n, 10)} ${pad(r.n29, 7)}`
      + (Number(r.n) === 0 ? '   <- dia SEM coleta de intervalo' : ''));
  }
  console.log(`\n${semNada} de ${cob.length} dia(s) sem nenhum intervalo coletado.`);

  // ── 4. O ORÁCULO DO FUSO ──────────────────────────────────────────────────
  // Duas leituras do MESMO instante gravado:
  //   h_utc    → o normalizador estava certo, a EDP manda UTC
  //   h_parede → a EDP manda parede (como session_begin) e o 'Z' foi um erro
  // Almoço entre 11h e 14h decide qual.
  const { rows: fuso } = await pool.query(
    `SELECT extract(hour FROM inicio AT TIME ZONE 'America/Sao_Paulo') AS h_utc,
            extract(hour FROM inicio AT TIME ZONE 'UTC')               AS h_parede,
            count(*) AS n
       FROM public.sessao_intervalo
      WHERE data BETWEEN $1::date AND $2::date
        AND motivo ILIKE '%refei%'
      GROUP BY 1, 2 ORDER BY n DESC LIMIT 12`, [DE, ATE]);

  console.log('\nORACULO DO FUSO — hora do "Horario de Refeicao"');
  if (!fuso.length) {
    console.log('  (nenhum apontamento de refeicao no periodo — sem oraculo)');
  } else {
    console.log('      n   lendo como UTC   lendo como parede');
    for (const f of fuso) {
      console.log(`${pad(f.n, 7)} ${pad(f.h_utc + 'h', 16)} ${pad(f.h_parede + 'h', 19)}`);
    }
    const dentro = col => fuso
      .filter(f => Number(f[col]) >= 11 && Number(f[col]) <= 14)
      .reduce((s, f) => s + Number(f.n), 0);
    const total = fuso.reduce((s, f) => s + Number(f.n), 0);
    const aUtc = dentro('h_utc'), aParede = dentro('h_parede');
    console.log(`\n  entre 11h e 14h:  como UTC ${aUtc}/${total}`
      + `   |   como parede ${aParede}/${total}`);
    console.log(`  >> leitura correta: ${aUtc > aParede
      ? "inicio AT TIME ZONE 'America/Sao_Paulo'  (a EDP manda UTC, o 'Z' esta certo)"
      : aParede > aUtc
        ? "inicio AT TIME ZONE 'UTC'  (a EDP manda PAREDE — o 'Z' anexado erra 3h)"
        : 'EMPATE — nao decida por este oraculo, investigue caso a caso'}`);
  }

  // ── 5. Como o "29" se posiciona na sessão ─────────────────────────────────
  // Amostra crua, pra olho humano: o retorno tem de cair perto do FIM da
  // sessão. Se cair no meio da tarde, ou não é o que eu penso que é, ou o fuso
  // está errado. As duas leituras vão lado a lado de propósito.
  const { rows: amostra } = await pool.query(
    `SELECT si.equipe, to_char(si.data, 'YYYY-MM-DD') AS dia,
            to_char(si.inicio AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI') AS ini_utc,
            to_char(si.inicio AT TIME ZONE 'UTC',               'HH24:MI') AS ini_parede,
            to_char(si.fim    AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI') AS fim_utc,
            to_char(si.fim    AT TIME ZONE 'UTC',               'HH24:MI') AS fim_parede,
            EXTRACT(epoch FROM (si.fim - si.inicio))/60 AS dur_min,
            substring(COALESCE(sn.session_end, '') from 12 for 5) AS logoff_parede
       FROM public.sessao_intervalo si
       LEFT JOIN LATERAL (
            SELECT COALESCE(s.session_end, s.data->>'sessionEnd') AS session_end
              FROM public.snapshots s
             WHERE upper(btrim(s.team_name)) = upper(btrim(si.equipe))
               AND s.date = si.data
               AND s.session_begin IS NOT NULL
             ORDER BY s.captured_at DESC LIMIT 1) sn ON TRUE
      WHERE si.data BETWEEN $1::date AND $2::date
        AND si.motivo ~ $3
      ORDER BY si.data DESC, si.equipe LIMIT 15`, [DE, ATE, RE_29]);

  console.log('\nAMOSTRA DO "29" (dur em min; logoff e hora de parede do snapshot)');
  if (!amostra.length) {
    console.log('  (nenhum "29" no periodo)');
  } else {
    console.log('  dia         equipe        ini(UTC) ini(par) fim(UTC) fim(par)  dur  logoff');
    for (const a of amostra) {
      console.log(`  ${a.dia}  ${String(a.equipe || '').padEnd(12)}`
        + ` ${pad(a.ini_utc, 8)} ${pad(a.ini_parede, 8)}`
        + ` ${pad(a.fim_utc, 8)} ${pad(a.fim_parede, 8)}`
        + ` ${pad(a.dur_min == null ? '' : Math.round(a.dur_min), 4)}`
        + ` ${pad(a.logoff_parede, 7)}`);
    }
    console.log('\n  A leitura certa e a coluna cujo `ini` cai POUCO ANTES do logoff.');
  }

  console.log('');
  process.exit(0);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
