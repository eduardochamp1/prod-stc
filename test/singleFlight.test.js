/**
 * test/singleFlight.test.js
 *
 * Trava a coalescência de coletas por setor (incidente 30/07/2026): o snapshot
 * disparado no boot e o /api/teams de quem abre a página logo após o deploy
 * disparavam DUAS varreduras completas da WPA em paralelo (~60 fetches cada),
 * dobrando a carga na API da EDP (que já devolve 500/502 sob pressão) e
 * deixando o Monitor "travado carregando".
 *
 * _singleFlight garante: enquanto há uma coleta EM VOO pra mesma chave, os
 * chamadores seguintes aguardam a MESMA promise. NÃO é cache — depois de
 * resolver, a chave é liberada e a próxima chamada executa de novo (a frescura
 * dos dados continua a mesma de antes).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { _singleFlight } = require('../services/wpaService');

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

test('chamadas concorrentes na MESMA chave executam fn 1x', async () => {
  const map = new Map();
  let execs = 0;
  const fn = async () => { execs++; await tick(20); return 'ok'; };

  const [a, b, c] = await Promise.all([
    _singleFlight(map, 'DESG', fn),
    _singleFlight(map, 'DESG', fn),
    _singleFlight(map, 'DESG', fn),
  ]);
  assert.equal(execs, 1, 'uma única varredura');
  assert.deepEqual([a, b, c], ['ok', 'ok', 'ok'], 'todos recebem o mesmo resultado');
});

test('chaves diferentes (setores distintos) NÃO se misturam', async () => {
  const map = new Map();
  const vistos = [];
  const fn = (s) => async () => { vistos.push(s); await tick(10); return s; };

  const [x, y] = await Promise.all([
    _singleFlight(map, 'DESG', fn('DESG')),
    _singleFlight(map, 'DSSJ', fn('DSSJ')),
  ]);
  assert.deepEqual([x, y], ['DESG', 'DSSJ']);
  assert.deepEqual(vistos.sort(), ['DESG', 'DSSJ'], 'cada setor executou o seu');
});

test('NÃO é cache: depois de resolver, a próxima chamada executa de novo', async () => {
  const map = new Map();
  let execs = 0;
  const fn = async () => { execs++; await tick(5); return execs; };

  await _singleFlight(map, 'DESG', fn);
  await _singleFlight(map, 'DESG', fn);
  assert.equal(execs, 2, 'dados não são reaproveitados (frescura preservada)');
  assert.equal(map.size, 0, 'chave liberada ao terminar');
});

test('erro propaga pra TODOS os chamadores e libera a chave', async () => {
  const map = new Map();
  let execs = 0;
  const fn = async () => { execs++; await tick(5); throw new Error('WPA 500'); };

  const p1 = _singleFlight(map, 'DESG', fn);
  const p2 = _singleFlight(map, 'DESG', fn);
  await assert.rejects(p1, /WPA 500/);
  await assert.rejects(p2, /WPA 500/);
  assert.equal(execs, 1, 'só uma tentativa mesmo com erro');
  assert.equal(map.size, 0, 'chave liberada após falhar (próxima tenta de novo)');
});

test('fn síncrona que lança também é capturada (não vaza a chave)', async () => {
  const map = new Map();
  const fn = () => { throw new Error('boom'); };
  await assert.rejects(_singleFlight(map, 'X', fn), /boom/);
  assert.equal(map.size, 0);
});
