/**
 * test/escalaAgora.test.js
 *
 * "Quantas equipes DEVERIAM estar em campo agora", pro KPI do Monitor.
 *
 * O erro sutil aqui é o TURNO QUE VIRA A MEIA-NOITE. O catálogo da EDP tem
 * vários (C17 17:00→02:00, C18 18:00→03:00, C35 22:35→06:00), e às 02:00 de hoje
 * quem está em campo foi escalado ONTEM. Olhar só o dia corrente zeraria o KPI
 * toda madrugada — e madrugada é justamente quando o plantão importa.
 *
 * O outro é o fuso: a VM roda em UTC e a operação em BRT. Ler o relógio do
 * processo apontaria o turno errado por 3h.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  turnoCobreAgora, minutosDoDia, diaAnterior, equipesCobertas,
} = require('../db/escalaQueries');

const min = (h, m = 0) => h * 60 + m;

// ─────────────────────────────────────────────────────────────────────────────
// Conversão de horário
// ─────────────────────────────────────────────────────────────────────────────

test('minutosDoDia aceita os formatos que o pg devolve', () => {
  assert.equal(minutosDoDia('06:00:00'), 360);
  assert.equal(minutosDoDia('22:35:00'), 1355);
  assert.equal(minutosDoDia('00:00:00'), 0);
  assert.equal(minutosDoDia('17:48'), 1068);
});

test('horário inválido vira null, não zero', () => {
  // Zero seria meia-noite — um turno "00:00" fantasma que cobriria a madrugada
  // inteira. Null faz a linha ser descartada, que é o certo.
  assert.equal(minutosDoDia(null), null);
  assert.equal(minutosDoDia(''), null);
  assert.equal(minutosDoDia('abc'), null);
  assert.equal(minutosDoDia('99:00'), null);
  assert.equal(minutosDoDia('12:99'), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Turno normal
// ─────────────────────────────────────────────────────────────────────────────

test('turno normal cobre do início (inclusive) ao fim (exclusive)', () => {
  const [i, f] = [min(8), min(17)];            // C08 08:00→17:00
  assert.equal(turnoCobreAgora(i, f, min(8),   false), true,  'no minuto do início já conta');
  assert.equal(turnoCobreAgora(i, f, min(12),  false), true);
  assert.equal(turnoCobreAgora(i, f, min(16, 59), false), true);
  assert.equal(turnoCobreAgora(i, f, min(17),  false), false, 'no fim já saiu');
  assert.equal(turnoCobreAgora(i, f, min(7, 59), false), false);
});

test('turno normal escalado ONTEM não cobre hoje', () => {
  // Sem isso, quem trabalhou 08:00–17:00 ontem apareceria como esperado hoje.
  assert.equal(turnoCobreAgora(min(8), min(17), min(12), true), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Turno que vira a meia-noite — o caso que o KPI erraria
// ─────────────────────────────────────────────────────────────────────────────

test('C35 (22:35→06:00): cobre a noite do dia da escala', () => {
  const [i, f] = [min(22, 35), min(6)];
  assert.equal(turnoCobreAgora(i, f, min(23),    false), true,  '23:00 do dia escalado');
  assert.equal(turnoCobreAgora(i, f, min(22, 35), false), true, 'no minuto do início');
  assert.equal(turnoCobreAgora(i, f, min(22, 34), false), false, 'um minuto antes, não');
  assert.equal(turnoCobreAgora(i, f, min(3),     false), false,
    '03:00 do PRÓPRIO dia da escala é antes do turno começar');
});

test('C35 (22:35→06:00): às 03:00 quem conta é a escala de ONTEM', () => {
  const [i, f] = [min(22, 35), min(6)];
  assert.equal(turnoCobreAgora(i, f, min(3), true), true,  '03:00 ainda dentro do turno de ontem');
  assert.equal(turnoCobreAgora(i, f, min(5, 59), true), true);
  assert.equal(turnoCobreAgora(i, f, min(6), true), false, 'às 06:00 o turno fechou');
  assert.equal(turnoCobreAgora(i, f, min(12), true), false);
});

test('C17 (17:00→02:00) — o outro vira-noite do catálogo', () => {
  const [i, f] = [min(17), min(2)];
  assert.equal(turnoCobreAgora(i, f, min(18), false), true);
  assert.equal(turnoCobreAgora(i, f, min(1),  true),  true,  '01:00 é da escala de ontem');
  assert.equal(turnoCobreAgora(i, f, min(1),  false), false, '01:00 do próprio dia, não');
});

// ─────────────────────────────────────────────────────────────────────────────
// Bordas
// ─────────────────────────────────────────────────────────────────────────────

test('janela ambígua (fim == início) não conta — não adivinha 24h', () => {
  assert.equal(turnoCobreAgora(min(8), min(8), min(12), false), false);
});

test('sem horário no catálogo, não cobre — é como DR/FER/AFO saem', () => {
  // Códigos não-trabalháveis vêm do catálogo SEM horário (AFO conferido em
  // 30/08). Isso os exclui sem precisar de lista negra no código, que ficaria
  // desatualizada no primeiro turno novo que a EDP criasse.
  assert.equal(turnoCobreAgora(null, min(17), min(12), false), false);
  assert.equal(turnoCobreAgora(min(8), null, min(12), false), false);
  assert.equal(turnoCobreAgora(null, null, min(12), false), false);
});

test('diaAnterior atravessa virada de mês e de ano', () => {
  assert.equal(diaAnterior('2026-08-30'), '2026-08-29');
  assert.equal(diaAnterior('2026-08-01'), '2026-07-31');
  assert.equal(diaAnterior('2026-01-01'), '2025-12-31');
  assert.equal(diaAnterior('2026-03-01'), '2026-02-28');
});

// ─────────────────────────────────────────────────────────────────────────────
// Agregação por equipe
// ─────────────────────────────────────────────────────────────────────────────

const linha = (sigla, data, inicio, fim, tipo = 'PLANTAO') =>
  ({ sigla, data, inicio_escala: inicio, fim_escala: fim, tipo, regional: 'GUA' });

test('equipe conta se QUALQUER colaborador dela está escalado agora', () => {
  // Dois de três em folga (linhas sem horário) e um em turno: a equipe está em
  // campo com gente a menos, mas está em campo. Exigir todos subestimaria.
  const linhas = [
    linha('EPMRT30', '2026-08-30', null, null),
    linha('EPMRT30', '2026-08-30', null, null),
    linha('EPMRT30', '2026-08-30', '08:00:00', '17:00:00'),
  ];
  const out = equipesCobertas(linhas, min(12), '2026-08-30');
  assert.equal(out.length, 1);
  assert.equal(out[0].sigla, 'EPMRT30');
});

test('a mesma equipe não é contada duas vezes', () => {
  const linhas = [
    linha('EPMRT30', '2026-08-30', '08:00:00', '17:00:00'),
    linha('EPMRT30', '2026-08-30', '08:00:00', '17:00:00'),
    linha('EPMRT31', '2026-08-30', '08:00:00', '17:00:00'),
  ];
  assert.equal(equipesCobertas(linhas, min(12), '2026-08-30').length, 2);
});

test('às 03:00 entram as de ontem e saem as de hoje', () => {
  const linhas = [
    linha('NOITE', '2026-08-29', '22:35:00', '06:00:00'),   // ontem, ainda em campo
    linha('DIA',   '2026-08-30', '08:00:00', '17:00:00'),   // hoje, ainda não começou
    linha('OUTRA', '2026-08-29', '08:00:00', '17:00:00'),   // ontem, já encerrou
  ];
  const out = equipesCobertas(linhas, min(3), '2026-08-30');
  assert.deepEqual(out.map(e => e.sigla), ['NOITE']);
});

test('lista vazia não quebra', () => {
  assert.deepEqual(equipesCobertas([], min(12), '2026-08-30'), []);
  assert.deepEqual(equipesCobertas(null, min(12), '2026-08-30'), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// O bug de 30/08: pg devolve `date` como Date, e a comparação de string falhava
// ─────────────────────────────────────────────────────────────────────────────

const { diaISO } = require('../db/escalaQueries');

test('diaISO aceita o objeto Date que o pg devolve', () => {
  // `String(new Date(...)).slice(0,10)` dava "Sat Aug 3" — nunca igual a
  // "2026-08-30". Toda linha virava "de ontem", turno normal exige !deOntem, e
  // o KPI mostrava 0 esperadas com 49 equipes escaladas.
  assert.equal(diaISO(new Date(2026, 7, 30)), '2026-08-30');
  assert.equal(diaISO(new Date(2026, 0, 1)),  '2026-01-01');
  assert.equal(diaISO('2026-08-30'), '2026-08-30');
  assert.equal(diaISO('2026-08-30T00:00:00Z'), '2026-08-30');
});

test('diaISO não inventa data quando não consegue ler', () => {
  assert.equal(diaISO(null), null);
  assert.equal(diaISO(''), null);
  assert.equal(diaISO('Sat Aug 30 2026'), null);
  assert.equal(diaISO(new Date('lixo')), null);
});

test('turno normal com data em Date do pg é contado — o caso do bug', () => {
  const linhas = [
    { sigla: 'EPMRT30', data: new Date(2026, 7, 30), tipo: 'PLANTAO', regional: 'GUA',
      inicio_escala: '08:00:00', fim_escala: '17:00:00' },
  ];
  assert.equal(equipesCobertas(linhas, min(14, 4), '2026-08-30').length, 1,
    'às 14:04 a equipe de 08:00-17:00 tem de contar');
});

test('linha com data ilegível é descartada, não tratada como de ontem', () => {
  // Cair no ramo "de ontem" por acidente faria turno normal sumir e turno
  // vira-noite aparecer na hora errada — erro silencioso nos dois sentidos.
  const linhas = [
    { sigla: 'X', data: 'sei lá', tipo: 'A', regional: 'GUA',
      inicio_escala: '22:00:00', fim_escala: '06:00:00' },
  ];
  assert.equal(equipesCobertas(linhas, min(3), '2026-08-30').length, 0);
});
