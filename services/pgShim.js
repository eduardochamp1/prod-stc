/**
 * services/pgShim.js
 *
 * Shim de compatibilidade com a API @supabase/supabase-js (PostgREST
 * builder), implementado por baixo via driver `pg`. Permite migrar do
 * Supabase para Postgres self-hosted SEM tocar nos 105 call sites do
 * codebase — o objeto retornado por getClient().from(t) tem os mesmos
 * métodos chainable, e o thenable resolve com { data, error, count }.
 *
 * Métodos suportados (cobrem 100% do uso atual da app):
 *   from(table)
 *   .select(cols?, opts?)
 *   .insert(rows)
 *   .upsert(rows, { onConflict })
 *   .update(obj)
 *   .delete(opts?)
 *   .eq / .gte / .lte / .gt / .lt / .in / .ilike / .not / .filter
 *   .order(col, { ascending })
 *   .range(from, to)
 *   .limit(n)
 *   .single() / .maybeSingle()
 *
 * NÃO suportados (não usados no projeto):
 *   .or(), .rpc(), .neq() encadeado complexo, RLS, auth.*
 *
 * Comportamento de erro: idêntico ao supabase-js — retorna
 *   { data: null, error: { message, code, details, hint } }
 * e nunca rejeita a promise. Quem destrutura `const { error }` continua
 * funcionando inalterado.
 */

const { Pool } = require('pg');

let _pool = null;

/**
 * Monta o config do `new Pool()` a partir do env. Função PURA (não cria pool
 * nem conecta) — separada de _getPool pra ser testável sem banco.
 *
 * statement_timeout (P2-6, 22/07/2026): aborta no servidor qualquer query que
 * passar de N ms (default 60s). Sem isso, um SELECT pesado (export mensal,
 * range grande na aba Deslocamentos) pode segurar as `max` conexões por
 * minutos e travar o cron de escrita em cascata. É aplicado via libpq
 * `options` (-c), então vale pra TODA conexão do pool desde o startup.
 * Scripts de backfill que precisam de query longa devem exportar
 * PG_STATEMENT_TIMEOUT_MS=0 (0 = sem limite, semântica do Postgres).
 */
function _buildPoolConfig(env = process.env) {
  const cs = env.DATABASE_URL;
  if (!cs) {
    throw new Error('DATABASE_URL não configurada — defina no .env (ex: postgresql://user:pass@localhost:5432/wpa_monitor)');
  }
  const stmtTimeout = parseInt(env.PG_STATEMENT_TIMEOUT_MS || '60000', 10);
  const cfg = {
    connectionString: cs,
    max:              parseInt(env.PG_POOL_MAX  || '10', 10),
    idleTimeoutMillis: parseInt(env.PG_IDLE_MS || '30000', 10),
    // Aceita conexões internas sem SSL; ative se conectar em Supabase ou em PG remoto.
    ssl: env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false,
  };
  if (Number.isFinite(stmtTimeout) && stmtTimeout > 0) {
    cfg.options = `-c statement_timeout=${stmtTimeout}`;
  }
  return cfg;
}

function _getPool() {
  if (_pool) return _pool;
  _pool = new Pool(_buildPoolConfig());
  _pool.on('error', err => console.error('[pgShim] pool error:', err.message));
  return _pool;
}

/** Permite testes injetarem um pool fake. */
function _setPool(pool) { _pool = pool; }

/** Escapa identificador (nome de tabela/coluna). Mantém pontos para JSONB path (col->>'x'). */
function _id(s) {
  // se contém aspas duplas, deixa como está (já é JSON path ou expressão)
  if (s.includes('"') || s.includes(' ') || s.includes('->')) return s;
  return `"${s}"`;
}

class Query {
  constructor(table) {
    this._table        = table;
    this._op           = null;
    this._cols         = '*';
    this._filters      = [];
    this._order        = [];
    this._range        = null;
    this._limit        = null;
    this._returnMode   = 'array';     // 'array' | 'single' | 'maybeSingle'
    this._payload      = null;
    this._onConflict   = null;
    this._wantCount    = false;       // .delete({ count: 'exact' })
  }

  // ── Operações ───────────────────────────────────────────────────────────
  select(cols, _opts) {
    if (!this._op) this._op = 'select';
    if (cols && typeof cols === 'string') this._cols = cols;
    return this;
  }
  insert(rows) {
    this._op = 'insert';
    this._payload = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  upsert(rows, opts) {
    this._op = 'upsert';
    this._payload = Array.isArray(rows) ? rows : [rows];
    this._onConflict = opts?.onConflict || null;
    return this;
  }
  update(obj) {
    this._op = 'update';
    this._payload = obj;
    return this;
  }
  delete(opts) {
    this._op = 'delete';
    if (opts?.count === 'exact') this._wantCount = true;
    return this;
  }

  // ── Filtros ─────────────────────────────────────────────────────────────
  eq(col, val)  { this._filters.push({ col, op: '=',  val }); return this; }
  neq(col, val) { this._filters.push({ col, op: '!=', val }); return this; }
  gt(col, val)  { this._filters.push({ col, op: '>',  val }); return this; }
  gte(col, val) { this._filters.push({ col, op: '>=', val }); return this; }
  lt(col, val)  { this._filters.push({ col, op: '<',  val }); return this; }
  lte(col, val) { this._filters.push({ col, op: '<=', val }); return this; }
  is(col, val)  {
    // .is('col', null) — nullability check
    if (val === null) { this._filters.push({ col, op: 'IS NULL' }); return this; }
    if (val === 'null') { this._filters.push({ col, op: 'IS NULL' }); return this; }
    this._filters.push({ col, op: '=', val });
    return this;
  }
  in(col, arr) { this._filters.push({ col, op: 'IN', val: Array.isArray(arr) ? arr : [arr] }); return this; }
  ilike(col, pattern) {
    // PostgREST aceita '*' como wildcard; SQL usa '%'
    const p = String(pattern).replace(/\*/g, '%');
    this._filters.push({ col, op: 'ILIKE', val: p });
    return this;
  }
  not(col, op, val) {
    // Suporta a forma usada no codebase: .not('team_name', 'in', '(a,b,c)')
    if (op === 'in' || op === 'IN') {
      let arr;
      if (Array.isArray(val)) {
        arr = val;
      } else {
        // String "(a,b,c)" — limpa parênteses e separa
        arr = String(val).replace(/^\(|\)$/g, '').split(',').map(s => s.trim()).filter(Boolean);
      }
      this._filters.push({ col, op: 'NOT IN', val: arr });
      return this;
    }
    if (op === 'is' && (val === null || val === 'null')) {
      this._filters.push({ col, op: 'IS NOT NULL' });
      return this;
    }
    const map = { eq: '!=', gte: '<', lte: '>', gt: '<=', lt: '>=' };
    if (!map[op]) throw new Error(`pgShim: not(col, '${op}', val) não suportado`);
    this._filters.push({ col, op: map[op], val });
    return this;
  }
  filter(col, op, val) {
    const map = { eq: '=', neq: '!=', gte: '>=', lte: '<=', gt: '>', lt: '<' };
    if (!map[op]) throw new Error(`pgShim: filter(col, '${op}', val) não suportado`);
    this._filters.push({ col, op: map[op], val });
    return this;
  }

  // ── Modificadores ───────────────────────────────────────────────────────
  order(col, opts = {}) {
    this._order.push({ col, asc: opts.ascending !== false });
    return this;
  }
  range(from, to) {
    this._range = { from: Number(from), to: Number(to) };
    return this;
  }
  limit(n) {
    this._limit = Number(n);
    return this;
  }

  // ── Terminadores ────────────────────────────────────────────────────────
  single()      { this._returnMode = 'single';      return this; }
  maybeSingle() { this._returnMode = 'maybeSingle'; return this; }

  // ── Thenable ────────────────────────────────────────────────────────────
  then(onResolve, onReject) {
    return this._execute().then(onResolve, onReject);
  }
  catch(onReject) { return this.then(undefined, onReject); }
  finally(cb) {
    return this.then(
      v => { try { cb && cb(); } catch (_) {} return v; },
      e => { try { cb && cb(); } catch (_) {} throw e; }
    );
  }

  async _execute() {
    try {
      return await this._run();
    } catch (err) {
      // Mantém shape de erro do supabase-js
      return {
        data:  null,
        error: {
          message: err.message || String(err),
          code:    err.code    || null,
          details: err.detail  || null,
          hint:    err.hint    || null,
        },
        count: null,
      };
    }
  }

  async _run() {
    if (!this._op) this._op = 'select';
    const { sql, params } = this._build();
    const pool = _getPool();
    const r = await pool.query(sql, params);

    let data;
    let count = null;

    if (this._op === 'select') {
      data = r.rows;
    } else {
      // mutations: RETURNING * dá as linhas afetadas
      data  = r.rows;
      count = r.rowCount;
    }

    // Terminator single/maybeSingle só faz sentido em select
    if (this._returnMode === 'single') {
      if (!Array.isArray(data) || data.length === 0) {
        const err = new Error('PGRST116: Cannot coerce the result to a single JSON object (0 rows)');
        err.code = 'PGRST116';
        throw err;
      }
      if (data.length > 1) {
        const err = new Error(`PGRST116: Cannot coerce the result to a single JSON object (${data.length} rows)`);
        err.code = 'PGRST116';
        throw err;
      }
      data = data[0];
    } else if (this._returnMode === 'maybeSingle') {
      data = (Array.isArray(data) && data.length > 0) ? data[0] : null;
    }

    return { data, error: null, count };
  }

  _build() {
    const params = [];
    const p = v => { params.push(v); return `$${params.length}`; };
    const T = _id(this._table);
    let sql = '';

    if (this._op === 'select') {
      const cols = this._cols === '*'
        ? '*'
        : this._cols.split(',').map(c => {
            const t = c.trim();
            return (t === '*' || t.includes('(') || t.includes('"')) ? t : _id(t);
          }).join(', ');
      sql = `SELECT ${cols} FROM ${T}`;
      sql += this._whereClause(p);
      if (this._order.length) {
        sql += ' ORDER BY ' + this._order.map(o => `${_id(o.col)} ${o.asc ? 'ASC' : 'DESC'}`).join(', ');
      }
      if (this._range) {
        const lim = this._range.to - this._range.from + 1;
        sql += ` LIMIT ${Math.max(lim, 0)} OFFSET ${Math.max(this._range.from, 0)}`;
      } else if (this._limit != null) {
        sql += ` LIMIT ${this._limit}`;
      }
    }
    else if (this._op === 'insert' || this._op === 'upsert') {
      const rows = this._payload;
      if (!rows || rows.length === 0) {
        // Sem linhas: simula um INSERT no-op. supabase-js retorna data=[].
        return { sql: `SELECT 1 WHERE FALSE`, params: [] };
      }
      // Coleta TODAS as colunas vistas nas linhas (linhas podem ser parciais)
      const cols = [...new Set(rows.flatMap(r => Object.keys(r)))];
      const colSql = cols.map(c => _id(c)).join(', ');
      const values = rows.map(row =>
        '(' + cols.map(c => p(row[c] === undefined ? null : row[c])).join(', ') + ')'
      ).join(', ');
      sql = `INSERT INTO ${T} (${colSql}) VALUES ${values}`;

      if (this._op === 'upsert') {
        const conflictColsRaw = this._onConflict
          ? this._onConflict.split(',').map(s => s.trim())
          : [cols[0]];
        const conflictCols = conflictColsRaw.map(c => _id(c)).join(', ');
        const updateCols = cols.filter(c => !conflictColsRaw.includes(c));
        if (updateCols.length === 0) {
          sql += ` ON CONFLICT (${conflictCols}) DO NOTHING`;
        } else {
          const setSql = updateCols.map(c => `${_id(c)} = EXCLUDED.${_id(c)}`).join(', ');
          sql += ` ON CONFLICT (${conflictCols}) DO UPDATE SET ${setSql}`;
        }
      }
      sql += ' RETURNING *';
    }
    else if (this._op === 'update') {
      const obj = this._payload || {};
      const cols = Object.keys(obj);
      if (cols.length === 0) {
        throw new Error('pgShim: update() chamado com objeto vazio');
      }
      const setSql = cols.map(c => `${_id(c)} = ${p(obj[c])}`).join(', ');
      sql = `UPDATE ${T} SET ${setSql}`;
      sql += this._whereClause(p);
      sql += ' RETURNING *';
    }
    else if (this._op === 'delete') {
      sql = `DELETE FROM ${T}`;
      sql += this._whereClause(p);
      sql += ' RETURNING *';
    }

    return { sql, params };
  }

  _whereClause(p) {
    if (this._filters.length === 0) return '';
    const parts = this._filters.map(f => {
      const col = _id(f.col);
      if (f.op === 'IS NULL' || f.op === 'IS NOT NULL') {
        return `${col} ${f.op}`;
      }
      if (f.op === 'IN' || f.op === 'NOT IN') {
        if (!Array.isArray(f.val) || f.val.length === 0) {
          // Empty IN é "always false"; empty NOT IN é "always true"
          return f.op === 'IN' ? 'FALSE' : 'TRUE';
        }
        const placeholders = f.val.map(v => p(v)).join(', ');
        return `${col} ${f.op} (${placeholders})`;
      }
      return `${col} ${f.op} ${p(f.val)}`;
    });
    return ' WHERE ' + parts.join(' AND ');
  }
}

class Client {
  from(table) { return new Query(table); }
}

module.exports = { Client, Query, _getPool, _setPool, _buildPoolConfig };
