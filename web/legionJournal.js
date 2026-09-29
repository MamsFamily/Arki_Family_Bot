const cron = require('node-cron');
const crypto = require('crypto');
const pgStore = require('../pgStore');
const legion = require('./legionManager');

const TIMEZONE = 'Europe/Paris';
let started = false;
let schedulerStarted = false;
let checking = false;
let ready = false;

function db() {
  const pool = pgStore.getPool();
  if (!pool) throw new Error('PostgreSQL requis pour le journal et les planifications Legion');
  return pool;
}

function validateIds(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > legion.MAPS.length ||
      ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) {
    throw new Error('Sélection de cartes invalide');
  }
  ids.forEach(legion.assertMap);
  return ids;
}

async function init({ runSchedules = true } = {}) {
  const pool = db();
  await pool.query(`CREATE TABLE IF NOT EXISTS legion_map_events (
    id BIGSERIAL PRIMARY KEY,
    map_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    origin TEXT NOT NULL,
    status TEXT NOT NULL,
    actor TEXT NOT NULL,
    details TEXT,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS legion_events_recent ON legion_map_events (occurred_at DESC)');
  await pool.query(`CREATE TABLE IF NOT EXISTS legion_map_schedules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    event_type TEXT NOT NULL,
    command TEXT,
    time_of_day TEXT NOT NULL,
    map_ids JSONB NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query('ALTER TABLE legion_map_schedules ADD COLUMN IF NOT EXISTS command TEXT');
  await pool.query(`CREATE TABLE IF NOT EXISTS legion_schedule_runs (
    schedule_id TEXT NOT NULL,
    local_date TEXT NOT NULL,
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (schedule_id, local_date)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS legion_schedule_map_runs (
    schedule_id TEXT NOT NULL,
    local_date TEXT NOT NULL,
    map_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'en_cours',
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (schedule_id, local_date, map_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS legion_map_states (
    map_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    uptime_ms BIGINT,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query('ALTER TABLE legion_map_states ADD COLUMN IF NOT EXISTS uptime_ms BIGINT');
  if (!started) {
    started = true;
    cron.schedule('* * * * *', () => observeStates().catch(e => console.error('[Legion] états:', e.message)),
      { timezone: TIMEZONE, noOverlap: true });
  }
  ready = true;
  if (runSchedules && !schedulerStarted) {
    if (!process.env.LEGION_CLIENT_API_KEY) throw new Error('Clé Legion requise pour exécuter les planifications');
    schedulerStarted = true;
    cron.schedule('* * * * *', () => runDueSchedules().catch(e => console.error('[Legion] plannings:', e.message)),
      { timezone: TIMEZONE, noOverlap: true });
    await reconcileMissedSchedules().catch(e => console.error('[Legion] rattrapage journal:', e.message));
  }
  console.log('[Legion] Journal et planifications initialisés');
}

function isReady() { return ready; }

async function execute(mapId, type, origin, actor) {
  legion.assertMap(mapId);
  if (!['restart', 'start', 'stop', 'wild_dinos'].includes(type)) throw new Error('Action non autorisée');
  const pool = db();
  const { rows } = await pool.query(
    `INSERT INTO legion_map_events (map_id, event_type, origin, status, actor)
     VALUES ($1,$2,$3,'en_cours',$4) RETURNING id`,
    [mapId, type, origin, actor]
  );
  try {
    if (type === 'wild_dinos') await legion.wipeWildDinos(mapId);
    else await legion.power(mapId, type);
    await pool.query(`UPDATE legion_map_events SET status='accepte' WHERE id=$1`, [rows[0].id]);
    return { id: mapId, ok: true };
  } catch (error) {
    await pool.query(`UPDATE legion_map_events SET status='echec', details=$2 WHERE id=$1`,
      [rows[0].id, error.message]);
    return { id: mapId, ok: false, error: error.message };
  }
}

async function executeMany(mapIds, type, origin, actor) {
  const ids = validateIds(mapIds);
  if (!['restart', 'start', 'stop', 'wild_dinos'].includes(type)) throw new Error('Action non autorisée');
  return Promise.all(ids.map(id => execute(id, type, origin, actor)));
}

async function listEvents(mapId) {
  if (mapId) legion.assertMap(mapId);
  const { rows } = await db().query(
    `SELECT id, map_id, event_type, origin, status, actor, details, occurred_at
     FROM legion_map_events WHERE ($1::text IS NULL OR map_id=$1)
     ORDER BY occurred_at DESC LIMIT 200`, [mapId || null]
  );
  const local = rows.map(row => ({ ...row, occurred_at: row.occurred_at.toISOString() }));
  if (!mapId) return local;
  // Les activités GPanel permettent de voir aussi les interventions faites hors dashboard.
  // On ne retourne jamais la valeur d'une commande console arbitraire.
  const activity = await legion.getActivity(mapId);
  const external = activity.map(a => ({
    id: `gpanel-${a.id}`, map_id: mapId,
    event_type: a.isWildWipe ? 'wild_dinos' : a.event.split('.').pop(),
    origin: 'gpanel', status: 'enregistre', actor: 'GPanel (acteur non communiqué)',
    details: null, occurred_at: a.timestamp,
  })).filter(a => !local.some(item => item.map_id === mapId && item.event_type === a.event_type &&
    Math.abs(new Date(item.occurred_at) - new Date(a.occurred_at)) < 2 * 60 * 1000));
  return [...local, ...external].sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at)).slice(0, 200);
}

async function listSchedules() {
  const { rows } = await db().query(
    'SELECT id, name, event_type, command, time_of_day, map_ids, active, created_at FROM legion_map_schedules ORDER BY created_at DESC'
  );
  return rows;
}

function validateScheduledCommand(command) {
  if (typeof command !== 'string' || command.length > 180 ||
      /[\u0000-\u001F\u007F-\u009F]/.test(command)) {
    throw new Error('Commande invalide (180 caractères maximum, sans caractères de contrôle)');
  }
  if (command === 'SaveWorld' || command === 'ListPlayers' || /^Broadcast .+$/.test(command)) return command;
  throw new Error('Commande planifiée non autorisée (SaveWorld, Broadcast <texte> ou ListPlayers)');
}

async function createSchedule({ name, type, time, ids, command }) {
  validateIds(ids);
  if (!['restart', 'wild_dinos', 'command'].includes(type) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) ||
      typeof name !== 'string' || !name.trim() || name.length > 80) {
    throw new Error('Nom, type ou heure invalide');
  }
  const safeCommand = type === 'command' ? validateScheduledCommand(command) : null;
  const id = crypto.randomUUID();
  await db().query(
    `INSERT INTO legion_map_schedules (id,name,event_type,command,time_of_day,map_ids)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [id, name.trim(), type, safeCommand, time, JSON.stringify(ids)]
  );
  return id;
}

async function executeScheduledCommand(mapId, command, actor, origin = 'programme') {
  legion.assertMap(mapId);
  const safeCommand = validateScheduledCommand(command);
  const pool = db();
  const { rows } = await pool.query(
    `INSERT INTO legion_map_events (map_id,event_type,origin,status,actor)
     VALUES ($1,'command',$2,'en_cours',$3) RETURNING id`,
    [mapId, origin, actor]
  );
  try {
    await legion.sendCommand(mapId, safeCommand);
    await pool.query(`UPDATE legion_map_events SET status='accepte' WHERE id=$1`, [rows[0].id]);
    return { id: mapId, ok: true };
  } catch (error) {
    await pool.query(`UPDATE legion_map_events SET status='echec', details=$2 WHERE id=$1`,
      [rows[0].id, error.message]);
    return { id: mapId, ok: false, error: error.message };
  }
}

async function setScheduleActive(id, active) {
  if (typeof active !== 'boolean') throw new Error('Valeur active invalide');
  const result = await db().query('UPDATE legion_map_schedules SET active=$2 WHERE id=$1', [id, active]);
  if (!result.rowCount) throw new Error('Planning introuvable');
}

async function removeSchedule(id) {
  const result = await db().query('DELETE FROM legion_map_schedules WHERE id=$1', [id]);
  if (!result.rowCount) throw new Error('Planning introuvable');
}

function parisParts(now) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', hourCycle:'h23',
  });
  return Object.fromEntries(formatter.formatToParts(now).map(p => [p.type, p.value]));
}

async function runDueSchedules(now = new Date()) {
  if (!ready) throw new Error('Planifications Legion non initialisées');
  const parts = parisParts(now);
  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  const localTime = `${parts.hour}:${parts.minute}`;
  const { rows } = await db().query(
    'SELECT * FROM legion_map_schedules WHERE active=true AND time_of_day=$1', [localTime]
  );
  for (const schedule of rows) {
    let ids;
    let safeCommand;
    try {
      ids = validateIds(schedule.map_ids);
      if (schedule.event_type === 'command') safeCommand = validateScheduledCommand(schedule.command);
      else if (!['restart', 'wild_dinos'].includes(schedule.event_type)) throw new Error('Action non autorisée');
    } catch (error) {
      console.error(`[Legion] Planning ${schedule.name} invalide : ${error.message}`);
      continue;
    }
    for (const id of ids) {
      const claim = await db().query(
        `INSERT INTO legion_schedule_map_runs (schedule_id,local_date,map_id)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING map_id`,
        [schedule.id, localDate, id]
      );
      if (!claim.rowCount) continue;
      try {
        const actor = `Planning : ${schedule.name}`;
        const result = schedule.event_type === 'command'
          ? await executeScheduledCommand(id, safeCommand, actor)
          : await execute(id, schedule.event_type, 'programme', actor);
        await db().query(
          'UPDATE legion_schedule_map_runs SET status=$4 WHERE schedule_id=$1 AND local_date=$2 AND map_id=$3',
          [schedule.id, localDate, id, result.ok ? 'accepte' : 'echec']
        );
        if (!result.ok) console.error(`[Legion] ${schedule.name} (${id}): ${result.error}`);
      } catch (error) {
        await db().query(
          `UPDATE legion_schedule_map_runs SET status='incertain'
           WHERE schedule_id=$1 AND local_date=$2 AND map_id=$3`, [schedule.id, localDate, id]
        );
        await db().query(
          `INSERT INTO legion_map_events (map_id,event_type,origin,status,actor,details)
           VALUES ($1,$2,'programme','incertain',$3,$4)`,
          [id, schedule.event_type, `Planning : ${schedule.name}`,
            'Exécution interrompue ou journal indisponible : vérifier GPanel avant toute relance (' + error.message + ')']
        );
        console.error(`[Legion] ${schedule.name} (${id}): ${error.message}`);
      }
    }
  }
}

async function reconcileMissedSchedules(now = new Date()) {
  const parts = parisParts(now);
  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  const localTime = `${parts.hour}:${parts.minute}`;
  const { rows } = await db().query(
    'SELECT * FROM legion_map_schedules WHERE active=true AND time_of_day < $1', [localTime]
  );
  for (const schedule of rows) {
    let ids;
    try {
      ids = validateIds(schedule.map_ids);
      if (schedule.event_type === 'command') validateScheduledCommand(schedule.command);
      else if (!['restart', 'wild_dinos'].includes(schedule.event_type)) throw new Error('Action non autorisée');
    } catch (error) {
      console.error(`[Legion] Planning ${schedule.name} invalide : ${error.message}`);
      continue;
    }
    const created = parisParts(schedule.created_at);
    const createdDate = `${created.year}-${created.month}-${created.day}`;
    if (createdDate === localDate && `${created.hour}:${created.minute}` >= schedule.time_of_day) continue;
    for (const id of ids) {
      const claim = await db().query(
        `INSERT INTO legion_schedule_map_runs (schedule_id,local_date,map_id,status)
         VALUES ($1,$2,$3,'manque') ON CONFLICT DO NOTHING RETURNING map_id`,
        [schedule.id, localDate, id]
      );
      if (claim.rowCount) await db().query(
        `INSERT INTO legion_map_events (map_id,event_type,origin,status,actor,details)
         VALUES ($1,$2,'programme','manque',$3,'Horaire manqué pendant une interruption du dashboard ; aucune commande envoyée')`,
        [id, schedule.event_type, `Planning : ${schedule.name}`]
      );
    }
  }
}

async function observeStates() {
  if (checking) return;
  checking = true;
  try {
    const servers = await legion.getServers();
    for (const server of servers) {
      if (server.state === 'unknown') continue;
      const connection = await db().connect();
      let previous;
      try {
        await connection.query('BEGIN');
        const { rows } = await connection.query(
          'SELECT state, uptime_ms, observed_at FROM legion_map_states WHERE map_id=$1 FOR UPDATE', [server.id]
        );
        previous = rows[0] || null;
        if (previous) {
          await connection.query(
            'UPDATE legion_map_states SET state=$2,uptime_ms=$3,observed_at=NOW() WHERE map_id=$1',
            [server.id, server.state, server.uptime]
          );
        } else {
          await connection.query(
            `INSERT INTO legion_map_states (map_id,state,uptime_ms) VALUES ($1,$2,$3)
             ON CONFLICT DO NOTHING`, [server.id, server.state, server.uptime]
          );
        }
        await connection.query('COMMIT');
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally { connection.release(); }

      if (!previous) continue;
      const changed = previous.state !== server.state;
      const elapsed = Date.now() - new Date(previous.observed_at).getTime();
      const uptimeReset = server.state === 'running' && server.uptime != null &&
        previous.uptime_ms != null && Number(server.uptime) + 15000 < Number(previous.uptime_ms) + elapsed;
      if (!changed && !uptimeReset) continue;

      const recent = await db().query(
        `SELECT 1 FROM legion_map_events
         WHERE map_id=$1 AND event_type IN ('restart','stop','start')
         AND occurred_at > NOW() - INTERVAL '5 minutes' LIMIT 1`, [server.id]
      );
      let panelAction = false;
      if (!recent.rowCount) {
        try {
          const activity = await legion.getActivity(server.id);
          panelAction = activity.some(a => a.event.startsWith('server:power.') &&
            Date.now() - new Date(a.timestamp).getTime() < 5 * 60 * 1000);
        } catch (error) {
          console.warn(`[Legion] Activité ${server.id} indisponible : ${error.message}`);
        }
      }
      if (recent.rowCount || panelAction) continue;
      const eventType = uptimeReset ? 'unexpected_restart' : 'state_change';
      const details = uptimeReset
        ? 'Redémarrage observé (temps de fonctionnement remis à zéro) ; cause inconnue, possible incident'
        : server.state === 'running'
          ? 'Retour en ligne observé ; cause inconnue'
          : 'Interruption observée ; cause inconnue, possible incident';
      await db().query(
        `INSERT INTO legion_map_events (map_id,event_type,origin,status,actor,details)
         VALUES ($1,$2,'surveillance','observe','Surveillance',$3)`, [server.id, eventType, details]
      );
    }
  } finally { checking = false; }
}

module.exports = { init, execute, listEvents, listSchedules, createSchedule,
  executeMany, executeScheduledCommand, setScheduleActive, removeSchedule,
  runDueSchedules, observeStates, validateIds, isReady };