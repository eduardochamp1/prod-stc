/**
 * services/timeUtil.js
 * Utilidades de fuso horário para a regra de negócio (BRT — America/Sao_Paulo).
 *
 * Por que existe: o codebase tinha 15+ ocorrências de
 * `new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10)`
 * para obter "data BRT". Esse cálculo:
 *   1. assume offset fixo -3h (Brasil pode reativar horário de verão)
 *   2. duplica a constante e o cálculo em vários arquivos
 *   3. é frágil quando alguém precisa de hora ou timezone diferente
 *
 * Esta função usa Intl.DateTimeFormat com `America/Sao_Paulo` — que
 * automaticamente respeita qualquer mudança de DST sem alterar código.
 */

const TZ = 'America/Sao_Paulo';

/**
 * Retorna a data atual (ou um Date arbitrário) formatada como YYYY-MM-DD
 * no fuso BRT/America/Sao_Paulo.
 *
 * @param {Date|number} [when=Date.now()]  timestamp ou Date a formatar
 * @returns {string}                       'YYYY-MM-DD' no fuso BRT
 */
function dateBRT(when) {
  const d = (when instanceof Date) ? when : new Date(when ?? Date.now());
  // pt-BR com sv-SE locale truque: sv-SE gera YYYY-MM-DD que é o que queremos
  // (en-CA também serve). Mais robusto que toLocaleDateString manual.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year:  'numeric',
    month: '2-digit',
    day:   '2-digit',
  }).format(d);
}

/**
 * Retorna a hora atual (0-23) no fuso BRT.
 *
 * @param {Date|number} [when=Date.now()]
 * @returns {number}                       0..23
 */
function hourBRT(when) {
  const d = (when instanceof Date) ? when : new Date(when ?? Date.now());
  const h = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hour:     'numeric',
    hour12:   false,
  }).format(d);
  // Em alguns locales/runtimes "00" pode aparecer como "24" → normaliza
  const n = parseInt(h, 10);
  return n === 24 ? 0 : n;
}

/**
 * Retorna a data BRT de N dias atrás (útil para janelas como "30 dias").
 * Considera o fuso ao calcular o cutoff — não vira "ontem" às 22h.
 *
 * @param {number} days  número de dias atrás
 * @returns {string}     'YYYY-MM-DD' BRT
 */
function dateBRTMinusDays(days) {
  return dateBRT(Date.now() - days * 86400000);
}

module.exports = { dateBRT, hourBRT, dateBRTMinusDays, TZ };
