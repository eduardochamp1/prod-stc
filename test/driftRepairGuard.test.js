/**
 * test/driftRepairGuard.test.js
 *
 * Trava a MONOTONICIDADE do auto-reparo (31/07/2026): ele só pode ADICIONAR
 * produção, nunca subtrair.
 *
 * Contexto — 3ª vez que a régua do drift engana:
 *   1ª (25/07) a régua era o passe de D. Subcontava ~6%; o sweep das 02:00
 *       "reparava" pra baixo e o 07-22 perdeu 172 OS. Fix: usar o passe de D+1.
 *   2ª (31/07) os scripts de MEDIÇÃO ainda usavam a régua de D, o que fez prever
 *       uma queda de −5,1% na re-consolidação de julho que não existia.
 *   3ª (31/07) verificando o backfill de julho com a régua CERTA, 5 dias vieram
 *       com drift NEGATIVO — tabela MAIOR que a régua: 03/07 −56, 08/07 −22,
 *       10/07 −96, 17/07 −117, 24/07 −84. Quatro dos cinco são SEXTA-FEIRA.
 *
 * Isso não é corrupção: `consolidateDay(X)` apaga só {X-1, X} mas faz upsert de
 * linhas pra vários notaDate anteriores (nota de sexta segue no payload das
 * sessões de sábado e segunda). Nos logs do backfill, o passe de 05/07 gravou
 * `dates ["2026-07-03","2026-07-04","2026-07-05"]` sem wipar 03/07. O valor
 * gravado de um dia antigo é portanto mais COMPLETO que o de qualquer passe
 * isolado — nenhuma régua de janela fixa o reproduz.
 *
 * Se o sweep reparasse esses dias, regravaria com a régua estreita e apagaria
 * 84–117 OS por dia. Daí a regra assimétrica. Se estes testes quebrarem, o
 * auto-reparo voltou a poder comer produção.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { shouldAutoRepair } = require('../services/dataWriter');

// Molde do relatório do detectDrift. diff = régua(snapshot_count) − tabela.
const rel = (table_count, snapshot_count, threshold = 20) => ({
  date: '2026-07-24',
  repair_date: '2026-07-25',
  table_count,
  snapshot_count,
  diff: snapshot_count - table_count,
  abs_diff: Math.abs(snapshot_count - table_count),
  threshold,
  has_drift: Math.abs(snapshot_count - table_count) > threshold,
});

test('sem drift → não repara', () => {
  const d = shouldAutoRepair(rel(1000, 1005));
  assert.equal(d.repair, false);
  assert.equal(d.reason, 'sem_drift');
});

test('tabela SUBCONTA (diff > 0) → repara: o reparo acrescenta', () => {
  const d = shouldAutoRepair(rel(900, 1000));
  assert.equal(d.repair, true);
  assert.equal(d.reason, 'tabela_subconta');
});

test('tabela ACIMA da régua (diff < 0) → NÃO repara (apagaria produção)', () => {
  // O caso real do 24/07/2026: tabela 959, régua 875 → diff −84.
  const d = shouldAutoRepair(rel(959, 875, 18));
  assert.equal(d.has_drift, undefined, 'shouldAutoRepair não muta o relatório');
  assert.equal(d.repair, false);
  assert.equal(d.reason, 'tabela_acima_da_regua');
});

test('os 5 dias reais de 31/07/2026 seriam TODOS recusados pelo sweep', () => {
  // [dia, tabela, régua, limiar] — saída de scripts/verify-consolidacao.js
  const casos = [
    ['2026-07-03', 888, 832, 17],
    ['2026-07-08', 980, 958, 19],
    ['2026-07-10', 885, 789, 16],
    ['2026-07-17', 1076, 959, 19],
    ['2026-07-24', 959, 875, 18],
  ];
  let perdaEvitada = 0;
  for (const [dia, tabela, regua, lim] of casos) {
    const r = rel(tabela, regua, lim);
    assert.ok(r.has_drift, `${dia} deveria acusar drift`);
    assert.equal(shouldAutoRepair(r).repair, false, `${dia} NÃO pode ser reparado`);
    perdaEvitada += tabela - regua;
  }
  assert.equal(perdaEvitada, 375, 'total de OS que o sweep destruiria em 1 noite');
});

test('drift positivo grande continua sendo reparado (não travamos o remédio)', () => {
  // Caso legítimo: dia consolidado pela metade após crash entre wipe e reagregação.
  const d = shouldAutoRepair(rel(0, 1100, 22));
  assert.equal(d.repair, true);
});

test('relatório nulo/ausente não quebra', () => {
  assert.equal(shouldAutoRepair(null).repair, false);
  assert.equal(shouldAutoRepair(undefined).repair, false);
  assert.equal(shouldAutoRepair({}).repair, false);
});

test('diff exatamente no limiar não repara (limiar é exclusivo)', () => {
  const d = shouldAutoRepair(rel(1000, 1020, 20));
  assert.equal(d.repair, false, 'has_drift exige abs_diff > threshold');
});
