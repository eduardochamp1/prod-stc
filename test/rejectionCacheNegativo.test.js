// 14/10/2026 — cache negativo envenenou o tipo SF: 1 nota com 404 em sfdl+sfrl
// marcava o tipo todo como "sem path" e as demais saíam "sem motivo registrado"
// (205 linhas de 07/10 com raw={"no_path_cached":"SF"}).
const test = require('node:test');
const assert = require('node:assert/strict');

const wpaPath = require.resolve('../services/wpaService');
const rejPath = require.resolve('../services/rejectionService');

function carregar(respostas) {
  const wpaAntes = require.cache[wpaPath];
  const rejAntes = require.cache[rejPath];
  const chamadas = [];
  require.cache[wpaPath] = {
    id: wpaPath, filename: wpaPath, loaded: true,
    exports: {
      wpaFetch: async (url) => {
        chamadas.push(url);
        const r = respostas(url);
        return {
          status: r.status, ok: r.status === 200,
          json: async () => r.body,
        };
      },
    },
  };
  delete require.cache[rejPath];
  const svc = require('../services/rejectionService');
  const restaurar = () => {
    delete require.cache[rejPath];
    if (wpaAntes) require.cache[wpaPath] = wpaAntes; else delete require.cache[wpaPath];
    if (rejAntes) require.cache[rejPath] = rejAntes;
  };
  return { svc, chamadas, restaurar };
}

const OK = { status: 200, body: { Data: { Rejection: {
  RejectionReasons: [{ Code: '0020', Description: 'Local Fechado sem acesso - Coletivo' }],
  RejectedAt: '2026-10-07T19:07:00' } } } };

test('SF: uma nota 404 não envenena as notas seguintes do mesmo tipo', async () => {
  const { svc, restaurar } = carregar(url =>
    url.includes('noteId=ruim') ? { status: 404 } : OK);
  try {
    const ruim = await svc.fetchRejectionDetails('ruim', 'SF');
    assert.equal(ruim.endpoint_missing, true);
    assert.deepEqual(svc.getNoPathTipos(), [], 'SF tem KNOWN_PATHS: não entra no cache negativo');

    const boa = await svc.fetchRejectionDetails('boa', 'SF');
    assert.deepEqual(boa.motivo_codes, ['0020']);
    assert.ok(boa.rejection_date);
    assert.notEqual(boa.raw.no_path_cached, 'SF');
  } finally { restaurar(); }
});

test('SF: se sfdl/sfrl dão 404, tenta os demais paths de formulário', async () => {
  const { svc, chamadas, restaurar } = carregar(url =>
    url.includes('/api/notes/lnrl') ? OK : { status: 404 });
  try {
    const r = await svc.fetchRejectionDetails('x', 'SF');
    assert.deepEqual(r.motivo_codes, ['0020']);
    assert.ok(chamadas.some(u => u.includes('/api/notes/lnrl')));
  } finally { restaurar(); }
});

test('tipo SEM path confirmado: cache negativo vale, mas expira por TTL', async () => {
  const { svc, chamadas, restaurar } = carregar(() => ({ status: 404 }));
  try {
    await svc.fetchRejectionDetails('a', 'PO');
    assert.deepEqual(svc.getNoPathTipos(), ['PO']);
    const n = chamadas.length;
    const r2 = await svc.fetchRejectionDetails('b', 'PO');
    assert.equal(chamadas.length, n, 'dentro do TTL não faz request');
    assert.equal(r2.raw.no_path_cached, 'PO');

    // Vence o TTL
    svc._noPathForTipo.set('PO', Date.now() - svc.NO_PATH_TTL_MS - 1000);
    assert.equal(svc._isNoPath('PO'), false);
    await svc.fetchRejectionDetails('c', 'PO');
    assert.ok(chamadas.length > n, 'após o TTL volta a tentar');
  } finally { restaurar(); }
});
