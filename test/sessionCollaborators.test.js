/**
 * test/sessionCollaborators.test.js
 *
 * P2-14 / P2-28: `Sessions/all/date` devolve `Collaborators` VAZIO, então o
 * caminho ao vivo nunca teve colaborador — e `db/rejectionsQueries.js` faz
 * `unnest` desses arrays para o ranking de rejeições por colaborador, que por
 * isso não tem linhas.
 *
 * Duas armadilhas medidas por outros projetos que consomem a mesma API, e que
 * este normalizador tem que absorver (22/08/2026):
 *
 *  1. `Collaborators` vem ora como LISTA, ora como OBJETO único — varia por
 *     equipe. Vale para teamsstatus/V2 e collaboratorshifts também.
 *  2. `Sessions/{id}/collaborators` responde `Data: null` SEM erro HTTP quando
 *     recebe o id errado. O projeto ES mediu que ele espera o id do SERVIÇO,
 *     não o da sessão, apesar do nome — nossa própria doc afirmava o contrário
 *     sem medição. Por isso usamos `collaborators/{sessionId}/session`, que é a
 *     rota que rodou em produção no projeto SJC por anos, e tratamos `null`
 *     como lista vazia em vez de estourar.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const wpa = require('../services/wpaService');

describe('_normalizeSessionCollaborators — lista, objeto único ou null', () => {
  test('lista simples (rota collaborators/{id}/session)', () => {
    const r = wpa._normalizeSessionCollaborators({
      Data: [
        { Code: '12345', Name: 'JOAO DA SILVA', Cpf: '000', Phone2: '27999' },
        { Code: '67890', Name: 'MARIA SOUZA' },
      ],
    });
    assert.equal(r.length, 2);
    assert.equal(r[0].nome, 'JOAO DA SILVA');
    assert.equal(r[0].matricula, '12345');
    assert.equal(r[1].matricula, '67890');
  });

  test('objeto único em vez de lista → devolve 1 colaborador', () => {
    const r = wpa._normalizeSessionCollaborators({
      Data: { Code: '11111', Name: 'SOZINHO NA SESSAO' },
    });
    assert.equal(r.length, 1);
    assert.equal(r[0].nome, 'SOZINHO NA SESSAO');
    assert.equal(r[0].matricula, '11111');
  });

  test('estrutura aninhada Collaborators[].Collaborator.{Name,Code}', () => {
    const r = wpa._normalizeSessionCollaborators({
      Data: {
        Id: 'sess-1',
        Team: { Name: 'EBGPR62' },
        Collaborators: [
          { SessionId: 'sess-1', Collaborator: { Code: '222', Name: 'ANINHADO UM' } },
          { SessionId: 'sess-1', Collaborator: { Code: '333', Name: 'ANINHADO DOIS' } },
        ],
      },
    });
    assert.equal(r.length, 2);
    assert.equal(r[0].nome, 'ANINHADO UM');
    assert.equal(r[1].matricula, '333');
  });

  test('Collaborators como OBJETO único dentro de Data', () => {
    const r = wpa._normalizeSessionCollaborators({
      Data: { Collaborators: { Collaborator: { Code: '444', Name: 'DICT UNICO' } } },
    });
    assert.equal(r.length, 1);
    assert.equal(r[0].matricula, '444');
  });

  test('Data: null (id errado) → [] em vez de estourar', () => {
    assert.deepEqual(wpa._normalizeSessionCollaborators({ Data: null }), []);
  });

  test('payload vazio / undefined → []', () => {
    assert.deepEqual(wpa._normalizeSessionCollaborators({}), []);
    assert.deepEqual(wpa._normalizeSessionCollaborators(null), []);
    assert.deepEqual(wpa._normalizeSessionCollaborators({ Data: [] }), []);
  });

  test('descarta entrada sem nome E sem matrícula (linha inútil)', () => {
    const r = wpa._normalizeSessionCollaborators({
      Data: [{ Code: '555', Name: 'VALIDO' }, {}, { Collaborator: {} }],
    });
    assert.equal(r.length, 1, 'só o válido sobra');
    assert.equal(r[0].matricula, '555');
  });
});

// ── a fonte de graça: teamsstatus/V2 já traz Session.Collaborators ───────────
// Os três projetos externos mapeiam `Session.Collaborators[].Name/.Code` do V2 —
// payload que NÓS JÁ BAIXAMOS e descartávamos. Por isso o fetch extra por sessão
// só é necessário quando não há item V2 (sessão encerrada), e não para as ~83
// equipes ativas de todo ciclo.
describe('_normalizeSessionCollaborators — shape do teamsstatus/V2', () => {
  test('Data.Collaborators com Name/Code planos (V2)', () => {
    const r = wpa._normalizeSessionCollaborators({
      Data: { Id: 'sess-9', Collaborators: [{ Name: 'PLANO UM', Code: '901' }, { Name: 'PLANO DOIS', Code: '902' }] },
    });
    assert.equal(r.length, 2);
    assert.equal(r[0].nome, 'PLANO UM');
    assert.equal(r[1].matricula, '902');
  });

  test('V2 sem Collaborators → [] (cai pro fetch por sessão)', () => {
    assert.deepEqual(wpa._normalizeSessionCollaborators({ Data: { Id: 'sess-9', Collaborators: [] } }), []);
  });
});

// ── invariante em que o call site do fluxo ao vivo se apoia ──────────────────
// O caminho ao vivo embrulha sempre em { Collaborators } explícito, justamente
// pra não passar o objeto de SESSÃO cru (que tem Id/BeginTime/Team/Vehicle) e
// acabar tratando a sessão como se fosse um colaborador. Estes dois casos pinam
// o que acontece quando o campo simplesmente não existe.
describe('_normalizeSessionCollaborators — sem Collaborators não inventa gente', () => {
  test('{ Collaborators: undefined } → []', () => {
    assert.deepEqual(wpa._normalizeSessionCollaborators({ Data: { Collaborators: undefined } }), []);
  });

  test('objeto sem nome e sem matrícula → []', () => {
    assert.deepEqual(
      wpa._normalizeSessionCollaborators({ Data: { Id: 'sess-1', BeginTime: '2026-08-22T07:00:00' } }),
      []
    );
  });
});
