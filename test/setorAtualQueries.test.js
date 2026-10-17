/**
 * test/setorAtualQueries.test.js
 *
 * Trava o SQL de db/setorAtualQueries.js com um pool FALSO (sem banco).
 * Contexto (16/10/2026): GUA tem DESG e DEPT e a equipe é transferida entre
 * eles — o setor da tela de Equipes vem da coleta mais recente, não do cadastro.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { setorAtualPorEquipe, DIAS_PADRAO } = require('../db/setorAtualQueries');

function poolFalso(rows = []) {
  const chamadas = [];
  return {
    chamadas,
    async query(sql, params) { chamadas.push({ sql, params }); return { rows }; },
  };
}
const norm = (s) => s.replace(/\s+/g, ' ').trim();

test('pega a coleta MAIS RECENTE por equipe, em janela limitada', async () => {
  const p = poolFalso();
  await setorAtualPorEquipe(p);
  const { sql, params } = p.chamadas[0];
  const s = norm(sql);
  assert.match(s, /FROM public\.snapshots/);
  assert.match(s, /DISTINCT ON \(upper\(team_name\)\)/);
  assert.match(s, /ORDER BY upper\(team_name\), date DESC, captured_at DESC/,
    'sem o DESC a equipe transferida mostraria o setor ANTIGO');
  assert.match(s, /date >= CURRENT_DATE - \$1::int/,
    'snapshots são retidos pra sempre — sem janela varre o histórico inteiro');
  assert.deepEqual(params, [DIAS_PADRAO]);
});

test('não filtra setor: DESG e DEPT entram os dois', async () => {
  const p = poolFalso();
  await setorAtualPorEquipe(p);
  assert.doesNotMatch(p.chamadas[0].sql, /sector_id\s*(=|IN)/i);
});

test('devolve Map sigla → { setor, data }', async () => {
  const p = poolFalso([
    { sigla: 'ECGPR53', sector_id: 'DEPT', data: '2026-10-16' },
    { sigla: 'ECCIT50', sector_id: 'DESC', data: '2026-10-15' },
  ]);
  const m = await setorAtualPorEquipe(p, { dias: 7 });
  assert.deepEqual(p.chamadas[0].params, [7]);
  assert.deepEqual(m.get('ECGPR53'), { setor: 'DEPT', data: '2026-10-16' });
  assert.deepEqual(m.get('ECCIT50'), { setor: 'DESC', data: '2026-10-15' });
  assert.equal(m.size, 2);
});
