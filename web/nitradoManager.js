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

async function getMods(serviceId) {
  // Sur Nitrado, les mods ARK SA sont dans les settings sous la clé 'mods' ou dans config
  const settings = await getSettings(serviceId);
  // Cherche dans toutes les catégories la clé 'mods' ou 'active_mods'
  for (const [, cat] of Object.entries(settings)) {
    if (typeof cat === 'object') {
      const raw = cat.mods?.value || cat.active_mods?.value || cat.ActiveMods?.value || '';
      if (raw !== undefined && raw !== '') {
        return raw.toString().split(',').map(s => s.trim()).filter(Boolean);
      }
    }
  }
  return [];
}

async function setMods(serviceId, modList) {
  // Met à jour la liste de mods dans les settings Nitrado
  const settings = await getSettings(serviceId);
  let categoryName = null;
  let keyName = null;

  for (const [cat, catVal] of Object.entries(settings)) {
    if (typeof catVal === 'object') {
      for (const key of ['mods', 'active_mods', 'ActiveMods']) {
        if (catVal[key] !== undefined) {
          categoryName = cat;
          keyName = key;
          break;
        }
      }
      if (categoryName) break;
    }
  }

  if (categoryName && keyName) {
    const payload = {};
    payload[categoryName] = {};
    payload[categoryName][keyName] = modList.join(',');
    return updateSettings(serviceId, payload);
  }

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

// ── RCON ─────────────────────────────────────────────────────────────────────

async function sendRcon(serviceId, command) {
  const res = await client().post(`/services/${serviceId}/gameservers/app_server/command`, { command });
  return res.data;
}

async function sendRconToMany(serviceIds, command) {
  const results = [];
  for (const id of serviceIds) {
    try {
      const data = await sendRcon(id, command);
      results.push({ id, ok: true, response: data?.data?.message || '' });
    } catch (e) {
      results.push({ id, ok: false, error: e.message });
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
  sendRconToMany,
};
