/**
 * test/sessionsDedup.test.js  (P2-36, metade segura)
 *
 * `POST /api/Sessions/all/date` devolve sessões de OUTRAS datas além da pedida —
 * comportamento documentado pelos três outros projetos da empresa que consomem a
 * mesma API, e todos os três deduplicam por `Id`. O GQO quantifica o custo de não
 * deduplicar: numa janela de 15 dias a mesma sessão era reprocessada ~16 vezes.
 *
 * Nós não deduplicávamos. Duplicata custa 2 fetches de nota por sessão repetida
 * (via _safeNotes) e infla a contagem de relogins da equipe.
 *
 * Esta é a metade SEGURA do item: dedup por `Id` é inequívoco — a mesma sessão
 * repetida na mesma resposta não é informação nova. A outra metade (filtrar
 * sessão ENCERRADA de outra data) continua pending, porque nosso fluxo ao vivo
 * mostra sessão aberta de dia anterior DE PROPÓSITO e não há medição ainda de
 * quanto do que chega é ruído.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const wpa = require('../services/wpaService');

describe('_dedupSessionsById', () => {
  test('mesma sessão repetida → uma linha, a primeira', () => {
    const r = wpa._dedupSessionsById([
      { Id: 'a', BeginTime: '2026-08-22T06:00:00' },
      { Id: 'a', BeginTime: '2026-08-22T06:00:00' },
      { Id: 'b', BeginTime: '2026-08-22T07:00:00' },
    ]);
    assert.equal(r.length, 2);
    assert.deepEqual(r.map(s => s.Id), ['a', 'b']);
  });

  test('preserva a ORDEM original', () => {
    const r = wpa._dedupSessionsById([{ Id: 'c' }, { Id: 'a' }, { Id: 'c' }, { Id: 'b' }]);
    assert.deepEqual(r.map(s => s.Id), ['c', 'a', 'b']);
  });

  test('sem duplicata devolve a mesma coisa', () => {
    const entrada = [{ Id: 'x' }, { Id: 'y' }];
    assert.deepEqual(wpa._dedupSessionsById(entrada).map(s => s.Id), ['x', 'y']);
  });

  test('sessão SEM Id é preservada, não colapsada', () => {
    // Sem Id não há como afirmar que são a mesma sessão. Colapsar aqui apagaria
    // sessão legítima — erra pro lado de manter.
    const r = wpa._dedupSessionsById([{ Id: null }, { Id: undefined }, {}]);
    assert.equal(r.length, 3);
  });

  test('lista vazia, null e não-array → []', () => {
    assert.deepEqual(wpa._dedupSessionsById([]), []);
    assert.deepEqual(wpa._dedupSessionsById(null), []);
    assert.deepEqual(wpa._dedupSessionsById('nada'), []);
  });

  test('Id numérico e string do mesmo valor NÃO são colapsados', () => {
    // A WPA usa GUID; se um dia mandar número, tratar 1 e '1' como iguais seria
    // inventar equivalência que a API não prometeu.
    const r = wpa._dedupSessionsById([{ Id: 1 }, { Id: '1' }]);
    assert.equal(r.length, 2);
  });
});
