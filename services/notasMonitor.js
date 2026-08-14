/**
 * services/notasMonitor.js
 * Monitor de notas devolvidas (Engelmig).
 *
 * Pipeline:
 *   collectSnapshot() = busca lista de equipes (CompanyId) + busca notas →
 *                       filtra por CompanyId Engelmig → tagueia oficial/nova →
 *                       grava snapshot → atualiza agregado diário →
 *                       limpa snapshots > 30 dias.
 */

const { getNotasDevolvidas, getTeamsSimple, isSectorDisabled } = require('./wpaService');
const equipesOficiais                          = require('./equipesOficiais');
const { _getPool }                             = require('./pgShim');
const log                                      = require('./logger').forModule('notas');

// CompanyIds que pertencem à Engelmig (descobertos no payload do dropdown
// Teams/Simple). Inclui os 2 CNPJs Engelmig que aparecem nas equipes da
// regional DESC (Cachoeiro):
//   92a2f98e-... → uma das matrizes
//   3a4b33fb-... → outra matriz
const ENGELMIG_COMPANY_IDS = new Set([
  '92a2f98e-8877-433e-8358-173b94c13a54',
  '3a4b33fb-25e0-4506-803c-3d58ec3fbd5b',
]);

/**
 * Cruza notas com o dicionário de equipes (Name → CompanyId), mantém só
 * notas de equipes Engelmig e marca cada uma como oficial (no whitelist) ou
 * nova (Engelmig mas fora do whitelist — a revisar).
 *
 * @param {Array} notas         payload de getNotasDevolvidas
 * @param {Map}   teamCompanyId mapa Name → CompanyId vindo de getTeamsSimple
 * @returns {Array} notas filtradas, cada uma com campo extra `_equipe_oficial`
 */
/**
 * Mantém só notas de equipes oficiais Engelmig (whitelist `equipesOficiais`).
 * Notas de equipes Engelmig por CompanyId mas fora do whitelist são descartadas
 * (logadas como warning pra eventual cadastro futuro).
 */
function filterEngelmig(notas, teamCompanyId) {
  const novasDescartadas = new Map();   // sigla → count
  const out = [];
  for (const n of notas) {
    const sigla = n?.Team?.Name;
    if (!sigla) continue;
    if (!equipesOficiais.isOficial(sigla)) {
      // Só registra como "candidata a cadastro" se for Engelmig por CompanyId
      const cid = teamCompanyId.get(sigla);
      if (cid && ENGELMIG_COMPANY_IDS.has(cid)) {
        novasDescartadas.set(sigla, (novasDescartadas.get(sigla) || 0) + 1);
      }
      continue;
    }
    n._equipe_oficial = true;
    out.push(n);
  }
  log.info('filter_engelmig', { total_in: notas.length, oficiais_out: out.length });
  if (novasDescartadas.size) {
    log.warn('equipes_candidatas_cadastro', { equipes: Object.fromEntries(novasDescartadas) });
  }
  return out;
}

/**
 * Constrói o mapa Name → CompanyId a partir do payload de Teams/Simple.
 */
function buildTeamCompanyMap(teams) {
  const m = new Map();
  for (const t of teams) {
    if (t?.Name && t?.CompanyId) m.set(t.Name, t.CompanyId);
  }
  return m;
}

/**
 * Persiste o snapshot no banco em batches. Idempotente por PK — re-rodar
 * com mesmo snapshot_ts não duplica linhas.
 */
async function saveSnapshot(notas, snapshotTs) {
  if (!notas.length) {
    log.info('snapshot_vazio', { ts: snapshotTs });
    return 0;
  }
  const pool = _getPool();
  const BATCH = 500;
  let total = 0;
  for (let i = 0; i < notas.length; i += BATCH) {
    const slice  = notas.slice(i, i + BATCH);
    const values = [];
    const params = [];
    slice.forEach((n, idx) => {
      const base = idx * 11;
      values.push(`($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10},$${base+11})`);
      const conclusionDate = n.ConclusionDate && n.ConclusionDate !== '0001-01-01T00:00:00'
        ? n.ConclusionDate : null;
      params.push(
        snapshotTs,
        n.Number,
        n.Id || null,
        n.Type || null,
        n.Team?.Name || null,
        n.Status ?? null,
        conclusionDate,
        n.ConclusionStatus || null,
        null,                                      // sap_message — v2
        n._equipe_oficial === false ? false : true, // default true se não taggeado
        n._regional || null,
      );
    });
    const sql = `
      INSERT INTO notas_snapshots
        (snapshot_ts, nota_number, nota_id, tipo, equipe, status, conclusion_date,
         conclusion_status, sap_message, equipe_oficial, regional)
      VALUES ${values.join(',')}
      ON CONFLICT (snapshot_ts, nota_number) DO NOTHING
    `;
    const r = await pool.query(sql, params);
    total += r.rowCount;
  }
  log.info('snapshot_saved', { ts: snapshotTs, rows: total });
  return total;
}

/**
 * Atualiza notas_daily_agg para o dia informado, baseado em todos os
 * snapshots já gravados naquele dia + último snapshot do dia anterior.
 * Idempotente — recalcula tudo via UPSERT (data, equipe).
 *
 * Definições por (data, equipe):
 *   pendentes_fim_dia       = qtd no último snapshot do dia
 *   entraram_no_dia         = notas que apareceram no dia e não estavam no
 *                             último snapshot do dia anterior
 *   sairam_no_dia           = notas que estavam no último snapshot do dia
 *                             anterior e não no último snapshot do dia
 *   idade_mais_antiga_dias  = max(now - conclusion_date) no último snapshot
 */
async function updateDailyAgg(data) {
  const pool = _getPool();
  const sql = `
    WITH ts_ult AS (
      SELECT max(snapshot_ts) AS ts FROM notas_snapshots
       WHERE snapshot_ts >= $1::date AND snapshot_ts < ($1::date + interval '1 day')
    ),
    ts_anterior AS (
      SELECT max(snapshot_ts) AS ts FROM notas_snapshots
       WHERE snapshot_ts < $1::date
    ),
    ult_dia AS (
      SELECT * FROM notas_snapshots WHERE snapshot_ts = (SELECT ts FROM ts_ult)
    ),
    ult_anterior AS (
      SELECT * FROM notas_snapshots WHERE snapshot_ts = (SELECT ts FROM ts_anterior)
    ),
    todas_dia AS (
      SELECT DISTINCT nota_number, equipe FROM notas_snapshots
       WHERE snapshot_ts >= $1::date AND snapshot_ts < ($1::date + interval '1 day')
    ),
    pend AS (
      SELECT equipe, coalesce(regional,'?') AS regional,
             count(*)                                                            AS pendentes_fim_dia,
             coalesce(max(EXTRACT(EPOCH FROM (now() - conclusion_date))/86400),0)::int AS idade_max
        FROM ult_dia
       GROUP BY equipe, coalesce(regional,'?')
    ),
    entr AS (
      SELECT td.equipe, coalesce(td.regional,'?') AS regional, count(*) AS entraram_no_dia
        FROM (SELECT DISTINCT nota_number, equipe, regional FROM notas_snapshots
               WHERE snapshot_ts >= $1::date AND snapshot_ts < ($1::date + interval '1 day')) td
       WHERE NOT EXISTS (SELECT 1 FROM ult_anterior ua WHERE ua.nota_number = td.nota_number)
       GROUP BY td.equipe, coalesce(td.regional,'?')
    ),
    sai AS (
      -- Saídas = qualquer nota que esteve presente em ALGUM momento (último de
      -- ontem OU qualquer snapshot de hoje) e NÃO está no último snapshot do dia.
      -- Captura também notas que entraram e foram tratadas no mesmo dia (churn
      -- intra-day). Garante simetria com entraram: variacao = entraram - sairam.
      SELECT equipe, coalesce(regional,'?') AS regional, count(*) AS sairam_no_dia
        FROM (
          SELECT DISTINCT nota_number, equipe, regional FROM notas_snapshots
           WHERE snapshot_ts >= $1::date AND snapshot_ts < ($1::date + interval '1 day')
          UNION
          SELECT DISTINCT nota_number, equipe, regional FROM ult_anterior
        ) u
       WHERE NOT EXISTS (SELECT 1 FROM ult_dia ud WHERE ud.nota_number = u.nota_number)
       GROUP BY equipe, coalesce(regional,'?')
    ),
    todas_equipes AS (
      SELECT equipe, regional FROM pend
      UNION SELECT equipe, regional FROM entr
      UNION SELECT equipe, regional FROM sai
    )
    INSERT INTO notas_daily_agg
      (data, equipe, regional, pendentes_fim_dia, entraram_no_dia, sairam_no_dia, idade_mais_antiga_dias)
    SELECT
      $1::date,
      te.equipe,
      te.regional,
      coalesce(p.pendentes_fim_dia, 0),
      coalesce(e.entraram_no_dia, 0),
      coalesce(s.sairam_no_dia, 0),
      coalesce(p.idade_max, 0)
    FROM todas_equipes te
    LEFT JOIN pend p ON p.equipe = te.equipe AND p.regional = te.regional
    LEFT JOIN entr e ON e.equipe = te.equipe AND e.regional = te.regional
    LEFT JOIN sai  s ON s.equipe = te.equipe AND s.regional = te.regional
    ON CONFLICT (data, equipe, regional) DO UPDATE SET
      pendentes_fim_dia      = EXCLUDED.pendentes_fim_dia,
      entraram_no_dia        = EXCLUDED.entraram_no_dia,
      sairam_no_dia          = EXCLUDED.sairam_no_dia,
      idade_mais_antiga_dias = EXCLUDED.idade_mais_antiga_dias
  `;
  const r = await pool.query(sql, [data]);
  log.info('daily_agg_updated', { data, equipes: r.rowCount });
  return r.rowCount;
}

/**
 * Pipeline completo do snapshot:
 *   1. Busca lista de equipes (com CompanyId) + notas devolvidas em paralelo
 *   2. Filtra para Engelmig (taggeia oficial/nova)
 *   3. Grava snapshot
 *   4. Atualiza agregado do dia
 *   5. Limpa snapshots > 30 dias
 */
// Setores cobertos. Mapping setor → regional alinhado com services/wpaService.js REGIONAL_MAP.
const SECTORS = ['DESG', 'DEPT', 'DESC', 'DSSJ'];
const SECTOR_TO_REGIONAL = { DESG: 'GUA', DEPT: 'GUA', DESC: 'CAC', DSSJ: 'SJC' };

async function collectSnapshot() {
  const t0 = Date.now();
  // Pula setores de conta desativada (P1-21) — não cutuca o WPA à toa. Usa a
  // lista ATIVA em todo o resto pra manter o alinhamento setor↔índice.
  const activeSectors = SECTORS.filter(s => !isSectorDisabled(s));
  // Busca paralelo: teams (1x por setor) + notas (1x por setor).
  const teamsBySector = await Promise.all(activeSectors.map(s =>
    getTeamsSimple(s).catch(e => { log.warn('teams_simple_fail', { sector: s, msg: e.message }); return []; })
  ));
  const notasBySector = await Promise.all(activeSectors.map(s =>
    getNotasDevolvidas(s).catch(e => { log.warn('notas_fail', { sector: s, msg: e.message }); return []; })
  ));
  // Junta dropdown de equipes (Name → CompanyId) — uma equipe pode aparecer
  // em mais de um setor, mas o CompanyId é o mesmo.
  const mapa = new Map();
  for (const teams of teamsBySector) {
    for (const [name, cid] of buildTeamCompanyMap(teams)) mapa.set(name, cid);
  }
  // Dedup de notas por Number (mesma nota pode aparecer em setores diferentes).
  // Tagueia cada nota com a regional do setor onde apareceu pela primeira vez.
  const seen = new Map();
  notasBySector.forEach((arr, idx) => {
    const regional = SECTOR_TO_REGIONAL[activeSectors[idx]] || null;
    for (const n of arr) {
      if (n?.Number && !seen.has(n.Number)) {
        n._regional = regional;
        seen.set(n.Number, n);
      }
    }
  });
  const todasNotas = [...seen.values()];
  const eng       = filterEngelmig(todasNotas, mapa);
  const ts        = new Date().toISOString();
  const inserted  = await saveSnapshot(eng, ts);
  const today     = ts.slice(0, 10);
  await updateDailyAgg(today);
  const deleted   = await _cleanupOld();
  const ms        = Date.now() - t0;
  const stats     = { total: todasNotas.length, engelmig: eng.length, inserted, deleted, ms };
  log.info('collect_done', stats);
  return stats;
}

async function _cleanupOld() {
  const pool = _getPool();
  const r = await pool.query(
    `DELETE FROM notas_snapshots WHERE snapshot_ts < now() - interval '30 days'`
  );
  return r.rowCount;
}

module.exports = {
  filterEngelmig, buildTeamCompanyMap, saveSnapshot, updateDailyAgg,
  collectSnapshot, ENGELMIG_COMPANY_IDS,
};
