/**
 * db/rejectionsQueries.js
 * Leitura/escrita da tabela note_rejections (detalhes de notas rejeitadas).
 *
 * Convenções:
 *   - `de` / `ate` em formato 'YYYY-MM-DD'
 *   - Atribuição por `session_date` (mesma regra do projeto — sessionBegin do dia)
 *   - Não chama WPA daqui. Quem coleta da WPA é services/rejectionService.js.
 */

const { getClient } = require('../services/supabaseClient');
const { _getPool } = require('../services/pgShim');
const { applyRegional, regionalSqlClause } = require('../services/regionalGroups');

// ── Leitura ──────────────────────────────────────────────────────────────────

/**
 * Set de UUIDs já presentes em note_rejections (para dedup rápida no cron/backfill).
 */
async function getKnownRejectedIds() {
  const sb = getClient();
  const ids = new Set();
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await sb
      .from('note_rejections')
      .select('note_id')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    data.forEach(r => ids.add(r.note_id));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return ids;
}

/**
 * Set de UUIDs que estão em note_rejections mas SEM motivos (motivo_codes vazio).
 * Usado pelo backfill com --retry-empty pra re-tentar notas que falharam na
 * descoberta de endpoint anterior (ex: RL/DL/LE antes do fix dos fallbacks).
 */
async function getEmptyRejectedIds() {
  const { _getPool } = require('../services/pgShim');
  const pool = _getPool();
  const { rows } = await pool.query(`
    SELECT note_id
    FROM note_rejections
    WHERE coalesce(array_length(motivo_codes, 1), 0) = 0
  `);
  return new Set(rows.map(r => r.note_id));
}

/**
 * Lista rejeições de um período com filtros opcionais.
 * @param {string} de            'YYYY-MM-DD'
 * @param {string} ate           'YYYY-MM-DD'
 * @param {object} [opts]
 * @param {string} [opts.regional]  'GUA' | 'CAC' | 'ALL'
 * @param {string} [opts.tipo]      'MD' | 'LN' | ... (filtro)
 * @param {string} [opts.teamName]
 */
async function listRejectionsByPeriod(de, ate, opts = {}) {
  const sb = getClient();
  let q = sb
    .from('note_rejections')
    .select('*')
    .gte('session_date', de)
    .lte('session_date', ate)
    .order('rejection_date', { ascending: false });

  q = applyRegional(q, opts.regional);
  if (opts.tipo)     q = q.eq('tipo', opts.tipo);
  if (opts.teamName) q = q.eq('team_name', opts.teamName);

  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// ── Agregações (raw SQL via pool — usa unnest pra arrays GIN-indexed) ────────

/**
 * Top motivos por contagem.
 * Retorna [{ code, texto, total }, ...] ordenado desc.
 *
 * Como motivo_codes é TEXT[], usamos unnest pra explodir 1 linha por motivo
 * (uma rejeição com 2 motivos conta 1x pra cada um — política B).
 */
async function getTopMotivos(de, ate, opts = {}) {
  const pool = _getPool();
  const params = [de, ate];
  const where  = ['session_date >= $1', 'session_date <= $2'];
  { const c = regionalSqlClause(opts.regional, params); if (c) where.push(c); }
  if (opts.tipo)     { params.push(opts.tipo);     where.push(`tipo = $${params.length}`); }
  if (opts.teamName) { params.push(opts.teamName); where.push(`team_name = $${params.length}`); }

  const sql = `
    SELECT
      m.code,
      MAX(t.texto)::text AS texto,
      COUNT(*)::int      AS total
    FROM note_rejections nr,
         LATERAL unnest(nr.motivo_codes)  WITH ORDINALITY AS m(code, idx),
         LATERAL unnest(nr.motivo_textos) WITH ORDINALITY AS t(texto, idx2)
    WHERE m.idx = t.idx2
      AND ${where.join(' AND ')}
    GROUP BY m.code
    ORDER BY total DESC, m.code ASC
  `;
  const { rows } = await pool.query(sql, params);
  return rows;
}

/**
 * Top equipes (siglas) por número de rejeições no período.
 * Retorna [{ team_name, regional, total }, ...]
 */
async function getTopTeams(de, ate, opts = {}) {
  const pool = _getPool();
  const params = [de, ate];
  const where  = ['session_date >= $1', 'session_date <= $2'];
  { const c = regionalSqlClause(opts.regional, params); if (c) where.push(c); }
  if (opts.tipo) { params.push(opts.tipo); where.push(`tipo = $${params.length}`); }

  const sql = `
    SELECT team_name, MAX(regional)::text AS regional, COUNT(*)::int AS total
    FROM note_rejections
    WHERE ${where.join(' AND ')}
    GROUP BY team_name
    ORDER BY total DESC, team_name ASC
  `;
  const { rows } = await pool.query(sql, params);
  return rows;
}

/**
 * Top colaboradores por número de rejeições no período.
 * Política B(a): todos os colaboradores da sessão recebem 1 ponto cada por
 * rejeição (não dividido). Implementado via unnest do array collaborator_codes.
 *
 * Retorna [{ code, name, total }, ...]
 */
async function getTopColaboradores(de, ate, opts = {}) {
  const pool = _getPool();
  const params = [de, ate];
  const where  = ['session_date >= $1', 'session_date <= $2'];
  { const c = regionalSqlClause(opts.regional, params); if (c) where.push(c); }
  if (opts.tipo)     { params.push(opts.tipo);     where.push(`tipo = $${params.length}`); }
  if (opts.teamName) { params.push(opts.teamName); where.push(`team_name = $${params.length}`); }

  const sql = `
    SELECT
      c.code,
      MAX(n.name)::text AS name,
      COUNT(*)::int     AS total
    FROM note_rejections nr,
         LATERAL unnest(nr.collaborator_codes) WITH ORDINALITY AS c(code, idx),
         LATERAL unnest(nr.collaborator_names) WITH ORDINALITY AS n(name, idx2)
    WHERE c.idx = n.idx2
      AND ${where.join(' AND ')}
    GROUP BY c.code
    ORDER BY total DESC, c.code ASC
  `;
  const { rows } = await pool.query(sql, params);
  return rows;
}

/**
 * Totais agregados no período (cards do dashboard).
 * Retorna { total, por_regional: {GUA, CAC}, por_tipo: {MD: N, LN: N, ...} }
 */
async function getResumoPeriodo(de, ate, opts = {}) {
  const pool = _getPool();
  const params = [de, ate];
  const where  = ['session_date >= $1', 'session_date <= $2'];
  { const c = regionalSqlClause(opts.regional, params); if (c) where.push(c); }

  const [total, porRegional, porTipo] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total FROM note_rejections WHERE ${where.join(' AND ')}`, params),
    pool.query(`
      SELECT regional, COUNT(*)::int AS total
      FROM note_rejections
      WHERE ${where.join(' AND ')}
      GROUP BY regional
    `, params),
    pool.query(`
      SELECT tipo, COUNT(*)::int AS total
      FROM note_rejections
      WHERE ${where.join(' AND ')}
      GROUP BY tipo
      ORDER BY total DESC
    `, params),
  ]);

  const por_regional = { GUA: 0, CAC: 0 };
  porRegional.rows.forEach(r => { por_regional[r.regional] = r.total; });

  const por_tipo = {};
  porTipo.rows.forEach(r => { por_tipo[r.tipo] = r.total; });

  return {
    total: total.rows[0]?.total || 0,
    por_regional,
    por_tipo,
  };
}

// ── Escrita ──────────────────────────────────────────────────────────────────

/**
 * Insere/atualiza várias rejeições.
 * onConflict = note_id (PK) — re-execução é idempotente.
 *
 * Cada row deve ter os campos:
 *   note_id (UUID), numero, tipo, team_name, regional, sector_id,
 *   rejection_date, session_date, observacao,
 *   motivo_codes[], motivo_textos[], formulario,
 *   collaborator_codes[], collaborator_names[],
 *   raw (JSONB), fetched_at
 */
async function upsertRejections(rows) {
  if (!rows || rows.length === 0) return 0;
  const sb = getClient();
  const CHUNK = 200;  // arrays + jsonb = payload grande, batch menor que subcategorias
  let total = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await sb
      .from('note_rejections')
      .upsert(chunk, { onConflict: 'note_id' });
    if (error) throw error;
    total += chunk.length;
  }
  return total;
}

module.exports = {
  // Leitura
  getKnownRejectedIds,
  getEmptyRejectedIds,
  listRejectionsByPeriod,
  // Agregações
  getTopMotivos,
  getTopTeams,
  getTopColaboradores,
  getResumoPeriodo,
  // Escrita
  upsertRejections,
};
