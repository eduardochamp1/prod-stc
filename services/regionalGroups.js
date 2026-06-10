/**
 * services/regionalGroups.js
 *
 * Agrupamentos de regionais — permite que um valor de regional represente
 * UMA OU MAIS siglas reais do banco. Útil pra escopos de auth:
 *
 *   GUA   → ['GUA']           (Guarapari)
 *   CAC   → ['CAC']           (Cachoeiro)
 *   SJC   → ['SJC']           (São José dos Campos)
 *   ES    → ['GUA', 'CAC']    (Espírito Santo = GUA + CAC)
 *   SP    → ['SJC']           (São Paulo — futuro, se virar grupo)
 *   ALL   → null              (sem filtro — vê tudo)
 *
 * Pra adicionar um novo grupo, basta editar o `GROUPS` abaixo. As queries
 * todas usam `applyRegional(query, regional)` que cuida da expansão.
 */

/**
 * Mapeamento de grupos → lista de regionais reais no banco.
 * Chaves devem ser MAIÚSCULAS e não colidir com siglas reais.
 */
const GROUPS = {
  ES: ['GUA', 'CAC'],
};

/** Lista das regionais reais (siglas que existem em `equipes_oficiais.regional`). */
const REGIONAIS_REAIS = new Set(['GUA', 'CAC', 'SJC']);

/**
 * Expande uma regional para a lista de siglas reais que ela representa.
 *
 * @param {string|null|undefined} regional
 * @returns {string[]|null}  null = sem filtro (ALL ou vazio).
 *                           [] = grupo conhecido mas sem siglas (não deveria acontecer).
 *                           ['GUA'] = sigla simples.
 *                           ['GUA','CAC'] = grupo expandido.
 */
function expandRegional(regional) {
  if (!regional) return null;
  const r = String(regional).toUpperCase().trim();
  if (r === 'ALL') return null;
  if (GROUPS[r]) return [...GROUPS[r]];
  if (REGIONAIS_REAIS.has(r)) return [r];
  // Valor desconhecido — devolve como sigla única (compatibilidade).
  return [r];
}

/**
 * Aplica filtro de regional num query-builder (Supabase ou pgShim).
 * Usa `.eq()` se for 1 sigla, `.in()` se for mais. Não aplica nada se
 * `regional` for 'ALL' / vazio.
 *
 * @param {object} query  query builder com .eq() e .in()
 * @param {string} regional
 * @param {string} [col='regional']  nome da coluna no banco
 * @returns {object}  query builder modificado
 */
function applyRegional(query, regional, col = 'regional') {
  const regs = expandRegional(regional);
  if (!regs) return query;
  if (regs.length === 1) return query.eq(col, regs[0]);
  return query.in(col, regs);
}

/**
 * Versão pra filtro em memória — útil quando os dados já vieram do banco
 * e precisamos filtrar JS-side (ex: `_onlyOficiais`-like pipelines).
 *
 * @param {string} regional  valor configurado no usuário (GUA/CAC/SJC/ES/ALL)
 * @param {string} rowRegional  valor real da linha (GUA/CAC/SJC)
 * @returns {boolean}  true se a linha passa pelo filtro
 */
function regionalMatches(regional, rowRegional) {
  const regs = expandRegional(regional);
  if (!regs) return true;
  return regs.includes(String(rowRegional || '').toUpperCase());
}

/** Lista as siglas válidas (incluindo grupos) — útil pra validação de input. */
function getValidRegionals() {
  return ['ALL', ...REGIONAIS_REAIS, ...Object.keys(GROUPS)];
}

/**
 * Gera cláusula SQL "regional = $N" ou "regional IN ($N,$N+1,...)" e
 * empurra os valores no array `params` (mutação in-place — padrão dos
 * builders de SQL raw em rejectionsQueries.js).
 *
 * @param {string} regional            valor configurado (GUA/CAC/SJC/ES/ALL)
 * @param {any[]}  params              array onde os valores são empurrados
 * @param {string} [col='regional']    nome da coluna no SQL
 * @returns {string|null}              cláusula pronta pra `where.push(...)`,
 *                                     ou null se for ALL/vazio (sem filtro).
 */
function regionalSqlClause(regional, params, col = 'regional') {
  const regs = expandRegional(regional);
  if (!regs) return null;
  if (regs.length === 1) {
    params.push(regs[0]);
    return `${col} = $${params.length}`;
  }
  const startIdx = params.length + 1;
  regs.forEach(r => params.push(r));
  const placeholders = regs.map((_, i) => `$${startIdx + i}`).join(', ');
  return `${col} IN (${placeholders})`;
}

module.exports = {
  GROUPS,
  expandRegional,
  applyRegional,
  regionalMatches,
  getValidRegionals,
  regionalSqlClause,
};
