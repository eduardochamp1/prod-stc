'use strict';

// Job noturno da aba "Saída da nota" (P2-70): avaliarDia ponta a ponta com os
// dois bancos falsos, gravação idempotente, pool do gseq e o backfill.

const test   = require('node:test');
const assert = require('node:assert');
const J      = require('../services/saidaNotaJob');
const Q      = require('../db/saidaNotaQueries');
const { configGseqPool } = require('../services/gseqPool');
const B      = require('../scripts/backfill-saida-nota');

const MIN = 60000;
const T0 = Date.parse('2026-10-15T13:00:00Z');              // 15/10 10:00 BRT
const NOTA = { lat: -20.3155, lon: -40.3128 };
const LONGE = { lat: -20.3055, lon: -40.3128 };
const id = (n) => `${String(n).repeat(8)}-0000-0000-0000-000000000000`;
const cps = (iniMin, fimMin, c = NOTA) => [
  { event: 2, timestamp: new Date(T0 + iniMin * MIN).toISOString(), latitude: c.lat, longitude: c.lon },
  { event: 3, timestamp: new Date(T0 + fimMin * MIN).toISOString(), latitude: c.lat, longitude: c.lon },
];

function pools({ alocacoes, intervalos = [] } = {}) {
  const sqls = [];
  const pool = { query: async (sql, params) => {
    sqls.push(sql);
    if (/FROM public\.snapshots/.test(sql)) return { rows: [
      { note_id: id(1), equipe: 'ECCIT50', regional: 'GUA' },   // ficou → ok
      { note_id: id(2), equipe: 'ECCIT51', regional: 'GUA' },   // saiu
      { note_id: id(3), equipe: 'ECCIT51', regional: 'GUA' },   // junto com a 2 (mesma ocorrência)
      { note_id: id(4), equipe: 'ETCIT15', regional: 'GUA' },   // sem placa cadastrada
      { note_id: id(5), equipe: 'ECCIT50', regional: 'GUA' },   // execução de ONTEM → fora deste dia
      { note_id: id(6), equipe: 'ECCIT50', regional: 'GUA' },   // sem detalhe
    ] };
    if (/FROM public\.note_details/.test(sql)) {
      const end = { latitude: NOTA.lat, longitude: NOTA.lon };
      return { rows: [
        { note_id: id(1), numero: '101', tipo: 'SF', checkpoints: cps(0, 60), endereco: end },
        { note_id: id(2), numero: '102', tipo: 'MD', checkpoints: cps(120, 210), endereco: end },
        { note_id: id(3), numero: '103', tipo: 'MD', checkpoints: cps(125, 200), endereco: end },
        { note_id: id(4), numero: '104', tipo: 'SF', checkpoints: cps(0, 30), endereco: end },
        { note_id: id(5), numero: '105', tipo: 'SF', checkpoints: cps(-24 * 60, -23 * 60), endereco: end },
      ] };
    }
    if (/FROM public\.sessao_intervalo/.test(sql)) return { rows: intervalos };
    if (/INSERT INTO public\.saida_nota/.test(sql)) return { rows: [] };
    throw new Error('sql inesperado (wpa): ' + sql.slice(0, 60));
  } };
  const poolGseq = { query: async (sql, params) => {
    sqls.push(sql);
    assert.doesNotMatch(sql, /INSERT|UPDATE|DELETE/i, 'gseq é só leitura');
    if (/FROM equipes_veiculos/.test(sql)) return { rows: alocacoes || [
      { sigla: 'ECCIT50', placa: 'TDY-1C64', tipo: 'VIGENCIA', desde: '2026-10-01', ate: null },
      { sigla: 'ECCIT51', placa: 'TDY-1C71', tipo: 'VIGENCIA', desde: '2026-10-01', ate: null },
    ] };
    if (/DISTINCT floor/.test(sql)) {
      const rows = [];
      for (let b = Math.floor((T0 - 7 * 3600000) / 300000); b <= Math.floor((T0 + 6 * 3600000) / 300000); b++) rows.push({ b: String(b) });
      return { rows };
    }
    if (/LIKE ANY/.test(sql)) {
      assert.deepStrictEqual(params[2].sort(), ['%TDY1C64%', '%TDY1C71%']);
      const p = (v, m, c, ign) => ({ v, t: new Date(T0 + m * MIN), lat: c.lat, lon: c.lon, ignition: !!ign });
      return { rows: [
        p('TDY1C64', -20, NOTA),
        p('TDY1C71', 100, NOTA), p('TDY1C71', 140, LONGE, true), p('TDY1C71', 170, LONGE), p('TDY1C71', 190, NOTA),
      ] };
    }
    if (/SELECT vehicle, lat, lon/.test(sql)) return { rows: [   // frota (sugestão)
      { vehicle: 'CAMINHAO TTR-8D24 FULANO DE TAL', t: new Date(T0 - 5 * MIN), lat: NOTA.lat, lon: NOTA.lon },
    ] };
    throw new Error('sql inesperado (gseq): ' + sql.slice(0, 60));
  } };
  return { pool, poolGseq, sqls };
}

test('avaliarDia: classifica, corta o dia, usa só a placa do cadastro e agrupa', async () => {
  const { pool, poolGseq } = pools();
  const { linhas, resumo } = await J.avaliarDia({ data: '2026-10-15', pool, poolGseq });
  const por = Object.fromEntries(linhas.map(l => [l.numero || l.note_id, l]));
  assert.equal(linhas.length, 5, 'a nota 105 é de 14/10 e fica fora');
  assert.equal(por['101'].status, 'ok');
  assert.equal(por['101'].placaFonte, 'gseq-vigencia');
  assert.equal(por['102'].status, 'saiu');
  assert.equal(por['102'].minFora, 50);
  assert.equal(por['102'].ocorrenciaId, por['103'].ocorrenciaId);
  assert.equal(por['104'].status, 'sem_placa');
  assert.deepStrictEqual(por['104'].veiculosJunto, ['TTR8D24']);
  assert.equal(por[id(6)].status, 'sem_janela');
  // 102 e 103 executadas juntas: as DUAS notas saíram, mas é UMA ocorrência
  assert.equal(resumo.porStatus.saiu, 2);
  assert.equal(new Set(linhas.filter(l => l.status === 'saiu').map(l => l.ocorrenciaId)).size, 1);
  assert.equal(resumo.regra, 'r500-m15-v5000-f20-pEP:PO,*:OS');
  // soma dos status = notas avaliadas no dia (aritmética por construção)
  assert.equal(Object.values(resumo.porStatus).reduce((a, b) => a + b, 0), linhas.length);
});

test('avaliarDia: pausa apontada cobrindo a saída → saiu_em_intervalo', async () => {
  const { pool, poolGseq } = pools({ intervalos: [
    { equipe: 'ECCIT51', motivo: '15 - Horário de Refeição', inicio: '2026-10-15T12:10:00', fim: '2026-10-15T13:20:00' }] });
  const { linhas } = await J.avaliarDia({ data: '2026-10-15', pool, poolGseq });
  assert.equal(linhas.find(l => l.numero === '102').status, 'saiu_em_intervalo');
});

test('avaliarDia: sem cadastro nenhum, ninguém é avaliado (a placa do WPA não é lida)', async () => {
  const { pool, poolGseq, sqls } = pools({ alocacoes: [] });
  const { linhas } = await J.avaliarDia({ data: '2026-10-15', pool, poolGseq });
  assert.ok(linhas.every(l => ['sem_placa', 'sem_janela'].includes(l.status)));
  assert.ok(!sqls.some(s => /vehiclePlate/.test(s)), 'a placa da sessão do WPA não entra (D4)');
});

test('runSaidaNota: sem gseq configurado não avalia nem grava', async () => {
  const r = await J.runSaidaNota({ data: '2026-10-15', pool: { query: () => { throw new Error('não devia'); } }, poolGseq: null });
  assert.equal(r.pulado, 'gseq_nao_configurado');
});

test('runSaidaNota: grava com upsert idempotente', async () => {
  const { pool, poolGseq, sqls } = pools();
  const r = await J.runSaidaNota({ data: '2026-10-15', pool, poolGseq, getSetting: async () => null });
  assert.equal(r.gravadas, 5);
  const ins = sqls.find(s => /INSERT INTO public\.saida_nota/.test(s));
  assert.match(ins, /ON CONFLICT \(note_id\) DO UPDATE SET/);
  assert.doesNotMatch(ins, /DO NOTHING/);
});

test('lerConfig: inválida ou com erro cai no padrão', async () => {
  assert.equal((await J.lerConfig(async () => ({ data: { raioM: 300 } }))).raioM, 300);
  assert.equal((await J.lerConfig(async () => ({ data: { raioM: 1 } }))).raioM, 500);
  assert.equal((await J.lerConfig(async () => { throw new Error('x'); })).raioM, 500);
});

test('valoresDaLinha: JSON serializado, datas em ISO, colunas na ordem', () => {
  const v = Q.valoresDaLinha({
    note_id: id(1), data: '2026-10-15', equipe: 'E', regional: 'GUA', status: 'saiu',
    janela: { inicio: T0, fim: T0 + MIN }, saidas: [{ inicio: T0, fim: T0 + MIN }], regraVersao: 'r',
    veiculosJunto: [],
  });
  assert.equal(v.length, Q.COLUNAS.length);
  assert.equal(v[Q.COLUNAS.indexOf('inicio')], new Date(T0).toISOString());
  assert.equal(typeof v[Q.COLUNAS.indexOf('saidas')], 'string');
  assert.equal(v[Q.COLUNAS.indexOf('trilha')], null);
  assert.equal(v[Q.COLUNAS.indexOf('veiculos_junto')], null);
});

test('frotaNoIntervalo: só a placa sai do nome da unidade (LGPD)', async () => {
  const fake = { query: async () => ({ rows: [
    { vehicle: 'CAMINHAO TTR-8D24 FULANO DE TAL', t: new Date(T0), lat: 1, lon: 2 },
    { vehicle: 'SEM PLACA NENHUMA', t: new Date(T0), lat: 1, lon: 2 },
  ] }) };
  const f = await Q.frotaNoIntervalo(fake, T0 - MIN, T0 + MIN);
  assert.deepStrictEqual([...f.keys()], ['TTR8D24']);
  assert.doesNotMatch(JSON.stringify([...f.values()]), /FULANO/);
});

test('consultas da tela: escopo regional e equipes entram no SQL', async () => {
  let visto;
  const fake = { query: async (sql, params) => { visto = { sql, params }; return { rows: [] }; } };
  await Q.ocorrencias(fake, { de: '2026-10-01', ate: '2026-10-07', regionals: ['GUA'], equipes: ['eccit50'] });
  assert.match(visto.sql, /regional IN \(\$3\)/);
  assert.match(visto.sql, /equipe = ANY\(\$4::text\[\]\)/);
  assert.deepStrictEqual(visto.params, ['2026-10-01', '2026-10-07', 'GUA', ['ECCIT50']]);
  await Q.detalhe(fake, id(1), ['SJC']);
  assert.match(visto.sql, /note_id = \$1::uuid AND regional IN \(\$2\)/);
});

test('gseqPool: sem variável = não configurado; URL do Prisma limpa; sessão só leitura', () => {
  assert.equal(configGseqPool({}), null);
  const c = configGseqPool({ GSEQ_DATABASE_URL: 'postgresql://u:p@localhost:5432/gseq?schema=public' });
  assert.equal(c.connectionString, 'postgresql://u:p@localhost:5432/gseq');
  assert.match(c.options, /default_transaction_read_only=on/);
});

test('backfill: exige período, não aceita hoje nem além da retenção da trilha', () => {
  assert.equal(B.lerArgs(['--de', '2026-10-01', '--ate', '2026-10-18'], '2026-10-19').erros.length, 0);
  assert.equal(B.lerArgs(['--de', '2026-10-01', '--ate', '2026-10-19'], '2026-10-19').erros.length, 1);
  assert.equal(B.lerArgs(['--de', '2026-08-01', '--ate', '2026-08-02'], '2026-10-19').erros.length, 1);
  assert.equal(B.lerArgs([], '2026-10-19').erros.length, 2);
  assert.equal(B.lerArgs(['--de', '2026-10-01', '--ate', '2026-10-02', '--apply'], '2026-10-19').apply, true);
  assert.deepStrictEqual(B.diasEntre('2026-10-30', '2026-11-01'), ['2026-10-30', '2026-10-31', '2026-11-01']);
});
