const axios = require('axios');

const BASE_URL = 'https://api.nitrado.net';

function getToken() {
  return process.env.NITRADO_TOKEN || null;
}

function client() {
  const token = getToken();
  if (!token) throw new Error('NITRADO_TOKEN non configuré');
  return axios.create({
    baseURL: BASE_URL,
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15000,
  });
}

// ── Services ──────────────────────────────────────────────────────────────────

async function getServices() {
  const res = await client().get('/services');
  return (res.data?.data?.services || []).filter(s => s.type === 'gameserver');
}

async function getServerDetails(serviceId) {
  const res = await client().get(`/services/${serviceId}/gameservers`);
  return res.data?.data?.gameserver || null;
}

async function getMultipleDetails(serviceIds) {
  return Promise.all(serviceIds.map(async id => {
    try {
      const detail = await getServerDetails(id);
      return { serviceId: id, detail };
    } catch {
      return { serviceId: id, detail: null };
    }
  }));
}

// ── Contrôle serveur ───────────────────────────────────────────────────────────

async function restartServer(serviceId, message = '') {
  const payload = message ? { message } : {};
  const res = await client().post(`/services/${serviceId}/gameservers/restart`, payload);
  return res.data;
}

async function stopServer(serviceId) {
  const res = await client().post(`/services/${serviceId}/gameservers/stop`);
  return res.data;
}

async function startServer(serviceId) {
  // Nitrado n'a pas d'endpoint /start séparé — /restart fonctionne que le serveur soit stoppé ou non
  const res = await client().post(`/services/${serviceId}/gameservers/restart`);
  return res.data;
}

// ── Paramètres jeu ──────────────────────────────────────────────────────────

async function getSettings(serviceId) {
  const res = await client().get(`/services/${serviceId}/gameservers/settings`);
  return res.data?.data?.settings || {};
}

// Normalise les séparateurs décimaux : remplace les virgules par des points
// Nitrado n'accepte que le point comme séparateur décimal dans les valeurs numériques
function normalizeValue(val) {
  if (typeof val !== 'string') val = String(val);
  // Remplace la virgule décimale par un point (format fr → international)
  // Uniquement si le format ressemble à un nombre (ex: "0,0002" → "0.0002")
  if (/^-?\d+,\d+$/.test(val.trim())) return val.trim().replace(',', '.');
  return val.trim();
}

async function updateSettings(serviceId, settingsObj) {
  // Nitrado attend category + key + value comme paramètres séparés (un appel par clé)
  const token = getToken();
  if (!token) throw new Error('NITRADO_TOKEN non configuré');
  const results = [];
  for (const [category, catVal] of Object.entries(settingsObj)) {
    if (typeof catVal !== 'object' || catVal === null) continue;
    for (const [key, val] of Object.entries(catVal)) {
      const rawValue = (typeof val === 'object' && val !== null && 'value' in val) ? val.value : val;
      const value = normalizeValue(rawValue);
      const params = new URLSearchParams({ category, key, value });
      console.log(`[Nitrado updateSettings] ${serviceId} — ${params.toString()}`);
      try {
        const res = await axios.post(
          `${BASE_URL}/services/${serviceId}/gameservers/settings`,
          params.toString(),
          { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
        );
        console.log(`[Nitrado updateSettings] Réponse HTTP ${res.status} pour ${category}/${key}:`, JSON.stringify(res.data));
        results.push(res.data);
      } catch (err) {
        const body = err.response?.data;
        const msg = (typeof body === 'object' ? JSON.stringify(body) : body) || err.message;
        console.error(`[Nitrado updateSettings] Erreur ${err.response?.status} pour ${serviceId}/${category}/${key}:`, msg);
        throw new Error(`Nitrado API ${err.response?.status || ''}: ${msg}`);
      }
    }
  }
  return results;
}

// ── Fichiers config ─────────────────────────────────────────────────────────

// Chemins ARK SA dans le file server Nitrado (relatifs à la racine du serveur de jeu)
const ARK_PATHS = {
  gameIni: '/ShooterGame/Saved/Config/WindowsServer/Game.ini',
  gameUserSettings: '/ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini',
};

// Mapping paramètre → { file, section }
const INI_KEY_MAP = {
  MatingIntervalMultiplier:           { file: 'gameIni',        section: '/Script/ShooterGame.ShooterGameMode' },
  BabyMatureSpeedMultiplier:          { file: 'gameIni',        section: '/Script/ShooterGame.ShooterGameMode' },
  BabyFoodConsumptionSpeedMultiplier: { file: 'gameIni',        section: '/Script/ShooterGame.ShooterGameMode' },
  EggHatchSpeedMultiplier:            { file: 'gameIni',        section: '/Script/ShooterGame.ShooterGameMode' },
  TamingSpeedMultiplier:              { file: 'gameUserSettings', section: 'ServerSettings' },
  HarvestAmountMultiplier:            { file: 'gameUserSettings', section: 'ServerSettings' },
  XPMultiplier:                       { file: 'gameUserSettings', section: 'ServerSettings' },
  PlayerDamageMultiplier:             { file: 'gameUserSettings', section: 'ServerSettings' },
  DinoDamageMultiplier:               { file: 'gameUserSettings', section: 'ServerSettings' },
  DinoResistanceMultiplier:           { file: 'gameUserSettings', section: 'ServerSettings' },
  PlayerResistanceMultiplier:         { file: 'gameUserSettings', section: 'ServerSettings' },
  ResourcesRespawnPeriodMultiplier:   { file: 'gameUserSettings', section: 'ServerSettings' },
  NightTimeSpeedScale:                { file: 'gameUserSettings', section: 'ServerSettings' },
  DayTimeSpeedScale:                  { file: 'gameUserSettings', section: 'ServerSettings' },
};

async function listFiles(serviceId, dir) {
  const res = await client().get(`/services/${serviceId}/gameservers/file_server/list`, {
    params: { dir },
  });
  return res.data?.data?.entries || [];
}

async function readFile(serviceId, filePath) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) await new Promise(r => setTimeout(r, 8000));
    try {
      const res = await client().get(`/services/${serviceId}/gameservers/file_server/download`, {
        params: { file: filePath },
      });
      const url = res.data?.data?.url;
      const token = res.data?.data?.token;
      if (!url && !token) throw new Error(`Pas de lien de téléchargement pour ${filePath}`);
      const dlUrl = url || `${BASE_URL}/download?token=${token}`;
      const dl = await axios.get(dlUrl, { responseType: 'text', timeout: 20000 });
      return typeof dl.data === 'string' ? dl.data : JSON.stringify(dl.data);
    } catch (err) {
      const status = err.response?.status;
      const msg = (typeof err.response?.data === 'object' ? JSON.stringify(err.response?.data) : err.response?.data) || err.message;
      console.error(`[Nitrado readFile] Erreur tentative ${attempt} — HTTP ${status}: ${msg} (${filePath})`);
      lastErr = new Error(`HTTP ${status}: ${msg}`);
    }
  }
  throw lastErr;
}

async function writeFile(serviceId, filePath, content) {
  const FormData = require('form-data');
  const nodePath = require('path');
  const tok = getToken();
  const dir = nodePath.dirname(filePath);
  const filename = nodePath.basename(filePath);

  // Retry 2× avec délai croissant (le file server peut prendre du temps à s'ouvrir après arrêt du serveur)
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) {
      console.log(`[Nitrado writeFile] Retry ${attempt} dans 10s (${filePath})`);
      await new Promise(r => setTimeout(r, 10000));
    }
    try {
      const form = new FormData();
      form.append('path', dir);
      form.append('file', Buffer.from(content, 'utf8'), { filename });
      console.log(`[Nitrado writeFile] Tentative ${attempt} — upload ${filePath} (${content.length} octets) vers ${dir}`);
      const res = await axios.post(
        `${BASE_URL}/services/${serviceId}/gameservers/file_server/upload`,
        form,
        { headers: { Authorization: `Bearer ${tok}`, ...form.getHeaders() }, timeout: 30000 }
      );
      console.log(`[Nitrado writeFile] OK tentative ${attempt} — HTTP ${res.status}:`, JSON.stringify(res.data).slice(0, 200));
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      const body = err.response?.data;
      const msg = (typeof body === 'object' ? JSON.stringify(body) : body) || err.message;
      console.error(`[Nitrado writeFile] Erreur tentative ${attempt} — HTTP ${status}: ${msg}`);
      lastErr = new Error(`HTTP ${status}: ${msg}`);
    }
  }
  throw lastErr;
}

// ── Éditeur INI ─────────────────────────────────────────────────────────────

/**
 * Parse un fichier INI ARK en tableau de lignes annotées.
 * Retourne { sections: Map<string, string[]>, raw: string[] }
 */
function parseIni(content) {
  const lines = content.split('\n');
  const sections = new Map(); // sectionName → index de début dans lines
  let currentSection = null;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const m = trimmed.match(/^\[(.+?)\]$/);
    if (m) {
      currentSection = m[1];
      if (!sections.has(currentSection)) sections.set(currentSection, i);
    }
  }
  return { sections, lines };
}

/**
 * Met à jour ou ajoute une clé dans une section d'un fichier INI.
 * Retourne le contenu INI modifié.
 */
function setIniKey(content, section, key, value) {
  const { sections, lines } = parseIni(content);
  const normalizedVal = normalizeValue(String(value));

  if (sections.has(section)) {
    const sectionStart = sections.get(section);
    // Cherche la clé dans cette section
    let found = false;
    for (let i = sectionStart + 1; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      // Fin de section
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) break;
      // Clé trouvée
      if (trimmed.startsWith(key + '=') || trimmed.startsWith(key + ' =')) {
        lines[i] = `${key}=${normalizedVal}`;
        found = true;
        break;
      }
    }
    if (!found) {
      // Ajouter la clé à la fin de la section (avant la prochaine section ou EOF)
      let insertAt = sectionStart + 1;
      for (let i = sectionStart + 1; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
          insertAt = i;
          break;
        }
        insertAt = i + 1;
      }
      lines.splice(insertAt, 0, `${key}=${normalizedVal}`);
    }
  } else {
    // Crée la section à la fin du fichier
    if (lines[lines.length - 1] !== '') lines.push('');
    lines.push(`[${section}]`);
    lines.push(`${key}=${normalizedVal}`);
  }

  return lines.join('\n');
}

/**
 * Lit un fichier INI, modifie une clé, réécrit le fichier.
 */
async function updateIniKey(serviceId, filePath, section, key, value) {
  let content = '';
  try {
    content = await readFile(serviceId, filePath);
  } catch (e) {
    console.warn(`[Nitrado INI] Fichier introuvable (${filePath}), création: ${e.message}`);
    content = '';
  }
  const updated = setIniKey(content, section, key, value);
  await writeFile(serviceId, filePath, updated);
  return { updated: true };
}

/**
 * Met à jour une clé en utilisant le mapping INI_KEY_MAP.
 * Si la clé n'est pas dans le mapping, lève une erreur.
 */
async function updateIniKeyMapped(serviceId, key, value) {
  const map = INI_KEY_MAP[key];
  if (!map) throw new Error(`Clé "${key}" non mappée — fichier et section inconnus`);
  const filePath = ARK_PATHS[map.file];
  return updateIniKey(serviceId, filePath, map.section, key, value);
}

async function updateIniKeyOnAll(serviceIds, key, value) {
  const results = [];
  for (const id of serviceIds) {
    try {
      await updateIniKeyMapped(id, key, value);
      results.push({ id, ok: true });
    } catch (e) {
      console.error(`[Nitrado INI] Erreur ${id} — ${key}:`, e.message);
      results.push({ id, ok: false, error: e.message });
    }
  }
  return results;
}

// ── Mods ARK SA ──────────────────────────────────────────────────────────────

// Clés candidates pour la liste de mods selon les versions d'ARK sur Nitrado
const MOD_KEY_CANDIDATES = [
  'active-mods', 'mods', 'active_mods', 'ActiveMods',
  'ModIDs', 'mod_ids', 'ModIds', 'GameModIds',
  'game_mod_ids', 'mod_list', 'modList',
];

function findModEntry(settings) {
  for (const [cat, catVal] of Object.entries(settings)) {
    if (typeof catVal !== 'object' || catVal === null) continue;
    for (const key of MOD_KEY_CANDIDATES) {
      if (catVal[key] !== undefined) return { categoryName: cat, keyName: key, entry: catVal[key] };
    }
  }
  return null;
}

async function getMods(serviceId) {
  const settings = await getSettings(serviceId);
  const found = findModEntry(settings);
  if (found) {
    const raw = found.entry?.value ?? found.entry ?? '';
    return raw.toString().split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

async function setMods(serviceId, modList) {
  const settings = await getSettings(serviceId);
  const found = findModEntry(settings);

  if (found) {
    const { categoryName, keyName, entry } = found;
    const payload = { [categoryName]: {} };
    // Nitrado attend la valeur encapsulée dans { value: "..." } si l'entrée est un objet
    payload[categoryName][keyName] = (typeof entry === 'object' && entry !== null)
      ? { value: modList.join(',') }
      : modList.join(',');
    console.log(`[Nitrado setMods] payload envoyé pour ${serviceId}:`, JSON.stringify(payload));
    return updateSettings(serviceId, payload);
  }

  // Log pour debug : affiche les clés disponibles dans la console Railway
  console.warn(`[Nitrado] Clé mods introuvable pour ${serviceId}. Clés dispo :`,
    Object.entries(settings).map(([c, v]) => `${c}: [${typeof v === 'object' ? Object.keys(v || {}).join(', ') : v}]`).join(' | ')
  );
  throw new Error('Clé de mods introuvable dans les settings Nitrado pour ce serveur');
}

async function addMod(serviceId, modId) {
  const mods = await getMods(serviceId);
  if (!mods.includes(modId)) mods.push(modId);
  return setMods(serviceId, mods);
}

async function removeMod(serviceId, modId) {
  const mods = await getMods(serviceId);
  return setMods(serviceId, mods.filter(m => m !== modId));
}

// ── Actions globales (toutes maps) ───────────────────────────────────────────

async function restartAll(serviceIds, message = '') {
  const results = [];
  for (const id of serviceIds) {
    try {
      await restartServer(id, message);
      results.push({ id, ok: true });
    } catch (e) {
      results.push({ id, ok: false, error: e.message });
    }
  }
  return results;
}

async function addModToAll(serviceIds, modId) {
  const results = [];
  for (const id of serviceIds) {
    try {
      await addMod(id, modId);
      results.push({ id, ok: true });
    } catch (e) {
      results.push({ id, ok: false, error: e.message });
    }
  }
  return results;
}

async function removeModFromAll(serviceIds, modId) {
  const results = [];
  for (const id of serviceIds) {
    try {
      await removeMod(id, modId);
      results.push({ id, ok: true });
    } catch (e) {
      results.push({ id, ok: false, error: e.message });
    }
  }
  return results;
}

// Cherche la catégorie réelle d'une clé dans les settings Nitrado
async function findCategory(serviceId, key) {
  const settings = await getSettings(serviceId);
  for (const [cat, catVal] of Object.entries(settings)) {
    if (typeof catVal !== 'object' || catVal === null) continue;
    if (key in catVal) return cat;
  }
  return null;
}

// Met à jour un paramètre en détectant automatiquement sa catégorie réelle
async function smartUpdateSetting(serviceId, key, value, hintCategory) {
  const settings = await getSettings(serviceId);

  // 1. Essaie la catégorie indicée d'abord (rapide)
  if (hintCategory && settings[hintCategory] && key in settings[hintCategory]) {
    console.log(`[Nitrado smartUpdate] Hint OK: ${hintCategory}/${key} = ${value} (serveur ${serviceId})`);
    await updateSettings(serviceId, { [hintCategory]: { [key]: value } });
    return { category: hintCategory };
  }

  // 2. Recherche exhaustive dans toutes les catégories
  let realCat = null;
  for (const [cat, catVal] of Object.entries(settings)) {
    if (typeof catVal !== 'object' || catVal === null) continue;
    if (key in catVal) { realCat = cat; break; }
  }
  if (!realCat) {
    const availableKeys = Object.entries(settings)
      .filter(([, v]) => typeof v === 'object' && v)
      .map(([c, v]) => `${c}: [${Object.keys(v).join(', ')}]`).join(' | ');
    console.warn(`[Nitrado smartUpdate] Clé "${key}" introuvable. Disponibles: ${availableKeys}`);
    throw new Error(`Clé "${key}" introuvable dans les settings Nitrado (serveur ${serviceId})`);
  }

  console.log(`[Nitrado smartUpdate] Catégorie détectée: ${realCat}/${key} = ${value} (serveur ${serviceId})`);
  await updateSettings(serviceId, { [realCat]: { [key]: value } });
  return { category: realCat };
}

async function updateSettingOnAll(serviceIds, key, value, hintCategory) {
  const results = [];
  for (const id of serviceIds) {
    try {
      const { category } = await smartUpdateSetting(id, key, value, hintCategory);
      results.push({ id, ok: true, category });
    } catch (e) {
      results.push({ id, ok: false, error: e.message });
    }
  }
  return results;
}

// ── RCON via API Nitrado ──────────────────────────────────────────────────────

async function sendRcon(serviceId, command) {
  const res = await client().post(`/services/${serviceId}/gameservers/app_server/command`, { command });
  return res.data;
}

// ── RCON direct (Source RCON protocol) ───────────────────────────────────────

async function sendRconDirect(ip, port, password, command) {
  const { Rcon } = require('rcon-client');
  const rcon = new Rcon({ host: ip, port: parseInt(port), password: password || '', timeout: 10000 });
  try {
    await rcon.connect();
    const response = await rcon.send(command);
    await rcon.end();
    return response || '';
  } catch (e) {
    try { await rcon.end(); } catch {}
    throw e;
  }
}

async function sendRconToMany(serviceIds, command, directCfg = {}) {
  const results = [];
  for (const id of serviceIds) {
    const cfg = directCfg[id];
    if (cfg && cfg.ip && cfg.rconPort) {
      // RCON direct — bypasse l'API Nitrado
      try {
        const response = await sendRconDirect(cfg.ip, cfg.rconPort, cfg.rconPassword || '', command);
        console.log(`✅ RCON direct ${id} (${command}): réponse = "${response || '(vide)'}"`);
        results.push({ id, ok: true, response });
      } catch (e) {
        console.error(`❌ RCON direct ${id} (${command}):`, e.message);
        results.push({ id, ok: false, error: e.message });
      }
    } else {
      // Fallback API Nitrado
      try {
        const data = await sendRcon(id, command);
        results.push({ id, ok: true, response: data?.data?.message || '' });
      } catch (e) {
        const status = e.response?.status;
        const nitradoMsg = e.response?.data?.message || e.response?.data?.error || '';
        const detail = nitradoMsg ? `[${status}] ${nitradoMsg}` : (e.message || 'Erreur inconnue');
        console.error(`❌ RCON API Nitrado ${id} (${command}):`, detail);
        results.push({ id, ok: false, error: detail });
      }
    }
  }
  return results;
}

module.exports = {
  getToken,
  getServices,
  getServerDetails,
  getMultipleDetails,
  restartServer,
  stopServer,
  startServer,
  getSettings,
  updateSettings,
  findCategory,
  smartUpdateSetting,
  listFiles,
  readFile,
  writeFile,
  updateIniKey,
  updateIniKeyMapped,
  updateIniKeyOnAll,
  INI_KEY_MAP,
  ARK_PATHS,
  getMods,
  setMods,
  addMod,
  removeMod,
  restartAll,
  addModToAll,
  removeModFromAll,
  updateSettingOnAll,
  sendRcon,
  sendRconDirect,
  sendRconToMany,
};
