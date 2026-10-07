#!/usr/bin/env node
/**
 * scripts/migrar-supervisores.js
 *
 * Aplica supabase/migrations/015_supervisores.sql pelo POOL DA APP (wpa_app).
 *
 * Por que não `psql -d wpa_monitor -f ...` como as outras: a 015 faz
 * `ALTER TABLE equipes_oficiais ADD COLUMN`, e ALTER exige ser DONO da tabela.
 * equipes_oficiais é de wpa_app (REASSIGN OWNED BY do restore), e o psql da VM
 * roda como usr_jose → "must be owner of table". É o mesmo motivo pelo qual o
 * cadastro HE (09/09) foi um script node e não um .sql.
 *
 * O arquivo inteiro vai num único `query()` — protocolo simples do Postgres
 * roda múltiplos statements numa transação implícita: entra tudo ou nada.
 * Idempotente (IF NOT EXISTS em tudo): rodar duas vezes não faz mal.
 *
 * MODO PADRÃO É DRY-RUN.
 *
 *   node scripts/migrar-supervisores.js            # mostra o SQL e o estado
 *   node scripts/migrar-supervisores.js --apply    # aplica
 */

'use strict';

require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const { _getPool } = require('../services/pgShim');

const APPLY = process.argv.includes('--apply');
const SQL_PATH = path.join(__dirname, '..', 'supabase', 'migrations', '015_supervisores.sql');

async function estado(pool) {
  const { rows } = await pool.query(`
    SELECT
      to_regclass('public.supervisores')                IS NOT NULL AS tem_catalogo,
      to_regclass('public.equipe_supervisor_historico') IS NOT NULL AS tem_historico,
      EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'equipes_oficiais'
                 AND column_name = 'supervisor_id')         AS tem_coluna`);
  return rows[0];
}

async function main() {
  const sql  = fs.readFileSync(SQL_PATH, 'utf8');
  const pool = _getPool();
  try {
    console.log('antes :', await estado(pool));
    if (!APPLY) {
      console.log(`\n── DRY-RUN. Nada foi escrito. SQL que seria aplicado: ${SQL_PATH}`);
      console.log('   Use --apply pra valer.\n');
      return;
    }
    await pool.query(sql);
    console.log('depois:', await estado(pool));
    console.log('\n✔ 015 aplicada. Reinicie o app (pm2 delete + start) pra o cache pegar a coluna.\n');
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('✖', err.message);
  process.exit(1);
});
