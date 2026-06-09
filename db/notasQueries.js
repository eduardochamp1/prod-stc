/**
 * db/notasQueries.js
 * Queries de leitura para a aba Notas.
 *
 * Filtros:
 *   classificacao = 'todas' | 'oficial' | 'nova'
 *   regionais     = array de regionais (['GUA','CAC','SJC']) — vazio/null = todas
 */
const { _getPool } = require('../services/pgShim');

function _classifClause(classificacao) {
  if (classificacao === 'oficial') return 'AND equipe_oficial = true';
  if (classificacao === 'nova')    return 'AND equipe_oficial = false';
  return '';
}

/** Recebe array de regionais, retorna { clause, param } onde clause é tipo `AND regional = ANY($N)` */
function _regionalParam(regionais, startIdx) {
  if (!regionais || !regionais.length) return { clause: '', param: null };
  return { clause: `AND regional = ANY($${startIdx})`, param: regionais };
}

async function getKpis(classificacao = 'todas', regionais = null) {
  const pool = _getPool();
  const cf   = _classifClause(classificacao);
  const r1   = _regionalParam(regionais, 1);
  const params = r1.param ? [r1.param] : [];
  const rg   = r1.clause;
  const sql = `
    WITH ult_ts AS (SELECT max(snapshot_ts) AS ts FROM notas_snapshots),
    ult AS (
      SELECT * FROM notas_snapshots
       WHERE snapshot_ts = (SELECT ts FROM ult_ts) ${cf} ${rg}
    ),
    ts24 AS (
      SELECT max(snapshot_ts) AS ts FROM notas_snapshots
       WHERE snapshot_ts <= now() - interval '24 hours'
    ),
    h24 AS (
      SELECT * FROM notas_snapshots
       WHERE snapshot_ts = (SELECT ts FROM ts24) ${cf} ${rg}
    ),
    ts_inicio_dia AS (
      SELECT min(snapshot_ts) AS ts FROM notas_snapshots
       WHERE snapshot_ts >= (now() AT TIME ZONE 'America/Sao_Paulo')::date AT TIME ZONE 'America/Sao_Paulo'
    ),
    inicio_dia AS (
      SELECT * FROM notas_snapshots
       WHERE snapshot_ts = (SELECT ts FROM ts_inicio_dia) ${cf} ${rg}
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
  const r = await pool.query(sql, params);
  return r.rows[0];
}

async function getSerie(dias = 30, classificacao = 'todas', regionais = null) {
  const pool = _getPool();
  // Para 'todas' sem filtro regional usa notas_daily_agg (rápido).
  if (classificacao === 'todas' && (!regionais || !regionais.length)) {
    const r = await pool.query(`
      SELECT data, sum(pendentes_fim_dia)::int AS pendentes
        FROM notas_daily_agg
       WHERE data >= current_date - $1::int
       GROUP BY data
       ORDER BY data
    `, [dias]);
    return r.rows;
  }
  // Caso geral: reconstrói via snapshots
  const cf = _classifClause(classificacao);
  const r1 = _regionalParam(regionais, 2);
  const params = r1.param ? [dias, r1.param] : [dias];
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
      JOIN notas_snapshots s ON s.snapshot_ts = u.ts ${cf} ${r1.clause}
     GROUP BY u.data
     ORDER BY u.data
  `, params);
  return r.rows;
}

async function getPorEquipe(classificacao = 'todas', regionais = null) {
  const pool = _getPool();
  const cf   = _classifClause(classificacao);
  const r1   = _regionalParam(regionais, 1);
  const params = r1.param ? [r1.param] : [];
  const sql = `
    WITH ts_ult AS (SELECT max(snapshot_ts) AS ts FROM notas_snapshots),
    ult AS (
      SELECT equipe,
             regional,
             bool_or(equipe_oficial) AS equipe_oficial,
             count(*)::int           AS pendentes,
             coalesce(max(EXTRACT(EPOCH FROM (now() - conclusion_date))/86400),0)::int AS idade_max
        FROM notas_snapshots
       WHERE snapshot_ts = (SELECT ts FROM ts_ult) ${cf} ${r1.clause}
       GROUP BY equipe, regional
    ),
    hoje AS (
      SELECT equipe, regional, entraram_no_dia, sairam_no_dia
        FROM notas_daily_agg
       WHERE data = current_date
    )
    SELECT
      u.equipe,
      u.regional,
      u.equipe_oficial,
      u.pendentes,
      coalesce(h.entraram_no_dia, 0)::int                           AS entraram_hoje,
      coalesce(h.sairam_no_dia,   0)::int                           AS sairam_hoje,
      (coalesce(h.entraram_no_dia, 0) - coalesce(h.sairam_no_dia, 0))::int AS saldo_dia,
      u.idade_max                                                    AS nota_mais_antiga_dias
    FROM ult u
    LEFT JOIN hoje h ON h.equipe = u.equipe AND h.regional = u.regional
    ORDER BY u.pendentes DESC
  `;
  const r = await pool.query(sql, params);
  return r.rows;
}

async function getNotasDeEquipe(equipe) {
  const pool = _getPool();
  const sql = `
    SELECT nota_number, tipo, conclusion_date, conclusion_status, regional,
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
