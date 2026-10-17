/**
 * test/diagEscalaAMais.test.js
 *
 * scripts/diag-escala-a-mais.js explica, equipe a equipe, por que o Monitor
 * mostra "N a mais que o previsto" (16/10/2026). O diag só vale se a união de
 * sessões for a MESMA do front e se cada motivo sair do caso certo — um diag que
 * classifica errado manda a correção pro lugar errado.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { unirSessoes, classificarExcedente, janelaContem } = require('../scripts/diag-escala-a-mais');

const HOJE = '2026-10-16';
const ONTEM = '2026-10-15';
const min = (h, m = 0) => h * 60 + m;

const linha = (over) => ({
  data: HOJE, codigo_escala: 'T07 07:00', no_catalogo: true, prefixo_catalogo: null,
  inicio_escala: '07:00:00', fim_escala: '16:00:00', ...over,
});
const ctx = (over) => ({
  sigla: 'ECGPR82', naWhitelist: true, regionalWl: 'GUA', regionalSessao: 'GUA',
  refLogon: `${HOJE}T06:40:00-03:00`, shiftType: 'T07 07:00',
  turnoV2: { inicio: '07:00', fim: '16:00' }, linhas: [linha()], agoraMin: min(6, 45), hoje: HOJE,
  ...over,
});

test('unirSessoes: relogin com sessão encerrada + aberta conta 1 equipe em campo', () => {
  const m = unirSessoes([
    { team_name: 'ECGPR82', session_begin: '2026-10-16T07:00', session_end: '2026-10-16T09:00', is_online: 'false' },
    { team_name: 'ecgpr82 ', session_begin: '2026-10-16T09:05', session_end: null, is_online: 'true' },
  ], HOJE);
  assert.equal(m.size, 1);
  const e = m.get('ECGPR82');
  assert.equal(e.emCampo, true);
  assert.equal(e.sessoesAbertas, 1);
});

test('unirSessoes: sessão aberta com isOnline=false NÃO é em campo (mesma regra do front)', () => {
  const m = unirSessoes([{ team_name: 'X', session_begin: 'a', session_end: null, is_online: 'false' }], HOJE);
  assert.equal(m.get('X').aberta, true);
  assert.equal(m.get('X').emCampo, false);
});

test('logou antes do início do turno → antes-do-turno com os minutos', () => {
  const r = classificarExcedente(ctx());
  assert.equal(r.motivo, 'antes-do-turno');
  assert.equal(r.minutos, 15);
});

test('turno acabou e segue logada → depois-do-turno', () => {
  const r = classificarExcedente(ctx({ agoraMin: min(17, 30) }));
  assert.equal(r.motivo, 'depois-do-turno');
  assert.equal(r.minutos, 90);
});

test('vira-noite de ontem que acabou há pouco, folga hoje → depois-do-turno (prorrogação)', () => {
  const r = classificarExcedente(ctx({
    agoraMin: min(7), shiftType: 'C35 22:35',
    linhas: [
      linha({ data: ONTEM, codigo_escala: 'C35 22:35', inicio_escala: '22:35:00', fim_escala: '06:00:00' }),
      linha({ codigo_escala: 'FOL', no_catalogo: false, inicio_escala: null, fim_escala: null }),
    ],
  }));
  assert.equal(r.motivo, 'depois-do-turno');
  assert.equal(r.minutos, 60);
});

test('só folga hoje e turno de ontem acabou há muito → folga-no-cadastro', () => {
  const r = classificarExcedente(ctx({
    agoraMin: min(10),
    linhas: [
      linha({ data: ONTEM }),
      linha({ codigo_escala: 'DR', no_catalogo: true, inicio_escala: null, fim_escala: null }),
    ],
  }));
  assert.equal(r.motivo, 'folga-no-cadastro');
});

test('sem linha nenhuma de escala hoje → sem-escala-hoje (P2-47)', () => {
  assert.equal(classificarExcedente(ctx({ linhas: [] })).motivo, 'sem-escala-hoje');
});

test('código que só casa por prefixo → codigo-com-grafia-diferente', () => {
  const r = classificarExcedente(ctx({ linhas: [linha({
    codigo_escala: 'T07  07:00', no_catalogo: false, prefixo_catalogo: 'T07 07:00',
    inicio_escala: null, fim_escala: null,
  })] }));
  assert.equal(r.motivo, 'codigo-com-grafia-diferente');
});

test('código fora do catálogo / sem horário / janela 24h', () => {
  const sem = { inicio_escala: null, fim_escala: null };
  assert.equal(classificarExcedente(ctx({ linhas: [linha({ no_catalogo: false, ...sem })] })).motivo,
    'codigo-fora-do-catalogo');
  assert.equal(classificarExcedente(ctx({ linhas: [linha(sem)] })).motivo, 'codigo-sem-horario');
  assert.equal(classificarExcedente(ctx({ linhas: [linha({ fim_escala: '07:00:00' })] })).motivo,
    'janela-ambigua');
});

test('fora da whitelist vem antes de tudo', () => {
  assert.equal(classificarExcedente(ctx({ naWhitelist: false })).motivo, 'fora-whitelist');
});

test('atributos: dia anterior, regional divergente, ShiftType V2 diferente e cobrindo agora', () => {
  const r = classificarExcedente(ctx({
    agoraMin: min(17, 30), refLogon: `${ONTEM}T20:00:00-03:00`, regionalSessao: 'CAC',
    shiftType: 'T15 15:00', turnoV2: { inicio: '15:00', fim: '00:00' },
  }));
  for (const f of ['sessao-de-dia-anterior', 'regional-diverge', 'v2-turno-diferente', 'v2-turno-cobre-agora']) {
    assert.ok(r.flags.includes(f), `faltou ${f}: ${r.flags}`);
  }
});

test('janelaContem: vira-noite cobre as duas pontas; início == fim não cobre', () => {
  assert.equal(janelaContem(min(22, 35), min(6), min(2)), true);
  assert.equal(janelaContem(min(22, 35), min(6), min(12)), false);
  assert.equal(janelaContem(min(7), min(7), min(8)), false);
});
