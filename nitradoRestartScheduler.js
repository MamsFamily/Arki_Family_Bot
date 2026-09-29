const cron = require('node-cron');
const axios = require('axios');
const crypto = require('crypto');
const pgStore = require('./pgStore');
const legion = require('./web/legionManager');
const legionJournal = require('./web/legionJournal');

// Historic Nitrado schedules are retained in their old key, but never run
// automatically. Only newly created, explicitly targeted Legion schedules run.
const STORE_KEY = 'legion_restart_schedules';
const GPanel_URL = 'https://gpanel.legionhosting.net/api/client';
const TIMEZONE = 'Europe/Paris';
const WARN_OFFSETS = [30, 15, 5, 1];
const jobs = new Map();
const knownSchedules = new Map();
const runningSchedules = new Set();
const runningMapIds = new Set();
let pollingTimer = null;

function timeOffset(h, m, offsetMin) {
  let total = h * 60 + m - offsetMin;
  if (total < 0) total += 1440;
  return { h: Math.floor(total / 60), m: total % 60 };
}

function warnMessage(minutes) {
  if (minutes === 1) return 'Broadcast ⚠️ REDÉMARRAGE dans 1 minute ! Sauvegardez vite !';
  if (minutes === 5) return 'Broadcast ⏳ Redémarrage dans 5 minutes.';
  if (minutes === 15) return 'Broadcast 🔔 Redémarrage dans 15 minutes.';
  return `Broadcast 🔔 Redémarrage dans ${minutes} minutes.`;
}

function validateIds(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > legion.MAPS.length ||
      ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) {
    throw new Error('Sélection de cartes invalide');
  }
  ids.forEach(legion.assertMap);
  return ids;
}

function resolveIds(serverIds) {
  return validateIds(serverIds);
}

function gpanelApi() {
  if (!process.env.LEGION_CLIENT_API_KEY) throw new Error('Clé API client Legion non configurée');
  return axios.create({
    baseURL: GPanel_URL,
    timeout: 15000,
    headers: {
      Authorization: `Bearer ${process.env.LEGION_CLIENT_API_KEY}`,
      Accept: 'application/json',
    },
  });
}

function gpanelError(error) {
  if (error.response?.status === 401) return new Error('Clé API Legion refusée (401)');
  if (error.response?.status === 403) return new Error('Permission API Legion insuffisante (403)');
  return new Error(`GPanel : ${error.response?.status || error.message}`);
}

async function sendConsoleCommand(mapId, command) {
  legion.assertMap(mapId);
  try {
    // GPanel attend la commande ARK nue : "SaveWorld" ou "Broadcast <message>".
    await gpanelApi().post(`/servers/${mapId}/command`, { command });
  } catch (error) {
    throw gpanelError(error);
  }
}

async function getAll() {
  const raw = await pgStore.getData(STORE_KEY, null);
  if (!raw) return [];
  return Array.isArray(raw) ? raw : JSON.parse(raw);
}

async function saveAll(list) {
  await pgStore.setData(STORE_KEY, list);
}

function stopJobs(id) {
  const existing = jobs.get(id);
  if (existing) {
    existing.forEach(task => task.stop());
    jobs.delete(id);
  }
}

function scheduleOne(sched) {
  stopJobs(sched.id);
  if (!sched.active) return;
  if (typeof sched.id !== 'string' || typeof sched.heure !== 'string' ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(sched.heure)) {
    console.error(`[RestartSched] Planning invalide ignoré : ${sched.nom || sched.id}`);
    return;
  }
  try {
    resolveIds(sched.serverIds);
  } catch (error) {
    // Les anciennes sélections Nitrado ne doivent jamais être réinterprétées comme des cartes Legion.
    console.error(`[RestartSched] Planning "${sched.nom}" ignoré : ${error.message}`);
    return;
  }

  const [h, m] = sched.heure.split(':').map(Number);
  const taskList = [];
  const taskOptions = { timezone: TIMEZONE, noOverlap: true };

  if (sched.avertissements !== false) {
    for (const offset of WARN_OFFSETS) {
      const { h: wh, m: wm } = timeOffset(h, m, offset);
      const expr = `${wm} ${wh} * * *`;
      if (!cron.validate(expr)) continue;
      taskList.push(cron.schedule(expr, async () => {
        try {
          const ids = resolveIds(sched.serverIds);
          const results = await Promise.allSettled(ids.map(id => sendConsoleCommand(id, warnMessage(offset))));
          results.forEach((result, index) => {
            if (result.status === 'rejected') {
              console.error(`[RestartSched] avertissement ${offset}min (${ids[index]}) : ${result.reason.message}`);
            }
          });
        } catch (error) {
          console.error(`[RestartSched] avertissement ${offset}min : ${error.message}`);
        }
      }, taskOptions));
    }
  }

  const mainExpr = `${m} ${h} * * *`;
  if (cron.validate(mainExpr)) {
    taskList.push(cron.schedule(mainExpr, async () => {
      try {
        await executeSchedule(sched, 'programme', `⏰ Planning : ${sched.nom}`, true);
      } catch (error) {
        console.error(`[RestartSched] redémarrage "${sched.nom}" : ${error.message}`);
      }
    }, taskOptions));
  }
  jobs.set(sched.id, taskList);
}

async function executeSchedule(sched, origin, actor, rejectOnFailure = false) {
  if (runningSchedules.has(sched.id)) {
    if (rejectOnFailure) throw new Error('Un redémarrage de ce planning est déjà en cours');
    console.warn(`[RestartSched] Exécution ignorée, planning déjà en cours : ${sched.nom}`);
    return [];
  }
  const ids = resolveIds(sched.serverIds);
  const overlap = ids.filter(id => runningMapIds.has(id));
  if (overlap.length) {
    if (rejectOnFailure) throw new Error(`Redémarrage déjà en cours pour : ${overlap.join(', ')}`);
    console.warn(`[RestartSched] Exécution ignorée, cartes déjà en cours : ${overlap.join(', ')}`);
    return [];
  }
  runningSchedules.add(sched.id);
  ids.forEach(id => runningMapIds.add(id));
  try {
    const saves = await Promise.all(ids.map(async id => {
      try {
        await sendConsoleCommand(id, 'SaveWorld');
        return { id, ok: true };
      } catch (error) {
        return { id, ok: false, error: error.message };
      }
    }));
    await new Promise(resolve => setTimeout(resolve, 5000));

    const results = await Promise.all(saves.map(async save => {
      if (!save.ok) return save;
      try {
        return await legionJournal.execute(save.id, 'restart', origin, actor);
      } catch (error) {
        return { id: save.id, ok: false, error: error.message };
      }
    }));
    const failed = results.filter(result => !result.ok);
    failed.forEach(result => {
      console.error(`[RestartSched] ${sched.nom} (${result.id}) : ${result.error || 'échec du redémarrage'}`);
    });
    if (results.some(result => result.ok)) {
      const list = await getAll();
      const stored = list.find(item => item.id === sched.id);
      if (stored) {
        stored.dernierRedemarrage = new Date().toISOString();
        await saveAll(list);
      }
    }
    if (failed.length) console.error(`[RestartSched] "${sched.nom}" : ${failed.length}/${results.length} carte(s) en échec`);
    else console.log(`[RestartSched] ✅ Redémarrage "${sched.nom}" exécuté`);
    return results;
  } finally {
    runningSchedules.delete(sched.id);
    ids.forEach(id => runningMapIds.delete(id));
  }
}

async function init() {
  const list = await getAll();
  for (const sched of list) {
    scheduleOne(sched);
    knownSchedules.set(sched.id, JSON.stringify(sched));
  }
  console.log(`[RestartSched] ${list.length} planning(s) chargé(s)`);
}

async function create({ nom, heure, avertissements = true, serverIds }) {
  if (typeof heure !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(heure)) {
    throw new Error('Format heure invalide (HH:MM requis)');
  }
  if (typeof nom !== 'string' || !nom.trim()) throw new Error('Nom du planning invalide');
  resolveIds(serverIds);
  const sched = {
    id: crypto.randomUUID(),
    nom,
    heure,
    avertissements,
    serverIds,
    active: true,
    dernierRedemarrage: null,
    createdAt: new Date().toISOString(),
  };
  const list = await getAll();
  list.push(sched);
  await saveAll(list);
  scheduleOne(sched);
  knownSchedules.set(sched.id, JSON.stringify(sched));
  return sched;
}

async function remove(id) {
  stopJobs(id);
  knownSchedules.delete(id);
  const list = await getAll();
  const filtered = list.filter(sched => sched.id !== id);
  if (filtered.length === list.length) throw new Error('Planning introuvable');
  await saveAll(filtered);
}

async function toggle(id) {
  const list = await getAll();
  const sched = list.find(item => item.id === id);
  if (!sched) throw new Error('Planning introuvable');
  if (!sched.active) resolveIds(sched.serverIds);
  sched.active = !sched.active;
  await saveAll(list);
  scheduleOne(sched);
  knownSchedules.set(sched.id, JSON.stringify(sched));
  return sched;
}

async function runNow(id) {
  const list = await getAll();
  const sched = list.find(item => item.id === id);
  if (!sched) throw new Error('Planning introuvable');
  return executeSchedule(sched, 'manuel', 'Redémarrage manuel immédiat', true);
}

async function poll() {
  try {
    const list = await getAll();
    const currentIds = new Set();
    for (const sched of list) {
      currentIds.add(sched.id);
      const fingerprint = JSON.stringify(sched);
      if (knownSchedules.get(sched.id) !== fingerprint) {
        scheduleOne(sched);
        knownSchedules.set(sched.id, fingerprint);
      }
    }
    for (const id of knownSchedules.keys()) {
      if (!currentIds.has(id)) {
        stopJobs(id);
        knownSchedules.delete(id);
      }
    }
  } catch (error) {
    console.error('[RestartSched] poll error:', error.message);
  }
}

function startPolling(intervalMs = 60000) {
  if (pollingTimer) return;
  pollingTimer = setInterval(poll, intervalMs);
}

module.exports = { init, create, remove, toggle, runNow, getAll, startPolling };
