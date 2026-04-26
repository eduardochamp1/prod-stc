require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const routes   = require('./routes/index');

const app  = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api', routes);

app.use(express.static(path.join(__dirname)));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/health', (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ── INICIALIZAÇÃO (apenas fora do Vercel) ─────────────────────────────────────

async function start() {
  // Cron de coleta automática (apenas servidor interno com acesso WPA)
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
    console.log(`  Supabase: ${process.env.SUPABASE_SERVICE_KEY ? 'configurado ✓' : 'não configurado'}\n`);
  });
}

// No Vercel: exporta o app sem iniciar servidor (serverless)
// Localmente: sobe o servidor normalmente
if (process.env.VERCEL) {
  module.exports = app;
} else {
  start().catch(err => {
    console.error('Erro fatal ao iniciar servidor:', err);
    process.exit(1);
  });
  module.exports = app;
}
