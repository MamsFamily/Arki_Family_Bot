const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = path.join(__dirname, 'settings.json');

function envOr(envKey, fallback) {
  return process.env[envKey] || fallback;
}

const DEFAULTS = {
  guild: {
    guildId: envOr('GUILD_ID', '1156256997403000874'),
    resultsChannelId: envOr('RESULTS_CHANNEL_ID', '1157994586774442085'),
    adminLogChannelId: envOr('ADMIN_LOG_CHANNEL_ID', '1457048610939207769'),
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
    adminPassword: envOr('DASHBOARD_PASSWORD', 'arki2024'),
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

function loadSettings() {
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

function saveSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    return true;
  } catch (err) {
    console.error('Erreur écriture settings.json:', err);
    return false;
  }
}

function updateSection(section, data, replace = false) {
  const settings = loadSettings();
  if (replace) {
    settings[section] = data;
  } else {
    settings[section] = { ...settings[section], ...data };
  }
  return saveSettings(settings) ? settings : null;
}

function getSettings() {
  return loadSettings();
}

module.exports = { getSettings, saveSettings, updateSection, DEFAULTS };
