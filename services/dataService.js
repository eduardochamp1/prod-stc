/**
 * services/dataService.js
 * Abstrai a fonte de dados: mock local (DATA_MODE=mock) ou WPA real (DATA_MODE=wpa).
 */

const { getMockTeams, getMockTeamDetail, getMockSummary } = require('../mock/mockData');
const { getTeamsBySector, REGIONAL_MAP } = require('./wpaService');

const MODE = (process.env.DATA_MODE || 'mock').toLowerCase();

// ── SETORES POR REGIONAL ──────────────────────────────────────────────────────
const SETORES = {
  GUA: ['DESG', 'DEPT'],
  CAC: ['DESC'],
  ALL: ['DESG', 'DEPT', 'DESC'],
};

// ── GET TEAMS ─────────────────────────────────────────────────────────────────
async function getTeams(filters = {}) {
  if (MODE === 'mock') return getMockTeams(filters);

  // Determina quais setores buscar
  const regional = filters.regional || 'ALL';
  const setores  = filters.sectorId && filters.sectorId !== 'ALL'
    ? [filters.sectorId]
    : (SETORES[regional] || SETORES.ALL);

  // Busca em paralelo
  const resultados = await Promise.all(setores.map(s => getTeamsBySector(s)));
  return resultados.flat();
}

// ── GET TEAM DETAIL ───────────────────────────────────────────────────────────
async function getTeamDetail(teamId) {
  if (MODE === 'mock') return getMockTeamDetail(teamId);

  // Busca em todos os setores até achar
  for (const setor of SETORES.ALL) {
    const teams = await getTeamsBySector(setor);
    const found = teams.find(t => t.id === teamId || t.sigla === teamId || t.teamName === teamId);
    if (found) return found;
  }
  return null;
}

// ── GET SUMMARY ───────────────────────────────────────────────────────────────
async function getSummary() {
  if (MODE === 'mock') return getMockSummary();

  const regionais = [
    { regionalId: 'GUA', nome: 'Guarapari', setores: SETORES.GUA },
    { regionalId: 'CAC', nome: 'Cachoeiro',  setores: SETORES.CAC },
  ];

  return Promise.all(regionais.map(async r => {
    const resultados = await Promise.all(r.setores.map(s => getTeamsBySector(s)));
    const teams = resultados.flat();
    return {
      regionalId:      r.regionalId,
      nome:            r.nome,
      totalEquipes:    teams.length,
      equipesAtivas:   teams.filter(t => !t.sessionEnd).length,
      totalBaixadas:   teams.reduce((s, t) => s + (t.notasBaixadas   || []).length, 0),
      totalExecutadas: teams.reduce((s, t) => s + (t.notasExecutadas || []).length, 0),
      totalConcluidas: teams.reduce((s, t) => s + (t.notasConcluidas || []).length, 0),
      totalRejeitadas: teams.reduce((s, t) => s + (t.notasRejeitadas || []).length, 0),
    };
  }));
}

module.exports = { getTeams, getTeamDetail, getSummary };
