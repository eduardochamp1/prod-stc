/**
 * test/heValores.test.js
 *
 * Valores/hora da Medição HE, editáveis em Admin (09/09/2026).
 *
 * ⚠️ ISTO É PREÇO DE CONTRATO. O número digitado aqui multiplica ~600 linhas
 * por mês e o total vai pra EDP. Ninguém confere 600 linhas na mão, então um
 * zero a mais passa. Os testes aqui existem pela validação, não pela feature.
 *
 * ── DEFEITO QUE ISTO TAMBÉM FECHA ───────────────────────────────────────────
 * A 1ª versão lia e gravava a coluna `value` do `app_settings`. A coluna é
 * `data` (schema-atual.sql:29, e os dois usos que já existiam em
 * queries.js:988 e deslocamentosQueries.js:123). O SELECT estourava, o catch
 * engolia, e a tela mostrava "Valores/hora vindos do seed do código" — o
 * próprio aviso que revelou o erro.
 *
 * Pior: na migration esse INSERT estava DENTRO da transação do cadastro, então
 * o erro de nome de coluna derrubava as 45 equipes junto. Agora é passo
 * separado, depois do COMMIT.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROTAS  = fs.readFileSync(path.join(__dirname, '..', 'routes', 'index.js'), 'utf8');
const SRC    = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const HEQ    = fs.readFileSync(path.join(__dirname, '..', 'db', 'heQueries.js'), 'utf8');
const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'migrar-he-cadastro.js'), 'utf8');

const { TIPOS_BREVE, VALORES_HORA_SEED } = require('../db/heCadastroSeed');

function blocoPut() {
  const i = ROTAS.indexOf("router.put('/admin/he-valores'");
  assert.ok(i > -1, 'não achei o PUT /admin/he-valores');
  return ROTAS.slice(i, ROTAS.indexOf("router.get('/admin/equipes'", i));
}

// ─────────────────────────────────────────────────────────────────────────────
// A coluna certa — o defeito de 09/09/2026
// ─────────────────────────────────────────────────────────────────────────────

test('app_settings é lido pela coluna `data`, não `value`', () => {
  const i = HEQ.indexOf('async function _valoresHora');
  const bloco = HEQ.slice(i, i + 900);
  assert.match(bloco, /SELECT data FROM public\.app_settings/);
  assert.doesNotMatch(bloco, /SELECT value FROM/, 'a coluna `value` não existe');
});

test('a migration grava em `data` e FORA da transação do cadastro', () => {
  assert.match(SCRIPT, /INSERT INTO public\.app_settings \(key, data, updated_at\)/);
  assert.doesNotMatch(SCRIPT, /app_settings \(key, value/);
  // A semente de preço vem DEPOIS do COMMIT do cadastro: erro nela não pode
  // levar as 45 equipes junto, como levava antes.
  // Âncora no INSERT, não em qualquer menção a app_settings: a 1ª versão
  // deste teste pegava a citação no docblock do topo do arquivo.
  const iCommit = SCRIPT.indexOf("await client.query('COMMIT')");
  const iSeed   = SCRIPT.indexOf('INSERT INTO public.app_settings');
  assert.ok(iCommit > -1, 'não achei o COMMIT');
  assert.ok(iSeed > iCommit,
    'a semente de valores tem de vir depois do COMMIT do cadastro');
});

test('as rotas usam os helpers canônicos de app_settings', () => {
  // getSetting/setSetting (queries.js:988) já sabem o nome da coluna. Escrever
  // SQL cru de novo é como o erro apareceu.
  const put = blocoPut();
  assert.match(put, /setSetting\('he-valores-hora'/);
  const iGet = ROTAS.indexOf("router.get('/admin/he-valores'");
  assert.match(ROTAS.slice(iGet, iGet + 900), /getSetting\('he-valores-hora'\)/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Validação — é dinheiro
// ─────────────────────────────────────────────────────────────────────────────

test('só os tipos do contrato passam, e tipo estranho é ERRO', () => {
  // Ignorar em silêncio faria quem digitou "A4" descobrir na fatura.
  const put = blocoPut();
  assert.match(put, /TIPOS_BREVE\.includes\(k\)/);
  assert.match(put, /fora do contrato/);
  assert.match(put, /status\(400\)/);
});

test('valor tem de ser número positivo', () => {
  const put = blocoPut();
  assert.match(put, /!Number\.isFinite\(n\) \|\| n <= 0/);
});

test('existe TETO — um zero a mais multiplica a fatura por 10', () => {
  const put = blocoPut();
  assert.match(ROTAS, /const HE_VALOR_MAX = \d+/);
  assert.match(put, /n > HE_VALOR_MAX/);
  // O teto tem de ser folgado o suficiente pros preços reais e apertado o
  // suficiente pra pegar dedo errado: o maior do contrato é R$ 376,28.
  const max = Number((ROTAS.match(/const HE_VALOR_MAX = (\d+)/) || [])[1]);
  const maiorReal = Math.max(...Object.values(VALORES_HORA_SEED));
  assert.ok(max > maiorReal * 5, `teto ${max} apertado demais pra ${maiorReal}`);
  assert.ok(max < maiorReal * 100, `teto ${max} folgado demais pra pegar um zero a mais`);
});

test('arredonda em centavos', () => {
  // Mais casas criariam divergência de arredondamento contra a planilha.
  assert.match(blocoPut(), /Math\.round\(n \* 100\) \/ 100/);
});

test('a rota está sob requireAdmin e não é o /settings genérico', () => {
  // O /settings/:key genérico já teve furo de IDOR (P1-18).
  assert.match(ROTAS, /router\.use\('\/admin', requireAdmin\)/);
  const iUse = ROTAS.indexOf("router.use('/admin', requireAdmin)");
  const iPut = ROTAS.indexOf("router.put('/admin/he-valores'");
  assert.ok(iUse < iPut, 'a rota tem de vir DEPOIS do guard pra ser coberta');
});

test('quem mudou o preço fica no log', () => {
  // Sem vigência histórica no banco, o log é o único rastro de quando e quem.
  assert.match(blocoPut(), /console\.log\(`\[admin\/he-valores\] atualizado por/);
  assert.match(blocoPut(), /req\.user && req\.user\.username/);
});

// ─────────────────────────────────────────────────────────────────────────────
// A tela
// ─────────────────────────────────────────────────────────────────────────────

test('a seção existe no modal do Admin e carrega ao abrir', () => {
  assert.match(SRC, /Valores\/hora — Medição HE/);
  assert.match(SRC, /id="he-val-grid"/);
  const i = SRC.indexOf('function initAdmin');
  assert.match(SRC.slice(i, i + 900), /carregarHeValores\(\)/,
    'sem isto os campos abrem vazios');
});

test('carregar não pode derrubar o resto do Admin', () => {
  const i = SRC.indexOf('function initAdmin');
  const bloco = SRC.slice(i, i + 900);
  assert.match(bloco, /try \{ carregarHeValores\(\); \}/);
  assert.match(bloco, /catch \(e\)/);
});

test('um input por tipo, construído da lista do backend', () => {
  // Hardcodar os 6 tipos na tela faria a lista divergir do contrato em silêncio.
  const i = SRC.indexOf('async function carregarHeValores');
  const bloco = SRC.slice(i, SRC.indexOf('async function salvarHeValores', i));
  assert.match(bloco, /\(d\.tipos \|\| \[\]\)\.map/);
  assert.match(bloco, /id="he-val-\$\{t\}"/);
  for (const t of TIPOS_BREVE) {
    assert.doesNotMatch(bloco, new RegExp(`id="he-val-${t}"`),
      `${t} não pode estar hardcodado na tela`);
  }
});

test('salvar pede confirmação mostrando os valores', () => {
  // Isto muda o VALOR TOTAL de toda medição futura. Salvar sem "tem certeza"
  // é barato demais pro efeito.
  const i = SRC.indexOf('async function salvarHeValores');
  const bloco = SRC.slice(i, i + 2200);
  assert.match(bloco, /confirm\(/);
  assert.match(bloco, /Afeta o VALOR TOTAL de toda medição/);
  assert.match(bloco, /v\.toFixed\(2\)/, 'a confirmação mostra o valor formatado');
});

test('salvar invalida o cache da medição', () => {
  // O cache foi calculado com o preço antigo; deixar como estava mostraria o
  // total velho depois de mudar o preço.
  const i = SRC.indexOf('async function salvarHeValores');
  assert.match(SRC.slice(i, i + 2200), /_heCache = null/);
});

test('a tela avisa quando o valor ainda vem do seed', () => {
  const i = SRC.indexOf('async function carregarHeValores');
  const bloco = SRC.slice(i, SRC.indexOf('async function salvarHeValores', i));
  assert.match(bloco, /ainda não salvos — mostrando o seed do código/);
});

test('a ausência de vigência histórica está dita na própria tela', () => {
  // O usuário escolheu valor único sabendo do efeito (spec §2). A tela lembra
  // no momento da edição, que é quando importa.
  const i = SRC.indexOf('Valores/hora — Medição HE');
  assert.match(SRC.slice(i, i + 900), /Sem vigência histórica/);
});

// ─────────────────────────────────────────────────────────────────────────────
// O tipo que dita o preço pode vir de `tipo` — reportado em 09/09/2026
// ─────────────────────────────────────────────────────────────────────────────

const { tipoHeDaEquipe } = require('../db/heQueries');

test('tipo_breve tem precedência quando preenchido', () => {
  assert.equal(tipoHeDaEquipe({ tipo_breve: 'A2', tipo: 'L1' }), 'A2');
});

test('cai pro `tipo` quando tipo_breve está vazio', () => {
  // O José preencheu o tipo de turma na coluna `tipo` pelo Admin antes da
  // migration rodar. O trabalho está feito e é correto — a medição usa.
  for (const t of TIPOS_BREVE) {
    assert.equal(tipoHeDaEquipe({ tipo_breve: null, tipo: t }), t);
  }
  assert.equal(tipoHeDaEquipe({ tipo: 'a2' }), 'A2', 'caixa não importa');
  assert.equal(tipoHeDaEquipe({ tipo: ' L0M ' }), 'L0M');
});

test('tipo operacional NÃO vira preço', () => {
  // `tipo` também guarda PLANTAO/COMERCIAL/BTZERO/USO MUTUO. Nenhum é tipo de
  // hora extra; aceitar seria escolher um valor/hora no chute.
  for (const t of ['PLANTAO', 'PLANTÃO', 'COMERCIAL', 'BTZERO', 'CS',
                   'USO MUTUO', 'CORTE L0', 'CORTE L1', 'MD', 'RAMAL', 'A2N']) {
    assert.equal(tipoHeDaEquipe({ tipo: t }), null, `${t} não é tipo de HE`);
  }
});

test('tipo_breve inválido não impede o fallback', () => {
  // Lixo em tipo_breve não pode mascarar um `tipo` bom.
  assert.equal(tipoHeDaEquipe({ tipo_breve: 'XPTO', tipo: 'A1' }), 'A1');
});

test('sem nenhum dos dois, devolve null', () => {
  assert.equal(tipoHeDaEquipe({}), null);
  assert.equal(tipoHeDaEquipe(null), null);
  assert.equal(tipoHeDaEquipe({ tipo_breve: '', tipo: '' }), null);
});

test('a query do cadastro traz a coluna `tipo`', () => {
  // Sem ela no SELECT, o fallback nunca teria o que ler.
  const HEQ2 = fs.readFileSync(path.join(__dirname, '..', 'db', 'heQueries.js'), 'utf8');
  const i = HEQ2.indexOf('async function _cadastroEquipes');
  const bloco = HEQ2.slice(i, i + 1400);
  assert.match(bloco, /AS sigla, regional, tipo, \$\{_COLS_HE\}/);
  assert.match(bloco, /AS sigla, regional, tipo\s*\n/, 'o fallback de schema antigo também');
});

test('a medição usa o tipo RESOLVIDO, não tipo_breve cru', () => {
  const HEQ2 = fs.readFileSync(path.join(__dirname, '..', 'db', 'heQueries.js'), 'utf8');
  const i = HEQ2.indexOf('const tipoHe = tipoHeDaEquipe(cad)');
  assert.ok(i > -1, 'a montagem da linha tem de resolver o tipo');
  const bloco = HEQ2.slice(i, i + 1800);
  assert.match(bloco, /const valorHora = tipoHe \? \(valores\[tipoHe\] \?\? null\) : null/);
  assert.match(bloco, /tipo_breve: tipoHe/, 'a linha mostra o resolvido');
  assert.match(bloco, /if \(!tipoHe\) semCadastro\.add\(equipe\)/,
    'o aviso "sem cadastro" tem de olhar o resolvido, senão acusa equipe que tem preço');
});

test('o tipo e o preço são resolvidos ANTES do piso', () => {
  // Sem isso não daria pra dizer QUANTO em reais o piso descartou, e o
  // descarte viraria "faltam linhas" sem explicação na conferência.
  const HEQ2 = fs.readFileSync(path.join(__dirname, '..', 'db', 'heQueries.js'), 'utf8');
  const iTipo = HEQ2.indexOf('const tipoHe = tipoHeDaEquipe(cad)');
  const iPiso = HEQ2.indexOf('if (!temHe(he))', iTipo - 2000);
  assert.ok(iTipo > -1 && iPiso > iTipo,
    'o gate do piso tem de vir DEPOIS da resolução de tipo/preço');
  assert.match(HEQ2.slice(iPiso, iPiso + 700), /descartadas\.valor\s*\+= valorTotalHe/);
});

test('os campos de valor cabem o número inteiro', () => {
  // "356.63" aparecia como "35": com 4 campos por linha o input de número
  // reservava espaço pras setinhas e o resto sumia.
  //
  // ⚠️ Asserções POSITIVAS, de propósito. A 1ª versão usava
  // `doesNotMatch(/min-width:120px/)` e reprovava por causa do comentário que
  // explica o defeito — foi a 3ª vez no dia que uma regra negativa minha pegou
  // a própria prosa. Especificar o que DEVE existir é mais preciso e não
  // depende de como o comentário está escrito.
  const i = SRC.indexOf('async function carregarHeValores');
  const bloco = SRC.slice(i, SRC.indexOf('async function salvarHeValores', i));
  assert.match(bloco, /gridTemplateColumns = 'repeat\(auto-fit, minmax\(168px, 1fr\)\)'/,
    'grid com largura mínima igual pra todos os campos');
  assert.match(bloco, /style="width:100%;min-width:0;/,
    'o input precisa de min-width:0 pra não estourar a célula do grid');
});
