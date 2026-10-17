/**
 * test/escalaForaDaEscala.test.js
 *
 * Saldo ABERTO do KPI "em campo × esperadas" (16/10/2026, P2-65). O card dizia
 * "N a mais que o previsto" — saldo de duas listas que nunca se cruzavam. Às
 * 17:00 dava "+70" com as equipes só encerrando o turno. Agora o backend diz o
 * motivo de cada equipe fora da escala e o front abre a conta; nenhum número é
 * ajustado, e a aritmética fecha por construção.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { _setPool } = require('../services/pgShim');
const Q = require('../db/escalaQueries');

// ── Grupo exibido ────────────────────────────────────────────────────────────

test('depois do fim: até 30 min é "encerrando turno"; passou disso é prorrogação', () => {
  assert.equal(Q.ENCERRANDO_TURNO_MIN, 30);
  assert.equal(Q.grupoForaDaEscala('depois-do-turno', 0).grupo, 'encerrando');
  assert.equal(Q.grupoForaDaEscala('depois-do-turno', 30).grupo, 'encerrando');
  assert.equal(Q.grupoForaDaEscala('depois-do-turno', 31).grupo, 'prorrogacao');
  assert.equal(Q.grupoForaDaEscala('sem-escala-hoje', null).grupo, 'sem-escala');
  assert.equal(Q.grupoForaDaEscala('antes-do-turno', 10).grupo, 'antes');
  assert.equal(Q.grupoForaDaEscala('folga-no-cadastro', null).grupo, 'folga');
  assert.equal(Q.grupoForaDaEscala('codigo-fora-do-catalogo', null).grupo, 'sem-horario');
  assert.equal(Q.grupoForaDaEscala('outra-regional', null).grupo, 'regional');
});

// ── foraDaEscalaAgora com pool falso ─────────────────────────────────────────

// 16/10/2026 17:10 BRT — o turno T08 (08:00→17:00) acabou há 10 min.
const QUANDO = new Date('2026-10-16T17:10:00-03:00');

function poolFalso({ esperadas = [], escala = [], whitelist = [] }) {
  const chamadas = [];
  return {
    chamadas,
    async query(sql, params) {
      chamadas.push({ sql, params });
      if (/ANY\(\$3::text\[\]\)/.test(sql)) {
        return { rows: escala.filter(l => params[2].includes(l.sigla)) };
      }
      if (/WHERE ativo AND upper\(btrim\(sigla\)\) = ANY/.test(sql)) {
        return { rows: whitelist.filter(w => params[0].includes(w.sigla)) };
      }
      // equipesEsperadasAgora
      const regs = params.slice(2);
      return { rows: esperadas.filter(e => !regs.length || regs.includes(e.regional)) };
    },
  };
}
const T08 = (sigla, extra = {}) => ({
  data: '2026-10-16', sigla, codigo_escala: 'T08 08:00', no_catalogo: true, prefixo_catalogo: null,
  inicio_escala: '08:00:00', fim_escala: '17:00:00', ...extra,
});

test('classifica só quem está em campo e NÃO está esperado, com motivo e grupo', async () => {
  const pool = poolFalso({
    esperadas: [{ data: '2026-10-16', sigla: 'ETARDE1', tipo: 'BT', regional: 'GUA',
      inicio_escala: '15:00:00', fim_escala: '23:59:00', codigo_escala: 'T15' }],
    escala: [T08('ECGPR82'), T08('EPMFL30', { inicio_escala: '07:00:00', fim_escala: '15:00:00', codigo_escala: 'T07 07:00' })],
    whitelist: [
      { sigla: 'ECGPR82', regional: 'GUA', tipo: 'BT' },
      { sigla: 'EPMFL30', regional: 'GUA', tipo: 'PLANTAO' },
      { sigla: 'EPAVP37', regional: 'GUA', tipo: 'PLANTAO' },
    ],
  });
  _setPool(pool);
  try {
    const fora = await Q.foraDaEscalaAgora(['ETARDE1', 'ecgpr82 ', 'EPMFL30', 'EPAVP37'], null, QUANDO);
    const por = Object.fromEntries(fora.map(f => [f.sigla, f]));
    assert.deepEqual(Object.keys(por).sort(), ['ECGPR82', 'EPAVP37', 'EPMFL30'], 'a esperada não entra');
    assert.equal(por.ECGPR82.grupo, 'encerrando');
    assert.equal(por.ECGPR82.minutos, 10);
    assert.equal(por.EPMFL30.grupo, 'prorrogacao');
    assert.equal(por.EPMFL30.minutos, 130);
    assert.equal(por.EPAVP37.grupo, 'sem-escala');
  } finally { _setPool(null); }
});

test('esperada numa regional fora do escopo vira "escala em outra regional", não "sem escala"', async () => {
  const pool = poolFalso({
    esperadas: [{ data: '2026-10-16', sigla: 'ECCAC10', tipo: 'BT', regional: 'CAC',
      inicio_escala: '15:00:00', fim_escala: '23:59:00', codigo_escala: 'T15' }],
    whitelist: [{ sigla: 'ECCAC10', regional: 'CAC', tipo: 'BT' }],
  });
  _setPool(pool);
  try {
    const fora = await Q.foraDaEscalaAgora(['ECCAC10'], ['GUA'], QUANDO);
    assert.equal(fora.length, 1);
    assert.equal(fora[0].grupo, 'regional');
  } finally { _setPool(null); }
});

test('ninguém fora da escala → nenhuma consulta extra', async () => {
  const pool = poolFalso({});
  _setPool(pool);
  try {
    const esp = { equipes: ['A1'] };
    assert.deepEqual(await Q.foraDaEscalaAgora(['A1'], null, QUANDO, esp), []);
    assert.equal(pool.chamadas.length, 0);
  } finally { _setPool(null); }
});

// ── Front: bloco SALDO DA ESCALA (regras puras) ──────────────────────────────

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')
  .replace(/\r\n/g, '\n');
const bloco = (ini, fim) => {
  const a = HTML.indexOf(ini), b = HTML.indexOf(fim);
  assert.ok(a > 0 && b > a, `bloco ${ini} não encontrado`);
  return HTML.slice(a, b);
};
const ctx = {};
vm.createContext(ctx);
vm.runInContext(
  bloco('/* ── ALERTA DE SESSÃO (regras puras)', '/* ── fim ALERTA DE SESSÃO')
  + bloco('/* ── SALDO DA ESCALA (regras puras)', '/* ── fim SALDO DA ESCALA')
  + '\nthis.api = { saldoEscala, htmlSaldoEscala };', ctx);
const F = ctx.api;

const det = (sigla, extra = {}) => ({ sigla, regional: 'GUA', inicio: '15:00', codigo: 'T15', minutosDesdeInicio: 130, ...extra });

test('aritmética fecha: em campo = na escala + fora; esperadas = na escala + faltando', () => {
  const s = F.saldoEscala({
    emCampo: ['A', 'B', 'C', 'D'],
    detalhe: [det('A'), det('B'), det('X')],
    foraDaEscala: [{ sigla: 'C', grupo: 'encerrando', rotulo: 'encerrando turno (até 30 min)', minutos: 5 },
                   { sigla: 'D', grupo: 'prorrogacao', rotulo: 'prorrogação', minutos: 90 }],
  });
  assert.equal(s.emCampo, 4);
  assert.equal(s.esperadas, 3);
  assert.equal(s.naEscala, 2);
  assert.equal(s.fora.length, 2);
  assert.equal(s.faltando.length, 1);
  assert.equal(s.emCampo, s.naEscala + s.fora.length);
  assert.equal(s.esperadas, s.naEscala + s.faltando.length);
  // Array do vm é de outro realm: compara o conteúdo, não o protótipo.
  assert.equal(JSON.stringify(s.grupos.map(g => g.grupo)), '["encerrando","prorrogacao"]');
});

test('filtro de equipes vale pros dois lados, mas quem está em campo nunca sai da escala', () => {
  // Busca "ec" no front: o campo já vem filtrado. A escala tem de ser filtrada
  // igual — senão "faltam" acusa equipe que a tela nem mostra.
  const s = F.saldoEscala({
    emCampo: ['ECA'],
    detalhe: [det('ECA'), det('ECB'), det('ETZ')],
    filtroEsperada: e => e.sigla.toLowerCase().includes('ec'),
  });
  assert.equal(s.esperadas, 2, 'ETZ fica fora do filtro');
  assert.equal(s.faltando.length, 1);
  // Em campo por busca de NOME de colaborador: a sigla não casa com a busca,
  // mas está na tela — continua contando como na escala.
  const s2 = F.saldoEscala({ emCampo: ['ETZ'], detalhe: [det('ETZ')], filtroEsperada: () => false });
  assert.equal(s2.naEscala, 1);
  assert.equal(s2.fora.length, 0);
});

test('equipe fora da escala sem motivo do backend não some: vai pra "sem classificação"', () => {
  const s = F.saldoEscala({ emCampo: ['Q'], detalhe: [], foraDaEscala: null });
  assert.equal(s.fora.length, 1);
  assert.equal(s.fora[0].grupo, 'sem-classificacao');
});

test('HTML: mostra os três números, lista por motivo e escapa a sigla', () => {
  const s = F.saldoEscala({
    emCampo: ['A', '<b>'], detalhe: [det('A'), det('X')],
    foraDaEscala: [{ sigla: '<B>', grupo: 'encerrando', rotulo: 'encerrando turno (até 30 min)', minutos: 12 }],
  });
  const html = F.htmlSaldoEscala(s);
  assert.match(html, /<b>1<\/b> na escala/);
  assert.match(html, /<b>1<\/b> fora · /);
  // A lista é um balão flutuante: dentro do card ela esticava a grade
  // ("esse card ficou muito grande", José, 16/10/2026).
  assert.match(html, /class="saldo-pop" style="display:none;position:fixed/);
  assert.match(html, /faltam <b>1<\/b>/);
  assert.match(html, /encerrando turno \(até 30 min\)<\/b> \(1\): <span[^>]*>&lt;B&gt; \+12 min/);
  assert.doesNotMatch(html, /a mais que o previsto/);
});
