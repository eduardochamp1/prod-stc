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
  instanteCp, intervalosDaNota, unir, montarRotina, montarCarteira, desvioDoBreak,
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

test('unir', () => {
  const u = unir([{ ini: 0, fim: 10 }, { ini: 5, fim: 20 }, { ini: 30, fim: 40 }]);
  assert.deepEqual(u, [{ ini: 0, fim: 20 }, { ini: 30, fim: 40 }]);
});

test('rotina completa; desvio vem do apontamento, não do buraco', () => {
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
  // Sem parada apontada não há desvio — o buraco entre apontamentos NÃO é desvio
  // no vocabulário da EDP (export "Serviços e Desvios", EPICO30 04/09/2026).
  assert.equal(r.totaisMin.desvio, 0);
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
  assert.equal(r.totaisMin.desvio, 0);
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

// ── Desvio = parada apontada na sessão (sessao_intervalo) ────────────────────
// Caso real: export "Serviços e Desvios" da EDP, EPICO30, 04/09/2026.
const D4 = '2026-09-04';
const ANTES = msParede('2026-10-15T12:00:00');

test('desvios do export da EDP viram as barras com motivo', () => {
  const r = montarRotina({
    dia: D4,
    desvios: [
      { motivo: '06 - Check List', inicio: `${D4}T11:00:20`, fim: `${D4}T11:14:44` },
      { motivo: '15 - Horário de Refeição', inicio: `${D4}T18:59:39`, fim: `${D4}T19:58:35` },
      { motivo: '29 - Retorno da equipe à base', inicio: `${D4}T20:56:13`, fim: `${D4}T22:14:58` },
    ],
    agoraMs: ANTES,
  });
  assert.deepEqual(r.faixas.desvio.map(d => d.motivo),
    ['06 - Check List', '15 - Horário de Refeição', '29 - Retorno da equipe à base']);
  // EDP: 14 + 59 + 79 min (a coluna "Tempo (min)" do export trunca; aqui é soma exata arredondada)
  assert.equal(r.totaisMin.desvio, 152);
});

test('desvio em aberto: hoje vai até agora; dia passado não é inventado', () => {
  const hoje = montarRotina({ dia: DIA, desvios: [{ motivo: '15 - Refeição', inicio: `${DIA}T12:00:00`, fim: null }],
    agoraMs: msParede(`${DIA}T12:30:00`) });
  assert.equal(hoje.faixas.desvio[0].fim, M('12:30'));
  assert.equal(hoje.faixas.desvio[0].aberto, true);
  const passado = montarRotina({ dia: DIA, desvios: [{ motivo: 'x', inicio: `${DIA}T12:00:00`, fim: null }], agoraMs: ANTES });
  assert.equal(passado.faixas.desvio.length, 0);
  assert.equal(passado.avisos.desvioSemFim, 1);
});

test('break ao vivo: o Z falso do normalizador sai, a parede fica', () => {
  const d = desvioDoBreak({ motivo: '06 - Check List', inicio: '2026-09-04T11:00:20Z', fim: '2026-09-04T11:14:44.123Z' });
  assert.equal(msParede(d.inicio), msParede('2026-09-04T11:00:20'));
  assert.equal(msParede(d.fim), msParede('2026-09-04T11:14:44'));
  assert.equal(desvioDoBreak({ inicio: '2026-09-04T11:00:20Z', fim: null }).fim, null);
});

test('serviço fechado por interrupção leva o motivo', () => {
  const r = montarRotina({
    dia: D4,
    notas: [{ id: 'dd', numero: '000017340324', tipo: 'DD', status: 'executada', checkpoints: [
      { event: 2, registradoEm: `${D4}T12:06:03-03:00` }] }],
    interrupcoes: [{ note_id: 'dd', instanteMs: msParede(`${D4}T12:06:32`), motivo: 'SUSPENSO PARA OUTROS SERVIÇOS' }],
    agoraMs: ANTES,
  });
  assert.equal(r.faixas.servico[0].status, 'interrompida');
  assert.equal(r.faixas.servico[0].motivo, 'SUSPENSO PARA OUTROS SERVIÇOS');
});

// ── 15/10/2026: serviço "de 00:00 à tarde" no Plano Diário ──────────────────
test('2 sem 3 de tentativa anterior não emenda com o 3 de hoje', () => {
  const ontem = '2026-08-31';
  const r = montarRotina({
    dia: DIA,
    notas: [{ id: 'x', numero: '9', tipo: 'MD', status: 'concluida', checkpoints: [
      { event: 0, registradoEm: `${ontem}T15:00:00-03:00` },
      { event: 1, registradoEm: `${ontem}T15:20:00-03:00` },
      { event: 2, registradoEm: `${ontem}T15:21:00-03:00` },   // interrompida ontem, sem 3
      cp(0, '10:00'), cp(1, '10:20'), cp(2, '10:25'), cp(3, '11:00'),
    ] }],
    agoraMs: msParede('2026-10-15T12:00:00'),
  });
  assert.deepEqual(r.faixas.servico.map(s => [s.ini, s.fim]), [[M('10:25'), M('11:00')]]);
  assert.equal(r.avisos.servicoSemFim, 0);   // o bloco de ontem não é aviso de hoje
});

test('serviço retomado: o bloco interrompido fecha na interrupção, o retomado no 3', () => {
  const r = montarRotina({
    dia: DIA,
    notas: [{ id: 'x', status: 'concluida', checkpoints: [cp(2, '12:00'), cp(2, '12:33'), cp(3, '12:57')] }],
    interrupcoes: [{ note_id: 'x', instanteMs: msParede(`${DIA}T12:12:00`), motivo: 'falta material' }],
    agoraMs: msParede('2026-10-15T12:00:00'),
  });
  assert.deepEqual(r.faixas.servico.map(s => [s.ini, s.fim, s.status]),
    [[M('12:00'), M('12:12'), 'interrompida'], [M('12:33'), M('12:57'), 'concluida']]);
});

test('hoje: só o último bloco aberto vai até agora', () => {
  const r = montarRotina({
    dia: DIA,
    notas: [{ id: 'x', status: 'executada', checkpoints: [cp(2, '09:00'), cp(0, '10:00'), cp(1, '10:10'), cp(2, '10:15')] }],
    agoraMs: msParede(`${DIA}T11:00:00`),
  });
  assert.deepEqual(r.faixas.servico.map(s => [s.ini, s.fim, s.status]), [[M('10:15'), M('11:00'), 'andamento']]);
  assert.equal(r.avisos.servicoSemFim, 1);   // o das 09:00 parou sem 3 e sem interrupção
});
