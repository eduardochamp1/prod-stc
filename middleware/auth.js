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
// DATA_MODE=wpa é o indicador de "estamos no servidor real com WPA".
if (JWT_SECRET === _DEFAULT_SECRET && process.env.DATA_MODE === 'wpa') {
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

function getUsers() {
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

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

// ── Login ─────────────────────────────────────────────────────────────────────

function login(username, password) {
  const users = getUsers();
  const hash  = sha256(password);
  const user  = users.find(u =>
    u.username === username && u.passwordHash === hash
  );
  if (!user) return null;

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

function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Não autenticado', code: 'NO_TOKEN' });
  }

  const token   = authHeader.slice(7);
  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({
      error: 'Sessão expirada, inválida ou desatualizada',
      code: 'EXPIRED',
      relogin: true,
    });
  }

  req.user = payload;
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

module.exports = {
  login, authMiddleware, requireAdmin, verifyToken, getUsers,
  applyScope, compatRegionalParam,
};
