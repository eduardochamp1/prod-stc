/**
 * db/schema.js
 * Cria as tabelas SQLite automaticamente na primeira execução.
 */

const { getDb } = require('./index');

function initSchema() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS metas (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      regional   TEXT    NOT NULL,
      tipo_code  TEXT    NOT NULL,
      valor      INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (regional, tipo_code)
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      captured_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      date             TEXT    NOT NULL,
      team_name        TEXT    NOT NULL,
      sector_id        TEXT    NOT NULL,
      regional         TEXT    NOT NULL,
      session_begin    TEXT,
      session_end      TEXT,
      vehicle_plate    TEXT,
      baixadas         INTEGER NOT NULL DEFAULT 0,
      executadas       INTEGER NOT NULL DEFAULT 0,
      concluidas       INTEGER NOT NULL DEFAULT 0,
      rejeitadas       INTEGER NOT NULL DEFAULT 0,
      collaborators    TEXT,
      notas_concluidas TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_date_team
      ON snapshots (date, team_name);

    CREATE TABLE IF NOT EXISTS daily_totals (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      date             TEXT    NOT NULL,
      team_name        TEXT    NOT NULL,
      sector_id        TEXT    NOT NULL,
      regional         TEXT    NOT NULL,
      baixadas         INTEGER NOT NULL DEFAULT 0,
      executadas       INTEGER NOT NULL DEFAULT 0,
      concluidas       INTEGER NOT NULL DEFAULT 0,
      rejeitadas       INTEGER NOT NULL DEFAULT 0,
      tipos_concluidos TEXT,
      UNIQUE (date, team_name)
    );

    CREATE INDEX IF NOT EXISTS idx_daily_totals_date_regional
      ON daily_totals (date, regional);
  `);

  console.log('[DB] Schema SQLite OK.');
}

module.exports = { initSchema };
