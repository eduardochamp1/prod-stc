/**
 * services/equipesOficiais.js
 * Lista hardcoded das equipes oficiais (Guarapari + Cachoeiro).
 * Apenas equipes nesta lista entram nos cálculos de produção, gauges,
 * ranking e histórico. Equipes fora da whitelist são ocultadas.
 *
 * Para adicionar/remover equipe: editar OFICIAIS_GUA ou OFICIAIS_CAC abaixo
 * e fazer redeploy. Estrutura: { sigla, tipo, placa }.
 *
 * Notas:
 * - "tipo" indica a categoria do veículo (A1, A2, A3, L1)
 * - GUA pode aparecer no setor DESG ou DEPT (já mapeado em dataService.js)
 * - Equipe é considerada oficial se a sigla bater (case-insensitive, trim)
 */

const OFICIAIS_GUA = [
  { sigla: 'EBGPR62', tipo: 'A2', placa: 'QMS9I79' },
  { sigla: 'EBGPR63', tipo: 'A3', placa: 'SFE8E68' },
  { sigla: 'EBGPR64', tipo: 'A3', placa: 'QUS4128' },
  { sigla: 'EBGPR65', tipo: 'A3', placa: 'TGX0G99' },
  { sigla: 'ECACH50', tipo: 'A1', placa: 'SIG1A15' },
  { sigla: 'ECANC50', tipo: 'L1', placa: 'TDY1C60' },
  { sigla: 'ECGPR51', tipo: 'L1', placa: 'SHQ6F47' },
  { sigla: 'ECGPR53', tipo: 'L1', placa: 'SH6F39'  },
  { sigla: 'ECGPR54', tipo: 'L1', placa: 'SHU2I02' },
  { sigla: 'ECGPR81', tipo: 'L1', placa: 'SHQ6F41' },
  { sigla: 'ECGPR82', tipo: 'L1', placa: 'SHU2H93' },
  { sigla: 'ECGPR90', tipo: 'L1', placa: 'TDY1C70' },
  { sigla: 'ECGPR91', tipo: 'L1', placa: 'TDY1C67' },
  { sigla: 'ECMRT50', tipo: 'L1', placa: 'TDY1C69' },
  { sigla: 'ECMRT51', tipo: 'A2', placa: 'SIH0G13' },
  { sigla: 'ECMRT80', tipo: 'L1', placa: 'TDY1C68' },
  { sigla: 'ECPIU50', tipo: 'A1', placa: 'SIG0A67' },
  { sigla: 'ECPIU90', tipo: 'L1', placa: 'TDY1C66' },
  { sigla: 'ECPKE50', tipo: 'A1', placa: 'RVW0D45' },
  { sigla: 'EPACH30', tipo: 'A1', placa: 'SIG0A46' },
  { sigla: 'EPANC30', tipo: 'A1', placa: 'RMP2F33' },
  { sigla: 'EPGPR30', tipo: 'A1', placa: 'SIG0A73' },
  { sigla: 'EPGPR31', tipo: 'A1', placa: 'SIG4C84' },
  { sigla: 'EPGPR32', tipo: 'A3', placa: 'SFD0F41' },
  { sigla: 'EPGPR33', tipo: 'A1', placa: 'SIF8B17' },
  { sigla: 'EPICO30', tipo: 'A1', placa: 'SNH8G77' },
  { sigla: 'EPMRT30', tipo: 'A2', placa: 'SIH0G17' },
  { sigla: 'EPMRT31', tipo: 'A3', placa: 'SFD0F63' },
  { sigla: 'EPMRT32', tipo: 'A1', placa: 'SIG4C86' },
  { sigla: 'EPPIU30', tipo: 'A3', placa: 'SFD0F63' },
  { sigla: 'EPPIU31', tipo: 'A1', placa: 'SIG0A63' },
];

const OFICIAIS_CAC = [
  { sigla: 'EPCIT30', tipo: 'A1', placa: 'RVW0D46' },
  { sigla: 'EPCIT31', tipo: 'A1', placa: 'RVW0D53' },
  { sigla: 'EPCIT32', tipo: 'A2', placa: 'SIG4C88' },
  { sigla: 'EPVGA30', tipo: 'A1', placa: 'SIA6D14' },
  { sigla: 'EPRNS30', tipo: 'A1', placa: 'SIG4C92' },
  { sigla: 'EPVGA31', tipo: 'A1', placa: 'SIG0A56' },
  { sigla: 'EPALE30', tipo: 'A1', placa: 'SIG4C91' },
  { sigla: 'EPALE31', tipo: 'A1', placa: 'SIF8B13' },
  { sigla: 'EPGUI30', tipo: 'A1', placa: 'SIH0G14' },
  { sigla: 'EPGUI31', tipo: 'A1', placa: 'SIG0A40' },
  { sigla: 'EPMUQ30', tipo: 'A1', placa: 'SIG0A62' },
  { sigla: 'EPMSU31', tipo: 'A1', placa: 'SIH0G16' },
  { sigla: 'EPBJE31', tipo: 'A1', placa: 'SIG4C85' },
  { sigla: 'ECCIT50', tipo: 'L1', placa: 'TDY1C64' },
  { sigla: 'ECCIT51', tipo: 'L1', placa: 'TDY1C71' },
  { sigla: 'ECCIT53', tipo: 'L1', placa: 'TDY1C61' },
  { sigla: 'ECCIT55', tipo: 'L1', placa: 'TDY1C73' },
  { sigla: 'ECCIT56', tipo: 'L1', placa: 'TDY1C62' },
  { sigla: 'ECCIT70', tipo: 'A2', placa: 'SIG4C88' },
  { sigla: 'ECCIT80', tipo: 'A1', placa: 'RVW7J53' },
  { sigla: 'ECCIT81', tipo: 'A1', placa: 'SIG0A48' },
  { sigla: 'ECALE80', tipo: 'A1', placa: 'SFD0F53' },
  { sigla: 'ECGUI80', tipo: 'L1', placa: 'TDY1C72' },
  { sigla: 'ECCIT90', tipo: 'L1', placa: 'TDY1C65' },
  { sigla: 'ECVGA50', tipo: 'A2', placa: 'SIH0G15' },
  { sigla: 'ECALE50', tipo: 'L1', placa: 'SHQ6F37' },
  { sigla: 'ECMSU50', tipo: 'A1', placa: 'SIG0A48' },
  { sigla: 'ECGUI50', tipo: 'A2', placa: 'SIF8B11' },
  { sigla: 'ECBJE50', tipo: 'A1', placa: 'SIG0A72' },
];

// ── Sets de lookup O(1) (uppercase, sem espaços) ──────────────────────────────
const SET_GUA = new Set(OFICIAIS_GUA.map(e => e.sigla.toUpperCase().trim()));
const SET_CAC = new Set(OFICIAIS_CAC.map(e => e.sigla.toUpperCase().trim()));
const SET_ALL = new Set([...SET_GUA, ...SET_CAC]);

// ── Mapa sigla → metadados ────────────────────────────────────────────────────
const META_BY_SIGLA = new Map();
for (const e of OFICIAIS_GUA) META_BY_SIGLA.set(e.sigla.toUpperCase().trim(), { ...e, regional: 'GUA' });
for (const e of OFICIAIS_CAC) META_BY_SIGLA.set(e.sigla.toUpperCase().trim(), { ...e, regional: 'CAC' });

/**
 * Normaliza uma sigla para lookup (uppercase + trim).
 */
function _norm(sigla) {
  return String(sigla || '').toUpperCase().trim();
}

/**
 * Retorna true se a sigla está na whitelist (qualquer regional).
 * Se `regional` for fornecido (GUA/CAC), valida só dentro daquela regional.
 */
function isOficial(sigla, regional) {
  const s = _norm(sigla);
  if (!s) return false;
  if (regional === 'GUA') return SET_GUA.has(s);
  if (regional === 'CAC') return SET_CAC.has(s);
  return SET_ALL.has(s);
}

/**
 * Retorna 'GUA' ou 'CAC' se a sigla for oficial, null caso contrário.
 */
function getRegional(sigla) {
  const meta = META_BY_SIGLA.get(_norm(sigla));
  return meta ? meta.regional : null;
}

/**
 * Filtra um array de equipes/objetos mantendo só os que têm sigla oficial.
 * `siglaKey` é o nome do campo que contém a sigla (default: 'sigla').
 */
function filterOficiais(arr, siglaKey = 'sigla', regional) {
  if (!Array.isArray(arr)) return arr;
  return arr.filter(item => {
    const sig = item && (item[siglaKey] || item.teamName || item.team_name);
    return isOficial(sig, regional);
  });
}

/**
 * Retorna a lista completa de siglas oficiais (opcionalmente filtrada por regional).
 */
function getSiglas(regional) {
  if (regional === 'GUA') return [...SET_GUA];
  if (regional === 'CAC') return [...SET_CAC];
  return [...SET_ALL];
}

/**
 * Retorna metadados completos { sigla, tipo, placa, regional } da equipe oficial.
 */
function getMeta(sigla) {
  return META_BY_SIGLA.get(_norm(sigla)) || null;
}

module.exports = {
  OFICIAIS_GUA,
  OFICIAIS_CAC,
  SET_GUA,
  SET_CAC,
  SET_ALL,
  isOficial,
  getRegional,
  filterOficiais,
  getSiglas,
  getMeta,
};
