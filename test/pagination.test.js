/**
 * test/pagination.test.js
 * Testa o _selectAll de db/queries.js — paginação até esgotar resultados E o
 * tie-breaker de ordem TOTAL (P2-5): sem uma chave única como última ordem, a
 * fronteira de página pode duplicar/sumir linhas quando o cron insere ~60
 * equipes com o mesmo captured_at (ou agregados empatam em `date`).
 *
 * IMPORTANTE: importa o _selectAll REAL de db/queries.js (não uma cópia) — assim
 * o teste trava o comportamento de produção, não uma reimplementação que pode
 * driftar. Requer db/queries.js apenas emite um warning de cache (sem DB) no
 * load; nenhum acesso a banco acontece (o query builder é 100% fake).
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { _selectAll } = require('../db/queries');

// ── Fake query builder ───────────────────────────────────────────────────────
// Simula o supabase client / pgShim: cada queryFactory() retorna um builder
// novo; .order(col) registra a chave de ordenação (na ordem chamada); .range()
// define a janela; await resolve aplicando o ORDER BY (todas as chaves) e depois
// fatiando — exatamente como o banco faria. Isso deixa o tie-breaker IMPORTAR
// para a estabilidade da paginação, não só para o SQL emitido.
function makeFakeFactory(allRows, orderLog = []) {
  return () => {
    const state = { from: 0, to: 999, orders: [] };
    const builder = {
      order(col, opts = {}) {
        state.orders.push({ col, asc: opts.ascending !== false });
        orderLog.push(col);
        return builder;
      },
      range(from, to) { state.from = from; state.to = to; return builder; },
      then(resolve) {
        const sorted = [...allRows].sort((a, b) => {
          for (const { col, asc } of state.orders) {
            if (a[col] < b[col]) return asc ? -1 : 1;
            if (a[col] > b[col]) return asc ? 1 : -1;
          }
          return 0;
        });
        resolve({ data: sorted.slice(state.from, state.to + 1), error: null });
      },
    };
    return builder;
  };
}

describe('_selectAll — paginação', () => {
  test('< 1000 rows: faz 1 request e termina', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: i }));
    const result = await _selectAll(makeFakeFactory(rows));
    assert.equal(result.length, 50);
  });

  test('exatamente 1000 rows: faz 2 requests (a 2a vem vazia)', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
    const result = await _selectAll(makeFakeFactory(rows));
    assert.equal(result.length, 1000);
  });

  test('1500 rows: pagina e retorna tudo (sem truncar)', async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({ id: i }));
    const result = await _selectAll(makeFakeFactory(rows));
    assert.equal(result.length, 1500);
    assert.equal(result[0].id, 0);
    assert.equal(result[1499].id, 1499);
  });

  test('20.000 rows: pagina 20 vezes e retorna tudo', async () => {
    const rows = Array.from({ length: 20000 }, (_, i) => ({ id: i }));
    const result = await _selectAll(makeFakeFactory(rows));
    assert.equal(result.length, 20000);
  });

  test('zero rows: retorna array vazio sem erro', async () => {
    const result = await _selectAll(makeFakeFactory([]));
    assert.deepEqual(result, []);
  });

  test('queryFactory é chamada uma vez por página (não reusa builder)', async () => {
    const allRows = Array.from({ length: 2500 }, (_, i) => ({ id: i }));
    let calls = 0;
    const factory = () => {
      calls++;
      const state = { from: 0, to: 999 };
      return {
        order() { return this; },
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

describe('_selectAll — tie-breaker de ordem total (P2-5)', () => {
  test('aplica tie-breaker "id" por padrão em CADA página', async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => ({ id: i }));
    const orderLog = [];
    await _selectAll(makeFakeFactory(rows, orderLog));
    // 3 páginas (1000+1000+500) → .order('id') chamado 1x por página
    assert.deepEqual(orderLog, ['id', 'id', 'id']);
  });

  test('tie-breaker é a ÚLTIMA chave (após a ordem própria do factory)', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: i, captured_at: 'x' }));
    const orderLog = [];
    // factory que já ordena por captured_at DESC antes de devolver
    const base = makeFakeFactory(rows, orderLog);
    const factory = () => base().order('captured_at', { ascending: false });
    await _selectAll(factory);
    // 1 página → captured_at (do factory) e depois id (do _selectAll)
    assert.deepEqual(orderLog, ['captured_at', 'id']);
  });

  test('tieBreaker customizado é respeitado (note_rejections → note_id)', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ note_id: `u${i}` }));
    const orderLog = [];
    await _selectAll(makeFakeFactory(rows, orderLog), 1000, 'note_id');
    assert.deepEqual(orderLog, ['note_id']);
  });

  test('tieBreaker=null desliga o desempate (escape hatch)', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: i }));
    const orderLog = [];
    await _selectAll(makeFakeFactory(rows, orderLog), 1000, null);
    assert.deepEqual(orderLog, [], 'nenhum .order() adicionado');
  });

  test('paginação ESTÁVEL com captured_at todos iguais: cada UUID 1x, sem perda', async () => {
    // 2500 notas no MESMO captured_at (simula batch de ~60 equipes ×N), ids
    // embaralhados. Sem tie-breaker, a fronteira de página (1000) poderia
    // duplicar/sumir linhas; com ORDER BY captured_at DESC, id ASC é estável.
    const ids = Array.from({ length: 2500 }, (_, i) => i);
    // embaralha de forma determinística (sem Math.random): inverte metades
    const shuffled = [...ids.slice(1250).reverse(), ...ids.slice(0, 1250).reverse()];
    const rows = shuffled.map(id => ({ id, captured_at: '2026-07-22T08:00:00' }));
    const base = makeFakeFactory(rows);
    const factory = () => base().order('captured_at', { ascending: false });
    const result = await _selectAll(factory);
    const seen = new Set(result.map(r => r.id));
    assert.equal(result.length, 2500, 'nenhuma linha perdida nem duplicada');
    assert.equal(seen.size, 2500, 'todos os UUIDs distintos presentes 1x');
    // ordem final estável: id ASC (captured_at empata em todos)
    assert.equal(result[0].id, 0);
    assert.equal(result[2499].id, 2499);
  });
});
