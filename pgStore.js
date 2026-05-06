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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS spawn_tickets (
        ticket_id VARCHAR PRIMARY KEY,
        channel_id VARCHAR NOT NULL,
        user_id VARCHAR NOT NULL,
        username VARCHAR,
        discord_username VARCHAR,
        age VARCHAR,
        platform VARCHAR,
        gamertag VARCHAR,
        source VARCHAR,
        checks JSONB DEFAULT '{}',
        status VARCHAR DEFAULT 'open',
        created_at BIGINT,
        checklist_message_id VARCHAR
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS session (
        sid VARCHAR NOT NULL COLLATE "default",
        sess JSON NOT NULL,
        expire TIMESTAMP(6) NOT NULL,
        CONSTRAINT session_pkey PRIMARY KEY (sid) NOT DEFERRABLE INITIALLY IMMEDIATE
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_session_expire ON session (expire)
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shop_orders (
        order_id VARCHAR PRIMARY KEY,
        channel_id VARCHAR NOT NULL,
        user_id VARCHAR NOT NULL,
        username VARCHAR,
        data JSONB NOT NULL DEFAULT '{}',
        status VARCHAR DEFAULT 'pending',
        created_at BIGINT
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_shop_orders_channel ON shop_orders (channel_id)
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reclaim_tickets (
        ticket_id VARCHAR PRIMARY KEY,
        channel_id VARCHAR NOT NULL,
        user_id VARCHAR NOT NULL,
        username VARCHAR,
        data JSONB NOT NULL DEFAULT '{}',
        status VARCHAR DEFAULT 'open',
        created_at BIGINT
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_reclaim_channel ON reclaim_tickets (channel_id)
    `);
    console.log('✅ Tables app_data + member_history + spawn_tickets + shop_orders + reclaim_tickets + session prêtes');
  } catch (err) {
    console.error('❌ Erreur création tables:', err.message);
    usePostgres = false;
  }
}

async function saveSpawnTicket(data) {
  if (!usePostgres) return;
  try {
    await pool.query(`
      INSERT INTO spawn_tickets
        (ticket_id, channel_id, user_id, username, discord_username, age, platform, gamertag, source, checks, status, created_at, checklist_message_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (ticket_id) DO UPDATE SET
        channel_id = EXCLUDED.channel_id,
        checks = EXCLUDED.checks,
        status = EXCLUDED.status,
        checklist_message_id = EXCLUDED.checklist_message_id
    `, [
      data.ticketId, data.channelId, data.userId, data.username, data.discordUsername,
      data.age, data.platform, data.gamertag, data.source || null,
      JSON.stringify(data.checks), data.status, data.createdAt, data.checklistMessageId || null,
    ]);
  } catch (err) {
    console.error('❌ Erreur sauvegarde spawn ticket:', err.message);
  }
}

async function loadAllOpenSpawnTickets() {
  if (!usePostgres) return [];
  try {
    const result = await pool.query(`SELECT * FROM spawn_tickets WHERE status != 'deleted'`);
    return result.rows.map(row => ({
      ticketId: row.ticket_id,
      channelId: row.channel_id,
      userId: row.user_id,
      username: row.username,
      discordUsername: row.discord_username,
      age: row.age,
      platform: row.platform,
      gamertag: row.gamertag,
      source: row.source,
      checks: typeof row.checks === 'string' ? JSON.parse(row.checks) : (row.checks || {}),
      status: row.status,
      createdAt: Number(row.created_at),
      checklistMessageId: row.checklist_message_id,
    }));
  } catch (err) {
    console.error('❌ Erreur chargement spawn tickets:', err.message);
    return [];
  }
}

async function deleteSpawnTicket(ticketId) {
  if (!usePostgres) return;
  try {
    await pool.query(`DELETE FROM spawn_tickets WHERE ticket_id = $1`, [ticketId]);
  } catch (err) {
    console.error('❌ Erreur suppression spawn ticket:', err.message);
  }
}

async function getData(key, fallback) {
  if (!usePostgres) return null;
  try {
    const res = await pool.query('SELECT value FROM app_data WHERE key = $1', [key]);
    if (res.rows.length > 0) {
      const raw = res.rows[0].value;
      if (typeof raw === 'string') {
        try { return JSON.parse(raw); } catch { return raw; }
      }
      return raw;
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

// ── Shop Orders ───────────────────────────────────────────────────────────────

async function saveShopOrder(orderData) {
  if (!usePostgres) return;
  try {
    await pool.query(`
      INSERT INTO shop_orders (order_id, channel_id, user_id, username, data, status, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (order_id) DO UPDATE SET
        data = EXCLUDED.data,
        status = EXCLUDED.status
    `, [
      orderData.orderId,
      orderData.channelId,
      orderData.userId,
      orderData.username || null,
      JSON.stringify(orderData),
      orderData.status || 'pending',
      orderData.createdAt || Date.now(),
    ]);
  } catch (err) {
    console.error('❌ Erreur sauvegarde shop order:', err.message);
  }
}

async function loadAllOpenShopOrders() {
  if (!usePostgres) return [];
  try {
    const result = await pool.query(`SELECT data FROM shop_orders WHERE status NOT IN ('deleted')`);
    return result.rows.map(row => {
      const raw = row.data;
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    });
  } catch (err) {
    console.error('❌ Erreur chargement shop orders:', err.message);
    return [];
  }
}

async function deleteShopOrder(orderId) {
  if (!usePostgres) return;
  try {
    await pool.query(`DELETE FROM shop_orders WHERE order_id = $1`, [orderId]);
  } catch (err) {
    console.error('❌ Erreur suppression shop order:', err.message);
  }
}

// ── Reclaim Tickets ───────────────────────────────────────────────────────────

async function saveReclaimTicket(ticketData) {
  if (!usePostgres) return;
  try {
    await pool.query(`
      INSERT INTO reclaim_tickets (ticket_id, channel_id, user_id, username, data, status, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (ticket_id) DO UPDATE SET
        data = EXCLUDED.data,
        status = EXCLUDED.status
    `, [
      ticketData.ticketId,
      ticketData.channelId,
      ticketData.userId,
      ticketData.username || null,
      JSON.stringify(ticketData),
      ticketData.status || 'open',
      ticketData.createdAt || Date.now(),
    ]);
  } catch (err) {
    console.error('❌ Erreur sauvegarde reclaim ticket:', err.message);
  }
}

async function loadAllOpenReclaimTickets() {
  if (!usePostgres) return [];
  try {
    const result = await pool.query(`SELECT data FROM reclaim_tickets WHERE status != 'deleted'`);
    return result.rows.map(row => {
      const raw = row.data;
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    });
  } catch (err) {
    console.error('❌ Erreur chargement reclaim tickets:', err.message);
    return [];
  }
}

async function deleteReclaimTicket(ticketId) {
  if (!usePostgres) return;
  try {
    await pool.query(`DELETE FROM reclaim_tickets WHERE ticket_id = $1`, [ticketId]);
  } catch (err) {
    console.error('❌ Erreur suppression reclaim ticket:', err.message);
  }
}

function isPostgres() {
  return usePostgres;
}

function getPool() {
  return pool;
}

module.exports = {
  initPool, initTables, getData, setData, isPostgres, getPool,
  saveSpawnTicket, loadAllOpenSpawnTickets, deleteSpawnTicket,
  saveShopOrder, loadAllOpenShopOrders, deleteShopOrder,
  saveReclaimTicket, loadAllOpenReclaimTickets, deleteReclaimTicket,
};
