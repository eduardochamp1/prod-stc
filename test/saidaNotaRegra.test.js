'use strict';

// Regra completa da aba "Saída da nota" (P2-70) — classificarNota,
// agruparOcorrencias e a config. SPEC-saida-da-nota-2026-10-18.md §3–§4.

const test   = require('node:test');
const assert = require('node:assert');
const S      = require('../services/saidaNota');

const MIN = 60000;
const T0 = Date.parse('2026-10-15T13:00:00Z');              // 10:00 BRT
const NOTA = { lat: -20.3155, lon: -40.3128 };
const LONGE = { lat: -20.3055, lon: -40.3128 };             // ~1,1 km
const RJ = { lat: -22.45, lon: -43.65 };                    // ~350 km
const janela = { inicio: T0, fim: T0 + 90 * MIN, cpInicio: NOTA };
const pt = (m, c, ign) => ({ t: T0 + m * MIN, lat: c.lat, lon: c.lon, ign: ign === true });
const baldesVivos = () => {
  const s = new Set();
  for (let b = Math.floor((T0 - 7 * 3600000) / 300000); b <= Math.floor((T0 + 3 * 3600000) / 300000); b++) s.add(b);
  return s;
};
const base = (extra) => ({
  janela, cadastro: NOTA, placa: 'ABC1D23', pontos: [pt(-10, NOTA)],
  baldesFrota: baldesVivos(), intervalos: [], equipe: 'ECCIT50', tipo: 'SF', ...extra,
});

test('config: padrão da SPEC, override válido e erro explícito', () => {
  const p = S.validarConfig(null);
  assert.equal(p.ok, true);
  assert.deepStrictEqual([p.config.raioM, p.config.minForaMin, p.config.limiteVeiculoM, p.config.maxBuracoFrotaMin],
    [500, 15, 5000, 20]);
  assert.deepStrictEqual(p.config.patrulha, [['EP', 'PO'], ['*', 'OS']]);
  const o = S.validarConfig({ raioM: 300, patrulha: [['ep', 'po']] });
  assert.equal(o.config.raioM, 300);
  assert.deepStrictEqual(o.config.patrulha, [['EP', 'PO']]);
  assert.equal(S.validarConfig({ raioM: 10 }).ok, false);
  assert.equal(S.validarConfig({ patrulha: 'EP:PO' }).ok, false);
  // a mutação da cópia não vaza para o padrão
  p.config.patrulha.push(['X', 'Y']);
  assert.equal(S.CONFIG_PADRAO.patrulha.length, 2);
});

test('regraVersao descreve os parâmetros usados', () => {
  assert.equal(S.regraVersao(S.CONFIG_PADRAO), 'r500-m15-v5000-f20-pEP:PO,*:OS');
});

test('classificar: ficou no local → ok', () => {
  const r = S.classificarNota(base());
  assert.equal(r.status, 'ok');
  assert.equal(r.trilha[0].t, T0);                          // posição herdada no início
});

test('classificar: sem janela / sem coordenada / sem placa / sem trilha', () => {
  assert.equal(S.classificarNota(base({ janela: { motivo: 'sem_fim' } })).status, 'sem_janela');
  assert.equal(S.classificarNota(base({ janela: null })).motivo, 'sem_detalhe');
  assert.equal(S.classificarNota(base({ cadastro: null, janela: { ...janela, cpInicio: null } })).motivo, 'sem_coordenada');
  assert.equal(S.classificarNota(base({ placa: null })).status, 'sem_placa');
  assert.equal(S.classificarNota(base({ pontos: [] })).status, 'sem_trilha');
});

test('classificar: frota calada na execução → rastreador_fora, não ok', () => {
  const r = S.classificarNota(base({ baldesFrota: new Set() }));
  assert.equal(r.status, 'rastreador_fora');
});

test('classificar: veículo do cadastro longe do tablet → veiculo_divergente', () => {
  const r = S.classificarNota(base({ pontos: [pt(-10, RJ), pt(40, RJ)] }));
  assert.equal(r.status, 'veiculo_divergente');
  assert.ok(r.dVeiculoTabletM > 300000);
});

test('classificar: EP em PO e qualquer equipe em OS → patrulha', () => {
  const saiu = [pt(-10, NOTA), pt(20, LONGE), pt(40, LONGE), pt(60, NOTA)];
  assert.equal(S.classificarNota(base({ pontos: saiu, equipe: 'EPMFL30', tipo: 'PO' })).status, 'patrulha');
  assert.equal(S.classificarNota(base({ pontos: saiu, equipe: 'ECCSJ84', tipo: 'OS' })).status, 'patrulha');
  assert.equal(S.classificarNota(base({ pontos: saiu, equipe: 'ECCSJ84', tipo: 'MD' })).status, 'saiu');
});

test('classificar: veículo longe no início — tablet longe = longe_do_local; tablet perto = fora_no_inicio', () => {
  const pontos = [pt(-10, LONGE), pt(80, LONGE)];
  const tabletLonge = { ...janela, cpInicio: LONGE };
  assert.equal(S.classificarNota(base({ pontos, janela: tabletLonge })).status, 'longe_do_local');
  assert.equal(S.classificarNota(base({ pontos })).status, 'fora_no_inicio');
});

test('classificar: saída de 40 min → saiu; com almoço apontado cobrindo → saiu_em_intervalo', () => {
  const pontos = [pt(-10, NOTA), pt(20, LONGE), pt(40, LONGE), pt(60, NOTA)];
  const r = S.classificarNota(base({ pontos }));
  assert.equal(r.status, 'saiu');
  assert.equal(r.minFora, 40);
  assert.equal(r.saidas.length, 1);
  const almoco = [{ ini: T0 + 15 * MIN, fim: T0 + 65 * MIN }];
  const p = S.classificarNota(base({ pontos, intervalos: almoco }));
  assert.equal(p.status, 'saiu_em_intervalo');
  assert.equal(p.pausaDescontadaMin, 40);
  const parcial = S.classificarNota(base({ pontos, intervalos: [{ ini: T0 + 25 * MIN, fim: T0 + 35 * MIN }] }));
  assert.equal(parcial.status, 'saiu');
  assert.equal(parcial.minFora, 30);
});

test('classificar: precedência — sem placa vence tudo o que depende da trilha', () => {
  const r = S.classificarNota(base({ placa: null, pontos: [pt(-10, RJ)], baldesFrota: new Set() }));
  assert.equal(r.status, 'sem_placa');
});

test('agruparOcorrencias: janelas sobrepostas da mesma equipe viram uma ocorrência', () => {
  const l = [
    { equipe: 'EPPIU31', janela: { inicio: T0, fim: T0 + 70 * MIN } },
    { equipe: 'EPPIU31', janela: { inicio: T0 + 5 * MIN, fim: T0 + 60 * MIN } },
    { equipe: 'EPPIU31', janela: { inicio: T0 + 120 * MIN, fim: T0 + 150 * MIN } },
    { equipe: 'ECCIT50', janela: { inicio: T0, fim: T0 + 70 * MIN } },
    { equipe: 'ECCIT50', janela: { motivo: 'sem_fim' } },
  ];
  S.agruparOcorrencias(l);
  assert.equal(l[0].ocorrenciaId, l[1].ocorrenciaId);
  assert.notEqual(l[0].ocorrenciaId, l[2].ocorrenciaId);
  assert.notEqual(l[0].ocorrenciaId, l[3].ocorrenciaId);           // outra equipe, mesmo horário
  assert.equal(l[4].ocorrenciaId, undefined);
  assert.match(l[0].ocorrenciaId, /^EPPIU31\|2026-10-15T13:00:00\.000Z$/);
});

test('placaCadastradaNaData diz a fonte', () => {
  const al = [
    { sigla: 'EQ1', placa: 'AAA-1A11', tipo: 'VIGENCIA', desde: '2026-10-01', ate: null },
    { sigla: 'EQ1', placa: 'CCC-3C33', tipo: 'DIA', desde: '2026-10-15', ate: '2026-10-15' },
  ];
  assert.deepStrictEqual(S.placaCadastradaNaData(al, 'EQ1', '2026-10-14'), { placa: 'AAA-1A11', fonte: 'gseq-vigencia' });
  assert.deepStrictEqual(S.placaCadastradaNaData(al, 'EQ1', '2026-10-15'), { placa: 'CCC-3C33', fonte: 'gseq-dia' });
  assert.equal(S.placaCadastradaNaData(al, 'EQ9', '2026-10-15'), null);
});
