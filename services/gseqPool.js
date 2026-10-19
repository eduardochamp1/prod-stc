'use strict';

/**
 * services/gseqPool.js — conexão SÓ DE LEITURA ao banco do gseq (mesma VM).
 *
 * Usada pela aba "Saída da nota" (P2-70) para ler a trilha do rastreador
 * (`vehicle_positions`) e a placa de cada equipe (`equipes_veiculos`).
 * SPEC-saida-da-nota-2026-10-18.md §5.
 *
 * Configuração: `GSEQ_DATABASE_URL` no `.env`, com um papel que só tem SELECT
 * nessas duas tabelas (SPEC §5, A8: o WPA Monitor não deve poder escrever no
 * banco de outro sistema). SEM a variável, `getGseqPool()` devolve null e
 * quem chama trata como "rastreador não configurado" — nunca como "não saiu".
 */

const { Pool } = require('pg');

let _pool = null;

/** Config do Pool a partir do env, ou null sem `GSEQ_DATABASE_URL`. Pura. */
function configGseqPool(env = process.env) {
  const url = env.GSEQ_DATABASE_URL;
  if (!url) return null;
  // URL copiada do .env do gseq (Prisma) traz `?schema=public`, que o
  // node-postgres não entende.
  const limpa = url.replace(/([?&])schema=[^&]*&?/, '$1').replace(/[?&]$/, '');
  return {
    connectionString: limpa,
    max: 2,                                    // job noturno + rota de detalhe; nada concorrente
    idleTimeoutMillis: 30000,
    application_name: 'wpa-monitor-saida-nota',
    options: '-c statement_timeout=120000 -c default_transaction_read_only=on',
  };
}

function getGseqPool() {
  if (_pool) return _pool;
  const cfg = configGseqPool();
  if (!cfg) return null;
  _pool = new Pool(cfg);
  _pool.on('error', err => console.error('[gseqPool] pool error:', err.message));
  return _pool;
}

/** Testes injetam um pool falso (ou null para simular "não configurado"). */
function _setGseqPool(pool) { _pool = pool; }

module.exports = { configGseqPool, getGseqPool, _setGseqPool };
