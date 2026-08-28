/**
 * test/janelaHistorico.test.js
 *
 * 28/08/2026 — P1-41. Antes disso, `/historico/sessoes` com intervalo largo
 * truncava em 200k linhas e devolvia produção ZERO nos dias mais ANTIGOS do
 * período (a ordem era `captured_at DESC`, então o corte comia o começo).
 *
 * Medido na VM: julho tem 243.113 linhas em `snapshots` e a consulta usa ~4.340
 * (31 dias × ~140 equipes) — ou seja, a consulta MENSAL de julho já vinha
 * truncada. O conserto foi mover a redução pro SQL (DISTINCT ON), não pôr teto
 * de janela: com a taxa real medida (6.200–7.800 linhas/dia), um teto que
 * couberia no limite do `_selectAll` (≤24 dias) quebraria a consulta mensal.
 *
 * Estes testes travam as três coisas:
 *   1. `_selectAll` estoura em vez de devolver array truncado;
 *   2. `getTeamSessionHistory` faz UMA query com DISTINCT ON (a redução está no
 *      banco, não em JS) e continua aplicando a regra "mais recente por
 *      (date, team_name)";
 *   3. `_checkJanela` recusa data irreal e intervalo invertido.
 */

const test = require('node:test');
const assert = require('node:assert');

const pgShim = require('../services/pgShim');

// As equipes usadas aqui (EBGPR62, ECACH50) são nomes REAIS da whitelist de
// fallback do equipesOficiais (75 siglas). Precisam ser reais porque
// getTeamSessionHistory aplica _onlyOficiais — com nomes fictícios o teste
// passaria a medir o filtro de whitelist em vez da query.

// ─────────────────────────────────────────────────────────────────────────────
// 1. _selectAll estoura ao bater MAX_PAGES
// ─────────────────────────────────────────────────────────────────────────────

test('_selectAll: estoura RANGE_TOO_LARGE ao bater MAX_PAGES', async () => {
  const { _selectAll } = require('../db/queries');

  // Fábrica de query falsa que SEMPRE devolve página cheia — força o loop até o
  // teto de 200 páginas. Imita só o que o _selectAll usa: .order() e .range().
  let paginas = 0;
  const cheia = { data: Array.from({ length: 1000 }, (_, i) => ({ id: i })), error: null };
  const fakeQuery = () => {
    const q = {
      order: () => q,
      range: () => { paginas++; return q; },
      then: (resolve) => resolve(cheia),
    };
    return q;
  };

  await assert.rejects(
    () => _selectAll(fakeQuery, 1000, 'id'),
    (err) => {
      assert.equal(err.code, 'RANGE_TOO_LARGE');
      assert.match(err.message, /intervalo grande demais/i);
      return true;
    },
    'devia estourar em vez de devolver array truncado',
  );
  assert.equal(paginas, 200, 'devia parar exatamente no MAX_PAGES');
});

test('_selectAll: intervalo que cabe devolve tudo, sem estourar', async () => {
  const { _selectAll } = require('../db/queries');
  let chamadas = 0;
  const fakeQuery = () => {
    const q = {
      order: () => q,
      range: () => q,
      then: (resolve) => {
        chamadas++;
        // 1ª página cheia, 2ª parcial → o loop encerra por data.length < pageSize
        resolve(chamadas === 1
          ? { data: Array.from({ length: 1000 }, (_, i) => ({ id: i })), error: null }
          : { data: [{ id: 9001 }], error: null });
      },
    };
    return q;
  };
  const rows = await _selectAll(fakeQuery, 1000, 'id');
  assert.equal(rows.length, 1001);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. getTeamSessionHistory reduz no SQL
// ─────────────────────────────────────────────────────────────────────────────

test('getTeamSessionHistory: usa DISTINCT ON e uma única query', async () => {
  // _getPool() estoura sem DATABASE_URL (pgShim.js:51). Restauramos com null:
  // o próximo _getPool() volta a reconstruir do ambiente, como antes do teste.
  const sqls = [];
  pgShim._setPool({
    query: async (sql, params) => {
      sqls.push({ sql, params });
      return {
        rows: [
          // duas linhas da MESMA equipe/dia não deveriam nem chegar aqui (o
          // DISTINCT ON resolve no banco), mas se chegarem o dedup em JS ainda
          // segura — é o cinto e suspensório documentado na função.
          { team_name: 'EBGPR62', regional: 'GUA', sector_id: 'DESG',
            date: '2026-07-15', captured_at: '2026-07-15T20:00:00Z',
            data: { notasConcluidas: [{ tipoCode: 'MD' }, { tipoCode: 'SF' }],
                    notasExecutadas: [], sessionBegin: '2026-07-15T07:00:00Z' } },
          { team_name: 'ECACH50', regional: 'GUA', sector_id: 'DESG',
            date: '2026-07-15', captured_at: '2026-07-15T20:00:00Z',
            data: { notasConcluidas: [{ tipoCode: 'MD' }], notasExecutadas: [] } },
        ],
      };
    },
  });

  try {
    const { getTeamSessionHistory } = require('../db/queries');
    const dias = await getTeamSessionHistory('2026-07-01', '2026-07-31', null, ['GUA']);

    assert.equal(sqls.length, 1, 'uma query só — sem paginação de 243k linhas');
    const sql = sqls[0].sql.replace(/\s+/g, ' ');
    assert.match(sql, /DISTINCT ON \(s\.date, s\.team_name\)/,
      'a redução tem de estar no SQL');
    assert.match(sql, /ORDER BY s\.date, s\.team_name, s\.captured_at DESC/,
      'sem esta ordem o DISTINCT ON escolheria linha arbitrária');
    assert.ok(sqls[0].params.includes('2026-07-01'));
    assert.ok(sqls[0].params.includes('GUA'), 'o filtro de regional tem de ir pro banco');

    // Forma do retorno preservada: lista de dias, cada um com equipes.
    assert.equal(dias.length, 1);
    assert.equal(dias[0].date, '2026-07-15');
    assert.equal(dias[0].equipes.length, 2);
    assert.equal(dias[0].equipes[0].team_name, 'EBGPR62');
    assert.equal(dias[0].equipes[0].total, 2);
    assert.deepEqual(dias[0].equipes[0].por_tipo, { MD: 1, SF: 1 });
  } finally {
    pgShim._setPool(null);
  }
});

test('getTeamSessionHistory: filtro de equipe vai pro SQL, não pra memória', async () => {
  // _getPool() estoura sem DATABASE_URL (pgShim.js:51). Restauramos com null:
  // o próximo _getPool() volta a reconstruir do ambiente, como antes do teste.
  const sqls = [];
  pgShim._setPool({
    query: async (sql, params) => { sqls.push({ sql, params }); return { rows: [] }; },
  });
  try {
    const { getTeamSessionHistory } = require('../db/queries');
    await getTeamSessionHistory('2026-07-01', '2026-07-31', 'EBGPR62', ['GUA']);
    assert.match(sqls[0].sql, /s\.team_name = \$/);
    assert.ok(sqls[0].params.includes('EBGPR62'));
  } finally {
    pgShim._setPool(null);
  }
});

test('getTeamSessionHistory: team="ALL" NÃO vira filtro', async () => {
  // _getPool() estoura sem DATABASE_URL (pgShim.js:51). Restauramos com null:
  // o próximo _getPool() volta a reconstruir do ambiente, como antes do teste.
  const sqls = [];
  pgShim._setPool({
    query: async (sql, params) => { sqls.push({ sql, params }); return { rows: [] }; },
  });
  try {
    const { getTeamSessionHistory } = require('../db/queries');
    await getTeamSessionHistory('2026-07-01', '2026-07-31', 'ALL', ['GUA']);
    assert.ok(!sqls[0].sql.includes('s.team_name ='), '"ALL" significa todas');
    assert.ok(!sqls[0].params.includes('ALL'));
  } finally {
    pgShim._setPool(null);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. _checkJanela
// ─────────────────────────────────────────────────────────────────────────────

const { _checkJanela } = require('../routes/index');

/** `res` mínimo: registra status e corpo do primeiro json(). */
function fakeRes() {
  const r = { statusCode: null, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

test('_checkJanela: intervalo normal passa', () => {
  const res = fakeRes();
  assert.equal(_checkJanela({}, res, '2026-08-01', '2026-08-28'), true);
  assert.equal(res.statusCode, null, 'não devia responder nada');
});

test('_checkJanela: intervalo longo PASSA — o teto de dias foi descartado de propósito', () => {
  // A auditoria propôs teto de 45 dias. A medição na VM mostrou que 45 dias são
  // ~353k linhas (acima do teto do _selectAll) e que um teto que caberia (≤24
  // dias) quebraria a consulta mensal. O DISTINCT ON tornou o teto desnecessário:
  // 240 dias × ~140 equipes ≈ 33.600 linhas.
  const res = fakeRes();
  assert.equal(_checkJanela({}, res, '2026-01-01', '2026-08-28'), true);
  assert.equal(res.statusCode, null);
});

test('_checkJanela: "ate" anterior a "de" é recusado', () => {
  const res = fakeRes();
  assert.equal(_checkJanela({}, res, '2026-08-28', '2026-08-01'), false);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /invertido/i);
});

test('_checkJanela: data que passa no regex mas não existe é recusada', () => {
  // `9999-99-99` casa com ^\d{4}-\d{2}-\d{2}$ e chegava no Postgres como data
  // inválida — 500 opaco em vez de 400 explicativo.
  const res = fakeRes();
  assert.equal(_checkJanela({}, res, '2026-01-01', '9999-99-99'), false);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /Data inválida/i);
});

test('_checkJanela: mesmo dia nos dois lados passa', () => {
  const res = fakeRes();
  assert.equal(_checkJanela({}, res, '2026-08-28', '2026-08-28'), true);
  assert.equal(res.statusCode, null);
});
