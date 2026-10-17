/**
 * db/setorAtualQueries.js
 *
 * Setor em que cada equipe foi vista na coleta MAIS RECENTE (tabela snapshots).
 *
 * Por quê (José, 16/10/2026): Guarapari tem DOIS setores no WPA, DESG e DEPT, e
 * uma equipe pode ser transferida de um pro outro conforme a região onde vai
 * atuar ou o tipo de serviço a que for direcionada. O `equipes_oficiais.setor`
 * é cadastro estático — não acompanha a transferência. A coluna Setor da tela
 * de Equipes passa a mostrar onde a equipe está, não onde foi cadastrada.
 *
 * Fonte: `snapshots`, não `teams_current` — esta perde a equipe quando ela
 * encerra a sessão (dataWriter.js remove as offline), e a tela ficaria vazia
 * à noite e no fim de semana.
 *
 * Recebe o `pool` (padrão: o do pgShim) — o teste injeta um pool falso.
 */

'use strict';

// Janela de busca. Snapshots são retidos pra sempre (decisão de 07/07/2026);
// sem limite, o DISTINCT ON varreria o histórico inteiro. Equipe sem sessão
// nesse período cai no setor do cadastro, sinalizado na tela.
const DIAS_PADRAO = 14;

function _pool(pool) {
  if (pool) return pool;
  return require('../services/pgShim')._getPool();
}

/**
 * @param {object|null} pool
 * @param {{ dias?: number }} [opts]
 * @returns {Promise<Map<string, { setor: string, data: string }>>} sigla (MAIÚSCULA) → setor e dia
 */
async function setorAtualPorEquipe(pool, { dias = DIAS_PADRAO } = {}) {
  const { rows } = await _pool(pool).query(
    `SELECT DISTINCT ON (upper(team_name))
            upper(team_name) AS sigla, sector_id, date::text AS data
       FROM public.snapshots
      WHERE date >= CURRENT_DATE - $1::int
      ORDER BY upper(team_name), date DESC, captured_at DESC`,
    [dias]
  );
  const mapa = new Map();
  for (const r of rows) mapa.set(r.sigla, { setor: r.sector_id, data: r.data });
  return mapa;
}

module.exports = { setorAtualPorEquipe, DIAS_PADRAO };
