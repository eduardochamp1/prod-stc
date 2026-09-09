#!/usr/bin/env node
/**
 * scripts/diag-he-sessoes-abertas.js
 *
 * ⚠️ ESTRITAMENTE READ-ONLY. Só SELECT. Não escreve nada, em nenhuma tabela.
 *
 * ── A PERGUNTA ──────────────────────────────────────────────────────────────
 * A Medição HE de 16–31/08/2026 acusou **26 linhas com sessão ABERTA** num
 * período já fechado. Sessão sem logoff tem prorrogação DESCONHECIDA, então
 * essas linhas cobram MENOS que o devido — ou não deveriam ser cobradas.
 *
 * Antes de decidir o que fazer com elas, é preciso saber o que são. Três
 * explicações possíveis, e cada uma pede uma ação diferente:
 *
 *   (a) EQUIPE NÃO DESLOGOU — comportamento de campo. O turno acabou e ninguém
 *       fechou a sessão no app. É problema operacional, não do painel.
 *   (b) JANELA DE COLETA CURTA — a sessão fechou, mas DEPOIS do último snapshot
 *       que a medição olha. A medição usa lookahead de +1 dia
 *       (`db/heQueries.js`, comentário do LOOKAHEAD); se o logoff veio no 2º
 *       dia, ele existe no banco e a medição simplesmente não alcança. Isso
 *       seria BUG NOSSO, e o conserto é ampliar o lookahead.
 *   (c) SESSÃO ABANDONADA — a equipe logou de novo depois (nova `session_begin`)
 *       sem nunca fechar a anterior. A sessão antiga é lixo e não deveria virar
 *       linha de cobrança.
 *
 * Este script separa as três. O `--dias N` procura o logoff numa janela LARGA
 * (default 7 dias), justamente pra distinguir (b) de (a).
 *
 *   node scripts/diag-he-sessoes-abertas.js
 *   node scripts/diag-he-sessoes-abertas.js --de 2026-08-16 --ate 2026-08-31
 *   node scripts/diag-he-sessoes-abertas.js --dias 15
 */

'use strict';

require('dotenv').config();

const { _getPool } = require('../services/pgShim');
// Reusa a leitura de parede da medição — a conta de duração tem de usar a
// MESMA regra do módulo que está sendo diagnosticado.
const { msParede } = require('../db/heQueries');

function arg(nome, padrao) {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}

const DE    = arg('de', '2026-08-16');
const ATE   = arg('ate', '2026-08-31');
const DIAS  = Math.max(1, Number(arg('dias', 7)) || 7);
const LIMITE_LISTA = Number(arg('listar', 40)) || 40;

const h = ms => (ms / 3600000);
const fmtH = ms => `${h(ms).toFixed(1)}h`;

async function main() {
  const pool = _getPool();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(DE) || !/^\d{4}-\d{2}-\d{2}$/.test(ATE)) {
    console.error('✖ datas em YYYY-MM-DD');
    process.exit(1);
  }

  console.log(`\n── Sessões do período ${DE} a ${ATE} `
    + `(logoff procurado até ${DIAS} dia(s) depois) ──\n`);

  // Último estado conhecido de CADA sessão. A janela vai muito além de `ATE`
  // de propósito: é o que permite ver se o logoff existe fora do alcance da
  // medição (hipótese "b").
  // ⚠️ DOIS DETALHES DE TIPO, os dois já erraram (09/09/2026):
  //
  // 1. `$4`/`$5` em vez de reusar `$1`/`$2` no filtro de texto. O Postgres
  //    infere o tipo do parâmetro pelo 1º uso: com `$1::date` no CTE, o `$1`
  //    vira `date`, e `substring(...) BETWEEN $1 AND $2` estoura com
  //    "operator does not exist: text >= date".
  //
  // 2. `captured_at` vem convertido pra PAREDE BRT aqui, no SQL. Ele é
  //    timestamptz (instante absoluto) e `session_begin` é hora de parede sem
  //    fuso. Subtrair um do outro na VM (que roda em UTC) erra 3 horas — é a
  //    mesma armadilha descrita no cabeçalho de `db/heQueries.js`, e eu a
  //    cometi justamente no script que diagnostica aquele módulo.
  const { rows } = await pool.query(
    `WITH ultimo AS (
       SELECT DISTINCT ON (team_name, session_begin)
              upper(btrim(team_name)) AS equipe, regional,
              session_begin,
              -- ATENCAO: sem crase aqui dentro. Este comentario SQL vive num
              -- template literal, e crase fecha a string. Ver o COALESCE em
              -- db/heQueries.js: o job das 03:00 grava o logoff so no jsonb.
              COALESCE(session_end, data->>'sessionEnd', data->>'session_end') AS session_end,
              session_end AS session_end_coluna,
              data->>'sessionEnd' AS session_end_payload,
              to_char(captured_at AT TIME ZONE 'America/Sao_Paulo',
                      'YYYY-MM-DD"T"HH24:MI:SS') AS visto_em
         FROM public.snapshots
        WHERE date BETWEEN $1::date AND ($2::date + $3::int)
          AND session_begin IS NOT NULL
        ORDER BY team_name, session_begin, captured_at DESC
     )
     SELECT * FROM ultimo
      WHERE substring(session_begin, 1, 10) BETWEEN $4 AND $5
      ORDER BY session_begin, equipe`,
    [DE, ATE, DIAS, DE, ATE]);

  if (!rows.length) { console.log('Nenhuma sessão no período.\n'); return; }

  const abertas = rows.filter(r => !r.session_end);
  // Quantas dependem do jsonb pra ter logoff. Foi o que enganou a 1ª execução
  // deste script: 277 "abertas" que na verdade tinham o logoff gravado pelo
  // job das 03:00, só não na coluna.
  const soNoPayload = rows.filter(r => !r.session_end_coluna && r.session_end_payload);
  console.log(`Sessões no período:        ${rows.length}`);
  console.log(`Com logoff registrado:     ${rows.length - abertas.length}`);
  console.log(`SEM logoff (abertas):      ${abertas.length}`
    + `  (${(100 * abertas.length / rows.length).toFixed(1)}%)\n`);

  console.log('── Onde o logoff está gravado ──\n');
  console.log(`  Só no jsonb, coluna NULL:  ${soNoPayload.length}`);
  console.log('  Estas são turnos que atravessam a meia-noite: o logoff vem do');
  console.log('  job runSyncLogoffs (03:00), que grava apenas o payload —');
  console.log('  services/cronService.js:1619. Ler só a coluna as tratava como');
  console.log('  sessão aberta e subnotificava a prorrogação do turno noturno.');
  console.log('  ⇒ A medição usa COALESCE(coluna, payload) desde 09/09/2026.\n');

  if (!abertas.length) {
    console.log('✔ Nenhuma sessão aberta no período — nada a analisar.\n');
    return;
  }

  // Para cada sessão aberta: a equipe logou DE NOVO depois? (hipótese "c")
  const proximoLogin = new Map();
  for (const r of rows) {
    const lista = proximoLogin.get(r.equipe) || [];
    lista.push(r.session_begin);
    proximoLogin.set(r.equipe, lista);
  }

  const classificadas = abertas.map(r => {
    // Os DOIS lados como parede BRT, pela mesma função que a medição usa.
    // `Date.parse` direto misturaria parede com instante e erraria 3h.
    const inicioMs = msParede(r.session_begin);
    const ultimoMs = msParede(r.visto_em);
    const logins   = (proximoLogin.get(r.equipe) || [])
      .filter(b => String(b) > String(r.session_begin));
    return {
      ...r,
      abertaMs: (inicioMs != null && ultimoMs != null) ? ultimoMs - inicioMs : null,
      relogouDepois: logins.length > 0,
      proximoLoginEm: logins.sort()[0] || null,
    };
  });

  // ── Classificação ─────────────────────────────────────────────────────────
  // A janela larga de busca é o que separa "o logoff não existe" de "o logoff
  // existe mas a medição não alcança". Como o SELECT já cobriu ATE+DIAS e a
  // sessão SEGUE sem logoff, a hipótese (b) fica DESCARTADA por construção.
  const abandonadas = classificadas.filter(c => c.relogouDepois);
  const semLogoff   = classificadas.filter(c => !c.relogouDepois);

  console.log('── Classificação ──\n');
  console.log(`Busca cobriu ${DIAS} dia(s) além do período, e nem a coluna nem o`);
  console.log('payload têm logoff pra estas. Ampliar o lookahead não resolve.\n');
  console.log(`(c) Relogou depois: ${abandonadas.length}`);
  console.log('    ⚠️ NÃO CONCLUA "abandono" só por isso. Turno diário relogá');
  console.log('    todo dia no mesmo horário — na 1ª execução deste script, em');
  console.log('    09/09/2026, o critério "logou de novo = abandonada" rotulou');
  console.log('    259 turnos noturnos legítimos como lixo. Abandono de verdade');
  console.log('    é o relogin MUITO antes do turno seguinte; olhe a coluna');
  console.log('    "relogou depois" na lista e compare com o horário do login.\n');
  console.log(`(a) Sem relogin posterior: ${semLogoff.length}`);
  console.log('    Prorrogação imensurável. Estas cobram só a antecipação.\n');

  // ── Reincidência ──────────────────────────────────────────────────────────
  const porEquipe = new Map();
  for (const c of classificadas) {
    porEquipe.set(c.equipe, (porEquipe.get(c.equipe) || 0) + 1);
  }
  const ranking = [...porEquipe.entries()].sort((a, b) => b[1] - a[1]);
  console.log('── Reincidência por equipe ──\n');
  console.log(`${porEquipe.size} equipe(s) distinta(s). Top:`);
  for (const [eq, n] of ranking.slice(0, 12)) {
    console.log(`  ${eq.padEnd(10)} ${String(n).padStart(3)} sessão(ões) aberta(s)`);
  }
  const concentracao = ranking.slice(0, 3).reduce((s, [, n]) => s + n, 0);
  console.log(`\n  As 3 primeiras concentram ${concentracao} de ${classificadas.length} `
    + `(${(100 * concentracao / classificadas.length).toFixed(0)}%).`);
  console.log(concentracao / classificadas.length > 0.5
    ? '  ⇒ CONCENTRADO em poucas equipes: é hábito de turma, tratável com cobrança.'
    : '  ⇒ ESPALHADO entre equipes: sugere comportamento geral do app, não turma.\n');

  // ── Por regional ──────────────────────────────────────────────────────────
  const porReg = new Map();
  for (const c of classificadas) porReg.set(c.regional, (porReg.get(c.regional) || 0) + 1);
  console.log('\n── Por regional ──\n');
  for (const [reg, n] of [...porReg.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(reg).padEnd(6)} ${String(n).padStart(3)}`);
  }

  // ── Quanto tempo "abertas" ────────────────────────────────────────────────
  const durs = classificadas.map(c => c.abertaMs).filter(v => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  if (durs.length) {
    const p = q => durs[Math.min(durs.length - 1, Math.floor(q * durs.length))];
    console.log('\n── Tempo entre o login e o último snapshot que ainda a via aberta ──\n');
    console.log(`  mínimo  ${fmtH(durs[0])}`);
    console.log(`  mediana ${fmtH(p(0.5))}`);
    console.log(`  máximo  ${fmtH(durs[durs.length - 1])}`);
    console.log('\n  ⚠️ Isto NÃO é a duração do turno — é até onde a coleta viu a');
    console.log('  sessão sem logoff. Valor absurdo (dias) confirma abandono.');
  }

  // ── Lista ─────────────────────────────────────────────────────────────────
  console.log(`\n── Detalhe (${Math.min(LIMITE_LISTA, classificadas.length)} `
    + `de ${classificadas.length}) ──\n`);
  console.log('equipe     reg    login                 último snapshot       aberta  relogou depois');
  for (const c of classificadas.slice(0, LIMITE_LISTA)) {
    console.log(
      `${c.equipe.padEnd(10)} ${String(c.regional || '—').padEnd(6)} `
      + `${String(c.session_begin).slice(0, 19).padEnd(21)} `
      + `${String(c.visto_em).replace('T', ' ').padEnd(21)} `
      + `${(c.abertaMs != null ? fmtH(c.abertaMs) : '—').padStart(7)}  `
      + (c.relogouDepois ? `sim, ${String(c.proximoLoginEm).slice(0, 16)}` : 'não'));
  }

  console.log('\n── O que isto decide ──\n');
  console.log('  • Se (c) domina: excluir sessão abandonada da medição. Ela nunca');
  console.log('    foi turno — é registro órfão, e cobrar por ela é indefensável.');
  console.log('  • Se (a) domina: decisão de negócio. As linhas cobram só a');
  console.log('    antecipação e subnotificam a prorrogação. Cobrar assim é');
  console.log('    conservador; deixá-las fora perde hora extra real.');
  console.log('  • Em qualquer caso, a reincidência por equipe é acionável na');
  console.log('    operação, independente do que se decida na fatura.\n');
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error('\n✖', err.message); process.exit(1); });
