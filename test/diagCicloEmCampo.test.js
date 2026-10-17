/**
 * test/diagCicloEmCampo.test.js
 *
 * scripts/diag-ciclo-em-campo.js explica por que o "em campo" cai ~40 equipes
 * por UM ciclo de snapshot e volta no seguinte (16/10/2026). Cada causa tem uma
 * assinatura no snapshot; o diag só serve se ler a assinatura certa — senão
 * manda a correção pro lugar errado (coleta × V2 × EDP).
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  v2DaLinha, estadosDoCiclo, resumoPorSetor, atrasoDoCiclo, explicarQueda, quedasPontuais, setoresAusentes,
} = require('../scripts/diag-ciclo-em-campo');
const { unirSessoes } = require('../scripts/diag-escala-a-mais');

const L = (over) => ({
  sector_id: 'DESG', team_name: 'ECGPR82', session_begin: '2026-10-15T07:00', session_end: null,
  is_online: 'true', v2_presente: 'true', last_update: '2026-10-15T11:00:00', ...over,
});
const ciclo = (linhas) => {
  const estados = estadosDoCiclo(linhas);
  return { estados, porSetor: resumoPorSetor(linhas, estados) };
};

test('v2DaLinha: usa v2Presente; antes de 15/10 infere por lastUpdate', () => {
  assert.deepEqual(v2DaLinha({ v2_presente: 'false', last_update: 'x' }), { v2: false, inferido: false });
  assert.deepEqual(v2DaLinha({ v2_presente: 'true' }), { v2: true, inferido: false });
  assert.deepEqual(v2DaLinha({ v2_presente: null, last_update: '2026-10-14T10:00' }), { v2: true, inferido: true });
  assert.deepEqual(v2DaLinha({ v2_presente: null, last_update: null }), { v2: false, inferido: true });
});

test('estadosDoCiclo: "em campo" é o mesmo de unirSessoes (regra do front)', () => {
  const linhas = [
    L({ team_name: 'A', session_end: '2026-10-15T09:00', is_online: 'false' }),
    L({ team_name: 'a ', session_begin: '2026-10-15T09:05' }),                  // relogin
    L({ team_name: 'B', is_online: 'false' }),                                  // offline no V2
    L({ team_name: 'C', is_online: 'false', v2_presente: 'false' }),            // sem V2
    L({ team_name: 'D', session_end: '2026-10-15T10:00' }),                     // encerrada
  ];
  const e = estadosDoCiclo(linhas);
  const u = unirSessoes(linhas, '2026-10-15');
  for (const [k, v] of e) assert.equal(v.emCampo, u.get(k).emCampo, k);
  assert.equal(e.get('A').estado, 'em-campo');
  assert.equal(e.get('B').estado, 'offline-no-v2');
  assert.equal(e.get('C').estado, 'sem-v2');
  assert.equal(e.get('D').estado, 'encerrada');
});

test('resumoPorSetor: conta sessões e equipes por setor da base', () => {
  const linhas = [L({ team_name: 'A' }), L({ team_name: 'B', sector_id: 'DSSJ', is_online: 'false', v2_presente: 'false' })];
  const r = resumoPorSetor(linhas, estadosDoCiclo(linhas));
  assert.deepEqual(r.DESG, { linhas: 1, equipes: 1, abertas: 1, emCampo: 1, semV2: 0, offlineV2: 0, encerradas: 0 });
  assert.equal(r.DSSJ.semV2, 1);
});

test('explicarQueda: setor inteiro ausente → setor-ausente', () => {
  const cheio = ciclo([L({ team_name: 'A' }), L({ team_name: 'S1', sector_id: 'DSSJ' }), L({ team_name: 'S2', sector_id: 'DSSJ' })]);
  const semSJ = ciclo([L({ team_name: 'A' })]);
  const e = explicarQueda(cheio, semSJ, cheio);
  assert.equal(e.piscaram.length, 2);
  assert.deepEqual(e.porSetorCausa, { 'DSSJ setor-ausente': 2 });
  assert.match(e.veredito, /coleta do setor falhou/);
});

test('explicarQueda: setor gravou sem a equipe → equipe-ausente', () => {
  const cheio = ciclo([L({ team_name: 'A' }), L({ team_name: 'B' })]);
  const e = explicarQueda(cheio, ciclo([L({ team_name: 'A' })]), cheio);
  assert.deepEqual(e.porCausa, { 'equipe-ausente': 1 });
});

test('explicarQueda: V2 sem a equipe × IsOnline caindo × sessão encerrada', () => {
  const cheio = ciclo([L({ team_name: 'A' }), L({ team_name: 'B' }), L({ team_name: 'C' })]);
  const queda = ciclo([
    L({ team_name: 'A', is_online: 'false', v2_presente: 'false' }),
    L({ team_name: 'B', is_online: 'false' }),
    L({ team_name: 'C', session_end: '2026-10-15T11:00' }),
  ]);
  const e = explicarQueda(cheio, queda, cheio);
  assert.deepEqual(e.porCausa, { 'sem-v2': 1, 'offline-no-v2': 1, encerrada: 1 });
});

test('explicarQueda: quem não volta no ciclo seguinte não "piscou"', () => {
  const antes = ciclo([L({ team_name: 'A' }), L({ team_name: 'B' })]);
  const e = explicarQueda(antes, ciclo([L({ team_name: 'A' })]), ciclo([L({ team_name: 'A' })]));
  assert.equal(e.piscaram.length, 0);
  assert.match(e.veredito, /nenhuma equipe piscou/);
});

test('quedasPontuais: só a queda que volta, medida contra o menor vizinho', () => {
  assert.deepEqual(quedasPontuais([104, 70, 103, 100], 15), [1]);
  assert.deepEqual(quedasPontuais([104, 70, 72, 71], 15), []);        // não voltou
  assert.deepEqual(quedasPontuais([104, 95, 103], 15), []);           // abaixo do limiar
});

test('setoresAusentes: pega setor diferente fora em ciclos seguidos, não a virada do dia', () => {
  // 15/10 10:49 DEPT, 11:06 DESG, 11:18 DESC: nenhuma queda "pontual", três falhas.
  const todos = ciclo([L({ team_name: 'A' }), L({ team_name: 'B', sector_id: 'DESC' }), L({ team_name: 'C', sector_id: 'DEPT' })]);
  const semDESG = ciclo([L({ team_name: 'B', sector_id: 'DESC' }), L({ team_name: 'C', sector_id: 'DEPT' })]);
  const semDESC = ciclo([L({ team_name: 'A' }), L({ team_name: 'C', sector_id: 'DEPT' })]);
  assert.deepEqual(setoresAusentes(todos, semDESG, true), ['DESG']);
  assert.deepEqual(setoresAusentes(semDESG, semDESC, true), ['DESC']);   // DESG voltou, DESC caiu
  assert.deepEqual(setoresAusentes(todos, semDESG, false), []);          // outro dia: sessions/date é outra
});

test('atrasoDoCiclo: minutos desde a vaga do cron', () => {
  assert.equal(atrasoDoCiclo('2026-10-15T14:06:00Z'), 6);
  assert.equal(atrasoDoCiclo('2026-10-15T14:47:30Z'), 2.5);
});
