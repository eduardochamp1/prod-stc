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

  // Note_details não tem team_name/regional/date direto — vem via JOIN com snapshots.
  // Pra evitar JOIN pesado, cruzamos via note_id e filtramos pela presença
  // em snapshots do período + equipe oficial.
  //
  // Estratégia: pega note_details com checkpoint, filtra por período via
  // jsonb timestamp do PRIMEIRO event=0 (que é o início do deslocamento real).
  // Depois cruza com a equipe/regional via snapshot mais próximo.

  const params = [de, ate];
  const where  = [
    `nd.payload->'checkpoints' IS NOT NULL`,
    `jsonb_array_length(nd.payload->'checkpoints') > 0`,
    // Filtra pelo intervalo via timestamp do primeiro evento
    `(nd.payload->'checkpoints'->0->>'timestamp')::timestamptz >= $1::date`,
    `(nd.payload->'checkpoints'->0->>'timestamp')::timestamptz < ($2::date + interval '1 day')`,
  ];

  // SQL simplificado: lê notas com checkpoint, e depois cruzamos com snapshot
  // pra pegar team_name/regional. Usamos uma LATERAL pra pegar 1 snapshot.
  const sql = `
    WITH notas_com_cp AS (
      SELECT
        nd.note_id,
        nd.numero,
        nd.tipo,
        nd.payload->'checkpoints' AS checkpoints
      FROM note_details nd
      WHERE ${where.join(' AND ')}
      LIMIT 5000
    ),
    notas_enriquecidas AS (
      SELECT
        n.*,
        s.team_name,
        s.regional,
        s.sector_id
      FROM notas_com_cp n
      LEFT JOIN LATERAL (
        SELECT s.team_name, s.regional, s.sector_id
        FROM snapshots s,
             LATERAL jsonb_array_elements(
               COALESCE(s.data->'notasConcluidas',  '[]'::jsonb) ||
               COALESCE(s.data->'notasRejeitadas',  '[]'::jsonb) ||
               COALESCE(s.data->'notasExecutadas',  '[]'::jsonb) ||
               COALESCE(s.data->'notasBaixadas',    '[]'::jsonb)
             ) AS nota_item
        WHERE nota_item->>'id' = n.note_id::text
        LIMIT 1
      ) s ON true
    )
    SELECT * FROM notas_enriquecidas
    WHERE team_name IS NOT NULL
      ${opts.regional && opts.regional !== 'ALL' ? `AND regional = $${params.push(opts.regional)}` : ''}
      ${opts.team_name ? `AND team_name = $${params.push(opts.team_name)}` : ''}
      ${opts.tipo     ? `AND tipo = $${params.push(opts.tipo)}` : ''}
  `;

  const { rows } = await pool.query(sql, params);

  // Filtra equipes oficiais (whitelist em equipes_oficiais)
  const { rows: oficRows } = await pool.query(
    `SELECT sigla FROM equipes_oficiais WHERE ativo = true`
  );
  const oficiais = new Set(oficRows.map(r => r.sigla));
  const filtered = oficiais.size > 0 ? rows.filter(r => oficiais.has(r.team_name)) : rows;

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

  // Enriquece com OSRM (cache-friendly)
  for (const d of cut) {
    const r = await getRoute(d.origem.lat, d.origem.lng, d.destino.lat, d.destino.lng);
    if (r) {
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
      d.tempo_osrm_sec = null;
      d.distancia_m    = null;
      d.desvio_pct     = null;
      d.status         = 'sem_osrm';
    }
  }

  return {
    total: desloc.length,
    returned: cut.length,
    rows: cut,
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

/** Tendência diária: tempo médio real vs OSRM por dia. */
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
  const out = Array.from(byDay.values()).map(d => ({
    data:           d.data,
    total:          d.total,
    tempo_real_avg_sec: Math.round(d.soma_real / d.total),
    tempo_osrm_avg_sec: Math.round(d.soma_osrm / d.total),
    pct_lentos:     +(100 * d.lentos / d.total).toFixed(1),
  }));
  out.sort((a, b) => a.data.localeCompare(b.data));
  return out;
}

module.exports = {
  listDeslocamentos,
  rankingEquipes,
  tendenciaDiaria,
  extrairDeslocamentos,
};
