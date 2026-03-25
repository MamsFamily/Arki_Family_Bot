const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pgStore = require('./pgStore');

const SETTINGS_PATH = path.join(__dirname, 'settings.json');
const PG_KEY = 'settings';

let cachedSettings = null;

function envOr(envKey, fallback) {
  return process.env[envKey] || fallback;
}

const DEFAULTS = {
  guild: {
    guildId: envOr('GUILD_ID', '1156256997403000874'),
    resultsChannelId: envOr('RESULTS_CHANNEL_ID', '1157994586774442085'),
    adminLogChannelId: envOr('ADMIN_LOG_CHANNEL_ID', '1457048610939207769'),
    inventoryLogChannelId: '',
    topVoterRoleId: envOr('TOP_VOTER_ROLE_ID', '1180440383784759346'),
    modoRoleId: '1157803768893689877',
  },
  rewards: {
    diamondsPerVote: 100,
    topDiamonds: { 4: 4000, 5: 3000 },
    topLots: {
      1: { '🦖': 6, '🎨': 6, '3️⃣': 1, '🍓': 15000, '💎': 15000 },
      2: { '🦖': 4, '🎨': 4, '2️⃣': 1, '🍓': 10000, '💎': 10000 },
      3: { '🦖': 2, '🎨': 2, '1️⃣': 1, '🍓': 5000, '💎': 5000 },
    },
  },
  api: {
    topserveursRankingUrl: envOr('TOPSERVEURS_RANKING_URL', 'https://api.top-serveurs.net/v1/servers/4ROMAU33GJTY/players-ranking?type=lastMonth'),
    timezone: envOr('TIMEZONE', 'Europe/Paris'),
    inventoryApiKey: '',
  },
  style: {
    everyonePing: true,
    logo: '<a:Logo:1313979016973127730>',
    fireworks: '<a:fireworks:1388428854078476339>',
    arrow: '<a:fleche:1402586366210080899>',
    animeArrow: '<a:animearrow:1157234686200922152>',
    sparkly: '<a:SparklyCrystal:1366174439003263087>',
    memoUrl: 'https://discord.com/channels/1156256997403000874/1157994573716973629/1367513646158319637',
  },
  message: {
    introText: 'Merci à tous les votants ! Grâce à vous, notre serveur gagne en visibilité. Continuez comme ça ! 💪',
    creditText: 'Les diamants ont été **automatiquement crédités** sur vos comptes !',
    memoText: 'Pour mémo, vous retrouverez la liste des récompenses votes à gagner ici',
    dinoShinyText: 'Tirage Dino Shiny juste après 🦖',
    dinoTitle: 'DINO',
    dinoWinText: 'Tu remportes le **Dino Shiny** du mois ! 🦖✨',
    pack1Text: 'Pack vote 1ère place + rôle',
    pack2Text: 'Pack vote 2ème place',
    pack3Text: 'Pack vote 3ème place',
  },
  auth: {
    adminPassword: envOr('DASHBOARD_PASSWORD', 'eden6'),
    staffPassword: 'arkistaff',
  },
  aliases: {},
};

function deepMerge(target, source) {
  const result = { ...target };
  for (const key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function loadSettingsFromFile() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
      return deepMerge(DEFAULTS, data);
    }
  } catch (err) {
    console.error('Erreur lecture settings.json:', err);
  }
  return { ...DEFAULTS };
}

function saveSettingsToFile(settings) {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    return true;
  } catch (err) {
    console.error('Erreur écriture settings.json:', err);
    return false;
  }
}

async function loadSettingsFromPg() {
  if (!pgStore.isPostgres()) return null;
  const data = await pgStore.getData(PG_KEY);
  if (data) return deepMerge(DEFAULTS, data);
  return null;
}

async function saveSettingsToPg(settings) {
  if (!pgStore.isPostgres()) return false;
  return await pgStore.setData(PG_KEY, settings);
}

async function initSettings() {
  if (pgStore.isPostgres()) {
    const pgData = await pgStore.getData(PG_KEY);
    if (!pgData) {
      const fileData = loadSettingsFromFile();
      await saveSettingsToPg(fileData);
      console.log('📋 Settings migrés vers PostgreSQL');
    }
    cachedSettings = await loadSettingsFromPg();
  } else {
    cachedSettings = loadSettingsFromFile();
  }

  // Générer la clé API publique si absente
  if (!cachedSettings.api || !cachedSettings.api.inventoryApiKey) {
    const key = crypto.randomBytes(24).toString('hex');
    cachedSettings.api = { ...cachedSettings.api, inventoryApiKey: key };
    await saveSettings(cachedSettings);
    console.log('🔑 Clé API inventaire générée');
  }
}

function getSettings() {
  if (cachedSettings) return cachedSettings;
  return loadSettingsFromFile();
}

async function saveSettings(settings) {
  cachedSettings = settings;
  if (pgStore.isPostgres()) {
    await saveSettingsToPg(settings);
  }
  saveSettingsToFile(settings);
  return true;
}

async function updateSection(section, data, replace = false) {
  const settings = getSettings();
  if (replace) {
    settings[section] = data;
  } else {
    settings[section] = { ...settings[section], ...data };
  }
  await saveSettings(settings);
  return settings;
}

module.exports = { getSettings, saveSettings, updateSection, initSettings, DEFAULTS };
