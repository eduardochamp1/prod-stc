/**
 * test/supervisorFiltro.test.js
 *
 * Filtro de Supervisor nas abas (07/10/2026). Sem harness de frontend (risco
 * H11): as funções PURAS são extraídas do index.html e executadas, e as
 * invariantes estruturais são checadas por texto — no estilo do
 * test/equipesAdminTela.test.js. Isto NÃO prova que a tela renderiza.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// Mesmo extrator do equipesAdminTela.test.js (parênteses primeiro, depois corpo).
function extrairFuncao(nome) {
  const marca = `function ${nome}(`;
  const ini   = SRC.indexOf(marca);
  assert.ok(ini > -1, `não achei ${marca} no index.html`);
  let paren = 0, fimParams = -1;
  for (let i = ini + marca.length - 1; i < SRC.length; i++) {
    if (SRC[i] === '(') paren++;
    else if (SRC[i] === ')') { paren--; if (paren === 0) { fimParams = i; break; } }
  }
  const abre = SRC.indexOf('{', fimParams);
  let nivel = 0;
  for (let i = abre; i < SRC.length; i++) {
    if (SRC[i] === '{') nivel++;
    else if (SRC[i] === '}') { nivel--; if (nivel === 0) return SRC.slice(ini, i + 1); }
  }
  throw new Error(`chaves não fecharam em ${nome}`);
}

const fns = new Function(`
  ${extrairFuncao('_supOpcoes')}
  ${extrairFuncao('_supSiglas')}
  ${extrairFuncao('_supIntersect')}
  ${extrairFuncao('_filtrarEquipes')}
  return { _supOpcoes, _supSiglas, _supIntersect, _filtrarEquipes };
`)();

const EQS = [
  { sigla: 'ECGPR51', regional: 'GUA', supervisor_id: 2, supervisor_nome: 'MARIA', ativo: true },
  { sigla: 'ECGPR53', regional: 'GUA', supervisor_id: 1, supervisor_nome: 'ANA',   ativo: true },
  { sigla: 'EPCIT30', regional: 'CAC', supervisor_id: 2, supervisor_nome: 'MARIA', ativo: true },
  { sigla: 'ETCIT15', regional: 'CAC', supervisor_id: null, ativo: true },
  { sigla: 'ETCIT16', regional: 'CAC', ativo: false },   // migration não aplicada: campo ausente
];

test('_supOpcoes: distintos, por nome, ignora quem não tem supervisor', () => {
  assert.deepEqual(fns._supOpcoes(EQS), [{ id: '1', nome: 'ANA' }, { id: '2', nome: 'MARIA' }]);
  assert.deepEqual(fns._supOpcoes([]), []);
});

test('_supSiglas: ALL = sem filtro; id; NONE = sem supervisor', () => {
  assert.equal(fns._supSiglas(EQS, 'ALL'), null);
  assert.equal(fns._supSiglas(EQS, ''), null);
  assert.deepEqual([...fns._supSiglas(EQS, '2')].sort(), ['ECGPR51', 'EPCIT30']);
  assert.deepEqual([...fns._supSiglas(EQS, 2)].sort(), ['ECGPR51', 'EPCIT30']);
  assert.deepEqual([...fns._supSiglas(EQS, 'NONE')].sort(), ['ETCIT15', 'ETCIT16']);
  // Supervisor sem equipe → conjunto VAZIO, nunca null (null seria "todas").
  const vazio = fns._supSiglas(EQS, '99');
  assert.ok(vazio instanceof Set);
  assert.equal(vazio.size, 0);
});

test('_supIntersect: null é neutro; vazio continua vazio', () => {
  const a = new Set(['X', 'Y']);
  assert.equal(fns._supIntersect(null, null), null);
  assert.equal(fns._supIntersect(a, null), a);
  assert.deepEqual([...fns._supIntersect(null, new Set(['Y']))], ['Y']);
  assert.deepEqual([...fns._supIntersect(a, new Set(['Y', 'Z']))], ['Y']);
  assert.equal(fns._supIntersect(a, new Set()).size, 0);
});

test('_filtrarEquipes (Admin): filtro e busca por supervisor', () => {
  const base = { texto: '', regional: 'ALL', situacao: 'ALL' };
  assert.equal(fns._filtrarEquipes(EQS, { ...base, supervisor: 'ALL' }).length, 5);
  assert.deepEqual(fns._filtrarEquipes(EQS, { ...base, supervisor: '2' }).map(e => e.sigla),
    ['ECGPR51', 'EPCIT30']);
  assert.deepEqual(fns._filtrarEquipes(EQS, { ...base, supervisor: 'NONE' }).map(e => e.sigla),
    ['ETCIT15', 'ETCIT16']);
  assert.deepEqual(fns._filtrarEquipes(EQS, { ...base, texto: 'ana' }).map(e => e.sigla), ['ECGPR53']);
  // Chamada antiga, sem o campo supervisor, segue igual.
  assert.equal(fns._filtrarEquipes(EQS, base).length, 5);
});

test('as 6 abas têm o select de Supervisor', () => {
  for (const id of ['mon', 'graf', 'rej', 'ranking', 'hist', 'mapa']) {
    assert.ok(SRC.includes(`id="${id}-supervisor-select"`), `falta ${id}-supervisor-select`);
    assert.ok(SRC.includes(`_supPopularSelect('${id}-supervisor-select')`), `${id}: select nunca é populado`);
  }
});

test('Gráficos e Rejeições barram conjunto vazio em vez de cair em "todas"', () => {
  // O caminho server-side manda `team=` só quando há siglas. Supervisor sem
  // equipe no recorte, sem esta guarda, viraria "sem filtro" = TODAS as equipes.
  const graf = extrairFuncao('loadGraficos');
  assert.match(graf, /_teamsEf && _teamsEf\.size === 0/);
  const rej = extrairFuncao('loadRejeicoes');
  assert.match(rej, /_ef && _ef\.size === 0/);
});

test('salvar vínculo no Admin atualiza os filtros sem F5 (08/10/2026)', () => {
  // Bug relatado: a lista do filtro era carregada uma vez por página, então
  // vincular equipe a supervisor não chegava às abas até recarregar.
  const inval = extrairFuncao('_supInvalidar');
  assert.match(inval, /_supEquipes = null/);
  assert.match(inval, /_supEquipesPromise = null/);
  assert.match(extrairFuncao('salvarEquipe'), /_supInvalidar\(\)/);
  assert.match(extrairFuncao('renomearSupervisor'), /_supInvalidar\(\)/);
});

test('formulário só manda supervisor_id quando mudou', () => {
  const salvar = extrairFuncao('salvarEquipe');
  assert.match(salvar, /supSel\.value !== supSel\.dataset\.original/);
});
