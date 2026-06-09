/**
 * services/notasMonitor.js
 * Monitor de notas devolvidas (Engelmig).
 *
 * Pipeline:
 *   collectSnapshot() = busca do WPA → filtra Engelmig → grava snapshot →
 *                       atualiza agregado diário → limpa snapshots > 30 dias.
 */

const { getNotasDevolvidas } = require('./wpaService');
const equipesOficiais        = require('./equipesOficiais');
const log                    = require('./logger').forModule('notas');

/**
 * Mantém só notas de equipes oficiais Engelmig.
 * Loga warning para equipes não-mapeadas com volume relevante (>=5 notas)
 * pra revisão da whitelist em equipes_oficiais.
 */
function filterEngelmig(notas) {
  const desconhecidas = new Map();   // sigla → count
  const filtradas = notas.filter(n => {
    const sigla = n?.Team?.Name;
    if (!sigla) return false;
    if (equipesOficiais.isOficial(sigla)) return true;
    desconhecidas.set(sigla, (desconhecidas.get(sigla) || 0) + 1);
    return false;
  });
  const ruidosas = [...desconhecidas.entries()].filter(([, c]) => c >= 5);
  if (ruidosas.length) {
    log.warn('equipes_desconhecidas', { equipes: Object.fromEntries(ruidosas) });
  }
  return filtradas;
}

module.exports = { filterEngelmig };
