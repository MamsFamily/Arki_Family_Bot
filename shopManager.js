const fs = require('fs');
const path = require('path');

const SHOP_PATH = path.join(__dirname, 'shop.json');

const DEFAULT_CATEGORIES = [
  { id: 'packs', name: 'Packs', emoji: '📦', color: '#e74c3c' },
  { id: 'dinos', name: 'Dinos', emoji: '🦖', color: '#2ecc71' },
  { id: 'imprint', name: 'Imprint', emoji: '⬆️', color: '#3498db' },
  { id: 'elements', name: 'Éléments', emoji: '🧪', color: '#9b59b6' },
  { id: 'chibis', name: 'Chibis & Skins', emoji: '🎨', color: '#f39c12' },
  { id: 'mutagene', name: 'Mutagène', emoji: '☣️', color: '#1abc9c' },
  { id: 'autres', name: 'Autres', emoji: '🛒', color: '#95a5a6' },
];

function loadShop() {
  try {
    if (fs.existsSync(SHOP_PATH)) {
      return JSON.parse(fs.readFileSync(SHOP_PATH, 'utf-8'));
    }
  } catch (err) {
    console.error('Erreur lecture shop.json:', err);
  }
  return { categories: DEFAULT_CATEGORIES, packs: [], shopChannelId: '' };
}

function saveShop(data) {
  try {
    fs.writeFileSync(SHOP_PATH, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.error('Erreur écriture shop.json:', err);
    return false;
  }
}

function getShop() {
  const shop = loadShop();
  if (!shop.categories || shop.categories.length === 0) {
    shop.categories = DEFAULT_CATEGORIES;
  }
  if (!shop.packs) shop.packs = [];
  if (!shop.shopChannelId) shop.shopChannelId = '';
  return shop;
}

function addPack(pack) {
  const shop = getShop();
  pack.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  pack.createdAt = new Date().toISOString();
  pack.messageId = null;
  pack.channelId = null;
  shop.packs.push(pack);
  saveShop(shop);
  return pack;
}

function updatePack(packId, updates) {
  const shop = getShop();
  const idx = shop.packs.findIndex(p => p.id === packId);
  if (idx === -1) return null;
  shop.packs[idx] = { ...shop.packs[idx], ...updates };
  saveShop(shop);
  return shop.packs[idx];
}

function deletePack(packId) {
  const shop = getShop();
  shop.packs = shop.packs.filter(p => p.id !== packId);
  saveShop(shop);
  return true;
}

function getPack(packId) {
  const shop = getShop();
  return shop.packs.find(p => p.id === packId) || null;
}

function updateShopChannel(channelId) {
  const shop = getShop();
  shop.shopChannelId = channelId;
  saveShop(shop);
}

function addCategory(category) {
  const shop = getShop();
  category.id = category.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
  shop.categories.push(category);
  saveShop(shop);
  return category;
}

function buildPackEmbed(pack) {
  const lines = [];

  if (pack.priceDiamonds > 0 || pack.priceStrawberries > 0) {
    let priceLine = '> **Prix :** ';
    const parts = [];
    if (pack.priceDiamonds > 0) {
      parts.push(`${pack.priceDiamonds.toLocaleString('fr-FR')} <a:SparklyCrystal:1366174439003263087>`);
    }
    if (pack.priceStrawberries > 0) {
      parts.push(`${pack.priceStrawberries.toLocaleString('fr-FR')} <:fraises:1328148609585123379>`);
    }
    priceLine += parts.join(' + ');
    lines.push(priceLine);
  }

  if (pack.donationAvailable) {
    lines.push('> 🎁 **Donation disponible**');
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
    title: `${category.emoji} ${pack.name}`,
    description: lines.join('\n'),
    color: parseInt(pack.color ? pack.color.replace('#', '') : category.color.replace('#', ''), 16),
    footer: { text: 'Arki\' Family Shop' },
    timestamp: new Date().toISOString(),
  };
}

module.exports = { getShop, addPack, updatePack, deletePack, getPack, updateShopChannel, addCategory, buildPackEmbed, DEFAULT_CATEGORIES };
