const pgStore = require('./pgStore');

// ─── Formule XP (DraftBot exponentielle ×1) ──────────────────────────────────
// XP nécessaire pour passer du niveau L au niveau L+1
function xpToNextLevel(level) {
  return Math.floor(5 * Math.pow(level, 2) + 50 * level + 100);
}

// XP total cumulé pour atteindre exactement le niveau N (depuis 0)
function totalXpForLevel(level) {
  let total = 0;
  for (let i = 0; i < level; i++) total += xpToNextLevel(i);
  return total;
}

// Décompose un XP total en { level, currentXp (dans le niveau), xpForNext }
function calcLevelAndRemainder(totalXp) {
  let level = 0;
  let remaining = Math.max(0, totalXp);
  while (remaining >= xpToNextLevel(level)) {
    remaining -= xpToNextLevel(level);
    level++;
  }
  return { level, currentXp: remaining, xpForNext: xpToNextLevel(level) };
}

// Niveau simple depuis un total XP
function calcLevel(totalXp) {
  return calcLevelAndRemainder(totalXp).level;
}

// Récompense par défaut : niveau N = N * multiplicateur
function defaultRewardForLevel(level, multiplier = 1000) {
  return level * multiplier;
}

// ─── Config ───────────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  roleId: '1173596259328729189',
  channelId: null,
  minXp: 3,
  maxXp: 10,
  cooldownMs: 60000,
  excludedChannels: [],
  rewardMultiplier: 1000,
  customRewards: {},
};

async function loadXpConfig() {
  const data = await pgStore.getData('xp_config');
  if (!data) return { ...DEFAULT_CONFIG };
  return { ...DEFAULT_CONFIG, ...data };
}

async function saveXpConfig(config) {
  await pgStore.setData('xp_config', config);
}

// ─── Données XP joueurs ───────────────────────────────────────────────────────
async function loadXpData() {
  const data = await pgStore.getData('xp_data');
  return data || {};
}

async function saveXpData(data) {
  await pgStore.setData('xp_data', data);
}

async function getUserData(userId) {
  const data = await loadXpData();
  return data[userId] || { totalXp: 0 };
}

// Ajoute (ou soustrait) de l'XP à un joueur — retourne le résultat
async function addXp(userId, amount) {
  const data   = await loadXpData();
  const user   = data[userId] || { totalXp: 0 };
  const config = await loadXpConfig();

  const oldLevel = calcLevel(user.totalXp);
  user.totalXp   = Math.max(0, (user.totalXp || 0) + amount);
  data[userId]   = user;
  await saveXpData(data);

  const newLevel = calcLevel(user.totalXp);
  const { currentXp, xpForNext } = calcLevelAndRemainder(user.totalXp);

  const leveledUp   = newLevel > oldLevel;
  const levelsGained = [];
  let totalReward   = 0;

  if (leveledUp) {
    for (let l = oldLevel + 1; l <= newLevel; l++) {
      const reward = config.customRewards[l] !== undefined
        ? config.customRewards[l]
        : defaultRewardForLevel(l, config.rewardMultiplier);
      totalReward += reward;
      levelsGained.push({ level: l, reward });
    }
  }

  return { totalXp: user.totalXp, newLevel, oldLevel, leveledUp, totalReward, levelsGained, currentXp, xpForNext };
}

// Fixe directement le total XP d'un joueur
async function setXp(userId, totalXp) {
  const data  = await loadXpData();
  data[userId] = { totalXp: Math.max(0, totalXp) };
  await saveXpData(data);
}

// ─── Cooldowns anti-spam ──────────────────────────────────────────────────────
async function loadCooldowns() {
  const data = await pgStore.getData('xp_cooldowns');
  return data || {};
}

async function saveCooldowns(data) {
  await pgStore.setData('xp_cooldowns', data);
}

async function getCooldown(userId) {
  const data = await loadCooldowns();
  return data[userId] || 0;
}

async function setCooldown(userId) {
  const data  = await loadCooldowns();
  data[userId] = Date.now();
  await saveCooldowns(data);
}

// ─── Tous les joueurs (classement) ───────────────────────────────────────────
async function getAllXpData() {
  return await loadXpData();
}

module.exports = {
  xpToNextLevel,
  totalXpForLevel,
  calcLevel,
  calcLevelAndRemainder,
  defaultRewardForLevel,
  loadXpConfig,
  saveXpConfig,
  getUserData,
  addXp,
  setXp,
  getCooldown,
  setCooldown,
  getAllXpData,
};
