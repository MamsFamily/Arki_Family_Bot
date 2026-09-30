const test = require('node:test');
const assert = require('node:assert/strict');
const pgStore = require('../pgStore');
const legion = require('../web/legionManager');
const booster = require('../boosterReproManager');
const iniLock = require('../web/legionIniMutationLock');
const shiny = require('../web/legionShiny');

const rules = shiny.DEFAULT_RULES;
const mapIds = legion.MAPS.map(map => map.id);
const file = '/ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini';

function fakeLockPool() {
  let held = false;
  return {
    connect: async () => ({
      query: async sql => {
        if (sql.includes('pg_try_advisory_lock')) {
          const acquired = !held;
          if (acquired) held = true;
          return { rows: [{ acquired }] };
        }
        if (sql.includes('pg_advisory_unlock')) held = false;
        return { rows: [] };
      },
      release() {},
    }),
  };
}

function ini(active, newline = '\n') {
  return ['[ServerSettings]', 'ServerAdminPassword=private', '[Shiny]',
    ...rules.map(rule => active ? rule.active : rule.inactive),
    'RandomSelectionBias=0.2', 'CanCarryShinies=False', '[Other]', 'Setting=1', ''].join(newline);
}

test('préserve les autres sections et réglages Shyni, avec fins de ligne CRLF', () => {
  const original = ini(false, '\r\n');
  const planned = shiny.planFile(original, rules, true);
  assert.equal(planned.state, 'inactive');
  assert.equal(planned.changed, true);
  assert.equal(planned.updated, ini(true, '\r\n'));
  assert.equal(shiny.planFile(ini(true), rules, true).changed, false);
  assert.equal(shiny.planFile(ini(true), rules, false).updated, ini(false));
  assert.doesNotMatch(JSON.stringify({ state: planned.state, changed: planned.changed }), /private/);
  const mixed = `[ServerSettings]\r\nServerAdminPassword=private\n[Shiny]\r\n${rules.map(rule => rule.inactive).join('\n')}\r\nRandomSelectionBias=0.2\n[Other]\r\nSetting=1\n`;
  let expected = mixed;
  for (const rule of rules) expected = expected.replace(rule.inactive, rule.active);
  assert.equal(shiny.planFile(mixed, rules, true).updated, expected);
});

test('refuse les valeurs inattendues, les sections absentes, les clés dupliquées et les états mixtes', () => {
  assert.throws(() => shiny.planFile(ini(true).replace('[Shiny]', '[Different]'), rules, false), /Section/);
  assert.throws(() => shiny.planFile(ini(true).replace('SpawnIntervalMin=20m', 'SpawnIntervalMin=12m'), rules, false), /inattendue/);
  assert.throws(() => shiny.planFile(ini(true).replace('SpawnIntervalMin=20m', 'SpawnIntervalMin=0'), rules, false), /partiellement/);
  assert.throws(() => shiny.planFile(ini(true).replace('SpawnIntervalMin=20m', 'SpawnIntervalMin=20m\nSpawnIntervalMin=0'), rules, false), /plusieurs fois/);
  assert.throws(() => shiny.validateRules([
    { active: 'ServerAdminPassword=a', inactive: 'ServerAdminPassword=0' }, ...rules.slice(1),
  ]), /sensible/);
  assert.throws(() => shiny.validateRules([
    { active: 'SpawnIntervalMin=20m', inactive: 'Other=0' }, ...rules.slice(1),
  ]), /même clé/);
  assert.throws(() => shiny.validateRules([...rules.slice(0, -1), rules[0]]), /unique/);
  assert.throws(() => shiny.validateRules(rules.slice(1)), /huit paires/);
  assert.throws(() => shiny.validateRules([...rules.slice(0, -1), {
    active: 'OtherSetting=1', inactive: 'OtherSetting=0',
  }]), /attendue/);
});

test('enregistre les paires sans toucher aux serveurs', async () => {
  const original = { getPool: pgStore.getPool, getData: pgStore.getData, setData: pgStore.setData,
    writeFile: legion.writeFile };
  let stored = null;
  let writes = 0;
  const pool = fakeLockPool();
  pgStore.getPool = () => pool;
  pgStore.getData = async () => stored;
  pgStore.setData = async (_key, value) => { stored = value; return true; };
  legion.writeFile = async () => { writes++; };
  try {
    const defaults = await shiny.loadConfig();
    assert.equal(defaults.saved, false);
    assert.equal(defaults.rules.length, 8);
    await assert.rejects(shiny.preview({ ids: mapIds.slice(0, 2) }), /Enregistre les lignes/);
    await assert.rejects(shiny.saveConfig({ rules, revision: 'obsolete' }), /modifiés/);
    const saved = await shiny.saveConfig({ rules, revision: defaults.revision });
    assert.equal(saved.saved, true);
    assert.equal((await shiny.loadConfig()).saved, true);
    assert.equal(writes, 0);
  } finally {
    pgStore.getPool = original.getPool;
    pgStore.getData = original.getData;
    pgStore.setData = original.setData;
    legion.writeFile = original.writeFile;
  }
});

test('deux enregistrements concurrents ne peuvent pas écraser les règles sauvegardées', async () => {
  const original = { getPool: pgStore.getPool, getData: pgStore.getData, setData: pgStore.setData };
  let stored = null;
  let releaseWrite;
  let writeStarted;
  const started = new Promise(resolve => { writeStarted = resolve; });
  const pending = new Promise(resolve => { releaseWrite = resolve; });
  const pool = fakeLockPool();
  pgStore.getPool = () => pool;
  pgStore.getData = async () => stored;
  pgStore.setData = async (_key, value) => {
    writeStarted();
    await pending;
    stored = value;
    return true;
  };
  try {
    const current = await shiny.loadConfig();
    const changedRules = [{ active: 'SpawnIntervalMin=25m', inactive: 'SpawnIntervalMin=0' }, ...rules.slice(1)];
    const first = shiny.saveConfig({ rules: changedRules, revision: current.revision });
    await started;
    await assert.rejects(shiny.saveConfig({ rules, revision: current.revision }), /déjà en cours/);
    releaseWrite();
    await first;
    await assert.rejects(shiny.saveConfig({ rules, revision: current.revision }), /modifiés/);
  } finally {
    releaseWrite();
    pgStore.getPool = original.getPool;
    pgStore.getData = original.getData;
    pgStore.setData = original.setData;
  }
});

test('arrête la rotation après un échec et indique les cartes non traitées', async () => {
  const original = { getPool: pgStore.getPool, getData: pgStore.getData,
    readFile: legion.readFile, writeFile: legion.writeFile,
    loadSessions: booster.loadSessions, withMapIniLock: iniLock.withMapIniLock };
  const contents = new Map(mapIds.map((id, index) => [id, ini(index < 2)]));
  const writes = [];
  const pool = fakeLockPool();
  pgStore.getPool = () => pool;
  pgStore.getData = async () => ({ rules });
  booster.loadSessions = async () => [];
  legion.readFile = async id => contents.get(id);
  legion.writeFile = async (id, _path, updated) => {
    writes.push(id);
    if (id === mapIds[1]) throw new Error('Écriture GPanel refusée');
    contents.set(id, updated);
  };
  iniLock.withMapIniLock = async (_id, work) => work();
  try {
    const ids = [mapIds[2], mapIds[3]];
    const preview = await shiny.preview({ ids });
    const result = await shiny.apply({
      ids, revision: preview.revision,
      expected: preview.maps.map(({ id, hash }) => ({ id, hash })),
    });
    assert.equal(result.ok, false);
    assert.deepEqual(writes, mapIds.slice(0, 2));
    assert.deepEqual(result.results.map(item => item.ok), [true, false, false, false]);
    assert.match(result.results[2].error, /Non traitée/);
  } finally {
    pgStore.getPool = original.getPool;
    pgStore.getData = original.getData;
    legion.readFile = original.readFile;
    legion.writeFile = original.writeFile;
    booster.loadSessions = original.loadSessions;
    iniLock.withMapIniLock = original.withMapIniLock;
  }
});

test('aperçu puis rotation vérifiée sur exactement deux cartes, anciennes désactivées en premier', async () => {
  const original = { getPool: pgStore.getPool, getData: pgStore.getData,
    readFile: legion.readFile, writeFile: legion.writeFile,
    loadSessions: booster.loadSessions, withMapIniLock: iniLock.withMapIniLock };
  const contents = new Map(mapIds.map((id, index) => [id, ini(index < 2)]));
  const writes = [];
  const pool = fakeLockPool();
  pgStore.getPool = () => pool;
  pgStore.getData = async () => ({ rules });
  booster.loadSessions = async () => [];
  legion.readFile = async (id, path) => {
    assert.equal(path, file);
    assert.ok(mapIds.includes(id));
    return contents.get(id);
  };
  legion.writeFile = async (id, path, updated) => {
    assert.equal(path, file);
    writes.push(id);
    contents.set(id, updated);
  };
  iniLock.withMapIniLock = async (id, work) => { legion.assertMap(id); return work(); };
  try {
    await assert.rejects(shiny.preview({ ids: [] }), /exactement deux/);
    await assert.rejects(shiny.preview({ ids: [mapIds[0], 'serveur-test'] }), /autorisés/);
    const ids = [mapIds[2], mapIds[3]];
    const preview = await shiny.preview({ ids });
    assert.equal(preview.ok, true);
    assert.deepEqual(preview.maps.filter(map => map.state === 'active').map(map => map.id), mapIds.slice(0, 2));
    assert.equal(writes.length, 0);
    assert.equal(JSON.stringify(preview).includes('private'), false);
    const applied = await shiny.apply({
      ids, revision: preview.revision,
      expected: preview.maps.map(({ id, hash }) => ({ id, hash })),
    });
    assert.equal(applied.ok, true);
    assert.deepEqual(writes, mapIds.slice(0, 4));
    assert.equal(applied.unchanged.length, 8);
    assert.deepEqual(mapIds.filter(id => shiny.planFile(contents.get(id), rules, true).state === 'active'), ids);
  } finally {
    pgStore.getPool = original.getPool;
    pgStore.getData = original.getData;
    legion.readFile = original.readFile;
    legion.writeFile = original.writeFile;
    booster.loadSessions = original.loadSessions;
    iniLock.withMapIniLock = original.withMapIniLock;
  }
});

test('bloque toutes les écritures si une carte a changé entre l’aperçu et la rotation', async () => {
  const original = { getPool: pgStore.getPool, getData: pgStore.getData,
    readFile: legion.readFile, writeFile: legion.writeFile, loadSessions: booster.loadSessions };
  const contents = new Map(mapIds.map((id, index) => [id, ini(index < 2)]));
  let writes = 0;
  const pool = fakeLockPool();
  pgStore.getPool = () => pool;
  pgStore.getData = async () => ({ rules });
  booster.loadSessions = async () => [];
  legion.readFile = async id => contents.get(id);
  legion.writeFile = async () => { writes++; };
  try {
    const ids = [mapIds[2], mapIds[3]];
    const preview = await shiny.preview({ ids });
    contents.set(mapIds[11], contents.get(mapIds[11]).replace('RandomSelectionBias=0.2', 'RandomSelectionBias=0.3'));
    await assert.rejects(shiny.apply({
      ids, revision: preview.revision,
      expected: preview.maps.map(({ id, hash }) => ({ id, hash })),
    }), /changé/);
    assert.equal(writes, 0);
  } finally {
    pgStore.getPool = original.getPool;
    pgStore.getData = original.getData;
    legion.readFile = original.readFile;
    legion.writeFile = original.writeFile;
    booster.loadSessions = original.loadSessions;
  }
});