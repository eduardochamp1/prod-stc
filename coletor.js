#!/usr/bin/env node
/**
 * coletor.js — o executável da coleta da EDP fora da VM (P0-13, 29/10/2026).
 *
 * Roda na máquina do José (rede da Engelmig, que a EDP aceita), chama a EDP nas
 * janelas fixas (08h, 12h, 17h + fechamento do D-1) e grava no Postgres da VM
 * por um túnel SSH (`ssh -L 15432:127.0.0.1:5432`), que o iniciar_coletor.ps1
 * abre. Não serve painel: o painel continua na VM, com WPA_COLETA=remota.
 * Ver services/coletorLocal.js e scripts/coletor-windows/LEIAME.txt.
 *
 * Config: coletor.env ao lado deste arquivo (ou COLETOR_ENV=caminho).
 *   node coletor.js            — liga o coletor
 *   node coletor.js --checar   — só confere banco e EDP e sai (0 = ok)
 */

'use strict';

const path = require('path');
const fs = require('fs');

const ENV = process.env.COLETOR_ENV || path.join(__dirname, 'coletor.env');
if (!fs.existsSync(ENV)) {
  console.error(`[coletor] ✖ não achei ${ENV}. Copie coletor.env.exemplo para coletor.env e preencha.`);
  process.exit(1);
}
require('dotenv').config({ path: ENV, override: true });
process.env.DATA_MODE = 'wpa';
process.env.WPA_COLETA = 'coletor';
delete process.env.WPA_PROXY;   // daqui a saída é direta: esta máquina já está na rede que a EDP aceita

const VERSAO = (() => { try { return fs.readFileSync(path.join(__dirname, 'VERSAO.txt'), 'utf8').trim(); } catch { return null; } })();

async function checarBanco() {
  const { _getPool } = require('./services/pgShim');
  const pool = _getPool();
  if (!pool) throw new Error('DATABASE_URL não configurado no coletor.env');
  const { rows } = await pool.query("select now() as agora, (select count(*) from equipes_oficiais) as equipes");
  return rows[0];
}

async function main() {
  const checar = process.argv.includes('--checar');
  console.log(`[coletor] WPA Monitor — coletor da EDP ${VERSAO ? `(${VERSAO}) ` : ''}— config ${ENV}`);

  try {
    const r = await checarBanco();
    console.log(`[coletor] ✓ banco da VM pelo túnel: ${r.equipes} equipes oficiais`);
  } catch (err) {
    console.error(`[coletor] ✖ sem banco (${err.message}). O túnel SSH está aberto? (iniciar_coletor.ps1 abre)`);
    process.exit(1);
  }

  // Sem isto, a 1ª coleta filtra pela lista de fallback (sem SJC) — equipesOficiais.js
  await require('./services/equipesOficiais').forceRefresh();

  if (checar) {
    const { main: checarWpa } = require('./scripts/check-wpa');
    const codigo = await checarWpa(['--proxy', 'none']);   // o check-wpa relê ../.env; daqui a saída é direta
    const { _getPool } = require('./services/pgShim');
    await _getPool().end().catch(() => {});
    process.exit(codigo);
  }

  const { iniciarColetor } = require('./services/coletorLocal');
  iniciarColetor({ versao: VERSAO });
  console.log('[coletor] ✓ ligado — coleta às 08h, 12h e 17h; fechamento do dia anterior na 1ª coleta do dia. Deixe esta janela aberta.');
}

// Mesma política do server.js (P2-41): rejeição solta loga e segue; exceção síncrona sai.
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection (ignorada, processo segue):', (reason && reason.stack) || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException (saindo):', (err && err.stack) || err);
  process.exit(1);
});

main().catch((err) => { console.error('[coletor] erro fatal:', err); process.exit(1); });
