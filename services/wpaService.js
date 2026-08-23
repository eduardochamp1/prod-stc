/**
 * services/wpaService.js
 * Integração com a API WPA EDP.
 *
 * Auth:  POST https://edp-wpa-po.azurewebsites.net/identity/signin  → JWT
 * API:   https://edp-wpa-web-api.azurewebsites.net
 *
 * Estratégia de dados (2 chamadas paralelas por setor):
 *   1. GET /api/sessions/current?sectorId=X
 *      → Única fonte do Team.CompanyId — necessário para filtrar equipes Engelmig.
 *        Também fornece Vehicle.Code (placa) que o V2 não retorna.
 *   2. GET /api/teamsstatus/V2?sectorId=X&filterByExhibitionSector=true
 *      → Fonte dos contadores de notas.
 *        Inclui Concluded[] com ExecutionStatus 4/5 que some de /notes/execution.
 *
 * ExecutionStatus das notas no V2 (confirmado em campo):
 *   1 → baixada   (na carteira, aguardando)
 *   3 → executada (em andamento)
 *   6 → executada ("Trabalhando na nota X" — nota ativa)
 *   7 → executada (variante de nota ativa)
 *   4 → concluida (exportada/sincronizada)
 *   5 → concluida (exportada variante)
 *   9 → concluida (mobile pendente sync)
 *
 * Estrutura de Collaborators:
 *   sessions/current → Collaborators[].Collaborator.{Name, Code}  (aninhado)
 *   teamsstatus/V2   → Session.Collaborators[].{Name, Code}        (plano)
 *   O código trata ambos com fallback defensivo.
 */

const fetch = require('node-fetch');
const { dateBRT } = require('./timeUtil');

// Timeout de TODA chamada HTTP à EDP. Antes não havia nenhum: um socket
// derrubado pelo Fortinet sem FIN deixava a promise pendurada pra sempre, e
// como o _singleFlight só limpa no .finally(), TODO getTeams/snapshot daquele
// setor passava a esperar a mesma promise morta — painel travado até
// `pm2 restart`. Achado da revisão paralela de 20/08/2026 (backlog P1-31).
// node-fetch@2 suporta a opção `timeout` (o padrão do repo já era esse em
// osrmService.js:106).
//
// ⚠️ CORRIGIDO EM 21/08/2026, no mesmo dia: o default entrou como 20000 e isso
// foi ERRADO. O comentário do backoff de login, ~350 linhas abaixo, registra
// "cold-start de até 25-30s" — ou seja, 20s corta resposta LEGÍTIMA. E o
// `_safeNotes` engole a exceção devolvendo [] ("esvaziando bucket"), então o
// efeito visível não é erro: é equipe aparecendo sem rejeitadas e sem
// executadas. Com o retry de 3 tentativas, o pior caso ficou ~69s E vazio —
// pior que o problema que o timeout foi resolver. Reportado pelo usuário como
// "páginas lentas e não carregando tudo".
// Agora: 45s (folga sobre os 30s observados) e SEM retry em timeout — ver
// _isTimeoutError no wpaFetch. Timeout existe pra cortar socket pendurado, não
// pra cortar resposta devagar.
const WPA_HTTP_TIMEOUT_MS = Number(process.env.WPA_HTTP_TIMEOUT_MS) || 45000;

/** node-fetch@2 marca timeout com type='request-timeout'. */
function _isTimeoutError(err) {
  return Boolean(err && (err.type === 'request-timeout' || /timeout/i.test(err.message || '')));
}

const WPA_AUTH = process.env.WPA_URL      || 'https://edp-wpa-po.azurewebsites.net';
const WPA_API  = process.env.WPA_API_URL  || 'https://edp-wpa-web-api.azurewebsites.net';

// ── MULTI-CONTA ─────────────────────────────────────────────────────────────
// Suporta múltiplas contas WPA, uma por regional/empresa. Cada conta tem
// suas próprias credenciais no .env e seu próprio token JWT.
//
// Adicionado em 08/06/2026 pra incluir regional SJC (EDP SP) com conta
// separada da Clarissa (ES).
//
//   account='es'   → WPA_USERNAME        / WPA_PASSWORD        (Clarissa, GUA/CAC)
//   account='sp'   → WPA_USERNAME_SP     / WPA_PASSWORD_SP     (SJC — conta do Ismael)
//   account='sp2'  → WPA_USERNAME_SP2    / WPA_PASSWORD_SP2    (SJC — BACKUP)
//
// SECTOR_ACCOUNT_CHAIN mapeia sectorId → CADEIA de contas (failover). A 1ª
// USÁVEL (não desativada e sem breaker aberto) é escolhida por requisição.
const ACCOUNTS = {
  es:  { userEnv: 'WPA_USERNAME',     passEnv: 'WPA_PASSWORD'     },
  sp:  { userEnv: 'WPA_USERNAME_SP',  passEnv: 'WPA_PASSWORD_SP'  },
  sp2: { userEnv: 'WPA_USERNAME_SP2', passEnv: 'WPA_PASSWORD_SP2' },
};
const DEFAULT_ACCOUNT = 'es';

// Cadeia de contas por setor (failover 13/08/2026). SJC tem primária (Ismael) +
// BACKUP: a backup SÓ é usada quando a primária "para de funcionar" — desativada
// (WPA_ACCOUNTS_DISABLED) ou com breaker aberto (credencial inválida / conta
// bloqueada). Setor não mapeado → [DEFAULT_ACCOUNT].
//   ⚠️ "não travar a backup por nossa causa" é garantido pelo circuit breaker
//   (P1-20): no máximo 1 tentativa de login por janela de cooldown (12h em
//   credencial inválida) — nunca chega às 5 tentativas que a EDP usa pra travar.
const SECTOR_ACCOUNT_CHAIN = {
  DESG: ['es'], DESC: ['es'], DEPT: ['es'],
  DSSJ: ['sp', 'sp2'],
};

/** Resolve account a partir de sectorId (ou default se não mapeado). */
/**
 * Map paralelo com cap de concorrência. Substitui `Promise.all(arr.map(...))`
 * quando cada item dispara fetches pesados — evita saturar o pool de
 * conexões HTTP (undici default = 6/origin) e o rate limit da EDP.
 * Mantém a ordem do array original.
 */
async function _mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await mapper(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

/** Cadeia de contas de um setor (ordem de failover). Sempre array não-vazio. */
function _accountsForSector(sectorId) {
  if (!sectorId) return [DEFAULT_ACCOUNT];
  return SECTOR_ACCOUNT_CHAIN[String(sectorId).toUpperCase()] || [DEFAULT_ACCOUNT];
}

/** Conta PRIMÁRIA do setor (1ª da cadeia). Pra mensagens/status; não roteia. */
function _accountForSector(sectorId) {
  return _accountsForSector(sectorId)[0];
}

/**
 * Conta USÁVEL do setor agora, percorrendo a cadeia de failover: pula contas
 * DESATIVADAS (kill-switch) e com BREAKER ABERTO (pararam de funcionar). A
 * backup só entra quando a primária cai — exatamente a regra pedida. Se nenhuma
 * está usável, devolve a ÚLTIMA (o erro propaga limpo, sem tentar /signin à toa).
 */
function _resolveUsableAccount(sectorId) {
  const chain = _accountsForSector(sectorId);
  for (const acc of chain) {
    if (isAccountDisabled(acc)) continue;
    if (_breakerRemaining(acc) > 0) continue;
    return acc;
  }
  return chain[chain.length - 1];
}

/** Extrai sectorId de um path (?sectorId=X) pra rotear pra conta correta. */
function _sectorFromPath(path) {
  const m = String(path || '').match(/[?&]sectorId=([^&]+)/);
  return m ? m[1] : null;
}

// Estado por conta: token, expireAt, loginPromise serializada.
const _tokens = new Map();   // accountKey → { token, expireAt }
const _loginPromises = new Map();   // accountKey → Promise pendente (serializa concorrência)

// ── CIRCUIT BREAKER de login (P1-20, incidente 13/08/2026) ───────────────────
// Quando a EDP rejeita a credencial ("Usuário ou senha inválidos") ou bloqueia a
// conta ("aguarde até HH:MM"), tentar de novo NÃO ajuda — só queima o orçamento
// de 5 tentativas da EDP e trava a conta. Como cada trigger (snapshot, notas,
// teams, cron de token das 45min) pede token de forma independente, sem breaker
// eles reaprendem o erro um a um e, em 5 tentativas espalhadas, a conta trava:
// foi o que aconteceu em 13/08 — 17:45 OK → 18:00 "senha inválida" → 18:30
// "bloqueado até 03:30", coleta parada a noite toda.
//
// O breaker guarda, POR CONTA, um `until`: enquanto vigente, login() rejeita SEM
// tocar no /signin (1 tentativa e para). Reseta em: login bem-sucedido, reinício
// do processo (estado é em memória de propósito — .env corrigido + restart
// recupera na hora), ou fim do `until`. Erro transiente (rede / Azure cold-start)
// NÃO abre o breaker.
const _breaker = new Map();   // accountKey → { until: ms, kind, message }

// Credencial inválida NÃO se cura sozinha (só troca de .env + restart). Por isso
// o cooldown é longo: garante ~1 tentativa por janela → nunca chega a 5 → nunca
// trava a conta. O restart limpa o estado, então isto não atrasa a recuperação.
const INVALID_CRED_COOLDOWN_MS =
  (Number(process.env.WPA_INVALID_CRED_COOLDOWN_MIN) || 720) * 60_000;   // default 12h
const LOCKED_FALLBACK_COOLDOWN_MS = 4 * 3_600_000;   // se não der pra ler o "HH:MM"

// ── P1-32 (20/08/2026): o breaker era FAIL-OPEN ──────────────────────────────
// `_classifyLoginError` são dois regexes em PORTUGUÊS; qualquer outra mensagem
// caía em 'other' e o breaker NÃO abria. Ou seja: a proteção inteira dependia de
// uma string que a EDP controla. Se ela trocar o texto ("Senha incorreta", "Too
// many attempts") ou passar a responder 429/HTML no /signin, cada trigger
// independente (snapshot */15, cron de token, notas xx:05, /api/teams de cada
// browser, classifier) volta a gastar uma tentativa — o incidente de 13/08 de
// novo. Agora 'other' também abre, num cooldown CURTO e só a partir da 2ª falha
// não-transiente consecutiva (a 1ª pode ser um soluço real da API).
const UNKNOWN_ERROR_COOLDOWN_MS =
  (Number(process.env.WPA_UNKNOWN_ERROR_COOLDOWN_MIN) || 20) * 60_000;
const UNKNOWN_FAILS_TO_OPEN = 2;
const _unknownFails = new Map();   // accountKey → falhas 'other' consecutivas

/** Classifica a mensagem de erro de login da WPA. Pura. */
function _classifyLoginError(message) {
  const m = String(message || '');
  if (/bloquead|aguarde\s+at[ée]/i.test(m)) return { kind: 'account_locked' };
  if (/usu[áa]rio\s+ou\s+senha\s+inv[áa]lid|senha\s+inv[áa]lid|invalid\s+(user|password|credential)/i.test(m)) {
    return { kind: 'invalid_credential' };
  }
  return { kind: 'other' };
}

/**
 * Extrai "aguarde até HH:MM" e devolve o timestamp (ms) da PRÓXIMA ocorrência
 * desse horário em BRT a partir de `nowMs`, com 2 min de margem. null se não achar.
 * Puro (nowMs injetável pra teste). BRT = UTC-3, calculado só a partir do epoch.
 */
function _computeUnlockUntil(message, nowMs = Date.now()) {
  const m = String(message || '').match(/aguarde\s+at[ée]\s*(\d{1,2}):(\d{2})/i);
  if (!m) return null;
  const targetMin = (+m[1]) * 60 + (+m[2]);
  const brt = new Date(nowMs - 3 * 3_600_000);
  const nowMin = brt.getUTCHours() * 60 + brt.getUTCMinutes();
  let delta = targetMin - nowMin;
  if (delta <= 0) delta += 1440;                       // vira o dia
  return nowMs + delta * 60_000 + 2 * 60_000;          // +2 min de margem
}

/** ms restantes do breaker pra conta (0 = fechado). Limpa a entrada expirada. */
function _breakerRemaining(accountKey, nowMs = Date.now()) {
  const b = _breaker.get(accountKey);
  if (!b) return 0;
  const left = b.until - nowMs;
  if (left <= 0) { _breaker.delete(accountKey); return 0; }
  return left;
}

/**
 * Abre o breaker pra conta conforme a classificação.
 * 'other' (mensagem desconhecida) abre cooldown CURTO a partir da 2ª falha
 * consecutiva — ver P1-32. Erro transiente nem chega aqui.
 */
function _openBreaker(accountKey, message, nowMs = Date.now()) {
  const cls = _classifyLoginError(message);

  if (cls.kind === 'other') {
    const n = (_unknownFails.get(accountKey) || 0) + 1;
    _unknownFails.set(accountKey, n);
    if (n < UNKNOWN_FAILS_TO_OPEN) return null;
    const until = nowMs + UNKNOWN_ERROR_COOLDOWN_MS;
    _breaker.set(accountKey, {
      until, kind: 'unknown_error', message: String(message).slice(0, 200),
    });
    _persistBreaker();
    return { kind: 'unknown_error', until };
  }

  _unknownFails.delete(accountKey);
  const until = cls.kind === 'account_locked'
    ? (_computeUnlockUntil(message, nowMs) || (nowMs + LOCKED_FALLBACK_COOLDOWN_MS))
    : (nowMs + INVALID_CRED_COOLDOWN_MS);
  _breaker.set(accountKey, { until, kind: cls.kind, message: String(message).slice(0, 200) });
  _persistBreaker();
  return { kind: cls.kind, until };
}

function _clearBreaker(accountKey) {
  const tinhaEstado = _breaker.has(accountKey) || _unknownFails.has(accountKey);
  _breaker.delete(accountKey);
  _unknownFails.delete(accountKey);
  // Só escreve no banco se havia algo a limpar — senão todo login bem-sucedido
  // faria um UPDATE inútil em app_settings.
  if (tinhaEstado) _persistBreaker();
}

// ── P1-29 (20/08/2026): breaker PERSISTIDO ───────────────────────────────────
// O breaker era só em memória, "de propósito: .env corrigido + restart recupera
// na hora". O custo dessa escolha só apareceu na revisão paralela: `autorestart`
// + `max_memory_restart` (e o crash-loop de 161 restarts num dia registrado no
// ecosystem.config.js) zeram o breaker a cada boot — e o boot AINDA disparava um
// /signin obrigatório. Com credencial errada, 5 restarts em menos de um minuto =
// conta travada na EDP. Era exatamente o incidente da conta do Ismael, com a
// proteção do P1-20 no ar e sem efeito.
//
// Agora o estado vive em app_settings.wpa_breaker e é lido UMA vez antes do
// primeiro /signin. Falha de banco nunca derruba o login: sem hidratação, o
// comportamento degrada para o de antes (memória só).
// Recuperação manual segue simples: corrigir o .env e apagar a chave
//   DELETE FROM app_settings WHERE key = 'wpa_breaker';
// (ou esperar o `until`). Está no RUNBOOK.
const BREAKER_SETTING_KEY = 'wpa_breaker';
let _breakerHydrated = false;
let _breakerHydrating = null;

/** Grava o mapa inteiro do breaker. Fire-and-forget: erro de banco é ignorado. */
function _persistBreaker() {
  (async () => {
    try {
      const sq = require('../db/queries');
      const accounts = {};
      for (const [k, v] of _breaker.entries()) accounts[k] = v;
      await sq.setSetting(BREAKER_SETTING_KEY, { accounts, ts: new Date().toISOString() });
    } catch (_) { /* breaker persistido é best-effort */ }
  })();
}

/** Lê o breaker do banco uma única vez por processo. Entradas expiradas são ignoradas. */
async function _hydrateBreaker() {
  if (_breakerHydrated) return;
  if (!_breakerHydrating) {
    _breakerHydrating = (async () => {
      try {
        const sq = require('../db/queries');
        const row = await sq.getSetting(BREAKER_SETTING_KEY);
        const accounts = (row && row.data && row.data.accounts) || {};
        const now = Date.now();
        for (const [k, v] of Object.entries(accounts)) {
          const until = Number(v && v.until);
          if (!until || until <= now) continue;
          // Não sobrescreve o que já foi aprendido nesta execução.
          if (_breaker.has(k)) continue;
          _breaker.set(k, { until, kind: v.kind, message: v.message });
          console.warn(
            `[WPA] Breaker RESTAURADO do banco (account=${k}, ${v.kind}) até ` +
            `${new Date(until).toISOString()} — não vou tentar /signin até lá.`);
        }
      } catch (_) { /* sem banco → degrada pro comportamento antigo (memória só) */ }
      _breakerHydrated = true;
    })();
  }
  return _breakerHydrating;
}

// ── CONTA DESATIVADA (kill-switch operacional) ───────────────────────────────
// Desliga POR COMPLETO a extração de uma conta WPA — nem tenta login. Uso: a
// credencial foi revogada/errada e não queremos NENHUMA tentativa (nem a 1 por
// 12h do breaker) até resolver com a EDP/dono da conta. Diferente do breaker
// (que é automático e temporário), este é uma decisão MANUAL, via .env:
//
//     WPA_ACCOUNTS_DISABLED=sp           (CSV de accountKeys; ex.: sp  ou  sp,es)
//
// Enquanto desativada: getTeamsBySector devolve [] (sem rede) e login() recusa.
// Reativar = tirar do .env e reiniciar. ⚠️ Os dados dessa conta NÃO são coletados
// no período — a API WPA só serve o ESTADO ATUAL, então NÃO dá pra backfill
// depois. (Se a conta já está travada/senha errada, o dado já está sendo perdido
// agora de qualquer jeito — desativar só evita re-travar e o spam de erro.)
const _disabledAccounts = new Set(
  String(process.env.WPA_ACCOUNTS_DISABLED || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);
function isAccountDisabled(accountKey) {
  return _disabledAccounts.has(String(accountKey || '').toLowerCase());
}
/** Setor desativado? SÓ se TODA a cadeia de contas está desativada (com failover,
 *  desativar a primária não desativa o setor enquanto a backup estiver ativa). */
function isSectorDisabled(sectorId) {
  const chain = _accountsForSector(sectorId);
  return chain.length > 0 && chain.every(acc => isAccountDisabled(acc));
}
const _disabledLogged = new Set();   // evita spam: loga o skip 1x por setor/boot

// Cache compartilhado em Supabase — opcional (lazy require pra evitar circular
// dep e permitir rodar sem Supabase em dev/test). Carregado na primeira
// chamada de loadCachedToken/saveCachedToken.
let _tokenStore = null;
function getTokenStore() {
  if (_tokenStore) return _tokenStore;
  if (!process.env.SUPABASE_SERVICE_KEY) return null; // sem Supabase configurado
  try {
    _tokenStore = require('../db/wpaTokenStore');
  } catch (err) {
    console.warn(`[WPA] wpaTokenStore indisponível: ${err.message}`);
    _tokenStore = null;
  }
  return _tokenStore;
}

// ── AUTH ──────────────────────────────────────────────────────────────────────

/**
 * Tenta uma única vez fazer login. Marca erros como `isAzureColdStart` (quando
 * o App Service do WPA responde 403 com a página HTML "Web App - Unavailable"
 * — típico de hibernação/cold-start no Azure) ou `isNetworkError` (fetch jogou
 * exceção: timeout, DNS, conexão recusada). O `login()` externo usa essas flags
 * para decidir retry — erros legítimos (ex: 401 credencial inválida) não retry.
 */
async function loginAttempt(accountKey = DEFAULT_ACCOUNT) {
  const acc = ACCOUNTS[accountKey];
  if (!acc) throw new Error(`account desconhecida: ${accountKey}`);
  const username = process.env[acc.userEnv] || '';
  const password = process.env[acc.passEnv] || '';
  if (!username || !password) {
    throw new Error(`credenciais ausentes pra account=${accountKey} (${acc.userEnv}/${acc.passEnv})`);
  }

  const body = new URLSearchParams({ Username: username, Password: password });

  let res;
  try {
    res = await fetch(`${WPA_AUTH}/identity/signin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: body.toString(),
      timeout: WPA_HTTP_TIMEOUT_MS,   // P1-31 — sem isso o login podia pendurar pra sempre
    });
  } catch (err) {
    err.isNetworkError = true;
    throw err;
  }

  if (!res.ok) {
    const txt = await res.text();
    const isAzureColdStart = /Web App\s*-\s*Unavailable/i.test(txt);
    const tag = isAzureColdStart ? ' [Azure cold-start]' : '';
    const error = new Error(`WPA login falhou (${res.status}, account=${accountKey})${tag}: ${txt.slice(0, 200)}`);
    error.isAzureColdStart = isAzureColdStart;
    error.httpStatus       = res.status;
    throw error;
  }

  const data = await res.json();

  if (!data.Token) {
    const msg = data.Error?.Message || 'Token não retornado';
    throw new Error(`WPA login (account=${accountKey}): ${msg}`);
  }

  let expireAt;
  try {
    const [, payload] = data.Token.split('.');
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
    expireAt = decoded.exp ? decoded.exp * 1000 : Date.now() + 3_600_000;
  } catch {
    expireAt = Date.now() + 3_600_000;
  }

  _tokens.set(accountKey, { token: data.Token, expireAt });

  const userId = data.UserIdId || data.UserId || null;
  console.log(`[WPA] Login OK (account=${accountKey}) — userId=${userId}  exp=${new Date(expireAt).toISOString()}`);

  // Grava no cache compartilhado (Supabase) — outros containers/processos
  // (ex: Lambdas Vercel) leem daqui antes de tentar login próprio.
  // saveToken não throws; falhas são logadas mas não quebram o login.
  const store = getTokenStore();
  if (store) {
    store.saveToken(data.Token, expireAt, userId, accountKey)
      .catch(err => console.warn(`[WPA] saveToken falhou (account=${accountKey}):`, err && err.message ? err.message : err));
  }

  return { token: data.Token, userId };
}

/**
 * Login com retry exponencial p/ erros transientes do Azure App Service.
 *
 * Cenário comum: cold-start do edp-wpa-po (App Service do WPA Auth) —
 * primeira request retorna 403 com HTML "Web App - Unavailable" enquanto
 * o container está iniciando. Geralmente sobe em 5-15s.
 *
 * Estratégia: até 3 tentativas com backoff [2s, 5s]. Total ~7s de espera
 * antes de propagar o erro pra UI (que já mostra wpaStatus real).
 *
 * Erros legítimos (401 credencial errada, etc) não fazem retry — propaga já.
 */
async function login(opts = {}) {
  const accountKey = opts.account || DEFAULT_ACCOUNT;

  // Kill-switch manual: conta desativada no .env não tenta login de jeito nenhum.
  if (isAccountDisabled(accountKey) && !opts.force) {
    const err = new Error(
      `WPA login (account=${accountKey}) DESATIVADO (WPA_ACCOUNTS_DISABLED) — ` +
      `extração pausada por decisão operacional; não tentando /signin.`);
    err.isAccountDisabled = true;
    throw err;
  }

  // Circuit breaker (P1-20): se a conta está em cooldown por credencial inválida
  // ou bloqueio, NÃO toca no /signin — devolve o erro conhecido, poupando o
  // orçamento de tentativas da EDP. `opts.force` é escape-hatch manual (ignora o
  // breaker) — hoje sem chamador.
  //
  // P1-29: o estado sobrevive a restart (app_settings.wpa_breaker), então a
  // recuperação NÃO é mais "reiniciar" — é corrigir o .env e apagar a chave
  // (ou esperar o `until`). Hidrata antes da primeira decisão.
  if (!opts.force) {
    await _hydrateBreaker();
    const remaining = _breakerRemaining(accountKey);
    if (remaining > 0) {
      const b = _breaker.get(accountKey);
      const err = new Error(
        `WPA login (account=${accountKey}) em cooldown [${b.kind}] por ~${Math.ceil(remaining / 60000)}min — ` +
        `não tentando /signin pra não travar a conta na EDP. Corrija a credencial (.env) e ` +
        `apague a chave: DELETE FROM app_settings WHERE key='wpa_breaker'; (restart NÃO limpa mais — P1-29). ` +
        `Original: ${b.message}`);
      err.isBreakerOpen = true;
      err.breakerKind = b.kind;
      throw err;
    }
  }

  // Backoff calibrado p/ Azure cold-start do edp-wpa-po. Em produção foi
  // observado cold-start de até 25-30s — backoff agressivo cobre isso.
  // Cliente pode pedir backoff mais longo via opts.aggressive (rota /admin/warm).
  const BACKOFF_MS = opts.aggressive
    ? [5000, 10000, 15000, 18000]   // ~48s — para warm/admin onde tempo é OK
    : [4000,  8000, 14000];          // ~26s — para chamadas de usuário
  const MAX_ATTEMPTS = BACKOFF_MS.length + 1;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await loginAttempt(accountKey);
      _clearBreaker(accountKey);   // sucesso → fecha o breaker
      if (attempt > 1) console.log(`[WPA] Login OK (account=${accountKey}) na tentativa ${attempt}/${MAX_ATTEMPTS}`);
      return result;
    } catch (err) {
      const transient = err.isAzureColdStart || err.isNetworkError;
      if (!transient || attempt === MAX_ATTEMPTS) {
        // Antes de propagar: se for credencial inválida/bloqueio, abre o breaker
        // pra que os próximos triggers não gastem tentativa (P1-20).
        const opened = _openBreaker(accountKey, err.message);
        if (opened) {
          console.warn(
            `[WPA] Breaker ABERTO (account=${accountKey}, ${opened.kind}) até ` +
            `${new Date(opened.until).toISOString()} — logins suspensos pra não travar ` +
            `a conta. Corrija a credencial no .env e reinicie o processo.`);
        }
        throw err;
      }
      const delay = BACKOFF_MS[attempt - 1];
      const reason = err.isAzureColdStart ? 'Azure cold-start' : 'erro de rede';
      console.warn(`[WPA] Login tentativa ${attempt}/${MAX_ATTEMPTS} (account=${accountKey}) falhou (${reason}: ${err.message.slice(0, 80)}) — retry em ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function getToken(accountKey = DEFAULT_ACCOUNT) {
  // 1. Cache em memória válido → usa direto (caso normal, 0 latência adicional)
  const cached = _tokens.get(accountKey);
  if (cached && !_deadTokens.has(cached.token) && Date.now() < cached.expireAt - 60_000) return cached.token;

  // 2. Cache compartilhado (Supabase) — evita login redundante entre containers.
  //    Em Lambdas Vercel cold-start, o token gravado pelo cron rpa1 (que mantém
  //    WPA quente) é lido aqui em ~50ms, sem bater no /signin do WPA.
  const store = getTokenStore();
  if (store) {
    try {
      const fromStore = await store.loadToken(accountKey);
      // !_deadTokens: o cache do banco pode guardar justamente o token que a EDP
      // acabou de recusar — readotá-lo faz o request seguinte falhar igual.
      if (fromStore?.token && !_deadTokens.has(fromStore.token) && Date.now() < fromStore.expiresAt - 60_000) {
        _tokens.set(accountKey, { token: fromStore.token, expireAt: fromStore.expiresAt });
        console.log(`[WPA] Token (account=${accountKey}) carregado do cache Supabase — exp=${new Date(fromStore.expiresAt).toISOString()}`);
        return fromStore.token;
      }
    } catch { /* fallthrough p/ login */ }
  }

  // 3. Login fresco — serializa logins concorrentes dentro do mesmo processo
  //    via _loginPromises (Map por account) — evita race onde WPA invalida
  //    o token do primeiro login ao receber o segundo. Login bem-sucedido
  //    grava no Supabase.
  //
  //    Cross-process: aplicamos double-check antes do login real — outro
  //    container pode ter terminado de gravar o token enquanto chegávamos aqui.
  if (!_loginPromises.has(accountKey)) {
    const p = (async () => {
      // Double-check: outro processo pode ter completado o login por nós
      if (store) {
        try {
          const fromStore = await store.loadToken(accountKey);
          if (fromStore?.token && !_deadTokens.has(fromStore.token) && Date.now() < fromStore.expiresAt - 60_000) {
            _tokens.set(accountKey, { token: fromStore.token, expireAt: fromStore.expiresAt });
            console.log(`[WPA] Token (account=${accountKey}) via double-check (outro container ganhou a corrida)`);
            return;
          }
        } catch { /* fallthrough — tenta login real */ }
      }
      await login({ account: accountKey });
    })().finally(() => { _loginPromises.delete(accountKey); });
    _loginPromises.set(accountKey, p);
  }
  await _loginPromises.get(accountKey);
  return _tokens.get(accountKey)?.token;
}

/** Força novo login independente do TTL atual.
 *  opts.aggressive=true → backoff longo (até ~48s); usado pelo /admin/warm.
 *  opts.account → conta específica ('es' default ou 'sp'). */
async function forceRefresh(opts = {}) {
  return login(opts);
}

/**
 * Retorna o estado atual do token sem fazer nenhuma chamada de rede.
 * Sem argumento → estado da conta default (ES, retrocompat).
 * Com accountKey → estado dessa conta.
 */
function getTokenStatus(accountKey = DEFAULT_ACCOUNT) {
  const now = Date.now();
  const cached = _tokens.get(accountKey);
  if (!cached?.token) return { valid: false, reason: 'sem token', expiresAt: null, expiresIn: null, account: accountKey };
  if (now >= cached.expireAt) return { valid: false, reason: 'expirado', expiresAt: new Date(cached.expireAt).toISOString(), expiresIn: '0s', account: accountKey };
  const secsLeft = Math.round((cached.expireAt - now) / 1000);
  return { valid: true, reason: 'ok', expiresAt: new Date(cached.expireAt).toISOString(), expiresIn: `${secsLeft}s`, account: accountKey };
}

// ── TOKEN MORTO E POLÍTICA DE RENOVAÇÃO ─────────────────────────────
//
// 22/08/2026 — comparação com os outros três projetos da empresa que consomem a
// mesma API WPA (GQO, SJC e o ES legado) trouxe duas coisas que não estavam aqui:
//
// (a) A EDP NÃO sinaliza token vencido só com 401/403. Na maioria dos endpoints
//     de dados a resposta é **500** com corpo
//     {"ExceptionMessage": "Token is invalid! -> Bearer eyJhbG..."}.
//     O nosso wpaFetch propagava "500 com JSON" sem retry e sem relogin, e
//     _safeNotes engolia a exceção devolvendo bucket vazio: token morto virava
//     "equipe sem rejeitadas e sem executadas", gravado no snapshot como se fosse
//     realidade. É a mesma classe de falha do timeout curto de 21/08/2026, por
//     outra porta — e nada no banco distinguia "falhou" de "não teve".
//
// (b) Renovar por relógio queima a conta. O cron de token chamava forceRefresh()
//     (= /signin incondicional) às :00 e :45, 32 logins/dia, na conta `es`
//     (clarissa.alves) que o projeto GQO usa para os MESMOS setores DESG/DESC/DEPT
//     (P1-25). Como a WPA invalida o token anterior ao receber um login novo (ver
//     _loginPromises abaixo), os dois sistemas se derrubavam mutuamente — e o
//     sintoma visível era (a). O `exp` do JWT, que já decodificamos no login,
//     passa a decidir: só reloga dentro da margem.
const _TOKEN_INVALID_RE = /Token is invalid/i;

// Tokens que a EDP já recusou. Sem isso _invalidateToken limpa a memória e o
// getToken readota o MESMO token morto do cache do banco no request seguinte.
const _deadTokens = new Set();
const _DEAD_TOKENS_MAX = 20;

/** Margem antes do `exp` em que vale relogar. 30 min cobre um ciclo de snapshot. */
const TOKEN_REFRESH_MARGIN_MS = Number(process.env.WPA_TOKEN_REFRESH_MARGIN_MS) || 30 * 60_000;

/**
 * A resposta é a EDP dizendo que o token morreu?
 * 401 sempre; 500 e 403 só com a assinatura medida — 403 com HTML é cold-start do
 * Azure (tratado antes, com retry), e confundir os dois faria o sistema relogar a
 * cada hibernação do App Service, queimando a conta compartilhada.
 */
function _isTokenInvalidBody(status, text) {
  if (status === 401) return true;
  if (status !== 500 && status !== 403) return false;
  return _TOKEN_INVALID_RE.test(String(text || ''));
}

async function _isTokenInvalidResponse(res) {
  if (!res || res.ok) return false;
  if (res.status === 401) return true;
  if (res.status !== 500 && res.status !== 403) return false;
  try {
    return _isTokenInvalidBody(res.status, await res.clone().text());
  } catch {
    return false;   // corpo ilegível: não assume token morto
  }
}

/** Descarta o token da conta e o marca como morto (memória + cache do banco). */
function _invalidateToken(accountKey) {
  const cached = _tokens.get(accountKey);
  if (cached?.token) {
    _deadTokens.add(cached.token);
    if (_deadTokens.size > _DEAD_TOKENS_MAX) _deadTokens.delete(_deadTokens.values().next().value);
  }
  _tokens.delete(accountKey);
}

/** true se vale gastar um /signin: sem token, exp ilegível, ou dentro da margem. */
function _needsTokenRefresh(cached, now = Date.now(), marginMs = TOKEN_REFRESH_MARGIN_MS) {
  if (!cached || !cached.token) return true;
  const exp = cached.expireAt;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return true;
  return now >= exp - marginMs;
}

/**
 * O que o cron de token deve chamar: mantém o token quente SEM /signin
 * desnecessário. Só toca a rede quando _needsTokenRefresh diz que vale.
 * @returns {Promise<{refreshed: boolean, expireAt: number|null, account: string}>}
 */
async function ensureFreshToken(accountKey = DEFAULT_ACCOUNT) {
  const cached = _tokens.get(accountKey);
  if (!_needsTokenRefresh(cached)) {
    return { refreshed: false, expireAt: cached.expireAt, account: accountKey };
  }
  await getToken(accountKey);   // memória → banco → /signin, com single-flight
  return { refreshed: true, expireAt: _tokens.get(accountKey)?.expireAt ?? null, account: accountKey };
}
// ── FETCH HELPER ──────────────────────────────────────────────────────────────

/**
 * Detecta se uma resposta é a página HTML de cold-start do Azure App Service
 * (header content-type=text/html + body contendo "Web App - Unavailable").
 * Consome o body via clone() para não quebrar o read posterior.
 */
async function _isAzureColdStartResponse(res) {
  const ctype = res.headers.get('content-type') || '';
  if (!ctype.includes('text/html') && res.status !== 503 && res.status !== 403) return false;
  try {
    const txt = await res.clone().text();
    return /Web App\s*-\s*Unavailable/i.test(txt);
  } catch { return false; }
}

/**
 * Faz fetch contra a Web API do WPA com retry em caso de:
 *   • Cold-start do Azure App Service (edp-wpa-web-api) — 403/503 com HTML "Unavailable"
 *   • Erro de rede (timeout, conexão recusada)
 * Backoff alinhado com login() — total ~21s de paciência.
 *
 * Importante: erros legítimos da API (401/404/500 com JSON) são propagados
 * direto sem retry, pra não esconder problemas reais.
 */
async function wpaFetch(path, options = {}) {
  // Resolve qual conta usar pra essa requisição:
  //   1. options.account explícito (chamadas internas sabem qual conta)
  //   2. Inferir do sectorId no path (?sectorId=DSSJ → cadeia [sp, sp2], pega a
  //      1ª usável → failover automático pra backup quando a primária cai)
  //   3. Default: 'es' (Clarissa)
  const accountKey = options.account
    || _resolveUsableAccount(_sectorFromPath(path))
    || DEFAULT_ACCOUNT;

  // Backoff mais curto que o do login: a Web API costuma estar quente quando
  // o auth está; só protege contra cold-start ocasional. Total ~9s.
  const BACKOFF_MS = [3000, 6000];
  const MAX_ATTEMPTS = BACKOFF_MS.length + 1;

  let tokenRetried = false;   // relogin por token recusado: no máximo 1 por request

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const token = await getToken(accountKey);
    let res;
    try {
      res = await fetch(`${WPA_API}${path}`, {
        timeout: WPA_HTTP_TIMEOUT_MS,   // P1-31 — options pode sobrescrever se precisar
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(options.headers || {}),
        },
      });
    } catch (err) {
      // Timeout NÃO é retentado: o socket ficou pendurado ou a API está fora do
      // aceitável, e 3 tentativas de 45s multiplicariam a espera do usuário por
      // três sem melhorar a chance. Cold-start de verdade chega como RESPOSTA
      // HTTP (403/503 com HTML) e é tratado logo abaixo, não como timeout.
      if (_isTimeoutError(err)) {
        console.warn(`[WPA] wpaFetch ${path} TIMEOUT em ${WPA_HTTP_TIMEOUT_MS}ms (tentativa ${attempt}) — sem retry`);
        throw err;
      }
      if (attempt === MAX_ATTEMPTS) throw err;
      const delay = BACKOFF_MS[attempt - 1];
      console.warn(`[WPA] wpaFetch ${path} erro de rede (tentativa ${attempt}/${MAX_ATTEMPTS}): ${err.message} — retry em ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    // Cold-start do App Service da Web API → retry
    if (await _isAzureColdStartResponse(res)) {
      if (attempt === MAX_ATTEMPTS) {
        console.warn(`[WPA] wpaFetch ${path} cold-start persistente (${MAX_ATTEMPTS} tentativas) — desistindo`);
        return res;
      }
      const delay = BACKOFF_MS[attempt - 1];
      console.warn(`[WPA] wpaFetch ${path} Azure cold-start (tentativa ${attempt}/${MAX_ATTEMPTS}) — retry em ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    // Token recusado pela EDP → invalida e tenta de novo UMA vez com token novo.
    // Sem isso o 500 "Token is invalid!" chegava como exceção ao _safeNotes, que
    // devolvia bucket vazio, e o snapshot gravava "equipe sem produção".
    // Checado DEPOIS do cold-start: 403 com HTML é Azure hibernando, não token.
    if (!tokenRetried && await _isTokenInvalidResponse(res)) {
      tokenRetried = true;
      _invalidateToken(accountKey);
      if (attempt === MAX_ATTEMPTS) {
        console.warn(`[WPA] wpaFetch ${path} token recusado (HTTP ${res.status}, conta=${accountKey}) na última tentativa — propagando`);
        return res;
      }
      console.warn(`[WPA] wpaFetch ${path} token recusado pela EDP (HTTP ${res.status}, conta=${accountKey}) — relogando e repetindo`);
      continue;
    }

    return res;
  }
}

// ── ENDPOINTS ─────────────────────────────────────────────────────────────────

/**
 * Extrai o horário de início da escala a partir do ShiftType do WPA.
 * Formato observado: "T07 07:00", "T15 15:00", "T14 14:00".
 * Retorna "HH:MM" ou null se não conseguir parsear.
 *
 * Essa é a escala REAL da EDP (mesma coluna "Escala" da tela Gestão de
 * Equipes). Usada pra sincronizar equipes_oficiais.escala_inicio e corrigir
 * o indicador de atraso de logon no Monitor.
 */
function _parseShiftStart(shiftType) {
  if (!shiftType) return null;
  const m = String(shiftType).match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const hh = String(m[1]).padStart(2, '0');
  return `${hh}:${m[2]}`;
}

/**
 * Calcula o fim da escala como início + 9h (8h trabalho + 1h refeição,
 * turno padrão Engelmig). O WPA não informa o fim do turno, só o início
 * (ShiftType). Wrap em 24h: 15:00 + 9h → 00:00.
 * @param {string} hhmm  "HH:MM"
 * @returns {string|null} "HH:MM"
 */
function _shiftEndFromStart(hhmm, horas = 9) {
  if (!hhmm) return null;
  const m = String(hhmm).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const totalMin = ((parseInt(m[1], 10) + horas) * 60 + parseInt(m[2], 10)) % (24 * 60);
  const hh = String(Math.floor(totalMin / 60)).padStart(2, '0');
  const mm = String(totalMin % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

// ── BUSCA DE NOTA PELO NÚMERO (search/SearchNotesByNumber) ───────────────────
//
// 22/08/2026: `details/optimized` e `historic` só aceitam o UUID da nota, mas a
// operação — e a EDP, quando questiona algo em auditoria — cita o NÚMERO. Este
// endpoint é a ponte, e não existia aqui: a rota /api/wpa/nota resolvia número
// varrendo `teams_current`, e logava "não encontrado" justamente para nota que
// não é do dia corrente, que é o caso de auditoria.
//
// Aqui `Data` é OBJETO, não lista — ao contrário da maioria dos endpoints.
const _NOTE_NUMBER_RE = /^\d{4,15}$/;

/**
 * O valor pode ir na query string como número de nota?
 * Só dígitos: o número entra numa URL que carrega o nosso Bearer, então nada de
 * `&`, espaço ou `..` — mesma preocupação do P1-4 (SSRF no /wpa/probe).
 */
function _isNoteNumber(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'number') return Number.isInteger(v) && _NOTE_NUMBER_RE.test(String(v));
  return typeof v === 'string' && _NOTE_NUMBER_RE.test(v.trim());
}

/** Resposta do SearchNotesByNumber → { id, numero, equipe, tipo } ou null. */
function _normalizeSearchNote(payload) {
  let d = payload?.Data;
  if (Array.isArray(d)) d = d[0];        // se a EDP virar a resposta em lista
  if (!d || !d.Id) return null;          // sem UUID não serve pra nada
  const team = d.Team;
  return {
    id:     d.Id,
    numero: d.Number !== null && d.Number !== undefined ? String(d.Number) : null,
    equipe: (typeof team === 'string' ? team : team?.Name) || null,
    tipo:   d.Type || null,
  };
}

/**
 * Nota a partir do número humano.
 * GET /api/search/SearchNotesByNumber?noteNumber={N}
 * @returns {Promise<{id,numero,equipe,tipo}|null>} null = a WPA não achou.
 */
async function searchNoteByNumber(noteNumber) {
  if (!_isNoteNumber(noteNumber)) throw new Error(`número de nota inválido: "${noteNumber}"`);
  const n = String(noteNumber).trim();
  const res = await wpaFetch(`/api/search/SearchNotesByNumber?noteNumber=${encodeURIComponent(n)}`);
  if (!res.ok) throw new Error(`WPA SearchNotesByNumber ${res.status}`);
  return _normalizeSearchNote(await res.json());
}

// ── ESCALA CADASTRADA DO MÊS (collaboratorshifts) ────────────────────────────
//
// A escala PLANEJADA, em três níveis: equipe → colaboradores → escalas por dia.
// É o dado que faltava para o P1-26 (o "equipe não logou" do /admin/health acusa
// quem está de folga) e para o P2-24 (não existia cadastro de escala por dia).
//
// Uma chamada por setor e mês. O ano é PARÂMETRO: no legado dos outros projetos
// ele estava hardcoded (`.../{mes}/2026`), o que vira bug em 01/01/2027.

/** Data da WPA → "YYYY-MM-DD". Sentinela 0001-01-01 e lixo devolvem null. */
function _dataDaEscala(v) {
  if (!v) return null;
  const str = String(v).trim();
  if (str.startsWith('0001-01-01')) return null;   // sentinela de nulo da EDP
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Aceita lista, objeto único ou nada — o padrão da WPA em Collaborators e Scale. */
function _comoLista(v) {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Achata a resposta de collaboratorshifts em linhas de
 * `{ sectorId, equipe, colaboradorCodigo, colaboradorNome, data, codigoEscala }`.
 *
 * Guardamos no grão do COLABORADOR, e não da equipe como o P2-24 propunha: dois
 * colaboradores da mesma equipe podem ter códigos diferentes no mesmo dia (um em
 * FOL, outro em T07). No grão da equipe essa informação se perde e a resposta
 * "a equipe estava escalada?" fica ambígua. A visão de equipe é derivada em
 * services/escalaDia.classificarDia.
 *
 * Linha sem data ou sem código é descartada: não serve para decidir nada, e
 * gravá-la faria `classificarDia` contar um colaborador que não existe.
 */
function _normalizeCollaboratorShifts(payload, sectorId) {
  const equipes = _comoLista(payload?.Data);
  const linhas = [];

  for (const eq of equipes) {
    const equipe = String(eq?.Name || '').trim();
    if (!equipe) continue;                      // sem nome não dá pra atribuir

    for (const col of _comoLista(eq.Collaborators)) {
      const codigo = col?.Code != null ? String(col.Code) : null;
      const nome   = col?.Name || null;

      for (const esc of _comoLista(col?.Scale)) {
        const data = _dataDaEscala(esc?.Date);
        const codigoEscala = esc?.ScaleCategoryName || null;
        if (!data || !codigoEscala) continue;

        linhas.push({
          sectorId,
          equipe,
          colaboradorCodigo: codigo,
          colaboradorNome:   nome,
          data,
          codigoEscala,
        });
      }
    }
  }

  return linhas;
}

/**
 * Escala cadastrada de um setor num mês.
 * GET /api/collaboratorshifts/{setor}/{mes}/{ano}
 *
 * @param {string} sectorId  DESG | DEPT | DESC | DSSJ
 * @param {number} mes       1..12 (sem zero à esquerda, como a rota espera)
 * @param {number} ano       ano com 4 dígitos
 */
async function getCollaboratorShifts(sectorId, mes, ano) {
  const m = Number(mes);
  const a = Number(ano);
  if (!Number.isInteger(m) || m < 1 || m > 12) throw new Error(`mês inválido: ${mes}`);
  if (!Number.isInteger(a) || a < 2000 || a > 2100) throw new Error(`ano inválido: ${ano}`);

  const path = `/api/collaboratorshifts/${encodeURIComponent(sectorId)}/${m}/${a}`;
  const res = await wpaFetch(path, { account: _resolveUsableAccount(sectorId) });
  if (!res.ok) throw new Error(`WPA collaboratorshifts ${res.status}`);
  return _normalizeCollaboratorShifts(await res.json(), sectorId);
}

// ── CATÁLOGO DE TURNOS (scaletypes/matches) ──────────────────────────────────
//
// 22/08/2026: o comentário em cronService.runSyncEscalas dizia "o WPA não informa
// o fim do turno", e por isso _shiftEndFromStart INFERIA fim = início + 9h — valor
// que o cron gravava em `equipes_oficiais.escala_fim`, tabela de negócio. O WPA
// informa: é este endpoint, usado pelos outros três projetos da empresa que
// consomem a mesma API. Uma chamada por setor, muda quase nunca.
//
// Além do fim real, ele traz a janela de intervalo prevista
// (StartIntervalTime/EndIntervalTime) e WorkDays/DaysOff — o que o P1-26 precisa
// pra distinguir folga de falta, e o P2-15 pra comparar previsto × realizado.
const _scaleTypesCache = new Map();   // sectorId → { at, list }
const SCALETYPES_TTL_MS = Number(process.env.WPA_SCALETYPES_TTL_MS) || 12 * 3600_000;

/**
 * "07:00:00", "2026-08-22T22:00:00" ou "22:00" → "HH:MM". Sentinela de nulo da
 * EDP (`0001-01-01T00:00:00`) vira null: tratá-la como 00:00 faria o painel
 * afirmar que o turno acaba à meia-noite.
 */
function _hhmmFromWpa(v) {
  if (v === null || v === undefined) return null;
  const str = String(v);
  if (str.startsWith('0001-01-01')) return null;
  const m = str.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return `${String(m[1]).padStart(2, '0')}:${m[2]}`;
}

function _intOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Um item de scaletypes/matches → forma nossa. Sem `Code` não serve pra nada. */
function _normalizeScaleType(raw) {
  if (!raw || !raw.Code) return null;
  return {
    codigo:          String(raw.Code),
    descricao:       raw.Description || null,
    inicio:          _hhmmFromWpa(raw.StartTime),
    intervaloInicio: _hhmmFromWpa(raw.StartIntervalTime),
    intervaloFim:    _hhmmFromWpa(raw.EndIntervalTime),
    fim:             _hhmmFromWpa(raw.EndTime),
    diasTrabalho:    _intOrNull(raw.WorkDays),
    diasFolga:       _intOrNull(raw.DaysOff),
  };
}

/**
 * Fim REAL do turno, a partir do `ShiftType` que o teamsstatus/V2 devolve.
 *
 * O V2 manda "T07 07:00"; o catálogo pode trazer o código completo ou só o
 * prefixo ("E22"), então casamos pelos dois. Sem match, ou com entrada sem fim,
 * devolve null — e o caller cai no +9h inferido, que continua sendo o fallback.
 */
function _scaleEndFromCatalog(shiftType, catalogo) {
  if (!shiftType || !Array.isArray(catalogo) || catalogo.length === 0) return null;
  const alvo  = String(shiftType).trim().toUpperCase();
  const curto = alvo.split(/\s+/)[0];

  const porCodigo = new Map();
  for (const e of catalogo) {
    if (!e?.codigo) continue;
    const cod = String(e.codigo).trim().toUpperCase();
    if (!porCodigo.has(cod)) porCodigo.set(cod, e);
    const pref = cod.split(/\s+/)[0];
    if (!porCodigo.has(pref)) porCodigo.set(pref, e);
  }

  const achado = porCodigo.get(alvo) || porCodigo.get(curto);
  return achado?.fim || null;
}

/**
 * Fim do turno COM a procedência — é o que o fluxo ao vivo usa.
 *
 * Existe por uma lição de 22/08/2026: subimos o P2-33 (fim vindo do catálogo em
 * vez de inferido como início+9h) e não havia como saber, pelo log de produção,
 * se o valor tinha vindo do catálogo ou do fallback. O `runSyncEscalas` só loga
 * quando o valor MUDA, e os 5 turnos em uso pelas nossas equipes
 * (T06/T07/T08/E07/E08) coincidem exatamente com início+9h — então o log ficou
 * mudo, e o silêncio foi lido como "o casamento ShiftType×codigo está quebrado",
 * quando estava funcionando. Três rodadas de query em produção pra descobrir.
 *
 * Medição do mesmo dia, que dá a dimensão: dos 164 turnos com fim no catálogo,
 * 64 (39%) NÃO são início+9h — nenhum deles em uso hoje. No dia em que a EDP
 * mover uma equipe pra C70 (07:00→16:48) ou V4 (07:00→15:20), a diferença passa
 * a valer, e o log tem que dizer isso em voz alta.
 *
 * @returns {{fim: string|null, origem: "catalogo"|"inferido"|"sem-turno", inferido: string|null}}
 *   `inferido` é sempre o +9h, exposto de propósito: é o que permite ao caller
 *   logar só quando o catálogo DISCORDA do palpite, sem poluir o resto.
 */
function _escalaFimComOrigem(shiftType, catalogo) {
  if (!shiftType) return { fim: null, origem: 'sem-turno', inferido: null };

  const inferido = _shiftEndFromStart(_parseShiftStart(shiftType), 9);
  const doCatalogo = _scaleEndFromCatalog(shiftType, catalogo);

  if (doCatalogo) return { fim: doCatalogo, origem: 'catalogo', inferido };
  return { fim: inferido, origem: 'inferido', inferido };
}

/**
 * Catálogo de turnos do setor, com cache de 12h (a EDP muda turno raramente).
 * GET /api/scaletypes/matches?sectorId={X}
 */
async function getScaleTypes(sectorId) {
  const hit = _scaleTypesCache.get(sectorId);
  if (hit && Date.now() - hit.at < SCALETYPES_TTL_MS) return hit.list;

  const res = await wpaFetch(`/api/scaletypes/matches?sectorId=${encodeURIComponent(sectorId)}`);
  if (!res.ok) throw new Error(`WPA scaletypes/matches ${res.status}`);
  const j = await res.json();
  const list = (Array.isArray(j?.Data) ? j.Data : []).map(_normalizeScaleType).filter(Boolean);

  _scaleTypesCache.set(sectorId, { at: Date.now(), list });
  console.log(`[WPA] scaletypes ${sectorId}: ${list.length} turno(s) no catálogo`);
  return list;
}

/** Versão que não derruba a coleta: falha aqui só devolve o fim ao +9h inferido. */
async function _safeScaleTypes(sectorId) {
  try {
    return await getScaleTypes(sectorId);
  } catch (err) {
    console.warn(`[WPA] scaletypes ${sectorId} falhou: ${err.message} — fim de turno volta a ser inferido (+9h)`);
    return [];
  }
}

/**
 * Retorna sessões ativas no setor.
 * Única fonte de Team.CompanyId — necessário para filtrar equipes Engelmig.
 * Também fornece Vehicle.Code (placa) que o V2 não retorna.
 *
 * GET /api/Sessions/today?sectorId={sectorId}
 *
 * IMPORTANTE: /api/Sessions/today retorna TODAS as sessões do dia (abertas
 * E encerradas com BeginTime + EndTime reais). Antes usávamos
 * /api/sessions/current que só retornava as ativas — equipes que
 * deslogavam durante o dia sumiam do payload e o sistema criava "ghosts"
 * com horários artificiais (sessionEnd = 23:59:59 UTC fake). Descobrimos
 * o endpoint correto via probe em 08/06/2026.
 *
 * Sessões ENCERRADAS têm EndTime preenchido (ex: "2026-06-08T06:39:03").
 * Sessões ABERTAS têm EndTime null/ausente.
 * Sessões que ATRAVESSARAM a virada têm BeginTime de ontem + EndTime de hoje.
 */
async function getSessions(sectorId) {
  const res = await wpaFetch(`/api/Sessions/today?sectorId=${sectorId}`);
  if (!res.ok) throw new Error(`WPA Sessions/today ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : (data.Data || []);
}

// getNotesExecution e getPreroute foram removidos (dead code).
// O endpoint V2 (getTeamStatusV2) já provê os dados que estes retornavam,
// com cobertura mais ampla e estrutura padronizada.

/**
 * Retorna status completo das equipes do setor — mesmo endpoint do WPA Gestão Online.
 * GET /api/teamsstatus/V2?sectorId={sectorId}&filterByExhibitionSector=true
 *
 * Estrutura de cada item (confirmada em campo):
 *   Concluded[]  — notas concluídas (ExecutionStatus 4/5 — inclui o que some de /notes/execution)
 *   Downloaded[] — notas na carteira do dispositivo
 *                  ExecutionStatus: 1=aguardando, 3/6/7=em andamento ativo
 *   Executed[]   — subconjunto de Downloaded em execução ativa (pode estar vazio mesmo
 *                  com notas em andamento — usar ExecutionStatus do Downloaded como fonte)
 *   Assigned[]   — notas atribuídas ainda não baixadas no dispositivo
 *   Rejected[]   — notas rejeitadas (pode ser null)
 *   Session      — dados de sessão; Team NÃO tem CompanyId (usar sessions/current para filtrar)
 *                  Collaborators[] é plano: { Id, Code, Name, Phone }
 *   Status       — texto descritivo: "Trabalhando na nota X", "Intervalo - 15...", etc.
 *   Location     — GPS { Latitude, Longitude }
 *   IsOnline, IsInLunchTime, LastUpdate, LastStatusUpdate
 */
async function getTeamStatusV2(sectorId) {
  const res = await wpaFetch(
    `/api/teamsstatus/V2?sectorId=${sectorId}&filterByExhibitionSector=true`
  );
  if (!res.ok) throw new Error(`WPA teamsstatus/V2 ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : (data.Data || []);
}

// Todos os setores conhecidos — usados no fallback cross-setor do V2.
// Se novos setores forem adicionados ao WPA, incluir aqui.
const ALL_SECTORS = ['DESG', 'DEPT', 'DESC', 'DSSJ'];

// Cache de V2 por setor — evita chamadas duplicadas quando equipes visitantes
// precisam buscar V2 em outros setores na mesma rodada de coleta.
// TTL de 3 minutos (bem abaixo do ciclo de 15 min do cron).
const _v2Cache   = new Map(); // sectorId → { list, ts }
const V2_TTL_MS  = 3 * 60 * 1000;

async function getV2Cached(sectorId) {
  const cached = _v2Cache.get(sectorId);
  if (cached && Date.now() - cached.ts < V2_TTL_MS) return cached.list;
  const list = await getTeamStatusV2(sectorId);
  _v2Cache.set(sectorId, { list, ts: Date.now() });
  return list;
}

/** Constrói índice (teamId → item, teamName → item) a partir de uma lista V2 */
function buildV2Index(statusList) {
  const byId   = new Map();
  const byName = new Map();
  statusList.forEach(item => {
    const id   = item.Session?.Team?.Id || item.Session?.TeamId;
    const nome = (item.Session?.Team?.Name || '').trim();
    if (id)   byId.set(id, item);
    if (nome) byName.set(nome, item);
  });
  return { byId, byName };
}

// ── HISTÓRICO (endpoints com parâmetro date) ──────────────────────────────────

/** Converte YYYY-MM-DD → M/D/YYYY (formato aceito pela API WPA) */
function toWpaDate(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${parseInt(m)}/${parseInt(d)}/${y}`;
}

/**
 * Sessões de um dia específico.
 * POST /api/Sessions/all/date?sectorId={sid}&date=M/D/YYYY
 */
async function getSessionsByDate(sectorId, isoDate) {
  const wpaDate = toWpaDate(isoDate);
  const res = await wpaFetch(
    `/api/Sessions/all/date?sectorId=${sectorId}&date=${encodeURIComponent(wpaDate)}`,
    { method: 'POST' }
  );
  if (!res.ok) throw new Error(`WPA sessions/date ${res.status}`);
  const data = await res.json();
  return data.Data || [];
}

/**
 * Notas de execução de um dia específico.
 * GET /api/notes/execution?sectorId={sid}&date=M/D/YYYY
 */
async function getNotesByDate(sectorId, isoDate) {
  const wpaDate = toWpaDate(isoDate);
  const res = await wpaFetch(
    `/api/notes/execution?sectorId=${sectorId}&date=${encodeURIComponent(wpaDate)}`
  );
  if (!res.ok) throw new Error(`WPA notes/date ${res.status}`);
  const data = await res.json();
  return data.Data?.Notes || [];
}

/**
 * Busca notas de uma sessão histórica por sessionId.
 * GET /api/notes/{category}/{sessionId}
 * Retorna array de notas com Number, Type, ConclusionDate.
 */
async function getNotesForSession(sessionId, category) {
  try {
    // Portal usa sufixo /session: GET /api/notes/{category}/{sessionId}/session
    const res  = await wpaFetch(`/api/notes/${category}/${sessionId}/session`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.Data || [];
  } catch {
    return [];
  }
}

/**
 * Retorna detalhes completos de uma nota (OS) pelo UUID e sectorId.
 * GET /api/Notes/{noteId}/details/optimized?sectorId={sectorId}
 *
 * Confirmado via interceptor Postman — endpoint usado pelo portal EDP WPA.
 * O noteId é o UUID (Data.Id), NÃO o número da OS (Data.Number).
 *
 * A resposta inclui:
 *   Data.Checkpoints[]  — eventos GPS (Event 0=início, 1=chegada, 2=concluída, 3=saída, 4=retorno)
 *                          Checkpoint com FileWrappers[] contém fotos em Base64
 *   Data.Equipments[]   — medidores e equipamentos (SerialNumber, Model, Prefix, etc.)
 *   Data.Seals[]        — lacres (SealNumber, SealId, SealType, etc.)
 *   Data.Materials[]    — materiais utilizados
 *   Data.Activities[]   — atividades registradas
 *   Data.*Note          — formulários preenchidos pelo técnico (SFRLNote, MDNote, etc.)
 *   Data.CustomerName, Address, City, Neighborhood, ZipCode — dados do cliente
 */
async function getNoteDetail(noteId, sectorId) {
  const qs   = sectorId ? `?sectorId=${encodeURIComponent(sectorId)}` : '';
  const path = `/api/Notes/${encodeURIComponent(noteId)}/details/optimized${qs}`;
  const t0   = Date.now();
  try {
    const res = await wpaFetch(path);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const elapsed = Date.now() - t0;
      console.warn(`[wpa] getNoteDetail !ok status=${res.status} path=${path} body=${body.slice(0,200)} ${elapsed}ms`);
      // Lança erro estruturado pro caller poder propagar status/body real do WPA
      // pra UI (em vez de só "HTTP 404"). Útil pra discriminar 401 (token race
      // em cold-start Vercel) de 404 real ou 5xx (timeout / erro upstream).
      const err = new Error(`WPA ${res.status} em ${path}`);
      err.wpaStatus  = res.status;
      err.wpaBody    = body.slice(0, 300);
      err.wpaPath    = path;
      err.wpaElapsed = elapsed;
      throw err;
    }
    const data = await res.json();
    console.log(`[wpa] getNoteDetail OK noteId=${noteId} sector=${sectorId} ${Date.now()-t0}ms`);
    return data.Data || data || null;
  } catch (err) {
    if (err.wpaStatus) throw err; // re-lança erro já estruturado
    const elapsed = Date.now() - t0;
    console.warn(`[wpa] getNoteDetail erro noteId=${noteId} sector=${sectorId} ${elapsed}ms — ${err.message}`);
    const wrapped = new Error(`WPA fetch falhou: ${err.message}`);
    wrapped.wpaStatus  = 0; // 0 = erro de rede / timeout / aborted
    wrapped.wpaBody    = err.message;
    wrapped.wpaPath    = path;
    wrapped.wpaElapsed = elapsed;
    throw wrapped;
  }
}

/**
 * Retorna detalhes completos de uma sessão individual.
 * GET /api/Sessions/{sessionId}
 * Único endpoint que retorna Collaborators[] com nome e matrícula.
 * sessions/all/date retorna Collaborators vazio.
 */
async function getSessionDetail(sessionId) {
  try {
    const res  = await wpaFetch(`/api/Sessions/${sessionId}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.Data || data;
  } catch {
    return null;
  }
}

/**
 * Combina sessões + notas de um dia histórico para um setor.
 *
 * Nova abordagem (v3): por sessionId
 *   1. POST /api/Sessions/all/date → lista de sessões do dia
 *   2. Filtra sessões Engelmig pelo CompanyId
 *   3. Para cada sessão: GET /api/notes/executed/{id} + /api/notes/downloaded/{id} + /api/notes/rejected/{id}
 *      → notas diretamente vinculadas à sessão, sem necessidade de cruzar por TeamName
 *
 * O endpoint /api/notes/executed/{sessionId} retorna notas com ConclusionDate preenchida
 * (confirmado via interceptor Postman) — essas são as "concluídas" do dia.
 */
async function getTeamsByDate(sectorId, isoDate) {
  function normalizarNotaHist(n, status) {
    return {
      id:             n.Id   || null,                    // UUID — necessário para /details/optimized
      codigo:         String(n.Number || n.Id || ''),
      tipoCode:       n.Type || '??',
      tipoNome:       n.Type || '??',
      status,
      conclusionDate: n.ConclusionDate2 || n.ConclusionDate || null,
    };
  }

  const sessions = await getSessionsByDate(sectorId, isoDate);
  const engelmigSessions = sessions.filter(s => s.Team?.CompanyId === ENGELMIG_COMPANY_ID);
  console.log(`[WPA] backfill ${sectorId}/${isoDate}: ${sessions.length} sessões totais, ${engelmigSessions.length} Engelmig`);

  // Busca notas + detalhe da sessão (colaboradores) em paralelo por sessão
  const sessionsWithNotes = await Promise.all(
    engelmigSessions.map(async s => {
      const sid = s.Id;
      const [executedRaw, downloadedRaw, rejectedRaw, surveyedRaw, detail] = await Promise.all([
        getNotesForSession(sid, 'executed'),
        getNotesForSession(sid, 'downloaded'),
        getNotesForSession(sid, 'rejected'),
        getNotesForSession(sid, 'surveyed'),
        getSessionDetail(sid),            // colaboradores reais (sessions/all/date retorna vazio)
      ]);

      const concluidas  = executedRaw.map(n  => normalizarNotaHist(n, 'concluida'));
      const baixadas    = downloadedRaw.map(n => normalizarNotaHist(n, 'baixada'));
      const rejeitadas  = rejectedRaw.map(n  => normalizarNotaHist(n, 'rejeitada'));
      const vistoriadas = surveyedRaw.map(n  => normalizarNotaHist(n, 'vistoriada'));

      // Colaboradores vêm do detalhe individual; fallback para o que vier na lista
      const collaborators = (detail?.Collaborators || s.Collaborators || []).map(normalizarColaborador);

      const teamName     = (s.Team?.Name || '').trim();
      const teamSectorId = s.SectorId || s.Sector?.Code || sectorId;

      console.log(`[WPA]   ${sectorId}/${teamName}: conc=${concluidas.length} baixadas=${baixadas.length} rej=${rejeitadas.length} vist=${vistoriadas.length} colab=${collaborators.length}`);

      return { s, teamName, teamSectorId, concluidas, baixadas, rejeitadas, vistoriadas, collaborators };
    })
  );

  // Mescla sessões da mesma equipe (relogins no mesmo dia)
  const teamMap = {};
  sessionsWithNotes.forEach(({ s, teamName, teamSectorId, concluidas, baixadas, rejeitadas, vistoriadas, collaborators }) => {
    if (!teamMap[teamName]) {
      teamMap[teamName] = {
        id:           s.Id,
        sigla:        teamName,
        teamName,
        sectorId:     teamSectorId,
        regional:     REGIONAL_MAP[teamSectorId] || 'GUA',
        date:         s.BeginTime?.slice(0, 10) || isoDate,
        sessionBegin: s.BeginTime,
        sessionEnd:   s.EndTime || null,
        vehiclePlate: s.Vehicle?.Code || '—',
        collaborators,
        relogins:     0,
        sessions:     [{ begin: s.BeginTime, end: s.EndTime || null }],
        deviceModel:  s.Device?.Model || null,
        appVersion:   s.AppVersion   || null,
        _conc: [], _baix: [], _rej: [], _vist: [],
      };
    } else {
      teamMap[teamName].relogins += 1;
      if (s.EndTime) teamMap[teamName].sessionEnd = s.EndTime;
      teamMap[teamName].sessions.push({ begin: s.BeginTime, end: s.EndTime || null });
      // Acumula colaboradores sem duplicar por matrícula
      collaborators.forEach(c => {
        if (!teamMap[teamName].collaborators.some(x => x.matricula === c.matricula)) {
          teamMap[teamName].collaborators.push(c);
        }
      });
    }

    // Acumula notas dedupicando por código
    const dedup = (arr, novas) => {
      const seen = new Set(arr.map(n => n.codigo).filter(Boolean));
      novas.forEach(n => { if (!seen.has(n.codigo)) { arr.push(n); seen.add(n.codigo); } });
    };
    dedup(teamMap[teamName]._conc, concluidas);
    dedup(teamMap[teamName]._baix, baixadas);
    dedup(teamMap[teamName]._rej,  rejeitadas);
    dedup(teamMap[teamName]._vist, vistoriadas);
  });

  return Object.values(teamMap).map(t => {
    const { _conc: notasConcluidas, _baix: notasBaixadas, _rej: notasRejeitadas, _vist: notasVistoriadas } = t;
    delete t._conc; delete t._baix; delete t._rej; delete t._vist;
    const allNotas = [...notasConcluidas, ...notasBaixadas, ...notasRejeitadas, ...notasVistoriadas];
    return {
      ...t,
      carteiraCount:   notasBaixadas.length,
      servicosPerfil:  [...new Set(allNotas.map(n => n.tipoCode))],
      notasBaixadas,
      notasExecutadas: [],   // histórico não distingue "em andamento" do dia
      notasConcluidas,
      notasRejeitadas,
      notasVistoriadas,
    };
  });
}

// ── ACUMULADOR DIÁRIO ─────────────────────────────────────────────────────────
// Preserva notas concluídas/executadas vistas durante o dia, garantindo que
// quando uma equipe encerra a sessão (sai do `teams_current`) as notas dela
// continuem aparecendo nos cards de produtividade e nos indicadores do monitor.
//
// Sem este acumulador, ao deslogar uma equipe, suas notas somem do array
// retornado por /api/teams e — como o frontend calcula MD/SF/DD por sub_code,
// EM ANDAMENTO, REJEITADAS e EM CARTEIRA a partir dessa lista — os contadores
// caem indevidamente. O daily_totals do Supabase é cumulativo mas só serve o
// KPI agregado por regional, não o detalhamento por tipo/sub_code.
//
// Reset usa data BRT (UTC-3) — usar UTC fazia o acumulador zerar às 21h BRT.
// Limitação conhecida: estado em memória (single-process). Em PM2 cluster
// múltiplas instâncias teriam acumuladores divergentes — não é o caso atual.
const _acc = {
  date:  '',
  notes: new Map(),    // chave (id||codigo) → { id, codigo, tipoCode, tipoNome, teamName, regional, status, conclusionDate }
  // Carteira inicial: conjunto cumulativo de noteIds que passaram pela carteira
  // de cada equipe no dia (baixadas + executadas + concluídas). Permite calcular
  // carteiraInicialCount = total de notas DISTINTAS que a equipe teve hoje, vs
  // carteiraCount = só as pendentes no dispositivo agora.
  // Ex: logou com 15, executou 3, recebeu 2 → inicial=17, atual=14.
  carteiras: new Map(), // teamName → Set<noteId>
};

function _accReset() {
  // Data BRT (America/Sao_Paulo) — respeita DST automaticamente
  const today = dateBRT();
  if (_acc.date !== today) {
    _acc.date = today;
    _acc.notes.clear();
    _acc.carteiras.clear();
    console.log('[WPA] Acumulador diário resetado para', today, '(BRT)');
  }
}

function _accRecord(teams) {
  _accReset();
  teams.forEach(t => {
    // Acumulamos executadas + concluidas + rejeitadas — todas precisam persistir
    // entre snapshots para os indicadores se manterem corretos mesmo quando
    // equipes deslogam no meio do dia.
    const todasRealizadas = [
      ...(t.notasExecutadas || []),
      ...(t.notasConcluidas || []),
      ...(t.notasRejeitadas || []),
    ];
    todasRealizadas.forEach(n => {
      const chave = n.id || n.codigo;
      if (!chave) return;
      // SOBRESCREVE (não só first-write, como era antes): mantém o status
      // acumulado alinhado ao ÚLTIMO estado visto ao vivo. Como todasRealizadas
      // vem na ordem executadas→concluidas→rejeitadas, se a nota estiver em mais
      // de um bucket no mesmo payload, o mais terminal vence (rejeitada >
      // concluida > executada). Sem isso, uma nota que avançava de andamento pra
      // concluída/rejeitada ficava congelada como 'executada' e (a) sumia da
      // produção se a fonte podasse concluidas/rejeitadas, (b) voltava pra
      // andamento indevidamente. (P3-11, 22/07/2026)
      _acc.notes.set(chave, {
        id:       n.id || null,
        codigo:   n.codigo,
        tipoCode: n.tipoCode,
        tipoNome: n.tipoNome || n.tipoCode,
        teamName: t.teamName,
        regional: t.regional,
        status:   n.status,  // 'executada' | 'concluida' | 'rejeitada'
        conclusionDate: n.conclusionDate || null,
      });
    });

    // Acumula carteira inicial: TODA nota que apareceu na carteira da equipe hoje
    // (baixadas pendentes + executadas em andamento + concluidas que já saíram).
    // Set deduplica por noteId — uma nota só conta uma vez, mesmo se atravessou
    // múltiplos estados durante o dia.
    const carteiraSet = _acc.carteiras.get(t.teamName) || new Set();
    const todasNaCarteira = [
      ...(t.notasBaixadas    || []),
      ...(t.notasExecutadas  || []),
      ...(t.notasConcluidas  || []),
    ];
    todasNaCarteira.forEach(n => {
      const id = n.id || n.codigo;
      if (id) carteiraSet.add(id);
    });
    if (carteiraSet.size > 0) _acc.carteiras.set(t.teamName, carteiraSet);
  });
}

function _accApply(teams) {
  _accReset();
  // NÃO retorna cedo aqui (mesmo com _acc.notes vazio) — precisamos injetar
  // carteiraInicialCount em TODAS as equipes (logo cedo do dia, sem notas
  // executadas/rejeitadas ainda, mas baixadas já contam pra carteira inicial).

  // Agrupa as notas acumuladas por equipe e por status (3 buckets agora: exec, conc, rej)
  const extrasExec = {};
  const extrasConc = {};
  const extrasRej  = {};
  _acc.notes.forEach(info => {
    const nota = {
      id:       info.id,
      codigo:   info.codigo,
      tipoCode: info.tipoCode,
      tipoNome: info.tipoNome,
      status:   info.status,
      conclusionDate: info.conclusionDate,
    };
    if (info.status === 'executada') {
      (extrasExec[info.teamName] ||= []).push(nota);
    } else if (info.status === 'rejeitada') {
      (extrasRej[info.teamName] ||= []).push(nota);
    } else {
      (extrasConc[info.teamName] ||= []).push(nota);
    }
  });

  // Aplica nas equipes ainda presentes (sem duplicar) e adiciona equipes-fantasma
  // sintéticas para as que sumiram do teams_current mas têm notas acumuladas
  const teamsByName = new Map(teams.map(t => [t.teamName, t]));
  const result = teams.map(t => {
    const existentes = new Set([
      ...(t.notasExecutadas || []).map(n => n.id || n.codigo),
      ...(t.notasConcluidas || []).map(n => n.id || n.codigo),
      ...(t.notasRejeitadas || []).map(n => n.id || n.codigo),
    ]);
    // ANDAMENTO é estado AO VIVO: pra equipe presente com payload ÍNTEGRO, a
    // lista atual de executadas É a verdade — não re-injeta andamento acumulado,
    // pois seriam notas transferidas/canceladas pela EDP no meio do dia (P3-11).
    // Só re-injeta como FALLBACK quando o payload veio 100% vazio (provável
    // falha de coleta transitória), pra não zerar andamento por erro. Concluídas
    // e rejeitadas SEMPRE re-injetam (produção + rejeições podadas pela API têm
    // que persistir — comportamento load-bearing validado na auditoria 22/07).
    const payloadIntegro = ((t.notasBaixadas || []).length + (t.notasExecutadas || []).length
      + (t.notasConcluidas || []).length + (t.notasRejeitadas || []).length) > 0 || !!t.sessionEnd;
    const novasExec = payloadIntegro
      ? []
      : (extrasExec[t.teamName] || []).filter(n => !existentes.has(n.id || n.codigo));
    const novasConc = (extrasConc[t.teamName] || []).filter(n => !existentes.has(n.id || n.codigo));
    const novasRej  = (extrasRej[t.teamName]  || []).filter(n => !existentes.has(n.id || n.codigo));
    // Carteira inicial: total cumulativo de notas distintas que passaram pela
    // carteira da equipe no dia. Lê do _acc.carteiras (alimentado em _accRecord).
    const carteiraInicialCount = _acc.carteiras.get(t.teamName)?.size || 0;
    if (novasExec.length === 0 && novasConc.length === 0 && novasRej.length === 0) {
      return { ...t, carteiraInicialCount };
    }
    return {
      ...t,
      notasExecutadas: [...(t.notasExecutadas || []), ...novasExec],
      notasConcluidas: [...(t.notasConcluidas || []), ...novasConc],
      notasRejeitadas: [...(t.notasRejeitadas || []), ...novasRej],
      carteiraInicialCount,
    };
  });

  // ── FANTASMAS SINTÉTICOS — DESATIVADO ────────────────────────────────────
  // Antes criávamos cards sintéticos com sessionEnd="${_acc.date}T23:59:59Z"
  // (que virava "08/06 20:59 BRT" no front, confundindo o usuario: "como as
  // equipes ficaram ate 20:59 se agora sao 09:26?").
  //
  // Desde 08/06/2026 usamos /api/Sessions/today que retorna TODAS as sessoes
  // do dia (abertas + encerradas) com BeginTime+EndTime reais. Ghosts ficaram
  // redundantes — toda equipe que operou hoje ja vem na resposta da API.
  //
  // Mantemos o enriquecimento das equipes EXISTENTES com notas acumuladas
  // (loop acima, linhas ~737-765) — pra cobrir cases onde uma equipe que
  // estava ativa em snapshot anterior teve notas que nao aparecem no V2 atual.
  // Mas a CRIAÇÃO de cards sintéticos foi removida.
  //
  // Se uma equipe acumulou notas no _acc mas nao aparece em /Sessions/today
  // (raro), as notas dela ficam orfas — nao entram em nenhum card nem KPI.
  // Esse trade-off e aceitavel: melhor uma equipe ausente do que um card
  // com horario fake confundindo o operador.
  return result;
}

// ── NORMALIZAÇÃO ──────────────────────────────────────────────────────────────

const REGIONAL_MAP = {
  DESG: 'GUA',
  DEPT: 'GUA',
  DESC: 'CAC',
  DSSJ: 'SJC',   // CSD São José dos Campos — EDP SP (conta WPA separada)
};

// CompanyId Engelmig na WPA — usado para filtrar sessões/equipes da empresa.
// Configurável via env var para permitir mudança sem redeploy de código.
// Se a env não estiver setada, usa o ID atual conhecido como fallback.
const ENGELMIG_COMPANY_ID = process.env.WPA_COMPANY_ID
  || '92a2f98e-8877-433e-8358-173b94c13a54';

/**
 * Normaliza uma nota do teamsstatus/V2.
 *
 * @param {object} n           - Objeto de nota do V2 (Concluded/Downloaded/Executed/Rejected)
 * @param {string} statusForcado - Se fornecido, ignora ExecutionStatus e usa este valor
 */
function normalizarNotaV2(n, statusForcado) {
  // Mapeamento confirmado em campo com dados reais
  const STATUS_V2 = {
    1: 'baixada',
    2: 'baixada',

    3: 'executada',   // em andamento
    6: 'executada',   // nota ativa ("Trabalhando na nota X")
    7: 'executada',   // variante de nota ativa
    4: 'concluida',   // exportada/sincronizada
    5: 'concluida',   // exportada variante
    9: 'concluida',   // mobile pendente sync
  };
  // ConclusionDate2 (DD/MM/YYYY HH:MM:SS BR) preferido por já vir em BRT;
  // ConclusionDate (ISO UTC) é fallback — porém vem SEM marker Z. JS interpreta
  // como local time se faltar Z, mostrando horário 3h adiantado (ex: 20:00 em
  // vez de 17:00 BRT). Concatena 'Z' se não tiver TZ marker explícito, alinhando
  // com o fix do RejectedAt em rejectionService.js (07/06/2026).
  let conclusionDate = n.ConclusionDate2 || n.ConclusionDate || null;
  if (
    conclusionDate &&
    typeof conclusionDate === 'string' &&
    /^\d{4}-\d{2}-\d{2}T/.test(conclusionDate) &&        // formato ISO (não DD/MM)
    !/[Zz]|[+-]\d{2}:?\d{2}$/.test(conclusionDate)       // sem TZ marker
  ) {
    conclusionDate = conclusionDate + 'Z';
  }
  return {
    id:             n.Id   || null,                    // UUID — necessário para /details/optimized
    codigo:         String(n.Number || n.Id || ''),
    tipoCode:       n.Type || '??',
    tipoNome:       n.Type || '??',
    status:         statusForcado || STATUS_V2[n.ExecutionStatus] || 'baixada',
    conclusionDate,
  };
}

/**
 * Normaliza colaboradores vindos de sessions/current.
 * sessions/current usa estrutura aninhada: Collaborators[].Collaborator.{Name, Code}
 * O fallback plano (c.Name) cobre variações futuras da API.
 */
function normalizarColaborador(c) {
  return {
    nome:      c.Collaborator?.Name || c.Name || '—',
    matricula: c.Collaborator?.Code || c.Code || '—',
    cargo:     '—',
  };
}

/**
 * Normaliza QUALQUER payload de colaboradores da WPA numa lista nossa.
 *
 * P2-14 / P2-28 (22/08/2026): o caminho ao vivo lia `Collaborators` de
 * `Sessions/all/date`, que a EDP devolve VAZIO — e `db/rejectionsQueries.js`
 * faz `unnest` desses arrays pro ranking de rejeições por colaborador, que por
 * isso não tinha linhas. Aqui absorvemos as três formas que a API usa:
 *
 *   • `Data` como LISTA        → rota `collaborators/{sessionId}/session`
 *   • `Data` como OBJETO       → sessão única
 *   • `Data.Collaborators`     → ora LISTA, ora DICT ÚNICO (varia por equipe;
 *     documentado pelos três outros projetos que consomem esta API), com os
 *     campos ora planos (`Name`/`Code`, shape do teamsstatus/V2), ora
 *     aninhados em `Collaborator.{Name,Code}`.
 *
 * `Data: null` vira `[]` de propósito: é o que a WPA responde, SEM erro HTTP,
 * quando o id não serve pra rota — estourar aqui derrubaria a coleta da equipe.
 */
function _normalizeSessionCollaborators(payload) {
  const data = payload?.Data;
  if (!data) return [];

  let itens;
  if (Array.isArray(data)) {
    itens = data;
  } else if (data.Collaborators !== undefined && data.Collaborators !== null) {
    itens = Array.isArray(data.Collaborators) ? data.Collaborators : [data.Collaborators];
  } else {
    itens = [data];
  }

  return itens
    .filter(Boolean)
    .map(normalizarColaborador)
    .filter(c => c.nome !== '—' || c.matricula !== '—');   // linha sem nome E sem matrícula é inútil
}

/**
 * Colaboradores de uma sessão — nome e matrícula reais.
 * GET /api/collaborators/{sessionId}/session
 *
 * Por que ESTA rota e não `/api/Sessions/{id}/collaborators`: a nossa própria
 * documentação afirmava que aquela é "por sessão", mas sem medição — e dois
 * outros projetos que consomem a mesma API dizem o contrário, com o ES medindo
 * que, recebendo id de SESSÃO, ela devolve `Data: null` sem erro HTTP (ela
 * espera o id do SERVIÇO, apesar do nome). Esta aqui é a que rodou em produção
 * no projeto SJC por anos, indexada por sessionId; traz `Code` e `Name` (mais
 * `Cpf` e `Phone2`, que não usamos).
 *
 * Custo: 1 request por sessão. Por isso o caller só chega aqui quando as duas
 * fontes de graça (a lista de sessões e o item do V2) vieram vazias.
 */
async function getSessionCollaborators(sessionId) {
  if (!sessionId) return [];
  const res = await wpaFetch(`/api/collaborators/${encodeURIComponent(sessionId)}/session`);
  if (!res.ok) throw new Error(`WPA collaborators/session ${res.status}`);
  return _normalizeSessionCollaborators(await res.json());
}

/**
 * Combina sessions/current (filtro Engelmig + metadados) + teamsstatus/V2 (notas).
 * Retorna array de equipes normalizado com contagem correta de concluídas.
 *
 * Fluxo:
 *   1. sessions/current  → lista de equipes Engelmig (CompanyId) + placa do veículo
 *   2. teamsstatus/V2    → Concluded[], Downloaded[], Executed[] para cada equipe
 *   3. Cruza os dois por Team.Id (fallback por Team.Name)
 *   4. Aplica acumulador diário como segurança
 */
// ── SINGLE-FLIGHT por setor (incidente 30/07/2026) ───────────────────────────
// Uma coleta de setor custa ~60 fetches na WPA e leva vários segundos. Antes,
// duas chamadas concorrentes (ex.: o snapshot do boot + o /api/teams de quem
// abriu a página logo após o deploy) disparavam DUAS varreduras completas em
// paralelo — dobrando a carga na WPA (que já devolve 500/502 sob pressão) e
// deixando o Monitor "travado carregando". Agora, se já existe uma coleta EM VOO
// pro mesmo setor, os chamadores seguintes aguardam a MESMA promise.
// Não é cache: nenhum dado é reaproveitado depois que a coleta termina — a
// frescura dos dados é exatamente a de antes.
const _inflightSector = new Map();   // sectorId → Promise

/**
 * FUNÇÃO PURA (testável): compartilha a promise em voo por chave. Se já há uma
 * execução pendente pra `key`, devolve a MESMA promise; senão executa `fn` e
 * registra até resolver/rejeitar. Não guarda resultado (não é cache).
 */
function _singleFlight(map, key, fn) {
  const emVoo = map.get(key);
  if (emVoo) return emVoo;
  const p = (async () => fn())().finally(() => { map.delete(key); });
  map.set(key, p);
  return p;
}

function getTeamsBySector(sectorId) {
  // Conta desativada (kill-switch): pula a extração sem tocar na rede. É o ponto
  // único por onde toda coleta de equipes passa, então isto cobre snapshot,
  // /teams e afins de uma vez. Devolve [] → a regional dessa conta fica vazia no
  // período (esperado: "travar a extração da conta"). Loga 1x por setor/boot.
  if (isSectorDisabled(sectorId)) {   // TODA a cadeia do setor desativada
    if (!_disabledLogged.has(sectorId)) {
      _disabledLogged.add(sectorId);
      console.warn(`[WPA] setor ${sectorId} PULADO — todas as contas [${_accountsForSector(sectorId).join(', ')}] desativadas (WPA_ACCOUNTS_DISABLED).`);
    }
    return Promise.resolve([]);
  }
  return _singleFlight(_inflightSector, sectorId, () => _getTeamsBySectorUncached(sectorId));
}

async function _getTeamsBySectorUncached(sectorId) {
  // IMPORTANTE: usamos getSessionsByDate com data BRT explícita em vez de
  // getSessions ('today') porque a EDP usa "today" em UTC. Servidor em UTC
  // + EDP em UTC = após 21h BRT (00h UTC), /api/Sessions/today já retorna
  // sessões de "amanhã" UTC = só plantão noturno (≈ 17 equipes em vez de 128).
  // Bug exposto em 08/06/2026 às 21h BRT quando carteira inicial do dia caiu
  // pra valor minúsculo enquanto KPIs do dia inteiro ainda apareciam corretos.
  const todayBRT = dateBRT();
  const [sessions, statusList, escalaCatalogo] = await Promise.all([
    getSessionsByDate(sectorId, todayBRT),
    getV2Cached(sectorId),
    _safeScaleTypes(sectorId),   // cacheado 12h — 1 request por setor por meio-dia
  ]);

  // Filtra apenas sessões Engelmig (CompanyId só existe em sessions/current).
  // Não filtramos por data: sessões abertas de dias anteriores (equipe esqueceu de encerrar)
  // devem aparecer — a data de início fica visível no card para identificação.

  const allEngelmig     = sessions.filter(s => s.Team?.CompanyId === ENGELMIG_COMPANY_ID);
  const engelmigSessions = allEngelmig; // sem corte de data — todas as sessões abertas

  // Loga quantas sessões são de dias anteriores (informativo)
  const antigas = allEngelmig.filter(s => s.BeginTime && s.BeginTime.slice(0, 10) < todayBRT);
  if (antigas.length > 0) {
    console.warn(
      `[WPA] ${sectorId}: ℹ️ ${antigas.length} sessão(ões) de dias anteriores ainda abertas` +
      ` (serão exibidas com destaque no monitor)`
    );
  }

  // Índice V2 do setor consultado
  const { byId: v2ByTeamId, byName: v2ByTeamName } = buildV2Index(statusList);

  console.log(
    `[WPA] ${sectorId}: ${sessions.length} sessões totais → ${engelmigSessions.length} Engelmig` +
    ` | ${statusList.length} entradas V2`
  );

  // Concurrency cap pra não saturar a EDP. Cada sessão dispara 2 fetches
  // (notes/rejected + notes/executed). Antes era Promise.all puro → em DSSJ
  // com 52 sessões viravam 104 fetches simultâneos contra 1 conta. Combinado
  // com os outros 3 setores em paralelo, chegava-se a ~300 sockets. Undici
  // default = 6 connections/origin → fila gigante → timeouts → _safeNotes
  // engolia silenciosamente → cards vinham vazios em ALL.
  // Limite de 8: cap em 16 fetches simultâneos por setor.
  // Procedência do fim de turno por equipe, só pra logar o resumo do setor.
  // NÃO entra no payload da equipe: snapshot é retido pra sempre, e campo que
  // ninguém consome custa espaço por anos.
  const _origensFim = [];

  const result = await _mapConcurrent(engelmigSessions, 8, async s => {
    const teamName     = (s.Team?.Name || '').trim();
    const teamId       = s.Team?.Id;
    const teamSectorId = s.SectorId || s.Sector?.Code || sectorId;

    // Busca dado V2: por ID primeiro (mais confiável), nome como fallback
    let v2 = (teamId && v2ByTeamId.get(teamId)) || v2ByTeamName.get(teamName);

    // Fallback cross-setor: quando V2 do setor atual não retorna dados da equipe,
    // tenta todos os outros setores conhecidos.
    // Ocorre quando o "setor de exibição" configurado no WPA difere do setor de login,
    // fazendo a equipe sumir do V2 com filterByExhibitionSector=true.
    //
    // Skip pra sessões já ENCERRADAS — V2 só retorna sessões ativas, fallback
    // cross-setor seria infrutífero (e custaria N fetches por equipe encerrada).
    const sessaoEncerrada = !!s.EndTime;
    if (!v2 && !sessaoEncerrada) {
      for (const altSector of ALL_SECTORS) {
        if (altSector === sectorId) continue; // já tentamos este
        if (isSectorDisabled(altSector)) continue; // conta desativada — não cutuca (P1-21)
        try {
          const altList = await getV2Cached(altSector);
          const { byId: altById, byName: altByName } = buildV2Index(altList);
          v2 = (teamId && altById.get(teamId)) || altByName.get(teamName);
          if (v2) {
            console.log(`[WPA] ${sectorId}/${teamName}: V2 encontrado em setor alternativo (${altSector}) ✓`);
            break;
          }
        } catch (err) {
          console.warn(`[WPA] ${sectorId}/${teamName}: falha ao buscar V2 em ${altSector}:`, err.message);
        }
      }
    }

    let baixadas, executadas, concluidas, rejeitadas;

    if (v2) {
      // Concluded[] → força 'concluida' (inclui ExecutionStatus 4/5 que sumia antes)
      concluidas = (v2.Concluded || []).map(n => normalizarNotaV2(n, 'concluida'));

      // Downloaded[] → classifica pelo ExecutionStatus
      //   1/2   → baixada (aguardando na carteira)
      //   3/6/7 → executada (nota em andamento ativo)
      const downloadedNormed = (v2.Downloaded || []).map(n => normalizarNotaV2(n));
      baixadas = downloadedNormed.filter(n => n.status === 'baixada');

      // ── REJEITADAS e EXECUTADAS via endpoint por sessionId ─────────────────
      // BREAKING CHANGE EDP (30/05/2026): v2.Rejected e v2.Executed começaram
      // a vir null/[] em 100% das equipes. Os dados migraram pra endpoints
      // dedicados indexados por sessionId. Endpoint confirmado por intercept
      // do browser e probe em produção (03/06/2026).
      //
      // Endpoints:
      //   /api/notes/rejected/{sessionId}/session
      //   /api/notes/executed/{sessionId}/session
      //
      // Shape: mesmo de v2.Rejected/Executed legado (Id, Number, Type,
      // ExecutionStatus, ConclusionDate2) — normalizarNotaV2 funciona direto.
      //
      // Custo: +2 fetches por equipe (~43 equipes × 2 = 86 fetches/snapshot).
      // Cada um leve (~1-5 KB). Tolerável dentro do ciclo de 15min.
      const sessionId = s.Id;
      const _safeNotes = async (status) => {
        if (!sessionId) return [];
        try {
          const r = await wpaFetch(`/api/notes/${status}/${sessionId}/session`);
          if (!r.ok) {
            console.warn(`[WPA] ${sectorId}/${teamName}: notes/${status} HTTP ${r.status} — esvaziando bucket`);
            return [];
          }
          const j = await r.json();
          const arr = Array.isArray(j) ? j : (j.Data || []);
          return Array.isArray(arr) ? arr : [];
        } catch (err) {
          console.warn(`[WPA] ${sectorId}/${teamName}: notes/${status} falhou: ${err.message}`);
          return [];
        }
      };
      const [rejRaw, execRaw] = await Promise.all([
        _safeNotes('rejected'),
        _safeNotes('executed'),
      ]);

      // EXECUTADAS — merge endpoint novo + Downloaded com ExecutionStatus 3/6/7
      const execBase = execRaw.map(n => normalizarNotaV2(n, 'executada'));
      const execIds  = new Set(execBase.map(n => n.codigo));
      const execFromDownloaded = downloadedNormed.filter(n => n.status === 'executada');
      executadas = [...execBase, ...execFromDownloaded.filter(n => !execIds.has(n.codigo))];

      // REJEITADAS — endpoint novo é a única fonte (v2.Rejected nunca mais popula)
      rejeitadas = rejRaw.map(n => normalizarNotaV2(n, 'rejeitada'));
    } else if (sessaoEncerrada) {
      // Sessão JÁ ENCERRADA — V2 não traz dados de sessões fechadas.
      // Buscamos rejected/executed via endpoints por sessionId (funcionam
      // pós-deslog). Probe confirmou em 08/06/2026 que /api/notes/concluded
      // NÃO existe (HTTP 404) — concluídas são restauradas posteriormente
      // por _enrichConcluidasDeEncerradas (dataService) via snapshot do dia.
      const sessionId = s.Id;
      const _safeNotes = async (status) => {
        if (!sessionId) return [];
        try {
          const r = await wpaFetch(`/api/notes/${status}/${sessionId}/session`);
          if (!r.ok) return [];
          const j = await r.json();
          const arr = Array.isArray(j) ? j : (j.Data || []);
          return Array.isArray(arr) ? arr : [];
        } catch (_) { return []; }
      };
      const [rejRaw, execRaw] = await Promise.all([
        _safeNotes('rejected'),
        _safeNotes('executed'),
      ]);
      baixadas    = [];
      concluidas  = [];   // restaurado em _enrichConcluidasDeEncerradas
      executadas  = execRaw.map(n => normalizarNotaV2(n, 'executada'));
      rejeitadas  = rejRaw.map(n => normalizarNotaV2(n, 'rejeitada'));
    } else {
      console.warn(`[WPA] ${sectorId}/${teamName}: ⚠️ sem dados V2`);
      baixadas = []; executadas = []; concluidas = []; rejeitadas = [];
    }

    // carteiraCount = notas que a equipe tem no dispositivo (= "Em Campo" do WPA)
    const carteiraCount = baixadas.length + executadas.length;
    const allNotas      = [...baixadas, ...executadas, ...concluidas, ...rejeitadas];

    // ── COLABORADORES: cascata de fontes (P2-14 / P2-28, 22/08/2026) ─────────
    // Antes daqui o card ao vivo lia só `s.Collaborators`, que a EDP devolve
    // VAZIO em Sessions/all/date — o ranking de rejeições por colaborador ficava
    // sem linhas, e o backfill não corrigia porque lê dos mesmos snapshots.
    //
    // A ordem existe pra não pagar rede à toa:
    //   1. s.Collaborators        — grátis (na prática vem vazio, mas é de graça)
    //   2. v2.Session.Collaborators — grátis: o teamsstatus/V2 JÁ está baixado, e
    //      os três outros projetos que consomem esta API mapeiam este campo. Cobre
    //      toda equipe com sessão ativa, que é a maioria do ciclo.
    //   3. collaborators/{sessionId}/session — 1 request, só pro que sobrou
    //      (tipicamente sessão encerrada, que não aparece no V2).
    // Sempre embrulhado em { Collaborators } explícito: passar o objeto de sessão
    // cru faria o normalizador tratá-lo como colaborador único, e um campo Name ou
    // Code solto da sessão viraria colaborador inventado.
    let collaborators = _normalizeSessionCollaborators({ Data: { Collaborators: s.Collaborators } });
    if (collaborators.length === 0 && v2?.Session) {
      collaborators = _normalizeSessionCollaborators({ Data: { Collaborators: v2.Session.Collaborators } });
    }
    if (collaborators.length === 0 && s.Id) {
      try {
        collaborators = await getSessionCollaborators(s.Id);
      } catch (err) {
        // Falha aqui não pode esvaziar a equipe: colaborador é enriquecimento,
        // não bucket de produção. Mas logamos — array vazio silencioso foi
        // exatamente o que escondeu este problema por meses.
        console.warn(`[WPA] ${sectorId}/${teamName}: collaborators/session falhou: ${err.message}`);
      }
    }

    // Fim do turno + procedência (ver _escalaFimComOrigem).
    const _fimTurno = _escalaFimComOrigem(v2?.ShiftType, escalaCatalogo);
    _origensFim.push({ teamName, shiftType: v2?.ShiftType || null, ..._fimTurno });

    const _statusTag = v2 ? '' : (sessaoEncerrada ? ' [ENCERRADA]' : ' [SEM V2]');
    console.log(
      `[WPA]   ${sectorId}/${teamName}: ` +
      `início=${s.BeginTime?.slice(0, 16) || '?'} ` +
      `${s.EndTime ? `fim=${s.EndTime.slice(0, 16)} ` : ''}` +
      `baixadas=${baixadas.length} exec=${executadas.length} ` +
      `conc=${concluidas.length} rej=${rejeitadas.length} ` +
      `carteira=${carteiraCount} colab=${collaborators.length}${_statusTag}`
    );

    return {
      id:           s.Id,
      sigla:        teamName,
      teamName,
      sectorId:     teamSectorId,
      regional:     REGIONAL_MAP[teamSectorId] || 'GUA',
      // Tipo da equipe (whitelist) — usado no front pra tratar casos especiais
      // (ex: USO MUTUO não opera o app, então não entra no alerta de offline).
      tipo:         (() => { try { return require('./equipesOficiais').getMeta(teamName)?.tipo || null; } catch (_) { return null; } })(),
      date:         s.BeginTime?.slice(0, 10) || new Date().toISOString().slice(0, 10),
      sessionBegin: s.BeginTime,
      sessionEnd:   s.EndTime || null,
      // Placa: só existe em sessions/current (V2 tem apenas VehicleCategory)
      vehiclePlate: s.Vehicle?.Code || '—',
      // Colaboradores: resolvidos acima pela cascata (P2-14/P2-28). A estrutura
      // varia entre aninhada (Collaborator.{Name,Code}) e plana, e entre lista e
      // dict único — _normalizeSessionCollaborators absorve os quatro casos.
      collaborators,
      relogins:    0,
      sessions:    [],
      deviceModel: s.Device?.Model || null,
      appVersion:  s.AppVersion   || null,
      // Campos enriquecidos do V2
      teamStatus:    v2?.Status        || s.TeamStatus || null,
      isOnline:      v2?.IsOnline      || false,
      isInLunchTime: v2?.IsInLunchTime || false,
      lastUpdate:    v2?.LastUpdate    || null,
      location:      v2?.Location      || null,
      // ShiftType vem como "T07 07:00" / "T15 15:00" — o horário ali é a
      // escala REAL da EDP. Guardamos cru + horário extraído (HH:MM) pra
      // sincronizar equipes_oficiais.escala_inicio automaticamente.
      shiftType:     v2?.ShiftType     || null,
      escalaInicioWPA: _parseShiftStart(v2?.ShiftType),
      // Fim do turno: o REAL, do catálogo scaletypes/matches (22/08/2026). O +9h
      // (8h trabalho + 1h refeição) fica como fallback pra turno que não está no
      // catálogo — a premissa antiga de que "o WPA não dá o fim" era falsa, mas o
      // fallback segue útil quando a EDP cria um turno e não o cataloga.
      // A procedência é acumulada em _origensFim e sai no resumo do setor.
      escalaFimWPA:    _fimTurno.fim,
      // "Hr. Apresentação" da EDP — v2.SessionBegin (nível 1) reflete o checkin
      // REAL do dia atual, diferente de Session.BeginTime/sessions.current que
      // mantém a sessão física aberta (pode ser de dia anterior se a equipe
      // esqueceu de deslogar). v2.SessionBegin já vem em BRT (sem sufixo TZ),
      // então anexamos -03:00 pra new Date() interpretar certo.
      presentationTime: v2?.SessionBegin ? `${v2.SessionBegin}-03:00` : null,
      carteiraCount,
      servicosPerfil: [...new Set(allNotas.map(n => n.tipoCode))],
      notasBaixadas:   baixadas,
      notasExecutadas: executadas,
      notasConcluidas: concluidas,
      notasRejeitadas: rejeitadas,
    };
  });

  // Resumo da procedência do fim de turno — 1 linha por setor por ciclo. É a
  // resposta pra "o catálogo está sendo usado?", que antes exigia ir ao banco.
  if (_origensFim.length > 0) {
    const cont = { catalogo: 0, inferido: 0, 'sem-turno': 0 };
    for (const o of _origensFim) cont[o.origem] = (cont[o.origem] || 0) + 1;

    // Divergência = o catálogo contradisse o +9h. Hoje isso é 0 (os turnos em uso
    // coincidem); quando deixar de ser, aparece aqui em vez de passar batido.
    const diverg = _origensFim
      .filter(o => o.origem === 'catalogo' && o.inferido && o.fim !== o.inferido)
      .map(o => `${o.teamName} ${o.shiftType} ${o.fim}≠${o.inferido}`);

    console.log(
      `[WPA] ${sectorId} escala-fim: catalogo=${cont.catalogo} inferido=${cont.inferido}` +
      ` sem-turno=${cont['sem-turno']}` +
      (diverg.length > 0 ? ` | ⚠️ catálogo discorda do +9h: ${diverg.join(', ')}` : '')
    );
  }

  _accRecord(result);
  const augmented = _accApply(result);
  const fantasmas = augmented.length - result.length;
  if (fantasmas > 0) {
    console.log(`[WPA] _acc: ${fantasmas} equipe(s) fantasma com notas acumuladas (deslogadas no dia)`);
  }
  return augmented;
}

/**
 * Busca todas as notas atualmente em "Tratar Notas" (devolvidas/pendentes de
 * tratamento pelo backoffice). Endpoint descoberto via DevTools em
 * edp-wpa-po.azurewebsites.net/Notes/StatusNotes.
 *
 * Retorna o array bruto de `Data` — o caller é responsável por filtrar equipes.
 * Cada item tem Number, Type, Team.Name, Status, ConclusionDate,
 * ConclusionStatus, Id, e dezenas de outros campos (muitos null na listagem).
 *
 * @returns {Promise<Array>} array de notas devolvidas.
 */
/**
 * Lista "leve" de equipes do setor — endpoint usado pelo dropdown de filtros
 * em /Notes/StatusNotes. Diferente do array em getNotasDevolvidas, este
 * carrega CompanyId/CompanyName preenchidos, o que permite identificar
 * a empresa (Engelmig vs EDP própria vs outras terceiras) por equipe.
 *
 * @returns {Promise<Array>} cada item tem Name, CompanyId, TeamType, etc.
 */
async function getTeamsSimple(sectorId = 'DESC', statusId = 1) {
  const path = `/api/Teams/Simple?sectorId=${encodeURIComponent(sectorId)}&statusId=${statusId}`;
  const res  = await wpaFetch(path, {
    headers: {
      'Wpa-Data-Context': 'default',
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`WPA Teams/Simple ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  return data?.Data || [];
}

async function getNotasDevolvidas(sectorId = 'DESC') {
  const res = await wpaFetch('/api/Notes/NotesStatusFilterBySector', {
    method:  'POST',
    headers: {
      'Content-Type':     'application/x-www-form-urlencoded; charset=UTF-8',
      'Wpa-Data-Context': 'default',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: `sectorId=${encodeURIComponent(sectorId)}`,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`WPA NotesStatusFilterBySector ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  return data?.Data || [];
}

module.exports = {
  login,
  getToken,
  forceRefresh,
  ensureFreshToken,   // o que o cron deve usar: só reloga dentro da margem do exp
  getTokenStatus,
  wpaFetch,
  // Endpoints individuais (usados em rotas de debug)
  getSessions,
  getSessionDetail,
  getSessionCollaborators,   // P2-14/P2-28 — colaboradores reais por sessão
  getScaleTypes,             // catálogo de turnos da EDP (fim real, intervalo, dias)
  getCollaboratorShifts,     // escala cadastrada do mês (P1-26 / P2-24)
  searchNoteByNumber,        // número humano da nota → UUID (entrada de auditoria)
  getNoteDetail,
  getNotasDevolvidas,
  getTeamsSimple,
  getTeamStatusV2,
  getV2Cached,
  // Principal
  getTeamsBySector,
  _singleFlight,   // exportado p/ teste (coalescência de coletas — incidente 30/07/2026)
  // Histórico
  getTeamsByDate,
  getSessionsByDate,   // usado pelo runSyncLogoffs (cronService)
  REGIONAL_MAP,
  // Exportados pra teste (P3-11) — acumulador diário.
  _accRecord, _accApply, _acc,
  // Exportados pra teste (P1-20) — circuit breaker de login.
  _classifyLoginError, _computeUnlockUntil, _breakerRemaining, _openBreaker, _clearBreaker, _breaker,
  // Kill-switch de conta (WPA_ACCOUNTS_DISABLED).
  isAccountDisabled, isSectorDisabled, _disabledAccounts,
  // Failover de conta por setor (backup SJC).
  _accountsForSector, _resolveUsableAccount,
  // Exportados pra teste (22/08/2026) — token morto (500 "Token is invalid!") e
  // política de renovação pelo exp em vez de pelo relógio do cron.
  _isTokenInvalidBody, _isTokenInvalidResponse, _invalidateToken, _needsTokenRefresh,
  _tokens, _deadTokens,
  // Exportado pra teste (P2-14/P2-28) — lista, objeto, dict único ou Data:null.
  _normalizeSessionCollaborators,
  // Exportados pra teste — catálogo de turnos (fim real do turno).
  _normalizeScaleType, _scaleEndFromCatalog, _escalaFimComOrigem,
  // Exportado pra teste — escala cadastrada do mês (3 níveis, dict×lista).
  _normalizeCollaboratorShifts,
  // Exportados pra teste — busca de nota pelo número humano.
  _isNoteNumber, _normalizeSearchNote,
};
