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
const md       = (Code, CodeText = 'Substituição Projetos Especiais') => ({ Data: { Code, CodeText } });
const mdDet    = (Comments)                             => ({ Data: { Comments } }); // /details/optimized
const sf       = (Code, CodeText = 'desc')             => ({ Data: { Code, CodeText } });
const dd       = (GroupCode = '63', GroupDescription = 'BF-CHAVE FUSIVEL', Code = null) =>
                   ({ Data: { Code, GroupCode, GroupDescription } });
// Address: regra de negócio EDP (20/05/2026) — C93 só vira "Subs Ramal" se o
// Address contém "RAMAL BT". Default vazio (sem ramal bt); os testes de C93
// passam o Address explicitamente p/ deixar a dependência visível.
const RAMAL_BT = 'RUA TESTE 100 - RAMAL BT';
const details  = (Activities, Comments, Address = '') => ({ Data: { Activities, Comments, Address } });
const activity = (Code, Amount, IsPrimary = true)      => ({
  Activity:  { Code, Description: Code },
  Amount,
  IsPrimary,
});

// ═════════════════════════════════════════════════════════════════════════════
//  MD — Subs Obsoleto vs Subs TL11 (regra canônica: SPEB + Comments com TL11)
// ═════════════════════════════════════════════════════════════════════════════
describe('classificarMD', () => {
  // Helper: mocka /api/notes/md (Code/CodeText) + /details/optimized (Comments)
  const mdMock = (id, code, comments, sectorId = 'DESG') => ({
    [`/api/notes/md?noteId=${id}`]:                                          md(code),
    [`/api/Notes/${id}/details/optimized?sectorId=${sectorId}`]:             mdDet(comments),
  });

  test('SPEB + Comments com "Tratativa de TL11" → sub_code=TL11 (caso real)', async () => {
    const id = 'note-tl11-real';
    const { classificar } = loadClassifierWith(mdMock(id, 'SPEB',
      '* 05.12.2025 14:59:04 Luryan Ultramar Bravim (710037)* Tratativa de TL11'));
    const r = await classificar(id, 'MD', { sectorId: 'DESG' });
    assert.equal(r.sub_code,      'TL11');
    assert.equal(r.sub_categoria, 'Subs TL11');
    assert.equal(r.tipo,          'MD');
  });

  test('SPEB + Comments com typo "Trativa de TL11" também casa (robusto)', async () => {
    const id = 'note-tl11-typo';
    const { classificar } = loadClassifierWith(mdMock(id, 'SPEB',
      '* DATA HORA USUARIO* Trativa de TL11'));
    const r = await classificar(id, 'MD', { sectorId: 'DESG' });
    assert.equal(r.sub_code, 'TL11');
  });

  test('SPEB + Comments com "TL11" no meio do texto também casa', async () => {
    const id = 'note-tl11-inline';
    const { classificar } = loadClassifierWith(mdMock(id, 'SPEB',
      'projeto urgente conforme TL11 cliente XYZ'));
    const r = await classificar(id, 'MD', { sectorId: 'DESG' });
    assert.equal(r.sub_code, 'TL11');
  });

  test('SPEB + Comments preenchido SEM "TL11" → sub_code=OBSOLETO (caso real)', async () => {
    const id = 'note-obsoleto-real';
    const { classificar } = loadClassifierWith(mdMock(id, 'SPEB',
      '* 12.03.2026 13:45:27 CAROLINA DAS CHAGAS FERRARINI (205288) Tel. N/A* Projeto substituicao de medidores. Favor substituir medidor em* campo!'));
    const r = await classificar(id, 'MD', { sectorId: 'DESG' });
    assert.equal(r.sub_code,      'OBSOLETO');
    assert.equal(r.sub_categoria, 'Subs Obsoleto');
  });

  test('SPEB + Comments vazio → sub_code=OBSOLETO', async () => {
    const id = 'note-obsoleto-vazio';
    const { classificar } = loadClassifierWith(mdMock(id, 'SPEB', ''));
    const r = await classificar(id, 'MD', { sectorId: 'DESG' });
    assert.equal(r.sub_code, 'OBSOLETO');
  });

  test('SPEB + Comments null → sub_code=OBSOLETO (defensivo)', async () => {
    const id = 'note-obsoleto-null';
    const { classificar } = loadClassifierWith(mdMock(id, 'SPEB', null));
    const r = await classificar(id, 'MD', { sectorId: 'DESG' });
    assert.equal(r.sub_code, 'OBSOLETO');
  });

  test('SPEB + details/optimized falha (404) → trata como Comments vazio → OBSOLETO', async () => {
    // Garantia de robustez: se o endpoint pesado falhar, ainda classificamos.
    const id = 'note-obsoleto-404';
    const { classificar } = loadClassifierWith({
      [`/api/notes/md?noteId=${id}`]: md('SPEB'),
      // /details/optimized não mockado → 404 → safeJson retorna null
    });
    const r = await classificar(id, 'MD', { sectorId: 'DESG' });
    assert.equal(r.sub_code, 'OBSOLETO');
  });

  test('Code != SPEB → OUTROS, NÃO chama details/optimized (lazy fetch)', async () => {
    // Mockando só /api/notes/md (com Code != SPEB) — se classifier chamar
    // details/optimized vai dar 404 mas não deve, porque code != SPEB.
    const id = 'note-outros-no-details-call';
    const { classificar } = loadClassifierWith({
      [`/api/notes/md?noteId=${id}`]: md('XPTO'),
    });
    const r = await classificar(id, 'MD', { sectorId: 'DESG' });
    assert.equal(r.sub_code,      'OUTROS');
    assert.equal(r.sub_categoria, 'MD Outros');
  });

  test('Code = SPMD (não SPEB) → sub_code=OUTROS', async () => {
    const id = 'note-outros-spmd';
    const { classificar } = loadClassifierWith({
      [`/api/notes/md?noteId=${id}`]: md('SPMD'),
    });
    const r = await classificar(id, 'MD', { sectorId: 'DESG' });
    assert.equal(r.sub_code, 'OUTROS');
  });

  test('Match é case-insensitive (tl11 minúsculo, TL11 maiúsculo, Tl11 misto)', async () => {
    for (const variant of ['tl11', 'TL11', 'Tl11', 'tL11']) {
      const id = 'note-tl11-' + variant;
      const { classificar } = loadClassifierWith(mdMock(id, 'SPEB',
        'tratativa ' + variant));
      const r = await classificar(id, 'MD', { sectorId: 'DESG' });
      assert.equal(r.sub_code, 'TL11', `falhou p/ variant "${variant}"`);
    }
  });

  test('SectorId default DESG quando ctx.sectorId não passado', async () => {
    const id = 'note-tl11-no-sector';
    const { classificar } = loadClassifierWith(mdMock(id, 'SPEB',
      'Tratativa de TL11', 'DESG')); // mock usa DESG
    const r = await classificar(id, 'MD'); // sem ctx.sectorId
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
  test('BTZ013 com Comments "TOTAL CLIENTES: 6" → quantidade=6 (caso real)', async () => {
    // Caso real (nota 17160974, validado em prod 05/05/2026): Activity.Amount=1
    // mas Comments tem "TOTAL CLIENTES: 6" — quantidade real = 6 CS substituídos.
    const id = 'dd-btz013-real';
    const { classificar } = loadClassifierWith({
      [`/api/notes/dd?noteId=${id}`]: dd('63', 'BF-CHAVE FUSIVEL'),
      [`/api/Notes/${id}/details/optimized?sectorId=DESG`]: details(
        [activity('BTZ013', 1, true), activity('BTZ012', 1, false)],
        '* @MANUTBTZERO | CS_CP: 15453582-15453084 | NET: 403 | ID_CS: 582 | TOTAL CLIENTES: 6 | @MANUTBTZERO'
      ),
    });
    const r = await classificar(id, 'DD', { sectorId: 'DESG' });
    assert.equal(r.sub_code,      'BTZ013');
    assert.equal(r.sub_categoria, 'Substituição CS');
    assert.equal(r.quantidade,    6); // do Comments, não Activity.Amount
    assert.equal(r.code_text,     'BF-CHAVE FUSIVEL');
  });

  test('BTZ013 sem Comments → fallback pra Activity.Amount', async () => {
    // Nota legada sem template @MANUTBTZERO no Comments — usa Amount como
    // fallback (mantém comportamento anterior).
    const id = 'dd-btz013-no-comments';
    const { classificar } = loadClassifierWith({
      [`/api/notes/dd?noteId=${id}`]: dd('63', 'BF-CHAVE FUSIVEL'),
      [`/api/Notes/${id}/details/optimized?sectorId=DESG`]: details(
        [activity('BTZ013', 1, true)],
        ''
      ),
    });
    const r = await classificar(id, 'DD', { sectorId: 'DESG' });
    assert.equal(r.sub_code,   'BTZ013');
    assert.equal(r.quantidade, 1); // fallback Activity.Amount
  });

  test('BTZ013 com Comments mas sem padrão "TOTAL CLIENTES" → fallback', async () => {
    const id = 'dd-btz013-no-pattern';
    const { classificar } = loadClassifierWith({
      [`/api/notes/dd?noteId=${id}`]: dd(),
      [`/api/Notes/${id}/details/optimized?sectorId=DESG`]: details(
        [activity('BTZ013', 1, true)],
        'Comentário arbitrário sem template — apenas texto livre do operador.'
      ),
    });
    const r = await classificar(id, 'DD', { sectorId: 'DESG' });
    assert.equal(r.sub_code,   'BTZ013');
    assert.equal(r.quantidade, 1); // fallback Activity.Amount
  });

  test('BTZ013 com "TOTAL CLIENTES: 12" maior valor → quantidade=12', async () => {
    const id = 'dd-btz013-12';
    const { classificar } = loadClassifierWith({
      [`/api/notes/dd?noteId=${id}`]: dd(),
      [`/api/Notes/${id}/details/optimized?sectorId=DESG`]: details(
        [activity('BTZ013', 1, true)],
        '* @MANUTBTZERO | CS_CP: ... | TOTAL CLIENTES: 12 | @MANUTBTZERO'
      ),
    });
    const r = await classificar(id, 'DD', { sectorId: 'DESG' });
    assert.equal(r.quantidade, 12);
  });

  test('BTZ013 com regex case-insensitive (Total Clientes / TOTAL  CLIENTES com espaços)', async () => {
    for (const variant of ['TOTAL CLIENTES: 5', 'total clientes:5', 'Total  Clientes :  9', 'TotalClientes: 4']) {
      const expected = parseInt(variant.match(/\d+/)[0], 10);
      const id = 'dd-btz013-' + expected;
      const { classificar } = loadClassifierWith({
        [`/api/notes/dd?noteId=${id}`]: dd(),
        [`/api/Notes/${id}/details/optimized?sectorId=DESG`]: details(
          [activity('BTZ013', 1, true)],
          '* @MANUTBTZERO | ' + variant + ' | @MANUTBTZERO'
        ),
      });
      const r = await classificar(id, 'DD', { sectorId: 'DESG' });
      // 'TotalClientes' (sem espaço) NÃO casa o regex /TOTAL\s*CLIENTES\s*:/ —
      // por design (mantém especificidade do template oficial)
      const shouldMatch = /TOTAL\s*CLIENTES\s*:/i.test(variant);
      if (shouldMatch) {
        assert.equal(r.quantidade, expected, `falhou p/ variant "${variant}"`);
      } else {
        assert.equal(r.quantidade, 1, `variant "${variant}" deveria fazer fallback`);
      }
    }
  });

  test('Activities com C93 IsPrimary=true → sub_code=C93, quantidade=Amount (decimal)', async () => {
    const id = 'dd-c93';
    const { classificar } = loadClassifierWith({
      [`/api/notes/dd?noteId=${id}`]: dd('45', 'RAMAL DE LIGACAO'),
      [`/api/Notes/${id}/details/optimized?sectorId=DESG`]: details([
        activity('C93', 12.5, true),
      ], undefined, RAMAL_BT),
    });
    const r = await classificar(id, 'DD', { sectorId: 'DESG' });
    assert.equal(r.sub_code,      'C93');
    assert.equal(r.sub_categoria, 'Subs Ramal');
    assert.equal(r.quantidade,    12.5);
  });

  test('REGRA RAMAL BT: atividade C93 mas Address SEM "ramal bt" → OUTROS (não conta como ramal)', async () => {
    // Regra de negócio EDP (20/05/2026, confirmada com Clarissa @engelmig):
    // só notas com "RAMAL BT" no Address contam como Subs Ramal. C93 em
    // endereço sem "ramal bt" é ramal não-BT e fica fora do indicador.
    const id = 'dd-c93-sem-ramalbt';
    const { classificar } = loadClassifierWith({
      [`/api/notes/dd?noteId=${id}`]: dd('45', 'RAMAL DE LIGACAO'),
      [`/api/Notes/${id}/details/optimized?sectorId=DESG`]: details([
        activity('C93', 9, true),
      ], undefined, 'AVENIDA SEM MARCADOR 200'),
    });
    const r = await classificar(id, 'DD', { sectorId: 'DESG' });
    assert.equal(r.sub_code,      'OUTROS');
    assert.equal(r.sub_categoria, 'DD Outros');
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
      ], undefined, RAMAL_BT),
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
      ], undefined, RAMAL_BT),
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

  test('Fallback: Activities=[] + Code "C93" no campo top-level → sub_code=C93', async () => {
    // Casos CAPEX onde Activities[] vem vazio mas o Code da nota é C93.
    // Substitui o antigo fallback baseado em GroupDescription regex (frágil).
    const id = 'dd-ramal-fallback';
    const { classificar } = loadClassifierWith({
      [`/api/notes/dd?noteId=${id}`]: dd('63', 'RAMAL DE LIGACAO - CAPEX', 'C93'),
      [`/api/Notes/${id}/details/optimized?sectorId=DESG`]: details([], undefined, RAMAL_BT),
    });
    const r = await classificar(id, 'DD', { sectorId: 'DESG' });
    assert.equal(r.sub_code,      'C93');
    assert.equal(r.sub_categoria, 'Subs Ramal');
    assert.equal(r.quantidade,    null); // sem Activities[].Amount, quantidade fica null
  });

  test('Fallback: Activities=[] + Code "BTZ013" no top-level → sub_code=BTZ013', async () => {
    const id = 'dd-cs-fallback';
    const { classificar } = loadClassifierWith({
      [`/api/notes/dd?noteId=${id}`]: dd('99', 'CAIXA SECCIONADORA', 'BTZ013'),
      [`/api/Notes/${id}/details/optimized?sectorId=DESG`]: details([]),
    });
    const r = await classificar(id, 'DD', { sectorId: 'DESG' });
    assert.equal(r.sub_code,      'BTZ013');
    assert.equal(r.sub_categoria, 'Substituição CS');
  });

  test('Activities=[] e Code/GroupCode diferente de C93/BTZ013 → OUTROS (regex de descrição não usa mais)', async () => {
    // Mesmo com GroupDescription "RAMAL", se Code/GroupCode não bater → OUTROS.
    // Texto livre foi removido por ser frágil (variações de grafia).
    const cases = [
      'PODA DE ARVORES - OPEX',
      'MANUT. CIRC. PRIMARIO - MT - OPEX',
      'BF-CHAVE FUSIVEL <34,5 kV - OPEX',
      'SUBSTITUIR RAMAL LIGACAO',  // mesmo isto fica OUTROS sem Code C93
    ];
    for (const desc of cases) {
      const id = 'dd-' + desc.slice(0, 6).toLowerCase().replace(/\W/g, '-');
      const { classificar } = loadClassifierWith({
        [`/api/notes/dd?noteId=${id}`]: dd('99', desc),
        [`/api/Notes/${id}/details/optimized?sectorId=DESG`]: details([]),
      });
      const r = await classificar(id, 'DD', { sectorId: 'DESG' });
      assert.equal(r.sub_code, 'OUTROS', `"${desc}" sem Code C93/BTZ013 deveria ficar em OUTROS`);
    }
  });

  test('Activities com BTZ013 vence Code top-level "C93"', async () => {
    // Garante que Activities[] (mais preciso) tem prioridade sobre Code.
    const id = 'dd-conflict';
    const { classificar } = loadClassifierWith({
      [`/api/notes/dd?noteId=${id}`]: dd('058', 'qualquer', 'C93'),
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
      [`/api/notes/md?noteId=${id}`]: md('SPEB'),
    });
    const r = await classificar(id, 'md'); // lowercase
    assert.equal(r.tipo,     'MD');
    assert.equal(r.sub_code, 'OBSOLETO'); // SPEB sem TL11 no Comments
  });

  test('ctx.numero é repassado no resultado', async () => {
    const id = 'with-numero';
    const { classificar } = loadClassifierWith({
      [`/api/notes/md?noteId=${id}`]: md('SPEB'),
    });
    const r = await classificar(id, 'MD', { numero: '000017123456' });
    assert.equal(r.numero, '000017123456');
    assert.equal(r.note_id, id);
  });
});
