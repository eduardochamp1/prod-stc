/**
 * Auth middleware — WPA Monitor Engelmig
 * JWT simples com HMAC-SHA256 (sem dependências externas)
 * Sessões de 8 horas. Usuários configurados via AUTH_USERS no .env
 */

const crypto = require('crypto');
const { isValidRegional } = require('../services/regionals');

const _DEFAULT_SECRET = 'wpa-monitor-mude-esta-chave';
const JWT_SECRET      = process.env.JWT_SECRET || _DEFAULT_SECRET;
const SESSION_SECS    = 8 * 3600; // 8 horas

// Bloqueia boot se o secret padrão for usado em produção.
// Dois indicadores de "produção real": DATA_MODE=wpa (servidor que ingere da
// WPA) e NODE_ENV=production (setado pelo ecosystem.config.js do PM2). Gatear
// nos dois é defesa em profundidade — cobre o caso de produção rodar com outro
// DATA_MODE (ex.: só servindo Postgres). NUNCA aborta em NODE_ENV=test, pra não
// derrubar o runner do `node --test`.
if (JWT_SECRET === _DEFAULT_SECRET
    && process.env.NODE_ENV !== 'test'
    && (process.env.DATA_MODE === 'wpa' || process.env.NODE_ENV === 'production')) {
  console.error('[AUTH] FATAL: JWT_SECRET não configurado! Defina JWT_SECRET no .env antes de iniciar em produção.');
  process.exit(1);
} else if (JWT_SECRET === _DEFAULT_SECRET) {
  console.warn('[AUTH] AVISO: JWT_SECRET usando valor padrão inseguro. Configure JWT_SECRET no .env!');
}

// ── Helpers JWT ──────────────────────────────────────────────────────────────

function b64url(str) {
  return Buffer.from(str).toString('base64url');
}

function signToken(payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body   = b64url(JSON.stringify(payload));
  const sig    = crypto.createHmac('sha256', JWT_SECRET)
                       .update(`${header}.${body}`)
                       .digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyToken(token) {
  try {
    const [header, body, sig] = token.split('.');
    if (!header || !body || !sig) return null;
    const expected = crypto.createHmac('sha256', JWT_SECRET)
                           .update(`${header}.${body}`)
                           .digest('base64url');
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (payload.v !== 2) return null;   // força re-login após upgrade
    return payload;
  } catch { return null; }
}

// ── Usuários (configurados no .env) ─────────────────────────────────────────
// Formato AUTH_USERS: "usuario:sha256hash:role:GUA|CAC|SJC,outro:..."
// Roles:     admin | user
//            (role só controla acesso a /admin; qualquer valor != 'admin' bloqueia)
// Regionais: lista de siglas reais separadas por '|'. Sem 'ALL', sem grupos.

/**
 * Só os usuários do `.env`. Desde 21/09/2026 isto é a CONTA DE EMERGÊNCIA —
 * os demais vivem na tabela `usuarios`. Ver `getUsers` logo abaixo.
 *
 * Continua SÍNCRONA de propósito: é só parsing de variável de ambiente, e é o
 * que o `test/auth.test.js` cobre.
 */
function _usuariosDoEnv() {
  const raw = process.env.AUTH_USERS || '';
  return raw.split(',').filter(Boolean).map(entry => {
    const parts = entry.trim().split(':');
    const username = parts[0];
    const passwordHash = parts[1];
    const role = parts[2] || 'user';
    const regionalsStr = parts[3] || '';

    if (regionalsStr === 'ALL') {
      throw new Error(
        `AUTH_USERS: user "${username}" tem regional="ALL" — não é mais aceito. ` +
        `Liste as siglas explicitamente: GUA|CAC|SJC`
      );
    }
    if (regionalsStr === 'ES') {
      throw new Error(
        `AUTH_USERS: user "${username}" tem regional="ES" — grupos não são mais aceitos. ` +
        `Use GUA|CAC`
      );
    }

    const regionals = regionalsStr
      .split('|')
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);

    if (regionals.length === 0) {
      throw new Error(`AUTH_USERS: user "${username}" sem regionals válidas (campo vazia)`);
    }
    const invalid = regionals.filter(r => !isValidRegional(r));
    if (invalid.length > 0) {
      throw new Error(`AUTH_USERS: user "${username}" tem siglas invalidas: ${invalid.join(', ')}`);
    }
    return { username, passwordHash, role, regionals };
  });
}

/**
 * Usuários do `.env` (conta de emergência) UNIDOS aos do banco.
 *
 * A conta do `.env` é a chave reserva: com o Postgres fora, é a única que
 * entra. Em 09/07/2026 o Postgres caiu em produção (P0-0, ainda aberto: a VM
 * segue sem swap) — sem ela, um repeteco tranca todo mundo pra fora, inclusive
 * de descobrir que o banco caiu.
 *
 * ⚠️ Em colisão de nome, a entrada do `.env` VENCE, e o banco recusa criar
 * usuário com nome do `.env` (services/usuarios.js). Sem as duas regras, quem
 * gerencia criaria um homônimo e qual das duas responde viraria detalhe de
 * implementação decidindo quem entra.
 *
 * Banco fora ⇒ devolve só a conta de emergência. Não é fail-open: o usuário
 * comum simplesmente não é encontrado, e o login falha.
 */
async function getUsers() {
  const doEnv = _usuariosDoEnv();
  const reservados = new Set(doEnv.map(u => u.username));

  let doBanco = [];
  try {
    const { listarDoBanco } = require('../services/usuarios');
    doBanco = (await listarDoBanco())
      .filter(u => u.ativo)                       // desativado não loga
      .filter(u => !reservados.has(u.username))   // o .env vence a colisão
      .map(u => ({
        username:     u.username,
        passwordHash: u.senha_hash,
        role:         u.role,
        regionals:    u.regionals,
      }));
  } catch (err) {
    console.warn('[auth] banco indisponível; só a conta de emergência pode entrar:', err.message);
  }
  return [...doEnv, ...doBanco];
}

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

// Comparação time-safe de strings (evita timing attack na verificação de hash).
function _safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Verifica senha contra o hash armazenado (P1-5). Suporta 2 formatos:
 *   - scrypt$<saltHex>$<hashHex>  → scrypt com salt por usuário (preferido)
 *   - <64 hex chars>              → SHA-256 legado (sem salt) — compat retroativa
 *
 * Migração: rodar scripts/rehash-users.js pra gerar o AUTH_USERS no formato
 * scrypt e substituir no .env. Enquanto o .env tiver hash SHA-256, loga um
 * aviso 1x por boot recomendando a migração.
 */
let _legacyHashWarned = false;
function _verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  if (stored.startsWith('scrypt$')) {
    const [, saltHex, hashHex] = stored.split('$');
    if (!saltHex || !hashHex) return false;
    try {
      const derived = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 32).toString('hex');
      return _safeEqual(derived, hashHex);
    } catch { return false; }
  }
  // Legado SHA-256 (sem salt)
  if (!_legacyHashWarned) {
    console.warn('[AUTH] AUTH_USERS usa hash SHA-256 legado (sem salt). ' +
      'Migre pra scrypt: node scripts/rehash-users.js (ver P1-5 no backlog).');
    _legacyHashWarned = true;
  }
  return _safeEqual(sha256(password), stored);
}

// ── Login ─────────────────────────────────────────────────────────────────────

async function login(username, password) {
  const users = await getUsers();
  const user  = users.find(u => u.username === username);
  if (!user || !_verifyPassword(password, user.passwordHash)) return null;

  const now     = Math.floor(Date.now() / 1000);
  const payload = {
    v:         2,
    username:  user.username,
    role:      user.role,
    regionals: user.regionals,
    iat:       now,
    exp:       now + SESSION_SECS,
  };
  return { token: signToken(payload), ...payload };
}

// ── Middleware Express ────────────────────────────────────────────────────────

/**
 * ⚠️ ASSÍNCRONO desde 21/09/2026. O corpo está em try/catch de propósito: o
 * Express 4 não captura rejeição de middleware `async`, e não existe handler de
 * `unhandledRejection` no projeto (P2-41) — uma promise solta derruba o
 * processo.
 *
 * O PRINCÍPIO: o token prova QUEM você é; o banco diz O QUE você pode.
 *
 * Antes, `role` e `regionals` vinham do token e valiam pelas 8h de sessão —
 * então desativar alguém às 9h, tendo a pessoa entrado às 8h59, a deixava
 * usando o painel até as 16h59. Agora o middleware consulta o usuário (via
 * cache de 30s) e SOBRESCREVE role/regionals com o que está no banco. De
 * quebra, mudança de permissão também passa a valer na hora.
 *
 * A conta de emergência do `.env` não tem linha no banco: para ela valem os
 * valores do `.env`, e ela nunca é negada por "não encontrada". Sem esta
 * exceção, a chave reserva falharia justamente quando é necessária.
 */
async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers['authorization'] || '';
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Não autenticado', code: 'NO_TOKEN' });
    }

    const payload = verifyToken(authHeader.slice(7));
    if (!payload) {
      return res.status(401).json({
        error: 'Sessão expirada, inválida ou desatualizada',
        code: 'EXPIRED',
        relogin: true,
      });
    }

    // Conta do .env (a de emergência): identidade e escopo vêm de lá, porque
    // ela precisa funcionar com o banco fora.
    const doEnv = _usuariosDoEnv().find(u => u.username === payload.username);
    if (doEnv) {
      // ⚠️ `pode_gerenciar` vem do BANCO, não do `.env`, e isso é deliberado.
      //
      // Dar a permissão a toda conta do `.env` parece inofensivo depois da
      // migração (sobra uma conta só), mas DURANTE a transição o `.env` ainda
      // tem as contas antigas — e todas virariam gestoras de uma vez, sem
      // ninguém conceder. Escalonamento silencioso, na janela em que menos se
      // está olhando.
      //
      // E, no sentido inverso: a conta que a migração marcou como gestora no
      // banco é sombreada pela homônima do `.env` (o `.env` vence, §3.3), então
      // sem esta consulta a tela nasceria inacessível justo para quem devia
      // usá-la.
      //
      // Com o banco fora, `buscar` devolve null e a permissão fica false — o
      // que não custa nada: gerenciar usuário exige banco de qualquer forma.
      const { buscar } = require('../services/usuarios');
      const linhaBanco = await buscar(payload.username);
      req.user = {
        ...payload,
        role:           doEnv.role,
        regionals:      doEnv.regionals,
        pode_gerenciar: !!(linhaBanco && linhaBanco.ativo && linhaBanco.pode_gerenciar),
      };
      return next();
    }

    const { buscar } = require('../services/usuarios');
    const atual = await buscar(payload.username);

    // Não achou (inclusive: banco fora E sem cache) ⇒ NEGA. Fail-open aqui é
    // o defeito que o P1-32 consertou no breaker de login.
    if (!atual || !atual.ativo) {
      return res.status(401).json({
        error: 'Acesso revogado ou sessão inválida',
        code: 'REVOKED',
        relogin: true,
      });
    }

    req.user = {
      ...payload,
      role:           atual.role,
      regionals:      atual.regionals,
      pode_gerenciar: atual.pode_gerenciar,
    };
    next();
  } catch (err) {
    console.error('[auth] erro no authMiddleware:', err.message);
    return res.status(500).json({ error: 'Falha na autenticação' });
  }
}

/**
 * Exige a permissão de GERENCIAR usuários — separada de role='admin'.
 * `admin` abre o /admin inteiro; esta diz quem mexe em quem entra.
 *
 * Use DEPOIS de authMiddleware, que é quem popula `pode_gerenciar`.
 */
function requireGerenciarUsuarios(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Não autenticado', code: 'NO_TOKEN' });
  }
  if (!req.user.pode_gerenciar) {
    return res.status(403).json({
      error: 'Você não tem permissão para gerenciar usuários',
      code: 'FORBIDDEN',
    });
  }
  next();
}

// ── Middleware: exige role=admin ──────────────────────────────────────────────
// Use DEPOIS de authMiddleware nas rotas administrativas.
// Ex: router.post('/admin/equipes', requireAdmin, handler)
function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Não autenticado', code: 'NO_TOKEN' });
  }
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso restrito a administradores', code: 'FORBIDDEN' });
  }
  next();
}

// ── Compat soft: aceita ?regional=GUA (singular, legado) ─────────────────
// Converte pra ?regionals=GUA e remove o singular. Loga warn quando usado.
// Pode ser removido depois de 1 release uma vez que os bookmarks/integrações migrarem.
function compatRegionalParam(req, _res, next) {
  if (req.query.regional && !req.query.regionals) {
    const v = String(req.query.regional);
    if (v === 'ALL' || v === 'ES') {
      console.warn('[compat] legacy regional param:', { user: req.user?.username, value: v });
      delete req.query.regional;   // deixa scope cair em "todas do user"
    } else {
      req.query.regionals = v;
      delete req.query.regional;
    }
  }
  next();
}

// ── Aplica escopo de regionais ─────────────────────────────────────────────
// Lê ?regionals=CSV, intersecta com req.user.regionals, popula req.scope.regionals.
// Sem param → todas do user. Intersect vazio → 403.
function applyScope(req, res, next) {
  if (!req.user || !Array.isArray(req.user.regionals)) {
    return res.status(401).json({ error: 'sem regionals no token', code: 'NO_REGIONALS' });
  }
  const requested = String(req.query.regionals || '')
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);

  const allowed = req.user.regionals;
  const scope = requested.length === 0
    ? [...allowed]
    : requested.filter(r => allowed.includes(r));

  if (scope.length === 0) {
    return res.status(403).json({ error: 'no_accessible_regionals' });
  }

  req.scope = { regionals: scope };
  next();
}

// Gera hash scrypt no formato scrypt$salt$hash (usado por scripts/rehash-users.js).
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

module.exports = {
  login, authMiddleware, requireAdmin, requireGerenciarUsuarios, verifyToken, getUsers,
  // `_usuariosDoEnv` é a parte SÍNCRONA (só parsing do .env). Exposta porque o
  // test/auth.test.js cobre exatamente isso, e `getUsers` virou assíncrono em
  // 21/09/2026 ao passar a ler do banco.
  _usuariosDoEnv,
  applyScope, compatRegionalParam,
  hashPassword, _verifyPassword,
};
