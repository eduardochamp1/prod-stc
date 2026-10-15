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
 *   Desvio        apontamento de parada da SESSÃO (sessao_intervalo, P2-15):
 *                 "06 - Check List", "15 - Horário de Refeição",
 *                 "29 - Retorno da equipe à base"...
 *
 * Eventos do checkpoint: docs/handoff/API-WPA-EDP.md §292 (0 início desloc,
 * 1 fim desloc, 2 início trabalho, 4 finalizando, 3 fim do trabalho).
 *
 * ⚠️ DESVIO — EU ESTAVA ERRADO (15/10/2026). A 1ª versão (aa1e901) DERIVAVA o
 * desvio como "sessão menos (deslocamento ∪ serviço)". O José trouxe o export
 * "Serviços e Desvios" do painel da EDP (EPICO30, 04/09/2026) e lá Desvio é
 * APONTAMENTO, com código e texto: 06 Check List 11:00:20→11:14:44, 15 Refeição
 * 18:59:39→19:58:35, 29 Retorno à base 20:56:13→22:14:58 — exatamente o
 * `sessions/{id}/break` que já gravamos em `sessao_intervalo`. O buraco entre
 * apontamentos NÃO é desvio no vocabulário da EDP, e chamá-lo assim seria pôr
 * na tela um número que a EDP desmente.
 *
 * ⚠️ FUSO do sessao_intervalo: leitura com `AT TIME ZONE 'UTC'` (o coletor
 * anexa um 'Z' falso) — mesma armadilha e mesma leitura de heQueries (P1-48).
 * E o cron só sincroniza às 03:10 de D+1: no dia de HOJE a tabela está vazia,
 * então a tela de UMA equipe busca ao vivo (`desviosAoVivo`).
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
const { inRegionalsSql } = require('../services/regionals');

const MS_MIN = 60000;
const MS_DIA = 86400000;
// Até onde a linha do tempo de um dia pode ir: turno noturno que fecha de manhã.
const HORIZONTE_MS = 30 * 3600000;

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
 * @param {Array}  p.desvios       [{motivo, responsavel, inicio, fim}] — parede
 *                                 BRT sem fuso (sessao_intervalo / break ao vivo)
 * @param {number} p.agoraMs       "agora" em ms de parede BRT
 */
function montarRotina({ dia, escalas = [], sessoes = [], notas = [], interrupcoes = [], desvios = [], agoraMs }) {
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
    intPorNota.get(it.note_id).push(it);
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
      const ints = (intPorNota.get(n.id) || []).filter(t => t.instanteMs >= s.ini)
        .sort((a, b) => a.instanteMs - b.instanteMs);
      if (ints.length) {
        servico.push({ ini: s.ini, fim: ints[0].instanteMs, ...info, status: 'interrompida',
          motivo: ints[0].motivo || '' });
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

  // ── Desvio — apontamento de parada da sessão (ver ⚠️ DESVIO no topo) ──────
  const desvio = [];
  let desvioSemFim = 0;
  const vistosDesvio = new Set();
  for (const d of desvios) {
    const ini = msParede(d.inicio);
    if (ini == null) continue;
    let fim = msParede(d.fim);
    let aberto = false;
    if (fim == null) {
      // Parada em aberto: hoje vai até agora; em dia passado não se inventa fim.
      if (!ehHoje) { desvioSemFim++; continue; }
      fim = agoraMs; aberto = true;
    }
    const k = `${ini}|${d.motivo || ''}`;
    if (vistosDesvio.has(k)) continue;     // tabela + ao vivo não duplicam
    vistosDesvio.add(k);
    desvio.push({ ini, fim: Math.max(ini, fim), motivo: d.motivo || '', responsavel: d.responsavel || '', aberto });
  }
  const fDesvio = desvio.filter(dentro).map(recorta).sort((a, b) => a.ini - b.ini);

  const paraMin = arr => arr.map(i => ({ ...i, ini: min(i.ini), fim: min(i.fim) }));
  const totalMin = arr => Math.round(_soma(arr) / MS_MIN);

  return {
    dia,
    faixas: {
      escala:       paraMin(fEscala),
      sessao:       paraMin(fSessao),
      desvio:       paraMin(fDesvio),
      deslocamento: paraMin(fDesloc.sort((a, b) => a.ini - b.ini)),
      servico:      paraMin(fServ.sort((a, b) => a.ini - b.ini)),
    },
    totaisMin: {
      escala: totalMin(fEscala), sessao: totalMin(fSessao), desvio: totalMin(fDesvio),
      deslocamento: totalMin(fDesloc), servico: totalMin(fServ),
    },
    interrupcoes: interrupcoes
      .filter(i => i.instanteMs != null && i.instanteMs >= base && i.instanteMs < limite)
      .map(i => ({ noteId: i.note_id, numero: i.numero || '', motivo: i.motivo || '', min: min(i.instanteMs) }))
      .sort((a, b) => a.min - b.min),
    folgas: [...folgas],
    agoraMin: ehHoje ? min(agoraMs) : null,
    avisos: { semHorario, servicoSemFim, desvioSemFim },
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

// Ordem importa: a primeira lista em que a nota aparece define o status
// (mesma ordem que o rotinaEquipe usava ao ler o `data` inteiro).
const STATUS_SNAPSHOT = [
  ['notasConcluidas', 'concluida'], ['notasRejeitadas', 'rejeitada'],
  ['notasExecutadas', 'executada'], ['notasBaixadas', 'baixada'],
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * FUNÇÃO PURA (testável): as notas do dia de UMA equipe.
 * Último snapshot (já na ordem de STATUS_SNAPSHOT) + rejeitadas persistidas +
 * interrompidas. Rejeitada > concluída (decisão 20/07/2026).
 */
function notasDoDia(snapNotas = [], rejRows = [], intRows = []) {
  const notasMap = new Map();
  for (const n of snapNotas) {
    if (n && n.id && !notasMap.has(n.id)) {
      notasMap.set(n.id, { id: n.id, numero: n.numero || '', tipo: n.tipo || '', status: n.status });
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
  return notasMap;
}

/** Agrupa linhas `{team, ...}` por equipe. */
function _porEquipe(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.team)) m.set(r.team, []);
    m.get(r.team).push(r);
  }
  return m;
}

/**
 * Carrega e monta a rotina de VÁRIAS equipes num dia. Pedido do José em
 * 15/10/2026 (Plano Diário do eOrder: todas as equipes de uma vez).
 *
 * UMA consulta por fonte, todas com `team = ANY($n)` — nada de N+1 por equipe.
 * A VM tem 3,8 GB: do snapshot sai só id/número/tipo das 4 listas de notas
 * (desmontadas no Postgres, o `data` inteiro nunca vem pro Node), e do
 * note_details só `payload->'checkpoints'` das notas do dia.
 *
 * @returns {Promise<Map<string, object>>} team → {team, ...rotina, carteira}
 *          + `erros` (comum a todas: a fonte que falha, falha pra todas).
 */
async function _carregarLote(pool, dia, equipes, agora, { aoVivo = null } = {}) {
  const siglas = [...new Set(equipes.map(t => String(t).trim().toUpperCase()).filter(Boolean))];
  const erros = [];
  if (!siglas.length) return { porEquipe: new Map(), erros };

  const [escalas, sesRows, snapRows, rejRows, intRows, cartRows, desvRows] = await Promise.all([
    _talvez(pool,
      `SELECT DISTINCT upper(btrim(ed.equipe)) AS team, ed.codigo_escala, ec.inicio_escala, ec.fim_escala
         FROM public.escala_dia ed
         LEFT JOIN public.escalas_catalogo ec
           ON ec.codigo = ed.codigo_escala AND ec.sector_id = ed.sector_id
        WHERE ed.data = $1::date AND upper(btrim(ed.equipe)) = ANY($2::text[])`,
      [dia, siglas], 'escala', erros),
    // Mesma leitura de sessão da medição de HE (heQueries.medicaoHe): +1 dia de
    // lookahead pro logoff depois da meia-noite, e COALESCE porque o job de
    // logoff das 03:00 só atualiza o jsonb. O DISTINCT ON roda só nas colunas
    // estreitas; o jsonb é lido apenas da linha escolhida de cada sessão.
    _talvez(pool,
      `WITH ult AS (
         SELECT DISTINCT ON (upper(btrim(team_name)), session_begin)
                id, upper(btrim(team_name)) AS team, session_begin, session_end
           FROM public.snapshots
          WHERE upper(btrim(team_name)) = ANY($1::text[])
            AND date BETWEEN $2::date AND $3::date
            AND session_begin IS NOT NULL
          ORDER BY upper(btrim(team_name)), session_begin, captured_at DESC
       )
       SELECT u.team, u.session_begin, s.data->>'id' AS session_id,
              COALESCE(u.session_end, s.data->>'sessionEnd', s.data->>'session_end') AS session_end
         FROM ult u JOIN public.snapshots s ON s.id = u.id`,
      [siglas, dia, _diaMais(dia, 1)], 'sessao', erros),
    _talvez(pool,
      `WITH ult AS (
         SELECT DISTINCT ON (upper(btrim(team_name))) id, upper(btrim(team_name)) AS team
           FROM public.snapshots
          WHERE date = $1::date AND upper(btrim(team_name)) = ANY($2::text[])
          ORDER BY upper(btrim(team_name)), captured_at DESC
       )
       SELECT u.team, k.status, nota->>'id' AS id,
              COALESCE(NULLIF(nota->>'numero', ''), nota->>'number', '') AS numero,
              COALESCE(NULLIF(nota->>'tipo', ''), nota->>'type', '') AS tipo
         FROM ult u
         JOIN public.snapshots s ON s.id = u.id
         CROSS JOIN (VALUES ${STATUS_SNAPSHOT.map(([k, s], i) => `(${i + 1}, '${k}', '${s}')`).join(', ')})
              AS k(ord, chave, status)
         CROSS JOIN LATERAL jsonb_array_elements(
              CASE WHEN jsonb_typeof(s.data->k.chave) = 'array' THEN s.data->k.chave ELSE '[]'::jsonb END) AS n(nota)
        WHERE nota->>'id' IS NOT NULL
        ORDER BY u.team, k.ord`,
      [dia, siglas], 'snapshot', erros),
    // Rejeitadas somem do payload horas depois (WPA limpa) — note_rejections
    // é a memória persistente, mesma regra de upsertTeamDailyCarteira.
    _talvez(pool,
      `SELECT DISTINCT upper(btrim(team_name)) AS team, note_id::text AS note_id, numero, tipo
         FROM public.note_rejections
        WHERE upper(btrim(team_name)) = ANY($1::text[]) AND session_date = $2::date`,
      [siglas, dia], 'rejeicoes', erros),
    _talvez(pool,
      `SELECT upper(btrim(team_name)) AS team, note_id::text AS note_id, numero, tipo, instante, motivo
         FROM public.note_interrupcoes
        WHERE upper(btrim(team_name)) = ANY($1::text[]) AND dia = $2::date`,
      [siglas, dia], 'interrupcoes', erros),
    _talvez(pool,
      `SELECT upper(btrim(team_name)) AS team, *
         FROM public.team_daily_carteira
        WHERE upper(btrim(team_name)) = ANY($1::text[]) AND date = $2::date`,
      [siglas, dia], 'carteira', erros),
    // Desvios = paradas apontadas na sessão. `data` é o dia do BeginTime da
    // sessão (cronService.runSyncIntervalos) — o mesmo critério das sessões aqui.
    // `AT TIME ZONE 'UTC'` desfaz o 'Z' falso do coletor (ver ⚠️ FUSO no topo).
    _talvez(pool,
      `SELECT upper(btrim(equipe)) AS team, session_id, motivo, responsavel,
              to_char(inicio AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS inicio,
              to_char(fim    AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS fim
         FROM public.sessao_intervalo
        WHERE data = $1::date AND upper(btrim(equipe)) = ANY($2::text[])`,
      [dia, siglas], 'desvios', erros),
  ]);

  const escPor = _porEquipe(escalas), sesPor = _porEquipe(sesRows), snapPor = _porEquipe(snapRows);
  const rejPor = _porEquipe(rejRows), intPor = _porEquipe(intRows), cartPor = _porEquipe(cartRows);
  const desvPor = _porEquipe(desvRows);

  // Hoje a tabela ainda não tem as paradas (sync 03:10 de D+1). Só a tela de
  // UMA equipe pede ao vivo — no Plano Diário seriam ~140 GETs por abertura.
  if (aoVivo) {
    for (const t of siglas) {
      if ((desvPor.get(t) || []).length) continue;
      const ids = [...new Set((sesPor.get(t) || [])
        .filter(r => String(r.session_begin).slice(0, 10) === dia && r.session_id)
        .map(r => r.session_id))];
      const vivos = [];
      for (const id of ids) {
        try { vivos.push(...(await aoVivo(id))); }
        catch (err) { erros.push(`desvios ao vivo: ${err.message}`); }
      }
      if (vivos.length) desvPor.set(t, vivos);
    }
  }

  const notasPor = new Map();
  for (const t of siglas) notasPor.set(t, notasDoDia(snapPor.get(t), rejPor.get(t), intPor.get(t)));

  // Checkpoints de TODAS as notas do dia numa consulta só. `note_id = ANY(uuid[])`
  // usa a PK; id que não é UUID (payload estranho) não derruba a consulta.
  const ids = [...new Set([...notasPor.values()].flatMap(m => [...m.keys()]))]
    .filter(id => UUID_RE.test(String(id)));
  const det = ids.length ? await _talvez(pool,
    `SELECT note_id::text AS note_id, numero, tipo, payload->'checkpoints' AS checkpoints
       FROM public.note_details WHERE note_id = ANY($1::uuid[])`,
    [ids], 'note_details', erros) : [];
  const detPor = new Map(det.map(d => [String(d.note_id).toLowerCase(), d]));

  const toIso = v => (v instanceof Date ? v.toISOString() : v);
  const agoraMs = msParede(new Date(agora).toISOString());
  const porEquipe = new Map();
  for (const t of siglas) {
    const notasMap = notasPor.get(t);
    for (const n of notasMap.values()) {
      const d = detPor.get(String(n.id).toLowerCase());
      if (!d) continue;
      n.checkpoints = Array.isArray(d.checkpoints) ? d.checkpoints : [];
      if (!n.numero) n.numero = d.numero || '';
      if (!n.tipo) n.tipo = d.tipo || '';
    }
    const ints = intPor.get(t) || [];
    const rotina = montarRotina({
      dia,
      escalas: escPor.get(t) || [],
      sessoes: (sesPor.get(t) || [])
        .filter(r => String(r.session_begin).slice(0, 10) === dia)
        .map(r => ({ begin: r.session_begin, end: r.session_end })),
      notas: [...notasMap.values()],
      interrupcoes: ints.map(r => ({
        note_id: r.note_id, numero: r.numero, motivo: r.motivo,
        instanteMs: msParede(toIso(r.instante)),
      })),
      desvios: desvPor.get(t) || [],
      agoraMs,
    });
    const interrompidas = new Set(ints.map(r => r.note_id)).size;
    porEquipe.set(t, { team: t, ...rotina, carteira: montarCarteira((cartPor.get(t) || [])[0], interrompidas) });
  }
  return { porEquipe, erros };
}

/**
 * FUNÇÃO PURA (testável): break do WPA (normalizado por wpaService) → desvio.
 * O normalizador anexa 'Z' em instante que é PAREDE BRT (P1-48); aqui o 'Z'
 * sai, para ler igual à tabela lida com `AT TIME ZONE 'UTC'`.
 */
function desvioDoBreak(b) {
  const parede = v => (v ? String(v).replace(/(\.\d+)?Z$/i, '') : null);
  return { motivo: b && b.motivo, responsavel: b && b.responsavel,
    inicio: parede(b && b.inicio), fim: parede(b && b.fim) };
}

// Cache curto das paradas ao vivo: a conta WPA é compartilhada (P1-25) e a
// tela pode ser reaberta várias vezes seguidas. 5 min = 1/3 do ciclo do cron.
const _cacheBreaks = new Map();
const CACHE_BREAKS_MS = 5 * 60000;

async function desviosAoVivo(sessionId) {
  if (process.env.DATA_MODE === 'mock') return [];
  const c = _cacheBreaks.get(sessionId);
  if (c && Date.now() - c.em < CACHE_BREAKS_MS) return c.lista;
  const { getSessionBreaks } = require('../services/wpaService');
  const lista = (await getSessionBreaks(sessionId)).map(desvioDoBreak);
  if (_cacheBreaks.size > 500) _cacheBreaks.clear();
  _cacheBreaks.set(sessionId, { em: Date.now(), lista });
  return lista;
}

/**
 * A rotina de uma equipe num dia. Bounded: 1 equipe × 1 dia.
 * Desde 15/10/2026 é o lote com uma equipe só — uma implementação, duas telas.
 */
async function rotinaEquipe(team, dia, agora = Date.now()) {
  const pool = _getPool();
  if (!pool) return null;
  const equipe = String(team).trim().toUpperCase();
  const { dateBRT } = require('../services/timeUtil');
  const aoVivo = dia === dateBRT(agora) ? desviosAoVivo : null;
  const { porEquipe, erros } = await _carregarLote(pool, dia, [equipe], agora, { aoVivo });
  return { ...porEquipe.get(equipe), erros };
}

/**
 * Plano Diário: todas as equipes OFICIAIS ativas das regionais do escopo
 * (`regionais` = req.scope.regionals), opcionalmente recortadas por `teams`
 * (filtro de supervisor da tela). Bounded: equipes do escopo × 1 dia.
 */
async function rotinaEquipes(dia, regionais, { teams = null, agora = Date.now() } = {}) {
  const pool = _getPool();
  if (!pool) return null;
  const params = [];
  const regClause = inRegionalsSql(regionais, params);
  const { rows: eqs } = await pool.query(
    `SELECT upper(btrim(sigla)) AS sigla, regional, tipo
       FROM public.equipes_oficiais
      WHERE ativo = true AND ${regClause}
      ORDER BY regional, sigla`, params);
  const filtro = Array.isArray(teams) && teams.length
    ? new Set(teams.map(t => String(t).trim().toUpperCase())) : null;
  const lista = eqs.filter(e => !filtro || filtro.has(e.sigla));

  const { porEquipe, erros } = await _carregarLote(pool, dia, lista.map(e => e.sigla), agora);
  return {
    dia,
    equipes: lista.map(e => ({ ...porEquipe.get(e.sigla), regional: e.regional, tipo: e.tipo })),
    erros,
  };
}

module.exports = {
  rotinaEquipe, rotinaEquipes,
  // Puras, exportadas pra teste.
  instanteCp, intervalosDaNota, unir, montarRotina, montarCarteira, notasDoDia, desvioDoBreak,
};
