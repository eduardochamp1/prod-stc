// override:true força sobrescrever vars já existentes no process.env (do pm2,
// systemd, ou shell). Sem isso, ambiente herdado de outro projeto/sessão
// derruba o .env corrente — visto em 08/06/2026 quando AUTH_USERS e
// DATABASE_URL ficavam com valor antigo apesar do .env atualizado.
//
// Exceção NODE_ENV=test: aqui o override é DESLIGADO pra não deixar o .env de
// produção da VM sobrescrever os usuários/segredos que test/routes.test.js
// injeta em process.env antes de require('../server'). Sem isso, `node --test`
// na VM dava 401 em todo teste de rota (o .env real clobbava as credenciais de
// teste). Em produção NODE_ENV não é 'test' → comportamento acima intacto.
//
// 29/10/2026: não basta desligar o override — sem override o dotenv ainda
// PREENCHE o que o teste não definiu, e o DATABASE_URL do .env real chegava aos
// testes de rota: pool aberto no Postgres de PRODUÇÃO, `node --test` travado
// pra sempre em 6 arquivos (loginRateLimit, routes, alertasRotas…) na máquina
// do dev, e qualquer escrita de teste caindo no banco real. Em teste o .env não
// é carregado; a suíte é autossuficiente (2025/2025 sem .env).
if (process.env.NODE_ENV !== 'test') require('dotenv').config({ override: true });

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const routes   = require('./routes/index');
const cronRoutes = require('./routes/cron');

const app  = express();
const PORT = process.env.PORT || 3002;

app.use(cors());

// ── Security headers (P2-4) ───────────────────────────────────────────────────
// CSP é defesa-em-profundidade: o escaping de dados EDP (escapeHtml no front) é a
// defesa primária contra XSS; aqui limitamos o estrago caso algo escape.
// Fontes externas LEGÍTIMAS do front (validadas por grep em 22/07/2026):
//   • tiles do mapa Leaflet → https://{s}.tile.openstreetmap.org  (img-src)
//   • proxy OSRM (deslocamentos) → osrm-proxy.jose-zouain.workers.dev (connect-src)
//   • ícones/logos base64 (data:) e fotos WPA (data:)              (img-src data:)
// 'unsafe-inline' é necessário: index.html tem <script> e onclick inline + estilos
// inline. Endurecer isso (nonces) exigiria refatorar o monólito — ver H11/backlog.
// NÃO adicione CDNs aqui: Fortinet bloqueia CDN em prod (tudo é vendorizado).
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  // tile.openstreetmap.org sem subdomínio (15/10/2026) — `*.` não casa o host nu.
  "img-src 'self' data: https://tile.openstreetmap.org https://*.tile.openstreetmap.org",
  "connect-src 'self' https://osrm-proxy.jose-zouain.workers.dev",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
].join('; ');

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// ── WEBHOOK DE DEPLOY — REMOVIDO em 28/08/2026 (auditoria P2-42) ─────────────
//
// Existia aqui um POST /webhook/deploy PÚBLICO (montado antes de qualquer auth)
// que, com a assinatura certa, executava:
//   cd <projeto> && git pull origin main && npm install --production && pm2 restart wpa-monitor
//
// Removido, e não consertado, por três razões:
//
//  1. usava `pm2 restart`, que a REGRA 4 do CLAUDE.md proíbe — restart/reload não
//     recarrega env var de forma confiável em cluster mode. O deploy rodava pela
//     via que o próprio projeto documentou como quebrada, e a falha era
//     silenciosa: o processo subia, com env velho. O procedimento correto é
//     `pm2 delete wpa-monitor && pm2 start ecosystem.config.js && pm2 save`.
//
//  2. `crypto.timingSafeEqual` LANÇA quando os buffers têm tamanhos diferentes,
//     então POST sem o header `x-hub-signature-256` virava 500 (o Express
//     capturava o throw), não 401 — e o log não distinguia scanner de erro real.
//     Mesmo defeito que o P1-43 consertou no /api/cron.
//
//  3. era superfície de RCE mantida viva pra um fluxo que ninguém usa: o deploy
//     é manual na VM (CLAUDE.md), `WEBHOOK_SECRET` não está no .env, e a rota
//     rodava `npm install` — que depende de rede que o Fortinet filtra, com a
//     flag `--production` deprecada desde o npm 9.
//
// Saíram junto os imports de `crypto` e `child_process`, usados só aqui.
//
// Se um dia o deploy automático voltar, ele volta DESENHADO: assinatura validada
// sem lançar, procedimento de restart correto, e FORA do processo que serve o
// painel. Ver P2-42 em docs/handoff/AUDIT-2026-08-28.md.

// ─────────────────────────────────────────────────────────────────────────────

// Timing de requisição: loga só o que passar de SLOW_REQUEST_MS (default 1500).
// Adicionado em 21/08/2026 porque "algumas páginas estão lentas" não tinha como
// ser investigado — não havia medida de latência por rota. Ver o middleware.
const { requestTiming } = require('./middleware/requestTiming');
app.use(requestTiming);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Origem das requisições à EDP (19/10/2026, P0-11): tudo que uma chamada de /api
// disparar contra a WPA é contado como `painel:<MÉTODO> <rota>` (ou `cron-http:`
// para /api/cron). DEPOIS dos body parsers de propósito: eles leem o corpo por
// eventos de stream, que não carregam o contexto do AsyncLocalStorage — montado
// antes, um POST perderia a marca. Ver services/wpaContador.js.
const wpaContador = require('./services/wpaContador');
app.use('/api', (req, _res, next) => wpaContador.comOrigem(wpaContador.origemDaRota(req.method, req.path), next));

// Cron endpoints (autenticados via CRON_SECRET, não via JWT de usuário)
// Devem ser montados ANTES de /api → /routes para escapar do authMiddleware
app.use('/api/cron', cronRoutes);

app.use('/api', routes);

// /health ANTES do static/catch-all (senão o app.get('*') responde HTML e o
// health check vira placebo — bug P1-2, corrigido 08/07/2026). Faz check REAL:
// SELECT 1 no Postgres + idade do último snapshot. Retorna 503 se degradado,
// pra que watchdog/monitor externo detecte de verdade (P1-1, P2-9).
app.get('/health', async (_req, res) => {
  const out = { ok: true, ts: new Date().toISOString() };
  try {
    const { _getPool } = require('./services/pgShim');
    const pool = _getPool();
    await pool.query('SELECT 1');
    out.db = 'ok';

    // Idade do último snapshot (só relevante em horário operacional 06-20h BRT)
    const { rows } = await pool.query('SELECT max(captured_at) AS last FROM snapshots');
    const last = rows[0] && rows[0].last ? new Date(rows[0].last) : null;
    if (last) {
      const ageMin = Math.round((Date.now() - last.getTime()) / 60000);
      out.last_snapshot_min = ageMin;
      const horaBRT = (new Date(Date.now() - 3 * 3600 * 1000)).getUTCHours();
      const emHorarioOperacional = horaBRT >= 6 && horaBRT < 20;
      if (emHorarioOperacional && ageMin > 30) {
        out.ok = false;
        out.reason = `último snapshot há ${ageMin}min (esperado <30 em horário operacional)`;
      }
    } else {
      out.last_snapshot_min = null;
    }
  } catch (err) {
    out.ok = false;
    out.db = 'error';
    out.reason = 'Postgres inacessível';
    console.error('[health] check falhou:', err.message);
  }
  res.status(out.ok ? 200 : 503).json(out);
});

// Serve SÓ o public/ — nunca a raiz do repo (P2-3, 22/07/2026). Antes servia
// __dirname inteiro, expondo server.js, services/*, db/*, logs/* e afins por
// HTTP sem autenticação. Os assets do cliente (index.html, vendor/, logo.*)
// vivem em public/. Arquivo fora do public/ simplesmente não é servível.
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  // Fallback SPA só pra rotas "de página" (sem extensão). Um caminho COM
  // extensão que chega aqui é asset inexistente/fora do public/ → 404 — não
  // devolve o HTML no lugar de um .js/.log, e /server.js, /logs/*.log dão 404.
  if (path.extname(req.path)) return res.status(404).end();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── INICIALIZAÇÃO (apenas fora do Vercel) ─────────────────────────────────────

async function start() {
  if (process.env.DATA_MODE === 'wpa') {
    const { startCron } = require('./services/cronService');
    startCron();
  } else {
    console.log(`[CRON] Modo ${process.env.DATA_MODE || 'mock'} — cron desativado.`);
  }

  // P2-10: reconcilia o job de reclassificação persistido. Se o processo caiu
  // com um job 'running', marca 'interrupted' (best-effort — nunca derruba o boot).
  try {
    const reclassifyJobStore = require('./services/reclassifyJobStore');
    const job = await reclassifyJobStore.reconcileOnBoot();
    if (job && job.status === 'interrupted') {
      console.warn(`[BOOT] reclassify job ${job.id} estava 'running' e foi marcado 'interrupted'.`);
    }
  } catch (err) {
    console.warn('[BOOT] reconcile do reclassify job falhou (ignorado):', err.message);
  }

  // 24/10/2026 (spec wpa-acesso-edp.md, R4): com WPA_PROXY, avisa já na subida se
  // o túnel do relay não está de pé — senão o primeiro sinal era o ciclo do cron
  // falhando com WPA_PROXY_INDISPONIVEL. Não espera nem impede o boot.
  const wpaProxy = (process.env.WPA_PROXY || '').trim();
  if (wpaProxy) {
    require('./services/wpaHttp').testarPortaProxy(wpaProxy, 3000).then((t) => {
      if (t.ok) console.log(`[BOOT] WPA_PROXY ${t.endereco} aceita conexão — chamadas à EDP saem pelo relay.`);
      else console.warn(`[BOOT] ⚠️ WPA_PROXY ${t.endereco} NÃO aceita conexão (${t.erro}) — chamadas à EDP vão falhar com WPA_PROXY_INDISPONIVEL até o túnel do relay subir.`);
    });
  }

  app.listen(PORT, () => {
    console.log(`\n  WPA Monitor — Engelmig Energia`);
    console.log(`  http://localhost:${PORT}`);
    console.log(`  Modo    : ${process.env.DATA_MODE || 'mock'}`);
    console.log(`  WPA URL : ${process.env.WPA_URL || 'não configurado'}`);
    console.log(`  Supabase: ${process.env.SUPABASE_SERVICE_KEY ? 'configurado ✓' : 'não configurado'}\n`);
  });
}

// Sobe o servidor só quando executado direto (node server.js / pm2). Quando
// importado por um teste (require('./server')), NÃO faz listen nem start()
// — permite testes de contrato de rota sem conflito de porta nem cron.
// require.main === module é true só pro processo principal.
if (require.main === module) {
  // 13/10/2026 — P2-41. No Node 24 uma promise rejeitada sem .catch() MATA o
  // processo, e `_acc` é em memória (P1-13): queda = subnotificar o dia, e com
  // Postgres fora vira crash loop (runSnapshot reagenda 5s após o boot).
  // Rejeição solta: loga e segue (ciclo perdido < painel fora do ar).
  // Exceção síncrona: estado indefinido, então loga a causa e sai de propósito
  // (o PM2 reinicia). console.error, não logger.js: se a queda for no logger,
  // o console ainda funciona.
  process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] unhandledRejection (ignorada, processo segue):',
      (reason && reason.stack) || reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[FATAL] uncaughtException (saindo):', (err && err.stack) || err);
    process.exit(1);
  });
  start().catch(err => {
    console.error('Erro fatal ao iniciar servidor:', err);
    process.exit(1);
  });
}
module.exports = app;
