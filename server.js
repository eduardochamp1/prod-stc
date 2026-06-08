// override:true força sobrescrever vars já existentes no process.env (do pm2,
// systemd, ou shell). Sem isso, ambiente herdado de outro projeto/sessão
// derruba o .env corrente — visto em 08/06/2026 quando AUTH_USERS e
// DATABASE_URL ficavam com valor antigo apesar do .env atualizado.
require('dotenv').config({ override: true });

const crypto   = require('crypto');
const { exec } = require('child_process');
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const routes   = require('./routes/index');
const cronRoutes = require('./routes/cron');

const app  = express();
const PORT = process.env.PORT || 3002;

app.use(cors());

// ── WEBHOOK DE DEPLOY (antes do JSON parser para preservar raw body) ──────────

app.post('/webhook/deploy', express.raw({ type: 'application/json' }), (req, res) => {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[WEBHOOK] WEBHOOK_SECRET não configurado — requisição ignorada.');
    return res.status(500).json({ error: 'WEBHOOK_SECRET não configurado' });
  }

  // Verifica assinatura do GitHub
  const sig = req.headers['x-hub-signature-256'] || '';
  const digest = 'sha256=' + crypto.createHmac('sha256', secret).update(req.body).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(digest))) {
    console.warn('[WEBHOOK] Assinatura inválida — requisição rejeitada.');
    return res.status(401).json({ error: 'Assinatura inválida' });
  }

  const payload = JSON.parse(req.body.toString());

  // Só atualiza em push no branch main
  if (payload.ref !== 'refs/heads/main') {
    return res.json({ ok: true, msg: `Branch ${payload.ref} ignorada` });
  }

  const commit = payload.head_commit?.message || '—';
  console.log(`[WEBHOOK] Push recebido: "${commit}" — iniciando deploy...`);
  res.json({ ok: true, msg: 'Deploy iniciado' });

  // Executa após responder para não travar o request
  const projectDir = __dirname;
  const cmd = `cd "${projectDir}" && git pull origin main && npm install --production && pm2 restart wpa-monitor`;

  exec(cmd, { env: { ...process.env, PATH: process.env.PATH } }, (err, stdout, stderr) => {
    if (err) {
      console.error('[WEBHOOK] Erro no deploy:', err.message);
      if (stderr) console.error('[WEBHOOK] stderr:', stderr);
      return;
    }
    console.log('[WEBHOOK] Deploy concluído com sucesso.');
    if (stdout) console.log('[WEBHOOK]', stdout.trim());
  });
});

// ─────────────────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Cron endpoints (autenticados via CRON_SECRET, não via JWT de usuário)
// Devem ser montados ANTES de /api → /routes para escapar do authMiddleware
app.use('/api/cron', cronRoutes);

app.use('/api', routes);

app.use(express.static(path.join(__dirname)));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/health', (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ── INICIALIZAÇÃO (apenas fora do Vercel) ─────────────────────────────────────

async function start() {
  if (process.env.DATA_MODE === 'wpa') {
    const { startCron } = require('./services/cronService');
    startCron();
  } else {
    console.log(`[CRON] Modo ${process.env.DATA_MODE || 'mock'} — cron desativado.`);
  }

  app.listen(PORT, () => {
    console.log(`\n  WPA Monitor — Engelmig Energia`);
    console.log(`  http://localhost:${PORT}`);
    console.log(`  Modo    : ${process.env.DATA_MODE || 'mock'}`);
    console.log(`  WPA URL : ${process.env.WPA_URL || 'não configurado'}`);
    console.log(`  Supabase: ${process.env.SUPABASE_SERVICE_KEY ? 'configurado ✓' : 'não configurado'}`);
    console.log(`  Webhook : ${process.env.WEBHOOK_SECRET ? 'configurado ✓' : 'não configurado'}\n`);
  });
}

if (process.env.VERCEL) {
  module.exports = app;
} else {
  start().catch(err => {
    console.error('Erro fatal ao iniciar servidor:', err);
    process.exit(1);
  });
  module.exports = app;
}
