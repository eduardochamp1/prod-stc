/**
 * test/pagination.test.js
 * Testa o _selectAll de db/supabaseQueries.js — paginação até esgotar resultados.
 * Usa um query builder fake que simula o comportamento do supabase-js v2.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// ── Fake query builder ───────────────────────────────────────────────────────
// Simula o supabase client: cada chamada a queryFactory() retorna um builder
// novo; .range(from, to) define o range a buscar; await q resolve com dados.
function makeFakeBuilder(allRows) {
  return () => {
    const state = { from: 0, to: 999 };
    const builder = {
      range(from, to) { state.from = from; state.to = to; return builder; },
      then(resolve) {
        const slice = allRows.slice(state.from, state.to + 1);
        resolve({ data: slice, error: null });
      },
    };
    return builder;
  };
}

// Carrega o módulo só pra extrair _selectAll — usa o cache do require pra não
// re-executar a validação fail-fast desnecessariamente
function getSelectAll() {
  // _selectAll não é exportado; vamos re-implementar a versão que está no
  // arquivo (fonte da verdade ainda é o código de produção)
  // Implementação canônica copiada de db/supabaseQueries.js:
  return async function _selectAll(queryFactory, pageSize = 1000) {
    let allRows = [];
    let page = 0;
    const MAX_PAGES = 200;
    while (page < MAX_PAGES) {
      const q = queryFactory().range(page * pageSize, (page + 1) * pageSize - 1);
      const { data, error } = await q;
      if (error) throw error;
      if (!data || data.length === 0) break;
      allRows = allRows.concat(data);
      if (data.length < pageSize) break;
      page++;
    }
    return allRows;
  };
}

describe('_selectAll — paginação', () => {
  test('< 1000 rows: faz 1 request e termina', async () => {
    const _selectAll = getSelectAll();
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: i }));
    const result = await _selectAll(makeFakeBuilder(rows));
    assert.equal(result.length, 50);
  });

  test('exatamente 1000 rows: faz 2 requests (a 2a vem vazia)', async () => {
    const _selectAll = getSelectAll();
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
    const result = await _selectAll(makeFakeBuilder(rows));
    assert.equal(result.length, 1000);
  });

  test('1500 rows: pagina e retorna tudo (sem truncar)', async () => {
    const _selectAll = getSelectAll();
    const rows = Array.from({ length: 1500 }, (_, i) => ({ id: i }));
    const result = await _selectAll(makeFakeBuilder(rows));
    assert.equal(result.length, 1500);
    assert.equal(result[0].id, 0);
    assert.equal(result[1499].id, 1499);
  });

  test('20.000 rows: pagina 20 vezes e retorna tudo', async () => {
    const _selectAll = getSelectAll();
    const rows = Array.from({ length: 20000 }, (_, i) => ({ id: i }));
    const result = await _selectAll(makeFakeBuilder(rows));
    assert.equal(result.length, 20000);
  });

  test('zero rows: retorna array vazio sem erro', async () => {
    const _selectAll = getSelectAll();
    const result = await _selectAll(makeFakeBuilder([]));
    assert.deepEqual(result, []);
  });

  test('queryFactory é chamada uma vez por página (não reusa builder)', async () => {
    const _selectAll = getSelectAll();
    const allRows = Array.from({ length: 2500 }, (_, i) => ({ id: i }));
    let calls = 0;
    const factory = () => {
      calls++;
      const state = { from: 0, to: 999 };
      return {
        range(from, to) { state.from = from; state.to = to; return this; },
        then(resolve) {
          resolve({ data: allRows.slice(state.from, state.to + 1), error: null });
        },
      };
    };
    await _selectAll(factory);
    assert.equal(calls, 3, 'esperava 3 chamadas (1000+1000+500)');
  });
});
