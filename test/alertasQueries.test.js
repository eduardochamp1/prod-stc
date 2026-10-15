/**
 * test/alertasQueries.test.js
 *
 * Trava o SQL de db/alertasQueries.js com um pool FALSO (sem banco). O que
 * importa aqui são as propriedades que, se quebradas, corrompem o alerta:
 *   - abrir NUNCA sobrescreve (ON CONFLICT DO NOTHING, não DO UPDATE);
 *   - atualizar/resolver NUNCA tocam num alerta já resolvido;
 *   - leitura por regional sempre filtra (e lista vazia não consulta);
 *   - a migration tem UNIQUE (data, team_name) e o OWNER wpa_app.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Q = require('../db/alertasQueries');

function poolFalso(rows = []) {
  const chamadas = [];
  return {
    chamadas,
    async query(sql, params) { chamadas.push({ sql, params }); return { rows }; },
  };
}
const norm = (s) => s.replace(/\s+/g, ' ').trim();

describe('abrir', () => {
  const l = {
    data: '2026-10-14', team_name: 'ECGPR53', regional: 'GUA', sector_id: 'DESG',
    supervisor: 'JOAO SILVA', limite: 4, escala_inicio: '08:00', escala_fim: '17:00',
    meio_turno_em: '2026-10-14T15:30:00Z', executadas: 2, rejeitadas: 1,
    disparado_em: '2026-10-14T15:31:00Z',
  };

  test('usa ON CONFLICT (data, team_name) DO NOTHING — nunca DO UPDATE', async () => {
    const p = poolFalso([{ id: 1 }]);
    await Q.abrir(p, l);
    const sql = norm(p.chamadas[0].sql);
    assert.match(sql, /ON CONFLICT \(data, team_name\) DO NOTHING/);
    assert.doesNotMatch(sql, /DO UPDATE/);
  });
  test('devolve true quando inseriu e false quando já existia', async () => {
    assert.equal(await Q.abrir(poolFalso([{ id: 9 }]), l), true);
    assert.equal(await Q.abrir(poolFalso([]), l), false);
  });
  test('executadas_disparo e executadas_atual nascem iguais (mesmo parâmetro)', async () => {
    const p = poolFalso([{ id: 1 }]);
    await Q.abrir(p, l);
    assert.match(norm(p.chamadas[0].sql), /\$10, \$10/);
    assert.equal(p.chamadas[0].params[9], 2);
  });
  test('campos opcionais viram NULL, não undefined', async () => {
    const p = poolFalso([{ id: 1 }]);
    await Q.abrir(p, { ...l, sector_id: undefined, supervisor: undefined, escala_inicio: undefined, rejeitadas: undefined });
    const params = p.chamadas[0].params;
    assert.equal(params.includes(undefined), false);
    assert.equal(params[3], null);   // sector_id
    assert.equal(params[4], null);   // supervisor
    assert.equal(params[10], 0);     // rejeitadas
  });
});

describe('atualizar / resolver só atuam em alerta ABERTO', () => {
  test('atualizar filtra resolvido_em IS NULL', async () => {
    const p = poolFalso();
    await Q.atualizar(p, '2026-10-14', 'ECGPR53', { executadas: 3, rejeitadas: 0 });
    assert.match(norm(p.chamadas[0].sql), /WHERE data = \$1::date AND team_name = \$2 AND resolvido_em IS NULL/);
    assert.deepEqual(p.chamadas[0].params, ['2026-10-14', 'ECGPR53', 3, 0]);
  });
  test('resolver filtra resolvido_em IS NULL e grava o instante', async () => {
    const p = poolFalso();
    await Q.resolver(p, '2026-10-14', 'ECGPR53', { executadas: 4, rejeitadas: 2, quando: '2026-10-14T18:00:00Z' });
    const sql = norm(p.chamadas[0].sql);
    assert.match(sql, /SET resolvido_em = \$5::timestamptz/);
    assert.match(sql, /AND resolvido_em IS NULL/);
    assert.equal(p.chamadas[0].params[4], '2026-10-14T18:00:00Z');
  });
});

describe('listarAtivos', () => {
  test('filtra por dia, por não resolvido e pelas regionais da conta', async () => {
    const p = poolFalso([{ team_name: 'ECGPR53' }]);
    const r = await Q.listarAtivos(p, '2026-10-14', ['GUA', 'CAC']);
    const sql = norm(p.chamadas[0].sql);
    assert.match(sql, /resolvido_em IS NULL/);
    assert.match(sql, /regional IN \(\$2,\$3\)/);
    assert.deepEqual(p.chamadas[0].params, ['2026-10-14', 'GUA', 'CAC']);
    assert.equal(r.length, 1);
  });
  test('ordena: menos executadas primeiro, depois o disparo mais antigo', async () => {
    const p = poolFalso();
    await Q.listarAtivos(p, '2026-10-14', ['GUA']);
    assert.match(norm(p.chamadas[0].sql), /ORDER BY executadas_atual ASC, disparado_em ASC/);
  });
  test('sem regionais (conta sem escopo) → [] e NÃO consulta o banco', async () => {
    const p = poolFalso([{ team_name: 'X' }]);
    assert.deepEqual(await Q.listarAtivos(p, '2026-10-14', []), []);
    assert.deepEqual(await Q.listarAtivos(p, '2026-10-14', undefined), []);
    assert.equal(p.chamadas.length, 0);
  });
});

describe('estadoDoDia', () => {
  test('mapeia resolvido para booleano', async () => {
    const p = poolFalso([
      { team_name: 'A', resolvido: true }, { team_name: 'B', resolvido: false }, { team_name: 'C', resolvido: null },
    ]);
    assert.deepEqual(await Q.estadoDoDia(p, '2026-10-14'), [
      { team_name: 'A', resolvido: true },
      { team_name: 'B', resolvido: false },
      { team_name: 'C', resolvido: false },
    ]);
  });
});

describe('executadasPorEquipe', () => {
  test('lê team_daily_totals (a mesma fonte do EXEC da matriz) e soma por equipe', async () => {
    const p = poolFalso([{ team_name: 'ECGPR53', executadas: '7' }, { team_name: 'ETGPR16', executadas: 2 }]);
    const r = await Q.executadasPorEquipe(p, '2026-10-14');
    assert.match(norm(p.chamadas[0].sql), /FROM public\.team_daily_totals WHERE date = \$1::date GROUP BY team_name/);
    assert.deepEqual(r, { ECGPR53: 7, ETGPR16: 2 });
  });
});

describe('interrompidasPorEquipe (15/10/2026)', () => {
  test('conta TODA interrupção do dia por equipe — sem o filtro Obsoleto/TL11 da matriz', async () => {
    // Caso real de 15/10/2026: ECGPR51 com 1 interrupção de MD Outros ficava sem chip.
    const p = poolFalso([{ team_name: 'ECGPR54', interrompidas: '6' }, { team_name: 'ECGPR51', interrompidas: 1 }]);
    const r = await Q.interrompidasPorEquipe(p, '2026-10-15', ['ECGPR54', 'ECGPR51', 'ECGPR91']);
    assert.deepEqual(r, { ECGPR54: 6, ECGPR51: 1 });
    const sql = norm(p.chamadas[0].sql);
    assert.match(sql, /FROM public\.note_interrupcoes WHERE dia = \$1::date AND team_name = ANY\(\$2::text\[\]\) GROUP BY team_name/);
    assert.doesNotMatch(sql, /note_subcategorias|sub_code/);
    assert.deepEqual(p.chamadas[0].params, ['2026-10-15', ['ECGPR54', 'ECGPR51', 'ECGPR91']]);
  });
  test('sem equipes não consulta', async () => {
    const p = poolFalso();
    assert.deepEqual(await Q.interrompidasPorEquipe(p, '2026-10-15', []), {});
    assert.equal(p.chamadas.length, 0);
  });
});

describe('historicoSupervisores', () => {
  test('devolve no formato do supervisorVigente e o mapa de nomes', async () => {
    const p = poolFalso([
      { sigla: 'ECGPR53', desde: '2026-10-07', supervisor_id: 3, nome: 'JOAO SILVA' },
      { sigla: 'ECGPR54', desde: '2026-10-07', supervisor_id: null, nome: null },
    ]);
    const r = await Q.historicoSupervisores(p);
    assert.deepEqual(r.historico, [
      { sigla: 'ECGPR53', desde: '2026-10-07', supervisor_id: 3 },
      { sigla: 'ECGPR54', desde: '2026-10-07', supervisor_id: null },
    ]);
    assert.deepEqual(r.nomes, { 3: 'JOAO SILVA' });
  });
});

describe('migration 016', () => {
  const SQL = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'migrations', '016_alertas_produtividade.sql'), 'utf8');

  test('UNIQUE (data, team_name) — a idempotência do alerta', () => {
    assert.match(SQL, /UNIQUE \(data, team_name\)/);
  });
  test('é idempotente (IF NOT EXISTS) e dá OWNER wpa_app à tabela E à sequence', () => {
    assert.match(SQL, /CREATE TABLE IF NOT EXISTS alertas_produtividade/);
    assert.match(SQL, /ALTER TABLE alertas_produtividade OWNER TO wpa_app/);
    assert.match(SQL, /ALTER SEQUENCE alertas_produtividade_id_seq OWNER TO wpa_app/);
  });
  test('avisa que o upsert do shim NÃO serve pra abrir', () => {
    assert.match(SQL, /DO UPDATE SET/);
    assert.match(SQL, /APLICAR ANTES/);
  });
  test('as colunas que o INSERT usa existem na migration', () => {
    for (const col of ['data', 'team_name', 'regional', 'sector_id', 'supervisor', 'limite',
      'escala_inicio', 'escala_fim', 'meio_turno_em', 'executadas_disparo', 'executadas_atual',
      'rejeitadas', 'disparado_em', 'resolvido_em']) {
      assert.match(SQL, new RegExp(`\\b${col}\\b`), col);
    }
  });
});
