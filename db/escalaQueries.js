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
    if (!sigla) continue;
    // Há quanto tempo o turno começou. Turno vira-noite de ontem começou no dia
    // anterior: às 02:00, um C35 (22:35) começou há 205 min, não há -1235.
    const inicio = minutosDoDia(l.inicio_escala);
    const desdeInicio = deOntem ? agoraMin + 1440 - inicio : agoraMin - inicio;
    const atual = out.get(sigla);
    // Mesma equipe com dois colaboradores em turnos diferentes: vale o que
    // começou PRIMEIRO — é a partir dele que a equipe já deveria ter logado.
    if (atual && atual.minutosDesdeInicio >= desdeInicio) continue;
    out.set(sigla, {
      sigla, tipo: (l.tipo || '—').toUpperCase(), regional: l.regional || null,
      inicio: String(l.inicio_escala).slice(0, 5),
      codigo: l.codigo_escala || null,
      minutosDesdeInicio: desdeInicio,
    });
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
            ec.inicio_escala, ec.fim_escala, ed.codigo_escala
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
    // Por equipe: início do turno e há quantos minutos começou. Alimenta as
    // "atrasadas" do aviso do Monitor (15/10/2026): escalada, turno já começou,
    // e não logou. O front cruza com quem logou — aqui não se sabe disso.
    detalhe:   equipes
      .map(e => ({ sigla: e.sigla, regional: e.regional, tipo: e.tipo,
        inicio: e.inicio, codigo: e.codigo, minutosDesdeInicio: e.minutosDesdeInicio }))
      .sort((a, b) => a.sigla.localeCompare(b.sigla)),
    porTipo,
    referencia: { dia: hoje, hora: hhmm },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FORA DA ESCALA — por que uma equipe EM CAMPO não está entre as esperadas
//
// 16/10/2026 (P2-65). O KPI mostrava "N a mais que o previsto", um SALDO entre
// duas listas que ninguém cruzava. A varredura de scripts/diag-escala-a-mais.js
// mediu o pico: às 17:00 a escala tira ~70 equipes de uma vez e a maioria
// desloga em até 30 min. O José escolheu mostrar o saldo ABERTO (em campo, na
// escala, fora da escala, com o motivo de cada uma) em vez de tolerância no
// número. Nasceu no diag; mora aqui pra tela e diag usarem a MESMA regra.
// ─────────────────────────────────────────────────────────────────────────────

const { isFolga } = require('../services/escalaDia');

// Turno de ONTEM que acabou há mais que isto não explica a equipe em campo hoje
// se hoje ela está de folga — aí o motivo é a folga, não a prorrogação.
const LIMIAR_POS_TURNO_ONTEM_MIN = 240;

// Até quanto depois do fim a equipe está "encerrando o turno" (fechando a última
// nota, voltando à base). Medido em 15 e 16/10/2026: a maior parte desloga entre
// 0 e 30 min. Passado disso é prorrogação. NÃO muda número nenhum — só rotula.
const ENCERRANDO_TURNO_MIN = 30;

const norm = (s) => String(s || '').toUpperCase().trim();

/** Primeiro token do código ("T07 07:00" → "T07"). */
const token = (c) => norm(c).split(/s+/)[0] || '';

/** A janela [inicio, fim) — com virada de meia-noite — contém `agora`? */
function janelaContem(inicio, fim, agora) {
  if (inicio == null || fim == null || agora == null || inicio === fim) return false;
  return fim > inicio ? (agora >= inicio && agora < fim) : (agora >= inicio || agora < fim);
}

/**
 * Por que uma equipe EM CAMPO não está entre as esperadas?
 *
 * @param {object} c
 *   sigla, naWhitelist, regionalWl, regionalSessao, refLogon, shiftType, turnoV2
 *   linhas: [{data, codigo_escala, no_catalogo, prefixo_catalogo, inicio_escala, fim_escala}]
 *           (escala_dia da equipe em ONTEM e HOJE, LEFT JOIN catálogo exato)
 *   agoraMin, hoje
 * @returns {{motivo: string, detalhe: string, minutos: number|null, flags: string[]}}
 */
function classificarExcedente(c) {
  const flags = [];
  const linhas = c.linhas || [];
  const hojeL  = linhas.filter(l => l.data === c.hoje);
  const ontemL = linhas.filter(l => l.data !== c.hoje);
  const trab   = hojeL.filter(l => !isFolga(l.codigo_escala));

  if (c.refLogon && String(c.refLogon).slice(0, 10) < c.hoje) flags.push('sessao-de-dia-anterior');
  if (c.regionalSessao && c.regionalWl && c.regionalSessao !== c.regionalWl) flags.push('regional-diverge');
  if (c.shiftType) {
    const tokHoje = new Set(hojeL.map(l => token(l.codigo_escala)));
    if (!tokHoje.has(token(c.shiftType))) flags.push('v2-turno-diferente');
    const v2 = c.turnoV2 || {};
    if (janelaContem(minutosDoDia(v2.inicio), minutosDoDia(v2.fim), c.agoraMin)) {
      flags.push('v2-turno-cobre-agora');
    }
  }

  if (!c.naWhitelist) {
    return { motivo: 'fora-whitelist', detalhe: 'não está ativa em equipes_oficiais', minutos: null, flags };
  }

  const janela = (l) => {
    const ini = minutosDoDia(l.inicio_escala), fim = minutosDoDia(l.fim_escala);
    return (l.no_catalogo && ini != null && fim != null && ini !== fim) ? { ini, fim } : null;
  };
  if (trab.some(l => !janela(l))) flags.push('codigo-orfao-junto');

  // Candidatos: a que distância ela está de um turno cadastrado?
  const cand = [];
  const agora = c.agoraMin;
  for (const l of trab) {
    const j = janela(l);
    if (!j) continue;
    if (janelaContem(j.ini, j.fim, agora) && (j.fim > j.ini || agora >= j.ini)) {
      // Cobriria pela regra do KPI — não deveria estar aqui. Fica visível.
      cand.push({ motivo: 'inconsistente', minutos: 0, l, j });
    } else if (agora < j.ini) {
      cand.push({ motivo: 'antes-do-turno', minutos: j.ini - agora, l, j });
    } else if (j.fim > j.ini && agora >= j.fim) {
      cand.push({ motivo: 'depois-do-turno', minutos: agora - j.fim, l, j });
    }
  }
  for (const l of ontemL) {
    if (isFolga(l.codigo_escala)) continue;
    const j = janela(l);
    if (!j) continue;
    // Fim do turno de ontem, em minutos relativos à meia-noite de HOJE.
    const fimRel = j.fim > j.ini ? j.fim - 1440 : j.fim;
    if (agora >= fimRel) cand.push({ motivo: 'depois-do-turno', minutos: agora - fimRel, l, j, ontem: true });
  }
  cand.sort((a, b) => a.minutos - b.minutos);
  const melhor = cand[0];
  const fmtJ = (x) => `${x.l.codigo_escala} ${String(x.l.inicio_escala).slice(0, 5)}→${String(x.l.fim_escala).slice(0, 5)}`;

  // Sem janela HOJE, só um turno de ontem que acabou há pouco explica; um que
  // acabou há 15h não explica nada — aí o motivo é o que há (ou falta) hoje.
  const temJanelaHoje = cand.some(x => !x.ontem);
  if (melhor && (temJanelaHoje || melhor.minutos <= LIMIAR_POS_TURNO_ONTEM_MIN)) {
    const quando = melhor.motivo === 'antes-do-turno' ? `${melhor.minutos} min antes do início`
      : melhor.motivo === 'depois-do-turno' ? `${melhor.minutos} min depois do fim`
      : 'a janela cobre agora (divergência com escalaQueries)';
    return {
      motivo: melhor.motivo, minutos: melhor.minutos, flags,
      detalhe: `${fmtJ(melhor)}${melhor.ontem ? ' (ontem)' : ''} · ${quando}`,
    };
  }

  if (hojeL.length === 0) {
    return { motivo: 'sem-escala-hoje', minutos: null, flags,
      detalhe: ontemL.length ? 'tem escala ontem, nada hoje' : 'nenhuma linha ontem nem hoje' };
  }
  const codigos = [...new Set(hojeL.map(l => l.codigo_escala))].join(', ');
  if (trab.length === 0) {
    return { motivo: 'folga-no-cadastro', minutos: null, flags, detalhe: `códigos de hoje: ${codigos}` };
  }
  const semCat = trab.filter(l => !l.no_catalogo);
  if (semCat.length === trab.length) {
    const comPrefixo = semCat.find(l => l.prefixo_catalogo);
    return comPrefixo
      ? { motivo: 'codigo-com-grafia-diferente', minutos: null, flags,
          detalhe: `"${comPrefixo.codigo_escala}" ≠ catálogo "${comPrefixo.prefixo_catalogo}"` }
      : { motivo: 'codigo-fora-do-catalogo', minutos: null, flags, detalhe: `códigos: ${codigos}` };
  }
  const ambigua = trab.find(l => l.no_catalogo && l.inicio_escala != null
    && minutosDoDia(l.inicio_escala) === minutosDoDia(l.fim_escala));
  if (ambigua) {
    return { motivo: 'janela-ambigua', minutos: null, flags,
      detalhe: `${ambigua.codigo_escala} ${String(ambigua.inicio_escala).slice(0, 5)}→${String(ambigua.fim_escala).slice(0, 5)}` };
  }
  return { motivo: 'codigo-sem-horario', minutos: null, flags, detalhe: `códigos: ${codigos}` };
}

/** Motivo do classificador → grupo exibido no KPI. */
function grupoForaDaEscala(motivo, minutos) {
  if (motivo === 'depois-do-turno') {
    return (minutos != null && minutos <= ENCERRANDO_TURNO_MIN)
      ? { grupo: 'encerrando', rotulo: `encerrando turno (até ${ENCERRANDO_TURNO_MIN} min)` }
      : { grupo: 'prorrogacao', rotulo: 'prorrogação' };
  }
  if (motivo === 'antes-do-turno')    return { grupo: 'antes',      rotulo: 'antes do turno' };
  if (motivo === 'sem-escala-hoje')   return { grupo: 'sem-escala', rotulo: 'sem escala' };
  if (motivo === 'folga-no-cadastro') return { grupo: 'folga',      rotulo: 'folga na escala' };
  if (motivo === 'fora-whitelist')    return { grupo: 'whitelist',  rotulo: 'fora da whitelist' };
  if (motivo === 'outra-regional')    return { grupo: 'regional',   rotulo: 'escala em outra regional' };
  return { grupo: 'sem-horario', rotulo: 'escala sem horário' };
}


/**
 * Equipes EM CAMPO que não estão entre as esperadas, com o motivo de cada uma.
 *
 * @param {string[]}      siglasEmCampo  quem a tela conta como em campo
 * @param {string[]|null} regionais      o mesmo escopo de equipesEsperadasAgora
 * @param {Date|number}   quando         instante de referência (default: agora)
 * @param {object}        [esp]          resultado de equipesEsperadasAgora, se já
 *                                       calculado — evita repetir a consulta
 */
async function foraDaEscalaAgora(siglasEmCampo, regionais, quando, esp) {
  const pool = _getPool();
  const ref = quando instanceof Date ? quando : new Date(quando ?? Date.now());
  const hoje = dateBRT(ref);
  const ontem = diaAnterior(hoje);
  const agoraMin = minutosDoDia(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(ref));

  const esperadas = esp || await equipesEsperadasAgora(regionais, ref);
  const noEscopo = new Set((esperadas.equipes || []).map(norm));
  const pedidas = [...new Set((siglasEmCampo || []).map(norm).filter(Boolean))]
    .filter(s => !noEscopo.has(s));
  if (!pedidas.length) return [];

  // Equipe esperada numa regional FORA do escopo (a sessão é de um setor, a
  // whitelist diz outra regional): não é "sem escala", é escala em outro lugar.
  const comEscopo = Array.isArray(regionais) && regionais.length > 0;
  const todas = comEscopo
    ? new Set((await equipesEsperadasAgora(null, ref)).equipes.map(norm))
    : noEscopo;

  const [{ rows: linhas }, { rows: wl }] = await Promise.all([
    pool.query(
      `SELECT to_char(ed.data,'YYYY-MM-DD') AS data, upper(btrim(ed.equipe)) AS sigla,
              ed.codigo_escala, (ec.codigo IS NOT NULL) AS no_catalogo,
              ec.inicio_escala, ec.fim_escala,
              (SELECT min(ec2.codigo) FROM public.escalas_catalogo ec2
                WHERE ec.codigo IS NULL AND ec2.sector_id = ed.sector_id
                  AND regexp_replace(upper(btrim(ec2.codigo)), '[[:space:]].*$', '')
                    = regexp_replace(upper(btrim(ed.codigo_escala)), '[[:space:]].*$', '')
              ) AS prefixo_catalogo
         FROM public.escala_dia ed
         LEFT JOIN public.escalas_catalogo ec
           ON ec.codigo = ed.codigo_escala AND ec.sector_id = ed.sector_id
        WHERE ed.data IN ($1::date, $2::date)
          AND upper(btrim(ed.equipe)) = ANY($3::text[])`, [ontem, hoje, pedidas]),
    pool.query(
      `SELECT upper(btrim(sigla)) AS sigla, regional, tipo
         FROM public.equipes_oficiais
        WHERE ativo AND upper(btrim(sigla)) = ANY($1::text[])`, [pedidas]),
  ]);
  const porEquipe = new Map();
  for (const l of linhas) {
    if (!porEquipe.has(l.sigla)) porEquipe.set(l.sigla, []);
    porEquipe.get(l.sigla).push(l);
  }
  const wlMap = new Map(wl.map(r => [r.sigla, r]));

  return pedidas.map(sigla => {
    const w = wlMap.get(sigla);
    const cls = todas.has(sigla)
      ? { motivo: 'outra-regional', minutos: null, detalhe: 'esperada em outra regional' }
      : classificarExcedente({
          sigla, naWhitelist: !!w, regionalWl: w && w.regional,
          linhas: porEquipe.get(sigla) || [], agoraMin, hoje,
        });
    return {
      sigla, regional: w ? w.regional : null, tipo: w ? (w.tipo || '—').toUpperCase() : '—',
      motivo: cls.motivo, minutos: cls.minutos, detalhe: cls.detalhe,
      ...grupoForaDaEscala(cls.motivo, cls.minutos),
    };
  }).sort((a, b) => a.sigla.localeCompare(b.sigla));
}

module.exports = {
  equipesEsperadasAgora,
  foraDaEscalaAgora,
  // Puras, exportadas pra teste — a janela de turno é onde mora o erro sutil.
  turnoCobreAgora,
  minutosDoDia,
  diaAnterior,
  diaISO,
  equipesCobertas,
  classificarExcedente,
  janelaContem,
  grupoForaDaEscala,
  LIMIAR_POS_TURNO_ONTEM_MIN,
  ENCERRANDO_TURNO_MIN,
};
