/**
 * db/index.js
 * Conexão SQLite via better-sqlite3.
 * Banco em arquivo local — zero configuração, sem servidor, sem admin.
 *
 * DB_PATH no .env define onde o arquivo fica (padrão: ./data/wpamonitor.db)
 */

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const DB_PATH = process.env.DB_PATH
  || path.join(__dirname, '../data/wpamonitor.db');

// Garante que o diretório de dados existe
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let _db;

function getDb() {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');  // leituras simultâneas sem lock
    _db.pragma('foreign_keys = ON');
    console.log(`[DB] SQLite → ${DB_PATH}`);
  }
  return _db;
}

/**
 * Executa SQL com parâmetros posicionais ($1, $2 → convertidos para ?).
 * Retorna Promise<{ rows }> para SELECT, Promise<{ rowCount }> para outros.
 */
function query(sql, params = []) {
  try {
    const db         = getDb();
    const normalized = sql.replace(/\$\d+/g, '?');
    const stmt       = db.prepare(normalized);
    const tipo       = sql.trimStart().toUpperCase();

    if (tipo.startsWith('SELECT') || tipo.startsWith('WITH')) {
      return Promise.resolve({ rows: stmt.all(params) });
    }
    const result = stmt.run(params);
    return Promise.resolve({ rowCount: result.changes });
  } catch (err) {
    return Promise.reject(err);
  }
}

module.exports = { query, getDb };
