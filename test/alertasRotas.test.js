/**
 * test/alertasRotas.test.js
 *
 * Contrato das rotas do alerta de baixa produtividade (T6). Sobe o app real em
 * DATA_MODE=mock (sem Postgres), como test/routes.test.js. O que depende do banco
 * é coberto por test/alertasQueries.test.js (SQL) e pelo teste de fonte abaixo.
 */

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

process.env.NODE_ENV    = 'test';
process.env.DATA_MODE   = 'mock';
process.env.JWT_SECRET  = 'test-secret-alertas';
process.env.CRON_SECRET = 'test-cron-secret';
process.env.AUTH_USERS = [
  `admin:${sha256('adminpass')}:admin:GUA|CAC|SJC`,
  `guarapari:${sha256('guapass')}:user:GUA`,
].join(',');

const app = require('../server');
const { formatarAlerta } = require('../services/alertaProdutividade');

let server, base;
before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});
after(() => { if (server) server.close(); });

async function req(method, rota, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(base + rota, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
async function login(u, p) {
  const { json } = await req('POST', '/api/auth/login', { body: { username: u, password: p } });
  return json.token;
}

describe('GET /api/alertas/produtividade', () => {
  test('sem token → 401', async () => {
    assert.equal((await req('GET', '/api/alertas/produtividade')).status, 401);
  });
  test('sem banco/desligado → { ativo:false, alertas:[] } (o balão nem aparece), nunca erro', async () => {
    for (const [u, p] of [['admin', 'adminpass'], ['guarapari', 'guapass']]) {
      const r = await req('GET', '/api/alertas/produtividade', { token: await login(u, p) });
      assert.equal(r.status, 200, u);
      assert.deepEqual(r.json, { ativo: false, alertas: [] }, u);
    }
  });
});

describe('/admin/alertas/config — só admin', () => {
  test('sem token → 401; conta comum → 403 (GET e PUT)', async () => {
    assert.equal((await req('GET', '/api/admin/alertas/config')).status, 401);
    const tk = await login('guarapari', 'guapass');
    assert.equal((await req('GET', '/api/admin/alertas/config', { token: tk })).status, 403);
    assert.equal((await req('PUT', '/api/admin/alertas/config', { token: tk, body: { ativo: true } })).status, 403);
  });
  test('admin lê a configuração: nasce DESLIGADA, limite 4', async () => {
    const r = await req('GET', '/api/admin/alertas/config', { token: await login('admin', 'adminpass') });
    assert.equal(r.status, 200);
    assert.equal(r.json.ativo, false);
    assert.equal(r.json.limite, 4);
    assert.deepEqual(r.json.categorias, ['COMERCIAL', 'PLANTAO', 'MOTO', 'BT_ZERO']);
  });
  test('PUT inválido → 400 com detalhes (e nada é gravado)', async () => {
    const tk = await login('admin', 'adminpass');
    for (const corpo of [{ limite: 0 }, { limite: '4' }, { ativo: 'sim' }, { categorias: ['XPTO'] }, { tolerancia_refeicao_min: -1 }]) {
      const r = await req('PUT', '/api/admin/alertas/config', { token: tk, body: corpo });
      assert.equal(r.status, 400, JSON.stringify(corpo));
      assert.equal(r.json.error, 'Configuração inválida');
      assert.ok(Array.isArray(r.json.detalhes) && r.json.detalhes.length > 0);
    }
  });
  test('PUT válido sem banco (mock) → 503, não 200 de mentira', async () => {
    const r = await req('PUT', '/api/admin/alertas/config', { token: await login('admin', 'adminpass'), body: { limite: 3 } });
    assert.equal(r.status, 503);
  });
});

describe('formatarAlerta', () => {
  const linha = {
    team_name: 'ECGPR53', regional: 'GUA', supervisor: 'JOAO SILVA', limite: 4,
    escala_inicio: '08:00', escala_fim: '17:00',
    meio_turno_em: new Date('2026-10-14T15:30:00Z'), disparado_em: '2026-10-14T15:31:00.000Z',
    executadas_disparo: 2, executadas_atual: '3', rejeitadas: 1,
  };
  test('formato do balão; usa o valor ATUAL, não o do disparo', () => {
    assert.deepEqual(formatarAlerta(linha), {
      equipe: 'ECGPR53', regional: 'GUA', supervisor: 'JOAO SILVA',
      executadas: 3, rejeitadas: 1, limite: 4,
      meioTurnoEm: '2026-10-14T15:30:00.000Z', disparadoEm: '2026-10-14T15:31:00.000Z',
      turno: { inicio: '08:00', fim: '17:00' },
    });
  });
  test('não vaza campos internos (id, sector_id, executadas_disparo)', () => {
    const f = formatarAlerta({ ...linha, id: 7, sector_id: 'DESG' });
    for (const k of ['id', 'sector_id', 'executadas_disparo', 'executadas_atual', 'team_name']) {
      assert.equal(k in f, false, k);
    }
  });
  test('supervisor ausente → null; turno ausente → nulls', () => {
    const f = formatarAlerta({ ...linha, supervisor: undefined, escala_inicio: null, escala_fim: undefined });
    assert.equal(f.supervisor, null);
    assert.deepEqual(f.turno, { inicio: null, fim: null });
  });
});

describe('rotas (fonte)', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'index.js'), 'utf8');
  const bloco = SRC.slice(SRC.indexOf('// ── ALERTA DE BAIXA PRODUTIVIDADE'), SRC.indexOf('// ── KPIs do dia'));

  test('a listagem é ESCOPADA: passa req.scope.regionals ao banco', () => {
    assert.match(bloco, /listarAtivos\(null, dateBRT\(\), req\.scope\.regionals\)/);
  });
  test('nenhuma resposta do bloco devolve err.message cru (P3-18a)', () => {
    assert.ok(!/res\.(status\(\d+\)\.)?json\(\{[^}]*err\.message/.test(bloco));
  });
  test('as rotas /admin ficam DEPOIS do router.use("/admin", requireAdmin)', () => {
    assert.ok(SRC.indexOf("router.use('/admin', requireAdmin)") < SRC.indexOf("router.get('/admin/alertas/config'"));
  });
  test('o PUT MESCLA com o gravado (mandar só o limite não desliga o alerta)', () => {
    assert.match(bloco, /validarConfigAlerta\(\{ \.\.\.base, \.\.\.corpo \}\)/);
  });
});
