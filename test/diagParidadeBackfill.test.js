/**
 * test/diagParidadeBackfill.test.js
 *
 * 28/10/2026 (backlog P0-12 passo 1). Antes de trocar a coleta contínua por
 * janelas + fechamento por backfill, scripts/diag-paridade-backfill.js mede se o
 * dia montado pelo backfill dá o mesmo número do ao vivo. Estes testes travam:
 * consolidateDay só aceita snapshots de fora em dryRun (e aí não lê a tabela
 * snapshots), e as funções puras do script — separar backfill antigo do banco,
 * escolher os ciclos das janelas, comparar por equipe, notas e logon/logoff.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Banco falso ANTES de carregar o dataWriter (ele desestrutura o getClient no load).
const tabelasLidas = [];
function consulta(tabela) {
  tabelasLidas.push(tabela);
  const q = {
    select: () => q, in: () => q, eq: () => q, order: () => q,
    then: (ok, erro) => Promise.resolve({ data: [], error: null }).then(ok, erro),
  };
  return q;
}
require.cache[path.resolve(__dirname, '../services/dbClient.js')] = {
  id: 'dbClient', loaded: true, exports: { getClient: () => ({ from: consulta }) },
};

const { consolidateDay } = require('../services/dataWriter');
const p = require('../scripts/diag-paridade-backfill');

function equipe(nome, begin, end, concluidas, extra = {}) {
  return {
    teamName: nome, regional: 'GUA', sectorId: 'DESG', sessionBegin: begin, sessionEnd: end,
    notasConcluidas: concluidas.map(id => ({ id, codigo: id, tipoCode: 'C93', conclusionDate: begin })),
    notasRejeitadas: [], notasExecutadas: [], ...extra,
  };
}
const snap = (t, captured_at) => ({ team_name: t.teamName, regional: t.regional, sector_id: t.sectorId, captured_at, data: t });

test('consolidateDay: snapshots de fora sem dryRun é recusado', async () => {
  await assert.rejects(consolidateDay('2026-10-21', { snaps: [] }), /só vale com dryRun/);
});

test('consolidateDay: com snaps em dryRun não lê a tabela snapshots e conta pelo conjunto', async () => {
  tabelasLidas.length = 0;
  const t = equipe('EQA', '2026-10-20T11:00:00Z', '2026-10-20T20:00:00Z', ['n1', 'n2']);
  const r = await consolidateDay('2026-10-21', { dryRun: true, snaps: [snap(t, '2026-10-20T21:00:00Z')] });
  assert.ok(!tabelasLidas.includes('snapshots'));
  assert.deepEqual(p.porEquipe(r.rows, '2026-10-20'), new Map([['EQA', 2]]));
});

test('backfill antigo no banco é reconhecido por notasVistoriadas', () => {
  assert.equal(p.ehSnapshotDeBackfill({ data: { notasVistoriadas: [] } }), true);
  assert.equal(p.ehSnapshotDeBackfill({ data: { notasConcluidas: [] } }), false);
  assert.equal(p.ehSnapshotDeBackfill({}), false);
});

test('janelas: só o 1º ciclo a partir de 08h, 12h e 17h BRT', () => {
  const t = equipe('EQA', '2026-10-20T11:00:00Z', null, []);
  const rows = [
    snap(t, '2026-10-20T10:45:00Z'),   // 07:45 — fora
    snap(t, '2026-10-20T11:00:05Z'),   // 08:00 — 1º ciclo
    snap(t, '2026-10-20T11:01:30Z'),   // 08:01 — mesmo ciclo
    snap(t, '2026-10-20T11:15:00Z'),   // 08:15 — 2º ciclo, fora
    snap(t, '2026-10-20T15:00:00Z'),   // 12:00
    snap(t, '2026-10-20T20:21:00Z'),   // 17:21 — passou de :20, fora
  ];
  assert.deepEqual(p.snapshotsDasJanelas(rows).map(r => r.captured_at),
    ['2026-10-20T11:00:05Z', '2026-10-20T11:01:30Z', '2026-10-20T15:00:00Z']);
});

test('comoSnapshots: linha do fim do dia BRT com o nome da equipe', () => {
  const [r] = p.comoSnapshots([equipe('EQA', '2026-10-20T11:00:00Z', null, [])], '2026-10-20');
  assert.equal(r.team_name, 'EQA');
  assert.equal(r.captured_at, '2026-10-21T02:59:00.000Z');
});

test('difPorEquipe: só diferenças, maior módulo primeiro', () => {
  const a = new Map([['A', 10], ['B', 5], ['C', 3]]);
  const b = new Map([['A', 10], ['B', 2], ['D', 1]]);
  assert.deepEqual(p.difPorEquipe(a, b).map(x => [x.equipe, x.dif]), [['B', -3], ['C', -3], ['D', 1]]);
});

test('concluídas que só um caminho vê', () => {
  const vivo = [snap(equipe('EQA', '2026-10-20T11:00:00Z', null, ['n1', 'n2']), '2026-10-20T20:00:00Z')];
  const back = [snap(equipe('EQA', '2026-10-20T11:00:00Z', null, ['n2', 'n3']), '2026-10-21T02:59:00Z')];
  const cv = p.concluidasPorEquipe(vivo, '2026-10-20');
  const cb = p.concluidasPorEquipe(back, '2026-10-20');
  assert.deepEqual(p.soEmUm(cv, cb).map(n => n.id), ['n1']);
  assert.deepEqual(p.soEmUm(cb, cv).map(n => n.id), ['n3']);
});

test('logon/logoff: 1º logon e último logoff, tolerância de 5 min', () => {
  const vivo = [
    snap(equipe('EQA', '2026-10-20T11:00:00Z', null, []), '2026-10-20T12:00:00Z'),
    snap(equipe('EQA', '2026-10-20T11:00:00Z', '2026-10-20T20:00:00Z', []), '2026-10-20T21:00:00Z'),
    snap(equipe('EQB', '2026-10-20T11:00:00Z', '2026-10-20T19:00:00Z', []), '2026-10-20T21:00:00Z'),
  ];
  const back = [
    snap(equipe('EQA', '2026-10-20T11:03:00Z', '2026-10-20T20:30:00Z', []), '2026-10-21T02:59:00Z'),
    snap(equipe('EQC', '2026-10-20T11:00:00Z', null, []), '2026-10-21T02:59:00Z'),
  ];
  const r = p.compararLogon(p.logonLogoff(vivo, '2026-10-20'), p.logonLogoff(back, '2026-10-20'));
  assert.equal(r.equipes, 1);
  assert.equal(r.logonIgual, 1);
  assert.equal(r.logoffIgual, 0);
  assert.equal(r.logoffDif[0].min, 30);
  assert.deepEqual(r.soAoVivo, ['EQB']);
  assert.deepEqual(r.soBackfill, ['EQC']);
});
