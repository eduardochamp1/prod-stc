/**
 * Auth middleware — WPA Monitor Engelmig
 * JWT simples com HMAC-SHA256 (sem dependências externas)
 * Sessões de 8 horas. Usuários configurados via AUTH_USERS no .env
 */

const crypto = require('crypto');

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
    return payload;
  } catch { return null; }
}

// ── Usuários (configurados no .env) ─────────────────────────────────────────
// Formato AUTH_USERS: "usuario1:sha256hash1:role1:regional1,usuario2:..."
// Roles:     admin | gua | cac | sjc | es
//            (role só controla acesso a /admin; qualquer valor != 'admin' bloqueia)
// Regionais: ALL | GUA | CAC | SJC | ES
//            (ES é grupo que expande pra ['GUA','CAC'] — ver services/regionalGroups.js)

function getUsers() {
  const raw = process.env.AUTH_USERS || '';
  return raw.split(',').filter(Boolean).map(entry => {
    const parts = entry.trim().split(':');
    return {
      username:     parts[0],
      passwordHash: parts[1],
      role:         parts[2] || 'gua',
      regional:     parts[3] || 'ALL',
    };
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
    username: user.username,
    role:     user.role,
    regional: user.regional,
    iat:      now,
    exp:      now + SESSION_SECS,
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
    return res.status(401).json({ error: 'Sessão expirada ou inválida', code: 'EXPIRED' });
  }

  req.user = payload;

  // Força filtro de regional para usuários não-admin
  if (payload.regional && payload.regional !== 'ALL') {
    // Sobrescreve qualquer regional enviado pelo cliente
    req.query.regional = payload.regional;
    if (req.body) req.body.regional = payload.regional;
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

module.exports = { login, authMiddleware, requireAdmin, verifyToken };
