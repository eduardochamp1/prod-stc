/**
 * test/performanceDias.test.js
 *
 * Trava o bug de 28/07/2026: a coluna "DIAS" (dias_trabalhados) do detalhamento
 * dos Gráficos contava LINHAS, não dias. O driver `pg` devolve a coluna DATE
 * como objeto `Date`, e getPerformanceEquipes fazia `Set.add(row.date)` — como
 * cada Date é um objeto distinto, linhas do MESMO dia (uma por tipo_code) nunca
 * colapsavam. Resultado: filtrando 1 dia, uma equipe com produção em SF e RL
 * mostrava DIAS=2; com LN, LE e MD, DIAS=3. Isso inflava MÉDIA/dia (total/dias)
 * e desordenava o ranking. _ymd normaliza pra 'YYYY-MM-DD' antes de deduplicar.
 *
 * Se algum destes quebrar, a métrica de dias/média voltou a contar linhas.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { _ymd, _diasTrabalhados } = require('../db/queries');

// Simula o que o pg devolve: coluna DATE vira objeto Date (meia-noite local).
const pgDate = (iso) => new Date(iso + 'T00:00:00-03:00');

// ── _ymd ──────────────────────────────────────────────────────────────────────

test('_ymd: objeto Date → YYYY-MM-DD', () => {
  assert.equal(_ymd(pgDate('2026-07-28')), '2026-07-28');
});

test('_ymd: dois Date do MESMO dia → mesma string (o cerne do bug)', () => {
  const a = pgDate('2026-07-28');
  const b = pgDate('2026-07-28');
  assert.notStrictEqual(a, b, 'são objetos distintos (por isso o Set falhava)');
  assert.equal(_ymd(a), _ymd(b), 'mas normalizam pra mesma string');
});

test('_ymd: string passa direto (recortada em 10)', () => {
  assert.equal(_ymd('2026-07-28'), '2026-07-28');
  assert.equal(_ymd('2026-07-28T09:15:00'), '2026-07-28');
});

test('_ymd: nulo/indefinido → string vazia (não quebra)', () => {
  assert.equal(_ymd(null), '');
  assert.equal(_ymd(undefined), '');
});

// ── _diasTrabalhados (o que alimenta a coluna DIAS e a MÉDIA) ───────────────────

test('1 dia filtrado, 2 tipos (SF+RL) → DIAS = 1 (regressão ETGPR15)', () => {
  // Antes do fix: Set de 2 objetos Date distintos → 2. Errado.
  const rows = [pgDate('2026-07-28'), pgDate('2026-07-28')];
  assert.equal(_diasTrabalhados(rows), 1);
});

test('1 dia filtrado, 3 tipos (LN+LE+MD) → DIAS = 1 (regressão ECMRT51)', () => {
  const rows = [pgDate('2026-07-28'), pgDate('2026-07-28'), pgDate('2026-07-28')];
  assert.equal(_diasTrabalhados(rows), 1);
});

test('2 dias reais, vários tipos por dia → DIAS = 2', () => {
  const rows = [
    pgDate('2026-07-27'), pgDate('2026-07-27'),  // dia 1, 2 tipos
    pgDate('2026-07-28'), pgDate('2026-07-28'), pgDate('2026-07-28'), // dia 2, 3 tipos
  ];
  assert.equal(_diasTrabalhados(rows), 2);
});

test('mistura Date + string do mesmo dia → conta 1', () => {
  const rows = [pgDate('2026-07-28'), '2026-07-28'];
  assert.equal(_diasTrabalhados(rows), 1);
});

test('média = total/dias fica correta depois do fix', () => {
  // ETGPR15 real: 31 OS num único dia (SF=30, RL=1). Média deve ser 31, não 15.5.
  const total = 31;
  const rows = [pgDate('2026-07-28'), pgDate('2026-07-28')]; // SF, RL — mesmo dia
  const dias = _diasTrabalhados(rows);
  assert.equal(dias, 1);
  assert.equal(+(total / dias).toFixed(2), 31);
});

test('sem linhas → 0 dias (sem divisão por zero no caller)', () => {
  assert.equal(_diasTrabalhados([]), 0);
  assert.equal(_diasTrabalhados(null), 0);
});
