const fs = require('fs');
const path = require('path');
const pgStore = require('./pgStore');

const INVENTORY_PATH = path.join(__dirname, 'inventory.json');
const PG_KEY_ITEM_TYPES = 'inventory_item_types';
const PG_KEY_INVENTORIES = 'inventory_data';
const PG_KEY_TRANSACTIONS = 'inventory_transactions';
const PG_KEY_CATEGORIES = 'inventory_categories';

let cachedItemTypes = null;
let cachedInventories = null;
let cachedTransactions = null;
let cachedCategories = null;

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

function saveToFile(data) {
  try {
    fs.writeFileSync(INVENTORY_PATH, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.error('Erreur écriture inventory.json:', err);
    return false;
  }
}

async function refreshInventoryCache() {
  if (!pgStore.isPostgres()) return;
  try {
    cachedInventories  = await pgStore.getData(PG_KEY_INVENTORIES)  || cachedInventories  || {};
    cachedItemTypes    = await pgStore.getData(PG_KEY_ITEM_TYPES)    || cachedItemTypes    || DEFAULT_ITEM_TYPES;
    cachedTransactions = await pgStore.getData(PG_KEY_TRANSACTIONS)  || cachedTransactions || [];
    cachedCategories   = await pgStore.getData(PG_KEY_CATEGORIES)    || cachedCategories   || DEFAULT_CATEGORIES;
  } catch (err) {
    console.error('[InventoryManager] Erreur refresh cache inventaire:', err);
  }
}

async function initInventory() {
  if (pgStore.isPostgres()) {
    let pgItemTypes = await pgStore.getData(PG_KEY_ITEM_TYPES);
    if (!pgItemTypes) {
      const fileData = loadFromFile();
      await pgStore.setData(PG_KEY_ITEM_TYPES, fileData.itemTypes || DEFAULT_ITEM_TYPES);
      await pgStore.setData(PG_KEY_INVENTORIES, fileData.inventories || {});
      await pgStore.setData(PG_KEY_TRANSACTIONS, fileData.transactions || []);
      await pgStore.setData(PG_KEY_CATEGORIES, fileData.categories || DEFAULT_CATEGORIES);
      console.log('📦 Inventaire migré vers PostgreSQL');
    }
    cachedItemTypes = await pgStore.getData(PG_KEY_ITEM_TYPES) || DEFAULT_ITEM_TYPES;
    cachedInventories = await pgStore.getData(PG_KEY_INVENTORIES) || {};
    cachedTransactions = await pgStore.getData(PG_KEY_TRANSACTIONS) || [];
    cachedCategories = await pgStore.getData(PG_KEY_CATEGORIES) || DEFAULT_CATEGORIES;
  } else {
    const fileData = loadFromFile();
    cachedItemTypes = fileData.itemTypes || DEFAULT_ITEM_TYPES;
    cachedInventories = fileData.inventories || {};
    cachedTransactions = fileData.transactions || [];
    cachedCategories = fileData.categories || DEFAULT_CATEGORIES;
  }
  console.log(`📦 Inventaire chargé: ${cachedItemTypes.length} types d'items, ${cachedCategories.length} catégories`);
}

function getFileData() {
  return { itemTypes: cachedItemTypes, inventories: cachedInventories, transactions: cachedTransactions, categories: cachedCategories };
}

async function saveItemTypes() {
  if (pgStore.isPostgres()) {
    await pgStore.setData(PG_KEY_ITEM_TYPES, cachedItemTypes);
  }
  saveToFile(getFileData());
}

async function saveInventories() {
  if (pgStore.isPostgres()) {
    await pgStore.setData(PG_KEY_INVENTORIES, cachedInventories);
  }
  saveToFile(getFileData());
}

async function saveTransactions() {
  if (pgStore.isPostgres()) {
    await pgStore.setData(PG_KEY_TRANSACTIONS, cachedTransactions);
  }
  saveToFile(getFileData());
}

async function saveCategories() {
  if (pgStore.isPostgres()) {
    await pgStore.setData(PG_KEY_CATEGORIES, cachedCategories);
  }
  saveToFile(getFileData());
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
  cachedItemTypes.splice(idx, 1);
  for (const playerId of Object.keys(cachedInventories)) {
    delete cachedInventories[playerId][itemId];
  }
  await saveItemTypes();
  await saveInventories();
  return true;
}

function getPlayerInventory(playerId) {
  return cachedInventories[playerId] || {};
}

function getAllInventories() {
  return cachedInventories || {};
}

async function addToInventory(playerId, itemTypeId, quantity, adminId, reason) {
  if (!cachedInventories[playerId]) {
    cachedInventories[playerId] = {};
  }
  const current = cachedInventories[playerId][itemTypeId] || 0;
  cachedInventories[playerId][itemTypeId] = current + quantity;

  const transaction = {
    id: generateId(),
    playerId,
    itemTypeId,
    quantity: +quantity,
    adminId: adminId || 'system',
    reason: reason || '',
    type: 'add',
    timestamp: new Date().toISOString(),
  };
  cachedTransactions.push(transaction);

  if (cachedTransactions.length > 10000) {
    cachedTransactions = cachedTransactions.slice(-5000);
  }

  await saveInventories();
  await saveTransactions();
  return { newQuantity: cachedInventories[playerId][itemTypeId], transaction };
}

async function removeFromInventory(playerId, itemTypeId, quantity, adminId, reason) {
  if (!cachedInventories[playerId]) {
    cachedInventories[playerId] = {};
  }
  const current = cachedInventories[playerId][itemTypeId] || 0;
  const newQty = Math.max(0, current - quantity);
  cachedInventories[playerId][itemTypeId] = newQty;

  if (newQty === 0) {
    delete cachedInventories[playerId][itemTypeId];
  }

  const transaction = {
    id: generateId(),
    playerId,
    itemTypeId,
    quantity: -quantity,
    adminId: adminId || 'system',
    reason: reason || '',
    type: 'remove',
    timestamp: new Date().toISOString(),
  };
  cachedTransactions.push(transaction);

  if (cachedTransactions.length > 10000) {
    cachedTransactions = cachedTransactions.slice(-5000);
  }

  await saveInventories();
  await saveTransactions();
  return { newQuantity: newQty, transaction };
}

async function setInventoryItem(playerId, itemTypeId, quantity, adminId, reason) {
  if (!cachedInventories[playerId]) {
    cachedInventories[playerId] = {};
  }
  const current = cachedInventories[playerId][itemTypeId] || 0;
  const diff = quantity - current;

  if (quantity <= 0) {
    delete cachedInventories[playerId][itemTypeId];
  } else {
    cachedInventories[playerId][itemTypeId] = quantity;
  }

  const transaction = {
    id: generateId(),
    playerId,
    itemTypeId,
    quantity: diff,
    adminId: adminId || 'system',
    reason: reason || 'set',
    type: diff >= 0 ? 'add' : 'remove',
    timestamp: new Date().toISOString(),
  };
  cachedTransactions.push(transaction);

  if (cachedTransactions.length > 10000) {
    cachedTransactions = cachedTransactions.slice(-5000);
  }

  await saveInventories();
  await saveTransactions();
  return { newQuantity: quantity <= 0 ? 0 : quantity, transaction };
}

async function resetPlayerInventory(playerId, adminId, reason) {
  const oldInventory = cachedInventories[playerId] || {};
  const items = Object.entries(oldInventory);

  for (const [itemTypeId, quantity] of items) {
    cachedTransactions.push({
      id: generateId(),
      playerId,
      itemTypeId,
      quantity: -quantity,
      adminId: adminId || 'system',
      reason: reason || 'reset',
      type: 'reset',
      timestamp: new Date().toISOString(),
    });
  }

  delete cachedInventories[playerId];

  if (cachedTransactions.length > 10000) {
    cachedTransactions = cachedTransactions.slice(-5000);
  }

  await saveInventories();
  await saveTransactions();
  return { itemsCleared: items.length };
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
