/**
 * test/rotina.test.js
 *
 * Aba Rotina (ex-Mapa), 15/10/2026 — a linha do tempo "Dia da equipe".
 * O que importa aqui: horário do checkpoint (registradoEm, nunca o timestamp
 * de sincronização nos eventos 0/1), o pareamento 0→1 / 2→3, e o Desvio ser
 * EXATAMENTE sessão − (deslocamento ∪ serviço).
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  instanteCp, intervalosDaNota, unir, buracos, montarRotina, montarCarteira,
} = require('../db/rotinaQueries');
const { msParede } = require('../db/heQueries');

const DIA = '2026-09-01';
const cp = (event, hhmm, extra = {}) => ({ event, registradoEm: `${DIA}T${hhmm}:00-03:00`, ...extra });
const M = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

test('evento 0/1 sem registradoEm não usa o timestamp de sincronização', () => {
  assert.equal(instanteCp({ event: 0, timestamp: '2026-09-01T20:35:43Z' }), null);
  assert.equal(instanteCp({ event: 1, timestamp: '2026-09-01T20:35:43Z' }), null);
  // Eventos 2/3 aceitam o timestamp como reserva (erro de segundos).
  assert.equal(instanteCp({ event: 3, timestamp: '2026-09-01T20:35:43Z' }),
    msParede('2026-09-01T17:35:43'));
});

test('registradoEm com -03:00 é lido como parede BRT', () => {
  assert.equal(instanteCp(cp(2, '16:53')), msParede('2026-09-01T16:53:00'));
});

test('pareia 0→1 e 2→3, o 4 não interfere', () => {
  const r = intervalosDaNota([
    cp(3, '10:00'), cp(0, '09:00'), cp(1, '09:20'), cp(2, '09:25'), cp(4, '09:55'),
  ]);
  assert.equal(r.desloc.length, 1);
  assert.equal(r.servico.length, 1);
  assert.equal((r.servico[0].fim - r.servico[0].ini) / 60000, 35);
  assert.equal((r.desloc[0].fim - r.desloc[0].ini) / 60000, 20);
});

test('início do trabalho sem fim do deslocamento fecha o deslocamento', () => {
  const r = intervalosDaNota([cp(0, '09:00'), cp(2, '09:30'), cp(3, '10:00')]);
  assert.equal((r.desloc[0].fim - r.desloc[0].ini) / 60000, 30);
});

test('duas tentativas viram dois deslocamentos', () => {
  const r = intervalosDaNota([cp(0, '08:00'), cp(1, '08:10'), cp(0, '14:00'), cp(1, '14:30')]);
  assert.equal(r.desloc.length, 2);
});

test('deslocamento sem registradoEm é contado, não desenhado', () => {
  const r = intervalosDaNota([{ event: 0, timestamp: '2026-09-01T12:00:00Z' }, cp(2, '09:30'), cp(3, '10:00')]);
  assert.equal(r.desloc.length, 0);
  assert.equal(r.semHorario, 1);
});

test('unir e buracos', () => {
  const u = unir([{ ini: 0, fim: 10 }, { ini: 5, fim: 20 }, { ini: 30, fim: 40 }]);
  assert.deepEqual(u, [{ ini: 0, fim: 20 }, { ini: 30, fim: 40 }]);
  const MIN = 60000;
  assert.deepEqual(buracos(0, 60 * MIN, [{ ini: 10 * MIN, fim: 20 * MIN }]),
    [{ ini: 0, fim: 10 * MIN }, { ini: 20 * MIN, fim: 60 * MIN }]);
  // buraco de 30s é ruído
  assert.deepEqual(buracos(0, 10 * MIN, [{ ini: 30000, fim: 10 * MIN }]), []);
});

test('rotina completa: desvio = sessão − (deslocamento ∪ serviço)', () => {
  const r = montarRotina({
    dia: DIA,
    escalas: [{ codigo_escala: 'T08', inicio_escala: '08:00:00', fim_escala: '17:00:00' }],
    sessoes: [{ begin: `${DIA}T07:58:20`, end: `${DIA}T19:44:24` }],
    notas: [{
      id: 'a', numero: '1', tipo: 'MD', status: 'concluida',
      checkpoints: [cp(0, '08:30'), cp(1, '09:10'), cp(2, '09:15'), cp(3, '10:00')],
    }],
    agoraMs: msParede('2026-10-15T12:00:00'),
  });
  assert.equal(r.faixas.escala[0].ini, M('08:00'));
  assert.equal(r.totaisMin.escala, 540);
  assert.equal(r.totaisMin.deslocamento, 40);   // 08:30→09:10
  assert.equal(r.totaisMin.servico, 45);
  // fecha por construção
  assert.equal(r.totaisMin.desvio + r.totaisMin.deslocamento + r.totaisMin.servico, r.totaisMin.sessao);
  assert.equal(r.faixas.servico[0].status, 'concluida');
  assert.equal(r.agoraMin, null);   // dia passado
});

test('serviço sem fim: fecha na interrupção', () => {
  const r = montarRotina({
    dia: DIA,
    notas: [{ id: 'x', status: 'executada', checkpoints: [cp(2, '12:12')] }],
    interrupcoes: [{ note_id: 'x', instanteMs: msParede(`${DIA}T12:33:00`), motivo: 'Chuva' }],
    agoraMs: msParede('2026-10-15T12:00:00'),
  });
  assert.equal(r.faixas.servico.length, 1);
  assert.equal(r.faixas.servico[0].status, 'interrompida');
  assert.equal(r.faixas.servico[0].fim, M('12:33'));
  assert.equal(r.interrupcoes.length, 1);
});

test('serviço sem fim em dia passado não é inventado', () => {
  const r = montarRotina({
    dia: DIA,
    notas: [{ id: 'x', status: 'executada', checkpoints: [cp(2, '12:12')] }],
    agoraMs: msParede('2026-10-15T12:00:00'),
  });
  assert.equal(r.faixas.servico.length, 0);
  assert.equal(r.avisos.servicoSemFim, 1);
});

test('hoje: serviço em andamento e sessão aberta vão até agora', () => {
  const r = montarRotina({
    dia: DIA,
    sessoes: [{ begin: `${DIA}T08:00:00`, end: null }],
    notas: [{ id: 'x', status: 'executada', checkpoints: [cp(2, '10:00')] }],
    agoraMs: msParede(`${DIA}T11:00:00`),
  });
  assert.equal(r.agoraMin, M('11:00'));
  assert.equal(r.faixas.sessao[0].fim, M('11:00'));
  assert.equal(r.faixas.sessao[0].aberta, true);
  assert.equal(r.faixas.servico[0].status, 'andamento');
  assert.equal(r.totaisMin.desvio, 120);
});

test('turno que vira a noite passa de 1440', () => {
  const r = montarRotina({
    dia: DIA,
    escalas: [{ codigo_escala: 'C35', inicio_escala: '22:35:00', fim_escala: '06:00:00' }],
    agoraMs: msParede('2026-10-15T12:00:00'),
  });
  assert.equal(r.faixas.escala[0].fim, 1440 + 360);
});

test('folga sem horário vira aviso, não barra', () => {
  const r = montarRotina({
    dia: DIA, escalas: [{ codigo_escala: 'DR', inicio_escala: null, fim_escala: null }],
    agoraMs: msParede('2026-10-15T12:00:00'),
  });
  assert.deepEqual(r.faixas.escala, []);
  assert.deepEqual(r.folgas, ['DR']);
});

test('carteira: renomeia sem recalcular; interrompidas fora da conta', () => {
  const c = montarCarteira({
    carteira_inicial: 10, entradas_novas: 2, atual: 3, andamento: 1,
    concluidas: 6, rejeitadas: 1, canceladas: 1,
  }, 2);
  assert.equal(c.inicial + c.entradas, c.pendentes + c.executadas + c.rejeitadas + c.remanejadas);
  assert.equal(c.interrompidas, 2);
  assert.equal(montarCarteira(null, 0), null);
});
