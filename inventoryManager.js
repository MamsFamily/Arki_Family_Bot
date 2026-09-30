const fs = require('fs');
const path = require('path');
const pgStore = require('./pgStore');
const { createInventoryPersistence, trimHistory } = require('./inventoryPersistence');

const INVENTORY_PATH = path.join(__dirname, 'inventory.json');
const PG_KEY_ITEM_TYPES = 'inventory_item_types';
const PG_KEY_INVENTORIES = 'inventory_data';
const PG_KEY_TRANSACTIONS = 'inventory_transactions';
const PG_KEY_CATEGORIES = 'inventory_categories';
const MAX_TRANSACTION_HISTORY = 50000;

let cachedItemTypes = null;
let cachedInventories = null;
let cachedTransactions = null;
let cachedCategories = null;
const inventoryPersistence = createInventoryPersistence({
  pgStore,
  filePath: INVENTORY_PATH,
  getFileDefaults: () => ({
    itemTypes: cachedItemTypes || DEFAULT_ITEM_TYPES,
    inventories: cachedInventories || {},
    transactions: cachedTransactions || [],
    categories: cachedCategories || DEFAULT_CATEGORIES,
    receipts: {},
  }),
});

const DEFAULT_ITEM_TYPES = [
  { id: 'diamants', name: 'Diamants', emoji: '💎', category: 'currency', order: 1 },
  { id: 'fraises', name: 'Fraises', emoji: '🍓', category: 'currency', order: 2 },
  { id: 'elements', name: 'Éléments', emoji: '🧪', category: 'consumable', order: 3 },
  { id: 'peinture_dino', name: 'Peinture Dino', emoji: '🎨', category: 'consumable', order: 4 },
  { id: 'pack', name: 'Pack', emoji: '📦', category: 'consumable', order: 5 },
  { id: 'schema', name: 'Schéma', emoji: '⛏', category: 'consumable', order: 6 },
  { id: 'chibi_skin', name: 'Chibi ou skin', emoji: '🥚', category: 'consumable', order: 7 },
  { id: 'imprint_300', name: 'Imprint 300', emoji: '3️⃣', category: 'consumable', order: 8 },
  { id: 'dino_epaule', name: "Dino d'épaule", emoji: '🦎', category: 'dino', order: 9 },
  { id: 'dino_epaule_shop', name: "Dino d'épaule Shop", emoji: '🦎', category: 'dino', order: 10 },
  { id: 'equip_mythique', name: 'Pièce d\'équipement crafté mythique', emoji: '🎒', category: 'equipment', order: 11 },
  { id: 'arme_mythique', name: 'Arme crafté mythique', emoji: '🔫', category: 'equipment', order: 12 },
  { id: 'dino_dona', name: 'Dino Dona', emoji: '🦕', category: 'dino', order: 13 },
  { id: 'boost-repro-6h',  name: 'Jeton Boost Repro 6h',  emoji: '🧬', category: 'consumable', order: 14 },
  { id: 'boost-repro-12h', name: 'Jeton Boost Repro 12h', emoji: '🧬', category: 'consumable', order: 15 },
  { id: 'boost-repro-24h', name: 'Jeton Boost Repro 24h', emoji: '🧬', category: 'consumable', order: 16 },
];

const DEFAULT_CATEGORIES = [
  { id: 'currency', name: 'Monnaie', emoji: '💰', order: 1 },
  { id: 'consumable', name: 'Consommable', emoji: '📦', order: 2 },
  { id: 'dino', name: 'Dino', emoji: '🦕', order: 3 },
  { id: 'equipment', name: 'Équipement', emoji: '🛡️', order: 4 },
  { id: 'other', name: 'Autre', emoji: '🔮', order: 5 },
];

function loadFromFile() {
  try {
    if (fs.existsSync(INVENTORY_PATH)) {
      return JSON.parse(fs.readFileSync(INVENTORY_PATH, 'utf-8'));
    }
  } catch (err) {
    console.error('Erreur lecture inventory.json:', err);
  }
  return { itemTypes: DEFAULT_ITEM_TYPES, inventories: {}, transactions: [], categories: DEFAULT_CATEGORIES };
}

function saveToFile(data, { preserveInventoryState = false } = {}) {
  let existing = {};
  if (fs.existsSync(INVENTORY_PATH)) {
    existing = JSON.parse(fs.readFileSync(INVENTORY_PATH, 'utf8'));
  }
  const savedData = {
    ...existing,
    ...data,
    inventories: preserveInventoryState ? (existing.inventories || data.inventories || {}) : data.inventories,
    transactions: preserveInventoryState ? (existing.transactions || data.transactions || []) : data.transactions,
    receipts: data.receipts !== undefined ? data.receipts : (existing.receipts || {}),
  };
  fs.writeFileSync(INVENTORY_PATH, JSON.stringify(savedData, null, 2));
  return true;
}

async function refreshInventoryCache({ throwOnError = true } = {}) {
  if (!pgStore.isPostgres()) return;
  try {
    const options = throwOnError ? { throwOnError: true } : {};
    const [inventories, itemTypes, transactions, categories] = await Promise.all([
      pgStore.getData(PG_KEY_INVENTORIES, undefined, options),
      pgStore.getData(PG_KEY_ITEM_TYPES, undefined, options),
      pgStore.getData(PG_KEY_TRANSACTIONS, undefined, options),
      pgStore.getData(PG_KEY_CATEGORIES, undefined, options),
    ]);
    cachedInventories = inventories || (throwOnError ? {} : cachedInventories || {});
    cachedItemTypes = itemTypes || (throwOnError ? DEFAULT_ITEM_TYPES : cachedItemTypes || DEFAULT_ITEM_TYPES);
    cachedTransactions = transactions || (throwOnError ? [] : cachedTransactions || []);
    cachedCategories = categories || (throwOnError ? DEFAULT_CATEGORIES : cachedCategories || DEFAULT_CATEGORIES);
  } catch (err) {
    if (throwOnError) throw err;
    console.error('[InventoryManager] Erreur refresh cache inventaire:', err);
  }
}

async function addMissingDefaultItemTypes(currentTypes) {
  const existingIds = new Set((currentTypes || []).map(item => item.id));
  if (DEFAULT_ITEM_TYPES.every(item => existingIds.has(item.id))) return currentTypes;
  const pool = pgStore.getPool();
  if (!pool || typeof pool.connect !== 'function') throw new Error('PostgreSQL pool is unavailable');
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query('BEGIN');
    inTransaction = true;
    const selected = await client.query(
      'SELECT value FROM app_data WHERE key = $1 FOR UPDATE',
      [PG_KEY_ITEM_TYPES]
    );
    if (!selected.rows.length) throw new Error('inventory_item_types disappeared during initialization');
    const raw = selected.rows[0].value;
    const latest = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const latestIds = new Set((latest || []).map(item => item.id));
    const missing = DEFAULT_ITEM_TYPES.filter(item => !latestIds.has(item.id));
    const updated = [...(latest || []), ...missing];
    if (missing.length) {
      const saved = await client.query(
        'UPDATE app_data SET value = $2::jsonb, updated_at = NOW() WHERE key = $1',
        [PG_KEY_ITEM_TYPES, JSON.stringify(updated)]
      );
      if (saved.rowCount === 0) throw new Error('Échec sauvegarde inventory_item_types');
    }
    await client.query('COMMIT');
    inTransaction = false;
    return updated;
  } catch (error) {
    if (inTransaction) {
      try { await client.query('ROLLBACK'); } catch (rollbackError) { error.rollbackError = rollbackError; }
    }
    throw error;
  } finally {
    client.release();
  }
}

async function initInventory() {
  if (pgStore.isPostgres()) {
    const fileData = loadFromFile();
    const readStrict = key => pgStore.getData(key, undefined, { throwOnError: true });
    let [pgItemTypes, pgInventories, pgTransactions, pgCategories] = await Promise.all([
      readStrict(PG_KEY_ITEM_TYPES),
      readStrict(PG_KEY_INVENTORIES),
      readStrict(PG_KEY_TRANSACTIONS),
      readStrict(PG_KEY_CATEGORIES),
    ]);

    const pool = pgStore.getPool();
    if (!pool || typeof pool.query !== 'function') throw new Error('PostgreSQL pool is unavailable');
    const migrations = [
      [PG_KEY_ITEM_TYPES, fileData.itemTypes || DEFAULT_ITEM_TYPES],
      [PG_KEY_INVENTORIES, fileData.inventories || {}],
      [PG_KEY_TRANSACTIONS, fileData.transactions || []],
      [PG_KEY_CATEGORIES, fileData.categories || DEFAULT_CATEGORIES],
    ];
    const currentValues = new Map([
      [PG_KEY_ITEM_TYPES, pgItemTypes],
      [PG_KEY_INVENTORIES, pgInventories],
      [PG_KEY_TRANSACTIONS, pgTransactions],
      [PG_KEY_CATEGORIES, pgCategories],
    ]);
    for (const [key, value] of migrations) {
      if (currentValues.get(key) === null || currentValues.get(key) === undefined) {
        await pool.query(
          `INSERT INTO app_data (key, value, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (key) DO NOTHING`,
          [key, JSON.stringify(value)]
        );
      }
    }

    // Re-read after insert-only migration to observe any competing initializer's row.
    [pgItemTypes, pgInventories, pgTransactions, pgCategories] = await Promise.all([
      readStrict(PG_KEY_ITEM_TYPES),
      readStrict(PG_KEY_INVENTORIES),
      readStrict(PG_KEY_TRANSACTIONS),
      readStrict(PG_KEY_CATEGORIES),
    ]);
    if ([pgItemTypes, pgInventories, pgTransactions, pgCategories].some(value => value === null || value === undefined)) {
      throw new Error('Inventory app_data initialization did not create all required keys');
    }

    cachedItemTypes = await addMissingDefaultItemTypes(pgItemTypes);
    cachedInventories = pgInventories;
    cachedTransactions = pgTransactions;
    cachedCategories = pgCategories;
  } else {
    const fileData = loadFromFile();
    cachedItemTypes    = fileData.itemTypes    || DEFAULT_ITEM_TYPES;
    cachedInventories  = fileData.inventories  || {};
    cachedTransactions = fileData.transactions || [];
    cachedCategories   = fileData.categories   || DEFAULT_CATEGORIES;
  }
  console.log(`📦 Inventaire chargé: ${cachedItemTypes.length} types d'items, ${cachedCategories.length} catégories`);
}

function getFileData() {
  return { itemTypes: cachedItemTypes, inventories: cachedInventories, transactions: cachedTransactions, categories: cachedCategories };
}

async function saveItemTypes() {
  if (pgStore.isPostgres()) {
    if (!await pgStore.setData(PG_KEY_ITEM_TYPES, cachedItemTypes)) throw new Error('Échec sauvegarde inventory_item_types');
  }
  saveToFile(getFileData(), { preserveInventoryState: true });
}

async function saveCategories() {
  if (pgStore.isPostgres()) {
    await pgStore.setData(PG_KEY_CATEGORIES, cachedCategories);
  }
  saveToFile(getFileData(), { preserveInventoryState: true });
}

function getCategories() {
  return (cachedCategories || DEFAULT_CATEGORIES).sort((a, b) => (a.order || 0) - (b.order || 0));
}

function getCategoryById(catId) {
  return (cachedCategories || []).find(c => c.id === catId) || null;
}

async function addCategory(data) {
  const cat = {
    id: data.id || generateId(),
    name: data.name,
    emoji: data.emoji || '📦',
    order: data.order || (cachedCategories.length + 1),
  };
  cachedCategories.push(cat);
  await saveCategories();
  return cat;
}

async function updateCategory(catId, data) {
  const idx = cachedCategories.findIndex(c => c.id === catId);
  if (idx === -1) return null;
  cachedCategories[idx] = { ...cachedCategories[idx], ...data, id: catId };
  await saveCategories();
  return cachedCategories[idx];
}

async function deleteCategory(catId) {
  const idx = cachedCategories.findIndex(c => c.id === catId);
  if (idx === -1) return false;
  cachedCategories.splice(idx, 1);
  await saveCategories();
  return true;
}

function getItemTypes() {
  return cachedItemTypes || DEFAULT_ITEM_TYPES;
}

function getItemTypeById(itemId) {
  return (cachedItemTypes || []).find(t => t.id === itemId) || null;
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function addItemType(data) {
  const itemType = {
    id: data.id || generateId(),
    name: data.name,
    emoji: data.emoji || '📦',
    category: data.category || 'other',
    order: data.order || (cachedItemTypes.length + 1),
  };
  cachedItemTypes.push(itemType);
  await saveItemTypes();
  return itemType;
}

async function updateItemType(itemId, data) {
  const idx = cachedItemTypes.findIndex(t => t.id === itemId);
  if (idx === -1) return null;
  cachedItemTypes[idx] = { ...cachedItemTypes[idx], ...data, id: itemId };
  await saveItemTypes();
  return cachedItemTypes[idx];
}

async function deleteItemType(itemId) {
  const idx = cachedItemTypes.findIndex(t => t.id === itemId);
  if (idx === -1) return false;
  const { state } = await inventoryPersistence.mutateInventory(data => {
    for (const inventory of Object.values(data.inventories)) delete inventory[itemId];
    return true;
  });
  syncInventoryCache(state);
  cachedItemTypes.splice(idx, 1);
  await saveItemTypes();
  return true;
}

function getPlayerInventory(playerId) {
  return cachedInventories[playerId] || {};
}

function getAllInventories() {
  return cachedInventories || {};
}

function syncInventoryCache(state) {
  cachedInventories = state.inventories;
  cachedTransactions = state.transactions;
}

async function applyInventoryCredits(playerId, credits, adminId, reason, options = {}) {
  const { result, state } = await inventoryPersistence.applyInventoryCredits(playerId, credits, adminId, reason, options);
  // Persistence returns only after COMMIT/atomic file replacement.
  syncInventoryCache(state);
  return result;
}

async function getInventoryCreditReceipt(idempotencyKey) {
  return inventoryPersistence.getInventoryCreditReceipt(idempotencyKey);
}

async function addToInventory(playerId, itemTypeId, quantity, adminId, reason, options = {}) {
  const result = await applyInventoryCredits(
    playerId,
    [{ itemTypeId, quantity }],
    adminId,
    reason,
    options
  );
  return { newQuantity: result.newQuantity, transaction: result.transaction };
}

async function removeFromInventory(playerId, itemTypeId, quantity, adminId, reason) {
  const { result, state } = await inventoryPersistence.mutateInventory(data => {
    const inventory = data.inventories[playerId] || (data.inventories[playerId] = {});
    const current = inventory[itemTypeId] || 0;
    const newQty = Math.max(0, current - quantity);
    const actualRemoved = current - newQty;
    if (newQty === 0) delete inventory[itemTypeId];
    else inventory[itemTypeId] = newQty;
    const transaction = {
      id: generateId(), playerId, itemTypeId, quantity: -actualRemoved,
      adminId: adminId || 'system', reason: reason || '', type: 'remove',
      timestamp: new Date().toISOString(),
    };
    data.transactions.push(transaction);
    trimHistory(data.transactions, MAX_TRANSACTION_HISTORY);
    return { newQuantity: newQty, transaction };
  });
  syncInventoryCache(state);
  return result;
}

async function setInventoryItem(playerId, itemTypeId, quantity, adminId, reason) {
  const { result, state } = await inventoryPersistence.mutateInventory(data => {
    const inventory = data.inventories[playerId] || (data.inventories[playerId] = {});
    const current = inventory[itemTypeId] || 0;
    const diff = quantity - current;
    if (quantity <= 0) delete inventory[itemTypeId];
    else inventory[itemTypeId] = quantity;
    const transaction = {
      id: generateId(), playerId, itemTypeId, quantity: diff,
      adminId: adminId || 'system', reason: reason || 'set',
      type: diff >= 0 ? 'add' : 'remove', timestamp: new Date().toISOString(),
    };
    data.transactions.push(transaction);
    trimHistory(data.transactions, MAX_TRANSACTION_HISTORY);
    return { newQuantity: quantity <= 0 ? 0 : quantity, transaction };
  });
  syncInventoryCache(state);
  return result;
}

async function resetPlayerInventory(playerId, adminId, reason) {
  const { result, state } = await inventoryPersistence.mutateInventory(data => {
    const items = Object.entries(data.inventories[playerId] || {});
    for (const [itemTypeId, quantity] of items) {
      data.transactions.push({
        id: generateId(), playerId, itemTypeId, quantity: -quantity,
        adminId: adminId || 'system', reason: reason || 'reset', type: 'reset',
        timestamp: new Date().toISOString(),
      });
    }
    delete data.inventories[playerId];
    trimHistory(data.transactions, MAX_TRANSACTION_HISTORY);
    return { itemsCleared: items.length };
  });
  syncInventoryCache(state);
  return result;
}

function getTransactions(filters = {}) {
  let results = cachedTransactions || [];

  if (filters.playerId) {
    results = results.filter(t => t.playerId === filters.playerId);
  }
  if (filters.itemTypeId) {
    results = results.filter(t => t.itemTypeId === filters.itemTypeId);
  }
  if (filters.adminId) {
    results = results.filter(t => t.adminId === filters.adminId);
  }
  if (filters.type) {
    results = results.filter(t => t.type === filters.type);
  }
  if (filters.after) {
    results = results.filter(t => new Date(t.timestamp) >= new Date(filters.after));
  }
  if (filters.before) {
    results = results.filter(t => new Date(t.timestamp) <= new Date(filters.before));
  }

  results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const limit = filters.limit || 50;
  const offset = filters.offset || 0;
  return {
    transactions: results.slice(offset, offset + limit),
    total: results.length,
  };
}

function getPlayerTransactions(playerId, limit = 20) {
  return getTransactions({ playerId, limit });
}

module.exports = {
  initInventory,
  getItemTypes,
  getItemTypeById,
  addItemType,
  updateItemType,
  deleteItemType,
  getPlayerInventory,
  getAllInventories,
  applyInventoryCredits,
  getInventoryCreditReceipt,
  addToInventory,
  removeFromInventory,
  setInventoryItem,
  resetPlayerInventory,
  getTransactions,
  getPlayerTransactions,
  getCategories,
  getCategoryById,
  addCategory,
  updateCategory,
  deleteCategory,
  DEFAULT_CATEGORIES,
  DEFAULT_ITEM_TYPES,
  refreshInventoryCache,
};
