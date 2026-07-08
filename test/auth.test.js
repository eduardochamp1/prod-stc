// test/auth.test.js
const { test } = require('node:test');
const assert = require('node:assert');

// Stub do .env antes de require — getUsers lê de process.env.AUTH_USERS
function withAuthUsers(value, fn) {
  const prev = process.env.AUTH_USERS;
  process.env.AUTH_USERS = value;
  try { fn(); } finally { process.env.AUTH_USERS = prev; }
}

// require uma vez — fns puras lendo process.env.AUTH_USERS no momento da call
const { getUsers } = require('../middleware/auth');

test('getUsers: parsing valido GUA|CAC', () => {
  withAuthUsers('engelmig_es:hashabc:user:GUA|CAC', () => {
    const users = getUsers();
    assert.equal(users.length, 1);
    assert.equal(users[0].username, 'engelmig_es');
    assert.equal(users[0].passwordHash, 'hashabc');
    assert.equal(users[0].role, 'user');
    assert.deepEqual(users[0].regionals, ['GUA', 'CAC']);
  });
});

test('getUsers: multiplas entradas (admin + ES)', () => {
  withAuthUsers('admin:h1:admin:GUA|CAC|SJC,engelmig_es:h2:user:GUA|CAC', () => {
    const users = getUsers();
    assert.equal(users.length, 2);
    assert.deepEqual(users[0].regionals, ['GUA', 'CAC', 'SJC']);
    assert.deepEqual(users[1].regionals, ['GUA', 'CAC']);
  });
});

test('getUsers: sigla unica', () => {
  withAuthUsers('guarapari:h:user:GUA', () => {
    assert.deepEqual(getUsers()[0].regionals, ['GUA']);
  });
});

test('getUsers: ALL rejeita com erro claro', () => {
  withAuthUsers('admin:h:admin:ALL', () => {
    assert.throws(() => getUsers(), /ALL.*nao e mais aceito|não é mais aceito/i);
  });
});

test('getUsers: ES rejeita com erro claro', () => {
  withAuthUsers('engelmig_es:h:user:ES', () => {
    assert.throws(() => getUsers(), /ES.*grupos|grupos.*aceitos/i);
  });
});

test('getUsers: sigla invalida rejeita', () => {
  withAuthUsers('x:h:user:XYZ', () => {
    assert.throws(() => getUsers(), /invalid|XYZ/i);
  });
});

test('getUsers: regional vazio rejeita', () => {
  withAuthUsers('x:h:user:', () => {
    assert.throws(() => getUsers(), /vazia|sem regionals/i);
  });
});

test('getUsers: case-insensitive normaliza pra uppercase', () => {
  withAuthUsers('x:h:user:gua|cac', () => {
    assert.deepEqual(getUsers()[0].regionals, ['GUA', 'CAC']);
  });
});

test('getUsers: AUTH_USERS vazio retorna []', () => {
  withAuthUsers('', () => {
    assert.deepEqual(getUsers(), []);
  });
});

const { login, verifyToken } = require('../middleware/auth');

test('login: payload contem v:2 e regionals (array)', () => {
  process.env.AUTH_USERS = 'admin:' + require('crypto').createHash('sha256').update('senha').digest('hex') + ':admin:GUA|CAC|SJC';
  process.env.JWT_SECRET = 'test-secret';
  const result = login('admin', 'senha');
  assert.ok(result);
  assert.equal(result.v, 2);
  assert.deepEqual(result.regionals, ['GUA', 'CAC', 'SJC']);
  assert.equal(typeof result.token, 'string');
  // payload do token bate
  const decoded = verifyToken(result.token);
  assert.equal(decoded.v, 2);
  assert.deepEqual(decoded.regionals, ['GUA', 'CAC', 'SJC']);
});

test('verifyToken: rejeita token v=1 (sem campo v)', () => {
  const crypto = require('crypto');
  const secret = process.env.JWT_SECRET = 'test-secret';
  const b64 = (s) => Buffer.from(s).toString('base64url');
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  // payload v=1 (sem campo v, com regional string)
  const body = b64(JSON.stringify({
    username: 'old', role: 'user', regional: 'GUA',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  }));
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  const token = `${header}.${body}.${sig}`;
  const result = verifyToken(token);
  assert.equal(result, null, 'token v=1 deve ser rejeitado');
});

const { applyScope, compatRegionalParam } = require('../middleware/auth');

function mockReqRes(query = {}, user = { regionals: ['GUA', 'CAC'] }) {
  const res = {
    _status: null, _body: null,
    status(c) { this._status = c; return this; },
    json(b) { this._body = b; return this; },
    end() { return this; },
  };
  const req = { query, user, scope: null };
  let nextCalled = false;
  const next = () => { nextCalled = true; };
  return { req, res, next, called: () => nextCalled };
}

test('applyScope: sem ?regionals — usa todas do user', () => {
  const m = mockReqRes({}, { regionals: ['GUA', 'CAC'] });
  applyScope(m.req, m.res, m.next);
  assert.deepEqual(m.req.scope.regionals, ['GUA', 'CAC']);
  assert.ok(m.called());
});

test('applyScope: ?regionals=GUA intersecta com user', () => {
  const m = mockReqRes({ regionals: 'GUA' }, { regionals: ['GUA', 'CAC'] });
  applyScope(m.req, m.res, m.next);
  assert.deepEqual(m.req.scope.regionals, ['GUA']);
});

test('applyScope: ?regionals=SJC quando user nao tem — 403', () => {
  const m = mockReqRes({ regionals: 'SJC' }, { regionals: ['GUA', 'CAC'] });
  applyScope(m.req, m.res, m.next);
  assert.equal(m.res._status, 403);
  assert.equal(m.called(), false);
});

test('applyScope: ?regionals=SJC,GUA — filtra silenciosamente (mantem GUA)', () => {
  const m = mockReqRes({ regionals: 'SJC,GUA' }, { regionals: ['GUA', 'CAC'] });
  applyScope(m.req, m.res, m.next);
  assert.deepEqual(m.req.scope.regionals, ['GUA']);
  assert.ok(m.called());
});

test('applyScope: ?regionals=gua,cac — normaliza pra uppercase', () => {
  const m = mockReqRes({ regionals: 'gua,cac' }, { regionals: ['GUA', 'CAC'] });
  applyScope(m.req, m.res, m.next);
  assert.deepEqual(m.req.scope.regionals, ['GUA', 'CAC']);
});

test('compatRegionalParam: ?regional=GUA vira ?regionals=GUA', () => {
  const m = mockReqRes({ regional: 'GUA' });
  compatRegionalParam(m.req, m.res, m.next);
  assert.equal(m.req.query.regionals, 'GUA');
  assert.equal(m.req.query.regional, undefined);
  assert.ok(m.called());
});

test('compatRegionalParam: ?regional=ALL — apaga (cai em todas)', () => {
  const m = mockReqRes({ regional: 'ALL' });
  compatRegionalParam(m.req, m.res, m.next);
  assert.equal(m.req.query.regional, undefined);
  assert.equal(m.req.query.regionals, undefined);
  assert.ok(m.called());
});

test('compatRegionalParam: ?regional=ES — apaga (cai em todas)', () => {
  const m = mockReqRes({ regional: 'ES' });
  compatRegionalParam(m.req, m.res, m.next);
  assert.equal(m.req.query.regional, undefined);
  assert.ok(m.called());
});

test('compatRegionalParam: ja tem ?regionals=X — nao toca', () => {
  const m = mockReqRes({ regionals: 'GUA' });
  compatRegionalParam(m.req, m.res, m.next);
  assert.equal(m.req.query.regionals, 'GUA');
});

// ── P1-5: hash de senha (scrypt + compat SHA-256) ────────────────────────────
const { hashPassword, _verifyPassword } = require('../middleware/auth');
const _crypto = require('crypto');

test('hashPassword: gera formato scrypt$salt$hash e valida roundtrip', () => {
  const h = hashPassword('minhaSenha123');
  assert.match(h, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
  assert.equal(_verifyPassword('minhaSenha123', h), true);
  assert.equal(_verifyPassword('senhaErrada', h), false);
});

test('_verifyPassword: aceita hash SHA-256 legado (compat retroativa)', () => {
  const legado = _crypto.createHash('sha256').update('legada').digest('hex');
  assert.equal(_verifyPassword('legada', legado), true);
  assert.equal(_verifyPassword('outra', legado), false);
});

test('_verifyPassword: salts diferentes geram hashes diferentes (mesma senha)', () => {
  const h1 = hashPassword('igual');
  const h2 = hashPassword('igual');
  assert.notEqual(h1, h2);                 // salt aleatório
  assert.equal(_verifyPassword('igual', h1), true);
  assert.equal(_verifyPassword('igual', h2), true);
});
