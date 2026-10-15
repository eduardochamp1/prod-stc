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

/**
 * Minutos desde a meia-noite BRT (0..1439). Existe porque `hourBRT` só devolve a
 * hora cheia, e o alerta de produtividade compara com o MEIO do turno (ex.: 12:30).
 * Usa `formatToParts` (não parseia string) e trata o "24" que alguns runtimes
 * devolvem pra meia-noite, como `hourBRT`.
 *
 * @param {Date|number} [when=Date.now()]
 * @returns {number} 0..1439
 */
function minutosBRT(when) {
  const d = (when instanceof Date) ? when : new Date(when ?? Date.now());
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(d);
  const get = (t) => parseInt((partes.find(p => p.type === t) || {}).value, 10);
  const h = get('hour') === 24 ? 0 : get('hour');
  return h * 60 + get('minute');
}

/**
 * Instante (ms) em que, no fuso BRT, é `dataISO` às `minutos` desde a meia-noite.
 * Inverso de dateBRT + minutosBRT. O palpite inicial assume UTC-3 mas é CORRIGIDO
 * pelo Intl até bater — então vale também se o Brasil voltar ao horário de verão.
 * Usado pelo backtest do alerta de produtividade (hora do meio do turno de um dia
 * passado).
 *
 * @param {string} dataISO  'YYYY-MM-DD' (dia BRT)
 * @param {number} minutos  0..1439
 * @returns {number} epoch ms
 */
function instanteBRT(dataISO, minutos) {
  const [y, m, d] = String(dataISO).split('-').map(Number);
  let guess = Date.UTC(y, m - 1, d, 0, 0) + minutos * 60000 + 3 * 3600000;
  const alvoDia = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 4; i++) {
    const [gy, gm, gd] = dateBRT(guess).split('-').map(Number);
    const diffDias = (alvoDia - Date.UTC(gy, gm - 1, gd)) / 86400000;
    const diff = diffDias * 1440 + (minutos - minutosBRT(guess));
    if (diff === 0) break;
    guess += diff * 60000;
  }
  return guess;
}

module.exports = { dateBRT, hourBRT, dateBRTMinusDays, minutosBRT, instanteBRT, TZ };
