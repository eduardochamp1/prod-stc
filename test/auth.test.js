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
