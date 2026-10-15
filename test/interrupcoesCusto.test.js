/**
 * test/interrupcoesCusto.test.js
 *
 * Coleta de interrupções ampliada a TODOS os tipos (15/10/2026, pedido do José:
 * "medindo o custo na conta EDP"). Trava o que protege a conta compartilhada:
 *   - teto de GETs por ciclo, com o excedente adiado (não marcado como visto);
 *   - MD na frente do teto;
 *   - contagem por tipo de GET com interrupção × vazio × falha.
 * dbClient, wpaService e equipesOficiais são trocados no require.cache — o ciclo
 * roda inteiro sem banco nem WPA.
 */

'use strict';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const S = (f) => path.join(__dirname, '..', 'services', f);
const originais = {};
function stub(arquivo, exports) {
  const id = require.resolve(S(arquivo));
  if (!(id in originais)) originais[id] = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

// Respostas da WPA por nota: array de interrupções, ou Error pra simular falha.
let respostas = {};
let getsFeitos = [];
let gravadas = [];
stub('wpaService.js', {
  async getNoteInterruptions(id) {
    getsFeitos.push(id);
    const r = respostas[id];
    if (r instanceof Error) throw r;
    return r || [];
  },
});
stub('dbClient.js', {
  getClient: () => ({
    from: () => ({ upsert: async (linhas) => { gravadas.push(...linhas); return { error: null }; } }),
  }),
});
stub('equipesOficiais.js', { getRegional: () => 'GUA' });

const svcId = require.resolve(S('interrupcaoService.js'));
delete require.cache[svcId];
const svc = require(S('interrupcaoService.js'));

const envAntes = { DATA_MODE: process.env.DATA_MODE, T: process.env.INTERR_TIPOS, M: process.env.INTERR_MAX_GETS_CICLO };
beforeEach(() => {
  process.env.DATA_MODE = 'postgres';
  delete process.env.INTERR_TIPOS;
  delete process.env.INTERR_MAX_GETS_CICLO;
  respostas = {}; getsFeitos = []; gravadas = [];
  svc._resetMemoria();
});
after(() => {
  for (const [id, mod] of Object.entries(originais)) {
    if (mod) require.cache[id] = mod; else delete require.cache[id];
  }
  delete require.cache[svcId];
  for (const [k, v] of [['DATA_MODE', envAntes.DATA_MODE], ['INTERR_TIPOS', envAntes.T], ['INTERR_MAX_GETS_CICLO', envAntes.M]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

const nota = (id, tipoCode) => ({ id, codigo: 'N' + id, tipoCode, executionStatus: 3 });
const equipe = (notas) => [{ sectorId: 'DESG', regional: 'GUA', notasExecutadas: notas }];

test('conta por tipo: GET com interrupção, vazio e falha', async () => {
  // O stub devolve já no formato normalizado do wpaService ({ id, dia, equipe }).
  respostas = {
    m1: [{ id: 'i1', dia: '2026-10-15', equipe: 'ECGPR51', instante: null }],
    s1: [],
    d1: new Error('timeout'),
  };
  await svc.runColetaInterrupcoes(equipe([nota('s1', 'SF'), nota('m1', 'MD'), nota('d1', 'DD')]));
  const c = svc.custoDoDia();
  assert.equal(c.gets, 3);
  assert.deepEqual(c.porTipo.MD, { gets: 1, comInterrupcao: 1, vazias: 0, falhas: 0 });
  assert.deepEqual(c.porTipo.SF, { gets: 1, comInterrupcao: 0, vazias: 1, falhas: 0 });
  assert.deepEqual(c.porTipo.DD, { gets: 1, comInterrupcao: 0, vazias: 0, falhas: 1 });
  assert.equal(gravadas.length, 1);
  assert.equal(gravadas[0].tipo, 'MD');
});

test('teto por ciclo: excedente é adiado e volta no ciclo seguinte; MD passa na frente', async () => {
  process.env.INTERR_MAX_GETS_CICLO = '2';
  const notas = [nota('s1', 'SF'), nota('s2', 'SF'), nota('m1', 'MD')];
  await svc.runColetaInterrupcoes(equipe(notas));
  assert.deepEqual(getsFeitos, ['m1', 's1']);
  assert.equal(svc.custoDoDia().adiadas, 1);

  getsFeitos = [];
  await svc.runColetaInterrupcoes(equipe(notas));
  assert.deepEqual(getsFeitos, ['s2'], 'só a adiada é buscada; as já vistas em 3 não gastam GET de novo');
  assert.equal(svc.custoDoDia().gets, 3);
});

test('falha de rede não marca como visto: retenta no ciclo seguinte', async () => {
  respostas = { s1: new Error('503') };
  await svc.runColetaInterrupcoes(equipe([nota('s1', 'SF')]));
  respostas = {};
  getsFeitos = [];
  await svc.runColetaInterrupcoes(equipe([nota('s1', 'SF')]));
  assert.deepEqual(getsFeitos, ['s1']);
});

test('INTERR_TIPOS=MD: outro tipo não gasta GET (rollback sem código)', async () => {
  process.env.INTERR_TIPOS = 'MD';
  await svc.runColetaInterrupcoes(equipe([nota('s1', 'SF'), nota('m1', 'MD')]));
  assert.deepEqual(getsFeitos, ['m1']);
});

test('caminho do detalhe também conta (origem detalhe)', async () => {
  respostas = { p1: [{ id: 'i9', dia: '2026-10-15', equipe: 'EPGPR30', instante: null }] };
  await svc.coletarDaNota({ note_id: 'p1', numero: 'N1', tipo: 'PO', sector_id: 'DESG' });
  const c = svc.custoDoDia();
  assert.equal(c.getsDetalhe, 1);
  assert.deepEqual(c.porTipo.PO, { gets: 1, comInterrupcao: 1, vazias: 0, falhas: 0 });
});

test('custoDoDia devolve cópia (quem lê não altera o contador)', async () => {
  await svc.runColetaInterrupcoes(equipe([nota('s1', 'SF')]));
  const c = svc.custoDoDia();
  c.gets = 999;
  assert.equal(svc.custoDoDia().gets, 1);
});
