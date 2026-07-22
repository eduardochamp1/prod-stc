/**
 * test/pgShim.test.js
 *
 * Testa a geração de SQL do pgShim sem precisar de Postgres real —
 * injeta um Pool fake que captura a query e retorna rows mockados.
 *
 * Rode: node --test test/pgShim.test.js
 */

const { test } = require('node:test');
const assert   = require('node:assert');
const { Client, _setPool, _buildPoolConfig } = require('../services/pgShim');

/**
 * Fake pool: registra a última query executada e retorna rows pré-definidos.
 * O segundo argumento de mockPool() pode ser uma função(sql, params)=>rows.
 */
function mockPool(rowsOrFn) {
  const calls = [];
  _setPool({
    query: async (sql, params) => {
      calls.push({ sql, params });
      const rows = typeof rowsOrFn === 'function' ? rowsOrFn(sql, params) : rowsOrFn;
      return { rows: rows || [], rowCount: (rows || []).length };
    },
    on: () => {},
  });
  return calls;
}

const sb = new Client();

// ── SELECT ──────────────────────────────────────────────────────────────────

test('select * básico', async () => {
  const calls = mockPool([{ id: 1 }]);
  const { data, error } = await sb.from('teams_current').select();
  assert.equal(error, null);
  assert.deepEqual(data, [{ id: 1 }]);
  assert.equal(calls[0].sql, 'SELECT * FROM "teams_current"');
});

test('select com colunas específicas', async () => {
  const calls = mockPool([]);
  await sb.from('snapshots').select('team_name, regional, date');
  assert.equal(calls[0].sql, 'SELECT "team_name", "regional", "date" FROM "snapshots"');
});

test('select com eq', async () => {
  const calls = mockPool([]);
  await sb.from('metas').select().eq('regional', 'GUA');
  assert.equal(calls[0].sql, 'SELECT * FROM "metas" WHERE "regional" = $1');
  assert.deepEqual(calls[0].params, ['GUA']);
});

test('select com múltiplos filtros eq + gte + lte', async () => {
  const calls = mockPool([]);
  await sb.from('team_daily_totals')
    .select('count')
    .eq('regional', 'CAC')
    .gte('date', '2026-05-01')
    .lte('date', '2026-05-25');
  assert.equal(
    calls[0].sql,
    'SELECT "count" FROM "team_daily_totals" WHERE "regional" = $1 AND "date" >= $2 AND "date" <= $3'
  );
  assert.deepEqual(calls[0].params, ['CAC', '2026-05-01', '2026-05-25']);
});

test('select com in', async () => {
  const calls = mockPool([]);
  await sb.from('snapshots').select().in('team_name', ['EPGPR30', 'ECPIU50']);
  assert.equal(calls[0].sql, 'SELECT * FROM "snapshots" WHERE "team_name" IN ($1, $2)');
  assert.deepEqual(calls[0].params, ['EPGPR30', 'ECPIU50']);
});

test('in vazio → FALSE (matches PostgREST)', async () => {
  const calls = mockPool([]);
  await sb.from('snapshots').select().in('team_name', []);
  assert.equal(calls[0].sql, 'SELECT * FROM "snapshots" WHERE FALSE');
});

test('select com order + range', async () => {
  const calls = mockPool([]);
  await sb.from('snapshots').select()
    .order('captured_at', { ascending: false })
    .range(1000, 1999);
  assert.equal(
    calls[0].sql,
    'SELECT * FROM "snapshots" ORDER BY "captured_at" DESC LIMIT 1000 OFFSET 1000'
  );
});

test('select com ilike (wildcards traduzidos)', async () => {
  const calls = mockPool([]);
  await sb.from('teams_current').select().ilike('team_name', 'ECG*');
  assert.equal(calls[0].sql, 'SELECT * FROM "teams_current" WHERE "team_name" ILIKE $1');
  assert.deepEqual(calls[0].params, ['ECG%']);
});

test('not in com string parêntese (padrão do projeto)', async () => {
  const calls = mockPool([]);
  await sb.from('teams_current').delete()
    .not('team_name', 'in', '(EPGPR30,ECPIU50)');
  assert.equal(
    calls[0].sql,
    'DELETE FROM "teams_current" WHERE "team_name" NOT IN ($1, $2) RETURNING *'
  );
  assert.deepEqual(calls[0].params, ['EPGPR30', 'ECPIU50']);
});

test('single() em 1 row → objeto', async () => {
  mockPool([{ regional: 'GUA', count: 42 }]);
  const { data, error } = await sb.from('metas').select().eq('regional', 'GUA').single();
  assert.equal(error, null);
  assert.deepEqual(data, { regional: 'GUA', count: 42 });
});

test('single() em 0 rows → erro PGRST116', async () => {
  mockPool([]);
  const { data, error } = await sb.from('metas').select().eq('regional', 'X').single();
  assert.equal(data, null);
  assert.equal(error.code, 'PGRST116');
  assert.match(error.message, /0 rows/);
});

test('maybeSingle() em 0 rows → null sem erro', async () => {
  mockPool([]);
  const { data, error } = await sb.from('metas').select().eq('regional', 'X').maybeSingle();
  assert.equal(error, null);
  assert.equal(data, null);
});

// ── INSERT ──────────────────────────────────────────────────────────────────

test('insert single row', async () => {
  const calls = mockPool([{ id: 1 }]);
  await sb.from('snapshots').insert({ team_name: 'EPGPR30', date: '2026-05-25' });
  assert.equal(
    calls[0].sql,
    'INSERT INTO "snapshots" ("team_name", "date") VALUES ($1, $2) RETURNING *'
  );
  assert.deepEqual(calls[0].params, ['EPGPR30', '2026-05-25']);
});

test('insert múltiplas rows com colunas parciais (union de keys)', async () => {
  const calls = mockPool([]);
  await sb.from('team_daily_totals').insert([
    { date: '2026-05-25', team_name: 'A', count: 5 },
    { date: '2026-05-25', team_name: 'B', count: 7, regional: 'GUA' },
  ]);
  // A coluna `regional` só está na 2ª linha → primeira recebe NULL na coluna ausente
  assert.match(calls[0].sql, /INSERT INTO "team_daily_totals" \("date", "team_name", "count", "regional"\) VALUES \(\$1, \$2, \$3, \$4\), \(\$5, \$6, \$7, \$8\) RETURNING \*/);
  assert.deepEqual(calls[0].params, ['2026-05-25', 'A', 5, null, '2026-05-25', 'B', 7, 'GUA']);
});

// ── UPSERT ──────────────────────────────────────────────────────────────────

test('upsert com onConflict single col', async () => {
  const calls = mockPool([]);
  await sb.from('metas').upsert({ regional: 'GUA', data: { x: 1 } }, { onConflict: 'regional' });
  assert.match(
    calls[0].sql,
    /INSERT INTO "metas" \("regional", "data"\) VALUES \(\$1, \$2\) ON CONFLICT \("regional"\) DO UPDATE SET "data" = EXCLUDED\."data" RETURNING \*/
  );
});

test('upsert com onConflict multi-col', async () => {
  const calls = mockPool([]);
  await sb.from('team_daily_totals').upsert(
    [{ date: '2026-05-25', team_name: 'A', tipo_code: 'MD', count: 3 }],
    { onConflict: 'date,team_name,tipo_code' }
  );
  assert.match(
    calls[0].sql,
    /ON CONFLICT \("date", "team_name", "tipo_code"\) DO UPDATE SET "count" = EXCLUDED\."count" RETURNING \*/
  );
});

// ── UPDATE ──────────────────────────────────────────────────────────────────

test('update com where eq', async () => {
  const calls = mockPool([]);
  await sb.from('snapshots').update({ data: { foo: 1 } }).eq('id', 'uuid-123');
  assert.equal(
    calls[0].sql,
    'UPDATE "snapshots" SET "data" = $1 WHERE "id" = $2 RETURNING *'
  );
  assert.deepEqual(calls[0].params, [{ foo: 1 }, 'uuid-123']);
});

// ── DELETE ──────────────────────────────────────────────────────────────────

test('delete com count exact retorna count', async () => {
  mockPool([{ id: 1 }, { id: 2 }, { id: 3 }]);
  const { error, count } = await sb.from('snapshots').delete({ count: 'exact' }).lt('date', '2026-01-01');
  assert.equal(error, null);
  assert.equal(count, 3);
});

test('delete com in array', async () => {
  const calls = mockPool([]);
  await sb.from('note_subcategorias').delete().in('note_id', ['a', 'b', 'c']);
  assert.equal(
    calls[0].sql,
    'DELETE FROM "note_subcategorias" WHERE "note_id" IN ($1, $2, $3) RETURNING *'
  );
});

// ── ERROR HANDLING ──────────────────────────────────────────────────────────

test('erro de query é envelopado em { error }, não rejeita promise', async () => {
  _setPool({
    query: async () => { const e = new Error('relation not exist'); e.code = '42P01'; throw e; },
    on: () => {},
  });
  const res = await sb.from('lol').select();
  assert.equal(res.data, null);
  assert.equal(res.error.code, '42P01');
  assert.match(res.error.message, /relation not exist/);
});

// ── POOL CONFIG / statement_timeout (P2-6) ──────────────────────────────────
// _buildPoolConfig é pura: monta o config do new Pool() sem conectar. Trava o
// contrato do statement_timeout (aborta query > N ms → protege as conexões).

test('statement_timeout: default 60s presente no options do pool', () => {
  const cfg = _buildPoolConfig({ DATABASE_URL: 'postgresql://u:p@localhost:5432/db' });
  assert.equal(cfg.options, '-c statement_timeout=60000');
});

test('statement_timeout: PG_STATEMENT_TIMEOUT_MS customizado é respeitado', () => {
  const cfg = _buildPoolConfig({
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    PG_STATEMENT_TIMEOUT_MS: '90000',
  });
  assert.equal(cfg.options, '-c statement_timeout=90000');
});

test('statement_timeout: 0 desliga (sem options) — escape hatch p/ backfill', () => {
  const cfg = _buildPoolConfig({
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    PG_STATEMENT_TIMEOUT_MS: '0',
  });
  assert.equal(cfg.options, undefined, 'sem statement_timeout quando 0');
});

test('_buildPoolConfig: sem DATABASE_URL lança erro claro', () => {
  assert.throws(() => _buildPoolConfig({}), /DATABASE_URL não configurada/);
});

test('_buildPoolConfig: PG_POOL_MAX / PG_IDLE_MS / SSL respeitados', () => {
  const cfg = _buildPoolConfig({
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    PG_POOL_MAX: '20', PG_IDLE_MS: '15000', PG_SSL: 'true',
  });
  assert.equal(cfg.max, 20);
  assert.equal(cfg.idleTimeoutMillis, 15000);
  assert.deepEqual(cfg.ssl, { rejectUnauthorized: false });
});
