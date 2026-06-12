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
