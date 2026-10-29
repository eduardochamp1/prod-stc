#!/usr/bin/env node
/**
 * scripts/coletor-windows/montar-pacote.js — monta o zip do coletor Windows (P0-13).
 *
 * 29/10/2026. Gera dist/wpa-coletor-<versão>.zip com:
 *   node\node.exe            Node para Windows x64 (mesma versão da VM), baixado 1x
 *                            para dist/cache/ (nodejs.org passa pelo Fortinet: 200 em 29/10)
 *   coletor.js, services\, db\, mock\, scripts\check-wpa.js, node_modules\, package.json
 *   iniciar.bat, iniciar_coletor.ps1, tunel_banco.ps1, checar.bat, LEIAME.txt,
 *   coletor.env.exemplo, VERSAO.txt
 *   coletor.env              SÓ com --com-env: gerado do .env da VM (lista fechada de
 *                            chaves; banco reescrito para o túnel 127.0.0.1:15432).
 *                            Tem senhas — o zip fica em dist/ (gitignored).
 *
 * Uso (na VM, raiz do repo):
 *   node scripts/coletor-windows/montar-pacote.js            # sem senhas
 *   node scripts/coletor-windows/montar-pacote.js --com-env  # com coletor.env pronto
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const DIST = path.join(RAIZ, 'dist');
const CACHE = path.join(DIST, 'cache');
const PORTA_TUNEL = 15432;

// Chaves do .env que o coletor usa. Fora da lista ficam JWT, AUTH_USERS,
// CRON_SECRET, WEBHOOK_SECRET, PORT, WPA_PROXY, WPA_COLETA (o da VM é `remota`;
// o coletor.js define o seu) etc. — o coletor não serve painel.
const CHAVES = /^(WPA_(?!PROXY$|COLETA$)[A-Z0-9_]+|DATABASE_URL|GSEQ_DATABASE_URL|LOG_LEVEL|DESLOC_USE_FIRST_CP|OSRM_HOST|SNAPSHOT_RETENTION_DAYS|NOTE_DETAILS_RETENTION_DAYS)$/;

/** FUNÇÃO PURA: .env da VM → coletor.env (lista fechada; banco pelo túnel). */
function gerarColetorEnv(textoEnv, porta = PORTA_TUNEL) {
  const linhas = ['# coletor.env — gerado de .env da VM por montar-pacote.js (P0-13). Tem senhas: não compartilhe.',
    'NODE_ENV=production'];
  for (const bruta of textoEnv.split(/\r?\n/)) {
    const m = bruta.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m || !CHAVES.test(m[1])) continue;
    let valor = m[2];
    if (m[1] === 'DATABASE_URL' || m[1] === 'GSEQ_DATABASE_URL') {
      valor = valor.replace(/@(localhost|127\.0\.0\.1)(:\d+)?\//, `@127.0.0.1:${porta}/`);
    }
    linhas.push(`${m[1]}=${valor}`);
  }
  return linhas.join('\r\n') + '\r\n';
}

function baixar(url, destino) {
  return new Promise((ok, falha) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); return baixar(res.headers.location, destino).then(ok, falha);
      }
      if (res.statusCode !== 200) { res.resume(); return falha(new Error(`${url} → HTTP ${res.statusCode}`)); }
      const tmp = destino + '.parcial';
      const f = fs.createWriteStream(tmp);
      res.pipe(f);
      f.on('finish', () => f.close(() => { fs.renameSync(tmp, destino); ok(); }));
      f.on('error', falha);
    }).on('error', falha);
  });
}

function copiar(origem, destino) {
  fs.cpSync(origem, destino, {
    recursive: true,
    filter: (src) => !/[\\/](\.bin|nodemon)([\\/]|$)/.test(src) && !src.endsWith('.test.js'),
  });
}

async function main() {
  const comEnv = process.argv.includes('--com-env');
  const versaoNode = process.version;   // mesma da VM: o que a suíte testa
  const commit = execFileSync('git', ['-C', RAIZ, 'rev-parse', '--short', 'HEAD']).toString().trim();
  const sujo = execFileSync('git', ['-C', RAIZ, 'status', '--porcelain', '--', 'services', 'db', 'coletor.js'])
    .toString().trim() ? '+alterado' : '';
  const versao = `${new Date().toISOString().slice(0, 10)}-${commit}${sujo}`;

  fs.mkdirSync(CACHE, { recursive: true });
  const nodeExe = path.join(CACHE, `node-${versaoNode}-win-x64.exe`);
  if (!fs.existsSync(nodeExe)) {
    console.log(`baixando node.exe ${versaoNode}...`);
    const tmp = nodeExe + '.baixado';
    await baixar(`https://nodejs.org/dist/${versaoNode}/win-x64/node.exe`, tmp);
    // Confere com a lista oficial antes de aceitar (o download passa pelo Fortinet).
    const somas = path.join(CACHE, `SHASUMS256-${versaoNode}.txt`);
    await baixar(`https://nodejs.org/dist/${versaoNode}/SHASUMS256.txt`, somas);
    const linha = fs.readFileSync(somas, 'utf8').split('\n').find(l => l.trim().endsWith(' win-x64/node.exe'));
    const esperado = linha && linha.split(/\s+/)[0];
    const obtido = require('crypto').createHash('sha256').update(fs.readFileSync(tmp)).digest('hex');
    if (!esperado || esperado !== obtido) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`node.exe com sha256 ${obtido}, esperado ${esperado || '(não achei na SHASUMS256)'} — download descartado`);
    }
    fs.renameSync(tmp, nodeExe);
  }

  const nome = `wpa-coletor-${versao}`;
  const pasta = path.join(DIST, nome);
  fs.rmSync(pasta, { recursive: true, force: true });
  fs.mkdirSync(path.join(pasta, 'node'), { recursive: true });
  fs.copyFileSync(nodeExe, path.join(pasta, 'node', 'node.exe'));
  for (const item of ['coletor.js', 'package.json', 'services', 'db', 'mock', 'node_modules']) {
    copiar(path.join(RAIZ, item), path.join(pasta, item));
  }
  fs.mkdirSync(path.join(pasta, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(RAIZ, 'scripts', 'check-wpa.js'), path.join(pasta, 'scripts', 'check-wpa.js'));
  for (const f of ['iniciar.bat', 'checar.bat', 'diag.bat', 'iniciar_coletor.ps1', 'tunel_banco.ps1', 'LEIAME.txt', 'coletor.env.exemplo']) {
    fs.copyFileSync(path.join(__dirname, f), path.join(pasta, f));
  }
  fs.writeFileSync(path.join(pasta, 'VERSAO.txt'), versao + '\r\n');
  if (comEnv) {
    fs.writeFileSync(path.join(pasta, 'coletor.env'), gerarColetorEnv(fs.readFileSync(path.join(RAIZ, '.env'), 'utf8')), { mode: 0o600 });
  }

  const zip = path.join(DIST, `${nome}.zip`);
  fs.rmSync(zip, { force: true });
  execFileSync('python3', ['-c',
    'import os,sys,zipfile\n' +
    'base,dest=sys.argv[1],sys.argv[2]\n' +
    'z=zipfile.ZipFile(dest,"w",zipfile.ZIP_DEFLATED)\n' +
    'pai=os.path.dirname(base)\n' +
    'for r,_,fs in os.walk(base):\n' +
    '  for f in fs:\n' +
    '    p=os.path.join(r,f); z.write(p,os.path.relpath(p,pai))\n' +
    'z.close()', pasta, zip]);
  fs.chmodSync(zip, 0o600);
  const mb = (fs.statSync(zip).size / 1048576).toFixed(1);
  console.log(`✓ ${zip} (${mb} MB)${comEnv ? ' — COM coletor.env (senhas): não compartilhe' : ' — sem coletor.env'}`);
}

if (require.main === module) {
  main().catch((err) => { console.error('✖', err.message); process.exit(1); });
}

module.exports = { gerarColetorEnv };
