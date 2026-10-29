/**
 * test/serverDotenvTeste.test.js
 *
 * 29/10/2026: com NODE_ENV=test o server.js só desligava o override do dotenv,
 * mas o .env real ainda PREENCHIA o que o teste não definia. O DATABASE_URL de
 * produção chegava aos testes de rota: pool aberto no Postgres real e
 * `node --test` travado pra sempre na máquina do dev. Em teste o .env não pode
 * ser carregado; fora de teste, segue carregando com override.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SERVER = path.join(__dirname, '..', 'server.js');

// O dotenv lê o .env do cwd. Num diretório temporário com um .env-isca, sobe o
// server.js num processo filho e devolve o que ficou em process.env.
function envAposCarregarServer(nodeEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotenv-isca-'));
  try {
    fs.writeFileSync(path.join(dir, '.env'), 'ISCA_DOTENV=veio-do-env\n');
    const script = `require(${JSON.stringify(SERVER)}); process.stdout.write(String(process.env.ISCA_DOTENV)); process.exit(0);`;
    const env = { ...process.env, NODE_ENV: nodeEnv, DATA_MODE: 'mock', JWT_SECRET: 'x', CRON_SECRET: 'x' };
    delete env.ISCA_DOTENV;
    delete env.DATABASE_URL;
    return execFileSync(process.execPath, ['-e', script], { cwd: dir, env, encoding: 'utf8', timeout: 20000 }).trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('NODE_ENV=test não carrega o .env do cwd', () => {
  assert.equal(envAposCarregarServer('test'), 'undefined');
});

test('fora de teste o .env do cwd continua sendo carregado', () => {
  assert.equal(envAposCarregarServer('development'), 'veio-do-env');
});
