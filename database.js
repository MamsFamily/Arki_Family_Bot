const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'db', 'meta.sqlite');

let db = null;

function initDatabase() {
  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      guild_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (guild_id, key)
    )
  `);

  console.log('📦 Base de données SQLite initialisée');
  return db;
}

function getMeta(guildId, key) {
  if (!db) initDatabase();
  const stmt = db.prepare('SELECT value FROM meta WHERE guild_id = ? AND key = ?');
  const row = stmt.get(String(guildId), key);
  return row ? row.value : null;
}

function setMeta(guildId, key, value) {
  if (!db) initDatabase();
  const stmt = db.prepare(`
    INSERT INTO meta (guild_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(guild_id, key) DO UPDATE SET value = excluded.value
  `);
  stmt.run(String(guildId), key, value);
}

function getDatabase() {
  if (!db) initDatabase();
  return db;
}

module.exports = {
  initDatabase,
  getMeta,
  setMeta,
  getDatabase,
};
