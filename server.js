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

// Serve o frontend
app.use(express.static(path.join(__dirname)));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ── INICIALIZAÇÃO ─────────────────────────────────────────────────────────────

async function start() {
  // Banco de dados SQLite
  if (process.env.DB_ENABLED === 'true') {
    try {
      const { initSchema } = require('./db/schema');
      initSchema();
    } catch (err) {
      console.warn(`[DB] Aviso: ${err.message}`);
      console.warn('[DB] App continuará sem persistência.');
    }
  } else {
    console.log('[DB] Banco desativado (DB_ENABLED=false).');
  }

  // Cron de coleta automática
  const { startCron } = require('./services/cronService');
  startCron();

  // Sobe o servidor
  app.listen(PORT, () => {
    console.log(`\n  WPA Monitor — Engelmig Energia`);
    console.log(`  http://localhost:${PORT}`);
    console.log(`  Modo    : ${process.env.DATA_MODE || 'mock'}`);
    console.log(`  WPA URL : ${process.env.WPA_URL || 'não configurado'}`);
    console.log(`  DB      : ${process.env.DB_ENABLED === 'false' ? 'desativado' : (process.env.DATABASE_URL || `${process.env.DB_HOST || 'localhost'}/${process.env.DB_NAME || 'wpamonitor'}`)}\n`);
  });
}

start().catch(err => {
  console.error('Erro fatal ao iniciar servidor:', err);
  process.exit(1);
});
