/**
 * test/escalaDia.test.js
 *
 * P1-26: `/admin/health` monta `teams_missing_today` iterando a whitelist inteira
 * e marcando quem não está em `teams_current` — SEM cruzar com escala. Equipe de
 * folga, férias ou afastamento aparece como "não logou", falso positivo todo dia.
 * Com escala, "não logou" passa a significar **estava escalada e não logou**.
 *
 * Decisão de direção do erro, deliberada: quando NÃO há escala para a equipe no
 * dia, ela continua sendo reportada (`sem-dado`), não suprimida. Suprimir por
 * falta de dado esconderia ausência real — e este projeto não mascara. O oposto
 * (reportar quem está de folga) é o ruído que o item quer eliminar, e para isso
 * exigimos evidência POSITIVA de folga.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const esc = require('../services/escalaDia');

describe('isFolga — só os códigos que a EDP usa para dia não trabalhado', () => {
  test('os 10 códigos de exclusão', () => {
    for (const c of ['FOL', 'DR', 'DES', 'FER', 'DIS', 'AFO', 'NA', 'SAV', 'SIN', 'TRE']) {
      assert.equal(esc.isFolga(c), true, `${c} deveria ser folga`);
    }
  });

  test('turno de trabalho não é folga', () => {
    assert.equal(esc.isFolga('T07 07:00'), false);
    assert.equal(esc.isFolga('C06'), false);
    assert.equal(esc.isFolga('E22 22:00'), false);
  });

  test('case e espaço não confundem', () => {
    assert.equal(esc.isFolga(' fol '), true);
    assert.equal(esc.isFolga('Fer'), true);
  });

  test('código composto usa o primeiro token', () => {
    assert.equal(esc.isFolga('FOL 00:00'), true);
  });

  test('ausência de código NÃO é folga comprovada', () => {
    // Direção do erro: sem evidência de folga, a equipe segue reportável.
    assert.equal(esc.isFolga(null), false);
    assert.equal(esc.isFolga(''), false);
    assert.equal(esc.isFolga(undefined), false);
  });

  test('código desconhecido não é folga (não inventa exclusão)', () => {
    assert.equal(esc.isFolga('ZZZ'), false);
  });
});

describe('classificarDia — a equipe estava escalada neste dia?', () => {
  test('todos os colaboradores de folga → folga, não reporta', () => {
    const r = esc.classificarDia([{ codigoEscala: 'FOL' }, { codigoEscala: 'DR' }]);
    assert.equal(r.escalada, false);
    assert.equal(r.motivo, 'folga');
    assert.deepEqual(r.codigos, ['FOL', 'DR']);
  });

  test('pelo menos um em turno de trabalho → escalada, reporta', () => {
    const r = esc.classificarDia([{ codigoEscala: 'FOL' }, { codigoEscala: 'T07 07:00' }]);
    assert.equal(r.escalada, true);
    assert.equal(r.motivo, 'escalada');
  });

  test('sem linha nenhuma → sem-dado, e REPORTA (não suprime no escuro)', () => {
    const r = esc.classificarDia([]);
    assert.equal(r.escalada, true);
    assert.equal(r.motivo, 'sem-dado');
    assert.deepEqual(r.codigos, []);
  });

  test('argumento nulo → sem-dado, reporta', () => {
    assert.equal(esc.classificarDia(null).motivo, 'sem-dado');
    assert.equal(esc.classificarDia(null).escalada, true);
  });

  test('linha com código vazio conta como sem evidência de folga → escalada', () => {
    const r = esc.classificarDia([{ codigoEscala: '' }]);
    assert.equal(r.escalada, true);
    assert.equal(r.motivo, 'escalada');
  });

  test('um único colaborador de férias → folga', () => {
    const r = esc.classificarDia([{ codigoEscala: 'FER' }]);
    assert.equal(r.escalada, false);
    assert.equal(r.motivo, 'folga');
  });
});
