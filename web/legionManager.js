const axios = require('axios');

const BASE_URL = 'https://gpanel.legionhosting.net/api/client';

// Liste approuvée après comparaison avec les 12 cartes GPanel. Le serveur d'essai
// (et tout futur serveur du compte) ne doit jamais recevoir d'action groupée.
const MAPS = Object.freeze([
  { id: '9e151580', name: 'Valguero' },
  { id: '7c110bf0', name: 'Genesis' },
  { id: '27d0aeff', name: 'Astraeos' },
  { id: 'd8d6185e', name: 'The Island' },
  { id: '8efe82b3', name: 'Ragnarok' },
  { id: '8e262f7c', name: 'Lost Colony' },
  { id: '686c087f', name: 'Aberration' },
  { id: '988af27d', name: 'Scorched Earth' },
  { id: 'e4d5b19e', name: 'Extinction' },
  { id: 'b59b0253', name: 'Map Event' },
  { id: '6c0e3a89', name: 'Svartalfheim' },
  { id: 'cf79fe13', name: 'The Center' },
]);
const MAP_IDS = new Set(MAPS.map(map => map.id));

function client() {
  if (!process.env.LEGION_CLIENT_API_KEY) throw new Error('Clé API client Legion non configurée');
  return axios.create({
    baseURL: BASE_URL,
    timeout: 15000,
    headers: {
      Authorization: `Bearer ${process.env.LEGION_CLIENT_API_KEY}`,
      Accept: 'application/json',
    },
  });
}

function assertMap(id) {
  if (!MAP_IDS.has(id)) throw new Error('Cette carte ne fait pas partie des 12 serveurs Legion autorisés');
}

function apiError(error) {
  if (error.response?.status === 401) return new Error('Clé API Legion refusée (401)');
  if (error.response?.status === 403) return new Error('Permission API Legion insuffisante (403)');
  return new Error(`GPanel : ${error.response?.status || error.message}`);
}

async function getServers() {
  try {
    const api = client();
    let page = 1;
    const all = [];
    do {
      const { data } = await api.get('/', { params: { page } });
      if (!Array.isArray(data.data)) throw new Error('Format de réponse GPanel inattendu');
      all.push(...data.data.map(item => item.attributes));
      if (page >= (data.meta?.pagination?.total_pages || 1)) break;
      page++;
    } while (page <= 20);

    const byId = new Map(all.map(server => [server.identifier, server]));
    const missing = MAPS.filter(map => !byId.has(map.id));
    if (missing.length) throw new Error(`Cartes Legion introuvables : ${missing.map(map => map.name).join(', ')}`);

    return Promise.all(MAPS.map(async map => {
      const server = byId.get(map.id);
      try {
        const { data } = await api.get(`/servers/${map.id}/resources`);
        const attributes = data.attributes || {};
        return {
          ...map,
          state: attributes.is_suspended ? 'suspended' : (attributes.current_state || 'unknown'),
          cpu: attributes.resources?.cpu_absolute ?? null,
          memory: attributes.resources?.memory_bytes ?? null,
          disk: attributes.resources?.disk_bytes ?? null,
          uptime: attributes.resources?.uptime ?? null,
          memoryLimit: server.limits?.memory ?? null,
          resourceError: null,
        };
      } catch (error) {
        return { ...map, state: 'unknown', cpu: null, memory: null, disk: null, uptime: null,
          memoryLimit: server.limits?.memory ?? null, resourceError: apiError(error).message };
      }
    }));
  } catch (error) {
    if (error.response) throw apiError(error);
    throw error;
  }
}

async function power(id, signal) {
  assertMap(id);
  if (!['start', 'stop', 'restart'].includes(signal)) throw new Error('Action non autorisée');
  try {
    await client().post(`/servers/${id}/power`, { signal });
  } catch (error) {
    throw apiError(error);
  }
}

async function wipeWildDinos(id) {
  assertMap(id);
  try {
    // La console GPanel exécute les commandes administrateur ARK. Une réponse
    // 204 signifie que la commande a été acceptée, pas que le wipe est terminé.
    await client().post(`/servers/${id}/command`, { command: 'cheat DestroyWildDinos' });
  } catch (error) {
    throw apiError(error);
  }
}

async function getActivity(id) {
  assertMap(id);
  try {
    const api = client();
    const first = (await api.get(`/servers/${id}/activity`)).data;
    const lastPage = first.meta?.pagination?.total_pages || 1;
    const last = lastPage > 1 ? (await api.get(`/servers/${id}/activity`, { params: { page: lastPage } })).data : first;
    return (last.data || []).map(item => {
      const a = item.attributes || {};
      return { id: a.id, event: a.event, timestamp: a.timestamp,
        // Ne jamais renvoyer les autres commandes console ni leurs paramètres.
        isWildWipe: a.event === 'server:console.command' &&
          /^(?:cheat |admincheat )?DestroyWildDinos$/i.test(String(a.properties?.command || '').trim()) };
    }).filter(a => /^server:power\.(restart|stop|start)$/.test(a.event) || a.isWildWipe);
  } catch (error) {
    throw apiError(error);
  }
}

module.exports = { MAPS, getServers, power, wipeWildDinos, getActivity, assertMap };