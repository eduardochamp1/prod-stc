/**
 * test/usuariosMigrationPendente.test.js
 *
 * INCIDENTE 07/10/2026, 16:22–17:03: código novo lendo `excluido_em` antes do
 * add_usuario_excluido.sql ser aplicado. A leitura de usuários falhou inteira:
 * só a conta de emergência entrava, e nem ela listava usuários. O log dizia
 * "banco indisponível" com o banco no ar.
 *
 * Aqui o pool fake responde como o Postgres responde a coluna inexistente
 * (código 42703), e o teste exige:
 *  - coluna OPCIONAL faltando → o login segue funcionando;
 *  - coluna da tabela original faltando → continua NEGANDO;
 *  - o log diz a verdade (migration pendente, banco no ar) e não se repete.
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV     = 'test';
process.env.DATA_MODE    = 'mock';
process.env.JWT_SECRET   = 'test-secret-migration-pendente';
process.env.DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://test:test@localhost:5432/test';

const { hashPassword } = require('../middleware/auth');
const usuariosSvc = require('../services/usuarios');
const { _cache, descreverFalha } = usuariosSvc;
const { _setPool } = require('../services/pgShim');

const SENHA_EMERG = 'senha-emergencia';
const SENHA_USER  = 'senha-do-fulano';
const H_USER      = hashPassword(SENHA_USER);

// A conta de emergência do .env — no incidente, a única que entrava.
process.env.AUTH_USERS = `admin:${hashPassword(SENHA_EMERG)}:admin:GUA|CAC|SJC`;

/** Colunas que "não existem" no banco fake. */
let _faltando = new Set();

const LINHAS = [
  { username: 'admin', senha_hash: 'x', role: 'admin', regionals: 'GUA|CAC|SJC',
    ativo: true, pode_gerenciar: true, criado_em: '2026-09-22', criado_por: 'migracao' },
  { username: 'fulano', senha_hash: H_USER, role: 'user', regionals: 'GUA',
    ativo: true, pode_gerenciar: false, criado_em: '2026-09-22', criado_por: 'admin' },
];

_setPool({
  query: async (sql, params) => {
    if (/^\s*(insert|update|delete)/i.test(sql)) return { rows: [], rowCount: 1 };
    if (/usuarios_log/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/usuarios/i.test(sql)) {
      for (const c of _faltando) {
        if (new RegExp(`\\b${c}\\b`).test(sql)) {
          // A forma exata do erro do node-postgres.
          throw Object.assign(new Error(`column "${c}" does not exist`), { code: '42703' });
        }
      }
      // O `buscar` filtra por username; sem isto ele receberia a linha errada.
      const alvo = (params || []).find(p => LINHAS.some(l => l.username === p));
      const rows = alvo ? LINHAS.filter(l => l.username === alvo) : LINHAS;
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  },
  on: () => {},
});

const app = require('../server');
let server, base;

before(async () => {
  await new Promise(r => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { if (server) server.close(); });

async function req(metodo, caminho, token, corpo) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(base + caminho, {
    method: metodo, headers, body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

/** Captura o que foi para console.error/warn durante `fn`. */
async function capturarLog(fn) {
  const linhas = [];
  const [e, w] = [console.error, console.warn];
  console.error = (...a) => linhas.push(a.join(' '));
  console.warn  = (...a) => linhas.push(a.join(' '));
  try { await fn(); } finally { console.error = e; console.warn = w; }
  return linhas;
}

test('SEM excluido_em: usuário do banco ENTRA (era o que falhava no incidente)', async () => {
  _faltando = new Set(['excluido_em']);
  _cache.limpar();
  let res;
  const linhas = await capturarLog(async () => {
    res = await req('POST', '/api/auth/login', null,
      { username: 'fulano', password: SENHA_USER });
  });
  assert.equal(res.status, 200, `login negado com só a migration pendente: ${JSON.stringify(res.json)}`);

  // E avisou — alto, uma vez, com o arquivo a aplicar.
  const avisos = linhas.filter(l => /MIGRATION PENDENTE/.test(l));
  assert.equal(avisos.length, 1, `esperava 1 aviso, vieram: ${linhas.join(' | ')}`);
  assert.match(avisos[0], /add_usuario_excluido\.sql/);
});

test('SEM excluido_em: a conta de emergência LISTA usuários (a outra metade do incidente)', async () => {
  _faltando = new Set(['excluido_em']);
  _cache.limpar();
  const { json: login } = await req('POST', '/api/auth/login', null,
    { username: 'admin', password: SENHA_EMERG });
  assert.ok(login.token);

  _cache.limpar();
  const { status, json } = await req('GET', '/api/admin/usuarios', login.token);
  assert.equal(status, 200, `admin não listou: ${status} ${JSON.stringify(json)}`);
  assert.ok(json.usuarios.some(u => u.username === 'fulano'));
});

test('SEM as duas colunas opcionais: ainda entra', async () => {
  _faltando = new Set(['excluido_em', 'senha_provisoria']);
  _cache.limpar();
  const { status } = await req('POST', '/api/auth/login', null,
    { username: 'fulano', password: SENHA_USER });
  assert.equal(status, 200);
});

test('coluna da tabela ORIGINAL faltando continua NEGANDO — tolerância não é fail-open', async () => {
  // `ativo` decide quem entra; sem ela não há como saber, então nega.
  _faltando = new Set(['ativo']);
  _cache.limpar();
  const { status } = await req('POST', '/api/auth/login', null,
    { username: 'fulano', password: SENHA_USER });
  assert.notEqual(status, 200, 'entrou sem a coluna que decide se o usuário está ativo');
});

test('o aviso de migration pendente sai UMA vez, nomeia o arquivo, e não diz "banco indisponível"', async () => {
  // No incidente foram centenas de linhas iguais dizendo "banco indisponível".
  // Processo novo do teste já avisou nos testes acima; aqui só não pode repetir.
  _faltando = new Set(['excluido_em']);
  const linhas = await capturarLog(async () => {
    for (let i = 0; i < 5; i++) {
      _cache.limpar();
      await req('POST', '/api/auth/login', null, { username: 'fulano', password: SENHA_USER });
    }
  });
  assert.equal(linhas.filter(l => /excluido_em/.test(l)).length, 0,
    `repetiu o aviso: ${linhas.join(' | ')}`);
});

test('descreverFalha: coluna faltando é "migration pendente", com o arquivo, e "banco NO AR"', () => {
  const msg = descreverFalha(Object.assign(
    new Error('column "excluido_em" does not exist'), { code: '42703' }));
  assert.match(msg, /migration pendente/);
  assert.match(msg, /add_usuario_excluido\.sql/);
  assert.match(msg, /NO AR/);
  assert.doesNotMatch(msg, /banco indispon/);
});

test('descreverFalha: falha de conexão continua sendo "banco indisponível"', () => {
  const msg = descreverFalha(Object.assign(
    new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }));
  assert.match(msg, /banco indispon/);
});
