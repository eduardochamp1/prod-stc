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
 *   node coletor.js --diag [SETOR] [AAAA-MM-DD] — 3 consultas (V2, sessões de hoje e da
 *                              data) e a resposta crua (29/10/2026: 1ª ligação voltou 0 equipes)
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

  if (process.argv.includes('--diag')) {
    // 29/10/2026: na 1ª ligação a EDP devolveu 0 equipes em todos os setores, de
    // hoje e de 27/10. Mostra a resposta crua de UMA consulta para separar
    // "Nenhum dado encontrado" (P0-10) de erro de login ou de rede.
    const args = process.argv.slice(process.argv.indexOf('--diag') + 1);
    const setor = (args.find(a => /^[A-Z]{4}$/.test(a))) || 'DESG';
    const { dateBRT } = require('./services/timeUtil');
    const data = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || dateBRT(Date.now() - 86400000);
    const wpa = require('./services/wpaService');
    const { wpaUserAgent } = require('./services/wpaHttp');
    console.log(`[diag] User-Agent: ${wpaUserAgent()} · conta do setor ${setor}: ${wpa._accountsForSector(setor).join(' → ')}`);
    // 29/10/2026: o portal (Gestão Online) mostrava o DESG ao vivo enquanto o
    // Sessions/all/date de 27/10 voltava vazio. Faz as consultas que o portal faz
    // (teamsstatus/V2) e o Sessions/all/date de hoje e da data pedida: separa
    // "conta/cliente bloqueado" de "só a consulta de sessões por data mudou".
    const hoje = dateBRT();
    const consultas = [
      ['V2 (o que a Gestão Online usa)', 'GET', `/api/teamsstatus/V2?sectorId=${setor}`],
      [`sessões de hoje (${hoje})`, 'POST', `/api/Sessions/all/date?sectorId=${setor}&date=${encodeURIComponent(wpa.toWpaDate(hoje))}`],
      [`sessões de ${data}`, 'POST', `/api/Sessions/all/date?sectorId=${setor}&date=${encodeURIComponent(wpa.toWpaDate(data))}`],
    ];
    for (const [nome, metodo, url] of consultas) {
      console.log(`[diag] ${nome}: ${metodo} ${decodeURIComponent(url)}`);
      try {
        const res = await wpa.wpaFetch(url, { method: metodo });
        const corpo = await res.text();
        let n = null; try { const j = JSON.parse(corpo); n = Array.isArray(j) ? j.length : (Array.isArray(j.Data) ? j.Data.length : null); } catch {}
        console.log(`[diag]   HTTP ${res.status} · ${corpo.length} bytes · itens: ${n === null ? '(nenhuma lista)' : n}`);
        console.log(`[diag]   início: ${corpo.slice(0, 200).replace(/\s+/g, ' ')}`);
      } catch (err) {
        console.log(`[diag]   falhou: ${err.code || ''} ${err.message}`);
      }
    }
    await require('./services/pgShim')._getPool().end().catch(() => {});
    process.exit(0);
  }

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
