/**
 * test/sectorLastOk.test.js
 *
 * P1-39 — `app_settings.sector_last_ok` guarda, POR SETOR, o último ciclo em que
 * aquele setor de fato coletou. É de onde sai o "indisponível desde HH:MM" do
 * painel.
 *
 * Por que não dava pra reusar `snapshot_last_ok`: ele é sobrescrito inteiro a
 * cada ciclo e só responde "quando foi o último ciclo bem-sucedido" — no
 * incidente de 24-25/08 ele ficou VERDE o tempo todo, porque GUA e CAC seguiram
 * coletando enquanto SJC estava fora. A informação "SJC não coleta desde ontem"
 * não existia em lugar nenhum.
 *
 * O merge é a parte que importa: gravar o mapa inteiro apagaria o histórico dos
 * setores que falharam nesse ciclo — justamente os que precisamos datar.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { _mergeSectorLastOk } = require('../services/cronService');

test('_mergeSectorLastOk: setor que coletou recebe o ts do ciclo', () => {
  const out = _mergeSectorLastOk({}, ['DESG', 'DESC'], '2026-08-25T12:00:00.000Z');
  assert.equal(out.DESG, '2026-08-25T12:00:00.000Z');
  assert.equal(out.DESC, '2026-08-25T12:00:00.000Z');
});

test('_mergeSectorLastOk: setor que FALHOU preserva o carimbo antigo', () => {
  // O ponto do item: sem isso, o "desde quando" seria apagado exatamente pelo
  // ciclo em que o setor caiu, e o painel nunca saberia dizer há quanto tempo.
  const antes = { DSSJ: '2026-08-24T14:00:00.000Z', DESG: '2026-08-25T11:45:00.000Z' };
  const out = _mergeSectorLastOk(antes, ['DESG'], '2026-08-25T12:00:00.000Z');
  assert.equal(out.DSSJ, '2026-08-24T14:00:00.000Z', 'DSSJ não coletou — carimbo intacto');
  assert.equal(out.DESG, '2026-08-25T12:00:00.000Z');
});

test('_mergeSectorLastOk: estado anterior ausente/corrompido não quebra o ciclo', () => {
  assert.deepEqual(_mergeSectorLastOk(null, ['DESG'], 'T'), { DESG: 'T' });
  assert.deepEqual(_mergeSectorLastOk('lixo', ['DESG'], 'T'), { DESG: 'T' });
  assert.deepEqual(_mergeSectorLastOk({ DESG: 'X' }, null, 'T'), { DESG: 'X' });
});

test('_mergeSectorLastOk: não inventa setor a partir de entrada vazia', () => {
  assert.deepEqual(_mergeSectorLastOk({}, [], '2026-08-25T12:00:00.000Z'), {});
});

test('_mergeSectorLastOk: não muta o objeto recebido', () => {
  // O caller lê de app_settings e reusa a referência; mutar in loco esconde
  // divergência entre o que foi gravado e o que ficou em memória.
  const antes = { DSSJ: 'A' };
  const out = _mergeSectorLastOk(antes, ['DESG'], 'B');
  assert.deepEqual(antes, { DSSJ: 'A' });
  assert.notEqual(out, antes);
});
