'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const S      = require('../services/saidaNota');
const D      = require('../scripts/diag-saida-nota');

const MIN = 60000;
const T0 = Date.parse('2026-10-15T13:00:00Z');           // 10:00 BRT
const LOCAL = { lat: -20.3155, lon: -40.3128 };          // Vitória
// ~1,1 km ao norte (0,01° de latitude)
const LONGE = { lat: -20.3055, lon: -40.3128 };

const cp = (event, minutos, coord = LOCAL, extra = {}) => ({
  event, timestamp: new Date(T0 + minutos * MIN).toISOString(),
  latitude: coord.lat, longitude: coord.lon, ...extra,
});

// ── coordenadas ─────────────────────────────────────────────────────────────

test('normalizaCoord: graus passam, vazio/(0,0)/lixo viram null', () => {
  assert.deepStrictEqual(S.normalizaCoord(-20.3, -40.3), { lat: -20.3, lon: -40.3 });
  assert.deepStrictEqual(S.normalizaCoord('-20.3', '-40.3'), { lat: -20.3, lon: -40.3 });
  assert.equal(S.normalizaCoord(0, 0), null);
  assert.equal(S.normalizaCoord(null, -40), null);
  assert.equal(S.normalizaCoord('', ''), null);
  assert.equal(S.normalizaCoord('abc', 1), null);
});

test('normalizaCoord: UTM 24S da EDP vira lat/lon no ES', () => {
  const c = S.normalizaCoord(349457.25, 7928881.48);
  assert.ok(c.lat < -18 && c.lat > -22, `lat ${c.lat}`);
  assert.ok(c.lon < -39 && c.lon > -42, `lon ${c.lon}`);
});

test('distanciaM: 0,01° de latitude ≈ 1,1 km', () => {
  const d = S.distanciaM(LOCAL, LONGE);
  assert.ok(d > 1100 && d < 1120, `d=${d}`);
});

// ── checkpoints ─────────────────────────────────────────────────────────────

test('instanteCp: prefere registradoEm (ISO ou BR), cai no timestamp', () => {
  assert.equal(S.instanteCp({ registradoEm: '2026-10-15T10:00:00-03:00', timestamp: '2026-10-15T14:00:00Z' }), T0);
  assert.equal(S.instanteCp({ registradoEm: '15/10/2026 10:00:00' }), T0);
  assert.equal(S.instanteCp({ registradoEm: null, timestamp: '2026-10-15T13:00:00Z' }), T0);
  assert.equal(S.instanteCp({}), null);
});

test('janelaExecucao: do último Início (2) ao Fim (3) depois dele', () => {
  const j = S.janelaExecucao([
    cp(0, -40), cp(1, -20), cp(2, -10, LONGE), cp(3, -5),   // 1ª tentativa
    cp(0, -2), cp(1, -1), cp(2, 0), cp(4, 50), cp(3, 60),   // a que concluiu
  ]);
  assert.equal(j.inicio, T0);
  assert.equal(j.fim, T0 + 60 * MIN);
  assert.deepStrictEqual(j.cpInicio, LOCAL);
});

test('janelaExecucao: sem Fim usa o último Finalizando (4); sem nada diz o motivo', () => {
  assert.equal(S.janelaExecucao([cp(2, 0), cp(4, 30), cp(4, 40)]).fim, T0 + 40 * MIN);
  assert.equal(S.janelaExecucao([]).motivo, 'sem_checkpoint');
  assert.equal(S.janelaExecucao([cp(0, 0), cp(1, 5)]).motivo, 'sem_inicio');
  assert.equal(S.janelaExecucao([cp(2, 0)]).motivo, 'sem_fim');
});

test('ancoraDaNota: cadastro primeiro, início como reserva, e a ordem pode inverter', () => {
  assert.equal(S.ancoraDaNota({ cadastro: LOCAL, cpInicio: LONGE }).fonte, 'cadastro');
  assert.equal(S.ancoraDaNota({ cadastro: null, cpInicio: LONGE }).fonte, 'inicio');
  assert.equal(S.ancoraDaNota({ cadastro: LOCAL, cpInicio: LONGE }, 'inicio').fonte, 'inicio');
  assert.equal(S.ancoraDaNota({ cadastro: null, cpInicio: null }), null);
});

// ── trilha ──────────────────────────────────────────────────────────────────

const janela = { inicio: T0, fim: T0 + 90 * MIN };
const pt = (minutos, coord) => ({ t: T0 + minutos * MIN, ...coord });
const params = { raioM: 300, minForaMin: 10 };

test('avaliarNota: ficou no local → ok', () => {
  const pontos = [0, 15, 30, 45, 60, 75, 90].map(m => pt(m, LOCAL));
  const r = S.avaliarNota({ pontos, janela, ancora: LOCAL }, params);
  assert.equal(r.status, 'ok');
  assert.equal(r.distMaxM, 0);
  assert.equal(r.minFora, 0);
});

test('avaliarNota: 30 min a 1,1 km no meio da execução → saiu', () => {
  const pontos = [pt(0, LOCAL), pt(10, LOCAL), pt(20, LONGE), pt(35, LONGE), pt(50, LOCAL), pt(90, LOCAL)];
  const r = S.avaliarNota({ pontos, janela, ancora: LOCAL }, params);
  assert.equal(r.status, 'saiu');
  assert.equal(r.minFora, 30);               // do 1º ponto fora (20) ao 1º de volta (50)
  assert.ok(r.distMaxM > 1100);
  assert.equal(r.saidas.length, 1);
});

test('avaliarNota: um ponto solto fora é salto de GPS, não saída', () => {
  const pontos = [pt(0, LOCAL), pt(20, LONGE), pt(40, LOCAL), pt(90, LOCAL)];
  assert.equal(S.avaliarNota({ pontos, janela, ancora: LOCAL }, params).status, 'ok');
});

test('avaliarNota: saída curta (abaixo do mínimo) não marca', () => {
  const pontos = [pt(0, LOCAL), pt(20, LONGE), pt(24, LONGE), pt(28, LOCAL), pt(90, LOCAL)];
  assert.equal(S.avaliarNota({ pontos, janela, ancora: LOCAL }, params).status, 'ok');
});

test('avaliarNota: saiu e não voltou conta até o fim da janela', () => {
  const pontos = [pt(0, LOCAL), pt(60, LONGE), pt(80, LONGE)];
  const r = S.avaliarNota({ pontos, janela, ancora: LOCAL }, params);
  assert.equal(r.status, 'saiu');
  assert.equal(r.minFora, 30);
});

test('avaliarNota: sem ponto na janela nem nas 6h antes é sem_trilha, nunca ok', () => {
  const fora = [pt(-400, LOCAL), pt(120, LOCAL)];
  const r = S.avaliarNota({ pontos: fora, janela, ancora: LOCAL }, params);
  assert.equal(r.status, 'sem_trilha');
  assert.equal(r.buracoMin, 90);
});

test('avaliarNota: trilha só grava mudança — parado desde antes do início é ok', () => {
  // chegou às 09:40 e não se mexeu mais: nenhum ponto durante a execução
  const r = S.avaliarNota({ pontos: [pt(-20, LOCAL)], janela, ancora: LOCAL }, params);
  assert.equal(r.status, 'ok');
  assert.equal(r.pts[0].herdado, true);
  assert.equal(r.pts[0].t, T0);
});

test('avaliarNota: saiu dirigindo e parou longe (1 ponto, ignição ligada) → saiu', () => {
  const pontos = [pt(-20, LOCAL), { ...pt(30, LONGE), ign: true }];
  const r = S.avaliarNota({ pontos, janela, ancora: LOCAL }, params);
  assert.equal(r.status, 'saiu');
  assert.equal(r.minFora, 60);               // das 30 ao fim da janela (90)
});

test('avaliarNota: veículo já longe no início é fora_no_inicio, não "saiu"', () => {
  const r = S.avaliarNota({ pontos: [pt(-20, LONGE), pt(60, LONGE)], janela, ancora: LOCAL }, params);
  assert.equal(r.status, 'fora_no_inicio');
  assert.equal(r.km, 0);
});

test('maiorBuracoFrotaMin: frota calada por 25 min na janela', () => {
  const b0 = Math.floor(T0 / 300000);
  const baldes = new Set();
  for (let i = 0; i <= 18; i++) if (i < 6 || i > 10) baldes.add(b0 + i);   // falta 6..10
  assert.equal(S.maiorBuracoFrotaMin(baldes, janela), 25);
  assert.equal(S.maiorBuracoFrotaMin(new Set(), { inicio: T0, fim: T0 + 9 * MIN }), 10);
});

test('veiculoConfere: veículo longe do tablet no início não é o da equipe', () => {
  const longeDemais = { lat: -22.45, lon: -43.65 };              // RJ, ~350 km
  const v = S.veiculoConfere({ pontos: [pt(1, longeDemais), pt(30, longeDemais)], janela, ref: LOCAL, limiteM: 5000 });
  assert.equal(v.confere, false);
  assert.ok(v.distM > 300000);
  assert.equal(S.veiculoConfere({ pontos: [pt(2, LOCAL)], janela, ref: LOCAL, limiteM: 5000 }).confere, true);
  // sem ponto perto do início usa o 1º da janela
  assert.equal(S.veiculoConfere({ pontos: [pt(40, LONGE)], janela, ref: LOCAL, limiteM: 5000 }).confere, true);
  assert.equal(S.veiculoConfere({ pontos: [], janela, ref: LOCAL, limiteM: 5000 }), null);
  assert.equal(S.veiculoConfere({ pontos: [pt(0, LOCAL)], janela, ref: null, limiteM: 5000 }), null);
});

test('deduplicar: nota repetida entre dias fica no dia em que a execução começou', () => {
  const j = { inicio: T0, fim: T0 + 60 * MIN };                  // 15/10 10:00 BRT
  const r = D.deduplicar([
    { note_id: 'a', data: '2026-10-14', janela: j, status: 'saiu' },
    { note_id: 'a', data: '2026-10-15', janela: j, status: 'saiu' },
    { note_id: 'a', data: '2026-10-16', janela: j, status: 'saiu' },
    { note_id: 'b', data: '2026-10-14', status: 'sem_detalhe' },
    { note_id: 'b', data: '2026-10-15', status: 'sem_detalhe' },
  ]);
  assert.equal(r.length, 2);
  assert.equal(r.find(x => x.note_id === 'a').data, '2026-10-15');
  assert.equal(r.find(x => x.note_id === 'b').data, '2026-10-14');
});

test('placaGseqNaData: correção do dia vence vigência; vigência fechada não vale', () => {
  const al = [
    { sigla: 'EQ1', placa: 'AAA-1A11', tipo: 'VIGENCIA', desde: '2026-09-01', ate: null },
    { sigla: 'EQ1', placa: 'BBB-2B22', tipo: 'VIGENCIA', desde: '2026-10-01', ate: null },
    { sigla: 'EQ1', placa: 'CCC-3C33', tipo: 'DIA', desde: '2026-10-15', ate: '2026-10-15' },
    { sigla: 'EQ2', placa: 'DDD-4D44', tipo: 'VIGENCIA', desde: '2026-09-01', ate: '2026-09-30' },
  ];
  assert.equal(D.placaGseqNaData(al, 'EQ1', '2026-10-14'), 'BBB-2B22');
  assert.equal(D.placaGseqNaData(al, 'EQ1', '2026-10-15'), 'CCC-3C33');
  assert.equal(D.placaGseqNaData(al, 'EQ1', '2026-09-10'), 'AAA-1A11');
  assert.equal(D.placaGseqNaData(al, 'EQ2', '2026-10-15'), null);
});

test('placaChave e percentil', () => {
  assert.equal(S.placaChave('tzw-7g19'), 'TZW7G19');
  assert.equal(S.placaChave('ABC1234'), 'ABC1234');
  assert.equal(S.placaChave('—'), null);
  assert.equal(S.placaChave(null), null);
  assert.equal(S.percentil([5, 1, 3, 2, 4], 50), 3);
  assert.equal(S.percentil([], 90), null);
});

// ── script ──────────────────────────────────────────────────────────────────

test('lerArgs: padrões, valores e erros', () => {
  const a = D.lerArgs([]);
  assert.equal(a.dias, 7); assert.equal(a.raio, 300); assert.equal(a.minFora, 10); assert.equal(a.ancora, 'cadastro');
  const b = D.lerArgs(['--dias=3', '--raio=500', '--min-fora=15', '--ancora=inicio', '--ate=2026-10-16']);
  assert.deepStrictEqual([b.dias, b.raio, b.minFora, b.ancora, b.ate], [3, 500, 15, 'inicio', '2026-10-16']);
  assert.ok(D.lerArgs(['--dias=90']).erros.length);
  assert.ok(D.lerArgs(['--raio=10']).erros.length);
  assert.ok(D.lerArgs(['--xpto']).erros.length);
});

test('patrulha: EP em PO por padrão; --patrulha troca ou desliga', () => {
  const pad = D.lerArgs([]).patrulha;
  assert.equal(D.ehPatrulha('EPMFL30', 'PO', pad), true);
  assert.equal(D.ehPatrulha('EPMFL30', 'OS', pad), false);
  assert.equal(D.ehPatrulha('ECCIT50', 'PO', pad), false);
  const dois = D.lerArgs(['--patrulha=EP:PO,eb:po']).patrulha;
  assert.equal(D.ehPatrulha('EBGPR64', 'PO', dois), true);
  assert.deepStrictEqual(D.lerArgs(['--patrulha=']).patrulha, []);
  assert.ok(D.lerArgs(['--patrulha=EP']).erros.length);
});

test('diasDoPeriodo: termina ontem por padrão e recusa hoje', () => {
  assert.deepStrictEqual(D.diasDoPeriodo({ dias: 3, ate: '2026-10-16' }, '2026-10-18'),
    ['2026-10-14', '2026-10-15', '2026-10-16']);
  assert.throws(() => D.diasDoPeriodo({ dias: 1, ate: '2026-10-18' }, '2026-10-18'));
});

test('configGseq: socket local por padrão; URL do Prisma perde o ?schema=', () => {
  assert.equal(D.configGseq({}).database, 'gseq');
  assert.equal(D.configGseq({ GSEQ_DATABASE_URL: 'postgresql://u:p@localhost:5432/gseq?schema=public' }).connectionString,
    'postgresql://u:p@localhost:5432/gseq');
  assert.equal(D.configGseq({ GSEQ_DATABASE_URL: 'postgresql://h/gseq?schema=public&sslmode=disable' }).connectionString,
    'postgresql://h/gseq?sslmode=disable');
});

test('executar: cruza nota × rastreador ponta a ponta com bancos falsos', async () => {
  const NOTA_OK = '11111111-1111-1111-1111-111111111111';
  const NOTA_SAIU = '22222222-2222-2222-2222-222222222222';
  const NOTA_SEM_PLACA = '33333333-3333-3333-3333-333333333333';
  const NOTA_DIV = '55555555-5555-5555-5555-555555555555';
  const NOTA_SEM_PONTO = '66666666-6666-6666-6666-666666666666';
  const RJ = { lat: -22.45, lon: -43.65 };
  const cps = [cp(2, 0), cp(3, 90)];
  const pool = {
    query: async (sql) => {
      if (/equipes_oficiais/.test(sql)) return { rows: [
        { sigla: 'EQ1', placa: 'ABC1D23' }, { sigla: 'EQ2', placa: 'XYZ9876' }, { sigla: 'EQ3', placa: null },
        { sigla: 'EQ4', placa: 'RJX1A23' }, { sigla: 'EQ5', placa: 'NOP1234' }] };
      if (/snapshots/.test(sql)) return { rows: [
        { note_id: NOTA_OK, team_name: 'EQ1', regional: 'GUA', placa_wpa: 'ABC-1D23' },
        { note_id: NOTA_SAIU, team_name: 'EQ2', regional: 'GUA', placa_wpa: '—' },   // cai no cadastro
        { note_id: NOTA_SEM_PLACA, team_name: 'EQ3', regional: 'GUA', placa_wpa: null },
        { note_id: '44444444-4444-4444-4444-444444444444', team_name: 'FORA', regional: 'GUA', placa_wpa: null },
        { note_id: NOTA_DIV, team_name: 'EQ4', regional: 'GUA', placa_wpa: 'RJX1A23' },
        { note_id: NOTA_SEM_PONTO, team_name: 'EQ5', regional: 'GUA', placa_wpa: 'NOP1234' },
      ] };
      if (/note_details/.test(sql)) return { rows: [NOTA_OK, NOTA_SAIU, NOTA_SEM_PLACA, NOTA_DIV, NOTA_SEM_PONTO].map((id, i) => ({
        note_id: id, numero: String(100 + i), tipo: 'CS', checkpoints: cps,
        endereco: { latitude: LOCAL.lat, longitude: LOCAL.lon } })) };
      throw new Error('sql inesperado: ' + sql);
    },
  };
  const pos = (v, m, c) => ({ v, t: new Date(T0 + m * MIN), lat: c.lat, lon: c.lon });
  const poolGseq = { query: async (sql, params) => {
    if (/equipes_veiculos/.test(sql)) return { rows: [
      { sigla: 'EQ1', placa: 'ABC-1D23', tipo: 'VIGENCIA', desde: '2026-10-01', ate: null }] };
    if (/DISTINCT floor/.test(sql)) {           // ingestão viva o tempo todo
      const rows = [];
      for (let b = Math.floor((T0 - 7 * 3600000) / 300000); b <= Math.floor((T0 + 3 * 3600000) / 300000); b++) rows.push({ b: String(b) });
      return { rows };
    }
    assert.match(sql, /vehicle_positions/);
    assert.deepStrictEqual(params[2].sort(), ['%ABC1D23%', '%NOP1234%', '%RJX1A23%', '%XYZ9876%']);
    return { rows: [
      pos('ABC1D23', 0, LOCAL), pos('ABC1D23', 45, LOCAL), pos('ABC1D23', 90, LOCAL),
      pos('XYZ987624HORAS', 0, LOCAL), pos('XYZ987624HORAS', 20, LONGE), pos('XYZ987624HORAS', 40, LONGE),
      pos('XYZ987624HORAS', 60, LOCAL),
      pos('RJX1A23', 0, RJ), pos('RJX1A23', 45, RJ), pos('RJX1A23', 90, RJ),
    ] };
  } };
  const saida = [];
  const res = await D.executar({ pool, poolGseq, args: { ...D.lerArgs(['--dias=1', '--ate=2026-10-15']) },
    hoje: '2026-10-18', escrever: (s) => saida.push(s) });
  assert.equal(res.total, 5);                       // FORA não é oficial
  assert.equal(res.fontePlaca.gseq, 1);
  assert.equal(res.funil.veiculo_divergente, 1);
  assert.equal(res.funil.sem_trilha_placa, 1);
  assert.equal(res.divergentes[0].placa, 'RJX1A23');
  assert.equal(res.semPlaca[0].placa, 'NOP1234');
  assert.equal(res.funil.ok, 1);
  assert.equal(res.funil.saiu, 1);
  assert.equal(res.funil.sem_placa, 1);
  assert.equal(res.fontePlaca.cadastro, 1);
  assert.equal(res.piores[0].equipe, 'EQ2');
  assert.match(saida.join('\n'), /1 de 2 notas saíram/);
});
