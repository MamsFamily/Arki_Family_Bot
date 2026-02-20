const fs = require('fs');
const path = require('path');
const pgStore = require('./pgStore');

const SHOP_PATH = path.join(__dirname, 'shop.json');
const PG_KEY = 'shop';

let cachedData = null;

const DEFAULT_CATEGORIES = [
  { id: 'packs', name: 'Packs', emoji: '📦', color: '#e74c3c' },
  { id: 'dinos', name: 'Dinos', emoji: '🦖', color: '#2ecc71' },
  { id: 'imprint', name: 'Imprint', emoji: '⬆️', color: '#3498db' },
  { id: 'elements', name: 'Éléments', emoji: '🧪', color: '#9b59b6' },
  { id: 'chibis', name: 'Chibis & Skins', emoji: '🎨', color: '#f39c12' },
  { id: 'mutagene', name: 'Mutagène', emoji: '☣️', color: '#1abc9c' },
  { id: 'autres', name: 'Autres', emoji: '🛒', color: '#95a5a6' },
];

function loadShopFromFile() {
  try {
    if (fs.existsSync(SHOP_PATH)) {
      return JSON.parse(fs.readFileSync(SHOP_PATH, 'utf-8'));
    }
  } catch (err) {
    console.error('Erreur lecture shop.json:', err);
  }
  return { categories: DEFAULT_CATEGORIES, packs: [], shopChannelId: '' };
}

function saveShopToFile(data) {
  try {
    fs.writeFileSync(SHOP_PATH, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.error('Erreur écriture shop.json:', err);
    return false;
  }
}

async function initShop() {
  if (pgStore.isPostgres()) {
    const pgData = await pgStore.getData(PG_KEY);
    if (!pgData) {
      const fileData = loadShopFromFile();
      await pgStore.setData(PG_KEY, fileData);
      console.log('🛒 Shop migré vers PostgreSQL');
    }
    cachedData = await pgStore.getData(PG_KEY);
  } else {
    cachedData = loadShopFromFile();
  }
}

function getShop() {
  let shop;
  if (cachedData) {
    shop = cachedData;
  } else {
    shop = loadShopFromFile();
  }
  if (!shop.categories || shop.categories.length === 0) {
    shop.categories = DEFAULT_CATEGORIES;
  }
  if (!shop.packs) shop.packs = [];
  if (!shop.shopChannelId) shop.shopChannelId = '';
  return shop;
}

async function saveShop(data) {
  cachedData = data;
  if (pgStore.isPostgres()) {
    await pgStore.setData(PG_KEY, data);
  }
  saveShopToFile(data);
  return true;
}

async function addPack(pack) {
  const shop = getShop();
  pack.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  pack.createdAt = new Date().toISOString();
  pack.messageId = null;
  pack.channelId = null;
  shop.packs.push(pack);
  await saveShop(shop);
  return pack;
}

async function updatePack(packId, updates) {
  const shop = getShop();
  const idx = shop.packs.findIndex(p => p.id === packId);
  if (idx === -1) return null;
  shop.packs[idx] = { ...shop.packs[idx], ...updates };
  await saveShop(shop);
  return shop.packs[idx];
}

async function deletePack(packId) {
  const shop = getShop();
  shop.packs = shop.packs.filter(p => p.id !== packId);
  await saveShop(shop);
  return true;
}

function getPack(packId) {
  const shop = getShop();
  return shop.packs.find(p => p.id === packId) || null;
}

async function updateShopChannel(channelId) {
  const shop = getShop();
  shop.shopChannelId = channelId;
  await saveShop(shop);
}

async function addCategory(category) {
  const shop = getShop();
  category.id = category.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
  shop.categories.push(category);
  await saveShop(shop);
  return category;
}

function formatNumber(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function buildPackEmbed(pack) {
  const lines = [];

  if (pack.priceDiamonds > 0 || pack.priceStrawberries > 0) {
    const priceLine = [];
    if (pack.priceDiamonds > 0) {
      priceLine.push(`**${formatNumber(pack.priceDiamonds)}** <a:SparklyCrystal:1366174439003263087>`);
    }
    if (pack.priceStrawberries > 0) {
      priceLine.push(`**${formatNumber(pack.priceStrawberries)}** <:fraises:1328148609585123379>`);
    }
    lines.push('\n> ' + priceLine.join('  +  '));
    lines.push('');
  }

  if (pack.donationAvailable) {
    lines.push('> <a:ok:1328152449785008189> **Compatible Pack Inventaire 📦**');
  }

  if (pack.notCompatible) {
    lines.push('> <a:no:1328152539660554363> **Non compatible avec les pack inventaires**');
  }

  if (pack.available === false) {
    lines.push('> ⚠️ *Pas encore disponible*');
  }

  if (pack.noReduction) {
    lines.push('> ⛔ *Réductions fondateur ou donateur non applicables*');
  }

  if (lines.length > 0) {
    lines.push('');
  }

  if (pack.content && pack.content.trim()) {
    const contentLines = pack.content.split('\n').filter(l => l.trim());
    contentLines.forEach(line => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('•') && !trimmed.startsWith('-') && !trimmed.startsWith('*')) {
        lines.push(`• ${trimmed}`);
      } else {
        lines.push(trimmed.replace(/^[-*]\s*/, '• '));
      }
    });
  }

  if (pack.note && pack.note.trim()) {
    lines.push('');
    lines.push(`> 📝 *${pack.note}*`);
  }

  const category = DEFAULT_CATEGORIES.find(c => c.id === pack.category) || DEFAULT_CATEGORIES[0];

  return {
    title: pack.name.toUpperCase(),
    description: lines.join('\n') + '\n\n*Arki\' Family Shop*',
    color: parseInt(pack.color ? pack.color.replace('#', '') : category.color.replace('#', ''), 16),
  };
}

module.exports = { getShop, addPack, updatePack, deletePack, getPack, updateShopChannel, addCategory, buildPackEmbed, initShop, DEFAULT_CATEGORIES };
