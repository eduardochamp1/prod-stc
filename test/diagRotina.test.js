/**
 * test/diagRotina.test.js
 *
 * scripts/diag-rotina.js — conferência da aba Rotina contra o export
 * "Serviços e Desvios" da EDP. Caso real: EPICO30, 04/09/2026 (15/10/2026).
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  chaveMotivo, minutosDoExport, eventosDoExport, eventosDaRotina, casar,
} = require('../scripts/diag-rotina');

const DIA = '2026-09-04';
const M = (h, m, s = 0) => h * 60 + m + s / 60;

test('chave do motivo: o código, com ou sem zero à esquerda', () => {
  assert.equal(chaveMotivo('06 - Check List'), '6');
  assert.equal(chaveMotivo('6 - check list'), '6');
  assert.equal(chaveMotivo('Retorno da equipe à base'), 'retorno da equipe à base');
});

test('data do export: texto en-US, texto pt-BR e serial do Excel dão o mesmo instante', () => {
  assert.equal(minutosDoExport('9/4/2026 11:00:20 AM', DIA), M(11, 0, 20));
  assert.equal(minutosDoExport('9/4/2026 6:59:39 PM', DIA), M(18, 59, 39));
  assert.equal(minutosDoExport('9/4/2026 12:06:03 PM', DIA), M(12, 6, 3));
  assert.equal(minutosDoExport('04/09/2026 11:00:20', DIA), M(11, 0, 20));
  // 04/09/2026 11:00:20 como serial do Excel (parede, sem fuso)
  const serial = 25569 + (Date.UTC(2026, 8, 4, 11, 0, 20) / 86400000);
  assert.equal(minutosDoExport(serial, DIA), M(11, 0, 20));
  assert.equal(minutosDoExport(null, DIA), null);
});

const EXPORT = [
  { Equipe: 'EPICO30', Evento: 'Desvio', 'Descrição': '06 - Check List', Nota: null, 'Início': '9/4/2026 11:00:20 AM', Fim: '9/4/2026 11:14:44 AM' },
  { Equipe: 'EPICO30', Evento: 'Deslocamento', 'Descrição': 'DD - 000017340324', Nota: '000017340324', 'Início': '9/4/2026 11:16:02 AM', Fim: '9/4/2026 12:05:53 PM' },
  { Equipe: 'EPICO30', Evento: 'Serviço - Atividade', 'Descrição': 'PO - 104930451 - Executada', Nota: '104930451', 'Início': '9/4/2026 12:13:20 PM', Fim: null },
  { Equipe: 'EPICO30', Evento: 'Serviço', 'Descrição': 'PO - 104930451 - Executada', Nota: '104930451', 'Início': '9/4/2026 12:13:20 PM', Fim: '9/4/2026 1:44:47 PM' },
  { Equipe: 'OUTRA01', Evento: 'Serviço', 'Descrição': 'x', Nota: '1', 'Início': '9/4/2026 12:00:00 PM', Fim: '9/4/2026 1:00:00 PM' },
];

test('export: só a equipe pedida, sem as linhas "Serviço - Atividade"', () => {
  const ev = eventosDoExport(EXPORT, 'EPICO30', DIA);
  assert.deepEqual(ev.map(e => e.evento), ['Desvio', 'Deslocamento', 'Serviço']);
  assert.equal(ev[0].chave, '6');
});

test('casa por evento + chave e mede a diferença em segundos', () => {
  const edp = eventosDoExport(EXPORT, 'EPICO30', DIA);
  const nosso = eventosDaRotina({ faixas: {
    desvio: [{ ini: M(11, 0, 20), fim: M(11, 14, 44), motivo: '06 - Check List' }],
    deslocamento: [{ ini: M(11, 16, 2), fim: M(12, 5, 53), numero: '000017340324', tipo: 'DD' }],
    servico: [
      { ini: M(12, 13, 50), fim: M(13, 44, 47), numero: '104930451', tipo: 'PO', status: 'concluida' },
      { ini: M(15, 0), fim: M(15, 30), numero: '999', tipo: 'MD', status: 'concluida' },
    ],
  } });
  const { pares, soEdp, soNosso } = casar(edp, nosso);
  assert.equal(pares.length, 3);
  assert.equal(soEdp.length, 0);
  assert.deepEqual(soNosso.map(e => e.chave), ['999']);
  const serv = pares.find(p => p.edp.evento === 'Serviço');
  assert.equal(serv.dIniSeg, 30);    // painel 30s depois da EDP
  assert.equal(serv.dFimSeg, 0);
});

test('fora da tolerância não casa — vira "só na EDP" e "só no painel"', () => {
  const edp = eventosDoExport(EXPORT.slice(0, 1), 'EPICO30', DIA);
  const nosso = eventosDaRotina({ faixas: { desvio: [{ ini: M(13, 0), fim: M(13, 10), motivo: '06 - Check List' }] } });
  const r = casar(edp, nosso);
  assert.equal(r.pares.length, 0);
  assert.equal(r.soEdp.length, 1);
  assert.equal(r.soNosso.length, 1);
});
