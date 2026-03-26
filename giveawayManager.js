const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pgStore = require('./pgStore');

const GIVEAWAY_PATH = path.join(__dirname, 'giveaways.json');
const PG_KEY = 'giveaways';

let cachedData = null;

function loadFromFile() {
  try {
    if (fs.existsSync(GIVEAWAY_PATH)) {
      return JSON.parse(fs.readFileSync(GIVEAWAY_PATH, 'utf-8'));
    }
  } catch (e) {
    console.error('[Giveaway] Erreur lecture giveaways.json:', e);
  }
  return { giveaways: [] };
}

function saveToFile(data) {
  try {
    fs.writeFileSync(GIVEAWAY_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[Giveaway] Erreur écriture giveaways.json:', e);
  }
}

async function loadData() {
  try {
    const pg = await pgStore.read(PG_KEY);
    if (pg) {
      cachedData = pg;
      saveToFile(pg);
      return pg;
    }
  } catch (e) {}
  const file = loadFromFile();
  cachedData = file;
  return file;
}

async function saveData(data) {
  cachedData = data;
  saveToFile(data);
  try { await pgStore.write(PG_KEY, data); } catch (e) {}
}

function getData() {
  if (!cachedData) cachedData = loadFromFile();
  return cachedData;
}

function generateId() {
  return crypto.randomBytes(4).toString('hex');
}

async function createGiveaway({ title, description, conditions, prize, winnerCount, endTime, channelId, guildId, createdBy, createdByName, imageUrl, roleId, pingEveryone }) {
  const data = getData();
  const id = generateId();
  const giveaway = {
    id,
    title,
    description: description || '',
    conditions: conditions || '',
    prize,
    winnerCount: parseInt(winnerCount) || 1,
    endTime,
    channelId,
    guildId,
    createdBy,
    imageUrl: imageUrl || '',
    roleId: roleId || '',
    pingEveryone: !!pingEveryone,
    createdByName: createdByName || createdBy || 'Admin',
    messageId: null,
    participants: [],
    winners: [],
    previousWinners: [],
    status: 'active',
    createdAt: new Date().toISOString(),
  };
  data.giveaways.push(giveaway);
  await saveData(data);
  return giveaway;
}

async function updateMessageId(id, messageId) {
  const data = getData();
  const g = data.giveaways.find(g => g.id === id);
  if (g) {
    g.messageId = messageId;
    await saveData(data);
  }
}

async function updateImageUrl(id, imageUrl) {
  const data = getData();
  const g = data.giveaways.find(g => g.id === id);
  if (g) {
    g.imageUrl = imageUrl;
    await saveData(data);
  }
}

function getGiveaway(id) {
  return getData().giveaways.find(g => g.id === id) || null;
}

function getActiveGiveaways() {
  return getData().giveaways.filter(g => g.status === 'active');
}

function getAllGiveaways() {
  return [...getData().giveaways].reverse();
}

async function addParticipant(id, userId) {
  const data = getData();
  const g = data.giveaways.find(g => g.id === id);
  if (!g || g.status !== 'active') return false;
  if (g.participants.includes(userId)) return false;
  g.participants.push(userId);
  await saveData(data);
  return true;
}

async function removeParticipant(id, userId) {
  const data = getData();
  const g = data.giveaways.find(g => g.id === id);
  if (!g) return false;
  const idx = g.participants.indexOf(userId);
  if (idx === -1) return false;
  g.participants.splice(idx, 1);
  await saveData(data);
  return true;
}

function isParticipant(id, userId) {
  const g = getGiveaway(id);
  return g ? g.participants.includes(userId) : false;
}

async function drawWinners(id) {
  const data = getData();
  const g = data.giveaways.find(g => g.id === id);
  if (!g) return null;

  const eligible = g.participants.filter(uid => !g.previousWinners.includes(uid));
  const count = Math.min(g.winnerCount, eligible.length);
  if (count === 0) return [];

  const shuffled = [...eligible].sort(() => Math.random() - 0.5);
  const winners = shuffled.slice(0, count);

  g.winners = winners;
  g.previousWinners = [...g.previousWinners, ...winners];
  g.status = 'ended';
  await saveData(data);
  return winners;
}

async function rerollGiveaway(id) {
  const data = getData();
  const g = data.giveaways.find(g => g.id === id);
  if (!g) return null;

  const eligible = g.participants.filter(uid => !g.previousWinners.includes(uid));
  const count = Math.min(g.winnerCount, eligible.length);
  if (count === 0) return [];

  const shuffled = [...eligible].sort(() => Math.random() - 0.5);
  const winners = shuffled.slice(0, count);

  g.winners = winners;
  g.previousWinners = [...g.previousWinners, ...winners];
  g.status = 'ended';
  await saveData(data);
  return winners;
}

async function deleteGiveaway(id) {
  const data = getData();
  data.giveaways = data.giveaways.filter(g => g.id !== id);
  await saveData(data);
}

async function initGiveaways() {
  await loadData();
}

function formatTimeLeft(endTime) {
  const now = Date.now();
  const end = new Date(endTime).getTime();
  const diff = end - now;
  if (diff <= 0) return 'Terminé';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h > 24) {
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return `${d}j ${rh}h ${m}m`;
  }
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

module.exports = {
  initGiveaways,
  createGiveaway,
  updateMessageId,
  updateImageUrl,
  getGiveaway,
  getActiveGiveaways,
  getAllGiveaways,
  addParticipant,
  removeParticipant,
  isParticipant,
  drawWinners,
  rerollGiveaway,
  deleteGiveaway,
  formatTimeLeft,
};
