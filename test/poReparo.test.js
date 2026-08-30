/**
 * test/poReparo.test.js
 *
 * Fase 1 de SPEC-tma-po-reparo-2026-08-30.md — a distância entre o "Horário do
 * Reparo" apontado e o checkpoint "Finalizando Trabalho" nas notas PO.
 *
 * O TESTE QUE IMPORTA É O DE FUSO. As duas pontas da conta chegam em formatos
 * diferentes: `RepairTime` vem UTC com "+00:00", e o checkpoint `RegisteredAt`
 * vem SEM marcador nenhum. Medido com os valores reais da nota 104875481:
 *
 *   TZ=America/Sao_Paulo   RegisteredAt2 → +7,03 min   RegisteredAt → +7,03 min
 *   TZ=UTC   (a VM)        RegisteredAt2 → +7,03 min   RegisteredAt → −172,97 min
 *
 * Ou seja, usar o campo errado PASSA na máquina do dev e QUEBRA em produção, com
 * 3h de erro que ainda inverte o sinal — viraria "reparo 3h depois do fim do
 * trabalho", absurdo plausível o bastante pra passar por anomalia de campo em vez
 * de bug de código. Por isso o teste força TZ e usa dados reais.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  finalizandoTrabalhoEm, montarLinhaReparo, faixaDoDelta,
  EVENT_FINALIZANDO, MINIMO_SEG,
} = require('../db/poReparoQueries');
const { _normalizePoExecution } = require('../services/wpaService');

// Valores REAIS da nota 104875481, conferidos contra o portal em 29-30/08/2026.
const REAL = {
  repairTime:    '2026-08-29T20:18:45+00:00',   // 17:18:45 BRT
  ev4RegAt2:     '2026-08-29T17:25:47-03:00',   // 17:25:47 BRT
  ev4RegAtCru:   '2026-08-29T17:25:47',         // sem fuso — a armadilha
  esperadoMin:   7.033333,
};

// ─────────────────────────────────────────────────────────────────────────────
// Fuso — o que protege 3 horas de erro
// ─────────────────────────────────────────────────────────────────────────────

test('a conta fecha em 7min02s com os dados reais da nota 104875481', () => {
  const linha = montarLinhaReparo(
    { repairTime: REAL.repairTime },
    [{ event: EVENT_FINALIZANDO, registradoEm: REAL.ev4RegAt2 }],
  );
  assert.equal(linha.delta_seg, 422);                       // 7min02s
  assert.ok(Math.abs(linha.delta_seg / 60 - REAL.esperadoMin) < 0.01);
});

test('o resultado NÃO depende do fuso do processo', () => {
  // A VM roda em UTC e a máquina do dev em BRT. Se o cálculo variar entre os
  // dois, o número da tela muda conforme onde roda — e ninguém percebe.
  const tzOriginal = process.env.TZ;
  const medir = () => montarLinhaReparo(
    { repairTime: REAL.repairTime },
    [{ event: EVENT_FINALIZANDO, registradoEm: REAL.ev4RegAt2 }],
  ).delta_seg;
  try {
    process.env.TZ = 'UTC';
    const emUtc = medir();
    process.env.TZ = 'America/Sao_Paulo';
    const emBrt = medir();
    assert.equal(emUtc, 422);
    assert.equal(emBrt, 422);
    assert.equal(emUtc, emBrt);
  } finally {
    if (tzOriginal === undefined) delete process.env.TZ;
    else process.env.TZ = tzOriginal;
  }
});

test('o campo SEM fuso daria resultado absurdo — por isso não é aceito', () => {
  // Demonstra o dano: interpretado como UTC, o mesmo instante vira -172,97 min.
  // Não é o código de produção sendo testado, é a razão de ele existir.
  const reparo = new Date(REAL.repairTime).getTime();
  const cru    = new Date(REAL.ev4RegAtCru + 'Z').getTime();   // como se fosse UTC
  assert.ok((cru - reparo) / 60000 < -170, 'o erro do campo cru tem de ser gritante');

  // E o código não aceita o campo cru: sem `registradoEm`, não mede.
  const linha = montarLinhaReparo(
    { repairTime: REAL.repairTime },
    [{ event: EVENT_FINALIZANDO, registeredAt: REAL.ev4RegAtCru }],
  );
  assert.equal(linha.delta_seg, null, 'checkpoint sem registradoEm não pode ser medido');
});

// ─────────────────────────────────────────────────────────────────────────────
// Escolha do checkpoint
// ─────────────────────────────────────────────────────────────────────────────

test('vários eventos 4 → vence o ÚLTIMO', () => {
  const em = finalizandoTrabalhoEm([
    { event: 4, registradoEm: '2026-08-29T10:00:00-03:00' },
    { event: 4, registradoEm: '2026-08-29T17:25:47-03:00' },
    { event: 4, registradoEm: '2026-08-29T14:00:00-03:00' },
  ]);
  assert.equal(new Date(em).toISOString(), new Date(REAL.ev4RegAt2).toISOString());
});

test('só o evento 4 conta — os outros são ignorados', () => {
  const em = finalizandoTrabalhoEm([
    { event: 0, registradoEm: '2026-08-29T16:40:53-03:00' },
    { event: 1, registradoEm: '2026-08-29T16:51:24-03:00' },
    { event: 2, registradoEm: '2026-08-29T16:53:17-03:00' },
    { event: 3, registradoEm: '2026-08-29T17:35:06-03:00' },
  ]);
  assert.equal(em, null, 'sem evento 4 não há Finalizando Trabalho');
});

test('checkpoint sem registradoEm é ignorado, não estimado', () => {
  assert.equal(finalizandoTrabalhoEm([{ event: 4, registradoEm: null }]), null);
  assert.equal(finalizandoTrabalhoEm([{ event: 4 }]), null);
  assert.equal(finalizandoTrabalhoEm([]), null);
  assert.equal(finalizandoTrabalhoEm(null), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// "Não medido" ≠ "medido em zero"
// ─────────────────────────────────────────────────────────────────────────────

test('sem RepairTime → delta null, e o resto da linha sobrevive', () => {
  const linha = montarLinhaReparo(
    { repairTime: null, hasRepair: false, classe: '350' },
    [{ event: 4, registradoEm: REAL.ev4RegAt2 }],
  );
  assert.equal(linha.delta_seg, null);
  assert.equal(linha.has_repair, false, 'false é valor legítimo, não ausência');
  assert.equal(linha.classe, '350', 'o resto do bloco continua sendo gravado');
  assert.ok(linha.finalizando_em, 'o checkpoint medido não se perde');
});

test('poExec nulo não quebra — devolve linha vazia', () => {
  const linha = montarLinhaReparo(null, [{ event: 4, registradoEm: REAL.ev4RegAt2 }]);
  assert.equal(linha.delta_seg, null);
  assert.equal(linha.repair_time, null);
  assert.equal(linha.has_repair, null, 'null é "não informado", diferente de false');
});

test('delta NEGATIVO é preservado, não zerado nem descartado', () => {
  // Reparo apontado DEPOIS do fim do trabalho: fisicamente impossível e o caso
  // mais acionável. Foram 6 em 158 na amostra de 30/08, chegando a -42min.
  const linha = montarLinhaReparo(
    { repairTime: '2026-08-29T18:00:00+00:00' },
    [{ event: 4, registradoEm: '2026-08-29T14:30:00-03:00' }],   // 17:30 UTC
  );
  assert.equal(linha.delta_seg, -1800, 'meia hora negativa tem de aparecer como -1800');
});

// ─────────────────────────────────────────────────────────────────────────────
// Faixas
// ─────────────────────────────────────────────────────────────────────────────

test('as fronteiras das faixas não deixam buraco nem sobreposição', () => {
  assert.equal(faixaDoDelta(null), 'nao_medido');
  assert.equal(faixaDoDelta(NaN),  'nao_medido');
  assert.equal(faixaDoDelta(-1),   'negativo');
  assert.equal(faixaDoDelta(0),    'abaixo');            // zero não é negativo
  assert.equal(faixaDoDelta(MINIMO_SEG - 1), 'abaixo');
  assert.equal(faixaDoDelta(MINIMO_SEG),     'ok');      // 10min exatos CUMPRE
  assert.equal(faixaDoDelta(422),  'abaixo');            // a nota real
});

test('o critério é 10 minutos', () => {
  assert.equal(MINIMO_SEG, 600);
  assert.equal(EVENT_FINALIZANDO, 4);
});

// ─────────────────────────────────────────────────────────────────────────────
// O normalizador da resposta da EDP
// ─────────────────────────────────────────────────────────────────────────────

test('_normalizePoExecution lê a resposta real da EDP', () => {
  // Recorte fiel da resposta de /api/notes/po pra nota 104875481.
  const po = _normalizePoExecution({
    Execution: {
      ExecutedById: '40f7ab14-277b-425a-8119-2835155f9108',
      Try: 1,
      Circuit: 'MRT03',
      PowerOnExecution: {
        RepairTime: '2026-08-29T20:18:45+00:00',
        PredictionRepairDate: '2026-08-29T21:10:25+00:00',
        ConfirmationDate: '2026-08-29T20:25:25+00:00',
        HasRepair: true,
        IncidentDevice: 'C 0000844791',
        Class: '350', Reason: '329', Climate: '1',
        TeamOnTargetResult: 'confirmado',
      },
    },
  });
  assert.equal(po.repairTime, '2026-08-29T20:18:45+00:00',
    'o +00:00 tem de sobreviver — anexar Z ou trocar o offset aqui vira erro de 3h');
  assert.equal(po.hasRepair, true);
  assert.equal(po.classe, '350');
  assert.equal(po.teamId, '40f7ab14-277b-425a-8119-2835155f9108');
  assert.equal(po.circuito, 'MRT03');
});

test('_normalizePoExecution devolve null quando não há PowerOnExecution', () => {
  assert.equal(_normalizePoExecution(null), null);
  assert.equal(_normalizePoExecution({}), null);
  assert.equal(_normalizePoExecution({ Execution: {} }), null);
  assert.equal(_normalizePoExecution({ Data: { Execution: { PowerOnExecution: null } } }), null);
});

test('_normalizePoExecution aceita o envelope Data da WPA', () => {
  const po = _normalizePoExecution({
    Data: { Execution: { PowerOnExecution: { RepairTime: '2026-08-29T20:18:45+00:00' } } },
  });
  assert.equal(po.repairTime, '2026-08-29T20:18:45+00:00');
});

test('sentinela 0001-01-01 da EDP vira null, não uma data do ano 1', () => {
  const po = _normalizePoExecution({
    Execution: { PowerOnExecution: { RepairTime: '0001-01-01T00:00:00', HasRepair: false } },
  });
  assert.equal(po.repairTime, null);
  assert.equal(po.hasRepair, false);
});
