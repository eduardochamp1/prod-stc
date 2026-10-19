/**
 * test/diagSessaoEncerrada.test.js
 *
 * 19/10/2026 (backlog P0-11 item 3b). O script que escolhe a janela do
 * congelamento de sessão encerrada pelo histórico de snapshots. Só a parte pura.
 * Versão 2: falha de coleta (bucket vazio) não conta como mudança, e a régua é
 * o valor FINAL do dia.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analisar, janelaQueCobre } = require('../scripts/diag-sessao-encerrada');

const L = (min, sid, fim, exec, rej = '') => ({
  captured_at: new Date(Date.parse('2026-10-19T19:00:00Z') + min * 60_000).toISOString(),
  sid, team_name: 'GUA1', sector_id: 'DESG', session_end: fim ? '2026-10-19T16:00:00' : null, exec, rej,
});

test('sessão que não muda depois de encerrada não conta', () => {
  const r = analisar([L(0, 's1', false, 'a'), L(15, 's1', true, 'a,b'), L(30, 's1', true, 'a,b')]);
  assert.equal(r.encerradas, 1);
  assert.equal(r.mudaram, 0);
});

test('mede quando chegou no valor FINAL, e diz o que mudou', () => {
  const r = analisar([
    L(0, 's1', true, 'a'), L(15, 's1', true, 'a,b'), L(30, 's1', true, 'a,b'), L(75, 's1', true, 'a,b', 'c'),
  ]);
  assert.equal(r.mudaram, 1);
  assert.deepEqual(r.atrasosMin, [75]);
  assert.equal(r.tipos.ganhouExec, 1);
  assert.equal(r.tipos.ganhouRej, 1);
  assert.equal(r.exemplos[0].ganhouExec, 1);
});

test('vazio no meio é FALHA de coleta, não mudança', () => {
  const r = analisar([L(0, 's1', true, 'a,b'), L(15, 's1', true, ''), L(30, 's1', true, 'a,b'), L(45, 's1', true, 'a,b')]);
  assert.equal(r.mudaram, 0);
  assert.equal(r.comFalhaTransitoria, 1);
});

test('vazio no fim (ex.: P0-10) também é falha, e a régua é a última linha cheia', () => {
  const r = analisar([L(0, 's1', true, 'a'), L(15, 's1', true, 'a'), L(30, 's1', true, ''), L(45, 's1', true, '')]);
  assert.equal(r.mudaram, 0);
  assert.equal(r.esvaziaramNoFim, 1);
});

test('ida e volta com dado (A → B → A) conta: congelar no B estaria errado', () => {
  const r = analisar([L(0, 's1', true, 'a'), L(15, 's1', true, 'a,b'), L(30, 's1', true, 'a')]);
  assert.equal(r.mudaram, 1);
  assert.deepEqual(r.atrasosMin, [30]);
});

test('sessão que encerra sem nota nenhuma e ganha depois: conta (não é falha)', () => {
  const r = analisar([L(0, 's1', true, ''), L(15, 's1', true, ''), L(60, 's1', true, 'a')]);
  assert.equal(r.mudaram, 1);
  assert.deepEqual(r.atrasosMin, [60]);
});

test('reaberta para a contagem e é listada à parte', () => {
  const r = analisar([L(0, 's1', true, 'a'), L(15, 's1', false, 'a,b'), L(30, 's1', true, 'a,b,c')]);
  assert.equal(r.reabertas, 1);
  assert.equal(r.mudaram, 0);
});

test('sessão nunca encerrada fica fora', () => {
  const r = analisar([L(0, 's1', false, 'a'), L(15, 's1', false, 'b')]);
  assert.equal(r.encerradas, 0);
});

test('janelaQueCobre: menor faixa ≥ máximo', () => {
  assert.equal(janelaQueCobre([]), 0);
  assert.equal(janelaQueCobre([10, 14]), 15);
  assert.equal(janelaQueCobre([61]), 90);
  assert.equal(janelaQueCobre([300]), 300);
});
