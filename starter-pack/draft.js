const pgStore = require('../pgStore');
const initialPack = require('./pack.json');

function db() {
  const pool = pgStore.getPool();
  if (!pgStore.isPostgres() || !pool) throw new Error('La composition du starter pack nécessite PostgreSQL.');
  return pool;
}

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

function validateItems(items) {
  if (!Array.isArray(items) || items.length > 50) {
    invalid('Le pack doit contenir au maximum 50 entrées.');
  }
  return items.map((item, index) => {
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    const note = typeof item?.note === 'string' ? item.note.trim() : '';
    if (!name || name.length > 120 || /[\u0000-\u001F\u007F]/.test(name)) {
      invalid(`Nom invalide à la ligne ${index + 1} (1 à 120 caractères).`);
    }
    if (note.length > 500 || /[\u0000-\u0008\u000B-\u001F\u007F]/.test(note)) {
      invalid(`Précision invalide à la ligne ${index + 1} (maximum 500 caractères).`);
    }
    if (!Number.isInteger(item?.quantity) || item.quantity < 1 || item.quantity > 500) {
      invalid(`Quantité invalide à la ligne ${index + 1} (1 à 500).`);
    }
    return { name, quantity: item.quantity, note };
  });
}

async function init() {
  await db().query(`
    CREATE TABLE IF NOT EXISTS starter_pack_draft (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      items JSONB NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const seed = validateItems(initialPack.items.map(item => ({
    name: item.name,
    quantity: item.quantity || 1,
    note: item.note || (item.pieces ? `Comprend : ${item.pieces.join(', ')}` : ''),
  })));
  await db().query(
    'INSERT INTO starter_pack_draft (id, items) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING',
    [JSON.stringify(seed)],
  );
}

async function getDraft() {
  const result = await db().query('SELECT items, revision, updated_at FROM starter_pack_draft WHERE id = 1');
  if (!result.rowCount) throw new Error('Brouillon de starter pack introuvable.');
  return result.rows[0];
}

async function saveDraft(items, revision) {
  const checked = validateItems(items);
  if (!Number.isInteger(revision) || revision < 1) invalid('Révision de brouillon invalide.');
  const result = await db().query(`
    UPDATE starter_pack_draft
    SET items = $1::jsonb, revision = revision + 1, updated_at = NOW()
    WHERE id = 1 AND revision = $2
    RETURNING items, revision, updated_at
  `, [JSON.stringify(checked), revision]);
  if (!result.rowCount) {
    const error = new Error('Ce brouillon a été modifié ailleurs. Recharge la page avant de réessayer.');
    error.status = 409;
    throw error;
  }
  return result.rows[0];
}

module.exports = { init, getDraft, saveDraft, validateItems };