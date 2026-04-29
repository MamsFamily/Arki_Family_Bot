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
  const res = await client().post(`/services/${serviceId}/gameservers/start`);
  return res.data;
}

// ── Paramètres jeu ──────────────────────────────────────────────────────────

async function getSettings(serviceId) {
  const res = await client().get(`/services/${serviceId}/gameservers/settings`);
  return res.data?.data?.settings || {};
}

async function updateSettings(serviceId, settingsObj) {
  // settingsObj = { category: { key: value, ... }, ... }
  const res = await client().post(`/services/${serviceId}/gameservers/settings`, settingsObj);
  return res.data;
}

// ── Fichiers config ─────────────────────────────────────────────────────────

async function readFile(serviceId, filePath) {
  const res = await client().get(`/services/${serviceId}/gameservers/file`, {
    params: { file: filePath },
  });
  return res.data?.data?.token ? await downloadFile(res.data.data.token) : (res.data?.data?.content || '');
}

async function downloadFile(token) {
  // Nitrado retourne un token de téléchargement pour les gros fichiers
  const res = await axios.get(`${BASE_URL}/services/file_server/download`, {
    params: { token },
    responseType: 'text',
  });
  return res.data;
}

async function writeFile(serviceId, filePath, content) {
  // Upload via multipart form
  const FormData = require('form-data');
  const form = new FormData();
  form.append('path', require('path').dirname(filePath));
  form.append('file', Buffer.from(content, 'utf8'), { filename: require('path').basename(filePath) });

  const token = getToken();
  const res = await axios.post(`${BASE_URL}/services/${serviceId}/gameservers/file`, form, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...form.getHeaders(),
    },
    timeout: 20000,
  });
  return res.data;
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
    // Respecte le format : { value: "..." } si c'est un objet, sinon chaîne directe
    payload[categoryName][keyName] = (typeof entry === 'object' && entry !== null)
      ? modList.join(',')
      : modList.join(',');
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

async function updateSettingOnAll(serviceIds, category, key, value) {
  const results = [];
  for (const id of serviceIds) {
    try {
      const payload = {};
      payload[category] = {};
      payload[category][key] = value;
      await updateSettings(id, payload);
      results.push({ id, ok: true });
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
  readFile,
  writeFile,
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
