/**
 * db/alertasQueries.js
 *
 * Acesso a dados do alerta de baixa produtividade (016_alertas_produtividade.sql).
 * Camada FINA: a regra de negócio mora em services/alertaProdutividade.js.
 *
 * Todas as funções recebem o `pool` (padrão: o do pgShim) — assim o teste injeta
 * um pool falso e confere o SQL sem banco.
 *
 * Por que SQL direto e não o query builder do pgShim: o `upsert` do shim gera
 * `ON CONFLICT … DO UPDATE SET` nas colunas que não são chave (pgShim.js:301-313),
 * então um 2º ciclo SOBRESCREVERIA `disparado_em`/`executadas_disparo` do alerta.
 * Abrir o alerta exige `DO NOTHING`.
 */

'use strict';

const { inRegionalsSql } = require('../services/regionals');

function _pool(pool) {
  if (pool) return pool;
  return require('../services/pgShim')._getPool();
}

/**
 * Abre o alerta. `ON CONFLICT (data, team_name) DO NOTHING`: reexecutar um ciclo
 * não duplica, não reabre um resolvido e não sobrescreve o disparo original.
 * @returns {Promise<boolean>} true se INSERIU (era novo), false se já existia
 */
async function abrir(pool, l) {
  const { rows } = await _pool(pool).query(
    `INSERT INTO public.alertas_produtividade
       (data, team_name, regional, sector_id, supervisor, limite,
        escala_inicio, escala_fim, meio_turno_em,
        executadas_disparo, executadas_atual, rejeitadas, disparado_em)
     VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10, $10, $11, $12::timestamptz)
     ON CONFLICT (data, team_name) DO NOTHING
     RETURNING id`,
    [l.data, l.team_name, l.regional, l.sector_id || null, l.supervisor || null, l.limite,
     l.escala_inicio || null, l.escala_fim || null, l.meio_turno_em,
     l.executadas, l.rejeitadas || 0, l.disparado_em]);
  return rows.length > 0;
}

/**
 * Atualiza os números de um alerta ABERTO. `resolvido_em IS NULL` garante que um
 * alerta resolvido não é reescrito.
 */
async function atualizar(pool, data, team, { executadas, rejeitadas }) {
  await _pool(pool).query(
    `UPDATE public.alertas_produtividade
        SET executadas_atual = $3, rejeitadas = $4
      WHERE data = $1::date AND team_name = $2 AND resolvido_em IS NULL`,
    [data, team, executadas, rejeitadas || 0]);
}

/** Marca como resolvido (a equipe chegou ao limite). Só atua se ainda estiver aberto. */
async function resolver(pool, data, team, { executadas, rejeitadas, quando }) {
  await _pool(pool).query(
    `UPDATE public.alertas_produtividade
        SET resolvido_em = $5::timestamptz, executadas_atual = $3, rejeitadas = $4
      WHERE data = $1::date AND team_name = $2 AND resolvido_em IS NULL`,
    [data, team, executadas, rejeitadas || 0, quando]);
}

/** Estado de TODOS os alertas do dia (abertos e resolvidos), pro avaliador. */
async function estadoDoDia(pool, data) {
  const { rows } = await _pool(pool).query(
    `SELECT team_name, (resolvido_em IS NOT NULL) AS resolvido
       FROM public.alertas_produtividade
      WHERE data = $1::date`, [data]);
  return rows.map(r => ({ team_name: r.team_name, resolvido: r.resolvido === true }));
}

/**
 * Alertas ATIVOS (não resolvidos) do dia, escopados às regionais da conta.
 * Lista de regionais vazia ⇒ [] (nunca consulta sem filtro: uma conta sem
 * regional não pode ver alerta de ninguém).
 */
async function listarAtivos(pool, data, regionais) {
  if (!Array.isArray(regionais) || regionais.length === 0) return [];
  const params = [data];
  const filtroRegional = inRegionalsSql(regionais, params);
  const { rows } = await _pool(pool).query(
    `SELECT team_name, regional, supervisor, limite,
            escala_inicio, escala_fim, meio_turno_em,
            executadas_disparo, executadas_atual, rejeitadas, disparado_em
       FROM public.alertas_produtividade
      WHERE data = $1::date AND resolvido_em IS NULL AND ${filtroRegional}
      ORDER BY executadas_atual ASC, disparado_em ASC, team_name ASC`, params);
  return rows;
}

/**
 * Executadas do dia por equipe: SOMA de team_daily_totals — a MESMA fonte da
 * coluna EXEC da matriz (fonte única). Já vem com dedup por UUID entre sessões e
 * a regra rejeitada > concluída (dataWriter._aggregateTeamDailyTotals).
 * @returns {Promise<Object<string, number>>} { 'ECGPR53': 7, ... }
 */
async function executadasPorEquipe(pool, data) {
  const { rows } = await _pool(pool).query(
    `SELECT team_name, SUM(count)::int AS executadas
       FROM public.team_daily_totals
      WHERE date = $1::date
      GROUP BY team_name`, [data]);
  const out = {};
  for (const r of rows) out[r.team_name] = Number(r.executadas) || 0;
  return out;
}

/**
 * Histórico de supervisor por equipe + nomes, no formato que
 * services/supervisores.supervisorVigente consome. Lido UMA vez por ciclo.
 */
async function historicoSupervisores(pool) {
  const { rows } = await _pool(pool).query(
    `SELECT h.sigla, to_char(h.desde, 'YYYY-MM-DD') AS desde, h.supervisor_id, s.nome
       FROM public.equipe_supervisor_historico h
       LEFT JOIN public.supervisores s ON s.id = h.supervisor_id`);
  const nomes = {};
  for (const r of rows) {
    if (r.supervisor_id !== null && r.supervisor_id !== undefined && r.nome) {
      nomes[Number(r.supervisor_id)] = r.nome;
    }
  }
  return {
    historico: rows.map(r => ({ sigla: r.sigla, desde: r.desde, supervisor_id: r.supervisor_id })),
    nomes,
  };
}

module.exports = {
  abrir, atualizar, resolver, estadoDoDia, listarAtivos,
  executadasPorEquipe, historicoSupervisores,
};
