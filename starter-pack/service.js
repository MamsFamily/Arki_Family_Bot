const crypto = require('node:crypto');
const pgStore = require('../pgStore');
const { MAPS } = require('../web/legionManager');
const pack = require('./pack.json');

const PACK_VERSION = 'starter-ark-1';
const CODE_TTL_MINUTES = 10;
const MAP_IDS = new Set(MAPS.map(map => map.id));
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function isDeliveryEnabled() {
  return process.env.STARTER_PACK_DELIVERY_ENABLED === 'true' &&
    process.env.STARTER_PACK_LINK_ENABLED === 'true' &&
    pack.version === PACK_VERSION &&
    pack.status === 'validated-in-devkit';
}

function db() {
  const pool = pgStore.getPool();
  if (!pgStore.isPostgres() || !pool) throw new Error('Le starter pack nécessite PostgreSQL.');
  return pool;
}

function requireDiscordId(id) {
  if (typeof id !== 'string' || !/^\d{17,20}$/.test(id)) throw new Error('Compte Discord invalide.');
  return id;
}

function requireEosId(id) {
  if (typeof id !== 'string' || !/^[a-fA-F0-9]{32}$/.test(id)) throw new Error('Identifiant EOS invalide.');
  return id.toLowerCase();
}

function requireMap(id) {
  if (!MAP_IDS.has(id)) throw new Error('Carte du cluster non autorisée.');
  return id;
}

function hashCode(code) {
  if (typeof code !== 'string' || !/^[A-HJ-NP-Z2-9]{10}$/.test(code.toUpperCase())) {
    throw new Error('Code de liaison invalide.');
  }
  return crypto.createHash('sha256').update(code.toUpperCase()).digest('hex');
}

function generateCode() {
  const bytes = crypto.randomBytes(10);
  return [...bytes].map(byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

async function init() {
  await db().query(`
    CREATE TABLE IF NOT EXISTS starter_pack_links (
      eos_id TEXT PRIMARY KEY,
      discord_id TEXT NOT NULL UNIQUE,
      linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS starter_pack_codes (
      discord_id TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS starter_pack_claims (
      id UUID PRIMARY KEY,
      eos_id TEXT NOT NULL UNIQUE REFERENCES starter_pack_links(eos_id),
      discord_id TEXT NOT NULL UNIQUE REFERENCES starter_pack_links(discord_id),
      status TEXT NOT NULL CHECK (status IN ('pending', 'delivering', 'delivered')),
      pack_version TEXT NOT NULL,
      map_id TEXT,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivery_started_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ
    )
  `);
}

async function issueCode(discordId) {
  requireDiscordId(discordId);
  const linked = await db().query('SELECT eos_id FROM starter_pack_links WHERE discord_id = $1', [discordId]);
  if (linked.rowCount) throw new Error('Ton compte Discord est déjà lié à un compte de jeu.');
  const code = generateCode();
  await db().query(`
    INSERT INTO starter_pack_codes (discord_id, code_hash, expires_at)
    VALUES ($1, $2, NOW() + INTERVAL '10 minutes')
    ON CONFLICT (discord_id) DO UPDATE
      SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at
  `, [discordId, hashCode(code)]);
  return { code, expiresInMinutes: CODE_TTL_MINUTES };
}

async function confirmLink(code, eosId, mapId) {
  const codeHash = hashCode(code);
  const eos = requireEosId(eosId);
  requireMap(mapId);
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'SELECT discord_id FROM starter_pack_codes WHERE code_hash = $1 AND expires_at > NOW() FOR UPDATE',
      [codeHash],
    );
    if (!result.rowCount) throw new Error('Code expiré ou invalide.');
    const discordId = result.rows[0].discord_id;
    const existing = await client.query(
      'SELECT eos_id, discord_id FROM starter_pack_links WHERE eos_id = $1 OR discord_id = $2',
      [eos, discordId],
    );
    if (existing.rows.some(row => row.eos_id !== eos || row.discord_id !== discordId)) {
      throw new Error('Ce compte Discord ou EOS est déjà lié à un autre compte.');
    }
    if (!existing.rowCount) {
      const inserted = await client.query(
        'INSERT INTO starter_pack_links (eos_id, discord_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING eos_id',
        [eos, discordId],
      );
      if (!inserted.rowCount) throw new Error('Ce compte Discord ou EOS est déjà lié à un autre compte.');
    }
    await client.query('DELETE FROM starter_pack_codes WHERE discord_id = $1', [discordId]);
    await client.query('COMMIT');
    return { linked: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getStatus(discordId) {
  requireDiscordId(discordId);
  const result = await db().query(`
    SELECT l.eos_id, c.status, c.pack_version
    FROM starter_pack_links l
    LEFT JOIN starter_pack_claims c ON c.discord_id = l.discord_id
    WHERE l.discord_id = $1
  `, [discordId]);
  if (!result.rowCount) return { linked: false };
  const { eos_id, status, pack_version } = result.rows[0];
  return { linked: true, eosSuffix: eos_id.slice(-6), status: status || 'available', packVersion: pack_version };
}

async function requestClaim(discordId) {
  if (!isDeliveryEnabled()) throw new Error('Distribution en jeu non validée.');
  requireDiscordId(discordId);
  const result = await db().query(`
    INSERT INTO starter_pack_claims (id, eos_id, discord_id, status, pack_version)
    SELECT $2, eos_id, discord_id, 'pending', $3 FROM starter_pack_links WHERE discord_id = $1
    ON CONFLICT DO NOTHING RETURNING status
  `, [discordId, crypto.randomUUID(), PACK_VERSION]);
  if (result.rowCount) return 'pending';
  const status = await getStatus(discordId);
  if (!status.linked) throw new Error('Lie d’abord ton compte de jeu avec /starterpack lier.');
  return status.status;
}

async function takeClaim(eosId, mapId, packVersion) {
  if (!isDeliveryEnabled()) throw new Error('Distribution en jeu non validée.');
  const eos = requireEosId(eosId);
  requireMap(mapId);
  if (packVersion !== PACK_VERSION) throw new Error('Version du mod incompatible avec le pack.');
  // One-way transition BEFORE the grant is sent. No automatic retries: if the
  // mod crashes or its acknowledgement is lost, staff must reconcile in game.
  const result = await db().query(`
    UPDATE starter_pack_claims SET status = 'delivering', map_id = $2, delivery_started_at = NOW()
    WHERE eos_id = $1 AND status = 'pending' AND pack_version = $3
    RETURNING id
  `, [eos, mapId, PACK_VERSION]);
  return result.rowCount ? { claimId: result.rows[0].id, packVersion: PACK_VERSION } : null;
}

async function confirmDelivered(eosId, mapId, claimId, packVersion) {
  if (!isDeliveryEnabled()) throw new Error('Distribution en jeu non validée.');
  const eos = requireEosId(eosId);
  requireMap(mapId);
  if (packVersion !== PACK_VERSION || !/^[0-9a-f-]{36}$/i.test(claimId || '')) {
    throw new Error('Confirmation de pack invalide.');
  }
  const result = await db().query(`
    UPDATE starter_pack_claims SET status = 'delivered', delivered_at = NOW()
    WHERE id = $1 AND eos_id = $2 AND map_id = $3 AND pack_version = $4 AND status = 'delivering'
    RETURNING id
  `, [claimId, eos, mapId, PACK_VERSION]);
  if (result.rowCount) return { delivered: true };
  const existing = await db().query(
    "SELECT 1 FROM starter_pack_claims WHERE id = $1 AND eos_id = $2 AND map_id = $3 AND status = 'delivered'",
    [claimId, eos, mapId],
  );
  if (existing.rowCount) return { delivered: true };
  throw new Error('Aucune livraison en attente pour ce joueur sur cette carte.');
}

module.exports = {
  PACK_VERSION, init, issueCode, confirmLink, getStatus, requestClaim, takeClaim, confirmDelivered,
  requireEosId, requireMap, isDeliveryEnabled,
};