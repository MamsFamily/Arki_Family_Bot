const fs = require('fs');
const path = require('path');

const DINO_PATH = path.join(__dirname, 'dinos.json');

const DEFAULT_LETTER_COLORS = {
  A: '#e74c3c', B: '#e67e22', C: '#f1c40f', D: '#2ecc71', E: '#1abc9c',
  F: '#3498db', G: '#9b59b6', H: '#e91e63', I: '#00bcd4', J: '#ff5722',
  K: '#8bc34a', L: '#ff9800', M: '#673ab7', N: '#009688', O: '#f44336',
  P: '#2196f3', Q: '#4caf50', R: '#ff4081', S: '#7c4dff', T: '#00e676',
  U: '#ffc107', V: '#e040fb', W: '#76ff03', X: '#ff6e40', Y: '#64ffda',
  Z: '#ea80fc',
};

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
  if (!data.letterColors) data.letterColors = {};
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

function updateLetterColor(letter, color) {
  const data = getDinoData();
  if (!data.letterColors) data.letterColors = {};
  data.letterColors[letter] = color;
  saveDinos(data);
}

function getLetterColor(letter) {
  const data = getDinoData();
  return (data.letterColors && data.letterColors[letter]) || DEFAULT_LETTER_COLORS[letter] || '#2ecc71';
}

function getLetterColors() {
  const data = getDinoData();
  return data.letterColors || {};
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

const DS_UPPER_CODES = [0x1D538,0x1D539,0x2102,0x1D53B,0x1D53C,0x1D53D,0x1D53E,0x210D,0x1D540,0x1D541,0x1D542,0x1D543,0x1D544,0x2115,0x1D546,0x2119,0x211A,0x211D,0x1D54A,0x1D54B,0x1D54C,0x1D54D,0x1D54E,0x1D54F,0x1D550,0x2124];
const DS_LOWER_CODES = [0x1D552,0x1D553,0x1D554,0x1D555,0x1D556,0x1D557,0x1D558,0x1D559,0x1D55A,0x1D55B,0x1D55C,0x1D55D,0x1D55E,0x1D55F,0x1D560,0x1D561,0x1D562,0x1D563,0x1D564,0x1D565,0x1D566,0x1D567,0x1D568,0x1D569,0x1D56A,0x1D56B];

function toDoubleStruck(text) {
  return [...text].map(c => {
    const code = c.charCodeAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(DS_UPPER_CODES[code - 65]);
    if (code >= 97 && code <= 122) return String.fromCodePoint(DS_LOWER_CODES[code - 97]);
    return c;
  }).join('');
}


function buildDinoLine(dino) {
  const diamonds = dino.priceDiamonds || 0;
  const strawberries = dino.priceStrawberries || 0;
  let line = `## ${toDoubleStruck(dino.name)}\n> ${formatNumber(diamonds)}<a:SparklyCrystal:1366174439003263087> + ${formatNumber(strawberries)}<:fraises:1328148609585123379>`;

  if (dino.uniquePerTribe) {
    line += '\n> ⚠️ __*Un seul par tribu*__';
  }
  if (dino.coupleInventaire) {
    line += '\n> 🦖 *( Un achat via inventaire coûte 🦖 x2 )*';
  }

  return line;
}

function buildVariantLine(variant) {
  const diamonds = variant.priceDiamonds || 0;
  const strawberries = variant.priceStrawberries || 0;
  return `>   ◦ **${toDoubleStruck(variant.label)}** : ${formatNumber(diamonds)}<a:SparklyCrystal:1366174439003263087> + ${formatNumber(strawberries)}<:fraises:1328148609585123379>`;
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
      dinoLines.push('> ⛔ *Réductions fondateur ou donateur non applicables*');
    }
    if (dino.notAvailableDona) {
      dinoLines.push('> ‼️ *( NON DISPONIBLE AVEC LES PACKS DONA OU LES DINOS INVENTAIRES )*');
    }
    if (dino.doubleInventaire) {
      dinoLines.push('> 🦖 *x2 par paiement inventaire*');
    }
    if (dino.notAvailableShop) {
      dinoLines.push('> 🚫 *Pas encore disponible au shop*');
    }

    blocks.push(dinoLines.join('\n'));
  });

  const color = getLetterColor(letter);
  const colorInt = parseInt(color.replace('#', ''), 16);

  return {
    description: `# 🦖 ━━━ 【${letter}】 ━━━ 🦖\n\n` + blocks.join('\n\n'),
    color: colorInt,
    footer: { text: `Arki' Family ─ Prix Dinos ─ ${letter}` },
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
  updateLetterColor,
  getLetterColor,
  getLetterColors,
  getDinosByLetter,
  buildLetterEmbed,
  getAllLetters,
  formatNumber,
  DEFAULT_LETTER_COLORS,
};
