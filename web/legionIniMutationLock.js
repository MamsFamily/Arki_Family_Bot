const pgStore = require('../pgStore');
const legion = require('./legionManager');

// One namespace and one map key across the bot and dashboard sharing PostgreSQL.
const NAMESPACE = 0x41524b49; // "ARKI"

async function withMapIniLock(mapId, work) {
  legion.assertMap(mapId);
  const pool = pgStore.getPool();
  if (!pool) throw new Error('PostgreSQL requis pour protéger les écritures INI.');
  const client = await pool.connect();
  const key = parseInt(mapId, 16) | 0;
  let acquired = false;
  try {
    const result = await client.query(
      'SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired',
      [NAMESPACE, key],
    );
    acquired = result.rows[0]?.acquired === true;
    if (!acquired) throw new Error('Une autre modification INI est en cours sur cette carte.');
    return await work();
  } finally {
    try {
      if (acquired) await client.query(
        'SELECT pg_advisory_unlock($1::integer, $2::integer)',
        [NAMESPACE, key],
      );
    } finally {
      client.release();
    }
  }
}

module.exports = { withMapIniLock };