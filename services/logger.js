/**
 * services/logger.js
 * Logger estruturado leve — JSON em produção, texto colorido em dev.
 *
 * Por que existe: console.log("texto livre") é OK em dev mas em prod
 * dificulta filtrar/agregar logs em qualquer observability tool (Vercel
 * Logs, Datadog, Logtail, etc). Eles parseiam JSON automaticamente.
 *
 * Modo automático:
 *   - process.env.NODE_ENV === 'production' OU process.env.VERCEL → JSON
 *   - caso contrário (dev local)              → texto colorido
 *
 * Uso:
 *   const log = require('./logger').forModule('cron');
 *   log.info('snapshot_done', { teams: 60, ms: 1234 });
 *   log.warn('classify_failed', { date: '2026-04-15', err: e.message });
 *   log.error('supabase_unreachable', { code: e.code });
 *
 * Output JSON:
 *   {"ts":"2026-05-04T22:00:00.000Z","level":"info","module":"cron",
 *    "event":"snapshot_done","teams":60,"ms":1234}
 *
 * Output dev (texto):
 *   22:00:00 [info ] cron snapshot_done teams=60 ms=1234
 *
 * Mantém compatibilidade: NÃO substitui console.* — existe em paralelo.
 * Migração é gradual.
 */

'use strict';

const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL] || (IS_PROD ? LEVELS.info : LEVELS.debug);

// Cores ANSI para dev
const COLORS = {
  debug: '\x1b[90m',  // cinza
  info:  '\x1b[36m',  // ciano
  warn:  '\x1b[33m',  // amarelo
  error: '\x1b[31m',  // vermelho
  reset: '\x1b[0m',
  dim:   '\x1b[2m',
};

function _formatDevPairs(data) {
  if (!data || typeof data !== 'object') return '';
  return Object.keys(data)
    .filter(k => data[k] !== undefined)
    .map(k => {
      const v = data[k];
      if (v === null) return `${k}=null`;
      if (typeof v === 'object') return `${k}=${JSON.stringify(v)}`;
      // Encurta strings longas em dev pra ficar legível
      const s = String(v);
      return `${k}=${s.length > 100 ? s.slice(0, 100) + '…' : s}`;
    })
    .join(' ');
}

function _emit(level, module, event, data) {
  if (LEVELS[level] < MIN_LEVEL) return;

  if (IS_PROD) {
    // JSON one-liner — sem dependências externas
    const payload = { ts: new Date().toISOString(), level, module, event, ...data };
    // Stdout pra info/debug, stderr pra warn/error (convenção Unix)
    const line = JSON.stringify(payload);
    if (level === 'warn' || level === 'error') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
    return;
  }

  // Dev: texto colorido legível
  const time = new Date().toLocaleTimeString('pt-BR', { hour12: false });
  const lvl  = level.padEnd(5);
  const head = `${COLORS.dim}${time}${COLORS.reset} ${COLORS[level]}[${lvl}]${COLORS.reset} ${COLORS.dim}${module}${COLORS.reset} ${event}`;
  const pairs = _formatDevPairs(data);
  const out = pairs ? `${head} ${pairs}` : head;
  if (level === 'warn' || level === 'error') console.error(out);
  else console.log(out);
}

/**
 * Cria um logger pré-configurado com um nome de módulo.
 * Mantém os métodos `debug/info/warn/error` que aceitam (event, data?).
 */
function forModule(moduleName) {
  return {
    debug: (event, data) => _emit('debug', moduleName, event, data),
    info:  (event, data) => _emit('info',  moduleName, event, data),
    warn:  (event, data) => _emit('warn',  moduleName, event, data),
    error: (event, data) => _emit('error', moduleName, event, data),
  };
}

module.exports = {
  forModule,
  IS_PROD,
};
