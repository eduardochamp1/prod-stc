/**
 * services/notasMonitor.js
 * Monitor de notas devolvidas (Engelmig).
 *
 * Pipeline:
 *   collectSnapshot() = busca lista de equipes (CompanyId) + busca notas →
 *                       filtra por CompanyId Engelmig → tagueia oficial/nova →
 *                       grava snapshot → atualiza agregado diário →
 *                       limpa snapshots > 30 dias.
 */

const { getNotasDevolvidas, getTeamsSimple } = require('./wpaService');
const equipesOficiais                          = require('./equipesOficiais');
const log                                      = require('./logger').forModule('notas');

// CompanyIds que pertencem à Engelmig (descobertos no payload do dropdown
// Teams/Simple). Inclui os 2 CNPJs Engelmig que aparecem nas equipes da
// regional DESC (Cachoeiro):
//   92a2f98e-... → uma das matrizes
//   3a4b33fb-... → outra matriz
const ENGELMIG_COMPANY_IDS = new Set([
  '92a2f98e-8877-433e-8358-173b94c13a54',
  '3a4b33fb-25e0-4506-803c-3d58ec3fbd5b',
]);

/**
 * Cruza notas com o dicionário de equipes (Name → CompanyId), mantém só
 * notas de equipes Engelmig e marca cada uma como oficial (no whitelist) ou
 * nova (Engelmig mas fora do whitelist — a revisar).
 *
 * @param {Array} notas         payload de getNotasDevolvidas
 * @param {Map}   teamCompanyId mapa Name → CompanyId vindo de getTeamsSimple
 * @returns {Array} notas filtradas, cada uma com campo extra `_equipe_oficial`
 */
function filterEngelmig(notas, teamCompanyId) {
  const naoEngelmig = new Map();  // sigla → count (não-Engelmig — só pra observabilidade)
  const novasNaoOficiais = new Map();  // sigla → count (Engelmig fora do whitelist)
  const out = [];
  for (const n of notas) {
    const sigla = n?.Team?.Name;
    if (!sigla) continue;
    const cid = teamCompanyId.get(sigla);
    if (!cid || !ENGELMIG_COMPANY_IDS.has(cid)) {
      naoEngelmig.set(sigla, (naoEngelmig.get(sigla) || 0) + 1);
      continue;
    }
    const oficial = equipesOficiais.isOficial(sigla);
    if (!oficial) novasNaoOficiais.set(sigla, (novasNaoOficiais.get(sigla) || 0) + 1);
    n._equipe_oficial = oficial;
    out.push(n);
  }
  log.info('filter_engelmig', {
    total_in: notas.length,
    engelmig_out: out.length,
    oficiais: out.filter(n => n._equipe_oficial).length,
    novas: out.filter(n => !n._equipe_oficial).length,
  });
  if (novasNaoOficiais.size) {
    log.warn('equipes_engelmig_fora_do_whitelist',
      { equipes: Object.fromEntries(novasNaoOficiais) });
  }
  return out;
}

/**
 * Constrói o mapa Name → CompanyId a partir do payload de Teams/Simple.
 */
function buildTeamCompanyMap(teams) {
  const m = new Map();
  for (const t of teams) {
    if (t?.Name && t?.CompanyId) m.set(t.Name, t.CompanyId);
  }
  return m;
}

module.exports = { filterEngelmig, buildTeamCompanyMap, ENGELMIG_COMPANY_IDS };
