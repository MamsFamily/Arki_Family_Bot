const crypto = require('node:crypto');
const pgStore = require('../pgStore');
const legion = require('./legionManager');
const booster = require('../boosterReproManager');
const iniLock = require('./legionIniMutationLock');
const iniSafety = require('./legionIniSafety');

const STORE_KEY = 'legion_shiny_rotation_config';
const FILE = '/ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini';
const SECTION = '[Shiny]';
const DEFAULT_RULES = Object.freeze([
  ['SpawnIntervalMin', '20m'],
  ['SpawnIntervalMax', '40m'],
  ['DinoLifetimeMin', '3h'],
  ['DinoLifetimeMax', '5h'],
  ['DinoLevelMin', '150'],
  ['DinoLevelMax', '300'],
  ['MaxNumShinies', '6'],
  ['NumSearchLoops', '15'],
].map(([key, value]) => Object.freeze({ active: `${key}=${value}`, inactive: `${key}=0` })));
const REQUIRED_KEYS = new Set(DEFAULT_RULES.map(rule => rule.active.split('=')[0].toLowerCase()));
const CONFIG_LOCK_NAMESPACE = 0x41524b49; // same ARKI namespace, separate key from map IDs
const CONFIG_LOCK_KEY = 0x5348594e; // "SHYN"
let applying = false;

function problem(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseLine(line) {
  if (typeof line !== 'string' || !line || line.length > 4096 ||
      /[\r\n\u0000-\u001F\u007F]/.test(line)) {
    throw problem('Chaque réglage Shyni doit tenir sur une seule ligne non vide.');
  }
  const equals = line.indexOf('=');
  const key = equals > 0 ? line.slice(0, equals) : '';
  if (!/^[A-Za-z_][A-Za-z0-9_.]*(?:\[\d+\])?$/.test(key) ||
      /(?:password|secret|token|api.?key|auth)/i.test(key)) {
    throw problem('Clé Shyni invalide ou sensible.');
  }
  const value = line.slice(equals + 1);
  if (!value || value.length > 200 || value.trim() !== value) throw problem('Valeur Shyni invalide.');
  return { key: key.toLowerCase(), value };
}

function validateRules(input) {
  if (!Array.isArray(input) || input.length !== REQUIRED_KEYS.size) {
    throw problem('Les huit paires de réglages Shyni sont nécessaires pour garantir deux cartes actives.');
  }
  const seen = new Set();
  return input.map(rule => {
    const active = parseLine(rule?.active);
    const inactive = parseLine(rule?.inactive);
    if (!REQUIRED_KEYS.has(active.key) || active.key !== inactive.key ||
        active.value === inactive.value || inactive.value !== '0' ||
        seen.has(active.key)) {
      throw problem('Chaque clé Shyni attendue doit être unique, avec une valeur active et la même clé réglée à 0.');
    }
    seen.add(active.key);
    return { active: rule.active, inactive: rule.inactive };
  });
}

function revision(rules) {
  return hash(JSON.stringify(rules));
}

async function withConfigLock(work) {
  const pool = pgStore.getPool();
  if (!pool) throw problem('PostgreSQL requis pour protéger les réglages Shyni.', 503);
  const client = await pool.connect();
  let acquired = false;
  try {
    const result = await client.query(
      'SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired',
      [CONFIG_LOCK_NAMESPACE, CONFIG_LOCK_KEY],
    );
    acquired = result.rows[0]?.acquired === true;
    if (!acquired) throw problem('Une rotation ou un enregistrement Shyni est déjà en cours.', 409);
    return await work();
  } finally {
    try {
      if (acquired) await client.query(
        'SELECT pg_advisory_unlock($1::integer, $2::integer)',
        [CONFIG_LOCK_NAMESPACE, CONFIG_LOCK_KEY],
      );
    } finally {
      client.release();
    }
  }
}

async function loadConfig() {
  if (!pgStore.getPool()) throw problem('PostgreSQL requis pour enregistrer les réglages Shyni.', 503);
  const saved = await pgStore.getData(STORE_KEY, null, { throwOnError: true });
  const rules = validateRules(saved === null ? DEFAULT_RULES : saved.rules);
  return { rules, revision: revision(rules), saved: saved !== null };
}

async function saveConfig(input) {
  return withConfigLock(async () => {
    if (applying) throw problem('Une rotation est en cours. Réessaie ensuite.', 409);
    const current = await loadConfig();
    if (input?.revision !== current.revision) throw problem('Réglages modifiés depuis leur chargement : recharge-les.', 409);
    const rules = validateRules(input?.rules);
    if (!(await pgStore.setData(STORE_KEY, { rules }))) throw problem('Enregistrement des réglages Shyni impossible.', 502);
    return { rules, revision: revision(rules), saved: true };
  });
}

function validateSelection(ids) {
  if (!Array.isArray(ids) || ids.length !== 2 || new Set(ids).size !== 2) {
    throw problem('Sélectionne exactement deux cartes pour les Shyni.');
  }
  ids.forEach(id => legion.assertMap(id));
  return ids;
}

function planFile(content, rules, activeTarget) {
  if (typeof content !== 'string' || content.length > 2_000_000) throw problem('Fichier INI invalide ou trop volumineux.');
  // Preserve each original separator: files may mix CRLF and LF outside [Shiny].
  const separators = content.match(/\r\n|\n|\r/g) || [];
  const lines = content === '' ? [] : content.split(/\r\n|\n|\r/);
  const records = lines.map((text, index) => ({ text, ending: separators[index] || '' }));
  const sections = [];
  records.forEach(({ text }, index) => {
    if (text.replace(/^\uFEFF/, '').trim().toLowerCase() === SECTION.toLowerCase()) sections.push(index);
  });
  if (sections.length > 1) throw problem('Section [Shiny] présente plusieurs fois : correction manuelle nécessaire.');
  const start = sections.length ? sections[0] + 1 : records.length;
  let end = start;
  while (end < records.length && !/^\s*\[[^\]\r\n]+\]\s*$/.test(records[end].text)) end++;
  const observed = [];
  const missing = [];
  let duplicates = 0;
  let unexpected = 0;
  for (const rule of rules) {
    const key = parseLine(rule.active).key;
    const matches = [];
    for (let i = start; i < end; i++) {
      const equals = records[i].text.indexOf('=');
      if (equals > 0 && records[i].text.slice(0, equals).trim().toLowerCase() === key) matches.push(i);
    }
    if (matches.length === 0) {
      missing.push(activeTarget ? rule.active : rule.inactive);
      observed.push('missing');
    } else {
      duplicates += matches.length - 1;
      const values = matches.map(index => records[index].text);
      observed.push(values.every(value => value === rule.active) ? 'active' :
        values.every(value => value === rule.inactive) ? 'inactive' : 'mixed');
      for (const index of matches) {
        if (records[index].text !== rule.active && records[index].text !== rule.inactive) unexpected++;
        records[index].text = activeTarget ? rule.active : rule.inactive;
      }
    }
  }
  const newline = sections.length ? records[sections[0]].ending || separators[0] || '\n' :
    separators[0] || '\n';
  if (!sections.length) missing.unshift(SECTION);
  if (missing.length) {
    let insertAt = end;
    // A trailing empty record represents a final newline, not a real setting.
    if (insertAt === records.length && /[\r\n]$/.test(content)) insertAt--;
    else if (insertAt === records.length && records.length) records[records.length - 1].ending = newline;
    const appendingWithoutFinalNewline = insertAt === records.length;
    records.splice(insertAt, 0, ...missing.map((text, index) => ({
      text, ending: appendingWithoutFinalNewline && index === missing.length - 1 ? '' : newline,
    })));
  }
  const updated = records.map(({ text, ending }) => text + ending).join('');
  if (updated.length > 2_000_000) throw problem('Fichier INI trop volumineux après modification.');
  const state = observed.every(value => value === 'active') ? 'active' :
    observed.every(value => value === 'inactive') ? 'inactive' : 'mixed';
  return {
    state, changed: updated !== content, updated,
    repairs: { missing: missing.length - Number(!sections.length), duplicates, unexpected },
  };
}

async function guardBoosts(ids) {
  if ((await booster.loadSessions()).some(session =>
    ids.includes(session.serviceId) && session.status === 'active')) {
    throw problem('Une session Booster Repro est active sur une carte : rotation refusée.', 409);
  }
}

async function prepare(ids, rules) {
  await guardBoosts(legion.MAPS.map(map => map.id));
  return Promise.all(legion.MAPS.map(async map => {
    try {
      const original = await legion.readFile(map.id, FILE);
      const toActive = ids.includes(map.id);
      const plan = planFile(original, rules, toActive);
      return { id: map.id, name: map.name, hash: hash(original), ...plan, toActive };
    } catch (error) {
      return { id: map.id, name: map.name, error: error.message };
    }
  }));
}

async function preview(input) {
  const ids = validateSelection(input?.ids);
  const config = await loadConfig();
  if (!config.saved) throw problem('Enregistre les lignes Shyni avant de prévisualiser la rotation.', 409);
  const [maps, serverStates] = await Promise.all([
    prepare(ids, config.rules),
    iniSafety.getMapsOfflineStatus(legion.MAPS.map(map => map.id)),
  ]);
  const states = new Map(serverStates.map(status => [status.id, status]));
  const enriched = maps.map(map => {
    const status = states.get(map.id);
    return {
      ...map,
      serverState: status.serverState,
      offline: status.offline,
      stateError: status.stateError,
      applySafe: !map.error && (!map.changed || status.applySafe),
    };
  });
  return {
    ok: enriched.every(map => !map.error),
    applySafe: enriched.every(map => map.applySafe),
    revision: config.revision,
    maps: enriched.map(({ id, name, hash: fileHash, state, changed, repairs, toActive, error,
      serverState, offline, stateError, applySafe }) =>
      ({ id, name, hash: fileHash, state, changed, repairs, toActive, error,
        serverState, offline, stateError, applySafe })),
  };
}

async function apply(input) {
  if (applying) throw problem('Une autre rotation Shyni est en cours.', 409);
  applying = true;
  try {
    return await withConfigLock(async () => {
    const ids = validateSelection(input?.ids);
    const config = await loadConfig();
    if (!config.saved) throw problem('Enregistre les lignes Shyni avant de lancer la rotation.', 409);
    if (input?.revision !== config.revision) throw problem('Réglages Shyni changés : refais l’aperçu.', 409);
    const expected = input?.expected;
    if (!Array.isArray(expected) || expected.length !== legion.MAPS.length ||
        new Set(expected.map(item => item?.id)).size !== legion.MAPS.length ||
        expected.some(item => !legion.MAPS.some(map => map.id === item?.id) ||
          !/^[a-f0-9]{64}$/.test(item?.hash || ''))) {
      throw problem('Aperçu manquant ou incomplet : recommence.', 400);
    }
    const hashes = new Map(expected.map(item => [item.id, item.hash]));
    const maps = await prepare(ids, config.rules);
    if (maps.some(map => map.error) || maps.some(map => map.hash !== hashes.get(map.id))) {
      throw problem('Une carte a changé depuis l’aperçu : aucun fichier modifié, recommence.', 409);
    }
    // Disable old maps before enabling new ones; multi-map writes cannot be atomic.
    const changes = maps.filter(map => map.changed).sort((a, b) => Number(a.toActive) - Number(b.toActive));
    // Check the complete write set before the first write so an online later map
    // cannot cause an avoidable partial rotation. Unchanged maps are irrelevant.
    await iniSafety.assertMapsOffline(changes.map(map => map.id));
    const results = [];
    for (const map of changes) {
      try {
        await iniLock.withMapIniLock(map.id, async () => {
          const current = await legion.readFile(map.id, FILE);
          if (hash(current) !== map.hash) throw problem('Fichier changé depuis l’aperçu.', 409);
          await guardBoosts([map.id]);
          await iniSafety.assertMapsOffline([map.id]);
          await legion.writeFile(map.id, FILE, map.updated);
          if (await legion.readFile(map.id, FILE) !== map.updated) {
            throw problem('Écriture non confirmée par relecture : vérifie cette carte dans GPanel.', 502);
          }
        });
        results.push({ id: map.id, name: map.name, ok: true });
      } catch (error) {
        results.push({ id: map.id, name: map.name, ok: false, error: error.message });
        break;
      }
    }
    for (const map of changes.slice(results.length)) {
      results.push({ id: map.id, name: map.name, ok: false, error: 'Non traitée après un échec précédent.' });
    }
    return { ok: results.every(result => result.ok), results, unchanged: maps.filter(map => !map.changed).map(map => map.name) };
    });
  } finally {
    applying = false;
  }
}

module.exports = { DEFAULT_RULES, validateRules, planFile, loadConfig, saveConfig, preview, apply };