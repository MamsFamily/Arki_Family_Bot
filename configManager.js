const fs = require('fs');
const path = require('path');
const pgStore = require('./pgStore');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const PG_KEY = 'config';

let cachedConfig = null;

function loadConfigFromFile() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch (err) {
    console.error('Erreur lecture config.json:', err);
  }
  return { rouletteChoices: [], rouletteTitle: 'ARKI' };
}

function saveConfigToFile(data) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.error('Erreur écriture config.json:', err);
    return false;
  }
}

async function initConfig() {
  if (pgStore.isPostgres()) {
    const pgData = await pgStore.getData(PG_KEY);
    if (!pgData) {
      const fileData = loadConfigFromFile();
      await pgStore.setData(PG_KEY, fileData);
      console.log('🎰 Config roulette migrée vers PostgreSQL');
    }
    cachedConfig = await pgStore.getData(PG_KEY);
  } else {
    cachedConfig = loadConfigFromFile();
  }
}

function getConfig() {
  if (cachedConfig) return cachedConfig;
  return loadConfigFromFile();
}

async function saveConfig(updates) {
  const current = getConfig();
  const merged = { ...current, ...updates };
  cachedConfig = merged;
  if (pgStore.isPostgres()) {
    await pgStore.setData(PG_KEY, merged);
  }
  saveConfigToFile(merged);
  return merged;
}

module.exports = { getConfig, saveConfig, initConfig };
