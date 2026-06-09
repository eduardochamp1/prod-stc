/**
 * db/notasQueries.js
 * Queries de leitura para a aba Notas.
 *
 * Filtros por classificação:
 *   classificacao = 'todas'    → tudo (default)
 *                   'oficial'  → só equipes do whitelist
 *                   'nova'     → só equipes Engelmig fora do whitelist
 */
const { _getPool } = require('../services/pgShim');

function _classifClause(classificacao) {
  if (classificacao === 'oficial') return 'AND equipe_oficial = true';
  if (classificacao === 'nova')    return 'AND equipe_oficial = false';
  return '';
}

/**
 * KPIs do topo da aba.
 */
async function getKpis(classificacao = 'todas') {
  const pool   = _getPool();
  const filtro = _classifClause(classificacao);
  const sql = `
    WITH ult_ts AS (
      SELECT max(snapshot_ts) AS ts FROM notas_snapshots
    ),
    ult AS (
      SELECT * FROM notas_snapshots
       WHERE snapshot_ts = (SELECT ts FROM ult_ts) ${filtro}
    ),
    ts24 AS (
      SELECT max(snapshot_ts) AS ts FROM notas_snapshots
       WHERE snapshot_ts <= now() - interval '24 hours'
    ),
    h24 AS (
      SELECT * FROM notas_snapshots
       WHERE snapshot_ts = (SELECT ts FROM ts24) ${filtro}
    ),
    ts_inicio_dia AS (
      SELECT min(snapshot_ts) AS ts FROM notas_snapshots
       WHERE snapshot_ts >= (now() AT TIME ZONE 'America/Sao_Paulo')::date AT TIME ZONE 'America/Sao_Paulo'
    ),
    inicio_dia AS (
      SELECT * FROM notas_snapshots
       WHERE snapshot_ts = (SELECT ts FROM ts_inicio_dia) ${filtro}
    )
    SELECT
      (SELECT count(*)::int FROM ult)                                AS pendentes_agora,
      (SELECT count(DISTINCT equipe)::int FROM ult)                  AS equipes_afetadas,
      ((SELECT count(*) FROM ult) - (SELECT count(*) FROM h24))::int AS delta_24h,
      (SELECT count(*)::int FROM inicio_dia
        WHERE nota_number NOT IN (SELECT nota_number FROM ult))      AS tratadas_hoje,
      (SELECT count(*)::int FROM ult
        WHERE nota_number NOT IN (SELECT nota_number FROM inicio_dia)) AS entraram_hoje
  `;
  const r = await pool.query(sql);
  return r.rows[0];
}

/**
 * Série temporal: total pendente por dia, últimos N dias.
 */
async function getSerie(dias = 30, classificacao = 'todas') {
  const pool = _getPool();
  // notas_daily_agg não tem coluna oficial — para 'oficial'/'nova', reconstrói via snapshots.
  // Para 'todas' usa o agregado (rápido).
  if (classificacao === 'todas') {
    const r = await pool.query(`
      SELECT data, sum(pendentes_fim_dia)::int AS pendentes
        FROM notas_daily_agg
       WHERE data >= current_date - $1::int
       GROUP BY data
       ORDER BY data
    `, [dias]);
    return r.rows;
  }
  const filtro = _classifClause(classificacao);
  const r = await pool.query(`
    WITH ult_por_dia AS (
      SELECT date_trunc('day', snapshot_ts AT TIME ZONE 'America/Sao_Paulo')::date AS data,
             max(snapshot_ts) AS ts
        FROM notas_snapshots
       WHERE snapshot_ts >= current_date - $1::int
       GROUP BY 1
    )
    SELECT u.data, count(s.*)::int AS pendentes
      FROM ult_por_dia u
      JOIN notas_snapshots s ON s.snapshot_ts = u.ts ${filtro}
     GROUP BY u.data
     ORDER BY u.data
  `, [dias]);
  return r.rows;
}

/**
 * Tabela do meio: linhas por equipe baseadas no snapshot mais recente +
 * agregado de hoje.
 */
async function getPorEquipe(classificacao = 'todas') {
  const pool   = _getPool();
  const filtro = _classifClause(classificacao);
  const sql = `
    WITH ts_ult AS (SELECT max(snapshot_ts) AS ts FROM notas_snapshots),
    ult AS (
      SELECT equipe,
             bool_or(equipe_oficial) AS equipe_oficial,
             count(*)::int           AS pendentes,
             coalesce(max(EXTRACT(EPOCH FROM (now() - conclusion_date))/86400),0)::int AS idade_max
        FROM notas_snapshots
       WHERE snapshot_ts = (SELECT ts FROM ts_ult) ${filtro}
       GROUP BY equipe
    ),
    hoje AS (
      SELECT equipe, entraram_no_dia, sairam_no_dia
        FROM notas_daily_agg
       WHERE data = current_date
    )
    SELECT
      u.equipe,
      u.equipe_oficial,
      u.pendentes,
      coalesce(h.entraram_no_dia, 0)::int                           AS entraram_hoje,
      coalesce(h.sairam_no_dia,   0)::int                           AS sairam_hoje,
      (coalesce(h.entraram_no_dia, 0) - coalesce(h.sairam_no_dia, 0))::int AS saldo_dia,
      u.idade_max                                                    AS nota_mais_antiga_dias
    FROM ult u
    LEFT JOIN hoje h ON h.equipe = u.equipe
    ORDER BY u.pendentes DESC
  `;
  const r = await pool.query(sql);
  return r.rows;
}

/**
 * Notas pendentes de uma equipe específica (drill-down).
 */
async function getNotasDeEquipe(equipe) {
  const pool = _getPool();
  const sql = `
    SELECT nota_number, tipo, conclusion_date, conclusion_status,
           EXTRACT(EPOCH FROM (now() - conclusion_date))/86400 AS dias_parada
      FROM notas_snapshots
     WHERE snapshot_ts = (SELECT max(snapshot_ts) FROM notas_snapshots)
       AND equipe = $1
     ORDER BY conclusion_date ASC NULLS LAST
  `;
  const r = await pool.query(sql, [equipe]);
  return r.rows;
}

module.exports = { getKpis, getSerie, getPorEquipe, getNotasDeEquipe };
