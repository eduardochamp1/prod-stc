/**
 * test/classifier.test.js
 *
 * Suite de testes do services/classifierService.js usando node:test (built-in).
 *
 * Como rodar:
 *   npm test                           # roda toda a suíte
 *   node --test test/classifier.test.js  # só este arquivo
 *   node --test --test-name-pattern="TL11" test/   # filtra por nome
 *
 * Estratégia: cada teste injeta um stub de wpaService no require.cache antes
 * de carregar o classifierService — assim isolamos das chamadas HTTP reais.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// ── Helper: carrega classifierService com wpaFetch mockado ───────────────────
function loadClassifierWith(fixturesByPath) {
  const wpaPath        = require.resolve('../services/wpaService');
  const classifierPath = require.resolve('../services/classifierService');
  // Limpa cache p/ forçar recarregamento com o stub
  delete require.cache[wpaPath];
  delete require.cache[classifierPath];

  // Stub do wpaService — exporta apenas wpaFetch (única função usada)
  require.cache[wpaPath] = {
    id: wpaPath,
    filename: wpaPath,
    loaded: true,
    exports: {
      wpaFetch: async (urlPath) => {
        if (!(urlPath in fixturesByPath)) {
          // Endpoint não mockado → 404 (safeJson devolve null)
          return { ok: false, status: 404, json: async () => null };
        }
        const data = fixturesByPath[urlPath];
        if (data === null) {
          // Mock explícito de erro 500
          return { ok: false, status: 500, json: async () => null };
        }
        return { ok: true, json: async () => data };
      },
    },
  };

  return require('../services/classifierService');
}

// ── Builders curtos de fixtures ──────────────────────────────────────────────
const md       = (Code, CodeText = 'desc')             => ({ Data: { Code, CodeText } });
const prio     = (SubProject)                          => ({ Data: { SubProject } });
const sf       = (Code, CodeText = 'desc')             => ({ Data: { Code, CodeText } });
const dd       = (GroupCode = '63', GroupDescription = 'BF-CHAVE FUSIVEL') => ({ Data: { GroupCode, GroupDescription } });
const details  = (Activities)                          => ({ Data: { Activities } });
const activity = (Code, Amount, IsPrimary = true)      => ({
  Activity:  { Code, Description: Code },
  Amount,
  IsPrimary,
});

// ═════════════════════════════════════════════════════════════════════════════
//  MD — Subs Obsoleto vs Subs TL11
// ═════════════════════════════════════════════════════════════════════════════
describe('classificarMD', () => {
  test('SubProject "TL11 Conv" → sub_code=TL11', async () => {
    const id = 'note-tl11-conv';
    const { classificar } = loadClassifierWith({
      [`/api/notes/md?noteId=${id}`]:                    md('SPMD', 'Subs MD'),
      [`/api/notepriorities/GetByNoteId/${id}`]:         prio('TL11 Conv'),
    });
    const r = await classificar(id, 'MD');
    assert.equal(r.sub_code,      'TL11');
    assert.equal(r.sub_categoria, 'Subs TL11');
    assert.equal(r.tipo,          'MD');
  });

  test('SubProject "TL11 Tele" também casa o prefixo TL11*', async () => {
    const id = 'note-tl11-tele';
    const { classificar } = loadClassifierWith({
      [`/api/notes/md?noteId=${id}`]:                    md('SPMD'),
      [`/api/notepriorities/GetByNoteId/${id}`]:         prio('TL11 Tele'),
    });
    const r = await classificar(id, 'MD');
    assert.equal(r.sub_code, 'TL11');
  });

  test('SubProject "OBSOLETO" → sub_code=OBSOLETO', async () => {
    const id = 'note-obsoleto';
    const { classificar } = loadClassifierWith({
      [`/api/notes/md?noteId=${id}`]:                    md('SPMD'),
      [`/api/notepriorities/GetByNoteId/${id}`]:         prio('OBSOLETO'),
    });
    const r = await classificar(id, 'MD');
    assert.equal(r.sub_code,      'OBSOLETO');
    assert.equal(r.sub_categoria, 'Subs Obsoleto');
  });

  test('SubProject NULL + Code "SPEB" → sub_code=OBSOLETO (regra de negócio)', async () => {
    const id = 'note-speb-null';
    const { classificar } = loadClassifierWith({
      [`/api/notes/md?noteId=${id}`]:                    md('SPEB'),
      [`/api/notepriorities/GetByNoteId/${id}`]:         prio(null),
    });
    const r = await classificar(id, 'MD');
    assert.equal(r.sub_code,      'OBSOLETO');
    assert.equal(r.sub_categoria, 'Subs Obsoleto');
  });

  test('SubProject NULL + Code aleatório → sub_code=OUTROS', async () => {
    const id = 'note-outros';
    const { classificar } = loadClassifierWith({
      [`/api/notes/md?noteId=${id}`]:                    md('XPTO'),
      [`/api/notepriorities/GetByNoteId/${id}`]:         prio(null),
    });
    const r = await classificar(id, 'MD');
    assert.equal(r.sub_code,      'OUTROS');
    assert.equal(r.sub_categoria, 'MD Outros');
  });

  test('SubProject "TL11" exato (sem sufixo) também casa', async () => {
    const id = 'note-tl11-bare';
    const { classificar } = loadClassifierWith({
      [`/api/notes/md?noteId=${id}`]:                    md('SPMD'),
      [`/api/notepriorities/GetByNoteId/${id}`]:         prio('TL11'),
    });
    const r = await classificar(id, 'MD');
    assert.equal(r.sub_code, 'TL11');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  SF — Corte Disjuntor (SRED) vs Corte Borne (SREB), com fallback sfdl→sfrl
// ═════════════════════════════════════════════════════════════════════════════
describe('classificarSF', () => {
  test('sfdl com Code=SRED → sub_code=L0 (Corte Disjuntor)', async () => {
    const id = 'sf-sred-local';
    const { classificar } = loadClassifierWith({
      [`/api/notes/sfdl?noteId=${id}`]: sf('SRED', 'Corte por inadimplência'),
    });
    const r = await classificar(id, 'SF');
    assert.equal(r.sub_code,      'L0');
    assert.equal(r.sub_categoria, 'Corte Disjuntor');
  });

  test('sfdl sem Code → fallback sfrl com Code=SREB → sub_code=L1 (Corte Borne)', async () => {
    const id = 'sf-sreb-remoto';
    const { classificar } = loadClassifierWith({
      [`/api/notes/sfdl?noteId=${id}`]: { Data: { Code: null } },
      [`/api/notes/sfrl?noteId=${id}`]: sf('SREB'),
    });
    const r = await classificar(id, 'SF');
    assert.equal(r.sub_code,      'L1');
    assert.equal(r.sub_categoria, 'Corte Borne');
  });

  test('sfdl 404 + sfrl com Code=SRED → fallback funciona via 404, não só null', async () => {
    const id = 'sf-sfdl-404';
    const { classificar } = loadClassifierWith({
      // sfdl não mockado → 404 → safeJson retorna null
      [`/api/notes/sfrl?noteId=${id}`]: sf('SRED'),
    });
    const r = await classificar(id, 'SF');
    assert.equal(r.sub_code, 'L0');
  });

  test('sfdl e sfrl ambos sem Code → sub_code=OUTROS', async () => {
    const id = 'sf-vazio';
    const { classificar } = loadClassifierWith({
      [`/api/notes/sfdl?noteId=${id}`]: { Data: { Code: null } },
      [`/api/notes/sfrl?noteId=${id}`]: { Data: { Code: null } },
    });
    const r = await classificar(id, 'SF');
    assert.equal(r.sub_code,      'OUTROS');
    assert.equal(r.sub_categoria, 'SF Outros');
  });

  test('Code "CREB" (não SRED nem SREB) → sub_code=OUTROS', async () => {
    const id = 'sf-creb';
    const { classificar } = loadClassifierWith({
      [`/api/notes/sfdl?noteId=${id}`]: sf('CREB'),
    });
    const r = await classificar(id, 'SF');
    assert.equal(r.sub_code, 'OUTROS');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  DD — Subs Ramal (C93) vs Substituição CS (BTZ013), com IsPrimary tiebreak
// ═════════════════════════════════════════════════════════════════════════════
describe('classificarDD', () => {
  test('Activities com BTZ013 IsPrimary=true → sub_code=BTZ013, quantidade=Amount', async () => {
    const id = 'dd-btz013';
    const { classificar } = loadClassifierWith({
      [`/api/notes/dd?noteId=${id}`]: dd('63', 'BF-CHAVE FUSIVEL'),
      [`/api/Notes/${id}/details/optimized?sectorId=DESG`]: details([
        activity('BTZ013', 1, true),
        activity('BTZ012', 1, false),
      ]),
    });
    const r = await classificar(id, 'DD', { sectorId: 'DESG' });
    assert.equal(r.sub_code,      'BTZ013');
    assert.equal(r.sub_categoria, 'Substituição CS');
    assert.equal(r.quantidade,    1);
    assert.equal(r.code_text,     'BF-CHAVE FUSIVEL');
  });

  test('Activities com C93 IsPrimary=true → sub_code=C93, quantidade=Amount (decimal)', async () => {
    const id = 'dd-c93';
    const { classificar } = loadClassifierWith({
      [`/api/notes/dd?noteId=${id}`]: dd('45', 'RAMAL DE LIGACAO'),
      [`/api/Notes/${id}/details/optimized?sectorId=DESG`]: details([
        activity('C93', 12.5, true),
      ]),
    });
    const r = await classificar(id, 'DD', { sectorId: 'DESG' });
    assert.equal(r.sub_code,      'C93');
    assert.equal(r.sub_categoria, 'Subs Ramal');
    assert.equal(r.quantidade,    12.5);
  });

  test('IsPrimary tiebreak: prefere a primária quando há duplicatas do mesmo Code', async () => {
    const id = 'dd-btz013-dup';
    const { classificar } = loadClassifierWith({
      [`/api/notes/dd?noteId=${id}`]: dd(),
      [`/api/Notes/${id}/details/optimized?sectorId=DESG`]: details([
        activity('BTZ013',  5, false), // secundária
        activity('BTZ013', 99, true),  // primária ← deve ser escolhida
      ]),
    });
    const r = await classificar(id, 'DD', { sectorId: 'DESG' });
    assert.equal(r.sub_code,    'BTZ013');
    assert.equal(r.quantidade,  99);
  });

  test('C93 só como secundária (sem primária com C93) → ainda classifica como C93', async () => {
    const id = 'dd-c93-secondary-only';
    const { classificar } = loadClassifierWith({
      [`/api/notes/dd?noteId=${id}`]: dd(),
      [`/api/Notes/${id}/details/optimized?sectorId=DESG`]: details([
        activity('OUTRA', 1, true),    // primária mas não é C93/BTZ013
        activity('C93',   3, false),   // C93 secundária
      ]),
    });
    const r = await classificar(id, 'DD', { sectorId: 'DESG' });
    assert.equal(r.sub_code,   'C93');
    assert.equal(r.quantidade, 3);
  });

  test('Activities=[] (caso PODA/MANUT) → sub_code=OUTROS', async () => {
    const id = 'dd-poda';
    const { classificar } = loadClassifierWith({
      [`/api/notes/dd?noteId=${id}`]: dd('45', 'PODA DE ARVORES'),
      [`/api/Notes/${id}/details/optimized?sectorId=DESG`]: details([]),
    });
    const r = await classificar(id, 'DD', { sectorId: 'DESG' });
    assert.equal(r.sub_code,      'OUTROS');
    assert.equal(r.sub_categoria, 'DD Outros');
    assert.equal(r.code_text,     'PODA DE ARVORES');
  });

  test('details/optimized falha (404) → sub_code=OUTROS, code_text vem do dd endpoint', async () => {
    const id = 'dd-details-fail';
    const { classificar } = loadClassifierWith({
      [`/api/notes/dd?noteId=${id}`]: dd('99', 'MANUT. CIRC.'),
      // details/optimized não mockado → 404 → safeJson null → activities=[]
    });
    const r = await classificar(id, 'DD', { sectorId: 'DESG' });
    assert.equal(r.sub_code,  'OUTROS');
    assert.equal(r.code_text, 'MANUT. CIRC.');
  });

  test('sectorId default DESG quando não passado em ctx', async () => {
    const id = 'dd-default-sector';
    const { classificar } = loadClassifierWith({
      [`/api/notes/dd?noteId=${id}`]: dd(),
      [`/api/Notes/${id}/details/optimized?sectorId=DESG`]: details([
        activity('C93', 8, true),
      ]),
    });
    const r = await classificar(id, 'DD'); // sem ctx
    assert.equal(r.sub_code, 'C93');
  });

  test('sectorId customizado é repassado pra URL', async () => {
    const id = 'dd-custom-sector';
    const { classificar } = loadClassifierWith({
      [`/api/notes/dd?noteId=${id}`]: dd(),
      [`/api/Notes/${id}/details/optimized?sectorId=CACO`]: details([
        activity('BTZ013', 2, true),
      ]),
    });
    const r = await classificar(id, 'DD', { sectorId: 'CACO' });
    assert.equal(r.sub_code, 'BTZ013');
  });

  test('Fallback: Activities=[] + GroupDescription "RAMAL DE LIGACAO - CAPEX" → sub_code=C93 (quantidade=null)', async () => {
    const id = 'dd-ramal-fallback';
    const { classificar } = loadClassifierWith({
      [`/api/notes/dd?noteId=${id}`]: dd('0000000000000000058', 'RAMAL DE LIGACAO - CAPEX'),
      [`/api/Notes/${id}/details/optimized?sectorId=DESG`]: details([]),
    });
    const r = await classificar(id, 'DD', { sectorId: 'DESG' });
    assert.equal(r.sub_code,      'C93');
    assert.equal(r.sub_categoria, 'Subs Ramal');
    assert.equal(r.quantidade,    null); // sem Activities[].Amount, quantidade fica null
    assert.equal(r.code_text,     'RAMAL DE LIGACAO - CAPEX');
  });

  test('Fallback NÃO dispara em GroupDescriptions OPEX (PODA, MANUT, INSPECAO, BF-CHAVE)', async () => {
    // Garante que o fallback do RAMAL é específico — não vaza pra OPEX.
    const cases = [
      'PODA DE ARVORES - OPEX',
      'MANUT. CIRC. PRIMARIO - MT - OPEX',
      'INSPECAO DE REDES E EQUIPTO - OPEX',
      'BF-CHAVE FUSIVEL <34,5 kV - OPEX',
    ];
    for (const desc of cases) {
      const id = 'dd-' + desc.slice(0, 6).toLowerCase().replace(/\W/g, '-');
      const { classificar } = loadClassifierWith({
        [`/api/notes/dd?noteId=${id}`]: dd('99', desc),
        [`/api/Notes/${id}/details/optimized?sectorId=DESG`]: details([]),
      });
      const r = await classificar(id, 'DD', { sectorId: 'DESG' });
      assert.equal(r.sub_code, 'OUTROS', `"${desc}" deveria ficar em OUTROS`);
    }
  });

  test('Fallback prioridade: Activities com BTZ013 vence GroupDescription RAMAL', async () => {
    // Garante que o fallback só dispara quando Activities está vazio.
    // Se uma nota tem GroupDescription RAMAL mas Activities tem BTZ013, vence Activities.
    const id = 'dd-conflict';
    const { classificar } = loadClassifierWith({
      [`/api/notes/dd?noteId=${id}`]: dd('058', 'RAMAL DE LIGACAO - CAPEX'),
      [`/api/Notes/${id}/details/optimized?sectorId=DESG`]: details([
        activity('BTZ013', 1, true),
      ]),
    });
    const r = await classificar(id, 'DD', { sectorId: 'DESG' });
    assert.equal(r.sub_code,   'BTZ013');
    assert.equal(r.quantidade, 1); // pega Amount do Activities, não null
  });

  test('raw.activities preserva apenas Code/Amount/IsPrimary (sem fotos/checkpoints)', async () => {
    const id = 'dd-raw-shape';
    const { classificar } = loadClassifierWith({
      [`/api/notes/dd?noteId=${id}`]: dd(),
      [`/api/Notes/${id}/details/optimized?sectorId=DESG`]: details([
        activity('BTZ013', 1, true),
      ]),
    });
    const r = await classificar(id, 'DD', { sectorId: 'DESG' });
    assert.deepEqual(r.raw.activities, [
      { Code: 'BTZ013', Amount: 1, IsPrimary: true },
    ]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  API pública — dispatch e edge cases
// ═════════════════════════════════════════════════════════════════════════════
describe('classificar (dispatch)', () => {
  test('tipo desconhecido → null', async () => {
    const { classificar } = loadClassifierWith({});
    const r = await classificar('xxx', 'XYZ');
    assert.equal(r, null);
  });

  test('noteId vazio → null', async () => {
    const { classificar } = loadClassifierWith({});
    const r = await classificar(null, 'MD');
    assert.equal(r, null);
  });

  test('tipo lower-case é normalizado p/ uppercase', async () => {
    const id = 'lc-md';
    const { classificar } = loadClassifierWith({
      [`/api/notes/md?noteId=${id}`]:            md('SPEB'),
      [`/api/notepriorities/GetByNoteId/${id}`]: prio(null),
    });
    const r = await classificar(id, 'md'); // lowercase
    assert.equal(r.tipo,     'MD');
    assert.equal(r.sub_code, 'OBSOLETO');
  });

  test('ctx.numero é repassado no resultado', async () => {
    const id = 'with-numero';
    const { classificar } = loadClassifierWith({
      [`/api/notes/md?noteId=${id}`]:            md('SPEB'),
      [`/api/notepriorities/GetByNoteId/${id}`]: prio(null),
    });
    const r = await classificar(id, 'MD', { numero: '000017123456' });
    assert.equal(r.numero, '000017123456');
    assert.equal(r.note_id, id);
  });
});
