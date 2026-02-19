const fs = require('fs');
const path = require('path');

const DINO_PATH = path.join(__dirname, 'dinos.json');

function loadDinos() {
  try {
    if (fs.existsSync(DINO_PATH)) {
      return JSON.parse(fs.readFileSync(DINO_PATH, 'utf-8'));
    }
  } catch (err) {
    console.error('Erreur lecture dinos.json:', err);
  }
  return { dinos: [], dinoChannelId: '' };
}

function saveDinos(data) {
  try {
    fs.writeFileSync(DINO_PATH, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.error('Erreur écriture dinos.json:', err);
    return false;
  }
}

function getDinoData() {
  const data = loadDinos();
  if (!data.dinos) data.dinos = [];
  if (!data.dinoChannelId) data.dinoChannelId = '';
  if (!data.letterMessages) data.letterMessages = {};
  return data;
}

function addDino(dino) {
  const data = getDinoData();
  dino.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  dino.createdAt = new Date().toISOString();
  data.dinos.push(dino);
  saveDinos(data);
  return dino;
}

function updateDino(dinoId, updates) {
  const data = getDinoData();
  const idx = data.dinos.findIndex(d => d.id === dinoId);
  if (idx === -1) return null;
  data.dinos[idx] = { ...data.dinos[idx], ...updates };
  saveDinos(data);
  return data.dinos[idx];
}

function deleteDino(dinoId) {
  const data = getDinoData();
  data.dinos = data.dinos.filter(d => d.id !== dinoId);
  saveDinos(data);
  return true;
}

function getDino(dinoId) {
  const data = getDinoData();
  return data.dinos.find(d => d.id === dinoId) || null;
}

function updateDinoChannel(channelId) {
  const data = getDinoData();
  data.dinoChannelId = channelId;
  saveDinos(data);
}

function updateLetterMessage(letter, messageId, channelId) {
  const data = getDinoData();
  if (!data.letterMessages) data.letterMessages = {};
  data.letterMessages[letter] = { messageId, channelId };
  saveDinos(data);
}

function getLetterMessages() {
  const data = getDinoData();
  return data.letterMessages || {};
}

function getDinosByLetter() {
  const data = getDinoData();
  const grouped = {};
  data.dinos.forEach(dino => {
    const letter = (dino.name || '?')[0].toUpperCase();
    if (!grouped[letter]) grouped[letter] = [];
    grouped[letter].push(dino);
  });
  Object.keys(grouped).forEach(letter => {
    grouped[letter].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  });
  return grouped;
}

function formatNumber(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function buildDinoLine(dino) {
  const diamonds = dino.priceDiamonds || 0;
  const strawberries = dino.priceStrawberries || 0;
  let line = `• **${dino.name}**: ${formatNumber(diamonds)}<a:SparklyCrystal:1366174439003263087> + ${formatNumber(strawberries)}<:fraises:1328148609585123379>`;

  if (dino.uniquePerTribe) {
    line += '  __*Un seul par tribu*__ ⚠️';
  }
  if (dino.coupleInventaire) {
    line += '\n( Un équivaut à un couple inventaire )';
  }

  return line;
}

function buildVariantLine(variant) {
  const diamonds = variant.priceDiamonds || 0;
  const strawberries = variant.priceStrawberries || 0;
  return `  ○ **${variant.label}** : ${formatNumber(diamonds)}<a:SparklyCrystal:1366174439003263087> + ${formatNumber(strawberries)}<:fraises:1328148609585123379>`;
}

function buildLetterEmbed(letter, dinos) {
  const blocks = [];

  dinos.forEach(dino => {
    const dinoLines = [];
    dinoLines.push(buildDinoLine(dino));

    if (dino.variants && dino.variants.length > 0) {
      dino.variants.forEach(v => {
        dinoLines.push(buildVariantLine(v));
      });
    }

    if (dino.noReduction) {
      dinoLines.push('⛔ *Réductions fondateur ou donateur non applicables*');
    }
    if (dino.notAvailableDona) {
      dinoLines.push('⚠️ *( NON DISPONIBLE AVEC LES PACKS DONA OU LES DINOS INVENTAIRES )*');
    }
    if (dino.doubleInventaire) {
      dinoLines.push('🦖 *x2 par paiement inventaire*');
    }
    if (dino.notAvailableShop) {
      dinoLines.push('🚫 *Pas encore disponible au shop*');
    }

    blocks.push(dinoLines.join('\n'));
  });

  return {
    description: `🔻 **${letter}** 🔻\n.\n${blocks.join('\n')}`,
    color: 0x2ecc71,
  };
}

function getAllLetters() {
  const grouped = getDinosByLetter();
  return Object.keys(grouped).sort();
}

module.exports = {
  getDinoData,
  addDino,
  updateDino,
  deleteDino,
  getDino,
  updateDinoChannel,
  updateLetterMessage,
  getLetterMessages,
  getDinosByLetter,
  buildLetterEmbed,
  getAllLetters,
  formatNumber,
};
