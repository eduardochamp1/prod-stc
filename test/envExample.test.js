/**
 * test/envExample.test.js
 *
 * 28/08/2026 — P1-44. O `.env.example` documentava 12 chaves enquanto o código
 * lia 30. O que faltava não era detalhe: faltava o `CRON_SECRET` (sem ele e com
 * `DATA_MODE=wpa` o processo faz `process.exit(1)` no boot), faltavam as
 * credenciais do SJC inteiro, e faltavam os dois botões destrutivos — o
 * kill-switch de conta EDP e o que apaga o histórico bruto.
 *
 * Como o `.env.example` é o primeiro arquivo que a próxima pessoa abre, o drift
 * dele é um problema de BUS FACTOR (P0-1), não de estilo. Este teste faz o drift
 * falhar a suíte em vez de aparecer numa auditoria seis meses depois.
 *
 * ⚠️ Leitura DINÂMICA não é pega por varredura de `process.env.NOME`. Foi assim
 * que 8 chaves ficaram invisíveis por meses:
 *   - `process.env[acc.userEnv]` (wpaService.js:413) — as 4 credenciais SJC, com
 *     os nomes guardados como string em ACCOUNTS;
 *   - `env.PG_POOL_MAX` etc. em `_buildPoolConfig(env = process.env)` (pgShim.js:48);
 *   - `process.env[\`SECTOR_ACCOUNT_CHAIN_${setor}\`]` (wpaService.js:151).
 * Por isso a lista DINAMICAS abaixo existe: elas TÊM de estar documentadas, mas
 * a varredura não as encontra sozinha.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');

/** Varre os .js do backend e devolve os nomes lidos como `process.env.NOME`. */
function envLidasNoCodigo() {
  const alvos = ['services', 'routes', 'db', 'middleware'];
  const arquivos = ['server.js', 'ecosystem.config.js']
    .map(f => path.join(RAIZ, f))
    .filter(f => fs.existsSync(f));

  for (const dir of alvos) {
    const d = path.join(RAIZ, dir);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (f.endsWith('.js')) arquivos.push(path.join(d, f));
    }
  }

  const nomes = new Set();
  for (const f of arquivos) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/process\.env\.([A-Z_0-9]+)/g)) nomes.add(m[1]);
  }
  return nomes;
}

/** Nomes que aparecem no .env.example, inclusive comentados (`# NOME=`). */
function envDocumentadas() {
  const src = fs.readFileSync(path.join(RAIZ, '.env.example'), 'utf8');
  const nomes = new Set();
  for (const m of src.matchAll(/^\s*#?\s*([A-Z_0-9]+)=/gm)) nomes.add(m[1]);
  return nomes;
}

// Do ambiente, não configuração nossa.
const IGNORAR = new Set(['PATH']);

// Famílias de nome DINÂMICO: o sufixo varia (por setor, por conta…), então o
// arquivo documenta o PADRÃO e mostra um exemplo. Não são variáveis fixas, e por
// isso não entram na checagem de "documentada e não lida".
const PREFIXOS_DINAMICOS = ['SECTOR_ACCOUNT_CHAIN_'];
const ehFamiliaDinamica = (n) => PREFIXOS_DINAMICOS.some(pre => n.startsWith(pre));

// Lidas DINAMICAMENTE — a varredura não acha, mas têm de estar documentadas.
const DINAMICAS = [
  'WPA_USERNAME_SP', 'WPA_PASSWORD_SP',      // process.env[acc.userEnv]
  'WPA_USERNAME_SP2', 'WPA_PASSWORD_SP2',
  'PG_POOL_MAX', 'PG_IDLE_MS', 'PG_STATEMENT_TIMEOUT_MS', 'PG_SSL',  // env.NOME
];

test('.env.example documenta TODA variável lida como process.env.NOME', () => {
  const lidas = envLidasNoCodigo();
  const docs  = envDocumentadas();
  const faltando = [...lidas].filter(n => !IGNORAR.has(n) && !docs.has(n)).sort();
  assert.deepEqual(faltando, [],
    `variáveis lidas no código e AUSENTES do .env.example: ${faltando.join(', ')}\n` +
    'Documente no mesmo commit — este arquivo é o que a próxima pessoa abre (P0-1).');
});

test('.env.example documenta as lidas DINAMICAMENTE', () => {
  const docs = envDocumentadas();
  const faltando = DINAMICAS.filter(n => !docs.has(n));
  assert.deepEqual(faltando, [],
    `lidas via process.env[nome] / env.NOME e ausentes: ${faltando.join(', ')}`);
});

test('.env.example não documenta variável MORTA', () => {
  // Documentar o que ninguém lê ensina errado — foi o caso do SUPABASE_URL,
  // resíduo do P3-8, removido em 28/08/2026.
  const lidas = envLidasNoCodigo();
  const docs  = envDocumentadas();
  const dinamicas = new Set(DINAMICAS);
  const mortas = [...docs]
    .filter(n => !lidas.has(n) && !dinamicas.has(n) && !ehFamiliaDinamica(n))
    .sort();
  assert.deepEqual(mortas, [],
    `documentadas e não lidas por ninguém: ${mortas.join(', ')}`);
});

test('.env.example documenta a família SECTOR_ACCOUNT_CHAIN_<SETOR>', () => {
  // Override de cadeia de contas por setor, lido como
  // process.env[`SECTOR_ACCOUNT_CHAIN_${setor}`] (wpaService.js:151). Nome
  // dinâmico, então o arquivo tem de explicar o padrão — não dá pra listar todas.
  const src = fs.readFileSync(path.join(RAIZ, '.env.example'), 'utf8');
  assert.match(src, /SECTOR_ACCOUNT_CHAIN_/, 'a família tem de aparecer no arquivo');
  assert.match(src, /SECTOR_ACCOUNT_CHAIN_<SETOR>|SECTOR_ACCOUNT_CHAIN_DSSJ/,
    'precisa mostrar o padrão ou um exemplo concreto');
});

test('.env.example avisa sobre as chaves perigosas', () => {
  const src = fs.readFileSync(path.join(RAIZ, '.env.example'), 'utf8');

  // A que apaga dado tem de estar marcada como destrutiva.
  const iRet = src.indexOf('SNAPSHOT_RETENTION_DAYS');
  assert.ok(iRet > -1, 'SNAPSHOT_RETENTION_DAYS tem de estar no arquivo');
  const blocoRet = src.slice(Math.max(0, iRet - 1200), iRet);
  assert.match(blocoRet, /DESTRUTIVO/,
    'SNAPSHOT_RETENTION_DAYS precisa do aviso de destrutivo — setar apaga o histórico bruto');
  assert.match(blocoRet, /ILIMITADA/,
    'precisa dizer que ausente = retenção ilimitada (decisão de 07/07/2026)');

  // A que impede o boot tem de dizer isso.
  const iCron = src.indexOf('CRON_SECRET=');
  assert.ok(iCron > -1, 'CRON_SECRET tem de estar no arquivo');
  const blocoCron = src.slice(Math.max(0, iCron - 1200), iCron);
  assert.match(blocoCron, /process\.exit\(1\)|não sobe|BOOT/i,
    'CRON_SECRET precisa avisar que sem ela o processo não sobe com DATA_MODE=wpa');

  // O kill-switch tem de explicar o efeito.
  const iKill = src.indexOf('WPA_ACCOUNTS_DISABLED=');
  assert.ok(iKill > -1, 'WPA_ACCOUNTS_DISABLED tem de estar no arquivo');
  const blocoKill = src.slice(Math.max(0, iKill - 1400), iKill);
  assert.match(blocoKill, /kill-switch/i);
  assert.match(blocoKill, /PULADOS|pausada/,
    'precisa dizer que os setores da conta são pulados e a regional aparece como pausada');
});

test('.env.example lembra das aspas na senha da WPA', () => {
  // O dotenv corta o valor no primeiro `#`. Senha com `#` chegava truncada e a
  // EDP recusava — custou ~40 min em 14/08/2026.
  const src = fs.readFileSync(path.join(RAIZ, '.env.example'), 'utf8');
  const i = src.indexOf('WPA_PASSWORD=');
  assert.ok(i > -1);
  const bloco = src.slice(Math.max(0, i - 800), i);
  assert.match(bloco, /aspas/i, 'o aviso das aspas duplas precisa estar junto da senha');
});
