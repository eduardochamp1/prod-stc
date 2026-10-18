/**
 * db/atrasoQueries.js
 *
 * Equipes ATRASADAS pela escala, num período — a tabela da aba Gráficos.
 *
 * Pedido do José em 18/10/2026: "vamos fazer uma tabela na aba de graficos com
 * a lista de equipes atrasadas, dai temos as equipes atrasadas, horario de
 * login horario da escala e tempo de atraso." Regras escolhidas por ele no
 * mesmo dia:
 *   • atrasada = QUALQUER atraso: primeiro login ≥ 1 min depois do início da
 *     escala (sem a tolerância de 15 min do alerta ⏰ do Monitor);
 *   • escalada e não logou entra na lista como "não logou", separada no resumo.
 *
 * ── DE ONDE VEM ─────────────────────────────────────────────────────────────
 *   escala  = escala_dia × escalas_catalogo (o mesmo JOIN do KPI "esperadas",
 *             db/escalaQueries.js). Código sem horário no catálogo (DR, FOL,
 *             FER…) não entra — é folga. Equipe só da whitelist ativa.
 *   login   = session_begin dos snapshots (o primeiro do turno).
 *
 * ── LIMITES CONHECIDOS (aparecem aqui pra não virarem surpresa na conferência)
 *   • O snapshot é a cada 15 min: sessão que abriu e fechou entre dois ciclos
 *     não existe pra nós, e a equipe sai "não logou".
 *   • A escala do dia é a última que o sync viu. Desde 18/10/2026 (P2-65) ela é
 *     relida a cada 30 min; antes disso, convocação lançada depois das 05:20 só
 *     aparecia no dia seguinte, e os dias passados já foram reescritos pelos
 *     syncs seguintes (a EDP devolve o mês inteiro).
 *   • Sem escala cadastrada (P2-47) a equipe não aparece — não dá pra estar
 *     atrasada em relação a nada.
 *
 * ⚠️ FUSO: tudo é HORA DE PAREDE, como na medição HE (db/heQueries.js, que
 * explica a armadilha). Os dois lados são lidos por `msParede`; só a diferença
 * é usada.
 */

'use strict';

const { _getPool } = require('../services/pgShim');
const { msParede, janelaDaEscala } = require('./heQueries');
const { filtroDeCategorias } = require('../services/categoriasEquipe');

const MS_MIN  = 60000;
const MS_HORA = 3600000;

// Login até quanto ANTES do início ainda é "o login deste turno". Plantão que
// loga cedo, ou turno que vira a noite, cabem; a sessão do turno de ontem não.
const ANTECEDENCIA_MAX_MS = 6 * MS_HORA;

// O snapshot é a cada 15 min (cronService). Usado só pro "não logou" de HOJE.
const CICLO_COLETA_MS = 15 * MS_MIN;

/** 'YYYY-MM-DD' ± n dias. */
function diaMais(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** ms de parede → 'YYYY-MM-DD HH:MM'. */
function fmtParedeMin(ms) {
  if (ms == null) return null;
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

/** Agora, em ms de parede BRT (a VM roda em UTC). */
function agoraParede(ref = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(ref).reduce((o, x) => { o[x.type] = x.value; return o; }, {});
  const hh = p.hour === '24' ? '00' : p.hour;
  return msParede(`${p.year}-${p.month}-${p.day}T${hh}:${p.minute}:${p.second}`);
}

/**
 * FUNÇÃO PURA (testável): o turno da equipe no dia.
 *
 * `escala_dia` é por COLABORADOR; com códigos diferentes no mesmo dia vale o
 * que COMEÇA PRIMEIRO — a mesma regra do alerta ⏰ do Monitor
 * (`escalaQueries.equipesCobertas`). A equipe deveria estar em campo desde o
 * primeiro turno de qualquer um dos seus.
 *
 * @param {string} dia
 * @param {Array<{codigo, inicio_escala, fim_escala}>} pares
 * @returns {{codigo, inicioMs, fimMs}|null}
 */
function turnoDoDia(dia, pares) {
  let out = null;
  for (const p of (pares || [])) {
    const j = janelaDaEscala(dia, p.inicio_escala, p.fim_escala);
    if (!j) continue;
    if (!out || j.inicioMs < out.inicioMs) out = { codigo: p.codigo || null, ...j };
  }
  return out;
}

/**
 * FUNÇÃO PURA (testável): a equipe atrasou neste turno?
 *
 * @param {{inicioMs, fimMs}} turno
 * @param {Array<{begin, end}>} sessoes  sessões da equipe ao redor do dia
 * @param {number} agoraMs  agora, em parede — turno que ainda não começou não é avaliado
 * @returns {null | {status: 'atrasada'|'nao-logou', loginMs: number|null, atrasoMin: number|null}}
 *          null = não houve atraso (ou ainda não dá pra dizer)
 */
function avaliarAtraso(turno, sessoes, agoraMs) {
  if (!turno) return null;
  if (agoraMs != null && agoraMs < turno.inicioMs) return null;   // turno no futuro

  const lista = (sessoes || [])
    .map(s => ({ ini: msParede(s.begin), fim: msParede(s.end) }))
    .filter(s => s.ini != null);

  // Sessão aberta ANTES da janela e que ainda cobria o início (plantão de
  // ontem que emendou, relogin perdido): a equipe estava em campo na hora.
  const cobriaInicio = lista.some(s =>
    s.ini < turno.inicioMs - ANTECEDENCIA_MAX_MS && (s.fim == null || s.fim > turno.inicioMs));
  if (cobriaInicio) return null;

  const doTurno = lista
    .filter(s => s.ini >= turno.inicioMs - ANTECEDENCIA_MAX_MS && s.ini < turno.fimMs)
    .map(s => s.ini);
  if (!doTurno.length) {
    // Turno que começou há menos de um ciclo de coleta: o login pode já ter
    // acontecido e ainda não estar em snapshot. Não é tolerância de atraso —
    // é não acusar o que não dá pra saber.
    if (agoraMs != null && agoraMs - turno.inicioMs < CICLO_COLETA_MS) return null;
    return { status: 'nao-logou', loginMs: null, atrasoMin: null };
  }

  const loginMs = Math.min(...doTurno);
  // "Qualquer atraso" (José, 18/10/2026), em minutos inteiros: 08:00:59 num
  // turno das 08:00 é 0 min e não entra; 08:01:00 entra.
  const atrasoMin = Math.floor((loginMs - turno.inicioMs) / MS_MIN);
  if (atrasoMin < 1) return null;
  return { status: 'atrasada', loginMs, atrasoMin };
}

/**
 * Equipes atrasadas (e escaladas que não logaram) no período.
 *
 * @param {string} de   'YYYY-MM-DD'
 * @param {string} ate  'YYYY-MM-DD'
 * @param {object} opts { regionais?: string[], teams?: string[], tipo?: string (CSV de categorias) }
 */
async function equipesAtrasadas(de, ate, opts = {}) {
  const pool = _getPool();

  const params = [de, ate];
  let filtroRegional = '';
  if (Array.isArray(opts.regionais) && opts.regionais.length) {
    const ph = opts.regionais.map(r => { params.push(r); return `$${params.length}`; });
    filtroRegional = ` AND eo.regional IN (${ph.join(', ')})`;
  }

  const { rows: escRows } = await pool.query(
    `SELECT DISTINCT to_char(ed.data, 'YYYY-MM-DD') AS dia,
            upper(btrim(eo.sigla)) AS sigla, eo.regional, eo.tipo,
            ed.codigo_escala AS codigo, ec.inicio_escala, ec.fim_escala
       FROM public.escala_dia ed
       JOIN public.escalas_catalogo ec
         ON ec.codigo = ed.codigo_escala AND ec.sector_id = ed.sector_id
       JOIN public.equipes_oficiais eo
         ON upper(btrim(eo.sigla)) = upper(btrim(ed.equipe)) AND eo.ativo
      WHERE ed.data BETWEEN $1::date AND $2::date
        AND ec.inicio_escala IS NOT NULL
        AND ec.fim_escala    IS NOT NULL
        ${filtroRegional}`, params);

  const filtroTeam = Array.isArray(opts.teams) && opts.teams.length
    ? new Set(opts.teams.map(t => String(t).trim().toUpperCase())) : null;
  const passaTipo = filtroDeCategorias(opts.tipo);

  const turnos = new Map();      // 'SIGLA|dia' → { sigla, dia, regional, tipo, pares[] }
  for (const r of escRows) {
    if (filtroTeam && !filtroTeam.has(r.sigla)) continue;
    if (!passaTipo(r.sigla)) continue;
    const k = `${r.sigla}|${r.dia}`;
    if (!turnos.has(k)) turnos.set(k, { sigla: r.sigla, dia: r.dia, regional: r.regional, tipo: r.tipo, pares: [] });
    turnos.get(k).pares.push(r);
  }

  const siglas = [...new Set([...turnos.values()].map(t => t.sigla))];
  const sessoesPorSigla = new Map();
  if (siglas.length) {
    // Um dia antes e um depois: turno que vira a noite e login antecipado de
    // turno da madrugada. Último estado de cada sessão (onde vive o fim) e o
    // logoff que o sync das 03:00 só grava no jsonb — ver db/heQueries.js.
    const { rows: sesRows } = await pool.query(
      `SELECT DISTINCT ON (upper(btrim(team_name)), session_begin)
              upper(btrim(team_name)) AS sigla, session_begin,
              COALESCE(session_end, data->>'sessionEnd', data->>'session_end') AS session_end
         FROM public.snapshots
        WHERE date BETWEEN $1::date AND $2::date
          AND session_begin IS NOT NULL
          AND upper(btrim(team_name)) = ANY($3)
        ORDER BY upper(btrim(team_name)), session_begin, captured_at DESC`,
      [diaMais(de, -1), diaMais(ate, 1), siglas]);
    for (const r of sesRows) {
      if (!sessoesPorSigla.has(r.sigla)) sessoesPorSigla.set(r.sigla, []);
      sessoesPorSigla.get(r.sigla).push({ begin: r.session_begin, end: r.session_end });
    }
  }

  const agoraMs = agoraParede();
  const linhas = [];
  let avaliados = 0;
  for (const t of turnos.values()) {
    const turno = turnoDoDia(t.dia, t.pares);
    if (!turno || turno.inicioMs > agoraMs) continue;
    avaliados++;
    const r = avaliarAtraso(turno, sessoesPorSigla.get(t.sigla) || [], agoraMs);
    if (!r) continue;
    linhas.push({
      dia: t.dia,
      equipe: t.sigla,
      regional: t.regional,
      tipo: t.tipo,
      codigo: turno.codigo,
      escala_inicio: fmtParedeMin(turno.inicioMs).slice(11),
      escala_fim: fmtParedeMin(turno.fimMs).slice(11),
      login: r.loginMs == null ? null : fmtParedeMin(r.loginMs),
      atraso_min: r.atrasoMin,
      status: r.status,
    });
  }

  // Dia mais recente primeiro; dentro do dia, atrasadas pelo maior atraso e
  // as que não logaram no fim.
  linhas.sort((a, b) => b.dia.localeCompare(a.dia)
    || (a.status === b.status ? 0 : a.status === 'atrasada' ? -1 : 1)
    || (b.atraso_min || 0) - (a.atraso_min || 0)
    || a.equipe.localeCompare(b.equipe));

  const atrasadas = linhas.filter(l => l.status === 'atrasada');
  const minutos = atrasadas.map(l => l.atraso_min).sort((x, y) => x - y);
  return {
    periodo: { de, ate },
    linhas,
    resumo: {
      turnos_avaliados: avaliados,
      atrasadas: atrasadas.length,
      nao_logou: linhas.length - atrasadas.length,
      atraso_medio_min: minutos.length ? Math.round(minutos.reduce((s, m) => s + m, 0) / minutos.length) : null,
      atraso_mediano_min: minutos.length ? minutos[Math.floor(minutos.length / 2)] : null,
    },
  };
}

module.exports = {
  equipesAtrasadas,
  // Puras, exportadas pra teste.
  turnoDoDia,
  avaliarAtraso,
  agoraParede,
  ANTECEDENCIA_MAX_MS,
};
