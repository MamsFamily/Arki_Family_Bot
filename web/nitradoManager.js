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
  // ── Élevage / Breeding (Game.ini) ───────────────────────────────────────────
  MatingIntervalMultiplier:                    { file: 'gameIni', section: '/Script/ShooterGame.ShooterGameMode' },
  MatingSpeedMultiplier:                       { file: 'gameIni', section: '/Script/ShooterGame.ShooterGameMode' },
  EggHatchSpeedMultiplier:                     { file: 'gameIni', section: '/Script/ShooterGame.ShooterGameMode' },
  BabyMatureSpeedMultiplier:                   { file: 'gameIni', section: '/Script/ShooterGame.ShooterGameMode' },
  BabyFoodConsumptionSpeedMultiplier:          { file: 'gameIni', section: '/Script/ShooterGame.ShooterGameMode' },
  BabyImprintingStatScaleMultiplier:           { file: 'gameIni', section: '/Script/ShooterGame.ShooterGameMode' },
  BabyCuddleIntervalMultiplier:                { file: 'gameIni', section: '/Script/ShooterGame.ShooterGameMode' },
  BabyCuddleGracePeriodMultiplier:             { file: 'gameIni', section: '/Script/ShooterGame.ShooterGameMode' },
  BabyCuddleLoseImprintQualitySpeedMultiplier: { file: 'gameIni', section: '/Script/ShooterGame.ShooterGameMode' },
  LayEggIntervalMultiplier:                    { file: 'gameIni', section: '/Script/ShooterGame.ShooterGameMode' },

  // ── Récolte / Ressources (Game.ini) ─────────────────────────────────────────
  DinoHarvestingDamageMultiplier:              { file: 'gameIni', section: '/Script/ShooterGame.ShooterGameMode' },
  PlayerHarvestingDamageMultiplier:            { file: 'gameIni', section: '/Script/ShooterGame.ShooterGameMode' },
  GlobalSpoilingTimeMultiplier:                { file: 'gameIni', section: '/Script/ShooterGame.ShooterGameMode' },
  GlobalItemDecompositionTimeMultiplier:       { file: 'gameIni', section: '/Script/ShooterGame.ShooterGameMode' },
  CropGrowthSpeedMultiplier:                   { file: 'gameIni', section: '/Script/ShooterGame.ShooterGameMode' },
  CropDecaySpeedMultiplier:                    { file: 'gameIni', section: '/Script/ShooterGame.ShooterGameMode' },
  FishingLootQualityMultiplier:                { file: 'gameIni', section: '/Script/ShooterGame.ShooterGameMode' },
  ItemStackSizeMultiplier:                     { file: 'gameIni', section: '/Script/ShooterGame.ShooterGameMode' },

  // ── Statistiques joueurs / dinos (Game.ini) ──────────────────────────────────
  'PerLevelStatsMultiplier_Player[0]':         { file: 'gameIni', section: '/Script/ShooterGame.ShooterGameMode' },
  'PerLevelStatsMultiplier_DinoWild[0]':       { file: 'gameIni', section: '/Script/ShooterGame.ShooterGameMode' },
  'PerLevelStatsMultiplier_DinoTamed[0]':      { file: 'gameIni', section: '/Script/ShooterGame.ShooterGameMode' },

  // ── Paramètres serveur (GameUserSettings.ini) ───────────────────────────────
  TamingSpeedMultiplier:                       { file: 'gameUserSettings', section: 'ServerSettings' },
  HarvestAmountMultiplier:                     { file: 'gameUserSettings', section: 'ServerSettings' },
  XPMultiplier:                                { file: 'gameUserSettings', section: 'ServerSettings' },
  PlayerDamageMultiplier:                      { file: 'gameUserSettings', section: 'ServerSettings' },
  DinoDamageMultiplier:                        { file: 'gameUserSettings', section: 'ServerSettings' },
  DinoResistanceMultiplier:                    { file: 'gameUserSettings', section: 'ServerSettings' },
  PlayerResistanceMultiplier:                  { file: 'gameUserSettings', section: 'ServerSettings' },
  ResourcesRespawnPeriodMultiplier:            { file: 'gameUserSettings', section: 'ServerSettings' },
  NightTimeSpeedScale:                         { file: 'gameUserSettings', section: 'ServerSettings' },
  DayTimeSpeedScale:                           { file: 'gameUserSettings', section: 'ServerSettings' },
  OverrideOfficialDifficulty:                  { file: 'gameUserSettings', section: 'ServerSettings' },
  DifficultyOffset:                            { file: 'gameUserSettings', section: 'ServerSettings' },
  OxygenSwimSpeedStatMultiplier:               { file: 'gameUserSettings', section: 'ServerSettings' },
  TheMaxStructuresInRange:                     { file: 'gameUserSettings', section: 'ServerSettings' },
  AutoSavePeriodMinutes:                       { file: 'gameUserSettings', section: 'ServerSettings' },
  KickIdlePlayersPeriod:                       { file: 'gameUserSettings', section: 'ServerSettings' },
  MaxTribeLogs:                                { file: 'gameUserSettings', section: 'ServerSettings' },
  MaxNumberOfPlayersInTribe:                   { file: 'gameUserSettings', section: 'ServerSettings' },
  RaidDinoCharacterFoodDrainMultiplier:        { file: 'gameUserSettings', section: 'ServerSettings' },
  DinoCharacterFoodDrainMultiplier:            { file: 'gameUserSettings', section: 'ServerSettings' },
  PlayerCharacterFoodDrainMultiplier:          { file: 'gameUserSettings', section: 'ServerSettings' },
  PlayerCharacterWaterDrainMultiplier:         { file: 'gameUserSettings', section: 'ServerSettings' },
  PlayerCharacterStaminaDrainMultiplier:       { file: 'gameUserSettings', section: 'ServerSettings' },
  PlayerCharacterHealthRecoveryMultiplier:     { file: 'gameUserSettings', section: 'ServerSettings' },
  DinoCharacterHealthRecoveryMultiplier:       { file: 'gameUserSettings', section: 'ServerSettings' },
  StructureDamageMultiplier:                   { file: 'gameUserSettings', section: 'ServerSettings' },
  StructureResistanceMultiplier:               { file: 'gameUserSettings', section: 'ServerSettings' },
  HarvestHealthMultiplier:                     { file: 'gameUserSettings', section: 'ServerSettings' },
  PvPStructureDecay:                           { file: 'gameUserSettings', section: 'ServerSettings' },
  DisableStructureDecayPvE:                    { file: 'gameUserSettings', section: 'ServerSettings' },
  AllowThirdPersonPlayer:                      { file: 'gameUserSettings', section: 'ServerSettings' },
  ShowMapPlayerLocation:                       { file: 'gameUserSettings', section: 'ServerSettings' },
  EnablePVPGamma:                              { file: 'gameUserSettings', section: 'ServerSettings' },
  ServerHardcore:                              { file: 'gameUserSettings', section: 'ServerSettings' },
  ServerPVE:                                   { file: 'gameUserSettings', section: 'ServerSettings' },
};

async function listFiles(serviceId, dir) {
  // Nitrado utilise "path" comme paramètre (pas "dir") — confirmé par debug brut
  const res = await client().get(`/services/${serviceId}/gameservers/file_server/list`, {
    params: { path: dir },
  });
  const raw = res.data;
  console.log(`[Nitrado listFiles] ${serviceId} "${dir}": entries=${raw?.data?.entries?.length ?? 'undefined'}`);
  return raw?.data?.entries || [];
}

// Retourne la réponse brute complète de list pour debug (teste dir et path)
async function listFilesRaw(serviceId, dir) {
  try {
    const res = await client().get(`/services/${serviceId}/gameservers/file_server/list`, {
      params: { path: dir },
    });
    return { httpStatus: res.status, body: res.data };
  } catch (err) {
    return { httpStatus: err.response?.status, body: err.response?.data, error: err.message };
  }
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

// Version qui retourne { found, basePath, gameDir } pour l'upload multi-format
async function discoverConfigDirFull(serviceId) {
  const results = await discoverConfigDirVerbose(serviceId);
  return { found: results.found || null, basePath: results.basePath || null, gameDir: results.gameRoot || null };
}

// Extrait le chemin base FTP à partir des entrées racine.
// Exemple : entry.path="/games/ni9697515_2/ftproot/arksa", entry.name="arksa"
//           → basePath="/games/ni9697515_2/ftproot"
function extractFtpBasePath(rootEntries) {
  for (const entry of rootEntries) {
    if (entry.path && entry.name) {
      const suffix = '/' + entry.name;
      const idx = entry.path.lastIndexOf(suffix);
      if (idx >= 0) return entry.path.slice(0, idx) || '/';
    }
  }
  return null;
}

// Version verbose qui retourne le détail de chaque tentative (pour le diagnostic)
// CLÉ : Nitrado retourne TOUJOURS les entrées racine pour les chemins relatifs comme "/arksa".
//       Il faut utiliser les CHEMINS SYSTÈME COMPLETS extraits du champ .path des entrées.
//       Exemple : pour lister arksa/, on passe path="/games/ni9697515_2/ftproot/arksa"
//       Le chemin retourné (found) est utilisé pour upload ET mkdir.
async function discoverConfigDirVerbose(serviceId) {
  const attempts = [];
  let rootEntries = [];
  let rootError = null;

  // ── ÉTAPE 1 : Listing racine pour trouver le chemin système du dossier jeu ────
  try {
    rootEntries = await listFiles(serviceId, '/');
    console.log(`[Nitrado discover] ${serviceId} "/": ${rootEntries.length} entrées`);

    // Extrait le chemin FTP base (ex: /games/ni9697515_2/ftproot)
    const basePath = extractFtpBasePath(rootEntries);
    console.log(`[Nitrado discover] ${serviceId} basePath="${basePath}"`);

    const gameDirs = rootEntries.filter(e => e.type === 'dir');
    for (const gameDir of gameDirs) {
      // Chemin système complet du dossier jeu (ex: /games/ni9697515_2/ftproot/arksa)
      const gameSysPath = gameDir.path || (basePath ? `${basePath}/${gameDir.name}` : null);
      if (!gameSysPath) continue;

      const suffixCandidates = [
        'ShooterGame/Saved/Config/WindowsServer',
        'ShooterGame/Saved/Config/WinServer',
        'ShooterGame/Saved/Config/LinuxServer',
        'ShooterGame/Saved/Config/WindowsNoEditor',
        'ShooterGame/Saved/Config',
      ];

      for (const suffix of suffixCandidates) {
        // Chemin système complet — Nitrado ignore les chemins relatifs
        const fullPath = `${gameSysPath}/${suffix}`;
        try {
          const entries = await listFiles(serviceId, fullPath);
          const hasIni = entries.some(e => e.name?.endsWith('.ini'));
          console.log(`[Nitrado discover] ${serviceId} "${fullPath}": ${entries.length} entrées, ini=${hasIni}`);
          attempts.push({ path: fullPath, status: 'ok', count: entries.length, hasIni, entries });
          if (hasIni) return { found: fullPath, gameRoot: gameDir.name, entries, attempts, rootEntries, basePath, note: 'ini_found' };
          if (entries.length > 0) {
            // Vérifie que ce n'est pas un faux-positif (même contenu que root = ignoré)
            const isRootRepeat = entries.length === rootEntries.length &&
              entries.every((e, i) => rootEntries[i] && e.name === rootEntries[i].name);
            if (!isRootRepeat) {
              return { found: fullPath, gameRoot: gameDir.name, entries, attempts, rootEntries, basePath, note: 'has_content' };
            }
          }
        } catch (err) {
          const status = err.response?.status;
          const msg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
          console.log(`[Nitrado discover] ${serviceId} "${fullPath}": HTTP ${status} — ${msg}`);
          attempts.push({ path: fullPath, status: 'error', httpStatus: status, error: msg });
        }
      }

      // Aucun suffix accessible → retourne le chemin WindowsServer complet par défaut
      const defaultPath = `${gameSysPath}/ShooterGame/Saved/Config/WindowsServer`;
      console.log(`[Nitrado discover] ${serviceId} "${gameDir.name}" → défaut: ${defaultPath}`);
      return { found: defaultPath, gameRoot: gameDir.name, basePath, entries: [], attempts, rootEntries, note: 'game_root_found_empty' };
    }
  } catch (err) {
    rootError = `HTTP ${err.response?.status} — ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`;
    console.log(`[Nitrado discover] ${serviceId} "/": ${rootError}`);
  }

  // ── ÉTAPE 2 : Fallback chemins relatifs classiques ────────────────────────────
  for (const candidate of CONFIG_PATH_CANDIDATES) {
    try {
      const entries = await listFiles(serviceId, candidate);
      const hasIni = entries.some(e => e.name?.endsWith('.ini'));
      console.log(`[Nitrado discover] ${serviceId} "${candidate}" (fallback): ${entries.length} entrées`);
      attempts.push({ path: candidate, status: 'ok', count: entries.length, hasIni, entries });
      if (hasIni) return { found: candidate, entries, attempts, note: 'fallback_ini_found' };
    } catch (err) {
      attempts.push({ path: candidate, status: 'error', error: err.message });
    }
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

async function writeFile(serviceId, filePath, content, opts = {}) {
  const FormData = require('form-data');
  const nodePath = require('path');
  const tok = getToken();
  const dir = nodePath.dirname(filePath);
  const filename = nodePath.basename(filePath);
  const { basePath, gameDir } = opts;

  // ── ÉTAPE 1 : Créer le répertoire final (WindowsServer) via mkdir prouvé ──
  // Deux tentatives : avec chemin système complet ET avec chemin FTP relatif
  const mkdirAttempts = [];
  if (basePath && gameDir) {
    // Chemin système complet (format PROUVÉ par les tests mkdir)
    mkdirAttempts.push({ parent: nodePath.dirname(dir), name: nodePath.basename(dir) });
  }
  // Chemin relatif FTP (au cas où)
  mkdirAttempts.push({ parent: nodePath.dirname(dir.replace(basePath || '', '') || dir), name: nodePath.basename(dir) });

  for (const attempt of mkdirAttempts) {
    const r = await mkdir(serviceId, `${attempt.parent}/${attempt.name}`);
    console.log(`[Nitrado writeFile] mkdir "${attempt.parent}" + "${attempt.name}": ${r.ok ? '✅' : `⚠️ ${r.error}`}`);
  }

  // Petit délai pour laisser le FS se mettre à jour après mkdir
  await new Promise(r => setTimeout(r, 1000));

  // ── ÉTAPE 2 : Upload — essaie plusieurs formats jusqu'au premier succès ────
  // Priorité : FTP-relatif (sans basePath) en premier, puis système complet
  const uploadFormats = [];

  if (basePath && gameDir) {
    // FTP-relatif = filePath sans le basePath prefix
    const ftpFilePath = filePath.startsWith(basePath) ? filePath.slice(basePath.length) : `/${gameDir}${filePath.slice(filePath.indexOf(`/${gameDir}`))}`;
    const ftpDir = nodePath.dirname(ftpFilePath);

    uploadFormats.push(
      // Format 1 : FTP-relatif, path=dir, filename dans multipart  ← PROBABLEMENT CORRECT
      { label: 'ftp-dir',      path: ftpDir,     useFilename: true  },
      // Format 2 : FTP-relatif, path=fullpath, pas de filename
      { label: 'ftp-full',     path: ftpFilePath, useFilename: false },
      // Format 3 : Système, path=dir, filename dans multipart
      { label: 'sys-dir',      path: dir,         useFilename: true  },
      // Format 4 : Système, path=fullpath, pas de filename
      { label: 'sys-full',     path: filePath,    useFilename: false },
    );
  } else {
    uploadFormats.push(
      { label: 'default-dir',  path: dir,         useFilename: true  },
      { label: 'default-full', path: filePath,    useFilename: false },
    );
  }

  let lastErr;
  for (const fmt of uploadFormats) {
    try {
      const form = new FormData();
      form.append('path', fmt.path);
      if (fmt.useFilename) {
        form.append('file', Buffer.from(content, 'utf8'), { filename });
      } else {
        form.append('file', Buffer.from(content, 'utf8'));
      }
      console.log(`[Nitrado writeFile] Upload [${fmt.label}] path="${fmt.path}" useFilename=${fmt.useFilename} (${content.length} octets)`);
      const res = await axios.post(
        `${BASE_URL}/services/${serviceId}/gameservers/file_server/upload`,
        form,
        { headers: { Authorization: `Bearer ${tok}`, ...form.getHeaders() }, timeout: 30000 }
      );
      console.log(`[Nitrado writeFile] ✅ OK [${fmt.label}] — HTTP ${res.status}:`, JSON.stringify(res.data).slice(0, 200));
      return { ...res.data, _formatUsed: fmt.label };
    } catch (err) {
      const status = err.response?.status;
      const body = err.response?.data;
      const msg = (typeof body === 'object' ? JSON.stringify(body) : body) || err.message;
      console.warn(`[Nitrado writeFile] ❌ [${fmt.label}] HTTP ${status}: ${msg}`);
      lastErr = new Error(`HTTP ${status}: ${msg}`);
    }
  }

  // Tous les formats ont échoué
  throw lastErr;
}

/**
 * Tentative d'upload unique ultra-rapide — uniquement format sys-full (chemin système absolu).
 * C'est le seul format qui TROUVE les fichiers ini existants ("Permission denied" vs "not exist").
 * Retourne { ok, error } sans jamais throw — conçu pour le polling rapide pendant un restart.
 */
async function writeFileSysFullOnce(serviceId, filePath, content) {
  const FormData = require('form-data');
  const tok = getToken();
  try {
    const form = new FormData();
    form.append('path', filePath); // Chemin système absolu complet (ex: /games/.../GameUserSettings.ini)
    form.append('file', Buffer.from(content, 'utf8'));
    const res = await axios.post(
      `${BASE_URL}/services/${serviceId}/gameservers/file_server/upload`,
      form,
      { headers: { Authorization: `Bearer ${tok}`, ...form.getHeaders() }, timeout: 8000 }
    );
    return { ok: true, status: res.status, data: res.data };
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    const msg = (typeof body === 'object' ? JSON.stringify(body) : body) || err.message;
    // Log détaillé pour HTTP 500 : chemin + taille contenu + corps réponse
    if (status === 500) {
      console.warn(`[Nitrado writeFileSysFullOnce] HTTP 500 — path="${filePath}" contentLen=${content.length} resp=${JSON.stringify(msg).slice(0, 200)}`);
    }
    return { ok: false, status, error: msg };
  }
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
  // Suppression du BOM UTF-8 éventuel en tête de fichier
  const cleaned = content.startsWith('\uFEFF') ? content.slice(1) : content;
  const lines = cleaned.split(/\r?\n/); // gère \r\n (Windows) ET \n (Unix)
  const normalizedVal = normalizeValue(String(value));
  const sectionHeader = `[${section}]`;

  const sectionHeaderLower = sectionHeader.toLowerCase();

  // Passe 1 : cherche la clé dans TOUTES les occurrences de la section
  // (ARK Game.ini peut avoir plusieurs blocs [/Script/ShooterGame.ShooterGameMode])
  // Comparaison insensible à la casse : ARK génère parfois [/script/shootergame.shootergamemode]
  let inSection = false;
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      inSection = (trimmed.toLowerCase() === sectionHeaderLower);
    }
    if (inSection && (trimmed.toLowerCase().startsWith(key.toLowerCase() + '=') || trimmed.toLowerCase().startsWith(key.toLowerCase() + ' ='))) {
      lines[i] = `${key}=${normalizedVal}`;
      found = true;
      break; // remplace uniquement la première occurrence trouvée
    }
  }

  if (!found) {
    // Passe 2 : clé absente — trouve la DERNIÈRE occurrence de la section
    let lastSectionIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.toLowerCase() === sectionHeaderLower) lastSectionIdx = i;
    }

    if (lastSectionIdx === -1) {
      // Section absente : on la crée en fin de fichier
      if (lines[lines.length - 1] !== '') lines.push('');
      lines.push(sectionHeader);
      lines.push(`${key}=${normalizedVal}`);
    } else {
      // Insère à la fin du dernier bloc de la section
      let insertAt = lastSectionIdx + 1;
      for (let i = lastSectionIdx + 1; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
          insertAt = i;
          break;
        }
        insertAt = i + 1;
      }
      lines.splice(insertAt, 0, `${key}=${normalizedVal}`);
    }
  }

  return lines.join('\n');
}

/**
 * Lit un fichier INI, modifie une clé, réécrit le fichier.
 * Crée le répertoire parent automatiquement si nécessaire.
 */
async function updateIniKey(serviceId, filePath, section, key, value, opts = {}) {
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
  await writeFile(serviceId, filePath, updated, opts);
  console.log(`[Nitrado INI] ✅ Clé ${key}=${value} écrite dans ${filePath}`);
  return { updated: true };
}

// Cache par serviceId pour éviter de redécouvrir à chaque appel
// Stocke { configDir, basePath, gameDir }
const _configDirCache = {};

// Vide le cache de découverte (appelé manuellement depuis le dashboard ou au redémarrage)
function clearConfigDirCache(serviceId) {
  if (serviceId) {
    delete _configDirCache[serviceId];
  } else {
    Object.keys(_configDirCache).forEach(k => delete _configDirCache[k]);
  }
}

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
  let cached = _configDirCache[serviceId];
  let configDir = cached?.configDir || (typeof cached === 'string' ? cached : null);
  let basePath  = cached?.basePath  || null;
  let gameDir   = cached?.gameDir   || null;

  // 2. Sinon, découvre le bon répertoire
  if (!configDir) {
    console.log(`[Nitrado INI] Découverte du répertoire config pour ${serviceId}…`);
    const disc = await discoverConfigDirFull(serviceId);
    configDir = disc.found;
    basePath  = disc.basePath;
    gameDir   = disc.gameDir;
    if (configDir) {
      _configDirCache[serviceId] = { configDir, basePath, gameDir };
      console.log(`[Nitrado INI] ✅ Répertoire trouvé: ${configDir} (basePath=${basePath}, gameDir=${gameDir})`);
    } else {
      // Fallback : utiliser le chemin par défaut et laisser mkdir créer le répertoire
      configDir = nodePath.dirname(ARK_PATHS[map.file]);
      console.warn(`[Nitrado INI] Aucun répertoire trouvé, utilisation du défaut: ${configDir}`);
    }
  }

  const filePath = `${configDir}/${filename}`;
  return updateIniKey(serviceId, filePath, map.section, key, value, { basePath, gameDir });
}

/**
 * Prépare les contenus ini en mémoire pour plusieurs clés/valeurs sans écrire.
 * Retourne { writes, skipped } où :
 *   writes  = [{ serviceId, filePath, content }] prêts pour writeFileSysFullOnce
 *   skipped = [{ serviceId?, key?, reason }] erreurs explicites (configDir manquant, clé non mappée, etc.)
 * Ne retourne JAMAIS silencieusement un tableau vide sans raison dans skipped.
 */
async function prepareIniWrites(serviceIds, keyValuePairs, ftpMap = {}, dbg = null) {
  const nodePath = require('path');
  const pendingWrites = {}; // key: "${serviceId}::${filePath}", value: { serviceId, filePath, content }
  const skipped = [];

  // Vérifie d'abord que toutes les clés sont mappées
  for (const { key } of keyValuePairs) {
    if (!INI_KEY_MAP[key]) {
      skipped.push({ key, reason: `Clé "${key}" absente de INI_KEY_MAP — fichier et section inconnus` });
    }
  }

  for (const id of serviceIds) {
    // Découverte (avec cache) du répertoire config
    let cached = _configDirCache[id];
    let configDir = cached?.configDir || (typeof cached === 'string' ? cached : null);
    let basePath  = cached?.basePath  || null;
    let gameDir   = cached?.gameDir   || null;

    if (!configDir) {
      try {
        const disc = await discoverConfigDirFull(id);
        configDir = disc.found;
        basePath  = disc.basePath;
        gameDir   = disc.gameDir;
        if (configDir) _configDirCache[id] = { configDir, basePath, gameDir };
      } catch (e) {
        skipped.push({ serviceId: id, reason: `Découverte répertoire config échouée: ${e.message}` });
      }
    }

    if (!configDir) {
      skipped.push({ serviceId: id, reason: 'Répertoire config introuvable (aucun chemin découvert)' });
      continue;
    }

    // Groupe les clés par fichier, puis lit et modifie le contenu
    for (const { key, value } of keyValuePairs) {
      const map = INI_KEY_MAP[key];
      if (!map) continue; // déjà enregistré dans skipped plus haut

      const filename = nodePath.basename(ARK_PATHS[map.file]);
      const filePath = `${configDir}/${filename}`;
      const cacheKey = `${id}::${filePath}`;

      // Lit le contenu si pas encore chargé pour ce fichier
      if (!pendingWrites[cacheKey]) {
        let content = '';

        // 1. Tentative lecture via API Nitrado
        try { content = await readFile(id, filePath); } catch {}

        // 2. Si l'API retourne vide (permission ou autre), fallback lecture FTP
        if (!content.trim() && ftpMap[id]) {
          const ftpPath = getFtpPath(id, filePath);
          if (dbg) dbg(`  🔍 [DEBUG] API vide → lecture FTP : ${ftpPath}`);
          content = await readFileFtp(ftpMap[id], ftpPath);
          if (content.trim()) {
            if (dbg) dbg(`  🔍 [DEBUG] FTP OK — ${content.length} octets lus`);
          } else {
            if (dbg) dbg(`  🔍 [DEBUG] ⚠️ FTP vide aussi — fichier sera créé from scratch`);
          }
        } else if (content.trim()) {
          if (dbg) dbg(`  🔍 [DEBUG] API OK — ${content.length} octets lus`);
        }

        // Aperçu lignes pour diagnostiquer la section
        if (dbg && content.trim()) {
          const sampleLines = content.split(/\r?\n/).slice(0, 5).map(l => `    "${l}"`).join('\n');
          dbg(`  🔍 [DEBUG] Premières lignes du fichier :\n${sampleLines}`);
        }

        pendingWrites[cacheKey] = { serviceId: id, filePath, content };
      }

      // Applique la modification en mémoire
      const beforeContent = pendingWrites[cacheKey].content;
      pendingWrites[cacheKey].content = setIniKey(pendingWrites[cacheKey].content, map.section, key, value);

      // Diagnostic : vérifie si la clé a été trouvée/remplacée ou ajoutée
      if (dbg) {
        const after = pendingWrites[cacheKey].content;
        const countBefore = (beforeContent.match(new RegExp(key.replace(/[[\]]/g, '\\$&') + '=', 'g')) || []).length;
        const countAfter  = (after.match(new RegExp(key.replace(/[[\]]/g, '\\$&') + '=', 'g')) || []).length;
        if (countBefore > 0 && countAfter === countBefore) {
          dbg(`  🔍 [DEBUG] "${key}" remplacé en place (${countBefore} occurrence(s)) ✅`);
        } else if (countBefore === 0 && countAfter === 1) {
          dbg(`  🔍 [DEBUG] "${key}" absent → ajouté dans la section`);
        } else if (countAfter > countBefore) {
          dbg(`  🔍 [DEBUG] ⚠️ "${key}" DUPLIQUÉ : ${countBefore} avant → ${countAfter} après`);
        }
      }
    }
  }

  return { writes: Object.values(pendingWrites), skipped };
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

// ── Écriture fichier via FTP direct ──────────────────────────────────────────

/**
 * Retourne le chemin FTP relatif au root FTP Nitrado à partir du chemin système complet.
 * Ex: fullPath="/games/ni9697515_2/ftproot/arksa/Game.ini"
 *     basePath="/games/ni9697515_2/ftproot"
 *   → ftpPath="/arksa/Game.ini"
 * Si basePath inconnu, retourne fullPath tel quel.
 */
function getFtpPath(serviceId, fullSystemPath) {
  const cached = _configDirCache[serviceId];
  const basePath = cached?.basePath || null;
  if (basePath && fullSystemPath.startsWith(basePath)) {
    return fullSystemPath.slice(basePath.length) || '/';
  }
  return fullSystemPath;
}

/**
 * Lit un fichier via FTP direct.
 * Utilisé en fallback quand l'API Nitrado retourne vide (même problème de permission).
 * @param {object} ftpConfig  { host, port, user, password, secure }
 * @param {string} ftpPath    Chemin FTP relatif ex: /arksa/ShooterGame/Saved/Config/WindowsServer/Game.ini
 * @returns {string} contenu du fichier, ou '' si erreur
 */
async function readFileFtp(ftpConfig, ftpPath) {
  const ftp = require('basic-ftp');
  const { Writable } = require('stream');

  if (!ftpConfig?.host || !ftpConfig?.user || !ftpConfig?.password) return '';

  const client = new ftp.Client();
  client.ftp.verbose = false;

  try {
    await client.access({
      host: ftpConfig.host,
      port: parseInt(ftpConfig.port) || 21,
      user: ftpConfig.user,
      password: ftpConfig.password,
      secure: ftpConfig.secure === true || ftpConfig.secure === 'true',
      secureOptions: { rejectUnauthorized: false },
    });

    const chunks = [];
    const writable = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
    });

    await client.downloadTo(writable, ftpPath);
    const content = Buffer.concat(chunks).toString('utf8');
    console.log(`[FTP read] ✅ ${ftpPath} (${content.length} octets)`);
    return content;
  } catch (err) {
    console.warn(`[FTP read] ⚠️ ${ftpPath} : ${err.message}`);
    return '';
  } finally {
    client.close();
  }
}

/**
 * Écrit un fichier via FTP direct sur le serveur Nitrado.
 * Contourne les restrictions de l'API Nitrado (Permission denied).
 * @param {object} ftpConfig  { host, port, user, password, secure }
 * @param {string} ftpPath    Chemin FTP relatif ex: /arksa/ShooterGame/Saved/Config/WindowsServer/Game.ini
 * @param {string} content    Contenu du fichier
 * @returns {{ ok, error }}
 */
async function writeFtpFile(ftpConfig, ftpPath, content) {
  const ftp = require('basic-ftp');
  const { Readable } = require('stream');
  const nodePath = require('path');

  if (!ftpConfig?.host || !ftpConfig?.user || !ftpConfig?.password) {
    return { ok: false, error: 'Credentials FTP incomplets (host/user/password requis)' };
  }

  const client = new ftp.Client();
  client.ftp.verbose = false;

  try {
    await client.access({
      host: ftpConfig.host,
      port: parseInt(ftpConfig.port) || 21,
      user: ftpConfig.user,
      password: ftpConfig.password,
      secure: ftpConfig.secure === true || ftpConfig.secure === 'true',
      secureOptions: { rejectUnauthorized: false },
    });

    const dir = nodePath.dirname(ftpPath);
    const filename = nodePath.basename(ftpPath);

    // Crée le répertoire si nécessaire
    try { await client.ensureDir(dir); } catch (e) {
      console.warn(`[FTP] ensureDir "${dir}" : ${e.message} — tentative d'écriture quand même`);
    }

    // Upload du contenu
    const buf = Buffer.from(content, 'utf8');
    const stream = Readable.from(buf);
    await client.uploadFrom(stream, filename);

    console.log(`[FTP] ✅ ${ftpPath} écrit (${buf.length} octets)`);
    return { ok: true };
  } catch (err) {
    console.error(`[FTP] ❌ ${ftpPath} : ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    client.close();
  }
}

// ── Vérification scopes du token ──────────────────────────────────────────────

/**
 * Vérifie les scopes/permissions du token NITRADO_TOKEN.
 * Appelle GET /token pour récupérer les grants et les services accessibles.
 * Retourne { ok, token, grants, services, hasFileserver, hasGameserver } ou { ok: false, error }.
 */
async function checkTokenScopes() {
  const tok = getToken();
  if (!tok) return { ok: false, error: 'NITRADO_TOKEN non configuré' };
  try {
    const res = await axios.get(`${BASE_URL}/token`, {
      headers: { Authorization: `Bearer ${tok}` },
      timeout: 10000,
    });
    const data = res.data?.data || res.data || {};
    // Nitrado renvoie les grants dans data.token.grants ou data.grants
    const tokenInfo = data.token || data;
    const rawGrants = tokenInfo.grants || tokenInfo.scopes || [];
    // Normalise : tableau direct, objet de type {scope: true}, ou chaîne CSV
    let grants;
    if (Array.isArray(rawGrants)) {
      grants = rawGrants;
    } else if (rawGrants && typeof rawGrants === 'object') {
      grants = Object.keys(rawGrants).filter(k => rawGrants[k]);
    } else if (typeof rawGrants === 'string' && rawGrants.length > 0) {
      grants = rawGrants.split(/[\s,]+/).filter(Boolean);
    } else {
      grants = [];
    }
    const services = tokenInfo.services || data.services || [];

    // Vérifie si les scopes critiques sont présents.
    // Nitrado Long-life tokens utilisent les scopes : service, service_order, rootserver, etc.
    // "service" couvre l'accès aux game servers (lecture/écriture fichiers + contrôle).
    const grantsLower = grants.map(g => String(g).toLowerCase());
    const hasService = grantsLower.some(g =>
      g.includes('service') || g.includes('fileserver') || g.includes('file_server') || g.includes('file-server')
    );
    const hasGameserver = grantsLower.some(g =>
      g.includes('service') || g.includes('gameserver') || g.includes('game_server') || g.includes('game-server')
    );
    // Alias pour compatibilité avec le reste du code
    const hasFileserver = hasService;

    return {
      ok: true,
      httpStatus: res.status,
      tokenInfo,
      grants,
      services,
      hasFileserver,
      hasGameserver,
      hasService,
      raw: res.data,
    };
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    const msg = (typeof body === 'object' ? JSON.stringify(body) : body) || err.message;
    return { ok: false, httpStatus: status, error: msg };
  }
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
  listFilesRaw,
  mkdir,
  mkdirRecursive,
  discoverConfigDir,
  discoverConfigDirVerbose,
  clearConfigDirCache,
  readFile,
  writeFile,
  writeFileSysFullOnce,
  prepareIniWrites,
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
  checkTokenScopes,
  writeFtpFile,
  getFtpPath,
  readFileFtp,
};
