/**
 * services/regionals.js
 *
 * Helper único pra manipulação de regionais.
 *
 * Convenção do projeto: `regional` é SEMPRE string[] de siglas reais
 * (ex: ['GUA','CAC','SJC']). Sem 'ALL', sem grupos virtuais como 'ES'.
 */

const REGIONAIS_VALIDAS = new Set(['GUA', 'CAC', 'SJC']);

const REGIONAIS_NOMES = {
  GUA: 'Guarapari',
  CAC: 'Cachoeiro',
  SJC: 'São José dos Campos',
};

/** Sigla válida (case-insensitive)? */
function isValidRegional(sigla) {
  if (sigla == null) return false;
  return REGIONAIS_VALIDAS.has(String(sigla).toUpperCase());
}

/** Aplica filtro regional num query builder (Postgres via pgShim). */
function inRegionals(query, regionals, col = 'regional') {
  return query.in(col, regionals);
}

/** Gera cláusula WHERE pra SQL raw (com placeholders $N). */
function inRegionalsSql(regionals, params, col = 'regional') {
  const placeholders = regionals
    .map((_, i) => `$${params.length + i + 1}`)
    .join(',');
  params.push(...regionals);
  return `${col} IN (${placeholders})`;
}

module.exports = {
  REGIONAIS_VALIDAS,
  REGIONAIS_NOMES,
  isValidRegional,
  inRegionals,
  inRegionalsSql,
};
