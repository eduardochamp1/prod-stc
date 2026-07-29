/**
 * test/equipeTipoMatrix.test.js
 *
 * Trava _buildEquipeTipoMatrix: a matriz EQUIPE × TIPO da aba Gráficos, com
 * EXEC (concluídas de team_daily_totals) e REJE (rejeitadas cruas de
 * note_rejections). Função pura — assume linhas já filtradas pela whitelist.
 *
 * Regras: EXEC soma `count` por (equipe, tipo_code); REJE conta 1 por linha de
 * note_rejections (equipe, tipo); TOTAL = soma dos tipos; filtro tipo de equipe
 * (COMERCIAL=EC*, PLANTAO=EP*); tipos = união dos códigos presentes.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { _buildEquipeTipoMatrix } = require('../db/queries');

const exec = (team_name, tipo_code, count, regional = 'GUA', sector_id = 'DESG') =>
  ({ team_name, tipo_code, count, regional, sector_id });
const rej = (team_name, tipo, regional = 'GUA', sector_id = 'DESG') =>
  ({ team_name, tipo, regional, sector_id });

const byName = (r, name) => r.equipes.find(e => e.team_name === name);

test('EXEC soma count por tipo e no total', () => {
  const r = _buildEquipeTipoMatrix(
    [exec('ECGPR53', 'LN', 3), exec('ECGPR53', 'LE', 2), exec('ECGPR53', 'LN', 1)],
    [],
  );
  const t = byName(r, 'ECGPR53');
  assert.equal(t.exec.LN, 4, 'duas linhas LN somam');
  assert.equal(t.exec.LE, 2);
  assert.equal(t.total_exec, 6);
  assert.equal(t.total_rej, 0);
});

test('REJE conta 1 por linha (equipe, tipo) e no total', () => {
  const r = _buildEquipeTipoMatrix(
    [],
    [rej('ECGPR53', 'MD'), rej('ECGPR53', 'MD'), rej('ECGPR53', 'LN')],
  );
  const t = byName(r, 'ECGPR53');
  assert.equal(t.rej.MD, 2);
  assert.equal(t.rej.LN, 1);
  assert.equal(t.total_rej, 3);
  assert.equal(t.total_exec, 0);
});

test('EXEC e REJE convivem na mesma equipe/tipo sem se misturar', () => {
  const r = _buildEquipeTipoMatrix(
    [exec('ECGPR53', 'LN', 10)],
    [rej('ECGPR53', 'LN'), rej('ECGPR53', 'LN')],
  );
  const t = byName(r, 'ECGPR53');
  assert.equal(t.exec.LN, 10);
  assert.equal(t.rej.LN, 2);
  assert.equal(t.total_exec, 10);
  assert.equal(t.total_rej, 2);
});

test('equipe só com rejeitadas (sem produção) ainda aparece', () => {
  const r = _buildEquipeTipoMatrix([], [rej('ECXYZ99', 'SF')]);
  const t = byName(r, 'ECXYZ99');
  assert.ok(t, 'equipe presente');
  assert.equal(t.total_exec, 0);
  assert.equal(t.rej.SF, 1);
});

test('tipos = união dos códigos presentes em EXEC e REJE', () => {
  const r = _buildEquipeTipoMatrix(
    [exec('E1', 'LN', 1), exec('E1', 'DL', 1)],
    [rej('E1', 'SF'), rej('E1', 'LN')],
  );
  assert.deepEqual([...r.tipos].sort(), ['DL', 'LN', 'SF']);
});

test('tipo_equipe derivado da sigla (EC/EP/OP)', () => {
  const r = _buildEquipeTipoMatrix(
    [exec('ECGPR53', 'LN', 1), exec('EPGPR31', 'PO', 1), exec('ETGPR15', 'SF', 1)],
    [],
  );
  assert.equal(byName(r, 'ECGPR53').tipo_equipe, 'COMERCIAL');
  assert.equal(byName(r, 'EPGPR31').tipo_equipe, 'PLANTAO');
  assert.equal(byName(r, 'ETGPR15').tipo_equipe, 'OPERACIONAL');
});

test('filtro COMERCIAL mantém só EC* (EXEC e REJE)', () => {
  const r = _buildEquipeTipoMatrix(
    [exec('ECGPR53', 'LN', 1), exec('EPGPR31', 'PO', 1)],
    [rej('ETGPR15', 'SF'), rej('ECGPR53', 'LN')],
    'COMERCIAL',
  );
  assert.equal(r.equipes.length, 1);
  assert.equal(r.equipes[0].team_name, 'ECGPR53');
  assert.equal(r.equipes[0].exec.LN, 1);
  assert.equal(r.equipes[0].rej.LN, 1);
});

test('filtro PLANTAO mantém só EP*', () => {
  const r = _buildEquipeTipoMatrix(
    [exec('ECGPR53', 'LN', 1), exec('EPGPR31', 'PO', 1)],
    [],
    'PLANTAO',
  );
  assert.equal(r.equipes.length, 1);
  assert.equal(r.equipes[0].team_name, 'EPGPR31');
});

test('ordena por (total_exec + total_rej) desc', () => {
  const r = _buildEquipeTipoMatrix(
    [exec('E_PEQ', 'LN', 2), exec('E_GRANDE', 'LN', 50)],
    [rej('E_PEQ', 'MD'), rej('E_PEQ', 'MD'), rej('E_PEQ', 'MD')],
  );
  assert.equal(r.equipes[0].team_name, 'E_GRANDE', '50 > 2+3');
  assert.equal(r.equipes[1].team_name, 'E_PEQ');
});

test('entrada vazia → matriz vazia (sem crash)', () => {
  const r = _buildEquipeTipoMatrix([], []);
  assert.deepEqual(r.equipes, []);
  assert.deepEqual(r.tipos, []);
  const r2 = _buildEquipeTipoMatrix(null, null);
  assert.deepEqual(r2.equipes, []);
});
