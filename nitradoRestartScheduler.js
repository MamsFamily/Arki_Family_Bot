const cron       = require('node-cron');
const pgStore    = require('./pgStore');
const nitrado    = require('./web/nitradoManager');

const STORE_KEY  = 'nitrado_restart_schedules';
const jobs       = new Map(); // id → [cron.Task, ...]

const WARN_OFFSETS = [30, 15, 5, 1]; // minutes avant le redémarrage

// ── Helpers ────────────────────────────────────────────────────────────────
function timeOffset(h, m, offsetMin) {
  let total = h * 60 + m - offsetMin;
  if (total < 0) total += 1440;
  return { h: Math.floor(total / 60), m: total % 60 };
}

function warnMessage(minutes) {
  if (minutes === 1)  return 'Broadcast ⚠️ REDÉMARRAGE dans 1 minute ! Sauvegardez vite !';
  if (minutes === 5)  return 'Broadcast ⏳ Redémarrage dans 5 minutes.';
  if (minutes === 15) return 'Broadcast 🔔 Redémarrage dans 15 minutes.';
  return `Broadcast 🔔 Redémarrage dans ${minutes} minutes.`;
}

async function resolveIds(serverIds) {
  if (serverIds && serverIds.length) return serverIds;
  const services = await nitrado.getServices();
  return services.map(s => s.id);
}

// ── Persistance ───────────────────────────────────────────────────────────
async function getAll() {
  const raw = await pgStore.getData(STORE_KEY, null);
  if (!raw) return [];
  return Array.isArray(raw) ? raw : JSON.parse(raw);
}

async function saveAll(list) {
  await pgStore.setData(STORE_KEY, list);
}

// ── Gestion des jobs ──────────────────────────────────────────────────────
function stopJobs(id) {
  const existing = jobs.get(id);
  if (existing) { existing.forEach(j => j.stop()); jobs.delete(id); }
}

function scheduleOne(sched) {
  stopJobs(sched.id);
  if (!sched.active) return;

  const [hStr, mStr] = sched.heure.split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  const taskList = [];

  // Avertissements
  if (sched.avertissements !== false) {
    for (const offset of WARN_OFFSETS) {
      const { h: wh, m: wm } = timeOffset(h, m, offset);
      const expr = `${wm} ${wh} * * *`;
      if (!cron.validate(expr)) continue;
      const task = cron.schedule(expr, async () => {
        try {
          const ids = await resolveIds(sched.serverIds);
          await nitrado.sendRconToMany(ids, warnMessage(offset));
        } catch (e) { console.error(`[RestartSched] warn ${offset}min: ${e.message}`); }
      }, { timezone: 'Europe/Paris' });
      taskList.push(task);
    }
  }

  // Redémarrage principal
  const mainExpr = `${m} ${h} * * *`;
  if (cron.validate(mainExpr)) {
    const task = cron.schedule(mainExpr, async () => {
      try {
        const ids = await resolveIds(sched.serverIds);
        await nitrado.sendRconToMany(ids, 'SaveWorld');
        await new Promise(r => setTimeout(r, 5000));
        await nitrado.restartAll(ids, 'Redémarrage automatique programmé');

        // Enregistrer la date du dernier redémarrage
        const list = await getAll();
        const s = list.find(x => x.id === sched.id);
        if (s) { s.dernierRedemarrage = new Date().toISOString(); await saveAll(list); }
        console.log(`[RestartSched] ✅ Redémarrage "${sched.nom}" exécuté`);
      } catch (e) { console.error(`[RestartSched] restart error: ${e.message}`); }
    }, { timezone: 'Europe/Paris' });
    taskList.push(task);
  }

  jobs.set(sched.id, taskList);
}

// ── API publique ──────────────────────────────────────────────────────────

async function init() {
  if (!nitrado.getToken()) return;
  const list = await getAll();
  list.forEach(scheduleOne);
  console.log(`[RestartSched] ${list.length} planning(s) chargé(s)`);
}

async function create({ nom, heure, avertissements = true, serverIds = [] }) {
  if (!/^\d{2}:\d{2}$/.test(heure)) throw new Error('Format heure invalide (HH:MM requis)');
  const [h, m] = heure.split(':').map(Number);
  if (h > 23 || m > 59) throw new Error('Heure invalide');
  const sched = {
    id: Date.now().toString(),
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
  return sched;
}

async function remove(id) {
  stopJobs(id);
  const list = await getAll();
  const before = list.length;
  const filtered = list.filter(s => s.id !== id);
  if (filtered.length === before) throw new Error('Planning introuvable');
  await saveAll(filtered);
}

async function toggle(id) {
  const list = await getAll();
  const sched = list.find(s => s.id === id);
  if (!sched) throw new Error('Planning introuvable');
  sched.active = !sched.active;
  await saveAll(list);
  scheduleOne(sched);
  return sched;
}

async function runNow(id) {
  const list = await getAll();
  const sched = list.find(s => s.id === id);
  if (!sched) throw new Error('Planning introuvable');
  const ids = await resolveIds(sched.serverIds);
  await nitrado.sendRconToMany(ids, 'SaveWorld');
  await new Promise(r => setTimeout(r, 5000));
  const results = await nitrado.restartAll(ids, 'Redémarrage manuel immédiat');
  sched.dernierRedemarrage = new Date().toISOString();
  await saveAll(list);
  return results;
}

module.exports = { init, create, remove, toggle, runNow, getAll };
