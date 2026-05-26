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
const { getClient } = require('../services/supabaseClient');
const { getRoute }  = require('../services/osrmService');

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
async function listDeslocamentos(de, ate, opts = {}) {
  const pool = _getPool();
  const t0 = Date.now();

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

  const sqlNotas = `
    SELECT
      nd.note_id,
      nd.numero,
      nd.tipo,
      nd.payload->'checkpoints' AS checkpoints
    FROM note_details nd
    WHERE nd.payload->'checkpoints' IS NOT NULL
      AND jsonb_array_length(nd.payload->'checkpoints') >= 2
      AND ${wherePeriodo}
    LIMIT 3000
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
  if (Array.isArray(opts.regionais) && opts.regionais.length > 0) {
    const ph = opts.regionais.map(r => { params2.push(r); return `$${params2.length}`; });
    snapWhere += ` AND s.regional IN (${ph.join(', ')})`;
  } else if (opts.regional && opts.regional !== 'ALL') {
    params2.push(opts.regional);
    snapWhere += ` AND s.regional = $${params2.length}`;
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
  const LIMIT = Math.min(Math.max(parseInt(opts.limit || 500, 10), 1), 5000);
  const cut = desloc.slice(0, LIMIT);
  console.log(`[deslocamentos] passo 4: ${desloc.length} deslocamentos extraídos, processando ${cut.length} via OSRM...`);
  const tOsrm = Date.now();
  let osrmHits = 0, osrmMisses = 0, osrmFails = 0;

  // Enriquece com OSRM (cache-friendly)
  for (const d of cut) {
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
        d.status = (d.tempo_real_sec / d.tempo_osrm_sec) > 1.5 ? 'lento' : 'ok';
      }
    } else {
      osrmFails++;
      d.tempo_osrm_sec = null;
      d.distancia_m    = null;
      d.desvio_pct     = null;
      d.status         = 'sem_osrm';
    }
  }
  console.log(`[deslocamentos] passo 4: OSRM concluído em ${((Date.now() - tOsrm) / 1000).toFixed(1)}s — cache hits=${osrmHits} misses=${osrmMisses} fails=${osrmFails}`);

  // Filtro opcional: somente deslocamentos acima do limite (status='lento',
  // que eh real > 1.5x tempo Maps). Aplicado apos enriquecimento OSRM porque
  // precisamos do status calculado. Quando ativo, total/returned refletem
  // so o subconjunto filtrado — usado nos KPIs/tabela/ranking/tendencia
  // pra apresentar visao focada nos problemas.
  let finalRows = cut;
  if (opts.somenteLentos) {
    finalRows = cut.filter(d => d.status === 'lento');
  }

  return {
    total: opts.somenteLentos ? finalRows.length : desloc.length,
    returned: finalRows.length,
    rows: finalRows,
  };
}

/** Ranking de equipes por % desvio médio. */
async function rankingEquipes(de, ate, opts = {}) {
  const lista = await listDeslocamentos(de, ate, { ...opts, limit: 5000 });
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
  const lista = await listDeslocamentos(de, ate, { ...opts, limit: 5000 });
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

module.exports = {
  listDeslocamentos,
  rankingEquipes,
  tendenciaDiaria,
  extrairDeslocamentos,
};
