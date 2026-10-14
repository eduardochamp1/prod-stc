/**
 * test/remotasNaII.test.js
 *
 * Trava (14/10/2026) onde as REMOTAS (MD/REMOTA, medidores executados) aparecem
 * junto da II. Para a EDP é a quantidade de medidores que conta, não a de notas.
 * Testes de fonte, no mesmo estilo dos de front já existentes (index.html é monolito).
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

describe('REMOTAS junto da II', () => {
  test('gauge da II mostra as remotas a partir de quantidades.REMOTA', () => {
    assert.ok(SRC.includes("g.key === 'II' && Math.round(quantidades['REMOTA'] || 0) > 0"));
    assert.ok(SRC.includes('${remotasLabel}'));
  });
  test('card da II no Monitor mostra "Remotas"', () => {
    assert.ok(SRC.includes("l.key === 'II' && (qtdReg.REMOTA || 0) > 0"));
  });
  test('Histórico: linha da II lê a quantidade de MD/REMOTA', () => {
    assert.ok(/{ tipo: 'II', sub_code: 'II',s+nome: 'Inspeção de Irregularidade', remotasDe: 'MD/REMOTA' }/.test(SRC));
  });
  test('XLSX: coluna "Remotas Exec" nas abas por equipe e regional, só em linhas II', () => {
    const n = (SRC.match(/'Remotas Exec'/g) || []).length;
    assert.equal(n, 2);
    assert.ok(SRC.includes("r.tipo_code === 'II' ? (remEq["));
    assert.ok(SRC.includes("r.tipo_code === 'II' ? (remReg["));
  });
  test('matriz: REMOTAS só no grupo II e fora da SOMA', () => {
    assert.ok(SRC.includes("const COM_REM = new Set(['II']);"));
    assert.ok(!/total_remota\s*\)?\s*\+\s*\(?e\.total_rej/.test(SRC));
  });
});
