/**
 * test/equipesImport.test.js
 *
 * `montarPlano` e as regras de validação de equipe oficial.
 *
 * Função pura: sem banco, sem DOM, sem rede. É onde mora toda a decisão da
 * importação em lote — ver docs/handoff/SPEC-import-equipes-2026-09-17.md.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { validateEquipe, MAX_LINHAS } = require('../services/equipesImport');

test('validateEquipe aceita uma equipe completa e válida', () => {
  const erros = validateEquipe({
    sigla: 'EBGPR62', setor: 'DESG', regional: 'GUA',
    tipo: 'BTZERO', placa: 'ABC-1234',
  });
  assert.deepEqual(erros, []);
});

test('validateEquipe recusa sigla curta, setor e regional inválidos', () => {
  const erros = validateEquipe({
    sigla: 'EB', setor: 'XXXX', regional: 'ZZZ', tipo: 'BTZERO',
  });
  assert.equal(erros.length, 3);
  assert.ok(erros.some(e => /sigla/.test(e)));
  assert.ok(erros.some(e => /setor/.test(e)));
  assert.ok(erros.some(e => /regional/.test(e)));
});

test('validateEquipe aceita DSSJ como setor', () => {
  const erros = validateEquipe({
    sigla: 'ESJSP01', setor: 'DSSJ', regional: 'SJC', tipo: 'COMERCIAL',
  });
  assert.deepEqual(erros, []);
});

test('validateEquipe trata placa como opcional', () => {
  assert.deepEqual(validateEquipe({
    sigla: 'EBGPR62', setor: 'DESG', regional: 'GUA', tipo: 'CS',
  }), []);
});

test('MAX_LINHAS é 500', () => {
  assert.equal(MAX_LINHAS, 500);
});

// ─────────────────────────────────────────────────────────────────────────────
// montarPlano — o destino de cada linha da planilha
// ─────────────────────────────────────────────────────────────────────────────

const { montarPlano } = require('../services/equipesImport');

/** Opções de lote válidas, para os testes não repetirem isso. */
const LOTE = { regional: 'GUA', setor: 'DESG', tipoPadrao: 'COMERCIAL' };

/** Uma equipe como o GET /admin/equipes devolve. */
function equipe(over = {}) {
  return {
    sigla: 'EBGPR62', setor: 'DESG', regional: 'GUA',
    tipo: 'BTZERO', placa: 'ABC-1234', ativo: true, ...over,
  };
}

test('sigla que não existe no cadastro vira "nova"', () => {
  const p = montarPlano(
    [{ linhaPlanilha: 2, sigla: 'ENOVA01', tipo: 'CS', placa: 'XYZ-9999' }],
    [], LOTE);

  assert.equal(p.novas.length, 1);
  assert.equal(p.alteradas.length, 0);
  assert.equal(p.identicas, 0);
  assert.deepEqual(p.erros, []);
  assert.deepEqual(p.novas[0], {
    linhaPlanilha: 2, sigla: 'ENOVA01', setor: 'DESG',
    regional: 'GUA', tipo: 'CS', placa: 'XYZ-9999',
  });
});

test('sigla existente com tudo igual conta como idêntica, não alterada', () => {
  const p = montarPlano(
    [{ linhaPlanilha: 2, sigla: 'EBGPR62', tipo: 'BTZERO', placa: 'ABC-1234' }],
    [equipe()], LOTE);

  assert.equal(p.identicas, 1);
  assert.equal(p.alteradas.length, 0);
  assert.equal(p.novas.length, 0);
});

test('só a placa muda → alterada, com SÓ o campo placa em mudancas', () => {
  const p = montarPlano(
    [{ linhaPlanilha: 2, sigla: 'EBGPR62', tipo: 'BTZERO', placa: 'NOV-0001' }],
    [equipe()], LOTE);

  assert.equal(p.alteradas.length, 1);
  assert.deepEqual(p.alteradas[0].mudancas, [
    { campo: 'placa', de: 'ABC-1234', para: 'NOV-0001' },
  ]);
});

test('equipe no cadastro e AUSENTE da planilha não aparece em lugar nenhum', () => {
  // Trava a §3.1 do spec: a importação NUNCA desativa. Pelo P2-20, a leitura do
  // histórico usa a whitelist de HOJE — desativar apaga produção já reportada
  // à EDP. Planilha chega incompleta; isso não pode virar exclusão.
  const p = montarPlano(
    [{ linhaPlanilha: 2, sigla: 'ENOVA01', tipo: 'CS', placa: null }],
    [equipe({ sigla: 'EANTIGA9' })], LOTE);

  assert.equal(p.novas.length, 1);
  assert.equal(p.alteradas.length, 0);
  assert.equal(p.identicas, 0);
  const todas = JSON.stringify(p);
  assert.ok(!todas.includes('EANTIGA9'), 'a equipe ausente da planilha vazou pro plano');
});

test('normaliza minúsculas e espaços nas pontas', () => {
  const p = montarPlano(
    [{ linhaPlanilha: 2, sigla: '  enova01 ', tipo: ' cs ', placa: ' xyz-9999 ' }],
    [], LOTE);

  assert.equal(p.novas[0].sigla, 'ENOVA01');
  assert.equal(p.novas[0].tipo, 'CS');
  assert.equal(p.novas[0].placa, 'XYZ-9999');
});

test('célula de tipo vazia usa o tipo padrão do lote', () => {
  const p = montarPlano(
    [{ linhaPlanilha: 2, sigla: 'ENOVA01', tipo: '', placa: null }],
    [], LOTE);

  assert.equal(p.novas[0].tipo, 'COMERCIAL');
});

test('placa vazia vira null, não string vazia', () => {
  const p = montarPlano(
    [{ linhaPlanilha: 2, sigla: 'ENOVA01', tipo: 'CS', placa: '  ' }],
    [], LOTE);

  assert.equal(p.novas[0].placa, null);
});

test('linha inteiramente vazia é descartada sem virar erro', () => {
  // Planilha tem linha em branco no fim. Isso não é problema do usuário.
  const p = montarPlano(
    [{ linhaPlanilha: 9, sigla: '', tipo: '', placa: '' }],
    [], LOTE);

  assert.deepEqual(p.erros, []);
  assert.equal(p.novas.length, 0);
});
