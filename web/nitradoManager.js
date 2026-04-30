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

// mkdir(serviceId, fullPath) — Nitrado attend { path: parentDir, name: newDirName }
async function mkdir(serviceId, fullPath) {
  const nodePath = require('path');
  const parentDir = nodePath.dirname(fullPath);   // ex: /ShooterGame/Saved/Config
  const dirName   = nodePath.basename(fullPath);  // ex: WindowsServer
  const tok = getToken();

  try {
    const payload = { path: parentDir, name: dirName };
    const res = await axios.post(
      `${BASE_URL}/services/${serviceId}/gameservers/file_server/mkdir`,
      payload,
      { headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    const bodyStr = JSON.stringify(res.data);
    console.log(`[Nitrado mkdir] ${serviceId} "${fullPath}": HTTP ${res.status} ✅ — ${bodyStr.slice(0, 200)}`);
    if (res.data?.status === 'error') {
      const msg = res.data.message || 'error in body';
      console.warn(`[Nitrado mkdir] HTTP 200 mais status=error: ${msg}`);
      return { ok: false, status: res.status, error: `HTTP 200 status=error: ${msg}` };
    }
    return { ok: true, status: res.status, body: res.data };
  } catch (err) {
    const status = err.response?.status;
    const respBody = err.response?.data;
    const msg = respBody ? JSON.stringify(respBody) : (err.message || 'unknown error');
    console.warn(`[Nitrado mkdir] ${serviceId} "${fullPath}": HTTP ${status} — ${msg}`);
    // 422 = déjà existant, c'est ok
    if (status === 422) {
      return { ok: true, status: 422, body: 'already exists' };
    }
    return { ok: false, status, error: msg };
  }
}

// Crée récursivement tous les niveaux d'un chemin
// Seul "Permission denied" est traité comme "dossier existant" (jeu protège ses dossiers)
// "Destination directory doesn't not exist" = vrai manque → ABANDON (parent introuvable)
async function mkdirRecursive(serviceId, fullPath) {
  const parts = fullPath.replace(/\/$/, '').split('/').filter(Boolean);
  let current = '';
  const results = [];
  for (const part of parts) {
    current += '/' + part;
    const r = await mkdir(serviceId, current);
    const entry = { path: current, ...r };
    if (r.ok) {
      console.log(`[Nitrado mkdirRecursive] ${serviceId} "${current}": ✅ créé`);
      results.push(entry);
    } else {
      // 422 = already exists (Nitrado standard)
      // "Permission denied" = dossier protégé (existe, ex: /ShooterGame root)
      const isPermDenied = r.error && r.error.toLowerCase().includes('permission denied');
      const isAlreadyExists = r.status === 422 || (r.error && r.error.toLowerCase().includes('already exist'));
      const treatedAsExisting = isPermDenied || isAlreadyExists;

      console.warn(`[Nitrado mkdirRecursive] ${serviceId} "${current}": ❌ (${r.error}) → ${treatedAsExisting ? 'supposé existant (continue)' : 'ABANDON'}`);
      results.push({ ...entry, ok: treatedAsExisting, note: treatedAsExisting ? 'assumed_existing' : 'real_failure' });
      if (!treatedAsExisting) return { allOk: false, results };
    }
  }
  return { allOk: true, results };
}

// Découvre automatiquement le répertoire Config ARK SA sur un serveur Nitrado
// Teste plusieurs chemins possibles (WindowsServer, WinServer, LinuxServer…)
const CONFIG_PATH_CANDIDATES = [
  '/ShooterGame/Saved/Config/WindowsServer',
  '/ShooterGame/Saved/Config/WinServer',
  '/ShooterGame/Saved/Config/LinuxServer',
  '/ShooterGame/Saved/Config/WindowsNoEditor',
  '/ShooterGame/Saved/Config',
];

async function discoverConfigDir(serviceId) {
  // Retourne le chemin trouvé ou null
  const results = await discoverConfigDirVerbose(serviceId);
  return results.found || null;
}

// Version verbose qui retourne le détail de chaque tentative (pour le diagnostic)
async function discoverConfigDirVerbose(serviceId) {
  const attempts = [];
  let firstOkPath = null; // Premier chemin qui répond sans erreur HTTP (même vide)

  // 1. Essaye de lister chaque chemin candidat
  for (const candidate of CONFIG_PATH_CANDIDATES) {
    try {
      const entries = await listFiles(serviceId, candidate);
      const hasIni = entries.some(e => e.name?.endsWith('.ini'));
      const hasContent = entries.length > 0;
      console.log(`[Nitrado discover] ${serviceId} "${candidate}": ${entries.length} entrées, ini=${hasIni}`);
      attempts.push({ path: candidate, status: 'ok', count: entries.length, hasIni, entries });

      if (hasIni) {
        // Priorité absolue : répertoire avec des .ini existants
        return { found: candidate, entries, attempts, note: 'ini_found' };
      }
      if (hasContent && !firstOkPath) {
        // Répertoire avec du contenu (sous-dossiers, autres fichiers)
        firstOkPath = { path: candidate, entries };
      }
      if (!hasContent && firstOkPath === null) {
        // Répertoire vide accessible → candidat par défaut (Nitrado retourne [] pour les dirs inexistants aussi,
        // mais on tentera mkdir+upload de toute façon — WriteFile gère ça maintenant)
        // On mémorise le premier chemin "standard" sans erreur
        if (candidate === '/ShooterGame/Saved/Config/WindowsServer') {
          firstOkPath = { path: candidate, entries: [] };
        }
      }
    } catch (err) {
      const status = err.response?.status;
      const msg = err.response?.data
        ? JSON.stringify(err.response.data)
        : err.message;
      console.log(`[Nitrado discover] ${serviceId} "${candidate}": HTTP ${status} — ${msg}`);
      attempts.push({ path: candidate, status: 'error', httpStatus: status, error: msg });
    }
  }

  // 2. Si un chemin avec contenu (non-ini) a été trouvé, l'utiliser
  if (firstOkPath) {
    return { found: firstOkPath.path, entries: firstOkPath.entries, attempts, note: 'empty_dir_assumed' };
  }

  // 3. Liste la racine "/" pour donner des pistes
  let rootEntries = [];
  let rootError = null;
  try {
    rootEntries = await listFiles(serviceId, '/');
    console.log(`[Nitrado discover] ${serviceId} "/": ${rootEntries.length} entrées`);
    if (rootEntries.length > 0) {
      const shooterDir = rootEntries.find(e => e.type === 'dir' && e.name?.toLowerCase().includes('shooter'));
      if (shooterDir) {
        const sub = `/${shooterDir.name}/Saved/Config`;
        try {
          const subEntries = await listFiles(serviceId, sub);
          const firstDir = subEntries.find(e => e.type === 'dir');
          if (firstDir) return { found: `${sub}/${firstDir.name}`, entries: subEntries, attempts, rootEntries, note: 'root_nav' };
          if (subEntries.length > 0) return { found: sub, entries: subEntries, attempts, rootEntries, note: 'root_nav' };
        } catch {}
      }
    }
  } catch (err) {
    rootError = `HTTP ${err.response?.status} — ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`;
    console.log(`[Nitrado discover] ${serviceId} "/": ${rootError}`);
  }

  return { found: null, attempts, rootEntries, rootError };
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

  // Créer récursivement tous les niveaux du répertoire avant l'upload
  // ex: /ShooterGame → /ShooterGame/Saved → /ShooterGame/Saved/Config → /ShooterGame/Saved/Config/WindowsServer
  console.log(`[Nitrado writeFile] mkdirRecursive "${dir}"…`);
  const mkdirResult = await mkdirRecursive(serviceId, dir);
  console.log(`[Nitrado writeFile] mkdirRecursive "${dir}": ${mkdirResult.allOk ? '✅ ok' : '⚠️ partiel'} — ${JSON.stringify(mkdirResult.results?.map(r => ({ path: r.path, ok: r.ok, status: r.status })))}`);
  const mkdirOk = mkdirResult.allOk;

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
      console.log(`[Nitrado writeFile] Tentative ${attempt} — upload ${filePath} (${content.length} octets) vers "${dir}"`);
      const res = await axios.post(
        `${BASE_URL}/services/${serviceId}/gameservers/file_server/upload`,
        form,
        { headers: { Authorization: `Bearer ${tok}`, ...form.getHeaders() }, timeout: 30000 }
      );
      console.log(`[Nitrado writeFile] ✅ OK tentative ${attempt} — HTTP ${res.status}:`, JSON.stringify(res.data).slice(0, 200));
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      const body = err.response?.data;
      const msg = (typeof body === 'object' ? JSON.stringify(body) : body) || err.message;
      console.error(`[Nitrado writeFile] ❌ Erreur tentative ${attempt} — HTTP ${status}: ${msg}`);
      // Si "directory doesn't exist" au 1er essai → retente mkdir et upload
      if (attempt === 1 && typeof msg === 'string' && msg.toLowerCase().includes('director')) {
        console.log(`[Nitrado writeFile] Répertoire manquant détecté, nouvelle tentative mkdir…`);
        await mkdir(serviceId, dir);
        await new Promise(r => setTimeout(r, 3000));
      }
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
 * Crée le répertoire parent automatiquement si nécessaire.
 */
async function updateIniKey(serviceId, filePath, section, key, value) {
  // 1. Lire le fichier existant (peut être vide si nouveau)
  let content = '';
  try {
    content = await readFile(serviceId, filePath);
    console.log(`[Nitrado INI] Fichier lu: ${filePath} (${content.length} octets)`);
  } catch (e) {
    console.warn(`[Nitrado INI] Fichier non trouvé (${filePath}), démarrage avec contenu vide. Erreur: ${e.message}`);
    content = '';
  }

  // 2. Modifier la clé dans le contenu INI
  const updated = setIniKey(content, section, key, value);

  // 3. Écrire le fichier — writeFile appelle mkdir automatiquement avant l'upload
  await writeFile(serviceId, filePath, updated);
  console.log(`[Nitrado INI] ✅ Clé ${key}=${value} écrite dans ${filePath}`);
  return { updated: true };
}

// Cache par serviceId pour éviter de redécouvrir à chaque appel
const _configDirCache = {};

/**
 * Met à jour une clé en utilisant le mapping INI_KEY_MAP.
 * Découvre automatiquement le bon répertoire config sur le serveur.
 */
async function updateIniKeyMapped(serviceId, key, value) {
  const map = INI_KEY_MAP[key];
  if (!map) throw new Error(`Clé "${key}" non mappée — fichier et section inconnus`);

  const nodePath = require('path');
  const filename = nodePath.basename(ARK_PATHS[map.file]); // ex: "Game.ini"

  // 1. Utilise le cache si disponible
  let configDir = _configDirCache[serviceId];

  // 2. Sinon, découvre le bon répertoire
  if (!configDir) {
    console.log(`[Nitrado INI] Découverte du répertoire config pour ${serviceId}…`);
    configDir = await discoverConfigDir(serviceId);
    if (configDir) {
      _configDirCache[serviceId] = configDir;
      console.log(`[Nitrado INI] ✅ Répertoire trouvé: ${configDir}`);
    } else {
      // Fallback : utiliser le chemin par défaut et laisser mkdir créer le répertoire
      configDir = nodePath.dirname(ARK_PATHS[map.file]);
      console.warn(`[Nitrado INI] Aucun répertoire trouvé, utilisation du défaut: ${configDir}`);
    }
  }

  const filePath = `${configDir}/${filename}`;
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
  mkdir,
  mkdirRecursive,
  discoverConfigDir,
  discoverConfigDirVerbose,
  readFile,
  writeFile,
  updateIniKey,
  updateIniKeyMapped,
  updateIniKeyOnAll,
  INI_KEY_MAP,
  ARK_PATHS,
  CONFIG_PATH_CANDIDATES,
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
