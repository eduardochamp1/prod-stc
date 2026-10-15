/**
 * db/rotinaQueries.js
 *
 * "Rotina da equipe" — a linha do tempo de UM dia de UMA equipe, no formato do
 * gráfico "Dia da equipe" do painel da EDP (Gestão de equipes - ES) e do Plano
 * Diário do eOrder. Pedido do José em 15/10/2026: a aba Mapa vira aba Rotina,
 * com esse gráfico no topo e a situação da carteira ao lado.
 *
 * ── AS 5 FAIXAS ─────────────────────────────────────────────────────────────
 *   Escala        escala_dia × escalas_catalogo (o turno CADASTRADO)
 *   Sessão        snapshots.session_begin/session_end (login → logoff no app)
 *   Deslocamento  checkpoint 0 → 1 de cada nota
 *   Serviço       checkpoint 2 → 3 de cada nota (cor = status da nota)
 *   Desvio        tempo DENTRO da sessão sem deslocamento nem serviço
 *
 * Eventos do checkpoint: docs/handoff/API-WPA-EDP.md §292 (0 início desloc,
 * 1 fim desloc, 2 início trabalho, 4 finalizando, 3 fim do trabalho).
 *
 * ⚠️ "Desvio" é DERIVADO, não vem da EDP: é sessão menos (deslocamento ∪
 * serviço). A definição é essa e só essa — inclui almoço, espera de material,
 * tudo. A tela diz isso no tooltip; não é acusação de ociosidade.
 *
 * ⚠️ HORÁRIO DO CHECKPOINT: lê `registradoEm` (RegisteredAt2), nunca o
 * `timestamp` nos eventos 0 e 1 — ali ele é o instante da SINCRONIZAÇÃO e erra
 * até 55 min (nota 104875481, ver API-WPA-EDP.md). Nos eventos 2/3 o erro do
 * `timestamp` é de segundos, então ele serve de reserva para cache anterior a
 * 30/08/2026 (quando `registradoEm` passou a ser gravado). Deslocamento sem
 * `registradoEm` NÃO é desenhado — é contado em `semHorario`.
 *
 * Todo instante vira "ms de parede BRT" via heQueries.msParede (a VM roda em
 * UTC; a armadilha das 3h está documentada lá) e sai em MINUTOS desde a
 * meia-noite do dia. Turno que vira a noite passa de 1440 — de propósito.
 */

'use strict';

const { _getPool } = require('../services/pgShim');
const { msParede, janelaDaEscala } = require('./heQueries');
const { isFolga } = require('../services/escalaDia');

const MS_MIN = 60000;
const MS_DIA = 86400000;
// Até onde a linha do tempo de um dia pode ir: turno noturno que fecha de manhã.
const HORIZONTE_MS = 30 * 3600000;
// Buraco menor que isso entre dois apontamentos é ruído de sincronização, não desvio.
const DESVIO_MIN_MS = 60000;

/** Instante do checkpoint em ms de parede. Ver o ⚠️ do topo. */
function instanteCp(cp) {
  if (!cp) return null;
  const reg = msParede(cp.registradoEm);
  if (reg != null) return reg;
  const ev = Number(cp.event);
  if (ev === 0 || ev === 1) return null;     // timestamp aqui é a sincronização
  return msParede(cp.timestamp);
}

/**
 * FUNÇÃO PURA (testável): intervalos de deslocamento e de serviço de UMA nota.
 *
 * Máquina de estados na ordem cronológica: 0 abre deslocamento, 1 fecha;
 * 2 abre serviço (e fecha um deslocamento que ficou aberto — chegou e já
 * começou sem apontar o 1); 3 fecha serviço. O 4 (Finalizando) fica dentro do
 * serviço e não muda nada. Cada novo 0 é uma nova tentativa.
 *
 * Serviço sem 3 volta com `fim: null` — quem chama decide (interrupção, em
 * andamento ou descartado). Deslocamento sem fim é descartado: sem chegada não
 * há duração para desenhar.
 */
function intervalosDaNota(checkpoints) {
  const evs = (checkpoints || [])
    .map(cp => ({ ev: Number(cp && cp.event), ms: instanteCp(cp) }))
    .filter(e => e.ms != null && Number.isFinite(e.ev))
    .sort((a, b) => a.ms - b.ms);

  const desloc = [], servico = [];
  let dAberto = null, sAberto = null;
  let semHorario = 0;
  for (const cp of (checkpoints || [])) {
    if (cp && Number(cp.event) === 0 && instanteCp(cp) == null) semHorario++;
  }

  for (const { ev, ms } of evs) {
    if (ev === 0) {
      dAberto = ms;
    } else if (ev === 1) {
      if (dAberto != null && ms >= dAberto) desloc.push({ ini: dAberto, fim: ms });
      dAberto = null;
    } else if (ev === 2) {
      if (dAberto != null && ms >= dAberto) desloc.push({ ini: dAberto, fim: ms });
      dAberto = null;
      if (sAberto == null) sAberto = ms;
    } else if (ev === 3) {
      if (sAberto != null && ms >= sAberto) servico.push({ ini: sAberto, fim: ms });
      sAberto = null;
    }
  }
  if (sAberto != null) servico.push({ ini: sAberto, fim: null });
  return { desloc, servico, semHorario };
}

/** FUNÇÃO PURA: une intervalos sobrepostos. Entrada [{ini,fim}] em ms. */
function unir(intervalos) {
  const ord = (intervalos || [])
    .filter(i => i && i.fim != null && i.fim > i.ini)
    .map(i => ({ ini: i.ini, fim: i.fim }))
    .sort((a, b) => a.ini - b.ini);
  const out = [];
  for (const i of ord) {
    const ult = out[out.length - 1];
    if (ult && i.ini <= ult.fim) ult.fim = Math.max(ult.fim, i.fim);
    else out.push(i);
  }
  return out;
}

/** FUNÇÃO PURA: [s,e] menos a união `ocupado`. Devolve os buracos ≥ minMs. */
function buracos(s, e, ocupado, minMs = DESVIO_MIN_MS) {
  const out = [];
  let cur = s;
  for (const o of unir(ocupado)) {
    if (o.fim <= cur) continue;
    if (o.ini >= e) break;
    if (o.ini > cur && o.ini - cur >= minMs) out.push({ ini: cur, fim: Math.min(o.ini, e) });
    cur = Math.max(cur, o.fim);
    if (cur >= e) break;
  }
  if (e > cur && e - cur >= minMs) out.push({ ini: cur, fim: e });
  return out;
}

const _soma = arr => unir(arr).reduce((acc, i) => acc + (i.fim - i.ini), 0);

/**
 * FUNÇÃO PURA (testável): monta a linha do tempo do dia.
 *
 * @param {object} p
 * @param {string} p.dia           'YYYY-MM-DD'
 * @param {Array}  p.escalas       [{codigo_escala, inicio_escala, fim_escala}]
 * @param {Array}  p.sessoes       [{begin, end}]  (strings como no snapshot)
 * @param {Array}  p.notas         [{id, numero, tipo, status, checkpoints}]
 * @param {Array}  p.interrupcoes  [{note_id, numero, instanteMs, motivo}]
 * @param {number} p.agoraMs       "agora" em ms de parede BRT
 */
function montarRotina({ dia, escalas = [], sessoes = [], notas = [], interrupcoes = [], agoraMs }) {
  const base = msParede(`${dia}T00:00:00`);
  const limite = base + HORIZONTE_MS;
  const ehHoje = agoraMs != null && agoraMs >= base && agoraMs < base + MS_DIA;
  const min = ms => Math.round((ms - base) / MS_MIN * 10) / 10;
  const dentro = i => i.fim > base && i.ini < limite;
  const recorta = i => ({ ...i, ini: Math.max(i.ini, base), fim: Math.min(i.fim, limite) });

  // ── Escala ────────────────────────────────────────────────────────────────
  const escala = [];
  const folgas = new Set();
  const vistos = new Set();
  for (const e of escalas) {
    const cod = e.codigo_escala ? String(e.codigo_escala).trim() : '';
    const j = janelaDaEscala(dia, e.inicio_escala, e.fim_escala);
    if (!j) { if (cod && isFolga(cod)) folgas.add(cod); continue; }
    const k = `${j.inicioMs}|${j.fimMs}`;
    if (vistos.has(k)) continue;           // 2 colaboradores, mesmo turno
    vistos.add(k);
    escala.push({ ini: j.inicioMs, fim: j.fimMs, codigo: cod || null });
  }

  // ── Sessão ────────────────────────────────────────────────────────────────
  const sessao = [];
  for (const s of sessoes) {
    const ini = msParede(s.begin);
    if (ini == null) continue;
    let fim = msParede(s.end);
    let aberta = false;
    if (fim == null) {
      // Sessão aberta: hoje vai até agora. Em dia passado não se inventa fim
      // (mesma regra de heQueries.sessaoDoDia) — desenha até o último
      // apontamento conhecido, marcada como aberta.
      aberta = true;
      fim = ehHoje ? agoraMs : null;
    }
    sessao.push({ ini, fim, aberta });
  }

  // ── Deslocamento e serviço ────────────────────────────────────────────────
  const intPorNota = new Map();
  for (const it of interrupcoes) {
    if (it.instanteMs == null) continue;
    if (!intPorNota.has(it.note_id)) intPorNota.set(it.note_id, []);
    intPorNota.get(it.note_id).push(it.instanteMs);
  }

  const deslocamento = [], servico = [];
  let semHorario = 0, servicoSemFim = 0;
  for (const n of notas) {
    const r = intervalosDaNota(n.checkpoints);
    semHorario += r.semHorario;
    const info = { noteId: n.id, numero: n.numero || '', tipo: n.tipo || '' };
    for (const d of r.desloc) deslocamento.push({ ...d, ...info });
    for (const s of r.servico) {
      if (s.fim != null) { servico.push({ ...s, ...info, status: n.status }); continue; }
      // Sem "Fim do Trabalho": interrupção depois do início fecha o bloco.
      const ints = (intPorNota.get(n.id) || []).filter(t => t >= s.ini).sort((a, b) => a - b);
      if (ints.length) {
        servico.push({ ini: s.ini, fim: ints[0], ...info, status: 'interrompida' });
      } else if (ehHoje && n.status === 'executada') {
        servico.push({ ini: s.ini, fim: agoraMs, ...info, status: 'andamento', aberto: true });
      } else {
        servicoSemFim++;
      }
    }
  }

  // Sessão aberta de dia passado: até o último apontamento dela.
  const ultimoApont = Math.max(base, ...deslocamento.map(d => d.fim), ...servico.map(s => s.fim));
  for (const s of sessao) if (s.fim == null) s.fim = Math.max(s.ini, ultimoApont);

  const fDesloc = deslocamento.filter(dentro).map(recorta);
  const fServ   = servico.filter(dentro).map(recorta);
  const fSessao = sessao.filter(s => s.fim > s.ini).filter(dentro).map(recorta);
  const fEscala = escala.filter(dentro).map(recorta);

  // ── Desvio ────────────────────────────────────────────────────────────────
  const ocupado = [...fDesloc, ...fServ];
  const desvio = [];
  for (const s of unir(fSessao)) desvio.push(...buracos(s.ini, s.fim, ocupado));

  const paraMin = arr => arr.map(i => ({ ...i, ini: min(i.ini), fim: min(i.fim) }));
  const totalMin = arr => Math.round(_soma(arr) / MS_MIN);

  return {
    dia,
    faixas: {
      escala:       paraMin(fEscala),
      sessao:       paraMin(fSessao),
      desvio:       paraMin(desvio),
      deslocamento: paraMin(fDesloc.sort((a, b) => a.ini - b.ini)),
      servico:      paraMin(fServ.sort((a, b) => a.ini - b.ini)),
    },
    totaisMin: {
      escala: totalMin(fEscala), sessao: totalMin(fSessao), desvio: totalMin(desvio),
      deslocamento: totalMin(fDesloc), servico: totalMin(fServ),
    },
    interrupcoes: interrupcoes
      .filter(i => i.instanteMs != null && i.instanteMs >= base && i.instanteMs < limite)
      .map(i => ({ noteId: i.note_id, numero: i.numero || '', motivo: i.motivo || '', min: min(i.instanteMs) }))
      .sort((a, b) => a.min - b.min),
    folgas: [...folgas],
    agoraMin: ehHoje ? min(agoraMs) : null,
    avisos: { semHorario, servicoSemFim },
  };
}

/**
 * FUNÇÃO PURA (testável): situação da carteira no painel lateral.
 *
 * Os números vêm prontos de `team_daily_carteira` — a MESMA fonte da aba
 * Carteira (rule 7: uma métrica, uma fonte). Aqui só se renomeia para o
 * vocabulário da operação. `canceladas` é tudo que SAIU da carteira da equipe
 * sem ser concluído nem rejeitado: na prática, nota remanejada para outra
 * equipe ou cancelada pela EDP — o snapshot não distingue as duas, e o rótulo
 * da tela diz isso em vez de fingir que sabe.
 *
 * Interrompidas vêm de `note_interrupcoes` (notas distintas da equipe no dia)
 * e NÃO entram na conta da carteira: a nota interrompida continua nela.
 */
function montarCarteira(row, interrompidas) {
  if (!row) return null;
  const n = v => Number(v) || 0;
  return {
    inicial:      n(row.carteira_inicial),
    entradas:     n(row.entradas_novas),
    executadas:   n(row.concluidas),
    rejeitadas:   n(row.rejeitadas),
    remanejadas:  n(row.canceladas),
    pendentes:    n(row.atual) + n(row.andamento),
    andamento:    n(row.andamento),
    interrompidas: interrompidas == null ? null : n(interrompidas),
  };
}

function _diaMais(iso, n) {
  return new Date(Date.parse(`${iso}T12:00:00Z`) + n * MS_DIA).toISOString().slice(0, 10);
}

/** Consulta que pode faltar (migration não aplicada) não derruba a tela. */
async function _talvez(pool, sql, params, rotulo, avisos) {
  try {
    return (await pool.query(sql, params)).rows;
  } catch (err) {
    avisos.push(`${rotulo}: ${err.message}`);
    return [];
  }
}

/**
 * A rotina de uma equipe num dia. Bounded: 1 equipe × 1 dia.
 */
async function rotinaEquipe(team, dia, agora = Date.now()) {
  const pool = _getPool();
  if (!pool) return null;
  const equipe = String(team).trim().toUpperCase();
  const erros = [];

  const [escalas, sesRows, ultRows, rejRows, intRows, cartRows] = await Promise.all([
    _talvez(pool,
      `SELECT DISTINCT ed.codigo_escala, ec.inicio_escala, ec.fim_escala
         FROM public.escala_dia ed
         LEFT JOIN public.escalas_catalogo ec
           ON ec.codigo = ed.codigo_escala AND ec.sector_id = ed.sector_id
        WHERE ed.data = $1::date AND upper(btrim(ed.equipe)) = $2`,
      [dia, equipe], 'escala', erros),
    // Mesma leitura de sessão da medição de HE (heQueries.medicaoHe): +1 dia de
    // lookahead pro logoff depois da meia-noite, e COALESCE porque o job de
    // logoff das 03:00 só atualiza o jsonb.
    _talvez(pool,
      `SELECT DISTINCT ON (session_begin)
              session_begin,
              COALESCE(session_end, data->>'sessionEnd', data->>'session_end') AS session_end
         FROM public.snapshots
        WHERE upper(btrim(team_name)) = $1
          AND date BETWEEN $2::date AND $3::date
          AND session_begin IS NOT NULL
        ORDER BY session_begin, captured_at DESC`,
      [equipe, dia, _diaMais(dia, 1)], 'sessao', erros),
    _talvez(pool,
      `SELECT data FROM public.snapshots
        WHERE upper(btrim(team_name)) = $1 AND date = $2::date
        ORDER BY captured_at DESC LIMIT 1`,
      [equipe, dia], 'snapshot', erros),
    // Rejeitadas somem do payload horas depois (WPA limpa) — note_rejections
    // é a memória persistente, mesma regra de upsertTeamDailyCarteira.
    _talvez(pool,
      `SELECT DISTINCT note_id::text AS note_id, numero, tipo
         FROM public.note_rejections
        WHERE upper(btrim(team_name)) = $1 AND session_date = $2::date`,
      [equipe, dia], 'rejeicoes', erros),
    _talvez(pool,
      `SELECT note_id::text AS note_id, numero, tipo, instante, motivo
         FROM public.note_interrupcoes
        WHERE upper(btrim(team_name)) = $1 AND dia = $2::date`,
      [equipe, dia], 'interrupcoes', erros),
    _talvez(pool,
      `SELECT * FROM public.team_daily_carteira
        WHERE upper(btrim(team_name)) = $1 AND date = $2::date`,
      [equipe, dia], 'carteira', erros),
  ]);

  // Notas do dia: último snapshot + rejeitadas persistidas + interrompidas.
  const STATUS = [
    ['notasConcluidas', 'concluida'], ['notasRejeitadas', 'rejeitada'],
    ['notasExecutadas', 'executada'], ['notasBaixadas', 'baixada'],
  ];
  const notasMap = new Map();
  const snap = (ultRows[0] && ultRows[0].data) || {};
  for (const [k, status] of STATUS) {
    for (const n of (snap[k] || [])) {
      if (n && n.id && !notasMap.has(n.id)) {
        notasMap.set(n.id, { id: n.id, numero: n.numero || n.number || '', tipo: n.tipo || n.type || '', status });
      }
    }
  }
  for (const r of rejRows) {
    const atual = notasMap.get(r.note_id);
    if (atual) atual.status = 'rejeitada';   // rejeitada > concluída (decisão 20/07/2026)
    else notasMap.set(r.note_id, { id: r.note_id, numero: r.numero || '', tipo: r.tipo || '', status: 'rejeitada' });
  }
  for (const r of intRows) {
    if (!notasMap.has(r.note_id)) {
      notasMap.set(r.note_id, { id: r.note_id, numero: r.numero || '', tipo: r.tipo || '', status: 'interrompida' });
    }
  }

  const ids = [...notasMap.keys()];
  const det = ids.length ? await _talvez(pool,
    `SELECT note_id::text AS note_id, numero, tipo, payload->'checkpoints' AS checkpoints
       FROM public.note_details WHERE note_id::text = ANY($1::text[])`,
    [ids], 'note_details', erros) : [];
  for (const d of det) {
    const n = notasMap.get(d.note_id);
    if (!n) continue;
    n.checkpoints = Array.isArray(d.checkpoints) ? d.checkpoints : [];
    if (!n.numero) n.numero = d.numero || '';
    if (!n.tipo) n.tipo = d.tipo || '';
  }

  const toIso = v => (v instanceof Date ? v.toISOString() : v);
  const rotina = montarRotina({
    dia,
    escalas,
    sessoes: sesRows
      .filter(r => String(r.session_begin).slice(0, 10) === dia)
      .map(r => ({ begin: r.session_begin, end: r.session_end })),
    notas: [...notasMap.values()],
    interrupcoes: intRows.map(r => ({
      note_id: r.note_id, numero: r.numero, motivo: r.motivo,
      instanteMs: msParede(toIso(r.instante)),
    })),
    agoraMs: msParede(new Date(agora).toISOString()),
  });

  const interrompidas = new Set(intRows.map(r => r.note_id)).size;
  return {
    team: equipe,
    ...rotina,
    carteira: montarCarteira(cartRows[0], interrompidas),
    erros,
  };
}

module.exports = {
  rotinaEquipe,
  // Puras, exportadas pra teste.
  instanteCp, intervalosDaNota, unir, buracos, montarRotina, montarCarteira,
};
