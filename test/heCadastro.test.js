/**
 * test/heCadastro.test.js
 *
 * Fase 1 da SPEC-medicao-he-2026-09-09 — cadastro HE por equipe.
 *
 * ⚠️ O QUE ESTES TESTES PROTEGEM: `tipo_breve` errado = valor/hora errado =
 * fatura errada para a EDP. E o cadastro veio de TRANSCRIÇÃO DE PRINT, por
 * decisão do José em 09/09/2026 ("transcreva, porém deixe editável e
 * revisável"). Então aqui não se testa só a função — se testa a INTEGRIDADE do
 * seed, linha por linha, e a trava que impede o dado transcrito de passar por
 * conferido.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  TIPOS_BREVE, VALORES_HORA_SEED, CADASTRO_SEED,
  tipoBreveDoTipoPlanilha, validarCadastroHe, seedResolvido,
} = require('../db/heCadastroSeed');

// ─────────────────────────────────────────────────────────────────────────────
// Derivação do tipo — nunca chutar
// ─────────────────────────────────────────────────────────────────────────────

test('extrai o tipo do primeiro token da coluna TIPO', () => {
  assert.equal(tipoBreveDoTipoPlanilha('A3 2P 22D'), 'A3');
  assert.equal(tipoBreveDoTipoPlanilha('L0M 1P 22D'), 'L0M');
  assert.equal(tipoBreveDoTipoPlanilha('L1 3P 30D'), 'L1');
});

test('tolera espaçamento e caixa', () => {
  assert.equal(tipoBreveDoTipoPlanilha('  a2   2p 22d '), 'A2');
  assert.equal(tipoBreveDoTipoPlanilha('L3-2P-22D'), 'L3');
  assert.equal(tipoBreveDoTipoPlanilha('L3/2P'), 'L3');
});

test('tipo desconhecido devolve null, NUNCA um palpite', () => {
  // Chutar aqui é escolher um valor/hora e faturar errado. Null faz a equipe
  // aparecer sem valor e com aviso, que é o comportamento seguro.
  assert.equal(tipoBreveDoTipoPlanilha('A9 2P 22D'), null);
  assert.equal(tipoBreveDoTipoPlanilha('XX'), null);
  assert.equal(tipoBreveDoTipoPlanilha('L0 1P 22D'), null, 'L0 não é L0M');
  assert.equal(tipoBreveDoTipoPlanilha(''), null);
  assert.equal(tipoBreveDoTipoPlanilha(null), null);
  assert.equal(tipoBreveDoTipoPlanilha(undefined), null);
});

test('não confunde prefixo com tipo — A1 não vira A', () => {
  assert.equal(tipoBreveDoTipoPlanilha('A 1P 22D'), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Validação de linha
// ─────────────────────────────────────────────────────────────────────────────

const linhaOk = () =>
  ({ sigla: 'EPMFL33', cidade: 'MARECHAL FLORIANO', tipo_planilha: 'A2 2P 22D', servico: 'PLT' });

test('linha completa passa', () => {
  assert.deepEqual(validarCadastroHe(linhaOk()), []);
});

test('serviço só aceita STC ou PLT', () => {
  assert.deepEqual(validarCadastroHe({ ...linhaOk(), servico: 'XPTO' }),
    ['servico deve ser STC ou PLT']);
  assert.deepEqual(validarCadastroHe({ ...linhaOk(), servico: 'stc' }), [], 'caixa não importa');
});

test('cidade vazia é erro — vira coluna C da planilha', () => {
  assert.ok(validarCadastroHe({ ...linhaOk(), cidade: '   ' }).includes('cidade vazia'));
});

test('tipo que não resolve é erro, não silêncio', () => {
  const erros = validarCadastroHe({ ...linhaOk(), tipo_planilha: 'A9' });
  assert.equal(erros.length, 1);
  assert.match(erros[0], /tipo_planilha não resolve/);
});

test('linha vazia acumula os erros em vez de estourar', () => {
  const erros = validarCadastroHe({});
  assert.ok(erros.length >= 3);
  assert.deepEqual(validarCadastroHe(null).length > 0, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// INTEGRIDADE DO SEED — é transcrição de print, e vira dinheiro
// ─────────────────────────────────────────────────────────────────────────────

test('toda linha do seed é válida', () => {
  for (const l of CADASTRO_SEED) {
    assert.deepEqual(validarCadastroHe(l), [], `${l.sigla} inválida`);
  }
});

test('toda equipe do seed resolve num tipo COM valor/hora', () => {
  // Tipo sem preço deixaria a coluna VALOR TOTAL vazia sem ninguém perceber.
  for (const l of seedResolvido()) {
    assert.ok(TIPOS_BREVE.includes(l.tipo_breve), `${l.sigla}: ${l.tipo_breve}`);
    assert.equal(typeof VALORES_HORA_SEED[l.tipo_breve], 'number', `${l.sigla} sem valor/hora`);
    assert.ok(VALORES_HORA_SEED[l.tipo_breve] > 0, `${l.sigla} com valor/hora <= 0`);
  }
});

test('nenhuma sigla duplicada no seed', () => {
  // Duplicata faria o UPDATE rodar duas vezes e a última vencer em silêncio.
  const vistas = new Set();
  for (const l of CADASTRO_SEED) {
    assert.equal(vistas.has(l.sigla), false, `${l.sigla} duplicada`);
    vistas.add(l.sigla);
  }
  assert.equal(vistas.size, CADASTRO_SEED.length);
});

test('os valores/hora batem com a aba Valores da planilha', () => {
  // Números do contrato. Se algum mudar sem ser por reajuste consciente, é bug.
  assert.deepEqual(VALORES_HORA_SEED, {
    A1: 356.63, A2: 376.28, A3: 332.65, L0M: 122.14, L1: 297.54, L3: 374.60,
  });
});

test('o cruzamento com a aba de medição está registrado por linha', () => {
  // `conferido` marca quem teve o tipo confirmado pelo VALOR na aba de
  // medição — leitura independente do mesmo print. Quem não tem é justamente
  // quem mais precisa de olho humano, e some se o campo virar opcional.
  for (const l of CADASTRO_SEED) {
    assert.equal(typeof l.conferido, 'boolean', `${l.sigla} sem marca de conferência`);
  }
  const conferidas = CADASTRO_SEED.filter(l => l.conferido);
  assert.ok(conferidas.length >= 15,
    `esperava >=15 equipes cruzadas com o valor/hora, achei ${conferidas.length}`);
});

test('as equipes cruzadas conferem tipo × valor observado na medição', () => {
  // Pares (sigla → valor/hora) lidos na coluna VALOR da aba H.E STC-PLT.
  // É a prova de que a transcrição do tipo não foi invenção minha.
  const observado = {
    EBGPR63: 376.28, EBGPR64: 376.28, EBGPR65: 376.28, ECMRT51: 376.28, EPMFL33: 376.28,
    ECACH50: 356.63, ECPIU50: 356.63,
    ECANC50: 297.54, ECDMA50: 297.54, ECGPR53: 297.54, ECGPR90: 297.54, ECGPR91: 297.54,
    ECMFL50: 297.54, ECMFL51: 297.54, ECMRT50: 297.54, ECMRT80: 297.54, ECPIU90: 297.54,
    ETGPR15: 122.14, ETGPR16: 122.14, ETGPR17: 122.14, ETMRT16: 122.14, ETPIU15: 122.14,
  };
  const porSigla = new Map(seedResolvido().map(l => [l.sigla, l]));
  for (const [sigla, valor] of Object.entries(observado)) {
    const l = porSigla.get(sigla);
    assert.ok(l, `${sigla} saiu do seed`);
    assert.equal(VALORES_HORA_SEED[l.tipo_breve], valor,
      `${sigla}: tipo ${l.tipo_breve} dá R$${VALORES_HORA_SEED[l.tipo_breve]}, `
      + `mas a medição mostra R$${valor}`);
    assert.equal(l.conferido, true, `${sigla} tem cruzamento e devia estar conferido`);
  }
});

test('as divergências da transcrição estão escritas, não escondidas', () => {
  const comDiv = CADASTRO_SEED.filter(l => l.divergencia);
  assert.ok(comDiv.length >= 1, 'ao menos ECMRT51 tem divergência anotada');
  for (const l of comDiv) {
    assert.equal(typeof l.divergencia, 'string');
    assert.ok(l.divergencia.length > 15, `${l.sigla}: divergência sem explicação`);
  }
  assert.ok(comDiv.some(l => l.sigla === 'ECMRT51'),
    'ECMRT51 aparece na medição a R$297,54 (L1) com DADOS dizendo A2 — tem de estar anotado');
});

// ─────────────────────────────────────────────────────────────────────────────
// A TRAVA — dado transcrito não pode passar por conferido
// ─────────────────────────────────────────────────────────────────────────────

const SCRIPT = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'migrar-he-cadastro.js'), 'utf8');

test('o script grava he_revisado = false, sempre', () => {
  // O seed é transcrição de imagem. Entrar como revisado seria o painel
  // afirmando conferência que ninguém fez.
  assert.match(SCRIPT, /he_revisado\s*=\s*false/);
  assert.doesNotMatch(SCRIPT, /he_revisado\s*=\s*true/);
});

test('o script é dry-run por padrão', () => {
  assert.match(SCRIPT, /const APPLY\s*=\s*process\.argv\.includes\('--apply'\)/);
  assert.match(SCRIPT, /if \(!APPLY\)/);
});

test('o script NÃO cria equipe nova a partir da transcrição', () => {
  // Criar equipe aqui a colocaria na whitelist e ela passaria a contar em
  // todas as métricas do painel, muito além da medição.
  assert.match(SCRIPT, /UPDATE public\.equipes_oficiais/);
  assert.doesNotMatch(SCRIPT, /INSERT INTO public\.equipes_oficiais/);
});

test('a migration só ADICIONA colunas', () => {
  assert.match(SCRIPT, /ADD COLUMN IF NOT EXISTS/);
  for (const destrutivo of [/DROP COLUMN/, /DROP TABLE/, /ALTER COLUMN .* TYPE/, /DELETE FROM/]) {
    assert.doesNotMatch(SCRIPT, destrutivo);
  }
});

test('o script roda em transação e faz rollback no erro', () => {
  assert.match(SCRIPT, /BEGIN/);
  assert.match(SCRIPT, /ROLLBACK/);
  assert.match(SCRIPT, /COMMIT/);
});

test('o script valida o seed ANTES de abrir conexão', () => {
  const iVal  = SCRIPT.indexOf('validarCadastroHe(l)');
  const iPool = SCRIPT.indexOf('_getPool()');
  assert.ok(iVal > -1 && iPool > iVal, 'validar depois de conectar arrisca escrever parcial');
});

test('tem modo --csv pra conferir contra a planilha', () => {
  // É o caminho mais rápido pro José validar a transcrição antes de virar
  // fatura, e foi a condição que ele pôs ("editável e revisável").
  assert.match(SCRIPT, /--csv/);
  assert.match(SCRIPT, /function emitirCSV/);
});

// ─────────────────────────────────────────────────────────────────────────────
// A rota de Admin — é o "editável e revisável" do pedido
// ─────────────────────────────────────────────────────────────────────────────

const ROTAS = fs.readFileSync(path.join(__dirname, '..', 'routes', 'index.js'), 'utf8');

test('o PUT aceita os campos de cadastro HE', () => {
  for (const campo of ['cidade', 'tipo_breve', 'servico', 'turno_cadastro', 'he_revisado']) {
    assert.match(ROTAS, new RegExp(`body\.${campo} !== undefined`),
      `sem isto o campo ${campo} não é editável pelo Admin`);
  }
});

test('tipo_breve na rota valida contra a lista do contrato', () => {
  // Aceitar string livre aqui deixaria "A4" entrar e a equipe ficaria sem
  // valor/hora, com a linha da medição saindo vazia sem explicação.
  const i = ROTAS.indexOf('body.tipo_breve !== undefined');
  const bloco = ROTAS.slice(i, i + 600);
  assert.match(bloco, /TIPOS_BREVE/);
  assert.match(bloco, /!TIPOS_BREVE\.includes\(v\)/);
});

test('servico e turno na rota são fechados em lista', () => {
  const iS = ROTAS.indexOf('body.servico !== undefined');
  assert.match(ROTAS.slice(iS, iS + 400), /\['STC', 'PLT'\]/);
  const iT = ROTAS.indexOf('body.turno_cadastro !== undefined');
  assert.match(ROTAS.slice(iT, iT + 400), /\['DIURNO', 'NOTURNO'\]/);
});

test('o GET tolera o schema SEM as colunas novas', () => {
  // Deploy do código antes da migration derrubaria a tela de Admin inteira,
  // e não há staging pra pegar isso antes.
  const i = ROTAS.indexOf('_COLS_BASE');
  assert.ok(i > -1, 'não achei o fallback de colunas');
  const bloco = ROTAS.slice(i, i + 1200);
  assert.match(bloco, /column .\* does not exist/);
  assert.match(bloco, /_COLS_BASE\s*\)/, 'a 2ª tentativa usa só as colunas antigas');
});
