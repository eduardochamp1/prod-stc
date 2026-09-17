/**
 * test/teamsCurrentJsonbPath.test.js
 *
 * Trava a regressão do getTeamsCurrent reportada em 17/09/2026.
 *
 * SINTOMA: a aba Admin → "SAÚDE DO SISTEMA" mostrava `0/138 (GUA 0 · CAC 0)`
 * logaram hoje e `último snapshot: sem dados`, enquanto a coleta estava
 * perfeita no mesmo instante (snapshot_last_ok: teams 146, ghosts 0,
 * sectors_failed []) e teams_current tinha 117 linhas de 4 minutos antes.
 *
 * CAUSA: `db/queries.js` filtrava por `'data->>date'` — chave do jsonb SEM
 * aspas. O _id() do pgShim devolve a string crua quando contém `->`, então o
 * SQL saía `WHERE data->>date >= $1`, e o Postgres lia o `date` solto como
 * coluna (`ERROR: column "date" does not exist`). getTeamsCurrent estourava e
 * os chamadores exibiam ZERO, não erro.
 *
 * A forma sem aspas era válida no Supabase/PostgREST (onde a linha nasceu, em
 * 27/04/2026); quebrou na migração pro pgShim (25/05/2026, 8217da4).
 *
 * Estes testes rodam SEM Postgres: injetam um pool fake no pgShim e inspecionam
 * o SQL gerado. Rode: node --test test/teamsCurrentJsonbPath.test.js
 */

const { test } = require('node:test');
const assert   = require('node:assert');

// dbClient exige DATABASE_URL no _init(); o pool real nunca é usado porque
// _setPool() abaixo substitui o pool do pgShim antes de qualquer query.
process.env.DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://test:test@localhost:5432/test';

const { _setPool, Client } = require('../services/pgShim');
const { getTeamsCurrent }  = require('../db/queries');

/** Pool fake: captura as queries e devolve rows pré-definidos. */
function mockPool(rows = []) {
  const calls = [];
  _setPool({
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows, rowCount: rows.length };
    },
    on: () => {},
  });
  return calls;
}

// Sigla presente na whitelist hardcoded de fallback (services/equipesOficiais).
// Usar uma sigla real importa: getTeamsCurrent filtra por isOficial() no fim.
const SIGLA_OFICIAL = 'EBGPR62';

function linhaTeamsCurrent() {
  return {
    data: {
      teamName: SIGLA_OFICIAL,
      sigla:    SIGLA_OFICIAL,
      regional: 'GUA',
      date:     new Date().toISOString().slice(0, 10),
    },
    regional:   'GUA',
    updated_at: new Date().toISOString(),
  };
}

test('getTeamsCurrent filtra por data->>\'date\' — chave do jsonb COM aspas', async () => {
  const calls = mockPool([linhaTeamsCurrent()]);
  await getTeamsCurrent({});

  assert.equal(calls.length, 1, 'esperava exatamente 1 query');
  assert.ok(
    calls[0].sql.includes("data->>'date'"),
    `SQL deveria conter data->>'date' (com aspas). SQL gerado:\n${calls[0].sql}`
  );
});

test('o SQL NÃO contém a forma sem aspas que o Postgres recusa', async () => {
  const calls = mockPool([linhaTeamsCurrent()]);
  await getTeamsCurrent({});

  // `data->>date` (sem aspas) faz o Postgres procurar uma COLUNA chamada date,
  // que teams_current não tem: team_name, regional, sector_id, data, updated_at.
  assert.ok(
    !/data->>date\b/.test(calls[0].sql),
    `SQL voltou à forma sem aspas — o defeito de 17/09/2026. SQL:\n${calls[0].sql}`
  );
});

test('getTeamsCurrent devolve as equipes em vez de estourar', async () => {
  mockPool([linhaTeamsCurrent()]);
  const teams = await getTeamsCurrent({});

  // Antes do fix esta chamada lançava o erro do Postgres (via `if (error) throw`),
  // e o /admin/health traduzia o throw em "0 logaram hoje".
  assert.equal(teams.length, 1);
  assert.equal(teams[0].sigla, SIGLA_OFICIAL);
});

test('a `regional` sobrevive ao map(row => row.data) — o card por regional depende dela', async () => {
  mockPool([linhaTeamsCurrent()]);
  const teams = await getTeamsCurrent({});

  // getTeamsCurrent devolve row.data (o jsonb), descartando a COLUNA regional.
  // O /admin/health conta byRegional[t.regional], então o dado precisa estar
  // dentro do jsonb — o dataWriter grava `data: t` com o objeto inteiro da
  // equipe, e é por isso que funciona. Se alguém passar a gravar só um subset,
  // o `(GUA 0 · CAC 0)` volta silenciosamente.
  assert.equal(teams[0].regional, 'GUA');
});

test('contraste: a forma sem aspas gera o SQL que o Postgres recusa', () => {
  // Documenta o mecanismo — _id() do pgShim passa a string crua quando vê `->`.
  const sb = new Client();
  const q  = sb.from('teams_current')
               .select('data, regional, updated_at')
               .filter('data->>date', 'gte', '2026-09-10');
  const { sql } = q._build();

  assert.ok(
    sql.includes('data->>date'),
    'o pgShim passa o path cru — é por isso que a chave precisa das aspas na origem'
  );
});
