/**
 * test/alertaProdutividade.ciclo.test.js
 *
 * `avaliarCiclo` de ponta a ponta com dependências FALSAS — sem banco, sem WPA.
 * É a resposta ao P2-39 (funções de cron invisíveis à suíte): o orquestrador é
 * 100% injetável, então tudo o que ele faz é exercitado aqui.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { avaliarCiclo, MAX_CONSULTAS_REFEICAO } = require('../services/alertaProdutividade');

// 14/10/2026 13:00 BRT = 16:00Z (BRT = UTC-3). Meio do turno 08–17 = 12:30.
const AGORA = new Date('2026-10-14T16:00:00Z');
const DATA = '2026-10-14';
const CFG = { ativo: true, limite: 4, categorias: ['COMERCIAL', 'PLANTAO', 'MOTO', 'BT_ZERO'], tolerancia_refeicao_min: 60 };

const equipe = (nome, o = {}) => ({
  teamName: nome, sigla: nome, sectorId: 'DESG', regional: 'GUA', id: `sess-${nome}`,
  sessionBegin: `${DATA}T08:00:00.00`, sessionEnd: null, notasRejeitadas: [], ...o,
});

function montar(o = {}) {
  const gravado = { abrir: [], atualizar: [], resolver: [] };
  const consultasRefeicao = [];
  const logs = { info: [], warn: [], error: [] };
  const metas = o.metas || {};
  const deps = {
    agora: () => AGORA,
    teams: o.teams || [],
    sessionDate: (t) => (t.sessionBegin ? String(t.sessionBegin).slice(0, 10) : null),
    lerConfig: async () => (o.config === undefined ? CFG : o.config),
    getMeta: (sigla) => (sigla in metas ? metas[sigla] : { sigla, regional: 'GUA', escala_inicio: '08:00:00', escala_fim: '17:00:00' }),
    estadoDoDia: async () => o.estado || [],
    executadasPorEquipe: async () => o.executadas || {},
    historicoSupervisores: async () => o.sup || { historico: [], nomes: {} },
    lerRefeicao: async (sid) => {
      consultasRefeicao.push(sid);
      if (o.refeicaoFalha) throw new Error('WPA 502');
      return (o.refeicao && o.refeicao[sid]) || [];
    },
    gravar: {
      abrir: async (l) => { gravado.abrir.push(l); return !(o.jaExiste || []).includes(l.team_name); },
      atualizar: async (d, t, c) => { gravado.atualizar.push({ d, t, ...c }); },
      resolver: async (d, t, c) => { gravado.resolver.push({ d, t, ...c }); },
    },
    log: {
      info: (e, m) => logs.info.push([e, m]),
      warn: (e, m) => logs.warn.push([e, m]),
      error: (e, m) => logs.error.push([e, m]),
    },
  };
  return { deps, gravado, consultasRefeicao, logs };
}

describe('avaliarCiclo — liga/desliga', () => {
  test('desligado: ZERO chamadas a qualquer dependência de dados', async () => {
    const m = montar({ teams: [equipe('ECGPR53')], config: { ativo: false } });
    let tocou = false;
    for (const k of ['estadoDoDia', 'executadasPorEquipe', 'historicoSupervisores', 'lerRefeicao']) {
      m.deps[k] = async () => { tocou = true; return {}; };
    }
    const r = await avaliarCiclo(m.deps);
    assert.equal(r.ativo, false);
    assert.equal(tocou, false);
    assert.deepEqual(m.gravado.abrir, []);
  });
  test('config ausente ou inválida → desligado, sem gravar', async () => {
    for (const config of [undefined, null, { limite: 0 }, 'lixo']) {
      const m = montar({ teams: [equipe('ECGPR53')], config: config === undefined ? null : config });
      const r = await avaliarCiclo(m.deps);
      assert.equal(r.ativo, false, JSON.stringify(config));
      assert.equal(m.gravado.abrir.length, 0);
    }
  });
  test('erro ao ler a config → desligado e registra, sem estourar', async () => {
    const m = montar({ teams: [equipe('ECGPR53')] });
    m.deps.lerConfig = async () => { throw new Error('banco fora'); };
    const r = await avaliarCiclo(m.deps);
    assert.equal(r.ativo, false);
    assert.equal(m.logs.warn.length, 1);
  });
});

describe('avaliarCiclo — abrir', () => {
  test('equipe abaixo do limite depois do meio do turno → abre com todos os campos', async () => {
    const m = montar({
      teams: [equipe('ECGPR53', { notasRejeitadas: [{ id: 'a' }, { id: 'b' }] })],
      executadas: { ECGPR53: 2 },
      sup: { historico: [{ sigla: 'ECGPR53', desde: '2026-10-01', supervisor_id: 3 }], nomes: { 3: 'JOAO SILVA' } },
    });
    const r = await avaliarCiclo(m.deps);
    assert.equal(r.abertos, 1);
    assert.equal(m.gravado.abrir.length, 1);
    const l = m.gravado.abrir[0];
    assert.equal(l.data, DATA);
    assert.equal(l.team_name, 'ECGPR53');
    assert.equal(l.regional, 'GUA');
    assert.equal(l.sector_id, 'DESG');
    assert.equal(l.supervisor, 'JOAO SILVA');
    assert.equal(l.limite, 4);
    assert.equal(l.executadas, 2);
    assert.equal(l.rejeitadas, 2);
    assert.equal(l.escala_inicio, '08:00');
    assert.equal(l.escala_fim, '17:00');
    assert.equal(l.meio_turno_em, '2026-10-14T15:30:00.000Z');   // 12:30 BRT
    assert.equal(l.disparado_em, AGORA.toISOString());
  });
  test('supervisor sem vínculo → null (não inventa)', async () => {
    const m = montar({ teams: [equipe('ECGPR53')], executadas: { ECGPR53: 0 } });
    await avaliarCiclo(m.deps);
    assert.equal(m.gravado.abrir[0].supervisor, null);
  });
  test('equipe sem linha em team_daily_totals conta como 0 executadas', async () => {
    const m = montar({ teams: [equipe('ECGPR53')], executadas: {} });
    await avaliarCiclo(m.deps);
    assert.equal(m.gravado.abrir[0].executadas, 0);
  });
  test('acima do limite não abre', async () => {
    const m = montar({ teams: [equipe('ECGPR53')], executadas: { ECGPR53: 4 } });
    const r = await avaliarCiclo(m.deps);
    assert.equal(r.abertos, 0);
  });
  test('rejeitadas = união por id entre as sessões do dia (sem dupla contagem)', async () => {
    const m = montar({
      teams: [
        equipe('ECGPR53', { id: 's1', sessionEnd: '2026-10-14T10:00:00', notasRejeitadas: [{ id: 'a' }, { id: 'b' }] }),
        equipe('ECGPR53', { id: 's2', notasRejeitadas: [{ id: 'b' }, { id: 'c' }] }),
      ],
      executadas: { ECGPR53: 1 },
    });
    await avaliarCiclo(m.deps);
    assert.equal(m.gravado.abrir[0].rejeitadas, 3);
  });
});

describe('avaliarCiclo — quem NÃO alerta', () => {
  test('equipe fora da whitelist (getMeta nulo) é pulada', async () => {
    const m = montar({ teams: [equipe('ECXXX99')], metas: { ECXXX99: null }, executadas: { ECXXX99: 0 } });
    const r = await avaliarCiclo(m.deps);
    assert.equal(r.abertos, 0);
  });
  test('sessão de OUTRO dia não conta como "logada hoje"', async () => {
    const m = montar({ teams: [equipe('ECGPR53', { sessionBegin: '2026-10-13T08:00:00.00' })], executadas: { ECGPR53: 0 } });
    assert.equal((await avaliarCiclo(m.deps)).abertos, 0);
  });
  test('sessão encerrada não alerta', async () => {
    const m = montar({ teams: [equipe('ECGPR53', { sessionEnd: '2026-10-14T12:00:00' })], executadas: { ECGPR53: 0 } });
    assert.equal((await avaliarCiclo(m.deps)).abertos, 0);
  });
  test('categoria fora da config (Operacional) não alerta', async () => {
    const m = montar({ teams: [equipe('OPXYZ01')], executadas: { OPXYZ01: 0 } });
    assert.equal((await avaliarCiclo(m.deps)).abertos, 0);
  });
  test('antes do meio do turno não alerta', async () => {
    const m = montar({ teams: [equipe('ECGPR53')], executadas: { ECGPR53: 0 } });
    m.deps.agora = () => new Date('2026-10-14T15:00:00Z');   // 12:00 BRT
    assert.equal((await avaliarCiclo(m.deps)).abertos, 0);
  });
  test('sem escala e vira-noite são IGNORADAS e devolvidas à parte (pro backtest/log)', async () => {
    const m = montar({
      teams: [equipe('ECGPR53'), equipe('ECGPR54')],
      metas: {
        ECGPR53: { sigla: 'ECGPR53', regional: 'GUA', escala_inicio: null, escala_fim: null },
        ECGPR54: { sigla: 'ECGPR54', regional: 'GUA', escala_inicio: '22:00:00', escala_fim: '07:00:00' },
      },
      executadas: { ECGPR53: 0, ECGPR54: 0 },
    });
    const r = await avaliarCiclo(m.deps);
    assert.equal(r.abertos, 0);
    assert.deepEqual(r.ignoradas.sem_escala, ['ECGPR53']);
    assert.deepEqual(r.ignoradas.vira_noite, ['ECGPR54']);
  });
});

describe('avaliarCiclo — refeição', () => {
  test('em refeição, dentro da tolerância → NÃO abre (adia)', async () => {
    const m = montar({
      teams: [equipe('ECGPR53')], executadas: { ECGPR53: 1 },
      refeicao: { 'sess-ECGPR53': [{ motivo: '15 - Horário de Refeição', emAberto: true }] },
    });
    const r = await avaliarCiclo(m.deps);
    assert.equal(r.abertos, 0);
    assert.equal(r.adiadas, 1);
  });
  test('consulta de refeição FALHOU → não alerta (nunca alerta sem a informação)', async () => {
    const m = montar({ teams: [equipe('ECGPR53')], executadas: { ECGPR53: 1 }, refeicaoFalha: true });
    const r = await avaliarCiclo(m.deps);
    assert.equal(r.abertos, 0);
    assert.equal(r.adiadas, 1);
    assert.equal(r.errosRefeicao, 1);
  });
  test('só consulta refeição de quem JÁ alertaria (candidata), nunca das demais', async () => {
    const m = montar({
      teams: [equipe('A1'), equipe('A2'), equipe('A3')],
      metas: {},
      executadas: { A1: 9, A2: 9, A3: 0 },   // só A3 está abaixo do limite
    });
    m.deps.getMeta = (s) => ({ sigla: s, regional: 'GUA', escala_inicio: '08:00', escala_fim: '17:00' });
    // siglas A1.. não casam prefixo de categoria → usar prefixos reais
    m.deps.teams = [equipe('ECGPR01'), equipe('ECGPR02'), equipe('ECGPR03')];
    m.deps.executadasPorEquipe = async () => ({ ECGPR01: 9, ECGPR02: 9, ECGPR03: 0 });
    await avaliarCiclo(m.deps);
    assert.deepEqual(m.consultasRefeicao, ['sess-ECGPR03']);
  });
  test(`teto de ${MAX_CONSULTAS_REFEICAO} consultas por ciclo; o resto adia sem consultar`, async () => {
    const nomes = Array.from({ length: 12 }, (_, i) => `ECGPR${String(i + 10)}`);
    const m = montar({ teams: nomes.map(n => equipe(n)) });
    m.deps.executadasPorEquipe = async () => Object.fromEntries(nomes.map(n => [n, 0]));
    const r = await avaliarCiclo(m.deps);
    assert.equal(MAX_CONSULTAS_REFEICAO, 8);
    assert.equal(m.consultasRefeicao.length, 8);
    assert.equal(r.abertos, 8);
    assert.equal(r.adiadas, 4);
  });
  test('aberto/resolvido NÃO consultam refeição', async () => {
    const m = montar({
      teams: [equipe('ECGPR53'), equipe('ECGPR54')],
      executadas: { ECGPR53: 1, ECGPR54: 9 },
      estado: [{ team_name: 'ECGPR53', resolvido: false }, { team_name: 'ECGPR54', resolvido: false }],
    });
    await avaliarCiclo(m.deps);
    assert.equal(m.consultasRefeicao.length, 0);
  });
});

describe('avaliarCiclo — ciclo de vida', () => {
  test('aberto e ainda abaixo → atualiza os números, não reabre', async () => {
    const m = montar({
      teams: [equipe('ECGPR53', { notasRejeitadas: [{ id: 'a' }] })], executadas: { ECGPR53: 3 },
      estado: [{ team_name: 'ECGPR53', resolvido: false }],
    });
    const r = await avaliarCiclo(m.deps);
    assert.equal(r.mantidos, 1);
    assert.equal(m.gravado.abrir.length, 0);
    assert.deepEqual(m.gravado.atualizar, [{ d: DATA, t: 'ECGPR53', executadas: 3, rejeitadas: 1 }]);
  });
  test('aberto e chegou ao limite → resolve com o instante do ciclo', async () => {
    const m = montar({
      teams: [equipe('ECGPR53')], executadas: { ECGPR53: 4 },
      estado: [{ team_name: 'ECGPR53', resolvido: false }],
    });
    const r = await avaliarCiclo(m.deps);
    assert.equal(r.resolvidos, 1);
    assert.equal(m.gravado.resolver[0].quando, AGORA.toISOString());
    assert.equal(m.gravado.resolver[0].executadas, 4);
  });
  test('resolvido NUNCA reabre, mesmo com executadas caindo', async () => {
    const m = montar({
      teams: [equipe('ECGPR53')], executadas: { ECGPR53: 0 },
      estado: [{ team_name: 'ECGPR53', resolvido: true }],
    });
    const r = await avaliarCiclo(m.deps);
    assert.equal(r.abertos, 0);
    assert.equal(m.gravado.abrir.length, 0);
  });
  test('IDEMPOTENTE: o 2º ciclo, com o alerta já aberto, não abre de novo', async () => {
    const m = montar({ teams: [equipe('ECGPR53')], executadas: { ECGPR53: 1 } });
    const r1 = await avaliarCiclo(m.deps);
    assert.equal(r1.abertos, 1);
    // 2º ciclo: o banco agora devolve o alerta como aberto
    m.deps.estadoDoDia = async () => [{ team_name: 'ECGPR53', resolvido: false }];
    const r2 = await avaliarCiclo(m.deps);
    assert.equal(r2.abertos, 0);
    assert.equal(m.gravado.abrir.length, 1);
    assert.equal(m.gravado.atualizar.length, 1);
  });
  test('corrida: abrir devolve false (já existia) → não conta como aberto', async () => {
    const m = montar({ teams: [equipe('ECGPR53')], executadas: { ECGPR53: 1 }, jaExiste: ['ECGPR53'] });
    const r = await avaliarCiclo(m.deps);
    assert.equal(r.abertos, 0);
  });
});

describe('avaliarCiclo — robustez', () => {
  test('falha numa equipe NÃO derruba as outras', async () => {
    const m = montar({ teams: [equipe('ECGPR53'), equipe('ECGPR54')], executadas: { ECGPR53: 0, ECGPR54: 0 } });
    let n = 0;
    const abrirOriginal = m.deps.gravar.abrir;
    m.deps.gravar.abrir = async (l) => { if (n++ === 0) throw new Error('banco'); return abrirOriginal(l); };
    const r = await avaliarCiclo(m.deps);
    assert.equal(r.abertos, 1);
    assert.equal(r.erros, 1);
    assert.equal(m.logs.warn.length >= 1, true);
  });
  test('falha ao ler os totais do dia → não grava nada e registra (nunca fabrica número)', async () => {
    const m = montar({ teams: [equipe('ECGPR53')] });
    m.deps.executadasPorEquipe = async () => { throw new Error('banco fora'); };
    const r = await avaliarCiclo(m.deps);
    assert.equal(r.ativo, true);
    assert.equal(r.erro, 'banco fora');
    assert.equal(m.gravado.abrir.length, 0);
  });
  test('sem equipes → resumo zerado, sem erro', async () => {
    const m = montar({ teams: [] });
    const r = await avaliarCiclo(m.deps);
    assert.equal(r.abertos, 0);
    assert.equal(r.avaliadas, 0);
  });
  test('o instante do ciclo (agora) é lido UMA vez: tudo do ciclo usa o mesmo relógio', async () => {
    const m = montar({ teams: [equipe('ECGPR53')], executadas: { ECGPR53: 1 } });
    let leituras = 0;
    m.deps.agora = () => { leituras++; return AGORA; };
    await avaliarCiclo(m.deps);
    assert.equal(leituras, 1);
  });
});
