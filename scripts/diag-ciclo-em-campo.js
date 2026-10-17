#!/usr/bin/env node
/**
 * scripts/diag-ciclo-em-campo.js
 *
 * ⚠️ ESTRITAMENTE READ-ONLY. Só SELECT. Não escreve nada, em nenhuma tabela, e
 * não chama a API da EDP (a conta é compartilhada — P1-25).
 *
 * ── A PERGUNTA (16/10/2026) ─────────────────────────────────────────────────
 * A varredura do diag-escala-a-mais (--varrer 2 --passo 15, P2-65) mostrou o
 * "em campo" caindo ~35–45 equipes por UM ciclo de snapshot e voltando no
 * seguinte (15/10 11:06, 12:02, 13:45, 14:19; 16/10 09:04, 11:32 — ex.:
 * 104 → 70 → 103). No painel isso vira um "faltam N" falso no KPI do Monitor.
 *
 * Como o ciclo é gravado (lido no código):
 *   - runSnapshot (cronService, '*\/15 5-23') chama getTeams, que coleta os
 *     setores EM SÉRIE e grava TUDO num único INSERT — todas as linhas do ciclo
 *     têm o mesmo `captured_at` (DEFAULT now()). O `captured_at` é o FIM da
 *     coleta, por isso o ciclo das 11:00 aparece como 11:06.
 *   - setor cujo getTeamsBySector lança (breaker/rede/HTTP≠200) vai pra
 *     report.failed e NÃO entra no INSERT: as equipes dele somem do ciclo
 *     (P1-30/P1-39). O report por ciclo não é guardado em tabela — só no log
 *     (`snapshot_partial`) e no último `snapshot_last_ok`.
 *   - teamsstatus/V2 que volta 200 com lista VAZIA (ou sem a equipe) não lança:
 *     o setor conta como ok, a sessão segue aberta, mas `isOnline:false` e
 *     `v2Presente:false` (wpaService.getTeamsBySector, `v2?.IsOnline || false`).
 *   - IsOnline que a EDP derruba em lote: V2 presente, `isOnline:false`.
 *
 * Cada causa deixa uma assinatura diferente no snapshot, e este script lê qual:
 *
 *   setor-ausente     o setor inteiro não tem linha no ciclo → coleta falhou
 *   equipe-ausente    o setor gravou, mas a equipe não veio (sessions/date
 *                     incompleto)
 *   sem-v2            sessão aberta, V2 não trouxe a equipe
 *   offline-no-v2     sessão aberta, V2 trouxe a equipe com IsOnline=false
 *   encerrada         a sessão veio encerrada (e reabriu no ciclo seguinte)
 *
 * "Em campo" é a MESMA regra do front (renderMetrics + _mergeTeamSessions) e do
 * diag-escala-a-mais (unirSessoes): sessões unidas por sigla, existe aberta E a
 * base (última aberta) está isOnline.
 *
 * `v2Presente` só existe no snapshot desde 15/10/2026 ~08:20 (2fcbf6f). Antes
 * disso a presença do V2 é INFERIDA por `lastUpdate` (só o V2 preenche) e a
 * saída marca "(inferido)".
 *
 * Uso (na VM):
 *   cd ~/prod-stc && node scripts/diag-ciclo-em-campo.js                 (2 dias até agora)
 *   node scripts/diag-ciclo-em-campo.js --dias 3
 *   node scripts/diag-ciclo-em-campo.js --em "2026-10-15 11:06"          (zoom: ciclo e vizinhos, equipe a equipe)
 *   node scripts/diag-ciclo-em-campo.js --limiar 10                      (queda mínima pra acusar; padrão 15)
 */

'use strict';

require('dotenv').config({ override: true });

const SETORES = ['DESG', 'DEPT', 'DESC', 'DSSJ'];
const LIMIAR_PADRAO = 15;

// ─────────────────────────────────────────────────────────────────────────────
// FUNÇÕES PURAS (exportadas pra teste)
// ─────────────────────────────────────────────────────────────────────────────

const norm = (s) => String(s || '').toUpperCase().trim();

/**
 * O V2 trouxe a equipe? `v2Presente` quando existe; antes de 15/10/2026, infere
 * por `lastUpdate` (campo que só o V2 preenche).
 */
function v2DaLinha(r) {
  if (r.v2_presente === 'true')  return { v2: true,  inferido: false };
  if (r.v2_presente === 'false') return { v2: false, inferido: false };
  return { v2: !!r.last_update, inferido: true };
}

/**
 * Estado de cada equipe num ciclo. União por sigla com a regra do front:
 * base = última sessão aberta (ou a última encerrada); em campo = há aberta E a
 * base está isOnline. O setor da equipe é o da base.
 *
 * @returns {Map<sigla, {sigla, setor, estado, aberta, emCampo, v2, v2Inferido, lastUpdate}>}
 *   estado ∈ em-campo | sem-v2 | offline-no-v2 | encerrada
 */
function estadosDoCiclo(linhas) {
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
    const { v2, inferido } = v2DaLinha(base);
    const aberta = abertas.length > 0;
    const emCampo = aberta && String(base.is_online) === 'true';
    const estado = !aberta ? 'encerrada' : emCampo ? 'em-campo' : v2 ? 'offline-no-v2' : 'sem-v2';
    out.set(sigla, { sigla, setor: base.sector_id || '?', estado, aberta, emCampo,
      v2, v2Inferido: inferido, lastUpdate: base.last_update || null });
  }
  return out;
}

/** Contagem por setor de um ciclo (linhas = sessões gravadas). */
function resumoPorSetor(linhas, estados) {
  const r = {};
  const s = (k) => (r[k] ||= { linhas: 0, equipes: 0, abertas: 0, emCampo: 0, semV2: 0, offlineV2: 0, encerradas: 0 });
  for (const l of (linhas || [])) s(l.sector_id || '?').linhas++;
  for (const e of estados.values()) {
    const x = s(e.setor);
    x.equipes++;
    if (e.aberta) x.abertas++;
    if (e.estado === 'em-campo') x.emCampo++;
    else if (e.estado === 'sem-v2') x.semV2++;
    else if (e.estado === 'offline-no-v2') x.offlineV2++;
    else x.encerradas++;
  }
  return r;
}

/** Minutos entre a vaga do cron (:00/:15/:30/:45) e o `captured_at`. */
function atrasoDoCiclo(capturado) {
  const d = new Date(capturado);
  return Math.round(((d.getUTCMinutes() % 15) * 60 + d.getUTCSeconds()) / 60 * 10) / 10;
}

/**
 * Explica a queda pontual do ciclo `cur`: equipes em campo no ciclo anterior E
 * no seguinte que não estão em campo neste ("piscaram"). Cada uma ganha a causa
 * pela assinatura no snapshot.
 *
 * @param {{estados: Map, porSetor: object}} prev, cur, next
 * @returns {{piscaram: Array<{sigla, setor, causa}>, porCausa: object, porSetorCausa: object, veredito: string}}
 */
function explicarQueda(prev, cur, next) {
  const piscaram = [];
  for (const [sigla, p] of prev.estados) {
    if (!p.emCampo) continue;
    const n = next.estados.get(sigla);
    if (!n || !n.emCampo) continue;
    const c = cur.estados.get(sigla);
    if (c && c.emCampo) continue;
    let causa;
    if (!c) {
      const setorGravou = (cur.porSetor[p.setor] || {}).linhas > 0;
      causa = setorGravou ? 'equipe-ausente' : 'setor-ausente';
    } else {
      causa = c.estado;   // sem-v2 | offline-no-v2 | encerrada
    }
    piscaram.push({ sigla, setor: c ? c.setor : p.setor, causa });
  }
  const porCausa = {}, porSetorCausa = {};
  for (const x of piscaram) {
    porCausa[x.causa] = (porCausa[x.causa] || 0) + 1;
    const k = `${x.setor} ${x.causa}`;
    porSetorCausa[k] = (porSetorCausa[k] || 0) + 1;
  }
  const [dom, nDom] = Object.entries(porSetorCausa).sort((a, b) => b[1] - a[1])[0] || [];
  const veredito = !dom ? 'nenhuma equipe piscou (a queda não é de equipes que voltaram)'
    : `${nDom} de ${piscaram.length} = ${dom}` + ({
      'setor-ausente':  ' → a coleta do setor falhou no ciclo (getTeamsBySector lançou; ver `snapshot_partial` no pm2 logs)',
      'equipe-ausente': ' → o setor gravou sem essas equipes (sessions/date veio incompleto)',
      'sem-v2':         ' → o teamsstatus/V2 do setor não trouxe as equipes (lista vazia com HTTP 200 não lança)',
      'offline-no-v2':  ' → o V2 trouxe as equipes com IsOnline=false em lote (lado da EDP)',
      'encerrada':      ' → as sessões vieram encerradas e reabriram no ciclo seguinte',
    }[dom.split(' ')[1]] || '');
  return { piscaram, porCausa, porSetorCausa, veredito };
}

/**
 * Ciclos com queda pontual: em campo cai pelo menos `limiar` em relação ao
 * MENOR dos dois vizinhos (anterior e seguinte). Queda que não volta não é
 * pontual e não entra.
 */
function quedasPontuais(totais, limiar) {
  const idx = [];
  for (let i = 1; i < totais.length - 1; i++) {
    if (Math.min(totais[i - 1], totais[i + 1]) - totais[i] >= limiar) idx.push(i);
  }
  return idx;
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

const fmtBRT = (d) => new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(d)).replace(',', '');

/** Todas as linhas de snapshot do período, só com os campos que importam. */
async function lerPeriodo(pool, de, ate) {
  const { rows } = await pool.query(
    `SELECT s.captured_at, s.sector_id, s.team_name, s.session_begin, s.session_end,
            s.data->>'sigla'      AS sigla,
            s.data->>'isOnline'   AS is_online,
            s.data->>'v2Presente' AS v2_presente,
            s.data->>'lastUpdate' AS last_update
       FROM public.snapshots s
      WHERE s.captured_at >= $1 AND s.captured_at < $2
      ORDER BY s.captured_at`, [de.toISOString(), ate.toISOString()]);
  // Um ciclo = um INSERT = um captured_at.
  const ciclos = new Map();
  for (const r of rows) {
    const k = new Date(r.captured_at).getTime();
    if (!ciclos.has(k)) ciclos.set(k, []);
    ciclos.get(k).push(r);
  }
  return [...ciclos.entries()].sort((a, b) => a[0] - b[0]).map(([t, linhas]) => {
    const estados = estadosDoCiclo(linhas);
    return { t, linhas, estados, porSetor: resumoPorSetor(linhas, estados),
      emCampo: [...estados.values()].filter(e => e.emCampo).length,
      inferido: [...estados.values()].some(e => e.v2Inferido) };
  });
}

function imprimirCiclos(ciclos, marcados) {
  const setores = [...new Set([...SETORES, ...ciclos.flatMap(c => Object.keys(c.porSetor))])];
  tabela(ciclos.map((c, i) => ({ c, i })), [
    { rotulo: 'ciclo (BRT)', get: x => fmtBRT(x.c.t) },
    { rotulo: 'atraso', get: x => `${atrasoDoCiclo(x.c.t)}m` },
    { rotulo: 'em campo', get: x => x.c.emCampo },
    // por setor: equipes / em campo / sem V2 / offline no V2
    ...setores.map(s => ({ rotulo: `${s} eq/cmp/sV2/off`, get: x => {
      const p = x.c.porSetor[s];
      return p ? `${p.equipes}/${p.emCampo}/${p.semV2}/${p.offlineV2}` : '— ausente —';
    } })),
    { rotulo: '', get: x => (marcados.has(x.i) ? '◀ QUEDA' : '') + (x.c.inferido ? ' (v2 inferido)' : '') },
  ]);
}

async function modoPeriodo(pool, dias, limiar) {
  const ate = new Date();
  const de = new Date(ate.getTime() - dias * 86400000);
  const ciclos = await lerPeriodo(pool, de, ate);

  H(`CICLOS DE SNAPSHOT — ${fmtBRT(de)} → ${fmtBRT(ate)} BRT (${ciclos.length} ciclos)`);
  if (!ciclos.length) { warn('nenhum snapshot no período.'); return; }
  info('atraso = minutos entre a vaga do cron e o fim da coleta (captured_at).');
  info('colunas por setor: equipes / em campo / sessão aberta sem V2 / aberta com IsOnline=false.');
  const quedas = quedasPontuais(ciclos.map(c => c.emCampo), limiar);
  imprimirCiclos(ciclos, new Set(quedas));

  // Mais de um INSERT por vaga = execução sobreposta (P2-23).
  const porVaga = {};
  for (const c of ciclos) { const v = Math.floor(c.t / 900000); porVaga[v] = (porVaga[v] || 0) + 1; }
  const dup = Object.entries(porVaga).filter(([, n]) => n > 1);
  if (dup.length) warn(`${dup.length} vaga(s) de 15 min com mais de um INSERT (execução sobreposta, P2-23).`);

  H(`QUEDAS PONTUAIS (≥ ${limiar} abaixo do menor vizinho, voltando no ciclo seguinte)`);
  if (!quedas.length) { ok('nenhuma.'); return; }
  const totCausa = {};
  const linhasQ = [];
  for (const i of quedas) {
    const e = explicarQueda(ciclos[i - 1], ciclos[i], ciclos[i + 1]);
    for (const [k, v] of Object.entries(e.porCausa)) totCausa[k] = (totCausa[k] || 0) + v;
    linhasQ.push({ c: ciclos[i], ant: ciclos[i - 1].emCampo, seg: ciclos[i + 1].emCampo, e });
  }
  tabela(linhasQ, [
    { rotulo: 'ciclo', get: x => fmtBRT(x.c.t) },
    { rotulo: 'atraso', get: x => `${atrasoDoCiclo(x.c.t)}m` },
    { rotulo: 'ant→ciclo→seg', get: x => `${x.ant}→${x.c.emCampo}→${x.seg}` },
    { rotulo: 'piscaram', get: x => x.e.piscaram.length },
    { rotulo: 'por setor × causa', get: x => Object.entries(x.e.porSetorCausa)
      .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ') },
  ]);
  console.log('');
  for (const q of linhasQ) info(`${fmtBRT(q.c.t)}: ${q.e.veredito}`);
  console.log('\n  Causa somada em todas as quedas:');
  tabela(Object.entries(totCausa).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ k, v })),
    [{ rotulo: 'causa', get: x => x.k }, { rotulo: 'equipe×ciclo', get: x => x.v }]);
  const atrQ = linhasQ.map(q => atrasoDoCiclo(q.c.t));
  const atrN = ciclos.filter((_, i) => !quedas.includes(i)).map(c => atrasoDoCiclo(c.t)).sort((a, b) => a - b);
  console.log('');
  info(`atraso dos ciclos com queda: ${atrQ.join(', ')} min · mediana dos demais: ${atrN[Math.floor(atrN.length / 2)]} min`);
  info('(coleta lenta + setor ausente = timeout/breaker naquele setor; procure `snapshot_partial` no log do horário)');
  info('Zoom: node scripts/diag-ciclo-em-campo.js --em "<AAAA-MM-DD HH:MM>" com a hora de um ciclo acima.');
  console.log('');
}

async function modoZoom(pool, ref) {
  // ciclo mais próximo do instante e um vizinho de cada lado
  const ciclos = await lerPeriodo(pool, new Date(ref.getTime() - 50 * 60000), new Date(ref.getTime() + 50 * 60000));
  if (ciclos.length < 3) { warn('preciso de 3 ciclos em torno do instante (±50 min).'); return; }
  let i = 0;
  for (let k = 0; k < ciclos.length; k++) if (Math.abs(ciclos[k].t - ref) < Math.abs(ciclos[i].t - ref)) i = k;
  i = Math.min(Math.max(i, 1), ciclos.length - 2);
  const [prev, cur, next] = [ciclos[i - 1], ciclos[i], ciclos[i + 1]];

  H(`ZOOM — ciclo ${fmtBRT(cur.t)} BRT (vizinhos ${fmtBRT(prev.t)} e ${fmtBRT(next.t)})`);
  imprimirCiclos(ciclos, new Set([i]));

  const e = explicarQueda(prev, cur, next);
  H('EQUIPES EM CAMPO ANTES E DEPOIS, FORA DE CAMPO NESTE CICLO');
  tabela(e.piscaram.sort((a, b) => a.setor.localeCompare(b.setor) || a.sigla.localeCompare(b.sigla)).map(x => ({
    ...x, c: cur.estados.get(x.sigla), p: prev.estados.get(x.sigla),
  })), [
    { rotulo: 'equipe', get: x => x.sigla }, { rotulo: 'setor', get: x => x.setor },
    { rotulo: 'causa', get: x => x.causa },
    { rotulo: 'lastUpdate V2 (antes)', get: x => x.p && x.p.lastUpdate ? String(x.p.lastUpdate).slice(0, 19) : '—' },
    { rotulo: 'lastUpdate V2 (neste)', get: x => x.c && x.c.lastUpdate ? String(x.c.lastUpdate).slice(0, 19) : '—' },
  ]);
  console.log('');
  info(e.veredito);
  if (cur.inferido) info('(neste período o snapshot não tinha `v2Presente`: presença do V2 inferida por lastUpdate)');
  console.log('');
}

async function main() {
  let pool;
  try {
    pool = require('../services/pgShim')._getPool();
  } catch (err) {
    console.error('\n[diag-ciclo-em-campo] Não consegui abrir o pool Postgres:', err.message);
    console.error('[diag-ciclo-em-campo] Exige DATABASE_URL no .env (Postgres local).\n');
    process.exit(1);
  }
  try {
    const em = arg('em');
    if (em) {
      const m = em.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/);
      if (!m) { console.error('✖ --em "YYYY-MM-DD HH:MM" (BRT)'); process.exit(1); }
      await modoZoom(pool, new Date(`${m[1]}T${m[2]}:00-03:00`));
    } else {
      const dias = Math.min(14, Math.max(1, Number(arg('dias')) || 2));
      const limiar = Math.max(1, Number(arg('limiar')) || LIMIAR_PADRAO);
      await modoPeriodo(pool, dias, limiar);
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\n[diag-ciclo-em-campo] falhou:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
}

module.exports = { v2DaLinha, estadosDoCiclo, resumoPorSetor, atrasoDoCiclo, explicarQueda, quedasPontuais };
