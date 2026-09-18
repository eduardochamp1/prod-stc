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

// ─────────────────────────────────────────────────────────────────────────────
// Erros — "tem que indicar quais linhas estão erradas" (José, 17/09/2026)
// ─────────────────────────────────────────────────────────────────────────────

test('sigla curta vira erro com linha, valor lido e motivo', () => {
  const p = montarPlano(
    [{ linhaPlanilha: 7, sigla: 'EBG', tipo: 'CS', placa: null }],
    [], LOTE);

  assert.equal(p.erros.length, 1);
  assert.equal(p.erros[0].linhaPlanilha, 7, 'o número tem de ser o do Excel');
  assert.equal(p.erros[0].campo, 'sigla');
  assert.equal(p.erros[0].valor, 'EBG', 'o valor lido tem de aparecer');
  assert.match(p.erros[0].motivo, /4 a 12/);
});

test('sigla repetida no arquivo erra e aponta a linha anterior', () => {
  // Não é preciosismo: dataWriter.js:89 documenta que o Postgres aborta o
  // upsert inteiro com "ON CONFLICT DO UPDATE command cannot affect row a
  // second time". Sem pegar aqui, o lote de 40 linhas morre por causa de 2.
  const p = montarPlano([
    { linhaPlanilha: 9,  sigla: 'ECGPR51', tipo: 'COMERCIAL', placa: null },
    { linhaPlanilha: 12, sigla: 'ECGPR51', tipo: 'COMERCIAL', placa: null },
  ], [], LOTE);

  assert.equal(p.novas.length, 1, 'a primeira ocorrência entra');
  assert.equal(p.erros.length, 1);
  assert.equal(p.erros[0].linhaPlanilha, 12);
  assert.match(p.erros[0].motivo, /linha 9/, 'tem de citar a linha da 1ª ocorrência');
});

test('placa inválida vira erro sem derrubar as outras linhas', () => {
  const p = montarPlano([
    { linhaPlanilha: 2,  sigla: 'EBOA0001', tipo: 'CS', placa: 'ABC-1234' },
    { linhaPlanilha: 19, sigla: 'EMGPR70',  tipo: 'CS', placa: 'A-1' },
    { linhaPlanilha: 20, sigla: 'EBOA0002', tipo: 'CS', placa: 'DEF-5678' },
  ], [], LOTE);

  assert.equal(p.novas.length, 2, 'as linhas boas seguem');
  assert.equal(p.erros.length, 1);
  assert.equal(p.erros[0].linhaPlanilha, 19);
  assert.equal(p.erros[0].campo, 'placa');
  assert.equal(p.erros[0].valor, 'A-1');
});

test('lote acima de MAX_LINHAS é recusado inteiro', () => {
  const muitas = Array.from({ length: MAX_LINHAS + 1 }, (_, i) => ({
    linhaPlanilha: i + 2,
    sigla: `E${String(i).padStart(6, '0')}`,
    tipo: 'CS', placa: null,
  }));
  const p = montarPlano(muitas, [], LOTE);

  assert.equal(p.novas.length, 0);
  assert.equal(p.erros.length, 1);
  assert.match(p.erros[0].motivo, /500/);
});

test('regional ou setor de lote inválidos recusam o lote inteiro', () => {
  const p = montarPlano(
    [{ linhaPlanilha: 2, sigla: 'ENOVA01', tipo: 'CS', placa: null }],
    [], { regional: 'ZZZ', setor: 'DESG', tipoPadrao: 'CS' });

  assert.equal(p.novas.length, 0);
  assert.equal(p.erros.length, 1);
  assert.match(p.erros[0].motivo, /regional/i);
});

test('tipo padrão ausente recusa o lote (tipo é NOT NULL no schema)', () => {
  const p = montarPlano(
    [{ linhaPlanilha: 2, sigla: 'ENOVA01', tipo: '', placa: null }],
    [], { regional: 'GUA', setor: 'DESG', tipoPadrao: '' });

  assert.equal(p.novas.length, 0);
  assert.equal(p.erros.length, 1);
  assert.match(p.erros[0].motivo, /tipo padrão/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// Inativas e o payload do upsert
// ─────────────────────────────────────────────────────────────────────────────

const { linhasParaUpsert } = require('../services/equipesImport');

test('sigla inativa presente na planilha cai em `inativas`', () => {
  const p = montarPlano(
    [{ linhaPlanilha: 2, sigla: 'EBGPR62', tipo: 'BTZERO', placa: 'ABC-1234' }],
    [equipe({ ativo: false })], LOTE);

  assert.equal(p.inativas.length, 1);
  assert.equal(p.inativas[0].sigla, 'EBGPR62');
});

test('sem reativar, o payload NÃO contém a chave ativo em nenhuma linha', () => {
  // Spec 3.3: linha nova pega o DEFAULT true do schema; linha existente mantém
  // o valor. Reativar mexe em número reportado (P2-20 ao contrário) e é decisão.
  const p = montarPlano([
    { linhaPlanilha: 2, sigla: 'EBGPR62', tipo: 'BTZERO', placa: 'NOV-0001' },
    { linhaPlanilha: 3, sigla: 'ENOVA01', tipo: 'CS',     placa: null },
  ], [equipe({ ativo: false })], { ...LOTE, reativar: false });

  const rows = linhasParaUpsert(p, { reativar: false });
  assert.equal(rows.length, 2);
  rows.forEach(r => assert.ok(!('ativo' in r), 'nenhuma linha pode trazer `ativo`'));
});

test('com reativar, TODAS as linhas trazem ativo:true — nunca um lote misto', () => {
  // pgShim.upsert monta as colunas pela UNIÃO das chaves e põe null onde falta
  // (services/pgShim.js:294). Como `ativo` é NOT NULL, lote misto derruba o
  // statement inteiro. É o P3-14 do backlog.
  const p = montarPlano([
    { linhaPlanilha: 2, sigla: 'EBGPR62', tipo: 'BTZERO', placa: 'ABC-1234' },
    { linhaPlanilha: 3, sigla: 'ENOVA01', tipo: 'CS',     placa: null },
  ], [equipe({ ativo: false })], { ...LOTE, reativar: true });

  const rows = linhasParaUpsert(p, { reativar: true });
  assert.equal(rows.length, 2);
  rows.forEach(r => assert.equal(r.ativo, true, 'todas as linhas têm de trazer ativo'));

  const chaves = new Set(rows.flatMap(r => Object.keys(r)));
  rows.forEach(r => assert.equal(
    Object.keys(r).length, chaves.size,
    'todas as linhas têm de ter EXATAMENTE as mesmas chaves'));
});

test('linhasParaUpsert junta novas e alteradas, e ignora idênticas e erros', () => {
  const p = montarPlano([
    { linhaPlanilha: 2, sigla: 'EBGPR62', tipo: 'BTZERO', placa: 'NOV-0001' }, // alterada
    { linhaPlanilha: 3, sigla: 'ENOVA01', tipo: 'CS',     placa: null },       // nova
    { linhaPlanilha: 4, sigla: 'EIGUAL1', tipo: 'CS',     placa: null },       // idêntica
    { linhaPlanilha: 5, sigla: 'EB',      tipo: 'CS',     placa: null },       // erro
  ], [
    equipe(),
    equipe({ sigla: 'EIGUAL1', tipo: 'CS', placa: null }),
  ], LOTE);

  const rows = linhasParaUpsert(p, { reativar: false });
  const siglas = rows.map(r => r.sigla).sort();
  assert.deepEqual(siglas, ['EBGPR62', 'ENOVA01']);
});

test('toda linha do upsert carrega as colunas do schema, com updated_at', () => {
  const p = montarPlano(
    [{ linhaPlanilha: 2, sigla: 'ENOVA01', tipo: 'CS', placa: null }],
    [], LOTE);

  const [row] = linhasParaUpsert(p, { reativar: false });
  assert.deepEqual(Object.keys(row).sort(),
    ['placa', 'regional', 'setor', 'sigla', 'tipo', 'updated_at']);
  assert.ok(!Number.isNaN(Date.parse(row.updated_at)));
});
