/**
 * test/interrupcoes.test.js
 *
 * Coluna INTERR do grupo MD na matriz "Notas Atendidas por Tipo" (pedido do
 * José, 07/10/2026): interrupções de MD Subs Obsoleto/TL11, no dia e na equipe
 * que interrompeu, FORA da SOMA e do %REJ. Ver services/interrupcaoService.js.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

const svc = require('../services/interrupcaoService');
const { _buildEquipeTipoMatrix, _filtrarInterrupcoesPorSubcat } = require('../db/queries');
const { _normalizarNotaV2 } = require('../services/wpaService');

const nota = (id, tipoCode, executionStatus) => ({ id, codigo: 'N' + id, tipoCode, executionStatus });

describe('normalizarNotaV2 guarda o ExecutionStatus cru', () => {
  test('3 continua status executada, mas o código cru fica disponível', () => {
    const n = _normalizarNotaV2({ Id: 'u', Number: '105293301', Type: 'PO', ExecutionStatus: 3 });
    assert.equal(n.status, 'executada');      // classificação NÃO mudou
    assert.equal(n.executionStatus, 3);
  });
  test('sem ExecutionStatus → null', () => {
    assert.equal(_normalizarNotaV2({ Id: 'u', Type: 'MD' }).executionStatus, null);
  });
});

describe('selecionarCandidatas — gatilho por ExecutionStatus 3', () => {
  const teams = [{
    sectorId: 'DESG', regional: 'GUA',
    notasBaixadas:   [nota('a', 'MD', 1)],
    notasExecutadas: [nota('b', 'MD', 3), nota('c', 'MD', 6), nota('d', 'PO', 3)],
  }];

  test('só MD em 3 vira candidata (PO em 3 e MD em 1/6 não)', () => {
    const { candidatas, atual } = svc.selecionarCandidatas(teams, new Map());
    assert.deepEqual(candidatas.map(c => c.note_id), ['b']);
    assert.equal(atual.get('a'), 1);
    assert.equal(atual.get('c'), 6);
    assert.equal(atual.has('d'), false);
  });

  test('MD que JÁ estava em 3 no ciclo anterior não gasta outro GET', () => {
    const { candidatas } = svc.selecionarCandidatas(teams, new Map([['b', 3]]));
    assert.deepEqual(candidatas, []);
  });

  test('MD que saiu de 3 e voltou (nova interrupção) é buscada de novo', () => {
    const { candidatas } = svc.selecionarCandidatas(teams, new Map([['b', 6]]));
    assert.deepEqual(candidatas.map(c => c.note_id), ['b']);
  });
});

describe('montarLinhas', () => {
  const cand = { note_id: 'n1', numero: '045006463152', tipo: 'MD', sector_id: 'DESG', regional: 'GUA' };

  test('nota interrompida 2x em dias diferentes → 2 linhas, cada uma no seu dia', () => {
    // Print do portal, 07/10/2026: ECGPR82 interrompeu em 28/09 e em 07/10.
    const linhas = svc.montarLinhas(cand, [
      { id: 'i1', equipe: 'ECGPR82', dia: '2026-09-28', instante: '2026-09-28T12:59:00-03:00', motivo: 'SUSPENSO PARA OUTROS SERVIÇOS' },
      { id: 'i2', equipe: 'ECGPR82', dia: '2026-10-07', instante: '2026-10-07T11:21:00-03:00', motivo: 'SUSPENSO PARA OUTROS SERVIÇOS' },
    ], () => 'GUA');
    assert.deepEqual(linhas.map(l => [l.interrupcao_id, l.team_name, l.dia]),
      [['i1', 'ECGPR82', '2026-09-28'], ['i2', 'ECGPR82', '2026-10-07']]);
  });

  test('regional é da equipe que INTERROMPEU (catálogo), não da que tem a nota', () => {
    const [l] = svc.montarLinhas(cand, [{ id: 'i', equipe: 'ECLSJ90', dia: '2026-10-07' }],
      s => (s === 'ECLSJ90' ? 'SJC' : null));
    assert.equal(l.regional, 'SJC');
  });

  test('sem dia ou sem equipe é descartada (não dá pra atribuir)', () => {
    assert.deepEqual(svc.montarLinhas(cand, [
      { id: 'x', equipe: null, dia: '2026-10-07' },
      { id: 'y', equipe: 'ECGPR82', dia: null },
    ]), []);
  });
});

describe('_filtrarInterrupcoesPorSubcat — só Subs Obsoleto e TL11', () => {
  test('OBSOLETO e TL11 passam; OUTROS e sem classificação ficam de fora', () => {
    const rows = [{ note_id: 'o' }, { note_id: 't' }, { note_id: 'x' }, { note_id: 'sem' }];
    const subcats = { o: { sub_code: 'OBSOLETO' }, t: { sub_code: 'TL11' }, x: { sub_code: 'OUTROS' } };
    assert.deepEqual(_filtrarInterrupcoesPorSubcat(rows, subcats).map(r => r.note_id), ['o', 't']);
  });
});

describe('_buildEquipeTipoMatrix com INTERR', () => {
  const exec = [{ team_name: 'ECGPR82', regional: 'GUA', tipo_code: 'MD', count: 10 }];
  const rej  = [{ team_name: 'ECGPR82', regional: 'GUA', tipo: 'MD' }];
  const ints = [
    { team_name: 'ECGPR82', regional: 'GUA', tipo: 'MD' },
    { team_name: 'ECGPR82', regional: 'GUA', tipo: 'MD' },
  ];

  test('interrupção NÃO entra em total_exec/total_rej (fora da SOMA e do %REJ)', () => {
    const { equipes } = _buildEquipeTipoMatrix(exec, rej, 'TODAS', ints);
    const e = equipes[0];
    assert.equal(e.total_exec, 10);
    assert.equal(e.total_rej, 1);
    assert.equal(e.interr.MD, 2);
    assert.equal(e.total_interr, 2);
  });

  test('sem o 4º argumento a matriz fica como antes', () => {
    const { equipes } = _buildEquipeTipoMatrix(exec, rej, 'TODAS');
    assert.deepEqual(equipes[0].interr, {});
    assert.equal(equipes[0].total_interr, 0);
  });
});

describe('front — coluna INTERR só no grupo MD', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  test('COM_INTERR = MD e a célula usa e.interr', () => {
    assert.ok(SRC.includes("const COM_INTERR = new Set(['MD']);"));
    assert.ok(SRC.includes("cell(e.interr?.[t], 'mtx-interr')"));
  });
  test('Acumulado ignora equipe que só tem interrupção', () => {
    assert.ok(SRC.includes('.filter(e => !(!e.total_exec && !e.total_rej && e.total_interr > 0))'));
  });
});

describe('_janelaInterrupcoes — só a partir do início da coleta (07/10/2026)', () => {
  const { _janelaInterrupcoes } = require('../db/queries');
  // Decisão do José em 07/10/2026: dias antes do deploy estão incompletos
  // (só têm o histórico das notas interrompidas NO MOMENTO da coleta).
  test('período inteiro antes de 07/10 → nada', () => {
    assert.equal(_janelaInterrupcoes('2026-09-01', '2026-09-30'), null);
  });
  test('período que atravessa 07/10 → começa em 07/10', () => {
    assert.deepEqual(_janelaInterrupcoes('2026-10-01', '2026-10-31'), { de: '2026-10-07', ate: '2026-10-31' });
  });
  test('período depois de 07/10 → intacto', () => {
    assert.deepEqual(_janelaInterrupcoes('2026-10-08', '2026-10-08'), { de: '2026-10-08', ate: '2026-10-08' });
  });
});
