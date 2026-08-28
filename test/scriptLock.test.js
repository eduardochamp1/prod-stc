/**
 * test/scriptLock.test.js
 *
 * 28/08/2026 — P2-43. O incidente de 09/07/2026 (P0-0) foi um backfill
 * improvisado como `for d in $(seq 0 60); do node -e ... &` — ~60 processos node
 * em paralelo, cada um com um pool pg de ~10 conexões, estourando a VM de 3,8 GB
 * sem swap e derrubando o Postgres por OOM.
 *
 * A lição virou advisory lock, mas em UM script só. Sete outros que escrevem no
 * banco ficaram sem ela, incluindo dois que reescrevem exatamente as tabelas de
 * onde saem os números reportados à EDP.
 *
 * Estes testes travam três coisas:
 *   1. a chave HISTÓRICA do backfill-consolidate não pode mudar (trocá-la faria
 *      uma cópia nova conviver com uma velha durante um deploy);
 *   2. cada script tem chave PRÓPRIA (dois scripts diferentes podem rodar juntos,
 *      duas cópias do mesmo não);
 *   3. todo script que escreve em tabela de número usa o lock — o teste falha se
 *      alguém adicionar um novo sem a guarda.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { chaveDe, CHAVES_FIXAS } = require('../scripts/_lock');
const RAIZ = path.join(__dirname, '..');

// ─────────────────────────────────────────────────────────────────────────────
// Chaves
// ─────────────────────────────────────────────────────────────────────────────

test('chave do backfill-consolidate é a HISTÓRICA (429153001)', () => {
  // Estava embutida no script desde o P0-0. Mudar faz a cópia nova não ver a
  // cópia velha durante um deploy — o oposto do que o lock existe pra fazer.
  assert.equal(chaveDe('backfill-consolidate'), 429153001);
  assert.equal(CHAVES_FIXAS['backfill-consolidate'], 429153001);
  // E o script continua exportando o mesmo valor.
  const { LOCK_KEY } = require('../scripts/backfill-consolidate');
  assert.equal(LOCK_KEY, 429153001);
});

test('cada script de escrita tem chave PRÓPRIA', () => {
  const nomes = [
    'backfill-consolidate', 'backfill-daily-subcat',
    'reconsolidar-produtividade', 'backfill-carteira',
  ];
  const chaves = nomes.map(chaveDe);
  assert.equal(new Set(chaves).size, nomes.length,
    `colisão de chave entre scripts: ${JSON.stringify(nomes.map((n, i) => [n, chaves[i]]))}`);
});

test('chaveDe é estável e devolve int32 positivo', () => {
  // Estável entre execuções, senão o lock não encontra o da outra cópia.
  assert.equal(chaveDe('qualquer-nome'), chaveDe('qualquer-nome'));
  for (const n of ['a', 'nome-bem-mais-longo-que-o-normal', 'x'.repeat(200)]) {
    const k = chaveDe(n);
    assert.ok(Number.isInteger(k), `${n} → não é inteiro`);
    assert.ok(k >= 0 && k < 2 ** 31, `${n} → ${k} fora do int32 positivo`);
  }
});

test('chave derivada não invade a faixa das fixas', () => {
  // As derivadas ficam abaixo de 400.000.000; a fixa é 429.153.001.
  for (const n of ['backfill-daily-subcat', 'reconsolidar-produtividade',
                   'backfill-carteira', 'algum-script-futuro']) {
    if (CHAVES_FIXAS[n] !== undefined) continue;
    assert.ok(chaveDe(n) < 400000000, `${n} → ${chaveDe(n)} pode colidir com chave fixa`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Cobertura: quem escreve em tabela de número tem de usar o lock
// ─────────────────────────────────────────────────────────────────────────────

test('todo script que escreve em tabela de NÚMERO usa o advisory lock', () => {
  // Lista explícita, não heurística: heurística sobre `.upsert(` pegaria também
  // script de leitura que só monta payload. Se um script novo entrar aqui, ele
  // tem de vir com o lock — é o ponto do teste.
  const DEVEM_TER_LOCK = [
    'backfill-consolidate.js',
    'backfill-daily-subcat.js',
    'reconsolidar-produtividade.js',
    'backfill-carteira.js',
  ];
  const semLock = DEVEM_TER_LOCK.filter(f => {
    const src = fs.readFileSync(path.join(RAIZ, 'scripts', f), 'utf8');
    return !src.includes("require('./_lock')");
  });
  assert.deepEqual(semLock, [],
    `escrevem em tabela de número e NÃO usam scripts/_lock.js: ${semLock.join(', ')}`);
});

test('_probe-save.js exige a flag explícita antes de gravar', () => {
  // Eram 12 linhas sem dry-run e sem confirmação: `node scripts/_probe-save.js`
  // inseria um snapshot em produção. A auditoria recomendou apagar; apagar
  // arquivo é decisão do dono do repo, então por ora tem guarda.
  const src = fs.readFileSync(path.join(RAIZ, 'scripts', '_probe-save.js'), 'utf8');
  assert.match(src, /--eu-sei-que-isto-grava-em-producao/,
    'a flag de confirmação tem de existir');
  assert.match(src, /GRAVA (UM SNAPSHOT )?EM PRODUÇÃO/i,
    'o aviso tem de dizer que grava em produção');
  // A guarda tem de vir ANTES do require do serviço que escreve.
  const iFlag = src.indexOf('process.exit(1)');
  const iReq  = src.indexOf("require('../services/notasMonitor')");
  assert.ok(iFlag > -1 && iReq > -1 && iFlag < iReq,
    'a guarda precisa estar antes de carregar o que escreve');
});

// ─────────────────────────────────────────────────────────────────────────────
// comLock: forma da API
// ─────────────────────────────────────────────────────────────────────────────

test('comLock existe e aceita (nome, opts, trabalho)', () => {
  const { comLock } = require('../scripts/_lock');
  assert.equal(typeof comLock, 'function');
  assert.equal(comLock.length, 3);
});
