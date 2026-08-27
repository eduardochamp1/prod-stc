/**
 * test/coletaStatus.test.js
 *
 * P1-39 — traduz o report por SETOR (`getTeams(filters, out)` → out.report, do
 * P1-30) para o estado por REGIONAL que o painel entende.
 *
 * Por que isso existe: em 24-25/08/2026 a coleta de SJC morreu (credencial WPA
 * inválida nas duas contas) e o painel mostrou "Nenhuma equipe encontrada" +
 * `0 em campo` — visualmente idêntico a um domingo. O `snapshot_partial` estava
 * correto no log desde o primeiro ciclo, mas ninguém lê log: o problema só foi
 * notado ~18h depois, quando um gestor perguntou por que SP tinha sumido.
 *
 * A regra que estes testes travam: `0` e `indisponível` NÃO são a mesma
 * informação, e uma regional com DOIS setores em que só um caiu está PARCIAL,
 * não fora — o painel ainda tem dado legítimo pra mostrar.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { buildColetaStatus } = require('../services/dataService');

// report no formato que getTeams devolve em out.report
const rep = ({ ok = [], failed = [], skipped = [] } = {}) => ({ ok, failed, skipped });

test('buildColetaStatus: tudo ok → nenhuma regional degradada', () => {
  const c = buildColetaStatus(
    rep({ ok: ['DESG', 'DEPT', 'DESC', 'DSSJ'] }),
    {},
    ['GUA', 'CAC', 'SJC'],
  );
  assert.equal(c.degradado, false);
  assert.equal(c.regionais.GUA.status, 'ok');
  assert.equal(c.regionais.SJC.status, 'ok');
});

test('buildColetaStatus: setor único da regional falhou → regional em falha, não parcial', () => {
  const c = buildColetaStatus(
    rep({
      ok: ['DESG', 'DEPT', 'DESC'],
      failed: [{ sector: 'DSSJ', msg: 'WPA login (account=sp2): Usuário ou senha inválidos' }],
    }),
    { DSSJ: '2026-08-24T14:00:00.000Z' },
    ['SJC'],
  );
  assert.equal(c.degradado, true);
  assert.equal(c.regionais.SJC.status, 'falha');
  assert.equal(c.regionais.SJC.parcial, false, 'DSSJ é o único setor de SJC — não sobra nada');
  assert.deepEqual(c.regionais.SJC.setores, ['DSSJ']);
  assert.equal(c.regionais.SJC.desde, '2026-08-24T14:00:00.000Z');
  assert.match(c.regionais.SJC.msg, /senha inválidos/);
});

test('buildColetaStatus: GUA tem 2 setores — um caindo é PARCIAL (ainda há dado real)', () => {
  const c = buildColetaStatus(
    rep({ ok: ['DESG', 'DESC'], failed: [{ sector: 'DEPT', msg: 'timeout' }] }),
    { DEPT: '2026-08-25T09:00:00.000Z' },
    ['GUA'],
  );
  assert.equal(c.regionais.GUA.status, 'falha');
  assert.equal(c.regionais.GUA.parcial, true, 'DESG seguiu coletando');
  assert.deepEqual(c.regionais.GUA.setores, ['DEPT']);
});

test('buildColetaStatus: setor pulado por kill-switch é "pausada", não "falha"', () => {
  // WPA_ACCOUNTS_DISABLED é decisão operacional consciente. Tratar como falha
  // faria o painel gritar por algo que o próprio operador desligou.
  const c = buildColetaStatus(
    rep({ ok: ['DESG', 'DEPT', 'DESC'], skipped: ['DSSJ'] }),
    {},
    ['SJC'],
  );
  assert.equal(c.regionais.SJC.status, 'pausada');
  assert.equal(c.degradado, true, 'pausada ainda é ausência de dado — o painel precisa dizer');
});

test('buildColetaStatus: recorta pelo escopo do usuário', () => {
  const c = buildColetaStatus(
    rep({ ok: ['DESG', 'DEPT'], failed: [{ sector: 'DSSJ', msg: 'x' }] }),
    {},
    ['GUA'],
  );
  assert.deepEqual(Object.keys(c.regionais), ['GUA']);
  assert.equal(c.degradado, false, 'falha fora do escopo não degrada o painel do usuário');
});

test('buildColetaStatus: sem sector_last_ok, `desde` é null (nunca inventa horário)', () => {
  const c = buildColetaStatus(
    rep({ ok: [], failed: [{ sector: 'DSSJ', msg: 'x' }] }),
    null,
    ['SJC'],
  );
  assert.equal(c.regionais.SJC.desde, null);
});

test('buildColetaStatus: regional com 2 setores falhos usa o `desde` MAIS ANTIGO', () => {
  // O que o operador precisa saber é há quanto tempo o buraco existe.
  const c = buildColetaStatus(
    rep({ failed: [{ sector: 'DESG', msg: 'a' }, { sector: 'DEPT', msg: 'b' }] }),
    { DESG: '2026-08-25T11:00:00.000Z', DEPT: '2026-08-25T08:00:00.000Z' },
    ['GUA'],
  );
  assert.equal(c.regionais.GUA.parcial, false, 'os dois setores caíram');
  assert.equal(c.regionais.GUA.desde, '2026-08-25T08:00:00.000Z');
});

test('buildColetaStatus: report ausente/malformado não quebra a rota', () => {
  assert.equal(buildColetaStatus(null, null, ['GUA']).degradado, false);
  assert.equal(buildColetaStatus(undefined, undefined, null).degradado, false);
});
