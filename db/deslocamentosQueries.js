/**
 * db/deslocamentosQueries.js
 *
 * Análise dos deslocamentos das equipes a partir dos checkpoints
 * (`note_details.payload.checkpoints[]`).
 *
 * MAPEAMENTO DOS EVENTOS (descoberto via SQL):
 *   event 0 → Início do Deslocamento  (saída)
 *   event 1 → Fim do Deslocamento     (chegada)
 *   event 2 → Início do Trabalho
 *   event 3 → Fim do Trabalho
 *   event 4 → Interrupção/pausa
 *
 * MÚLTIPLAS TENTATIVAS:
 *   Uma mesma nota pode ter 1, 2 ou 3 deslocamentos (cada tentativa de
 *   execução tem seu par 0→1). Detectamos pelas SEQUÊNCIAS na timeline:
 *   cada vez que aparece event=0, começa uma nova tentativa.
 *
 * REGRA DE NEGÓCIO (definida pelo cliente):
 *   - tempo_real = t(event=1) - t(event=0) por tentativa
 *   - tempo_osrm = duration estimado pelo OSRM (rota dirigindo)
 *   - desvio_pct = ((tempo_real - tempo_osrm) / tempo_osrm) * 100
 *   - threshold = 1.5x (>= 150% do OSRM → vermelho)
 *
 * IMPORTANTE: o "dia" do deslocamento usa o timestamp do event=0
 * (não a sessionDate da nota), porque tentativas podem cruzar dias.
 */

const { _getPool } = require('../services/pgShim');
const { getClient } = require('../services/dbClient');
const { getRoute }  = require('../services/osrmService');
const { inRegionalsSql } = require('../services/regionals');

// ── helper: extrai deslocamentos de um payload.checkpoints[] ─────────────────

/**
 * Dado o array de checkpoints de UMA nota, retorna lista de deslocamentos:
 *   [{ tentativa: 1, origem: {lat,lng,ts}, destino: {lat,lng,ts}, tempo_real_sec }, ...]
 *
 * Algoritmo:
 *   Itera em ordem cronológica. Cada event=0 começa uma tentativa.
 *   O próximo event=1 da MESMA tentativa fecha o par.
 *   Se aparecer outro event=0 antes do event=1, descarta o anterior
 *   (raro — equipe cancelou e recomeçou).
 */
function extrairDeslocamentos(checkpoints) {
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) return [];

  // Ordena por timestamp (defensivo — geralmente já vem ordenado)
  const ordered = [...checkpoints].sort((a, b) =>
    String(a.timestamp || '').localeCompare(String(b.timestamp || ''))
  );

  const out = [];
  let aberto = null;
  let tentativaCount = 0;

  for (const cp of ordered) {
    if (cp.event === 0) {
      // Novo início — se tinha um anterior pendente, descarta
      aberto = {
        origem: { lat: cp.latitude, lng: cp.longitude, ts: cp.timestamp },
      };
    } else if (cp.event === 1 && aberto) {
      // Fechamento — par válido
      tentativaCount++;
      const oTs = new Date(aberto.origem.ts);
      const dTs = new Date(cp.timestamp);
      const tempo_real_sec = Math.max(0, Math.round((dTs - oTs) / 1000));
      out.push({
        tentativa:      tentativaCount,
        origem:         aberto.origem,
        destino:        { lat: cp.latitude, lng: cp.longitude, ts: cp.timestamp },
        tempo_real_sec,
      });
      aberto = null;
    }
    // events 2, 3, 4 ignorados (não fazem parte do deslocamento)
  }
  return out;
}

// ── Leitura agregada ─────────────────────────────────────────────────────────

/**
 * Lista todos os deslocamentos de notas no período/filtros.
 * Para cada par origem→destino, anexa estimativa OSRM (cache-aware).
 *
 * @param {string} de       'YYYY-MM-DD'
 * @param {string} ate      'YYYY-MM-DD'
 * @param {object} opts     { regional, team_name, tipo, limit }
 * @returns {Promise<Array>} cada item:
 *   { note_id, numero, tipo, team_name, regional, tentativa, origem, destino,
 *     tempo_real_sec, tempo_osrm_sec, distancia_m, desvio_pct, status }
 *   status ∈ 'ok' | 'lento' (> 1.5x) | 'sem_osrm' (consulta falhou)
 */
// Threshold (fator multiplicador) acima do qual um deslocamento é "lento".
// Configurável via app_settings 'desloc-threshold' = { fator: 1.5 }.
// Default 1.5 (real > 1.5× tempo Maps → vermelho). Cache leve de 60s.
const _thrCache = { fator: null, ts: 0 };
async function getThreshold() {
  if (_thrCache.fator !== null && (Date.now() - _thrCache.ts) < 60000) {
    return _thrCache.fator;
  }
  let fator = 1.5;
  try {
    const sb = getClient();
    const { data } = await sb.from('app_settings')
      .select('data').eq('key', 'desloc-threshold').maybeSingle();
    const f = data && data.data && Number(data.data.fator);
    if (f && isFinite(f) && f > 1) fator = f;
  } catch (_) { /* usa default */ }
  _thrCache.fator = fator;
  _thrCache.ts = Date.now();
  return fator;
}

/** Atualiza o cache na hora (chamado após PUT) pra refletir imediato. */
function setThresholdCache(fator) {
  const f = Number(fator);
  if (f && isFinite(f) && f > 1) {
    _thrCache.fator = f;
    _thrCache.ts = Date.now();
  }
}

// 21/08/2026 — aba Deslocamento "sempre demora muito" (reportado pelo usuario).
// O front dispara /lista, /ranking e /tendencia em PARALELO com os mesmos filtros
// (public/index.html ~2726), e rankingEquipes/tendenciaDiaria chamavam a versao
// CRUA de listDeslocamentos. Resultado: o pipeline caro rodava TRES vezes
// concorrentes — 3 varreduras completas de note_details com detoast de jsonb,
// 3 explosoes de snapshots, e ate 3 x 20.000 consultas OSRM.
//
// O cache do fim do arquivo NAO cobria isso, apesar de o comentario dele dizer
// que cobria: as chaves sao por funcao (list/rank/tend), entao as tres chamadas
// nunca colidiam e o single-flight nunca era acionado.
//
// Conserto: as duas derivadas passam a chamar a versao CACHEADA da lista, via
// esta referencia tardia (a cacheada so existe no fim do arquivo). Assim as tres
// requisicoes compartilham UM calculo pelo single-flight do memoCache.
let _listCached = null;

async function listDeslocamentos(de, ate, opts = {}) {
  const pool = _getPool();
  const t0 = Date.now();
  const THRESHOLD = await getThreshold();

  // Estratégia em 2 passos (muito mais rápida que JOIN LATERAL):
  //
  // Passo 1: SELECT direto em note_details filtrando por timestamp do primeiro
  //          event=0. Só notas com checkpoint, no período. ~ms.
  // Passo 2: SELECT mapa note_id → {team_name, regional, sector_id} a partir
  //          das snapshots NO PERÍODO (com filtro de regional/team se vier).
  //          Cruza em memória.

  const params = [de, ate];
  const wherePeriodo = `
    (nd.payload->'checkpoints'->0->>'timestamp')::timestamptz >= $1::date
    AND (nd.payload->'checkpoints'->0->>'timestamp')::timestamptz < ($2::date + interval '1 day')
  `;

  // ORDER BY timestamp DESC + LIMIT alto: se algum dia bater no teto, perde os
  // dias mais ANTIGOS (previsível), não dias do meio. Antes era LIMIT 3000 sem
  // ORDER, que truncava por ordem física e fazia dias inteiros sumirem do meio
  // do período (ex: 09/10/11/06 sumiam apesar de terem ~1400 notas).
  const sqlNotas = `
    SELECT
      nd.note_id,
      nd.numero,
      nd.tipo,
      nd.payload->'checkpoints' AS checkpoints,
      (nd.payload->'checkpoints'->0->>'timestamp')::timestamptz AS first_ts
    FROM note_details nd
    WHERE nd.payload->'checkpoints' IS NOT NULL
      AND jsonb_array_length(nd.payload->'checkpoints') >= 2
      AND ${wherePeriodo}
    ORDER BY first_ts DESC
    LIMIT 20000
  `;
  const { rows: rawNotas } = await pool.query(sqlNotas, params);
  const t1 = Date.now();
  console.log(`[deslocamentos] passo 1: ${rawNotas.length} notas com checkpoint em ${t1 - t0}ms`);

  if (rawNotas.length === 0) return { total: 0, returned: 0, rows: [] };

  // Passo 2: mapa note_id → equipe. Lê snapshots no período (filtros aplicados).
  // Como pode ter 60k+ snapshots, restringimos por período pra evitar full scan.
  // Multi-select: aceita opts.teams[] / opts.regionais[] (com fallback singular).
  const params2 = [de, ate];
  let snapWhere = `s.date >= $1 AND s.date <= $2`;
  // Filtro de regional: `opts.regionais` é string[] de siglas reais (GUA/CAC/SJC).
  // Caller (route) é responsável por garantir array — sem fallback singular.
  if (Array.isArray(opts.regionais) && opts.regionais.length > 0) {
    snapWhere += ` AND ${inRegionalsSql(opts.regionais, params2, 's.regional')}`;
  }
  if (Array.isArray(opts.teams) && opts.teams.length > 0) {
    const ph = opts.teams.map(t => { params2.push(t); return `$${params2.length}`; });
    snapWhere += ` AND s.team_name IN (${ph.join(', ')})`;
  } else if (opts.team_name) {
    params2.push(opts.team_name);
    snapWhere += ` AND s.team_name = $${params2.length}`;
  }

  // jsonb_array_elements + extração de id — restringido ao período/filtros
  // pra não escanear 63k linhas. Custo ~ N_snapshots_no_periodo × notas_por_snap.
  const sqlMap = `
    SELECT DISTINCT ON (nota_item->>'id')
      nota_item->>'id'   AS note_id,
      s.team_name,
      s.regional,
      s.sector_id
    FROM snapshots s,
         LATERAL jsonb_array_elements(
           COALESCE(s.data->'notasConcluidas',  '[]'::jsonb) ||
           COALESCE(s.data->'notasRejeitadas',  '[]'::jsonb) ||
           COALESCE(s.data->'notasExecutadas',  '[]'::jsonb) ||
           COALESCE(s.data->'notasBaixadas',    '[]'::jsonb)
         ) AS nota_item
    WHERE ${snapWhere}
      AND nota_item->>'id' IS NOT NULL
  `;
  const { rows: mapaRows } = await pool.query(sqlMap, params2);
  const t2 = Date.now();
  console.log(`[deslocamentos] passo 2: mapa note_id→equipe com ${mapaRows.length} entradas em ${t2 - t1}ms`);

  const mapaTeam = new Map();
  for (const m of mapaRows) {
    mapaTeam.set(m.note_id, { team_name: m.team_name, regional: m.regional, sector_id: m.sector_id });
  }

  // Filtra equipes oficiais (whitelist em equipes_oficiais)
  const { rows: oficRows } = await pool.query(`SELECT sigla FROM equipes_oficiais WHERE ativo = true`);
  const oficiais = new Set(oficRows.map(r => r.sigla));

  // Junta tudo em memória
  const rows = [];
  for (const n of rawNotas) {
    const info = mapaTeam.get(n.note_id);
    if (!info) continue;                                // não tem equipe no período → skip
    if (oficiais.size > 0 && !oficiais.has(info.team_name)) continue;
    if (opts.tipo && n.tipo !== opts.tipo) continue;
    rows.push({
      note_id:    n.note_id,
      numero:     n.numero,
      tipo:       n.tipo,
      checkpoints: n.checkpoints,
      team_name:  info.team_name,
      regional:   info.regional,
      sector_id:  info.sector_id,
    });
  }
  const t3 = Date.now();
  console.log(`[deslocamentos] passo 3: ${rows.length} notas finais após join+filtros em ${t3 - t2}ms`);

  const filtered = rows;

  // Expande cada nota em N deslocamentos (N tentativas)
  const desloc = [];
  for (const n of filtered) {
    const pares = extrairDeslocamentos(n.checkpoints);
    for (const p of pares) {
      desloc.push({
        note_id:     n.note_id,
        numero:      n.numero,
        tipo:        n.tipo,
        team_name:   n.team_name,
        regional:    n.regional,
        sector_id:   n.sector_id,
        tentativa:   p.tentativa,
        origem:      p.origem,
        destino:     p.destino,
        tempo_real_sec: p.tempo_real_sec,
        data:        p.origem.ts.slice(0, 10),
      });
    }
  }

  // Limite antes do OSRM pra não estourar quota
  // Cap maximo do enrichment OSRM. 20k pairs = ~10s na 1a consulta com OSRM
  // paralelizado (chunks de 10) e Worker cacheado. Subiu de 5000 -> 20000 pra
  // cobrir periodos de 15 dias inteiros (tipico ~7k notas * ~1.5 pairs = 10k).
  const LIMIT = Math.min(Math.max(parseInt(opts.limit || 500, 10), 1), 20000);
  const cut = desloc.slice(0, LIMIT);
  console.log(`[deslocamentos] passo 4: ${desloc.length} deslocamentos extraídos, processando ${cut.length} via OSRM...`);
  const tOsrm = Date.now();
  let osrmHits = 0, osrmMisses = 0, osrmFails = 0;

  // Enriquece com OSRM em chunks paralelos. Worker Cloudflare aguenta
  // dezenas de req simultaneas; cache hits sao ~0ms; cache miss ~150ms.
  // Antes era sequencial com throttle 1.1s = 500 pairs * 1.1s = 9min na 1a
  // consulta. Agora chunks de 10 * ~200ms = ~10s na pior hipotese.
  const CHUNK = 10;
  for (let i = 0; i < cut.length; i += CHUNK) {
    const batch = cut.slice(i, i + CHUNK);
    await Promise.all(batch.map(async (d) => {
      const r = await getRoute(d.origem.lat, d.origem.lng, d.destino.lat, d.destino.lng);
      if (r) {
        if (r.cached) osrmHits++; else osrmMisses++;
        d.tempo_osrm_sec = r.duration_sec;
        d.distancia_m    = r.distance_m;
        d.geometry       = r.geometry;
        if (d.tempo_osrm_sec === 0) {
          d.desvio_pct = null;
          d.status = 'origem_destino_iguais';
        } else {
          d.desvio_pct = +(100 * (d.tempo_real_sec - d.tempo_osrm_sec) / d.tempo_osrm_sec).toFixed(1);
          // Excedente em segundos (real - osrm). 'lento' exige AMBOS:
          //   desvio > 50% (fator > THRESHOLD)  E  excedente > 15min de tolerância.
          // Isso evita marcar como lento deslocamentos curtos (ex: 2min real vs 1min osrm).
          const excedenteSec    = d.tempo_real_sec - d.tempo_osrm_sec;
          const TOLERANCIA_SEC  = 15 * 60;   // 15 min
          const fatorAcima      = (d.tempo_real_sec / d.tempo_osrm_sec) > THRESHOLD;
          const excedenteAcima  = excedenteSec > TOLERANCIA_SEC;
          d.excedente_sec = excedenteSec;
          d.status = (fatorAcima && excedenteAcima) ? 'lento' : 'ok';
        }
      } else {
        osrmFails++;
        d.tempo_osrm_sec = null;
        d.distancia_m    = null;
        d.desvio_pct     = null;
        d.status         = 'sem_osrm';
      }
    }));
  }
  console.log(`[deslocamentos] passo 4: OSRM concluído em ${((Date.now() - tOsrm) / 1000).toFixed(1)}s — cache hits=${osrmHits} misses=${osrmMisses} fails=${osrmFails}`);

  // Filtro opcional: somente deslocamentos acima do limite (status='lento',
  // que eh real > 1.5x tempo Maps). Aplicado apos enriquecimento OSRM porque
  // precisamos do status calculado. Quando ativo, total/returned refletem
  // so o subconjunto filtrado — usado nos KPIs/tabela/ranking/tendencia
  // pra apresentar visao focada nos problemas.
  // Filtro de "acima": null/todos | 50 | 100 (percentual mínimo de desvio).
  // Sempre exige excedente > 15min (regra de tolerância).
  let finalRows = cut;
  if (opts.acimaPct != null) {
    const pct = Number(opts.acimaPct);
    const TOL = 15 * 60;
    finalRows = cut.filter(d =>
      d.status !== 'sem_osrm'
      && d.tempo_osrm_sec > 0
      && d.desvio_pct != null
      && d.desvio_pct > pct
      && (d.excedente_sec || 0) > TOL
    );
  } else if (opts.somenteLentos) {
    // backward compat — checkbox antigo
    finalRows = cut.filter(d => d.status === 'lento');
  }

  return {
    total: opts.somenteLentos ? finalRows.length : desloc.length,
    returned: finalRows.length,
    rows: finalRows,
    threshold: THRESHOLD,   // UI usa pra rotular "> N× Maps" dinamicamente
  };
}

/** Ranking de equipes por % desvio médio. */
async function rankingEquipes(de, ate, opts = {}) {
  // limit alto: precisamos de TODOS os deslocamentos do periodo pra ranking
  // honesto. Com OSRM paralelizado + Worker cacheado (commit e97691f), 20k
  // pairs sao ~10s na 1a vez e <2s nas subsequentes.
  const lista = await (_listCached || listDeslocamentos)(de, ate, { ...opts, limit: 20000 });
  const byTeam = new Map();
  for (const d of lista.rows) {
    if (d.status === 'sem_osrm' || d.tempo_osrm_sec === 0) continue;
    if (!byTeam.has(d.team_name)) {
      byTeam.set(d.team_name, {
        team_name: d.team_name,
        regional:  d.regional,
        total_desloc: 0,
        soma_desvio: 0,
        lentos: 0,
      });
    }
    const acc = byTeam.get(d.team_name);
    acc.total_desloc++;
    acc.soma_desvio += d.desvio_pct;
    if (d.status === 'lento') acc.lentos++;
  }
  const ranking = Array.from(byTeam.values()).map(t => ({
    ...t,
    desvio_medio_pct: t.total_desloc > 0 ? +(t.soma_desvio / t.total_desloc).toFixed(1) : 0,
    pct_lentos: t.total_desloc > 0 ? +(100 * t.lentos / t.total_desloc).toFixed(1) : 0,
  }));
  ranking.sort((a, b) => b.desvio_medio_pct - a.desvio_medio_pct);
  return ranking;
}

/** Tendência diária: tempo médio real vs Maps por dia, com continuidade de calendário. */
async function tendenciaDiaria(de, ate, opts = {}) {
  // limit alto: tendencia precisa amostrar todos os dias do periodo, nao so os
  // mais recentes. Antes era 5000 e dias antigos sumiam quando rawNotas DESC
  // truncava neles. Com OSRM paralelizado, 20k pairs = ~10s 1a vez.
  const lista = await (_listCached || listDeslocamentos)(de, ate, { ...opts, limit: 20000 });
  const byDay = new Map();
  for (const d of lista.rows) {
    if (d.status === 'sem_osrm') continue;
    if (!byDay.has(d.data)) {
      byDay.set(d.data, { data: d.data, total: 0, soma_real: 0, soma_osrm: 0, lentos: 0 });
    }
    const acc = byDay.get(d.data);
    acc.total++;
    acc.soma_real += d.tempo_real_sec;
    acc.soma_osrm += d.tempo_osrm_sec;
    if (d.status === 'lento') acc.lentos++;
  }

  // Garante continuidade do calendario [de, ate] preenchendo zero em dias
  // sem deslocamentos (mesma logica de getRejeicoesTotais.porDia).
  const out = [];
  if (de && ate) {
    const cur = new Date(de + 'T00:00:00Z');
    const end = new Date(ate + 'T00:00:00Z');
    while (cur <= end) {
      const isoDate = cur.toISOString().slice(0, 10);
      const d = byDay.get(isoDate);
      if (d && d.total > 0) {
        out.push({
          data:               isoDate,
          total:              d.total,
          tempo_real_avg_sec: Math.round(d.soma_real / d.total),
          tempo_osrm_avg_sec: Math.round(d.soma_osrm / d.total),
          pct_lentos:         +(100 * d.lentos / d.total).toFixed(1),
        });
      } else {
        out.push({
          data:               isoDate,
          total:              0,
          tempo_real_avg_sec: 0,
          tempo_osrm_avg_sec: 0,
          pct_lentos:         0,
        });
      }
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
  }
  return out;
}

// ── Cache de resultado: TTL 5min + single-flight ─────────────────────────────
// Snapshots atualizam a cada 15min (cronService). TTL de 5min mantem os dados
// "frescos o suficiente".
//
// CORRECAO 21/08/2026: este comentario afirmava que o cache "reduz drasticamente
// o re-trabalho quando o front dispara lista/ranking/tendencia em paralelo com
// mesmos filtros". Nao reduzia — as chaves sao por funcao, entao as tres chamadas
// geravam tres chaves distintas e o single-flight nunca colidia. O
// compartilhamento agora vem de as derivadas chamarem a lista CACHEADA (ver
// _listCached no topo) + o limit normalizado no _key.
const _memo = require('../services/memoCache').create({
  ttlMs: 5 * 60 * 1000,
  name:  'deslocamentos',
});

function _key(prefix, de, ate, opts) {
  // Normaliza: aceita teams/regionais como array (multi) ou singular.
  const o = opts || {};
  return JSON.stringify({
    fn:        prefix,
    de, ate,
    teams:     Array.isArray(o.teams)     ? [...o.teams].sort()     : o.team_name || null,
    regionais: Array.isArray(o.regionais) ? [...o.regionais].sort() : null,
    tipo:      o.tipo  || null,
    limit:     o.limit != null && o.limit !== '' ? Number(o.limit) : null,   // string da querystring x numero interno (21/08)
    somenteLentos: !!o.somenteLentos,
    acimaPct:      o.acimaPct != null ? Number(o.acimaPct) : null,
  });
}

const listDeslocamentosCached = _memo.wrap(listDeslocamentos,
  (de, ate, opts) => _key('list', de, ate, opts));
_listCached = listDeslocamentosCached;   // ver nota no topo: as derivadas reusam esta
const rankingEquipesCached    = _memo.wrap(rankingEquipes,
  (de, ate, opts) => _key('rank', de, ate, opts));
const tendenciaDiariaCached   = _memo.wrap(tendenciaDiaria,
  (de, ate, opts) => _key('tend', de, ate, opts));

module.exports = {
  // Versões cacheadas (uso normal — usado pelos endpoints HTTP)
  listDeslocamentos: listDeslocamentosCached,
  rankingEquipes:    rankingEquipesCached,
  tendenciaDiaria:   tendenciaDiariaCached,
  // Versões cruas (mantidas pra eventual uso direto sem cache)
  _listDeslocamentosRaw: listDeslocamentos,
  _rankingEquipesRaw:    rankingEquipes,
  _tendenciaDiariaRaw:   tendenciaDiaria,
  // Resto
  extrairDeslocamentos,
  _key,   // exportado p/ teste: a chave decide se as 3 rotas compartilham o calculo
  getThreshold,
  setThresholdCache,
  _memo,   // exposto pra debug/invalidate manual via rota admin se quiser
};
