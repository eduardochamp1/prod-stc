/**
 * db/poReparoQueries.js
 *
 * Fase 1 de docs/handoff/SPEC-tma-po-reparo-2026-08-30.md.
 *
 * Nas notas **PO**, a distância entre o **"Horário do Reparo"** apontado pela
 * equipe e o checkpoint **"Finalizando Trabalho"**. Critério da operação: no
 * mínimo **10 minutos**. Abaixo disso indica problema no método de apontamento —
 * e esses minutos entram no CHI do CSD atendido.
 *
 * ⚠️ NÃO confundir com o TMA regulatório (emissão → conclusão). A sub-aba se
 * chama "TMA (PO)" por decisão do José, mas mede outra coisa; a spec cancelada
 * do TMA de verdade é SPEC-subaba-tma-2026-08-29-CANCELADA.md.
 *
 * ── AS DUAS PONTAS ──────────────────────────────────────────────────────────
 *   Horário do Reparo    → /api/notes/po → PowerOnExecution.RepairTime
 *                          UTC, com "+00:00" explícito
 *   Finalizando Trabalho → checkpoint com Event === 4, campo RegisteredAt2
 *                          local, com "-03:00" explícito
 *
 * ⚠️⚠️ A ARMADILHA DESTE ARQUIVO É O FUSO. Medido com os valores reais da nota
 * 104875481 (RepairTime 20:18:45+00:00, evento 4 às 17:25:47-03:00):
 *
 *   TZ=America/Sao_Paulo   RegisteredAt2 → +7,03 min   RegisteredAt → +7,03 min
 *   TZ=UTC   (a VM)        RegisteredAt2 → +7,03 min   RegisteredAt → −172,97 min
 *
 * Usar `RegisteredAt` (sem o 2) FUNCIONA na máquina do dev e QUEBRA em produção,
 * com 3h de erro que ainda inverte o sinal — viraria "reparo 3h depois do fim do
 * trabalho", absurdo plausível o bastante pra passar por anomalia de campo em vez
 * de bug. Por isso aqui só entra `registradoEm` (que é o RegisteredAt2), e nota
 * sem ele NÃO É MEDIDA — nunca estimada.
 */

const { _getPool } = require('../services/pgShim');

/** Código de evento do checkpoint "Finalizando Trabalho" (conferido no portal). */
const EVENT_FINALIZANDO = 4;

/** Critério da operação, em segundos. */
const MINIMO_SEG = 10 * 60;

/**
 * FUNÇÃO PURA (testável): instante do "Finalizando Trabalho".
 *
 * Só aceita `registradoEm` (RegisteredAt2). Checkpoint sem ele é ignorado — ver
 * a nota de fuso no topo do arquivo.
 *
 * Várias tentativas geram vários event=4; vale o ÚLTIMO, que é o que fecha a
 * execução que terminou na conclusão da nota.
 *
 * @param {Array<{event:number, registradoEm:string}>} checkpoints
 * @returns {string|null} ISO, ou null se não der pra medir
 */
function finalizandoTrabalhoEm(checkpoints) {
  if (!Array.isArray(checkpoints)) return null;
  const instantes = checkpoints
    .filter(cp => cp && Number(cp.event) === EVENT_FINALIZANDO && cp.registradoEm)
    .map(cp => new Date(cp.registradoEm).getTime())
    .filter(n => Number.isFinite(n));
  if (instantes.length === 0) return null;
  return new Date(Math.max(...instantes)).toISOString();
}

/**
 * FUNÇÃO PURA (testável): monta a linha de `note_po_reparo`.
 *
 * `delta_seg` fica NULL quando falta qualquer uma das pontas. Não zera, não
 * estima: "não medido" e "medido em zero" são coisas diferentes, e a tela conta
 * as duas separado (a cobertura vive disso).
 *
 * Delta NEGATIVO é preservado de propósito — reparo apontado DEPOIS do fim do
 * trabalho é fisicamente impossível e é justamente o caso mais acionável. Foram
 * 6 em 158 na amostra de 30/08/2026, chegando a −42 minutos.
 *
 * @param {object} poExec       saída de wpaService.getNotePoExecution
 * @param {Array}  checkpoints  checkpoints JÁ PROCESSADOS (com `registradoEm`)
 */
function montarLinhaReparo(poExec, checkpoints) {
  const finalizando = finalizandoTrabalhoEm(checkpoints);
  const po = poExec || {};

  const tReparo = po.repairTime ? new Date(po.repairTime).getTime() : NaN;
  const tFim    = finalizando   ? new Date(finalizando).getTime()   : NaN;
  const mensuravel = Number.isFinite(tReparo) && Number.isFinite(tFim);

  return {
    repair_time:       po.repairTime || null,
    has_repair:        po.hasRepair === undefined ? null : po.hasRepair,
    finalizando_em:    finalizando,
    delta_seg:         mensuravel ? Math.round((tFim - tReparo) / 1000) : null,
    prediction_repair: po.predictionRepair || null,
    confirmation_date: po.confirmationDate || null,
    classe:            po.classe || null,
    causa:             po.causa  || null,
    clima:             po.clima  || null,
    team_id:           po.teamId || null,
  };
}

/** Classifica um delta em segundos. Fronteiras conferem com as faixas da tela. */
function faixaDoDelta(deltaSeg) {
  if (deltaSeg == null || !Number.isFinite(deltaSeg)) return 'nao_medido';
  if (deltaSeg < 0) return 'negativo';
  if (deltaSeg < MINIMO_SEG) return 'abaixo';
  return 'ok';
}

/**
 * Grava (ou atualiza) a linha da nota. Idempotente por `note_id`: o cron pode
 * reprocessar a mesma nota sem duplicar, como todo upsert deste projeto.
 */
async function upsertPoReparo(noteId, { numero, sector_id }, linha) {
  if (!noteId) return;
  const pool = _getPool();
  await pool.query(
    `INSERT INTO public.note_po_reparo
       (note_id, numero, sector_id, team_id, repair_time, has_repair,
        finalizando_em, delta_seg, prediction_repair, confirmation_date,
        classe, causa, clima, atualizado_em)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
     ON CONFLICT (note_id) DO UPDATE SET
       numero            = EXCLUDED.numero,
       sector_id         = EXCLUDED.sector_id,
       team_id           = EXCLUDED.team_id,
       repair_time       = EXCLUDED.repair_time,
       has_repair        = EXCLUDED.has_repair,
       finalizando_em    = EXCLUDED.finalizando_em,
       delta_seg         = EXCLUDED.delta_seg,
       prediction_repair = EXCLUDED.prediction_repair,
       confirmation_date = EXCLUDED.confirmation_date,
       classe            = EXCLUDED.classe,
       causa             = EXCLUDED.causa,
       clima             = EXCLUDED.clima,
       atualizado_em     = now()`,
    [noteId, numero || null, sector_id || null, linha.team_id,
     linha.repair_time, linha.has_repair, linha.finalizando_em, linha.delta_seg,
     linha.prediction_repair, linha.confirmation_date,
     linha.classe, linha.causa, linha.clima],
  );
}

// ── Fase 2 — leitura agregada ────────────────────────────────────────────────

const REGIONAL_PARA_SETORES = { GUA: ['DESG', 'DEPT'], CAC: ['DESC'], SJC: ['DSSJ'] };

/**
 * Faixas da tela. Fronteiras fechadas à esquerda e abertas à direita, sem buraco
 * nem sobreposição — o teste cobre cada divisa.
 */
const FAIXAS = [
  { chave: 'negativo',  rotulo: 'negativo (reparo DEPOIS)', de: -Infinity, ate: 0 },
  { chave: '0_2',       rotulo: '0 a 2 min',                de: 0,         ate: 120 },
  { chave: '2_5',       rotulo: '2 a 5 min',                de: 120,       ate: 300 },
  { chave: '5_10',      rotulo: '5 a 10 min',               de: 300,       ate: 600 },
  { chave: '10_30',     rotulo: '10 a 30 min',              de: 600,       ate: 1800 },
  { chave: '30_60',     rotulo: '30 a 60 min',              de: 1800,      ate: 3600 },
  { chave: '60_mais',   rotulo: '60 min ou mais',           de: 3600,      ate: Infinity },
];

/**
 * Chave da faixa FINA (as sete da tela), pro filtro de desvio.
 * Devolve null quando não é mensurável — nota sem delta não pertence a faixa
 * nenhuma, e forçá-la numa faria a soma do histograma parar de fechar.
 */
function faixaFinaDoDelta(deltaSeg) {
  if (deltaSeg == null || !Number.isFinite(Number(deltaSeg))) return null;
  const d = Number(deltaSeg);
  const f = FAIXAS.find(x => d >= x.de && d < x.ate);
  return f ? f.chave : null;
}

/** Piso de notas medidas pra uma equipe entrar no ranking por PERCENTUAL. */
const PISO_RANKING = 10;

/**
 * Limite do "caso grave", em segundos.
 *
 * 30/08/2026 — a primeira versão da tela destacava os 66,6% abaixo do critério,
 * e isso não priorizava nada: com dois terços da base violando, a tela dizia
 * "está tudo errado" e não "comece por estes".
 *
 * O corte em 2 minutos separa dois problemas que são qualitativamente
 * diferentes e estavam somados no mesmo número:
 *
 *   - nota com 8 min → apontamento impreciso, discutível, zona cinzenta;
 *   - nota com 30 segundos, ou com o reparo DEPOIS do fim do trabalho → o
 *     horário não descreve nada do que aconteceu. Indefensável.
 *
 * Negativo entra aqui por construção (todo negativo é < 120). Medido na base
 * completa de agosto: 620 de 1.808 medidas, 34,3%.
 */
const GRAVE_SEG = 120;

/** Segunda-feira da semana de um instante ISO — chave da série semanal. */
function inicioDaSemana(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const dia = d.getUTCDay();                 // 0=dom
  const recuo = (dia === 0 ? 6 : dia - 1);   // segunda = início
  const seg = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - recuo));
  return seg.toISOString().slice(0, 10);
}

function _percentil(ordenado, p) {
  if (!ordenado.length) return null;
  const i = Math.min(ordenado.length - 1, Math.floor((p / 100) * ordenado.length));
  return ordenado[i];
}

const _min1 = seg => (seg == null ? null : Math.round(seg / 6) / 10);   // seg → min, 1 casa

/**
 * FUNÇÃO PURA (testável): agrega as linhas no contrato que a tela consome.
 *
 * Recebe as linhas já filtradas por período/regional e o mapa note_id→equipe.
 * Toda a estatística acontece aqui, sem banco — é o que permite testar as
 * fronteiras de faixa e o piso do ranking sem subir Postgres.
 *
 * ⚠️ Os percentuais do indicador são sobre as MEDIDAS, não sobre o total. Nota
 * sem `delta_seg` não é violação nem cumprimento: é ausência de dado, e vive na
 * cobertura. Misturar as duas contas foi o erro que esta spec evita por decisão
 * (D5) — com 28,2% sem RepairTime na base, a diferença é enorme.
 */
function agregarPoReparo(linhas, mapaEquipe) {
  const rows = Array.isArray(linhas) ? linhas : [];
  const medidas = rows.filter(r => r.delta_seg != null && Number.isFinite(Number(r.delta_seg)));
  const deltas  = medidas.map(r => Number(r.delta_seg)).sort((a, b) => a - b);

  const cobertura = {
    total:            rows.length,
    medidas:          medidas.length,
    cobertura_pct:    rows.length ? +(100 * medidas.length / rows.length).toFixed(1) : 0,
    sem_repair_time:  rows.filter(r => !r.repair_time).length,
    has_repair_false: rows.filter(r => r.has_repair === false).length,
  };

  const abaixo = deltas.filter(d => d < MINIMO_SEG).length;
  const graves = deltas.filter(d => d < GRAVE_SEG).length;
  const resumo = {
    mediana_min:    _min1(_percentil(deltas, 50)),
    p10_min:        _min1(_percentil(deltas, 10)),
    p90_min:        _min1(_percentil(deltas, 90)),
    min_min:        _min1(deltas[0] ?? null),
    max_min:        _min1(deltas[deltas.length - 1] ?? null),
    abaixo:         abaixo,
    abaixo_pct:     medidas.length ? +(100 * abaixo / medidas.length).toFixed(1) : 0,
    // O número que a tela destaca: o subconjunto indefensável. Ver GRAVE_SEG.
    graves:         graves,
    graves_pct:     medidas.length ? +(100 * graves / medidas.length).toFixed(1) : 0,
    negativos:      deltas.filter(d => d < 0).length,
    minimo_min:     MINIMO_SEG / 60,
    grave_min:      GRAVE_SEG / 60,
  };

  // Três grupos pra barra empilhada. Sete faixas soltas faziam o olho não somar:
  // as ruins ficavam quebradas em quatro barras e as boas em três, e a maior
  // barra da tela era verde — a primeira leitura saía invertida.
  const grupos = [
    { chave: 'graves',   rotulo: `Graves (< ${GRAVE_SEG / 60} min ou negativo)`,
      quantidade: graves, cor: '#c0392b' },
    { chave: 'cinzenta', rotulo: `${GRAVE_SEG / 60} a ${MINIMO_SEG / 60} min`,
      quantidade: abaixo - graves, cor: '#e67e22' },
    { chave: 'ok',       rotulo: `${MINIMO_SEG / 60} min ou mais`,
      quantidade: medidas.length - abaixo, cor: '#27ae60' },
  ].map(g => ({ ...g, pct: medidas.length ? +(100 * g.quantidade / medidas.length).toFixed(1) : 0 }));

  const faixas = FAIXAS.map(f => {
    const q = deltas.filter(d => d >= f.de && d < f.ate).length;
    return {
      chave: f.chave, rotulo: f.rotulo, quantidade: q,
      pct: medidas.length ? +(100 * q / medidas.length).toFixed(1) : 0,
    };
  });

  // ── série diária, com continuidade de calendário ──────────────────────────
  const porDiaMap = new Map();
  for (const r of medidas) {
    if (!r.finalizando_em) continue;
    const dia = new Date(r.finalizando_em).toISOString().slice(0, 10);
    if (!porDiaMap.has(dia)) porDiaMap.set(dia, []);
    porDiaMap.get(dia).push(Number(r.delta_seg));
  }
  const porDia = [...porDiaMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([data, ds]) => {
      const ord = [...ds].sort((a, b) => a - b);
      const ab = ord.filter(d => d < MINIMO_SEG).length;
      return {
        data,
        total: ord.length,
        mediana_min: _min1(_percentil(ord, 50)),
        abaixo_pct: +(100 * ab / ord.length).toFixed(1),
      };
    });

  // ── ranking por equipe ────────────────────────────────────────────────────
  // ⚠️ PISO: equipe com 3 notas viraria 100% de violação e lideraria sem
  // significar nada. Quem não alcança o piso NÃO some — vai pra `poucas_notas`,
  // porque desaparecer silenciosamente é pior que aparecer com ressalva.
  const porEquipeMap = new Map();
  for (const r of medidas) {
    const info = mapaEquipe && mapaEquipe.get ? mapaEquipe.get(r.note_id) : null;
    const equipe = (info && info.team_name) || null;
    if (!equipe) continue;
    if (!porEquipeMap.has(equipe)) porEquipeMap.set(equipe, { equipe, regional: info.regional || null, deltas: [] });
    porEquipeMap.get(equipe).deltas.push(Number(r.delta_seg));
  }
  const equipes = [...porEquipeMap.values()].map(e => {
    const ord = [...e.deltas].sort((a, b) => a - b);
    const ab = ord.filter(d => d < MINIMO_SEG).length;
    const gr = ord.filter(d => d < GRAVE_SEG).length;
    return {
      equipe: e.equipe, regional: e.regional, total: ord.length,
      mediana_min: _min1(_percentil(ord, 50)),
      abaixo: ab,
      abaixo_pct: +(100 * ab / ord.length).toFixed(1),
      graves: gr,
      graves_pct: +(100 * gr / ord.length).toFixed(1),
    };
  });
  // 30/08/2026 — ordena por CONTAGEM de casos graves, não por percentual.
  // O ranking por % empatava todo mundo entre 62% e 98% e não priorizava nada:
  // "98,2%" não é uma tarefa, "54 casos" é. E contagem se auto-regula — equipe
  // com 3 notas não consegue ter 54 casos, então não precisa de piso pra não
  // liderar indevidamente (o piso continua valendo pro ranking por %).
  const cmpGraves = (a, b) => b.graves - a.graves || b.graves_pct - a.graves_pct;
  const cmpPct    = (a, b) => b.abaixo_pct - a.abaixo_pct || b.total - a.total;

  return {
    cobertura,
    resumo,
    grupos,
    faixas,
    porDia,
    porSemana:   _agruparPorSemana(medidas),
    // Ordem principal: quem tem mais casos graves pra tratar.
    porEquipe:   [...equipes].sort(cmpGraves),
    // Mantido pra quem quiser a leitura por proporção — aí o piso importa.
    porEquipePct: equipes.filter(e => e.total >= PISO_RANKING).sort(cmpPct),
    poucasNotas: equipes.filter(e => e.total <  PISO_RANKING).sort(cmpPct),
    piso_ranking: PISO_RANKING,
  };
}

/**
 * Série SEMANAL. A diária tinha ruído demais pra responder "a cobrança
 * adiantou?": a mediana pulava de dia pra dia e o último ponto era sempre um
 * dia parcial, que despencava ou disparava sozinho.
 *
 * Semana começa na segunda. Semanas sem nota simplesmente não aparecem — não há
 * o que preencher com zero num indicador que é razão, e um zero falso puxaria a
 * curva pra baixo como se o apontamento tivesse piorado.
 */
function _agruparPorSemana(medidas) {
  const mapa = new Map();
  for (const r of medidas) {
    if (!r.finalizando_em) continue;
    const semana = inicioDaSemana(r.finalizando_em);
    if (!semana) continue;
    if (!mapa.has(semana)) mapa.set(semana, []);
    mapa.get(semana).push(Number(r.delta_seg));
  }
  return [...mapa.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([semana, ds]) => {
    const ord = [...ds].sort((a, b) => a - b);
    const ab = ord.filter(d => d < MINIMO_SEG).length;
    const gr = ord.filter(d => d < GRAVE_SEG).length;
    const fim = new Date(semana);
    fim.setUTCDate(fim.getUTCDate() + 6);
    return {
      semana,
      rotulo: `${semana.slice(8)}/${semana.slice(5, 7)}`,
      ate: fim.toISOString().slice(0, 10),
      total: ord.length,
      mediana_min: _min1(_percentil(ord, 50)),
      abaixo_pct: +(100 * ab / ord.length).toFixed(1),
      graves_pct: +(100 * gr / ord.length).toFixed(1),
    };
  });
}

/** Traduz regionais (GUA/CAC/SJC) nos setores que a tabela guarda. */
function setoresDasRegionais(regionais) {
  if (!Array.isArray(regionais) || regionais.length === 0) return null;
  const out = [];
  for (const r of regionais) for (const s of (REGIONAL_PARA_SETORES[r] || [])) out.push(s);
  return out.length ? out : null;
}

/**
 * Lê as linhas do período e devolve o agregado pronto pra tela.
 *
 * Recorte por `finalizando_em` (D8): é o evento medido, e faltou em só 4 de
 * 8.402 notas. A conclusão da nota seria consistente com o resto do painel, mas
 * some quando a nota não fecha — e aí o caso mais suspeito sairia do gráfico.
 */
async function resumoPoReparo(de, ate, opts = {}) {
  const pool = _getPool();
  const params = [de, ate];
  let where = `finalizando_em >= $1::date AND finalizando_em < ($2::date + interval '1 day')`;

  const setores = setoresDasRegionais(opts.regionais);
  if (setores) {
    const ph = setores.map(s => { params.push(s); return `$${params.length}`; });
    where += ` AND sector_id IN (${ph.join(', ')})`;
  }

  const { rows: brutas } = await pool.query(
    `SELECT note_id, numero, sector_id, repair_time, has_repair,
            finalizando_em, delta_seg
       FROM public.note_po_reparo
      WHERE ${where}`, params);

  // Equipe vem do mesmo mapa que a aba Deslocamento usa — ver a nota do export
  // em deslocamentosQueries.js. Se falhar, o indicador ainda sai; só o ranking
  // fica vazio. Número na tela não pode depender de uma consulta acessória.
  let mapaEquipe = null;
  try {
    const { _mapaEquipeDoPeriodo } = require('./deslocamentosQueries');
    mapaEquipe = await _mapaEquipeDoPeriodo(de, ate, opts);
  } catch (err) {
    console.warn('[po-reparo] mapa de equipe falhou — ranking sai vazio:', err.message);
  }

  // ── Filtro de EQUIPE ──────────────────────────────────────────────────────
  // Aplicado aqui, não no SQL: a tabela guarda o UUID da equipe (ExecutedById),
  // e a sigla só existe no mapa de snapshots. Filtra ANTES de agregar, então
  // cartões, distribuição, tendência e ranking passam a falar só das equipes
  // escolhidas — que é o que "filtrar" tem de significar.
  const equipeDe = id => ((mapaEquipe && mapaEquipe.get(id)) || {});
  const teams = Array.isArray(opts.teams) && opts.teams.length ? new Set(opts.teams) : null;
  const rows = teams
    ? brutas.filter(r => teams.has(equipeDe(r.note_id).team_name))
    : brutas;

  const agregado = agregarPoReparo(rows, mapaEquipe);

  // ── Filtro de FAIXA — só na TABELA ────────────────────────────────────────
  // De propósito: filtrar a distribuição pela própria faixa a tornaria 100%
  // daquela faixa, e os cartões deixariam de descrever a operação. A faixa é
  // drill-down — "me mostre os casos DESTE tipo" —, não recorte do indicador.
  const faixas = Array.isArray(opts.faixas) && opts.faixas.length ? new Set(opts.faixas) : null;
  const casos = rows.filter(r => {
    const chave = faixaFinaDoDelta(r.delta_seg);
    if (!chave) return false;
    // Sem filtro, o padrão continua sendo o que precisa de ação: abaixo do critério.
    return faixas ? faixas.has(chave) : Number(r.delta_seg) < MINIMO_SEG;
  });

  agregado.casos = casos
    .sort((a, b) => Number(a.delta_seg) - Number(b.delta_seg))
    .slice(0, 1000)
    .map(r => ({
      numero: r.numero,
      delta_min: _min1(Number(r.delta_seg)),
      delta_seg: Number(r.delta_seg),
      faixa: faixaFinaDoDelta(r.delta_seg),
      // Os DOIS apontamentos, pra tabela poder mostrar o que a equipe registrou
      // em cada ponta — sem isso o usuário vê a diferença e não vê de onde veio.
      finalizando_em: r.finalizando_em,
      repair_time: r.repair_time,
      equipe: equipeDe(r.note_id).team_name || null,
      regional: equipeDe(r.note_id).regional || null,
    }));
  agregado.casos_total = casos.length;

  agregado.periodo = { de, ate };
  return agregado;
}

// Cache 5min + single-flight, no mesmo molde dos deslocamentos.
const _memo = require('../services/memoCache').create({ ttlMs: 5 * 60 * 1000, name: 'po-reparo' });
const resumoPoReparoCached = _memo.wrap(resumoPoReparo, (de, ate, opts) => JSON.stringify({
  de, ate,
  regionais: Array.isArray(opts && opts.regionais) ? [...opts.regionais].sort() : null,
  // teams e faixas ENTRAM na chave: sem isso o cache devolveria o resultado de
  // um filtro pro outro, e o usuário veria número de outra equipe.
  teams:     Array.isArray(opts && opts.teams)     ? [...opts.teams].sort()     : null,
  faixas:    Array.isArray(opts && opts.faixas)    ? [...opts.faixas].sort()    : null,
}));

module.exports = {
  upsertPoReparo,
  resumoPoReparo: resumoPoReparoCached,
  _resumoPoReparoRaw: resumoPoReparo,
  // Puras, exportadas pra teste — é onde mora a regra que pode errar 3 horas.
  finalizandoTrabalhoEm,
  montarLinhaReparo,
  faixaDoDelta,
  faixaFinaDoDelta,
  agregarPoReparo,
  setoresDasRegionais,
  inicioDaSemana,
  FAIXAS,
  PISO_RANKING,
  GRAVE_SEG,
  EVENT_FINALIZANDO,
  MINIMO_SEG,
};
