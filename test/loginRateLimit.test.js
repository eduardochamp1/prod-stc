/**
 * test/loginRateLimit.test.js
 *
 * 28/08/2026 — P1-42. O rate limit do login (P1-5) era CONTORNÁVEL com um
 * header: a chave do balde era `x-forwarded-for | username`, e `x-forwarded-for`
 * é enviado pelo CLIENTE. Trocando o header a cada request, cada tentativa caía
 * num balde novo que sempre começava em `count: 1` — o teto de 10 tentativas em
 * 5 min nunca era alcançado. Não existe `app.set('trust proxy', ...)` no
 * server.js, então o header nunca foi validado.
 *
 * Estes testes sobem o app REAL em porta aleatória e batem com fetch, no mesmo
 * padrão do test/routes.test.js — porque o contorno só é demonstrável por HTTP.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Env ANTES do require do app (middleware/auth lê no load).
process.env.NODE_ENV    = 'test';
process.env.DATA_MODE   = 'mock';
process.env.JWT_SECRET  = 'test-secret-ratelimit';
process.env.CRON_SECRET = 'test-cron-secret-ratelimit';
process.env.AUTH_USERS  = [
  `alvo:${sha256('senhaCerta')}:user:GUA`,
  `outro:${sha256('outraSenha')}:user:GUA`,
].join(',');

const app = require('../server');
const rotas = require('../routes/index');

let server, base;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => { if (server) server.close(); });

/** POST /api/auth/login com XFF opcional. */
async function tentar(username, password, xff) {
  const headers = { 'Content-Type': 'application/json' };
  if (xff) headers['X-Forwarded-For'] = xff;
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers, body: JSON.stringify({ username, password }),
  });
  return res.status;
}

/** Zera os baldes entre testes — eles vivem num Map de módulo. */
function limparBaldes() { rotas._loginTries.clear(); }

// ─────────────────────────────────────────────────────────────────────────────
// O contorno que o P1-42 fecha
// ─────────────────────────────────────────────────────────────────────────────

test('rate limit NÃO é contornável trocando X-Forwarded-For', async () => {
  limparBaldes();
  const status = [];
  // 20 tentativas erradas, cada uma com um XFF DIFERENTE, mesmo socket.
  for (let i = 0; i < 20; i++) {
    status.push(await tentar('alvo', 'errada' + i, `10.0.${Math.floor(i / 256)}.${i % 256}`));
  }
  const primeiro429 = status.indexOf(429);
  assert.notEqual(primeiro429, -1,
    'antes do P1-42 nenhuma das 20 dava 429 — o XFF criava um balde novo por tentativa');
  // Teto por IP é 10, então o 11º request (índice 10) já deve ser barrado.
  assert.ok(primeiro429 <= 10,
    `429 devia aparecer até a 11ª tentativa, apareceu na ${primeiro429 + 1}ª`);
});

test('rate limit por IP+usuário barra na 11ª tentativa errada', async () => {
  limparBaldes();
  const status = [];
  for (let i = 0; i < 12; i++) status.push(await tentar('alvo', 'errada' + i));
  assert.equal(status.slice(0, 10).every(s => s === 401), true,
    'as 10 primeiras são 401 (credencial errada), não 429');
  assert.equal(status[10], 429, 'a 11ª é barrada');
  assert.equal(status[11], 429);
});

test('429 vem com Retry-After', async () => {
  limparBaldes();
  for (let i = 0; i < 11; i++) await tentar('alvo', 'errada' + i);
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'alvo', password: 'x' }),
  });
  assert.equal(res.status, 429);
  const retry = Number(res.headers.get('retry-after'));
  assert.ok(retry > 0 && retry <= 300, `Retry-After fora do esperado: ${retry}`);
});

test('login CORRETO zera os dois baldes', async () => {
  limparBaldes();
  for (let i = 0; i < 5; i++) await tentar('alvo', 'errada' + i);
  assert.equal(await tentar('alvo', 'senhaCerta'), 200, 'senha certa deve entrar');
  // Zerado: dá pra errar 10 vezes de novo antes do 429.
  const status = [];
  for (let i = 0; i < 10; i++) status.push(await tentar('alvo', 'denovo' + i));
  assert.equal(status.every(s => s === 401), true,
    'depois do sucesso o contador recomeça — nenhuma das 10 deve dar 429');
});

test('balde de um usuário não afeta OUTRO usuário', async () => {
  limparBaldes();
  for (let i = 0; i < 11; i++) await tentar('alvo', 'errada' + i);
  assert.equal(await tentar('outro', 'outraSenha'), 200,
    'o rate limit é por alvo, não global');
});

// ─────────────────────────────────────────────────────────────────────────────
// Os helpers, direto
// ─────────────────────────────────────────────────────────────────────────────

test('_loginKey NÃO usa x-forwarded-for', () => {
  const req = {
    headers: { 'x-forwarded-for': '1.2.3.4' },
    socket: { remoteAddress: '10.0.0.9' },
  };
  const k = rotas._loginKey(req, 'alvo');
  assert.ok(k.includes('10.0.0.9'), 'a chave tem de vir do socket');
  assert.ok(!k.includes('1.2.3.4'), 'o header do cliente não pode entrar na chave');
});

test('_loginKey sem socket cai em "unknown", não quebra', () => {
  assert.equal(rotas._loginKey({ headers: {} }, 'alvo'), 'unknown|alvo');
  assert.equal(rotas._loginKey({ headers: {} }, null), 'unknown|?');
});

test('_loginKeyUser é independente do IP', () => {
  assert.equal(rotas._loginKeyUser('alvo'), 'user|alvo');
  assert.equal(rotas._loginKeyUser(null), 'user|?');
});

test('_baldeEstourado: dentro do teto não estoura', () => {
  const now = 1_000_000;
  const r = rotas._baldeEstourado({ count: 9, first: now - 1000 }, 10, now, 300_000);
  assert.equal(r.estourado, false);
});

test('_baldeEstourado: no teto estoura e informa o Retry-After', () => {
  const now = 1_000_000;
  const r = rotas._baldeEstourado({ count: 10, first: now - 60_000 }, 10, now, 300_000);
  assert.equal(r.estourado, true);
  assert.equal(r.retryS, 240);   // 300s de janela - 60s já passados
});

test('_baldeEstourado: janela expirada não estoura, mesmo com count alto', () => {
  const now = 1_000_000;
  const r = rotas._baldeEstourado({ count: 999, first: now - 400_000 }, 10, now, 300_000);
  assert.equal(r.estourado, false);
});

test('_baldeEstourado: sem registro não estoura', () => {
  assert.equal(rotas._baldeEstourado(undefined, 10, Date.now(), 300_000).estourado, false);
});

test('teto por usuário é mais alto que o por IP', () => {
  // O balde por username carrega o login legítimo de todo mundo que usa a conta,
  // então ele existe pra fechar origem distribuída — não pra ser o limite normal.
  assert.ok(rotas._LOGIN_MAX_USER > rotas._LOGIN_MAX,
    `usuário=${rotas._LOGIN_MAX_USER} devia ser > ip=${rotas._LOGIN_MAX}`);
});
