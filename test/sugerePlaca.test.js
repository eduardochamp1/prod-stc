'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const P      = require('../scripts/diag-sugere-placa');

const MIN = 60000;
const T0 = Date.parse('2026-10-15T13:00:00Z');
const NOTA = { lat: -20.3155, lon: -40.3128 };
const LONGE = { lat: -20.3055, lon: -40.3128 };          // ~1,1 km

test('placaDoNome: tira a placa do nome da unidade, com ou sem separador', () => {
  assert.equal(P.placaDoNome('TZW-7G19'), 'TZW7G19');
  assert.equal(P.placaDoNome('TLF-3E65 / 24 HORAS'), 'TLF3E65');
  assert.equal(P.placaDoNome('CAMINHAO ABC1234'), 'ABC1234');
  assert.equal(P.placaDoNome('caminhaoabc1234'), 'ABC1234');
  assert.equal(P.placaDoNome('SEM PLACA'), null);
  assert.equal(P.fmtPlaca('TZW7G19'), 'TZW-7G19');
});

test('posicaoNoInstante: último ponto até 6h antes; senão o 1º até 15 min depois', () => {
  const pts = [{ t: T0 - 60 * MIN, id: 'a' }, { t: T0 - 5 * MIN, id: 'b' }, { t: T0 + 10 * MIN, id: 'c' }];
  assert.equal(P.posicaoNoInstante(pts, T0).id, 'b');
  assert.equal(P.posicaoNoInstante([{ t: T0 + 10 * MIN, id: 'c' }], T0).id, 'c');
  assert.equal(P.posicaoNoInstante([{ t: T0 + 20 * MIN, id: 'c' }], T0), null);
  assert.equal(P.posicaoNoInstante([{ t: T0 - 400 * MIN, id: 'a' }], T0), null);
  assert.equal(P.posicaoNoInstante([], T0), null);
});

test('veiculosPerto: só quem estava dentro do raio no instante', () => {
  const frota = new Map([
    ['AAA1A11', [{ t: T0 - 10 * MIN, ...NOTA }]],
    ['BBB2B22', [{ t: T0 - 10 * MIN, ...LONGE }]],
    ['CCC3C33', [{ t: T0 - 10 * MIN, ...LONGE }, { t: T0 - 2 * MIN, ...NOTA }]],
  ]);
  assert.deepStrictEqual(P.veiculosPerto(frota, NOTA, T0, 300).sort(), ['AAA1A11', 'CCC3C33']);
});

test('veredito: forte exige volume, maioria e folga sobre o 2º', () => {
  assert.equal(P.veredito(new Map([['A', 8], ['B', 2]]), 10, 5).forca, 'forte');
  assert.equal(P.veredito(new Map([['A', 8], ['B', 5]]), 10, 5).forca, 'fraca');   // pátio: 2º perto demais
  assert.equal(P.veredito(new Map([['A', 4]]), 4, 5).forca, 'fraca');              // poucas notas
  assert.equal(P.veredito(new Map([['A', 4]]), 10, 5).forca, 'fraca');             // < 60%
  assert.equal(P.veredito(new Map(), 10, 5).forca, 'nenhum');
});

test('lerArgs: padrões e erros', () => {
  const a = P.lerArgs([]);
  assert.deepStrictEqual([a.dias, a.raio, a.minNotas, a.equipes, a.todas], [7, 300, 5, null, false]);
  assert.deepStrictEqual(P.lerArgs(['--equipes=eccit53, ecpiu90']).equipes, ['ECCIT53', 'ECPIU90']);
  assert.ok(P.lerArgs(['--dias=0']).erros.length);
  assert.ok(P.lerArgs(['--xpto']).erros.length);
});

test('executar: sugere o veículo que estava junto do tablet, ponta a ponta', async () => {
  // EQ1: WPA diz XXX9X99 (longe), mas TZW7G19 está junto do tablet nas 6 notas.
  // EQ2: WPA diz ABC1234 e confere.  EQ3: nenhum veículo junto (sem rastreador).
  const ids = (k, n) => Array.from({ length: n }, (_, i) => `${k}${i}`.padEnd(8, '0') + '-0000-0000-0000-000000000000');
  const eq1 = ids('1', 6), eq2 = ids('2', 6), eq3 = ids('3', 3);
  // EQ1 trabalha na NOTA; EQ2 em LONGE (1,1 km); EQ3 onde não há veículo nenhum.
  const cps = (id) => {
    const c = id[0] === '2' ? LONGE : id[0] === '3' ? { lat: -21.0, lon: -41.0 } : NOTA;
    const i = Number(id[1]) || 0;
    return [
      { event: 2, timestamp: new Date(T0 + i * 60 * MIN).toISOString(), latitude: c.lat, longitude: c.lon },
      { event: 3, timestamp: new Date(T0 + (i * 60 + 30) * MIN).toISOString(), latitude: c.lat, longitude: c.lon },
    ];
  };
  const pool = { query: async (sql) => {
    if (/equipes_oficiais/.test(sql)) return { rows: [{ sigla: 'EQ1' }, { sigla: 'EQ2' }, { sigla: 'EQ3' }] };
    if (/snapshots/.test(sql)) return { rows: [
      ...eq1.map(id => ({ note_id: id, team_name: 'EQ1', placa_wpa: 'XXX-9X99' })),
      ...eq2.map(id => ({ note_id: id, team_name: 'EQ2', placa_wpa: 'ABC1234' })),
      ...eq3.map(id => ({ note_id: id, team_name: 'EQ3', placa_wpa: 'RBE0A89' })),
    ] };
    if (/note_details/.test(sql)) return { rows: [...eq1, ...eq2, ...eq3].map((id) => ({
      note_id: id, checkpoints: cps(id) })) };
    throw new Error('sql inesperado');
  } };
  const pos = (vehicle, m, c) => ({ vehicle, t: new Date(T0 + m * MIN), lat: c.lat, lon: c.lon });
  const poolGseq = { query: async (sql) => {
    if (/equipes_veiculos/.test(sql)) return { rows: [] };
    assert.match(sql, /vehicle_positions/);
    assert.doesNotMatch(sql, /driver|document/i);
    // TZW7G19 parado na NOTA (junto do tablet da EQ1), ABC1234 parado em LONGE
    // (junto do tablet da EQ2), e o XXX9X99 — placa do WPA da EQ1 — no RJ.
    return { rows: [
      pos('CAMINHAO TZW-7G19 / 24H', -30, NOTA),
      pos('ABC-1234', -30, LONGE),
      pos('XXX9X99 FULANO', -30, { lat: -22.45, lon: -43.65 }),
    ] };
  } };
  const saida = [];
  const linhas = await P.executar({ pool, poolGseq, hoje: '2026-10-18',
    args: P.lerArgs(['--dias=1', '--ate=2026-10-15']), escrever: (s) => saida.push(s) });
  const eq = (s) => linhas.find(l => l.equipe === s);
  assert.equal(eq('EQ1').sugerida, 'TZW7G19');
  assert.equal(eq('EQ1').forca, 'forte');
  assert.equal(eq('EQ1').confere, false);
  assert.equal(eq('EQ1').wpaNoRastreador, true);
  assert.equal(eq('EQ2').sugerida, 'ABC1234');
  assert.equal(eq('EQ2').confere, true);
  assert.equal(eq('EQ3').sugerida, null);
  assert.equal(eq('EQ3').wpaNoRastreador, false);
  const txt = saida.join('\n');
  assert.match(txt, /EQ1 .*XXX-9X99.*TZW-7G19\s+forte/);
  assert.doesNotMatch(txt, /FULANO/);                     // nome da unidade nunca sai
  assert.match(txt, /SUGESTÃO DE PLACA/);
});
