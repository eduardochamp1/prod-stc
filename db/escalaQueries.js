/**
 * db/escalaQueries.js
 *
 * Quantas equipes DEVERIAM estar em campo agora, segundo a escala.
 *
 * Pedido do José em 30/08/2026: o KPI "TOTAL EQUIPES" do Monitor mostrava
 * whitelist × em campo, e comparar 139 com 31 não diz nada — a maioria das 139
 * está de folga a qualquer momento. O número útil é **esperadas agora**.
 *
 * ── DE ONDE VEM ─────────────────────────────────────────────────────────────
 *   escala_dia        (data, sector_id, equipe, colaborador_codigo, codigo_escala)
 *                     quem está escalado em cada dia. Populada por runSyncEscalaDia.
 *   escalas_catalogo  (codigo, sector_id, inicio_escala, fim_escala, ...)
 *                     o horário de cada código. Populada por runSyncEscalaCatalogo.
 *
 * ⚠️ POR QUE NÃO USAR `equipes_oficiais.escala_inicio/fim`: aquilo é só uma faixa
 * de horário, sem dia da semana. Medido em 30/08/2026, num único dia havia **216
 * equipes com código `DR`** (descanso) e 5 em `FER` (férias). Usar a faixa fixa
 * contaria todas elas como "deveriam estar online" e o KPI acusaria um buraco
 * enorme que não existe — todo fim de semana. KPI que o usuário aprende a
 * ignorar é pior que KPI nenhum.
 *
 * ⚠️ FOLGA E FÉRIAS SAEM SOZINHAS. Códigos não-trabalháveis (`DR`, `FER`, `AFO`)
 * vêm do catálogo SEM horário, então o filtro de horário não-nulo já os exclui.
 * É de propósito: uma lista negra de códigos no código-fonte ficaria desatualizada
 * na primeira vez que a EDP criasse um turno novo.
 */

const { _getPool } = require('../services/pgShim');
const { dateBRT } = require('../services/timeUtil');

/** 'HH:MM:SS' (ou Date do pg) → minutos desde a meia-noite. null se inválido. */
function minutosDoDia(v) {
  if (v == null) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mi) || h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/**
 * FUNÇÃO PURA (testável): o turno cobre o instante atual?
 *
 * @param {number} inicio    minutos do dia em que o turno começa
 * @param {number} fim       minutos do dia em que termina
 * @param {number} agora     minutos do dia agora (BRT)
 * @param {boolean} deOntem  a linha de escala é do dia ANTERIOR?
 *
 * Turno que vira a meia-noite (fim < inicio, ex.: C35 22:35→06:00) cobre DOIS
 * dias de calendário. Às 02:00 de hoje, quem está em campo foi escalado ONTEM —
 * olhar só o dia de hoje zeraria o KPI toda madrugada.
 */
function turnoCobreAgora(inicio, fim, agora, deOntem) {
  if (inicio == null || fim == null || agora == null) return false;
  if (fim === inicio) return false;   // janela ambígua (24h? erro?) — não adivinha

  if (fim > inicio) {
    // Turno normal, dentro do mesmo dia. Linha de ontem nunca cobre hoje.
    return !deOntem && agora >= inicio && agora < fim;
  }
  // Vira a meia-noite: cobre [inicio, 24h) do dia da escala e [0, fim) do dia seguinte.
  return deOntem ? (agora < fim) : (agora >= inicio);
}

/**
 * Dia da linha como 'YYYY-MM-DD', aceitando string OU Date.
 *
 * ⚠️ 30/08/2026 — BUG QUE ISSO CONSERTA. O `pg` devolve coluna `date` como
 * objeto Date, e o código fazia `String(l.data).slice(0, 10)`. Em Date isso dá
 * `"Sat Aug 3"` (de "Sat Aug 30 2026 00:00:00 GMT+0000"), que nunca é igual a
 * "2026-08-30" — então TODA linha era tratada como "de ontem", os turnos normais
 * exigem `!deOntem`, e o KPI mostrava 0 esperadas com 49 equipes escaladas.
 *
 * A consulta passou a devolver `to_char(...)`, o que já resolve; isto fica como
 * defesa em profundidade, e usa as partes LOCAIS do Date de propósito: o pg
 * materializa `date` como meia-noite local, então `toISOString()` mudaria o dia
 * em qualquer fuso a oeste de Greenwich.
 */
function diaISO(v) {
  if (v == null) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const p = n => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/** 'YYYY-MM-DD' menos um dia, sem depender do fuso do processo. */
function diaAnterior(iso) {
  const d = new Date(iso + 'T12:00:00Z');   // meio-dia evita borda de horário de verão
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * FUNÇÃO PURA (testável): dado o conjunto de linhas (escala × catálogo),
 * devolve as equipes distintas que deveriam estar em campo agora.
 *
 * Uma equipe conta se QUALQUER colaborador dela está escalado agora. Com dois
 * de três colaboradores em folga, a equipe está em campo com gente a menos —
 * mas está em campo. Exigir todos subestimaria o esperado.
 */
function equipesCobertas(linhas, agoraMin, hoje) {
  const out = new Map();
  for (const l of (linhas || [])) {
    const dia = diaISO(l.data);
    // Linha sem dia legível não pode virar "de ontem" por acidente — descarta.
    if (!dia) continue;
    const deOntem = dia !== hoje;
    if (!turnoCobreAgora(minutosDoDia(l.inicio_escala), minutosDoDia(l.fim_escala), agoraMin, deOntem)) {
      continue;
    }
    const sigla = String(l.sigla || '').toUpperCase().trim();
    if (!sigla || out.has(sigla)) continue;
    out.set(sigla, { sigla, tipo: (l.tipo || '—').toUpperCase(), regional: l.regional || null });
  }
  return [...out.values()];
}

/**
 * Equipes da whitelist que deveriam estar em campo agora.
 *
 * @param {string[]|null} regionais  siglas reais (GUA/CAC/SJC); null = todas
 * @param {Date|number}   quando     instante de referência (default: agora)
 */
async function equipesEsperadasAgora(regionais, quando) {
  const pool = _getPool();
  const ref = quando instanceof Date ? quando : new Date(quando ?? Date.now());
  const hoje = dateBRT(ref);
  const ontem = diaAnterior(hoje);

  // Minutos do dia em BRT. Usar o relógio do processo (UTC na VM) daria 3h de
  // erro e o KPI apontaria o turno errado — mesma armadilha do TMA (PO).
  const hhmm = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(ref);
  const agoraMin = minutosDoDia(hhmm);

  const params = [ontem, hoje];
  let filtroRegional = '';
  if (Array.isArray(regionais) && regionais.length > 0) {
    const ph = regionais.map(r => { params.push(r); return `$${params.length}`; });
    filtroRegional = ` AND eo.regional IN (${ph.join(', ')})`;
  }

  // Só HOJE e ONTEM: nenhum turno catalogado dura mais de 24h, então esses dois
  // dias cobrem qualquer janela que alcance o instante atual.
  const { rows } = await pool.query(
    `SELECT to_char(ed.data, 'YYYY-MM-DD') AS data, eo.sigla, eo.tipo, eo.regional,
            ec.inicio_escala, ec.fim_escala
       FROM public.escala_dia ed
       JOIN public.escalas_catalogo ec
         ON ec.codigo = ed.codigo_escala AND ec.sector_id = ed.sector_id
       JOIN public.equipes_oficiais eo
         ON upper(btrim(eo.sigla)) = upper(btrim(ed.equipe)) AND eo.ativo
      WHERE ed.data IN ($1::date, $2::date)
        AND ec.inicio_escala IS NOT NULL
        AND ec.fim_escala    IS NOT NULL
        ${filtroRegional}`, params);

  const equipes = equipesCobertas(rows, agoraMin, hoje);

  const porTipo = {};
  for (const e of equipes) porTipo[e.tipo] = (porTipo[e.tipo] || 0) + 1;

  return {
    esperadas: equipes.length,
    equipes:   equipes.map(e => e.sigla).sort(),
    porTipo,
    referencia: { dia: hoje, hora: hhmm },
  };
}

module.exports = {
  equipesEsperadasAgora,
  // Puras, exportadas pra teste — a janela de turno é onde mora o erro sutil.
  turnoCobreAgora,
  minutosDoDia,
  diaAnterior,
  diaISO,
  equipesCobertas,
};
