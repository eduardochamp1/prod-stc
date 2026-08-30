#!/usr/bin/env node
/**
 * scripts/diag-escala-semana.js
 * DIAGNÓSTICO READ-ONLY — por que há equipe NÃO-PLANTÃO escalada no domingo?
 *
 * Uso (na VM):
 *   cd ~/prod-stc && node scripts/diag-escala-semana.js
 *   cd ~/prod-stc && node scripts/diag-escala-semana.js 2026-08-30   (outro dia)
 *
 * Contexto (30/08/2026, domingo). O diag-escala-agora mostrou 39 equipes
 * esperadas às 15:58 de um DOMINGO, com esta quebra:
 *   {BTZERO:1, COMERCIAL:12, PLANTÃO:17, L1:1, A2:6, L3:2}
 * Plantão no domingo é esperado. 12 COMERCIAIS em T08 08:00→17:00, não —
 * a tela de Escala do portal mostra a comercial fazendo C08 de segunda a sexta
 * e DR em todo sábado e domingo.
 *
 * Já descartado: o JOIN de código casa exato (só DR fica órfão, e DR é folga
 * mesmo); nenhum código de folga tem horário no catálogo; e _dataDaEscala é
 * regex sobre a string, sem new Date() — não há off-by-one de fuso.
 *
 * Sobram duas causas, que INFLAM igual e se corrigem de formas OPOSTAS:
 *
 *   (b) MECANISMO NOSSO — equipesCobertas conta a equipe se QUALQUER colaborador
 *       dela tem turno agora. Se 5 estão em DR e 1 tem T08 cadastrado (um
 *       encarregado, um cadastro que nunca recebeu folga), a equipe inteira
 *       entra no esperado. O bloco 2 mede exatamente isso: trabalham/total.
 *
 *   (c) DADO DA EDP — a comercial é escalada no domingo mesmo, e a estranheza
 *       é da operação, não do código. O bloco 1 decide: se o perfil semanal
 *       mostrar comercial trabalhando em TODOS os domingos do mês, é padrão de
 *       cadastro; se hoje for o único, é anomalia pontual.
 *
 * Não escreve nada. Só SELECT.
 */

require('dotenv').config({ override: true });

const { dateBRT } = require('../services/timeUtil');
const { equipesEsperadasAgora } = require('../db/escalaQueries');

let pool;
try {
  pool = require('../services/pgShim')._getPool();
} catch (err) {
  console.error('\n[diag-escala-semana] Não consegui abrir o pool Postgres:', err.message);
  process.exit(1);
}

const H    = (s) => console.log(`\n${'═'.repeat(78)}\n  ${s}\n${'═'.repeat(78)}`);
const ok   = (s) => console.log(`  ✅ ${s}`);
const bad  = (s) => console.log(`  ❌ ${s}`);
const warn = (s) => console.log(`  ⚠️  ${s}`);
const info = (s) => console.log(`  ·  ${s}`);
const DOW  = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

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
  const hoje  = process.argv[2] && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[2])
    ? process.argv[2] : dateBRT();
  const [ano, mes] = hoje.split('-');
  const ini = `${ano}-${mes}-01`;
  const fim = new Date(Date.UTC(Number(ano), Number(mes), 0)).toISOString().slice(0, 10);

  H(`0. REFERÊNCIA — dia analisado: ${hoje}`);
  info(`mês varrido: ${ini} → ${fim}`);

  // ── 1. Perfil semanal: o cadastro distingue fim de semana? ────────────────
  // Conta, por DIA do mês, quantas equipes da whitelist têm ao menos um
  // colaborador com turno catalogado (mesma regra do KPI, sem o recorte de
  // hora). Se COMERCIAL some no sábado/domingo e reaparece na segunda, o
  // cadastro distingue — e o domingo de hoje é a anomalia. Se COMERCIAL tem o
  // mesmo número todo dia, o cadastro NUNCA dá folga e o KPI herda isso.
  H('1. PERFIL SEMANAL — equipes com turno cadastrado, por dia e por tipo');
  const { rows: perfil } = await pool.query(
    `SELECT to_char(ed.data,'YYYY-MM-DD') AS dia,
            extract(dow from ed.data)::int AS dow,
            coalesce(upper(eo.tipo),'—') AS tipo,
            count(DISTINCT upper(btrim(eo.sigla))) AS equipes
       FROM public.escala_dia ed
       JOIN public.escalas_catalogo ec
         ON ec.codigo = ed.codigo_escala AND ec.sector_id = ed.sector_id
        AND ec.inicio_escala IS NOT NULL AND ec.fim_escala IS NOT NULL
       JOIN public.equipes_oficiais eo
         ON upper(btrim(eo.sigla)) = upper(btrim(ed.equipe)) AND eo.ativo
      WHERE ed.data BETWEEN $1::date AND $2::date
      GROUP BY 1,2,3 ORDER BY 1,3`, [ini, fim]);

  const tipos = [...new Set(perfil.map(r => r.tipo))].sort();
  const porDia = new Map();
  for (const r of perfil) {
    if (!porDia.has(r.dia)) porDia.set(r.dia, { dia: r.dia, dow: r.dow, total: 0 });
    const d = porDia.get(r.dia);
    d[r.tipo] = Number(r.equipes);
    d.total += Number(r.equipes);
  }
  const dias = [...porDia.values()].sort((a, b) => a.dia.localeCompare(b.dia));
  tabela(dias, [
    { rotulo: 'dia', get: r => r.dia.slice(8) },
    { rotulo: 'dow', get: r => DOW[r.dow] },
    ...tipos.map(t => ({ rotulo: t.slice(0, 9), get: r => r[t] ?? 0 })),
    { rotulo: 'TOTAL', get: r => r.total },
    { rotulo: '', get: r => (r.dia === hoje ? '← hoje' : '') },
  ]);

  // Veredito automático: compara o tipo em fins de semana × dias úteis.
  console.log('');
  const fds  = dias.filter(d => d.dow === 0 || d.dow === 6);
  const uteis = dias.filter(d => d.dow !== 0 && d.dow !== 6);
  const media = (arr, t) => (arr.length ? arr.reduce((s, d) => s + (d[t] ?? 0), 0) / arr.length : 0);
  const cmp = tipos.map(t => ({
    tipo: t,
    util: media(uteis, t).toFixed(1),
    fds:  media(fds, t).toFixed(1),
    hoje: (porDia.get(hoje)?.[t]) ?? 0,
    razao: media(uteis, t) > 0 ? (media(fds, t) / media(uteis, t)) : 0,
  }));
  info('Média de equipes com turno cadastrado — dia útil × fim de semana:');
  console.log('');
  tabela(cmp, [
    { rotulo: 'tipo',           get: r => r.tipo },
    { rotulo: 'média seg-sex',  get: r => r.util },
    { rotulo: 'média sáb-dom',  get: r => r.fds },
    { rotulo: `em ${hoje.slice(8)}/${mes}`, get: r => r.hoje },
    { rotulo: 'fds/útil',       get: r => `${(r.razao * 100).toFixed(0)}%` },
  ]);
  console.log('');
  // PLANTÃO trabalhar todo fim de semana é o comportamento CORRETO — foi o que
  // o limiar de 90% acusou na 1ª rodada (30/08/2026), e acusar o certo treina o
  // leitor a ignorar o alerta. Só é achado quando o tipo NÃO é de plantão.
  const ehPlantao = t => /PLANT/.test(t);
  for (const c of cmp) {
    if (Number(c.util) <= 2) continue;                 // amostra pequena demais
    if (c.razao >= 0.9) {
      if (ehPlantao(c.tipo)) ok(`${c.tipo}: ${(c.razao * 100).toFixed(0)}% do dia útil no fim de semana — esperado para plantão.`);
      else bad(`${c.tipo}: o cadastro NÃO distingue fim de semana (${(c.razao * 100).toFixed(0)}% do dia útil).`);
    } else if (c.razao === 0) {
      ok(`${c.tipo}: zera no fim de semana — o cadastro distingue.`);
    } else if (!ehPlantao(c.tipo)) {
      warn(`${c.tipo}: ${(c.razao * 100).toFixed(0)}% do dia útil no fim de semana (${c.fds} de ${c.util}).`);
    }
  }

  // ── 2. O mecanismo: quantos colaboradores sustentam cada equipe? ──────────
  // equipesCobertas conta a equipe se QUALQUER colaborador tem turno agora.
  // Equipe que aparece com 1/6 é equipe que entrou no esperado pelo cadastro de
  // uma pessoa só — e é aí que o KPI deixa de descrever "equipe em campo".
  H('2. MECANISMO — quantos colaboradores sustentam cada equipe ESPERADA agora');
  const atual = await equipesEsperadasAgora(null);
  info(`esperadas agora: ${atual.esperadas} — ${JSON.stringify(atual.porTipo)}`);
  if (atual.equipes.length === 0) {
    info('(nenhuma equipe esperada neste instante — rode em horário de turno)');
  } else {
    const { rows: detalhe } = await pool.query(
      `SELECT upper(btrim(eo.sigla)) AS sigla, coalesce(upper(eo.tipo),'—') AS tipo,
              count(*) AS total,
              count(*) FILTER (WHERE ec.inicio_escala IS NOT NULL
                                 AND ec.fim_escala    IS NOT NULL) AS trabalham,
              string_agg(DISTINCT ed.codigo_escala, ', ' ORDER BY ed.codigo_escala) AS codigos,
              string_agg(DISTINCT coalesce(ed.colaborador_nome,'?'), ' | ')
                FILTER (WHERE ec.inicio_escala IS NOT NULL) AS quem_trabalha
         FROM public.escala_dia ed
         JOIN public.equipes_oficiais eo
           ON upper(btrim(eo.sigla)) = upper(btrim(ed.equipe)) AND eo.ativo
         LEFT JOIN public.escalas_catalogo ec
           ON ec.codigo = ed.codigo_escala AND ec.sector_id = ed.sector_id
        WHERE ed.data = $1::date
          AND upper(btrim(ed.equipe)) = ANY($2::text[])
        GROUP BY 1,2 ORDER BY 4, 1`, [hoje, atual.equipes]);
    // ORDER BY por POSIÇÃO, não por alias: o Postgres aceita `ORDER BY trabalham`
    // mas não `ORDER BY trabalham::int` — com cast vira expressão e o alias de
    // saída deixa de ser visível. Custou uma rodada em produção (30/08/2026).

    console.log('');
    tabela(detalhe, [
      { rotulo: 'equipe',   get: r => r.sigla },
      { rotulo: 'tipo',     get: r => r.tipo },
      { rotulo: 'trab/tot', get: r => `${r.trabalham}/${r.total}` },
      { rotulo: 'códigos do dia', get: r => r.codigos },
      { rotulo: 'quem sustenta a equipe no esperado', get: r => (r.quem_trabalha || '—').slice(0, 60) },
    ]);
    console.log('');
    const soUm = detalhe.filter(r => Number(r.trabalham) === 1 && Number(r.total) > 1);
    if (soUm.length) {
      warn(`${soUm.length} de ${detalhe.length} equipes entram no esperado por UM ÚNICO colaborador,`);
      info('   com o restante da equipe em folga. O KPI chama isso de "equipe esperada em campo".');
    } else {
      ok('nenhuma equipe depende de um único colaborador — a regra "qualquer colaborador" não é a causa.');
    }
  }

  // ── 3. Quem são as pessoas que nunca folgam no cadastro ───────────────────
  // Se o mesmo colaborador aparece com turno em TODOS os domingos do mês, o
  // cadastro dele é administrativo (nunca recebeu DR), não operacional. É o
  // padrão que transforma "equipe escalada" em ruído no fim de semana.
  H('3. COLABORADORES SEM FOLGA NO CADASTRO (todos os fins de semana do mês)');
  const { rows: semFolga } = await pool.query(
    `WITH fds AS (
       SELECT ed.equipe, ed.colaborador_codigo, ed.colaborador_nome,
              count(*) AS dias_fds,
              count(*) FILTER (WHERE ec.inicio_escala IS NOT NULL
                                 AND ec.fim_escala    IS NOT NULL) AS fds_trabalhando
         FROM public.escala_dia ed
         LEFT JOIN public.escalas_catalogo ec
           ON ec.codigo = ed.codigo_escala AND ec.sector_id = ed.sector_id
        WHERE ed.data BETWEEN $1::date AND $2::date
          AND extract(dow from ed.data) IN (0, 6)
        GROUP BY 1,2,3)
     SELECT upper(btrim(eo.sigla)) AS sigla, coalesce(upper(eo.tipo),'—') AS tipo,
            fds.colaborador_nome, fds.dias_fds, fds.fds_trabalhando
       FROM fds
       JOIN public.equipes_oficiais eo
         ON upper(btrim(eo.sigla)) = upper(btrim(fds.equipe)) AND eo.ativo
      WHERE fds.dias_fds > 0 AND fds.fds_trabalhando = fds.dias_fds
        AND coalesce(upper(eo.tipo),'—') <> 'PLANTÃO'
      ORDER BY 2, 1, 3`, [ini, fim]);

  if (semFolga.length === 0) {
    ok('nenhum colaborador não-plantão trabalha todos os fins de semana no cadastro.');
  } else {
    bad(`${semFolga.length} colaborador(es) NÃO-PLANTÃO com turno em TODO sábado e domingo do mês.`);
    console.log('');
    tabela(semFolga.slice(0, 40), [
      { rotulo: 'equipe',      get: r => r.sigla },
      { rotulo: 'tipo',        get: r => r.tipo },
      { rotulo: 'colaborador', get: r => (r.colaborador_nome || '?').slice(0, 38) },
      { rotulo: 'fds trab/tot',get: r => `${r.fds_trabalhando}/${r.dias_fds}` },
    ]);
    if (semFolga.length > 40) info(`(+${semFolga.length - 40} não listados)`);
    console.log('');
    info('São estes cadastros que sustentam equipe não-plantão no esperado de fim de semana.');
  }

  // ── 4. O confronto que o KPI faz na tela: esperada × em campo ─────────────
  // Mesma regra do painel (public/index.html:7002): em campo = está em
  // teams_current com sessionEnd nulo e isOnline verdadeiro. É aqui que se vê
  // se as comerciais de domingo são equipe real que não logou, ou linha de
  // cadastro que nunca vai a campo — nos dois casos o KPI acusa "faltam N",
  // mas só um deles é desvio operacional.
  H('4. CONFRONTO — esperadas agora × em campo agora');
  const { rows: campo } = await pool.query(
    `SELECT upper(btrim(tc.team_name)) AS sigla, tc.regional,
            coalesce(upper(eo.tipo),'(fora da whitelist)') AS tipo,
            (tc.data->>'sessionEnd') AS session_end,
            (tc.data->>'isOnline')   AS is_online
       FROM public.teams_current tc
       LEFT JOIN public.equipes_oficiais eo
         ON upper(btrim(eo.sigla)) = upper(btrim(tc.team_name)) AND eo.ativo`);

  const emCampo = new Map();
  for (const r of campo) {
    if (r.session_end != null) continue;          // já deslogou
    if (String(r.is_online) !== 'true') continue; // offline
    emCampo.set(r.sigla, r);
  }
  const esperadas = new Set(atual.equipes);
  // Tipo vindo da whitelist, não de teams_current: equipe escalada e ausente do
  // campo não tem linha em teams_current e ficaria sem tipo — justamente a que
  // mais interessa nomear.
  const { rows: tiposWl } = await pool.query(
    `SELECT upper(btrim(sigla)) AS sigla, coalesce(upper(tipo),'—') AS tipo
       FROM public.equipes_oficiais WHERE ativo`);
  const tipoWl = new Map(tiposWl.map(r => [r.sigla, r.tipo]));
  const tipoCampo = new Map(campo.map(r => [r.sigla, r.tipo]));
  const tipoDe = s => tipoWl.get(s) || tipoCampo.get(s) || '—';

  const ambos    = [...esperadas].filter(s => emCampo.has(s)).sort();
  const soEsper  = [...esperadas].filter(s => !emCampo.has(s)).sort();
  const soCampo  = [...emCampo.keys()].filter(s => !esperadas.has(s)).sort();

  info(`esperadas agora ... ${esperadas.size}`);
  info(`em campo agora .... ${emCampo.size}  (whitelist + fora dela, regra !sessionEnd && isOnline)`);
  console.log('');
  ok(`escaladas E em campo: ${ambos.length}`);
  if (ambos.length) console.log('     ' + ambos.join(', '));

  console.log('');
  if (soEsper.length) {
    bad(`escaladas e NÃO em campo: ${soEsper.length}  ← é o "faltam N" que o KPI mostra`);
    const porTipo = {};
    for (const s of soEsper) (porTipo[tipoDe(s)] ||= []).push(s);
    for (const [t, lista] of Object.entries(porTipo)) {
      console.log(`     ${t} (${lista.length}): ${lista.join(', ')}`);
    }
  } else {
    ok('nenhuma equipe escalada está fora de campo.');
  }

  console.log('');
  if (soCampo.length) {
    warn(`em campo e NÃO escaladas: ${soCampo.length}  ← trabalhando fora da escala cadastrada`);
    const porTipo = {};
    for (const s of soCampo) (porTipo[tipoDe(s)] ||= []).push(s);
    for (const [t, lista] of Object.entries(porTipo)) {
      console.log(`     ${t} (${lista.length}): ${lista.join(', ')}`);
    }
    info('As "(fora da whitelist)" são esperadas aqui — o KPI só conta equipe faturada.');
  } else {
    ok('ninguém em campo fora da escala.');
  }

  console.log('');
  await pool.end();
})().catch(async (err) => {
  console.error('\n[diag-escala-semana] falhou:', err.message);
  console.error(err.stack);
  try { await pool.end(); } catch (_) { /* já fechado */ }
  process.exit(1);
});
