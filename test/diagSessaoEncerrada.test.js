/**
 * test/diagSessaoEncerrada.test.js
 *
 * 19/10/2026 (backlog P0-11 item 3b). O script que escolhe a janela do
 * congelamento de sessão encerrada pelo histórico de snapshots. Só a parte pura.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analisar, janelaQueCobre } = require('../scripts/diag-sessao-encerrada');

const L = (min, sid, fim, ass) => ({
  captured_at: new Date(Date.parse('2026-10-19T19:00:00Z') + min * 60_000).toISOString(),
  sid, team_name: 'GUA1', sector_id: 'DESG', session_end: fim ? '2026-10-19T16:00:00' : null, assinatura: ass,
});

test('sessão que não muda depois de encerrada não conta', () => {
  const r = analisar([L(0, 's1', false, 'a#'), L(15, 's1', true, 'a,b#'), L(30, 's1', true, 'a,b#')]);
  assert.equal(r.encerradas, 1);
  assert.equal(r.mudaram, 0);
});

test('mede o atraso da ÚLTIMA mudança a partir do 1º ciclo encerrado', () => {
  const r = analisar([
    L(0, 's1', true, 'a#'), L(15, 's1', true, 'a,b#'), L(30, 's1', true, 'a,b#'), L(75, 's1', true, 'a,b#c'),
  ]);
  assert.equal(r.mudaram, 1);
  assert.deepEqual(r.atrasosMin, [75]);
  assert.equal(r.exemplos[0].atrasoMin, 75);
});

test('reaberta para a contagem e é listada à parte', () => {
  const r = analisar([L(0, 's1', true, 'a#'), L(15, 's1', false, 'a,b#'), L(30, 's1', true, 'a,b,c#')]);
  assert.equal(r.reabertas, 1);
  assert.equal(r.mudaram, 0);
});

test('sessão nunca encerrada fica fora', () => {
  const r = analisar([L(0, 's1', false, 'a#'), L(15, 's1', false, 'b#')]);
  assert.equal(r.encerradas, 0);
});

test('janelaQueCobre: menor faixa ≥ máximo', () => {
  assert.equal(janelaQueCobre([]), 0);
  assert.equal(janelaQueCobre([10, 14]), 15);
  assert.equal(janelaQueCobre([61]), 90);
  assert.equal(janelaQueCobre([300]), 300);
});
