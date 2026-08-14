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

const WPA_AUTH = process.env.WPA_URL      || 'https://edp-wpa-po.azurewebsites.net';
const WPA_API  = process.env.WPA_API_URL  || 'https://edp-wpa-web-api.azurewebsites.net';

// ── MULTI-CONTA ─────────────────────────────────────────────────────────────
// Suporta múltiplas contas WPA, uma por regional/empresa. Cada conta tem
// suas próprias credenciais no .env e seu próprio token JWT.
//
// Adicionado em 08/06/2026 pra incluir regional SJC (EDP SP) com conta
// separada da Clarissa (ES).
//
//   account='es'  → WPA_USERNAME       / WPA_PASSWORD       (Clarissa, GUA/CAC)
//   account='sp'  → WPA_USERNAME_SP    / WPA_PASSWORD_SP    (SJC)
//
// SECTOR_TO_ACCOUNT mapeia sectorId → account pra roteamento automático.
const ACCOUNTS = {
  es: { userEnv: 'WPA_USERNAME',    passEnv: 'WPA_PASSWORD'    },
  sp: { userEnv: 'WPA_USERNAME_SP', passEnv: 'WPA_PASSWORD_SP' },
};
const DEFAULT_ACCOUNT = 'es';

// Mapeamento sectorId → account. Setores não mapeados caem no default.
const SECTOR_TO_ACCOUNT = {
  DESG: 'es', DESC: 'es', DEPT: 'es',  // ES: conta Clarissa
  DSSJ: 'sp',                           // SJC: conta SP
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

function _accountForSector(sectorId) {
  if (!sectorId) return DEFAULT_ACCOUNT;
  return SECTOR_TO_ACCOUNT[String(sectorId).toUpperCase()] || DEFAULT_ACCOUNT;
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

/** Abre o breaker pra conta conforme a classificação. Erro 'other' não abre. */
function _openBreaker(accountKey, message, nowMs = Date.now()) {
  const cls = _classifyLoginError(message);
  if (cls.kind === 'other') return null;
  const until = cls.kind === 'account_locked'
    ? (_computeUnlockUntil(message, nowMs) || (nowMs + LOCKED_FALLBACK_COOLDOWN_MS))
    : (nowMs + INVALID_CRED_COOLDOWN_MS);
  _breaker.set(accountKey, { until, kind: cls.kind, message: String(message).slice(0, 200) });
  return { kind: cls.kind, until };
}

function _clearBreaker(accountKey) { _breaker.delete(accountKey); }

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
/** Setor está desativado? (via a conta que o atende). Usado pela coleta resiliente. */
function isSectorDisabled(sectorId) {
  return isAccountDisabled(_accountForSector(sectorId));
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
  // breaker) — hoje sem chamador; a recuperação normal é corrigir o .env e
  // reiniciar (o restart zera o breaker, que é em memória).
  if (!opts.force) {
    const remaining = _breakerRemaining(accountKey);
    if (remaining > 0) {
      const b = _breaker.get(accountKey);
      const err = new Error(
        `WPA login (account=${accountKey}) em cooldown [${b.kind}] por ~${Math.ceil(remaining / 60000)}min — ` +
        `não tentando /signin pra não travar a conta na EDP. Corrija a credencial (.env) e reinicie. ` +
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
  if (cached && Date.now() < cached.expireAt - 60_000) return cached.token;

  // 2. Cache compartilhado (Supabase) — evita login redundante entre containers.
  //    Em Lambdas Vercel cold-start, o token gravado pelo cron rpa1 (que mantém
  //    WPA quente) é lido aqui em ~50ms, sem bater no /signin do WPA.
  const store = getTokenStore();
  if (store) {
    try {
      const fromStore = await store.loadToken(accountKey);
      if (fromStore?.token && Date.now() < fromStore.expiresAt - 60_000) {
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
          if (fromStore?.token && Date.now() < fromStore.expiresAt - 60_000) {
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
  //   2. Inferir do sectorId no path (?sectorId=DSSJ → 'sp')
  //   3. Default: 'es' (Clarissa)
  const accountKey = options.account
    || _accountForSector(_sectorFromPath(path))
    || DEFAULT_ACCOUNT;

  // Backoff mais curto que o do login: a Web API costuma estar quente quando
  // o auth está; só protege contra cold-start ocasional. Total ~9s.
  const BACKOFF_MS = [3000, 6000];
  const MAX_ATTEMPTS = BACKOFF_MS.length + 1;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const token = await getToken(accountKey);
    let res;
    try {
      res = await fetch(`${WPA_API}${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(options.headers || {}),
        },
      });
    } catch (err) {
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
  const acc = _accountForSector(sectorId);
  if (isAccountDisabled(acc)) {
    if (!_disabledLogged.has(sectorId)) {
      _disabledLogged.add(sectorId);
      console.warn(`[WPA] setor ${sectorId} PULADO — conta '${acc}' desativada (WPA_ACCOUNTS_DISABLED).`);
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
  const [sessions, statusList] = await Promise.all([
    getSessionsByDate(sectorId, todayBRT),
    getV2Cached(sectorId),
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

    const _statusTag = v2 ? '' : (sessaoEncerrada ? ' [ENCERRADA]' : ' [SEM V2]');
    console.log(
      `[WPA]   ${sectorId}/${teamName}: ` +
      `início=${s.BeginTime?.slice(0, 16) || '?'} ` +
      `${s.EndTime ? `fim=${s.EndTime.slice(0, 16)} ` : ''}` +
      `baixadas=${baixadas.length} exec=${executadas.length} ` +
      `conc=${concluidas.length} rej=${rejeitadas.length} ` +
      `carteira=${carteiraCount}${_statusTag}`
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
      // Colaboradores: sessions/current usa estrutura aninhada Collaborator.{Name,Code}
      collaborators: (s.Collaborators || []).map(normalizarColaborador),
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
      // Fim inferido: início + 9h (8h trabalho + 1h refeição). WPA não dá fim.
      escalaFimWPA:    _shiftEndFromStart(_parseShiftStart(v2?.ShiftType), 9),
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
  getTokenStatus,
  wpaFetch,
  // Endpoints individuais (usados em rotas de debug)
  getSessions,
  getSessionDetail,
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
};
