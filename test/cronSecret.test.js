/**
 * test/cronSecret.test.js
 *
 * 28/08/2026 — P1-43. Duas coisas travadas aqui:
 *
 *   1. O `?secret=` na query string NÃO é mais aceito. Ele era descrito no
 *      cabeçalho do routes/cron.js como "fallback de teste", mas não tinha gate
 *      de modo — valia igual em produção. Query string vaza pro out.log do PM2,
 *      pro log do Fortinet, pro histórico do navegador e pro header Referer. E
 *      quem lesse a linha ganhava o poder de disparar
 *      `GET /api/cron/consolidate?date=<qualquer dia>`, que APAGA e reescreve
 *      team_daily_totals — cruzado com o P2-13 (re-consolidação de dia antigo
 *      subconta ~0,8%), isso rebaixa número já reportado à EDP sem rastro.
 *
 *   2. O `_redigirUrl` do middleware/requestTiming.js. Aquele middleware, que eu
 *      adicionei em 22/08 pra achar página lenta, logava `req.originalUrl`
 *      inteira — ou seja, a observabilidade virou vazamento de credencial. Agora
 *      redige o valor de parâmetro sensível.
 */

const test = require('node:test');
const assert = require('node:assert');

// O SECRET é lido no require do módulo, então precisa estar no env ANTES.
const SEGREDO = 'segredo-de-teste-com-32-caracteres!!';
process.env.CRON_SECRET = SEGREDO;
delete require.cache[require.resolve('../routes/cron')];
const cron = require('../routes/cron');

/** `req` mínimo pro checkSecret. */
function fakeReq({ auth = null, query = {} } = {}) {
  return { headers: auth ? { authorization: auth } : {}, query };
}
/** `res` mínimo: registra status e corpo. */
function fakeRes() {
  const r = { statusCode: null, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

// ─────────────────────────────────────────────────────────────────────────────
// _secretIguais
// ─────────────────────────────────────────────────────────────────────────────

test('_secretIguais: iguais → true', () => {
  assert.equal(cron._secretIguais(SEGREDO, SEGREDO), true);
});

test('_secretIguais: diferentes de MESMO tamanho → false', () => {
  const outro = 'X' + SEGREDO.slice(1);
  assert.equal(outro.length, SEGREDO.length);
  assert.equal(cron._secretIguais(outro, SEGREDO), false);
});

test('_secretIguais: tamanhos diferentes → false, SEM lançar', () => {
  // timingSafeEqual lança RangeError quando os buffers têm tamanhos diferentes.
  // É o mesmo defeito que o P2-42 aponta no /webhook/deploy, onde virava 500 em
  // vez de 401. Aqui a checagem de tamanho vem antes.
  assert.doesNotThrow(() => cron._secretIguais('curto', SEGREDO));
  assert.equal(cron._secretIguais('curto', SEGREDO), false);
  assert.equal(cron._secretIguais('', SEGREDO), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// checkSecret
// ─────────────────────────────────────────────────────────────────────────────

test('checkSecret: header Bearer correto passa', () => {
  const res = fakeRes();
  let passou = false;
  cron._checkSecret(fakeReq({ auth: `Bearer ${SEGREDO}` }), res, () => { passou = true; });
  assert.equal(passou, true);
  assert.equal(res.statusCode, null);
});

test('checkSecret: ?secret= com o valor CERTO é recusado (P1-43)', () => {
  // Este é o coração do item: antes isto passava.
  const res = fakeRes();
  let passou = false;
  cron._checkSecret(fakeReq({ query: { secret: SEGREDO } }), res, () => { passou = true; });
  assert.equal(passou, false, 'query string não pode mais autenticar');
  assert.equal(res.statusCode, 401);
  assert.match(res.body.error, /Authorization: Bearer/);
});

test('checkSecret: sem header nenhum → 401, sem lançar', () => {
  const res = fakeRes();
  let passou = false;
  assert.doesNotThrow(() => {
    cron._checkSecret(fakeReq(), res, () => { passou = true; });
  });
  assert.equal(passou, false);
  assert.equal(res.statusCode, 401);
});

test('checkSecret: header com valor errado → 401', () => {
  const res = fakeRes();
  let passou = false;
  cron._checkSecret(fakeReq({ auth: 'Bearer errado' }), res, () => { passou = true; });
  assert.equal(passou, false);
  assert.equal(res.statusCode, 401);
});

test('checkSecret: header sem o prefixo "Bearer " → 401', () => {
  const res = fakeRes();
  let passou = false;
  cron._checkSecret(fakeReq({ auth: SEGREDO }), res, () => { passou = true; });
  assert.equal(passou, false);
  assert.equal(res.statusCode, 401);
});

// ─────────────────────────────────────────────────────────────────────────────
// Validação da data do /consolidate
// ─────────────────────────────────────────────────────────────────────────────

test('validação de date: aceita YYYY-MM-DD real e recusa o resto', () => {
  // Mesmo regex do handler. Replicado aqui de propósito: se alguém afrouxar o
  // regex no handler, este teste continua passando e o outro (o de aceite na VM)
  // é que pega — então o valor deste é documentar QUAIS entradas devem morrer.
  const re = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

  for (const ok of ['2026-08-28', '2026-01-01', '2026-12-31']) {
    assert.equal(re.test(ok), true, `${ok} devia passar`);
  }
  for (const ruim of [
    'abc', '', '2026-13-01', '2026-00-10', '2026-08-32', '2026-08-00',
    '9999-99-99',            // passava no regex antigo ^\d{4}-\d{2}-\d{2}$
    '2026-8-1',              // sem zero à esquerda
    "2026-08-28'; DROP TABLE snapshots; --",
    '2026-08-28 OR 1=1',
  ]) {
    assert.equal(re.test(ruim), false, `${JSON.stringify(ruim)} devia morrer`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// _redigirUrl — o vazamento pelo próprio middleware de observabilidade
// ─────────────────────────────────────────────────────────────────────────────

const { _redigirUrl } = require('../middleware/requestTiming');

test('_redigirUrl: esconde o valor de secret', () => {
  assert.equal(
    _redigirUrl('/api/cron/consolidate?secret=abc123&date=2026-08-28'),
    '/api/cron/consolidate?secret=***&date=2026-08-28');
});

test('_redigirUrl: pega maiúsculas e outros parâmetros sensíveis', () => {
  assert.equal(_redigirUrl('/x?SECRET=abc'), '/x?SECRET=***');
  assert.equal(_redigirUrl('/x?token=abc'), '/x?token=***');
  assert.equal(_redigirUrl('/x?password=abc'), '/x?password=***');
  assert.equal(_redigirUrl('/x?api_key=abc'), '/x?api_key=***');
});

test('_redigirUrl: não mexe no que é inofensivo', () => {
  const u = '/api/historico/sessoes?de=2026-08-01&ate=2026-08-28&regionals=GUA,CAC';
  assert.equal(_redigirUrl(u), u);
  assert.equal(_redigirUrl('/api/teams'), '/api/teams');
});

test('_redigirUrl: entrada estranha não lança', () => {
  assert.doesNotThrow(() => _redigirUrl(null));
  assert.doesNotThrow(() => _redigirUrl(undefined));
  assert.doesNotThrow(() => _redigirUrl('/x?'));
  assert.doesNotThrow(() => _redigirUrl('/x?secret'));
  assert.equal(_redigirUrl('/x?secret'), '/x?secret=***');
});
