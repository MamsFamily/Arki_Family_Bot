const legion = require('./legionManager');

const STATE_UNAVAILABLE = 'État GPanel indisponible';

function validateIds(ids) {
  if (!Array.isArray(ids)) throw new Error('Liste de cartes INI invalide');
  ids.forEach(id => legion.assertMap(id));
}

async function getMapOfflineStatus(id) {
  legion.assertMap(id);
  try {
    const serverState = await legion.getMapState(id);
    const offline = serverState === 'offline';
    return {
      serverState,
      offline,
      applySafe: offline,
      stateError: null,
    };
  } catch {
    return {
      serverState: 'unknown',
      offline: false,
      applySafe: false,
      stateError: STATE_UNAVAILABLE,
    };
  }
}

async function getMapsOfflineStatus(ids) {
  validateIds(ids);
  return Promise.all(ids.map(async id => ({
    id,
    ...await getMapOfflineStatus(id),
  })));
}

async function assertMapsOffline(ids) {
  const statuses = await getMapsOfflineStatus(ids);
  const blocked = statuses.filter(status => !status.applySafe);
  if (blocked.length) {
    const names = blocked.map(status => {
      const map = legion.MAPS.find(item => item.id === status.id);
      const state = status.stateError || status.serverState;
      return `${map.name} (${state})`;
    });
    const error = new Error(`Modification INI refusée : arrêt confirmé requis pour ${names.join(', ')}.`);
    error.status = 409;
    throw error;
  }
  return statuses;
}

module.exports = { getMapOfflineStatus, getMapsOfflineStatus, assertMapsOffline };