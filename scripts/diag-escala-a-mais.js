#!/usr/bin/env node
/**
 * scripts/diag-escala-a-mais.js
 *
 * ⚠️ ESTRITAMENTE READ-ONLY. Só SELECT. Não escreve nada, em nenhuma tabela, e
 * não chama a API da EDP (a conta é compartilhada — P1-25).
 *
 * ── A PERGUNTA (16/10/2026) ─────────────────────────────────────────────────
 * O José notou que o KPI do Monitor às vezes mostra MAIS equipes em campo do que
 * a escala prevê ("N a mais que o previsto"). Os dois lados do KPI vêm de fontes
 * diferentes e só se encontram na tela:
 *
 *   EM CAMPO   = front, renderMetrics: sessões do /teams unidas por sigla,
 *                `!sessionEnd && isOnline` (isOnline = V2.IsOnline).
 *   ESPERADAS  = GET /api/escala/agora → db/escalaQueries.equipesEsperadasAgora:
 *                escala_dia × escalas_catalogo (JOIN exato do código) ×
 *                equipes_oficiais, janela [início, fim) estrita.
 *
 * "N a mais" é um SALDO: (em campo e não esperadas) − (esperadas e não em campo).
 * Este script abre o saldo nos dois termos e, para cada equipe em campo que a
 * escala NÃO previa, diz o porquê:
 *
 *   antes-do-turno     logou antes do início do turno (antecipação)
 *   defasagem-do-ciclo o "depois do fim" cabe na diferença entre a foto da
 *                      equipe e a referência do ciclo — não é prorrogação
 *   depois-do-turno    o turno já acabou e ela segue logada (prorrogação / HE /
 *                      sessão esquecida aberta)
 *   folga-no-cadastro  todos os códigos do dia são folga/DR/FER... (plantão, HE em
 *                      dia de folga, ou troca de escala não lançada)
 *   sem-escala-hoje    nenhuma linha em escala_dia hoje (P2-47)
 *   codigo-com-grafia-diferente  o código existe no catálogo só por prefixo
 *   codigo-fora-do-catalogo      o código não existe no catálogo
 *   codigo-sem-horario           está no catálogo mas sem início/fim
 *   janela-ambigua               início == fim (escalaQueries recusa adivinhar)
 *   fora-whitelist               não está ativa em equipes_oficiais
 *
 * e marca atributos que ajudam a decidir (não excluem do motivo):
 *   sessao-de-dia-anterior, regional-diverge (sessão × whitelist),
 *   v2-turno-diferente (ShiftType ao vivo ≠ código da escala_dia),
 *   v2-turno-cobre-agora (pelo ShiftType ao vivo, ela ESTÁ no turno),
 *   codigo-orfao-junto (outro colaborador da equipe com código sem horário).
 *
 * A fonte de "em campo" é a tabela `snapshots` (o último ciclo antes do instante),
 * e não `teams_current`: esta deduplica por team_name e guarda a ÚLTIMA sessão do
 * lote, que pode ser a encerrada de um relogin — o front une as sessões e vê a
 * aberta. Aqui a união é a mesma do front (_mergeTeamSessions).
 *
 * Uso (na VM):
 *   cd ~/prod-stc && node scripts/diag-escala-a-mais.js
 *   node scripts/diag-escala-a-mais.js --em "2026-10-16 07:10"   (instante passado, BRT)
 *   node scripts/diag-escala-a-mais.js --varrer 3                (de hora em hora, 3 dias)
 *   node scripts/diag-escala-a-mais.js --varrer 2 --passo 15     (todo ciclo de snapshot)
 */

'use strict';

require('dotenv').config({ override: true });

const { dateBRT } = require('../services/timeUtil');
const {
  equipesEsperadasAgora, minutosDoDia, diaAnterior,
  classificarExcedente, janelaContem, LIMIAR_POS_TURNO_ONTEM_MIN,
} = require('../db/escalaQueries');


// ─────────────────────────────────────────────────────────────────────────────
// FUNÇÕES PURAS (exportadas pra teste)
// ─────────────────────────────────────────────────────────────────────────────

/** Normaliza sigla como os dois lados do KPI: upper + trim. */
const norm = (s) => String(s || '').toUpperCase().trim();

/** Primeiro token do código ("T07 07:00" → "T07"). */
const token = (c) => norm(c).split(/\s+/)[0] || '';

/**
 * Une as sessões de um ciclo de snapshot por sigla, com a MESMA regra do front
 * (public/index.html, _mergeTeamSessions + renderMetrics):
 *   base = última sessão aberta (ou a última encerrada); em campo = existe
 *   sessão aberta E a base está isOnline.
 */
function unirSessoes(linhas, hoje) {
  const grupos = new Map();
  for (const r of (linhas || [])) {
    const k = norm(r.sigla || r.team_name);
    if (!k) continue;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(r);
  }
  const out = new Map();
  for (const [sigla, ss] of grupos) {
    const sorted = [...ss].sort((a, b) =>
      String(a.session_begin || '').localeCompare(String(b.session_begin || '')));
    const abertas = sorted.filter(s => !s.session_end);
    const base = abertas.length ? abertas[abertas.length - 1] : sorted[sorted.length - 1];
    const begins = sorted.map(s => s.session_begin).filter(Boolean).sort();
    const sbr = sorted.map(s => s.session_begin_real).filter(Boolean).sort()[0] || null;
    // _refLogon do front: 1º login do dia se foi hoje; senão o re-checkin do V2.
    const refLogon = (sbr && String(sbr).slice(0, 10) >= hoje)
      ? sbr : (base.presentation_time || sbr || begins[0] || null);
    out.set(sigla, {
      sigla,
      regional: base.regional || null,
      aberta: abertas.length > 0,
      emCampo: abertas.length > 0 && String(base.is_online) === 'true',
      sessoesAbertas: abertas.length,
      sessoes: sorted.length,
      refLogon,
      shiftType: base.shift_type || null,
      turnoV2: { inicio: base.escala_inicio_wpa || null, fim: base.escala_fim_wpa || null },
      vistaEm: base.captured_at ? new Date(base.captured_at) : null,
    });
  }
  return out;
}

/** Faixa de minutos pro histograma de antecipação/prorrogação. */
function faixa(m) {
  if (m == null) return '—';
  if (m <= 15) return '≤15';
  if (m <= 30) return '16-30';
  if (m <= 60) return '31-60';
  if (m <= 120) return '61-120';
  return '>120';
}

// ─────────────────────────────────────────────────────────────────────────────
// LEITURA (SELECT)
// ─────────────────────────────────────────────────────────────────────────────

const H    = (s) => console.log(`\n${'═'.repeat(78)}\n  ${s}\n${'═'.repeat(78)}`);
const ok   = (s) => console.log(`  ✅ ${s}`);
const warn = (s) => console.log(`  ⚠️  ${s}`);
const info = (s) => console.log(`  ·  ${s}`);

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

function arg(nome) {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 ? (process.argv[i + 1] || '') : null;
}

const hhmmBRT = (d) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(d);

/** Último ciclo de snapshot até `ref` (janela de 25 min — o ciclo é de 15). */
async function lerCiclo(pool, ref) {
  const { rows } = await pool.query(
    `WITH ult AS (
       SELECT max(captured_at) AS t FROM public.snapshots
        WHERE captured_at <= $1 AND captured_at > $1::timestamptz - interval '25 minutes')
     SELECT s.team_name, s.regional, s.session_begin, s.session_end, s.captured_at,
            s.data->>'sigla'            AS sigla,
            s.data->>'isOnline'         AS is_online,
            s.data->>'shiftType'        AS shift_type,
            s.data->>'escalaInicioWPA'  AS escala_inicio_wpa,
            s.data->>'escalaFimWPA'     AS escala_fim_wpa,
            s.data->>'presentationTime' AS presentation_time,
            s.data->>'sessionBeginReal' AS session_begin_real
       FROM public.snapshots s, ult
      WHERE ult.t IS NOT NULL
        AND s.captured_at >  ult.t - interval '10 minutes'
        AND s.captured_at <= ult.t`, [ref.toISOString()]);
  // Cada equipe vale pelo SEU último lote dentro da janela (os setores não
  // gravam no mesmo segundo).
  const maxPorEquipe = new Map();
  for (const r of rows) {
    const k = norm(r.sigla || r.team_name);
    const t = new Date(r.captured_at).getTime();
    if (!maxPorEquipe.has(k) || maxPorEquipe.get(k) < t) maxPorEquipe.set(k, t);
  }
  const ciclo = rows.filter(r => new Date(r.captured_at).getTime() === maxPorEquipe.get(norm(r.sigla || r.team_name)));
  const capturado = rows.length ? new Date(Math.max(...rows.map(r => new Date(r.captured_at).getTime()))) : null;
  return { linhas: ciclo, capturado };
}

async function lerEscala(pool, ontem, hoje) {
  const { rows } = await pool.query(
    `SELECT to_char(ed.data,'YYYY-MM-DD') AS data, upper(btrim(ed.equipe)) AS sigla,
            ed.sector_id, ed.codigo_escala, ed.updated_at,
            (ec.codigo IS NOT NULL) AS no_catalogo, ec.inicio_escala, ec.fim_escala,
            (SELECT min(ec2.codigo) FROM public.escalas_catalogo ec2
              WHERE ec.codigo IS NULL AND ec2.sector_id = ed.sector_id
                AND regexp_replace(upper(btrim(ec2.codigo)), '[[:space:]].*$', '')
                  = regexp_replace(upper(btrim(ed.codigo_escala)), '[[:space:]].*$', '')
            ) AS prefixo_catalogo
       FROM public.escala_dia ed
       LEFT JOIN public.escalas_catalogo ec
         ON ec.codigo = ed.codigo_escala AND ec.sector_id = ed.sector_id
      WHERE ed.data IN ($1::date, $2::date)`, [ontem, hoje]);
  const porEquipe = new Map();
  for (const r of rows) {
    if (!porEquipe.has(r.sigla)) porEquipe.set(r.sigla, []);
    porEquipe.get(r.sigla).push(r);
  }
  return { rows, porEquipe };
}

async function lerWhitelist(pool) {
  const { rows } = await pool.query(
    `SELECT upper(btrim(sigla)) AS sigla, regional, tipo
       FROM public.equipes_oficiais WHERE ativo`);
  return new Map(rows.map(r => [r.sigla, r]));
}

/** Analisa um instante. Devolve o resultado estruturado (pra varredura). */
async function analisar(pool, refPedido, whitelist) {
  const { linhas, capturado } = await lerCiclo(pool, refPedido);
  // ⚠️ 16/10/2026 — a 1ª varredura comparava o snapshot (capturado até ~15 min
  // ANTES) com a escala da hora cheia: às 17:00, uma equipe de turno até 17:00
  // vista em campo às 16:48 saía "depois-do-turno 0 min". 281 dos 401 casos
  // caíram em ≤15 min — boa parte disso era a defasagem, não prorrogação. O
  // front não tem esse atraso (o /teams é ao vivo), então a escala tem de ser
  // avaliada no MESMO instante em que a equipe foi vista.
  const ref = capturado || refPedido;
  const hoje = dateBRT(ref);
  const ontem = diaAnterior(hoje);
  const agoraMin = minutosDoDia(hhmmBRT(ref));

  const [escala, esp] = await Promise.all([
    lerEscala(pool, ontem, hoje), equipesEsperadasAgora(null, ref),
  ]);
  const sessoes = unirSessoes(linhas, hoje);
  const esperadas = new Set(esp.equipes.map(norm));
  const emCampo = [...sessoes.values()].filter(s => s.emCampo);

  const aMais = [];
  for (const s of emCampo) {
    if (esperadas.has(s.sigla)) continue;
    const wl = whitelist.get(s.sigla);
    const cls = classificarExcedente({
      sigla: s.sigla, naWhitelist: !!wl, regionalWl: wl && wl.regional,
      regionalSessao: s.regional, refLogon: s.refLogon,
      shiftType: s.shiftType, turnoV2: s.turnoV2,
      linhas: escala.porEquipe.get(s.sigla) || [], agoraMin, hoje,
    });
    aMais.push({ ...s, tipo: wl ? wl.tipo : '—', regionalWl: wl ? wl.regional : null,
      codigos: [...new Set((escala.porEquipe.get(s.sigla) || [])
        .filter(l => l.data === hoje).map(l => l.codigo_escala))].join(', ') || '—',
      ...cls });
    // Os setores gravam em série: dentro do ciclo, a equipe pode ter sido vista
    // minutos ANTES do instante de referência. Se o "depois do fim" cabe nessa
    // diferença, não dá pra afirmar prorrogação — o turno pode ter acabado
    // entre a foto e a referência.
    const ult = aMais[aMais.length - 1];
    const defasagem = (s.vistaEm && ref) ? Math.max(0, Math.round((ref - s.vistaEm) / 60000)) : 0;
    if (ult.motivo === 'depois-do-turno' && ult.minutos <= defasagem) {
      ult.motivo = 'defasagem-do-ciclo';
      ult.detalhe += ` · vista ${defasagem} min antes da referência`;
    }
  }
  const emCampoSet = new Set(emCampo.map(s => s.sigla));
  const faltando = esp.detalhe.filter(e => !emCampoSet.has(norm(e.sigla)));

  return { ref, hoje, ontem, agoraMin, capturado, sessoes, emCampo, esp, aMais, faltando, escala };
}

function resumoMotivos(aMais) {
  const m = {};
  for (const a of aMais) m[a.motivo] = (m[a.motivo] || 0) + 1;
  return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ') || '—';
}

// ─────────────────────────────────────────────────────────────────────────────
// SAÍDA
// ─────────────────────────────────────────────────────────────────────────────

async function modoInstante(pool, ref) {
  const whitelist = await lerWhitelist(pool);
  const r = await analisar(pool, ref, whitelist);

  H(`0. REFERÊNCIA — ${r.hoje} ${hhmmBRT(ref)} BRT`);
  if (!r.capturado) {
    warn('nenhum snapshot nos 25 min antes do instante — o cron de snapshot estava parado.');
    return;
  }
  info(`ciclo de snapshot usado .. ${r.capturado.toISOString()} (${hhmmBRT(r.capturado)} BRT)`);
  info('(a escala é avaliada nesse instante, não no pedido — o front compara ao vivo)');
  info(`equipes no ciclo ......... ${r.sessoes.size} (sessões: ${[...r.sessoes.values()].reduce((s, x) => s + x.sessoes, 0)})`);

  // ── 1. Frescor da escala ───────────────────────────────────────────────────
  H('1. A ESCALA DE HOJE ESTÁ ATUALIZADA?');
  const linhasHoje = r.escala.rows.filter(l => l.data === r.hoje);
  if (!linhasHoje.length) {
    warn('escala_dia NÃO tem linha nenhuma de hoje — esperadas só pode vir de turno de ontem.');
  } else {
    const porSetor = {};
    for (const l of linhasHoje) {
      const t = new Date(l.updated_at).getTime();
      const s = (porSetor[l.sector_id] ||= { max: 0, linhas: [] });
      s.max = Math.max(s.max, t); s.linhas.push(t);
    }
    tabela(Object.entries(porSetor).map(([setor, s]) => ({
      setor, linhas: s.linhas.length,
      sync: new Date(s.max).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
      idade: `${((ref.getTime() - s.max) / 3600000).toFixed(1)}h`,
      // Upsert sem DELETE (cronService.runSyncEscalaDia): linha que o último
      // sync NÃO trouxe fica com updated_at antigo — a EDP tirou, nós não.
      velhas: s.linhas.filter(t => t < s.max - 30 * 60000).length,
    })), [
      { rotulo: 'setor', get: x => x.setor }, { rotulo: 'linhas hoje', get: x => x.linhas },
      { rotulo: 'último sync', get: x => x.sync }, { rotulo: 'idade', get: x => x.idade },
      { rotulo: 'linhas que o último sync não trouxe', get: x => x.velhas },
    ]);
    info('O sync roda 1x/dia (05:20). Troca de escala, plantão ou HE lançados DEPOIS disso');
    info('só entram amanhã — a equipe aparece em campo sem estar esperada.');
  }

  // ── 2. O saldo, aberto ─────────────────────────────────────────────────────
  H('2. O SALDO DO KPI, ABERTO NOS DOIS TERMOS');
  const esperadasEmCampo = r.esp.esperadas - r.faltando.length;
  info(`EM CAMPO (front: sessão aberta + isOnline) ........ ${r.emCampo.length}`);
  info(`ESPERADAS (GET /api/escala/agora) ................. ${r.esp.esperadas}`);
  info(`  esperadas E em campo ............................ ${esperadasEmCampo}`);
  info(`  em campo e NÃO esperadas  (a) ................... ${r.aMais.length}`);
  info(`  esperadas e NÃO em campo  (b) ................... ${r.faltando.length}`);
  const saldo = r.emCampo.length - r.esp.esperadas;
  info(`saldo = (a) − (b) = ${r.aMais.length} − ${r.faltando.length} = ${saldo}  ` +
       `(${saldo > 0 ? `"${saldo} a mais que o previsto"` : saldo < 0 ? `"faltam ${-saldo}"` : '"escala completa"'})`);
  // Aritmética por construção: se não fechar, o script está errado, não o dado.
  if (esperadasEmCampo + r.aMais.length !== r.emCampo.length) warn('a conta NÃO fechou — bug neste script.');
  const logadasOffline = [...r.sessoes.values()].filter(s => s.aberta && !s.emCampo).length;
  if (logadasOffline) info(`(fora do "em campo": ${logadasOffline} equipe(s) com sessão aberta mas isOnline=false)`);
  const multi = [...r.sessoes.values()].filter(s => s.sessoesAbertas > 1);
  info(`equipes com 2+ sessões ABERTAS no ciclo: ${multi.length}` +
       (multi.length ? ` (${multi.map(s => s.sigla).join(', ')}) — o front une por sigla, não conta 2x` : ''));

  // ── 3. Por regional ────────────────────────────────────────────────────────
  // O front filtra "em campo" pela regional da SESSÃO (REGIONAL_MAP[setor]) e
  // "esperadas" pela regional da WHITELIST. Se divergirem, a tela filtrada
  // desloca a equipe de um lado só.
  H('3. POR REGIONAL (o que a tela filtrada mostra)');
  const regs = [...new Set([...r.emCampo.map(s => s.regional), ...r.esp.detalhe.map(e => e.regional)])].filter(Boolean).sort();
  tabela(regs.map(g => ({
    g,
    campo: r.emCampo.filter(s => s.regional === g).length,
    esp: r.esp.detalhe.filter(e => e.regional === g).length,
    a: r.aMais.filter(s => s.regional === g).length,
    b: r.faltando.filter(e => e.regional === g).length,
  })), [
    { rotulo: 'regional', get: x => x.g }, { rotulo: 'em campo', get: x => x.campo },
    { rotulo: 'esperadas', get: x => x.esp }, { rotulo: '(a) a mais', get: x => x.a },
    { rotulo: '(b) faltando', get: x => x.b },
  ]);

  // ── 4. Equipe a equipe ─────────────────────────────────────────────────────
  H('4. (a) EM CAMPO SEM ESTAR ESPERADA — equipe a equipe');
  if (!r.aMais.length) ok('nenhuma. Todo mundo em campo está na escala de agora.');
  tabela([...r.aMais].sort((x, y) => x.motivo.localeCompare(y.motivo) || x.sigla.localeCompare(y.sigla)), [
    { rotulo: 'equipe',   get: x => x.sigla },
    { rotulo: 'reg',      get: x => x.regional || '—' },
    { rotulo: 'tipo',     get: x => x.tipo || '—' },
    { rotulo: 'motivo',   get: x => x.motivo },
    { rotulo: 'detalhe',  get: x => x.detalhe },
    { rotulo: 'escala hoje', get: x => x.codigos },
    { rotulo: 'ShiftType V2', get: x => x.shiftType || '—' },
    { rotulo: 'logon',    get: x => x.refLogon ? String(x.refLogon).slice(0, 16).replace('T', ' ') : '—' },
    { rotulo: 'atributos', get: x => x.flags.join(' ') || '—' },
  ]);
  if (r.aMais.length) { console.log(''); info(`resumo: ${resumoMotivos(r.aMais)}`); }

  H('5. (b) ESPERADAS QUE NÃO ESTÃO EM CAMPO (o outro termo do saldo)');
  tabela(r.faltando.map(e => ({ ...e, s: r.sessoes.get(norm(e.sigla)) })), [
    { rotulo: 'equipe', get: x => x.sigla }, { rotulo: 'reg', get: x => x.regional || '—' },
    { rotulo: 'turno', get: x => `${x.codigo || '—'} desde ${x.inicio}` },
    { rotulo: 'há', get: x => `${x.minutosDesdeInicio} min` },
    { rotulo: 'sessão', get: x => !x.s ? 'não logou' : x.s.aberta ? 'aberta, isOnline=false' : 'encerrada' },
  ]);
  console.log('');
}

async function modoVarredura(pool, dias, passoMin) {
  const whitelist = await lerWhitelist(pool);
  const fim = new Date();
  fim.setUTCMinutes(0, 0, 0);
  const inicio = new Date(fim.getTime() - dias * 86400000);

  H(`VARREDURA — a cada ${passoMin} min, ${dias} dia(s), até ${dateBRT(fim)} ${hhmmBRT(fim)} BRT`);
  info('instante = hora do SNAPSHOT usado (é nela que a escala é avaliada).');
  const porHora = {};
  let ultimoCiclo = null;
  const tot = { instantes: 0, comAMais: 0, saldoPositivo: 0, aMais: 0 };
  const porMotivo = {}, porFlag = {}, porFaixa = {}, porEquipe = {};
  const linhasInst = [];

  const passo = passoMin * 60000;
  for (let t = inicio.getTime() + passo; t <= fim.getTime(); t += passo) {
    const r = await analisar(pool, new Date(t), whitelist);
    if (!r.capturado) continue;
    // Com passo curto, dois pedidos podem cair no mesmo ciclo — conta 1 vez.
    if (ultimoCiclo && r.capturado.getTime() === ultimoCiclo) continue;
    ultimoCiclo = r.capturado.getTime();
    const ref = r.ref;
    tot.instantes++;
    const saldo = r.emCampo.length - r.esp.esperadas;
    if (r.aMais.length) tot.comAMais++;
    if (saldo > 0) tot.saldoPositivo++;
    const hh = hhmmBRT(ref).slice(0, 2);
    const ph = (porHora[hh] ||= { n: 0, pos: 0, max: 0 });
    ph.n++; if (saldo > 0) ph.pos++; ph.max = Math.max(ph.max, saldo);
    tot.aMais += r.aMais.length;
    for (const a of r.aMais) {
      porMotivo[a.motivo] = (porMotivo[a.motivo] || 0) + 1;
      for (const f of a.flags) porFlag[f] = (porFlag[f] || 0) + 1;
      if (a.motivo === 'antes-do-turno' || a.motivo === 'depois-do-turno') {
        const k = `${a.motivo} ${faixa(a.minutos)}`;
        porFaixa[k] = (porFaixa[k] || 0) + 1;
      }
      const e = (porEquipe[a.sigla] ||= { n: 0, motivos: {} });
      e.n++; e.motivos[a.motivo] = (e.motivos[a.motivo] || 0) + 1;
    }
    // ⚠️ 16/10/2026 — o rótulo misturava o dia do snapshot (23:4x de ontem) com a
    // hora do pedido (00:00) e saía "13/10 00:00" pro ciclo da virada do dia 14.
    linhasInst.push({ quando: `${r.hoje.slice(8, 10)}/${r.hoje.slice(5, 7)} ${hhmmBRT(ref)}`,
      campo: r.emCampo.length, esp: r.esp.esperadas, a: r.aMais.length, b: r.faltando.length,
      saldo, motivos: resumoMotivos(r.aMais) });
  }

  tabela(linhasInst, [
    { rotulo: 'instante', get: x => x.quando }, { rotulo: 'campo', get: x => x.campo },
    { rotulo: 'esp', get: x => x.esp }, { rotulo: '(a)', get: x => x.a },
    { rotulo: '(b)', get: x => x.b }, { rotulo: 'saldo', get: x => (x.saldo > 0 ? '+' : '') + x.saldo },
    { rotulo: 'motivos de (a)', get: x => x.motivos },
  ]);

  H('RESUMO DA VARREDURA');
  console.log('\n  Saldo positivo por hora do dia (BRT):');
  tabela(Object.entries(porHora).filter(([, v]) => v.pos > 0).sort().map(([h, v]) => ({ h, ...v })), [
    { rotulo: 'hora', get: x => `${x.h}h` }, { rotulo: 'ciclos', get: x => x.n },
    { rotulo: 'com saldo +', get: x => x.pos }, { rotulo: 'maior saldo', get: x => `+${x.max}` },
  ]);
  console.log('');
  info(`instantes com snapshot ......... ${tot.instantes}`);
  info(`com alguma equipe (a) .......... ${tot.comAMais}`);
  info(`com saldo positivo ("a mais") .. ${tot.saldoPositivo}`);
  info(`casos (equipe × instante) ...... ${tot.aMais}`);
  console.log('\n  Por motivo:');
  tabela(Object.entries(porMotivo).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ k, v,
    pct: tot.aMais ? `${(100 * v / tot.aMais).toFixed(0)}%` : '—' })),
    [{ rotulo: 'motivo', get: x => x.k }, { rotulo: 'casos', get: x => x.v }, { rotulo: '%', get: x => x.pct }]);
  console.log('\n  Antecipação / prorrogação, por faixa de minutos:');
  tabela(Object.entries(porFaixa).sort().map(([k, v]) => ({ k, v })),
    [{ rotulo: 'faixa', get: x => x.k }, { rotulo: 'casos', get: x => x.v }]);
  console.log('\n  Atributos:');
  tabela(Object.entries(porFlag).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ k, v })),
    [{ rotulo: 'atributo', get: x => x.k }, { rotulo: 'casos', get: x => x.v }]);
  console.log('\n  Equipes que mais aparecem em (a):');
  tabela(Object.entries(porEquipe).sort((a, b) => b[1].n - a[1].n).slice(0, 25).map(([k, v]) => ({ k, n: v.n,
    m: Object.entries(v.motivos).map(([mm, c]) => `${mm}=${c}`).join(' ') })),
    [{ rotulo: 'equipe', get: x => x.k }, { rotulo: 'instantes', get: x => x.n }, { rotulo: 'motivos', get: x => x.m }]);
  console.log('');
}

async function main() {
  let pool;
  try {
    pool = require('../services/pgShim')._getPool();
  } catch (err) {
    console.error('\n[diag-escala-a-mais] Não consegui abrir o pool Postgres:', err.message);
    console.error('[diag-escala-a-mais] Exige DATABASE_URL no .env (Postgres local).\n');
    process.exit(1);
  }
  try {
    const varrer = arg('varrer');
    const em = arg('em');
    if (varrer != null) {
      const dias = Math.min(14, Math.max(1, Number(varrer) || 3));
      const passoMin = Math.min(60, Math.max(5, Number(arg('passo')) || 60));
      await modoVarredura(pool, dias, passoMin);
    } else {
      let ref = new Date();
      if (em) {
        const m = em.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/);
        if (!m) { console.error('✖ --em "YYYY-MM-DD HH:MM" (BRT)'); process.exit(1); }
        ref = new Date(`${m[1]}T${m[2]}:00-03:00`);
      }
      await modoInstante(pool, ref);
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\n[diag-escala-a-mais] falhou:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
}

module.exports = { unirSessoes, classificarExcedente, janelaContem, faixa, LIMIAR_POS_TURNO_ONTEM_MIN };
