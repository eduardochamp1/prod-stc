#!/usr/bin/env node
/**
 * scripts/diag-escala-agora.js
 * DIAGNÓSTICO READ-ONLY do KPI "esperadas agora" (GET /api/escala/agora).
 *
 * Uso (na VM):
 *   cd ~/prod-stc && node scripts/diag-escala-agora.js
 *
 * Contexto (30/08/2026). O KPI do Monitor passou a mostrar EM CAMPO × ESPERADAS
 * pela escala (commits 29ef830 e 441f4a1) e o número não bate com o que a
 * operação enxerga. Este script NÃO corrige nada — ele mede ONDE o cruzamento
 * perde (ou ganha) equipe, porque "esperadas" é produto de três JOINs e o erro
 * pode estar em qualquer um deles:
 *
 *   escala_dia ──(codigo_escala = codigo)──> escalas_catalogo   ← o horário
 *        └──────(equipe = sigla)───────────> equipes_oficiais   ← a whitelist
 *
 * SUSPEITA PRINCIPAL, que o bloco 2 confirma ou derruba: o JOIN do código é
 * igualdade EXATA, enquanto wpaService._scaleEndFromCatalog — que faz o MESMO
 * casamento no fluxo ao vivo — precisa casar pelo código completo E pelo
 * prefixo, com trim/upper, porque "o catálogo pode trazer o código completo ou
 * só o prefixo". Se os dois lados divergirem, a equipe some do esperado sem
 * erro nenhum no log.
 *
 * Não escreve nada. Só SELECT. Seguro rodar a qualquer hora.
 */

require('dotenv').config({ override: true });

const { dateBRT } = require('../services/timeUtil');
const { ESCALA_NAO_TRABALHADA } = require('../services/escalaDia');
const {
  equipesEsperadasAgora, minutosDoDia, turnoCobreAgora, diaAnterior, diaISO,
} = require('../db/escalaQueries');

let pool;
try {
  pool = require('../services/pgShim')._getPool();
} catch (err) {
  console.error('\n[diag-escala-agora] Não consegui abrir o pool Postgres:', err.message);
  console.error('[diag-escala-agora] Exige DATABASE_URL no .env (Postgres local).\n');
  process.exit(1);
}

const H    = (s) => console.log(`\n${'═'.repeat(74)}\n  ${s}\n${'═'.repeat(74)}`);
const ok   = (s) => console.log(`  ✅ ${s}`);
const warn = (s) => console.log(`  ⚠️  ${s}`);
const bad  = (s) => console.log(`  ❌ ${s}`);
const info = (s) => console.log(`  ·  ${s}`);
const hhmm = (t) => (t == null ? '—' : String(t).slice(0, 5));

/** Tabela simples, sem dependência: alinha pela largura da maior célula. */
function tabela(linhas, colunas) {
  if (!linhas.length) { info('(nenhuma linha)'); return; }
  const larg = colunas.map(c =>
    Math.max(c.rotulo.length, ...linhas.map(l => String(c.get(l) ?? '').length)));
  console.log('  ' + colunas.map((c, i) => c.rotulo.padEnd(larg[i])).join('  '));
  console.log('  ' + larg.map(w => '─'.repeat(w)).join('──'));
  for (const l of linhas) {
    console.log('  ' + colunas.map((c, i) => String(c.get(l) ?? '').padEnd(larg[i])).join('  '));
  }
}

(async () => {
  const agora  = new Date();
  const hoje   = dateBRT(agora);
  const ontem  = diaAnterior(hoje);
  const horaBR = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(agora);
  const agoraMin = minutosDoDia(horaBR);

  H('0. REFERÊNCIA');
  info(`agora (BRT) ......... ${hoje} ${horaBR}  (${agoraMin} min do dia)`);
  info(`dias consultados .... ontem=${ontem}  hoje=${hoje}`);
  info(`relógio do processo . ${agora.toISOString()} (UTC)`);

  // ── 1. As tabelas foram populadas? ────────────────────────────────────────
  // O cron de escala_dia roda 1x/dia às 05:20 BRT. Se o último sync for de
  // anteontem, nada abaixo importa — o dado está VELHO, não errado.
  H('1. COBERTURA DAS TABELAS');
  const { rows: cobEscala } = await pool.query(
    `SELECT to_char(data,'YYYY-MM-DD') AS dia, sector_id,
            count(*) AS linhas, count(DISTINCT equipe) AS equipes,
            count(DISTINCT codigo_escala) AS codigos,
            to_char(max(updated_at) AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') AS ultimo_sync
       FROM public.escala_dia WHERE data IN ($1::date,$2::date)
      GROUP BY 1,2 ORDER BY 1,2`, [ontem, hoje]);
  console.log('\n  escala_dia (dias escalados — vem do SGE/collaboratorshifts):');
  tabela(cobEscala, [
    { rotulo: 'dia',     get: r => r.dia },
    { rotulo: 'setor',   get: r => r.sector_id },
    { rotulo: 'linhas',  get: r => r.linhas },
    { rotulo: 'equipes', get: r => r.equipes },
    { rotulo: 'códigos', get: r => r.codigos },
    { rotulo: 'sync',    get: r => r.ultimo_sync },
  ]);
  if (!cobEscala.some(r => r.dia === hoje)) {
    bad('escala_dia NÃO tem linha nenhuma de hoje — o KPI só pode dar 0 ou quase.');
    info('   rode: curl -XPOST localhost:3002/api/admin/sync-escala-dia');
  }

  const { rows: cobCat } = await pool.query(
    `SELECT sector_id, count(*) AS turnos,
            count(*) FILTER (WHERE inicio_escala IS NOT NULL AND fim_escala IS NOT NULL) AS com_horario,
            to_char(max(updated_at) AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') AS ultimo_sync
       FROM public.escalas_catalogo GROUP BY 1 ORDER BY 1`);
  console.log('\n  escalas_catalogo (horário de cada código):');
  tabela(cobCat, [
    { rotulo: 'setor',      get: r => r.sector_id },
    { rotulo: 'turnos',     get: r => r.turnos },
    { rotulo: 'c/ horário', get: r => r.com_horario },
    { rotulo: 'sync',       get: r => r.ultimo_sync },
  ]);
  const setoresCat = new Set(cobCat.map(r => r.sector_id));
  for (const s of new Set(cobEscala.map(r => r.sector_id))) {
    if (!setoresCat.has(s)) {
      bad(`setor ${s} tem escala mas NÃO tem catálogo — todas as equipes dele somem do esperado.`);
    }
  }

  // ── 2. O JOIN do código: quanto a igualdade exata está custando ───────────
  H('2. JOIN DO CÓDIGO — escala_dia.codigo_escala = escalas_catalogo.codigo');
  const { rows: orfaos } = await pool.query(
    `SELECT ed.sector_id, ed.codigo_escala,
            count(*) AS linhas, count(DISTINCT ed.equipe) AS equipes,
            (SELECT string_agg(DISTINCT ec2.codigo || '  [' ||
                      coalesce(to_char(ec2.inicio_escala,'HH24:MI'),'—') || '→' ||
                      coalesce(to_char(ec2.fim_escala,'HH24:MI'),'—') || ']', ' | ')
               FROM public.escalas_catalogo ec2
              WHERE ec2.sector_id = ed.sector_id
                AND regexp_replace(upper(btrim(ec2.codigo)), '[[:space:]].*$', '')
                  = regexp_replace(upper(btrim(ed.codigo_escala)), '[[:space:]].*$', '')
            ) AS candidatos_por_prefixo
       FROM public.escala_dia ed
       LEFT JOIN public.escalas_catalogo ec
         ON ec.codigo = ed.codigo_escala AND ec.sector_id = ed.sector_id
      WHERE ed.data = $1::date AND ec.codigo IS NULL
      GROUP BY 1,2 ORDER BY 3 DESC`, [hoje]);

  if (orfaos.length === 0) {
    ok('todo código de hoje casou EXATO com o catálogo. A suspeita principal cai.');
  } else {
    bad(`${orfaos.length} código(s) de hoje NÃO casam exato com o catálogo.`);
    console.log('');
    tabela(orfaos, [
      { rotulo: 'setor',   get: r => r.sector_id },
      { rotulo: 'código',  get: r => `"${r.codigo_escala}"` },
      { rotulo: 'linhas',  get: r => r.linhas },
      { rotulo: 'equipes', get: r => r.equipes },
      { rotulo: 'no catálogo, mesmo prefixo', get: r => r.candidatos_por_prefixo || '(nenhum)' },
    ]);
    console.log('');
    const recuperaveis = orfaos.filter(r => r.candidatos_por_prefixo);
    const perdidos     = orfaos.filter(r => !r.candidatos_por_prefixo);
    if (recuperaveis.length) {
      warn(`${recuperaveis.length} deles EXISTEM no catálogo com grafia diferente —`);
      info('   são equipes que o KPI perde por formato de string, não por escala.');
      // Prefixo ambíguo é o motivo pelo qual "casar por prefixo" não pode ser
      // aplicado no escuro: C08 07:00 e C08 19:00 têm o mesmo prefixo e janelas
      // opostas. Se aparecer aqui, a correção precisa de regra de desempate.
      const ambiguos = recuperaveis.filter(r => String(r.candidatos_por_prefixo).includes(' | '));
      if (ambiguos.length) {
        bad(`  ATENÇÃO: ${ambiguos.length} têm MAIS DE UM candidato (prefixo ambíguo).`);
        info('  Casar por prefixo aqui escolheria a janela no chute — precisa de desempate.');
      } else {
        ok('  nenhum prefixo ambíguo: cada órfão tem 1 único candidato no catálogo.');
      }
    }
    if (perdidos.length) {
      info(`${perdidos.length} não existem no catálogo nem por prefixo — ou é folga (esperado),`);
      info('   ou é turno que a EDP não catalogou (aí o catálogo é que está incompleto).');
    }
  }

  // ── 3. O JOIN da equipe: whitelist × sigla da escala ──────────────────────
  H('3. JOIN DA EQUIPE — escala_dia.equipe = equipes_oficiais.sigla');
  const { rows: foraWhitelist } = await pool.query(
    `SELECT DISTINCT ed.equipe, ed.sector_id
       FROM public.escala_dia ed
       LEFT JOIN public.equipes_oficiais eo
         ON upper(btrim(eo.sigla)) = upper(btrim(ed.equipe)) AND eo.ativo
      WHERE ed.data = $1::date AND eo.sigla IS NULL
      ORDER BY 1`, [hoje]);
  info(`equipes escaladas hoje FORA da whitelist ativa: ${foraWhitelist.length}`);
  if (foraWhitelist.length) {
    info('(esperado até certo ponto — whitelist é filtro de negócio, equipes faturadas)');
    console.log('  ' + foraWhitelist.map(r => `${r.equipe}(${r.sector_id})`).join(', '));
  }

  const { rows: semEscala } = await pool.query(
    `SELECT eo.sigla, eo.tipo, eo.regional
       FROM public.equipes_oficiais eo
      WHERE eo.ativo
        AND NOT EXISTS (SELECT 1 FROM public.escala_dia ed
                         WHERE ed.data = $1::date
                           AND upper(btrim(ed.equipe)) = upper(btrim(eo.sigla)))
      ORDER BY eo.regional, eo.sigla`, [hoje]);
  const { rows: [{ total: totalWl }] } = await pool.query(
    `SELECT count(*)::int AS total FROM public.equipes_oficiais WHERE ativo`);
  console.log('');
  if (semEscala.length === 0) {
    ok(`todas as ${totalWl} equipes da whitelist têm escala cadastrada hoje.`);
  } else {
    warn(`${semEscala.length} de ${totalWl} equipes da whitelist NÃO têm NENHUMA linha de escala hoje.`);
    info('Elas são INVISÍVEIS pro KPI: nunca entram em "esperadas", em nenhum horário.');
    info('(escalaDia.js trata "sem dado" como escalada; escalaQueries.js, como não-escalada —');
    info(' as duas superfícies discordam, e é o KPI que puxa o número pra baixo.)');
    const porReg = {};
    for (const r of semEscala) (porReg[r.regional || '—'] ||= []).push(r.sigla);
    for (const [reg, siglas] of Object.entries(porReg)) {
      console.log(`     ${reg} (${siglas.length}): ${siglas.join(', ')}`);
    }
  }

  // ── 4. Códigos de folga COM horário: o lado que INFLA ─────────────────────
  // escalaQueries aposta que DR/FER/AFO vêm do catálogo sem horário e caem
  // sozinhos no filtro de horário não-nulo. Se a aposta falhar, folga vira
  // "esperada" e o KPI acusa um buraco que não existe.
  H('4. CÓDIGOS NÃO-TRABALHADOS QUE TÊM HORÁRIO NO CATÁLOGO');
  const { rows: folgaComHora } = await pool.query(
    `SELECT sector_id, codigo, descricao,
            to_char(inicio_escala,'HH24:MI') AS ini, to_char(fim_escala,'HH24:MI') AS fim
       FROM public.escalas_catalogo
      WHERE regexp_replace(upper(btrim(codigo)), '[[:space:]].*$', '') = ANY($1::text[])
        AND inicio_escala IS NOT NULL AND fim_escala IS NOT NULL
      ORDER BY 1,2`, [[...ESCALA_NAO_TRABALHADA]]);
  if (folgaComHora.length === 0) {
    ok('nenhum. A premissa do escalaQueries se sustenta: folga sai sozinha pelo filtro de horário.');
  } else {
    bad(`${folgaComHora.length} código(s) de folga/afastamento TÊM horário — contam como "esperadas".`);
    console.log('');
    tabela(folgaComHora, [
      { rotulo: 'setor',     get: r => r.sector_id },
      { rotulo: 'código',    get: r => r.codigo },
      { rotulo: 'janela',    get: r => `${r.ini}→${r.fim}` },
      { rotulo: 'descrição', get: r => r.descricao || '—' },
    ]);
    console.log('');
    info('Isso INFLA o esperado: equipe de folga entra na conta.');
    const { rows: [{ n }] } = await pool.query(
      `SELECT count(DISTINCT ed.equipe)::int AS n
         FROM public.escala_dia ed
         JOIN public.equipes_oficiais eo
           ON upper(btrim(eo.sigla)) = upper(btrim(ed.equipe)) AND eo.ativo
        WHERE ed.data = $1::date
          AND regexp_replace(upper(btrim(ed.codigo_escala)), '[[:space:]].*$', '') = ANY($2::text[])`,
      [hoje, [...ESCALA_NAO_TRABALHADA]]);
    info(`equipes da whitelist com código não-trabalhado hoje: ${n}`);
  }

  // ── 5. O número real, e o que ele seria com o JOIN tolerante ──────────────
  H('5. VEREDITO — esperadas agora');
  const atual = await equipesEsperadasAgora(null, agora);
  info(`regra ATUAL (JOIN exato) ......... ${atual.esperadas} equipes`);

  // Mesma query do KPI, mas casando o código por prefixo normalizado — igual ao
  // que wpaService._scaleEndFromCatalog já faz no fluxo ao vivo.
  const { rows: linhasTol } = await pool.query(
    `SELECT to_char(ed.data,'YYYY-MM-DD') AS data, eo.sigla, eo.tipo, eo.regional,
            ed.codigo_escala, ec.codigo AS codigo_catalogo,
            ec.inicio_escala, ec.fim_escala
       FROM public.escala_dia ed
       JOIN public.escalas_catalogo ec
         ON ec.sector_id = ed.sector_id
        AND regexp_replace(upper(btrim(ec.codigo)), '[[:space:]].*$', '')
          = regexp_replace(upper(btrim(ed.codigo_escala)), '[[:space:]].*$', '')
       JOIN public.equipes_oficiais eo
         ON upper(btrim(eo.sigla)) = upper(btrim(ed.equipe)) AND eo.ativo
      WHERE ed.data IN ($1::date, $2::date)
        AND ec.inicio_escala IS NOT NULL AND ec.fim_escala IS NOT NULL`, [ontem, hoje]);

  const cobertasTol = new Map();
  for (const l of linhasTol) {
    const dia = diaISO(l.data);
    if (!dia) continue;
    const cobre = turnoCobreAgora(
      minutosDoDia(l.inicio_escala), minutosDoDia(l.fim_escala), agoraMin, dia !== hoje);
    if (!cobre) continue;
    const sigla = String(l.sigla || '').toUpperCase().trim();
    if (!sigla || cobertasTol.has(sigla)) continue;
    cobertasTol.set(sigla, l);
  }
  info(`regra TOLERANTE (por prefixo) .... ${cobertasTol.size} equipes`);

  const delta = cobertasTol.size - atual.esperadas;
  console.log('');
  if (delta === 0) {
    ok('As duas regras dão o mesmo número — o formato do código NÃO é a causa.');
    info('Se o KPI ainda está errado, olhe o bloco 3 (cobertura) e o bloco 4 (folga com horário).');
  } else {
    bad(`DIFERENÇA DE ${delta} EQUIPE(S) — o JOIN exato perde equipe por grafia de código.`);
    const soTol = [...cobertasTol.keys()].filter(s => !atual.equipes.includes(s)).sort();
    if (soTol.length) info(`entram só na tolerante: ${soTol.join(', ')}`);
  }

  console.log('');
  info('Equipes que a regra ATUAL diz estarem escaladas agora:');
  console.log('     ' + (atual.equipes.length ? atual.equipes.join(', ') : '(nenhuma)'));
  info(`por tipo: ${JSON.stringify(atual.porTipo)}`);

  // Detalhe nominal — é o que permite conferir equipe a equipe contra a tela de
  // Escala do portal, que é a fonte que a operação enxerga.
  console.log('');
  info('Detalhe (regra tolerante), pra bater com a tela de Escala do WPA:');
  console.log('');
  tabela([...cobertasTol.values()].sort((a, b) => String(a.sigla).localeCompare(String(b.sigla))), [
    { rotulo: 'equipe',     get: r => r.sigla },
    { rotulo: 'tipo',       get: r => r.tipo || '—' },
    { rotulo: 'regional',   get: r => r.regional || '—' },
    { rotulo: 'cód.escala', get: r => r.codigo_escala },
    { rotulo: 'cód.catál.', get: r => r.codigo_catalogo },
    { rotulo: 'janela',     get: r => `${hhmm(r.inicio_escala)}→${hhmm(r.fim_escala)}` },
    { rotulo: 'dia',        get: r => (diaISO(r.data) === hoje ? 'hoje' : 'ontem') },
  ]);

  console.log('');
  await pool.end();
})().catch(async (err) => {
  console.error('\n[diag-escala-agora] falhou:', err.message);
  console.error(err.stack);
  try { await pool.end(); } catch (_) { /* pool já fechado */ }
  process.exit(1);
});
