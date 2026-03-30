const { Pool } = require('pg');

let pool = null;
let usePostgres = false;

function initPool() {
  const dbUrl = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
  if (!dbUrl) {
    console.log('⚠️ DATABASE_URL non défini, utilisation des fichiers JSON locaux');
    return false;
  }
  try {
    pool = new Pool({
      connectionString: dbUrl,
      ssl: false,
      max: 5,
      idleTimeoutMillis: 30000,
    });
    usePostgres = true;
    console.log('✅ Connexion PostgreSQL configurée');
    return true;
  } catch (err) {
    console.error('❌ Erreur connexion PostgreSQL:', err.message);
    return false;
  }
}

async function initTables() {
  if (!usePostgres) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_data (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL DEFAULT '{}',
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS member_history (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        joined_at BIGINT NOT NULL,
        left_at BIGINT DEFAULT NULL
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_mh_user_guild ON member_history (user_id, guild_id)
    `);
    console.log('✅ Tables app_data + member_history prêtes');
  } catch (err) {
    console.error('❌ Erreur création tables:', err.message);
    usePostgres = false;
  }
}

async function getData(key, fallback) {
  if (!usePostgres) return null;
  try {
    const res = await pool.query('SELECT value FROM app_data WHERE key = $1', [key]);
    if (res.rows.length > 0) {
      return res.rows[0].value;
    }
    return null;
  } catch (err) {
    console.error(`❌ Erreur lecture ${key}:`, err.message);
    return null;
  }
}

async function setData(key, value) {
  if (!usePostgres) return false;
  try {
    await pool.query(
      `INSERT INTO app_data (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, JSON.stringify(value)]
    );
    return true;
  } catch (err) {
    console.error(`❌ Erreur écriture ${key}:`, err.message);
    return false;
  }
}

function isPostgres() {
  return usePostgres;
}

function getPool() {
  return pool;
}

module.exports = { initPool, initTables, getData, setData, isPostgres, getPool };
