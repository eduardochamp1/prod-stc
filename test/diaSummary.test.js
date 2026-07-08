/**
 * test/diaSummary.test.js
 *
 * Trava a aritmética do painel do dia (P0-3): _buildDiaSummary classifica cada
 * UUID de nota em EXATAMENTE 1 bucket (concluida > rejeitada > andamento >
 * atual) e calcula canceladas/entradas_novas. É o número que a gestão olha
 * diariamente. Já produziu bug em prod (canc=904 vs 294 esperado, 11/06/2026).
 *
 * Usa pool fake injetado via pgShim._setPool — sem Postgres real. O fake
 * distingue as 3 queries de _buildDiaSummary pela SQL (ASC=primeiro snap,
 * DESC=último snap, note_rejections=rejeições persistentes).
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const pgShim = require('../services/pgShim');
const { _buildDiaSummary } = require('../services/dataService');

// notas → formato do que o SELECT DISTINCT ON devolve (arrays JSONB de {id})
const nota = (id) => ({ id });
const teamRow = (name, { baixadas = [], executadas = [], concluidas = [], rejeitadas = [] } = {}) => ({
  team_name: name,
  baixadas:   baixadas.map(nota),
  executadas: executadas.map(nota),
  concluidas: concluidas.map(nota),
  rejeitadas: rejeitadas.map(nota),
});

/**
 * Monta um pool fake. first/last são arrays de teamRow; rej é array de note_id.
 */
function fakePool({ first = [], last = [], rej = [] }) {
  return {
    async query(sql) {
      if (/note_rejections/i.test(sql)) {
        return { rows: rej.map(id => ({ note_id: id })) };
      }
      if (/captured_at ASC/i.test(sql))  return { rows: first };
      if (/captured_at DESC/i.test(sql)) return { rows: last };
      return { rows: [] };
    },
  };
}

afterEach(() => pgShim._setPool(null));

// invariante que DEVE fechar sempre, por construção
function assertInvariante(s) {
  const soma = s.atual + s.andamento + s.concluidas + s.rejeitadas + s.canceladas;
  assert.equal(s.inicial + s.entradas_novas, soma,
    `invariante quebrada: inicial(${s.inicial}) + entradas(${s.entradas_novas}) != ` +
    `atual(${s.atual})+and(${s.andamento})+conc(${s.concluidas})+rej(${s.rejeitadas})+canc(${s.canceladas})`);
}

test('_buildDiaSummary: nota concluída presente do início ao fim', async () => {
  pgShim._setPool(fakePool({
    first: [teamRow('E1', { baixadas: ['a'] })],
    last:  [teamRow('E1', { concluidas: ['a'] })],
  }));
  const s = await _buildDiaSummary(null);
  assert.equal(s.inicial, 1);
  assert.equal(s.concluidas, 1);
  assert.equal(s.atual, 0);
  assert.equal(s.canceladas, 0);
  assert.equal(s.entradas_novas, 0);
  assertInvariante(s);
});

test('_buildDiaSummary: nota que some do último snap → cancelada', async () => {
  pgShim._setPool(fakePool({
    first: [teamRow('E1', { baixadas: ['a', 'b'] })],
    last:  [teamRow('E1', { concluidas: ['a'] })], // 'b' sumiu
  }));
  const s = await _buildDiaSummary(null);
  assert.equal(s.inicial, 2);
  assert.equal(s.concluidas, 1);
  assert.equal(s.canceladas, 1); // 'b'
  assertInvariante(s);
});

test('_buildDiaSummary: nota só no último snap → entrada_nova', async () => {
  pgShim._setPool(fakePool({
    first: [teamRow('E1', { baixadas: ['a'] })],
    last:  [teamRow('E1', { baixadas: ['a'], concluidas: ['z'] })], // 'z' nova
  }));
  const s = await _buildDiaSummary(null);
  assert.equal(s.inicial, 1);
  assert.equal(s.entradas_novas, 1); // 'z'
  assert.equal(s.concluidas, 1);
  assert.equal(s.atual, 1); // 'a' segue baixada
  assertInvariante(s);
});

test('_buildDiaSummary: UUID em 2 buckets do último snap → prioridade concluida', async () => {
  // Mesma nota aparece em concluidas (equipe A) E baixadas (equipe B).
  // Prioridade concluida > atual → conta 1x como concluida, não 2x.
  pgShim._setPool(fakePool({
    first: [teamRow('A', { baixadas: ['x'] })],
    last:  [
      teamRow('A', { concluidas: ['x'] }),
      teamRow('B', { baixadas: ['x'] }),
    ],
  }));
  const s = await _buildDiaSummary(null);
  assert.equal(s.concluidas, 1);
  assert.equal(s.atual, 0);
  assert.equal(s.canceladas, 0);
  assertInvariante(s);
});

test('_buildDiaSummary: note_rejections captura rejeitada que sumiu do payload', async () => {
  // Bug 12/06: WPA limpou notasRejeitadas do último snap, mas note_rejections
  // tem o UUID. Sem a união, 'r' viraria "cancelada"; com ela, é "rejeitada".
  pgShim._setPool(fakePool({
    first: [teamRow('E1', { baixadas: ['r'] })],
    last:  [teamRow('E1', {})],  // payload vazio (WPA limpou)
    rej:   ['r'],                // mas persistiu em note_rejections
  }));
  const s = await _buildDiaSummary(null);
  assert.equal(s.rejeitadas, 1);
  assert.equal(s.canceladas, 0); // NÃO cancelada
  assertInvariante(s);
});

test('_buildDiaSummary: prioridade rejeitada > andamento > atual', async () => {
  // 'y' está em executadas (andamento) do último snap E em note_rejections.
  // Prioridade: rejeitada ganha de andamento.
  pgShim._setPool(fakePool({
    first: [teamRow('E1', { baixadas: ['y'] })],
    last:  [teamRow('E1', { executadas: ['y'] })],
    rej:   ['y'],
  }));
  const s = await _buildDiaSummary(null);
  assert.equal(s.rejeitadas, 1);
  assert.equal(s.andamento, 0);
  assertInvariante(s);
});

test('_buildDiaSummary: cenário misto grande — invariante fecha', async () => {
  pgShim._setPool(fakePool({
    first: [
      teamRow('E1', { baixadas: ['a', 'b', 'c'], executadas: ['d'] }),
      teamRow('E2', { baixadas: ['e', 'f'] }),
    ],
    last: [
      teamRow('E1', { concluidas: ['a'], rejeitadas: ['b'], baixadas: ['c'], executadas: ['d'] }),
      teamRow('E2', { concluidas: ['e'], baixadas: ['g'] }), // 'f' sumiu, 'g' nova
    ],
    rej: ['b'],
  }));
  const s = await _buildDiaSummary(null);
  // inicial = a,b,c,d,e,f = 6
  assert.equal(s.inicial, 6);
  // concluidas = a,e = 2; rejeitadas = b = 1; andamento = d = 1; atual = c,g = 2
  assert.equal(s.concluidas, 2);
  assert.equal(s.rejeitadas, 1);
  assert.equal(s.andamento, 1);
  assert.equal(s.atual, 2);
  // canceladas = f (sumiu, não rejeitada) = 1; entradas = g = 1
  assert.equal(s.canceladas, 1);
  assert.equal(s.entradas_novas, 1);
  assertInvariante(s);
});

test('_buildDiaSummary: pool ausente → null (fallback do frontend)', async () => {
  pgShim._setPool(null);
  const s = await _buildDiaSummary(null);
  assert.equal(s, null);
});
