// Only explicitly public game settings cross the persistence/API boundary.
const crypto = require('node:crypto');
const pgStore = require('../pgStore');
const legion = require('./legionManager');
const iniLock = require('./legionIniMutationLock');
const ROOT = '/ShooterGame/Saved/Config/WindowsServer/';
const GAME_SECTION = '[/Script/ShooterGame.ShooterGameMode]';
const PRESETS = new Set([
  'matingintervalmultiplier', 'babyimprintamountmultiplier', 'babymaturespeedmultiplier',
  'babyfoodconsumptionspeedmultiplier', 'egghatchspeedmultiplier',
]);
const SETTINGS = new Set([
  'tamingspeedmultiplier', 'harvestamountmultiplier', 'xpmultiplier', 'playerdamagemultiplier',
]);
const SHINY = new Set([
  'spawnintervalmin', 'spawnintervalmax', 'dinolifetimemin', 'dinolifetimemax',
  'dinolevelmin', 'dinolevelmax', 'maxnumshinies', 'numsearchloops',
  'randomselectionbias', 'cancarryshinies',
]);
let initialized = null;
let checking = false;
let started = false;

function pool() {
  const db = pgStore.getPool();
  if (!db) throw new Error('PostgreSQL requis pour le suivi INI ; aucune écriture autorisée sans historique.');
  return db;
}

function allowed(file, section, key) {
  if (typeof section !== 'string' || typeof key !== 'string') return false;
  const s = section.toLowerCase();
  const k = key.toLowerCase();
  return (file === 'Game.ini' && s === GAME_SECTION.toLowerCase() &&
    (PRESETS.has(k) || /^itemstatclamps\[(?:[0-9]|1[0-2])\]$/.test(k))) ||
    (file === 'GameUserSettings.ini' &&
      ((s === '[serversettings]' && SETTINGS.has(k)) || (s === '[shiny]' && SHINY.has(k))));
}

function validValue(key, value) {
  if (typeof value !== 'string' || value.length > 30) return false;
  if (key.toLowerCase() === 'cancarryshinies') return /^(true|false)$/i.test(value);
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)(?:[smhd])?$/.test(value)) return false;
  if (/[smhd]$/.test(value) && !/^(spawninterval|dinolifetime)/i.test(key)) return false;
  return Number.isFinite(Number(value.replace(/[smhd]$/, '')));
}

function target(file, section, line, absent = false) {
  if (typeof line !== 'string') return null;
  const i = line.indexOf('=');
  if (i < 1) return null;
  const key = line.slice(0, i).trim().toLowerCase();
  const value = line.slice(i + 1).trim();
  if (!allowed(file, section, key) || !validValue(key, value)) return null;
  return { file, section: section.toLowerCase(), key, expected: absent ? null : value };
}

function lineTargets(request) {
  const entries = [];
  const before = target(request.file, request.section, request.before, true);
  const after = target(request.file, request.section, request.after);
  const afterKey = typeof request.after === 'string' ? request.after.split('=')[0].trim().toLowerCase() : null;
  if (before && (!afterKey || before.key !== afterKey)) entries.push(before);
  if (after) entries.push(after);
  return entries;
}

function validateAfter(file, section, line) {
  if (typeof line !== 'string') return;
  const i = line.indexOf('=');
  const key = line.slice(0, i).trim();
  if (allowed(file, section, key) && !validValue(key, line.slice(i + 1).trim())) {
    throw new Error('Valeur de jeu non validée pour le suivi INI : nombre, durée ou booléen attendu.');
  }
}

function start() {
  if (started) return;
  started = true;
  const check = () => runDueChecks().catch(() =>
    console.error('[Legion] Surveillance INI indisponible ; reprise au prochain passage.'));
  require('node-cron').schedule('* * * * *', check, { noOverlap: true });
  check(); // Durable due dates survive a process restart, even if journal init failed.
}

async function init() {
  if (!initialized) initialized = (async () => {
    await pool().query(`CREATE TABLE IF NOT EXISTS legion_ini_edits (
      id BIGSERIAL PRIMARY KEY, batch_id UUID NOT NULL, map_id TEXT NOT NULL,
      file TEXT NOT NULL, section TEXT NOT NULL, key TEXT NOT NULL, expected TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), confirmed_at TIMESTAMPTZ,
      initial_result TEXT NOT NULL DEFAULT 'pending',
      next_check TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '5 minutes',
      checked_at TIMESTAMPTZ, last_result TEXT, check_status TEXT,
      observed TEXT, server_state TEXT, check_reason TEXT NOT NULL DEFAULT 'delay'
    )`);
    await pool().query(`CREATE INDEX IF NOT EXISTS legion_ini_target
      ON legion_ini_edits (map_id,file,section,key,id DESC)`);
    await pool().query(`CREATE TABLE IF NOT EXISTS legion_ini_checks (
      id BIGSERIAL PRIMARY KEY, edit_id BIGINT NOT NULL REFERENCES legion_ini_edits(id),
      checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), result TEXT NOT NULL,
      observed TEXT, server_state TEXT NOT NULL, reason TEXT NOT NULL
    )`);
  })().catch(() => {
    initialized = null;
    throw new Error('Historique INI indisponible ; aucune nouvelle écriture autorisée.');
  });
  return initialized;
}

async function begin(mapId, entries) {
  legion.assertMap(mapId);
  // Unknown keys are intentionally not recorded, not even their names.
  if (!Array.isArray(entries) || entries.some(e =>
    !allowed(e.file, e.section, e.key) || (e.expected !== null && !validValue(e.key, e.expected)))) {
    throw new Error('Réglage non autorisé dans le suivi INI.');
  }
  await init();
  if (!entries.length) return null;
  const batch = crypto.randomUUID();
  try {
    await pool().query(`INSERT INTO legion_ini_edits (batch_id,map_id,file,section,key,expected)
      SELECT $1,$2,x.file,x.section,x.key,x.expected FROM
      jsonb_to_recordset($3::jsonb) AS x(file text,section text,key text,expected text)`,
    [batch, mapId, JSON.stringify(entries.map(e => ({
      file: e.file, section: e.section.toLowerCase(), key: e.key.toLowerCase(), expected: e.expected,
    })))]);
  } catch {
    throw new Error('Historique INI indisponible avant écriture ; fichier non modifié.');
  }
  return batch;
}

async function confirm(batch, verifiedContent) {
  if (!batch) return;
  let mismatch = false;
  try {
    const { rows } = await pool().query('SELECT * FROM legion_ini_edits WHERE batch_id=$1', [batch]);
    mismatch = !rows.length || rows.some(row => !safeRow(row) || inspect(verifiedContent, row).result !== 'match');
    const result = await pool().query(`UPDATE legion_ini_edits
      SET initial_result=$2,confirmed_at=CASE WHEN $2='confirmed' THEN NOW() ELSE NULL END
      WHERE batch_id=$1 AND initial_result='pending'`, [batch, mismatch ? 'unconfirmed' : 'confirmed']);
    if (!result.rowCount) throw new Error('Missing audit');
  } catch {
    throw new Error('Fichier relu conforme, mais confirmation historique indisponible ; contrôler manuellement. Ne pas réappliquer automatiquement.');
  }
  if (mismatch) throw new Error('Fichier écrit et relu, mais réglages ciblés ambigus ou non conformes dès la relecture initiale ; contrôle manuel requis.');
}

function inspect(content, entry) {
  if (typeof content !== 'string' || content.length > 2_000_000) throw new Error('Invalid file');
  let inside = false;
  let sections = 0;
  const values = [];
  for (const line of content.split(/\r\n|\n|\r/)) {
    const text = line.replace(/^\uFEFF/, '').trim();
    if (/^\[.*\]$/.test(text)) {
      inside = text.toLowerCase() === entry.section.toLowerCase();
      if (inside) sections++;
    } else if (inside) {
      const equals = text.indexOf('=');
      if (equals > 0 && text.slice(0, equals).trim().toLowerCase() === entry.key.toLowerCase()) {
        values.push(text.slice(equals + 1).trim());
      }
    }
  }
  if (sections > 1) return { result: 'ambiguous', observed: null };
  if (!values.length) return { result: entry.expected === null ? 'match' : 'missing', observed: null };
  if (values.some(value => !validValue(entry.key, value))) return { result: 'invalid', observed: null };
  if (new Set(values).size > 1) return { result: 'ambiguous', observed: null };
  return { result: values[0] === entry.expected ? 'match' : 'mismatch', observed: values[0] };
}

async function onRestart(mapId) {
  legion.assertMap(mapId);
  await init();
  await pool().query(`UPDATE legion_ini_edits SET
    next_check=LEAST(next_check,NOW() + INTERVAL '2 minutes'), check_reason='restart_observed'
    WHERE map_id=$1 AND initial_result='confirmed'`, [mapId]);
}

async function runDueChecks() {
  if (checking) return;
  checking = true;
  try {
    await init();
    // Pending writes surviving a process restart are never promoted to confirmed.
    await pool().query(`UPDATE legion_ini_edits SET initial_result='unconfirmed'
      WHERE initial_result='pending' AND created_at < NOW() - INTERVAL '5 minutes'`);
    for (const map of legion.MAPS) {
      try {
        await iniLock.withMapIniLock(map.id, async () => {
          const { rows } = await pool().query(`SELECT * FROM (
            SELECT DISTINCT ON (file,section,key) * FROM legion_ini_edits
            WHERE map_id=$1 ORDER BY file,section,key,id DESC
          ) latest WHERE initial_result='confirmed' AND next_check <= NOW()`, [map.id]);
          if (!rows.length) return;
          let state = 'unknown';
          try { state = await legion.getMapState(map.id); } catch { /* independent observation */ }
          if (!['offline', 'running', 'starting', 'stopping'].includes(state)) state = 'unknown';
          const files = new Map();
          for (const row of rows) {
            // Validate again when reading persisted data; never trust legacy DB contents.
            if (!allowed(row.file, row.section, row.key) ||
                (row.expected !== null && !validValue(row.key, row.expected))) continue;
            if (!files.has(row.file)) {
              try { files.set(row.file, await legion.readFile(map.id, ROOT + row.file)); }
              catch { files.set(row.file, null); }
            }
            let outcome;
            try { outcome = inspect(files.get(row.file), row); }
            catch { outcome = { result: 'unavailable', observed: null }; }
            const client = await pool().connect();
            try {
              await client.query('BEGIN');
              // Store transitions only: no unbounded hourly copies of unchanged results.
              if (row.check_status !== outcome.result || row.observed !== outcome.observed ||
                  row.check_reason === 'restart_observed') {
                await client.query(`INSERT INTO legion_ini_checks (edit_id,result,observed,server_state,reason)
                  VALUES ($1,$2,$3,$4,$5)`, [row.id, outcome.result, outcome.observed, state, row.check_reason]);
              }
              await client.query(`UPDATE legion_ini_edits SET checked_at=NOW(),check_status=$2,
                last_result=CASE WHEN $2='unavailable' THEN last_result ELSE $2 END,
                observed=$3,server_state=$4,check_reason='delay',
                next_check=NOW() + CASE WHEN $2='unavailable' THEN INTERVAL '5 minutes' ELSE INTERVAL '1 hour' END
                WHERE id=$1`, [row.id, outcome.result, outcome.observed, state]);
              await client.query('COMMIT');
            } catch (error) {
              await client.query('ROLLBACK');
              throw error;
            } finally { client.release(); }
          }
        });
      } catch {
        // Contention/database outage: leave durable due dates unchanged for next tick.
        console.warn('[Legion] Contrôle INI différé pour une carte ; nouvelle tentative au prochain passage.');
      }
    }
  } finally { checking = false; }
}

function safeRow(row) {
  return legion.MAPS.some(m => m.id === row.map_id) &&
    allowed(row.file, row.section, row.key) &&
    (row.expected === null || validValue(row.key, row.expected)) &&
    (row.observed == null || validValue(row.key, row.observed));
}

async function list() {
  await init();
  const db = pool();
  const { rows: current } = await db.query(`SELECT DISTINCT ON (map_id,file,section,key) *
    FROM legion_ini_edits WHERE map_id=ANY($1::text[]) ORDER BY map_id,file,section,key,id DESC`,
  [legion.MAPS.map(m => m.id)]);
  const { rows: history } = await db.query(`SELECT * FROM legion_ini_edits
    WHERE map_id=ANY($1::text[]) ORDER BY id DESC LIMIT 200`, [legion.MAPS.map(m => m.id)]);
  const { rows: checks } = await db.query(`SELECT e.map_id,e.file,e.section,e.key,e.expected,
    c.observed,c.result,c.server_state,c.reason,c.checked_at FROM legion_ini_checks c
    JOIN legion_ini_edits e ON e.id=c.edit_id WHERE e.map_id=ANY($1::text[])
    ORDER BY c.id DESC LIMIT 100`, [legion.MAPS.map(m => m.id)]);
  return { current: current.filter(safeRow), history: history.filter(safeRow), checks: checks.filter(safeRow) };
}

module.exports = { init, start, begin, confirm, target, lineTargets, inspect, validValue,
  validateAfter, onRestart, runDueChecks, list };
