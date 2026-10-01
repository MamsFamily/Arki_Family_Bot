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
const originalGetMapState = legion.getMapState;
let mapState;

test.beforeEach(() => {
  mapState = async () => 'offline';
  legion.getMapState = id => mapState(id);
});

test.afterEach(() => {
  legion.getMapState = originalGetMapState;
});

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

test('régularise les lignes manquantes, dupliquées, inattendues et partiellement actives', () => {
  const unusual = ini(true).replace('SpawnIntervalMin=20m', ' spawnintervalmin = 12m');
  const corrected = shiny.planFile(unusual, rules, false);
  assert.equal(corrected.state, 'mixed');
  assert.equal(corrected.repairs.unexpected, 1);
  assert.equal(corrected.updated, ini(false));
  const partial = ini(true).replace('SpawnIntervalMin=20m', 'SpawnIntervalMin=0');
  assert.equal(shiny.planFile(partial, rules, false).updated, ini(false));
  const missing = ini(true).replace('SpawnIntervalMin=20m\n', '');
  const completed = shiny.planFile(missing, rules, false);
  assert.equal(completed.repairs.missing, 1);
  assert.equal(shiny.planFile(completed.updated, rules, false).state, 'inactive');
  assert.match(completed.updated, /SpawnIntervalMin=0\n\[Other\]/);
  const duplicate = ini(true).replace('SpawnIntervalMin=20m', 'SpawnIntervalMin=20m\nSpawnIntervalMin=12m');
  const normalized = shiny.planFile(duplicate, rules, false);
  assert.equal(normalized.repairs.duplicates, 1);
  assert.equal(normalized.repairs.unexpected, 1);
  assert.match(normalized.updated, /SpawnIntervalMin=0\nSpawnIntervalMin=0/);
  assert.equal(shiny.planFile(normalized.updated, rules, false).state, 'inactive');
  const newSection = shiny.planFile('[ServerSettings]\r\nServerAdminPassword=private', rules, false);
  assert.equal(newSection.repairs.missing, 8);
  assert.equal(newSection.updated, `[ServerSettings]\r\nServerAdminPassword=private\r\n[Shiny]\r\n${rules.map(rule => rule.inactive).join('\r\n')}`);
  const noFinalNewline = shiny.planFile('[Shiny]\nRandomSelectionBias=0.2', rules, true);
  assert.equal(noFinalNewline.updated, `[Shiny]\nRandomSelectionBias=0.2\n${rules.map(rule => rule.active).join('\n')}`);
  const lowercaseSection = shiny.planFile('[shiny]\nRandomSelectionBias=0.2', rules, false);
  assert.equal(lowercaseSection.updated.includes('[Shiny]'), false);
  assert.equal(lowercaseSection.updated.includes('SpawnIntervalMin=0'), true);
  assert.throws(() => shiny.planFile(`${ini(true)}[Shiny]\n`, rules, false), /plusieurs fois/);
  assert.throws(() => shiny.planFile(`${ini(true)}[shiny]\n`, rules, false), /plusieurs fois/);
});

test('refuse des règles incomplètes ou des clés non prévues', () => {
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

test('la rotation corrige les écarts et finit avec deux cartes actives, dix à zéro', async () => {
  const original = { getPool: pgStore.getPool, getData: pgStore.getData,
    readFile: legion.readFile, writeFile: legion.writeFile,
    loadSessions: booster.loadSessions, withMapIniLock: iniLock.withMapIniLock };
  const contents = new Map(mapIds.map((id, index) => [id, ini(index < 2)]));
  contents.set(mapIds[2], ini(false).replace('SpawnIntervalMin=0\n', ''));
  contents.set(mapIds[3], ini(false).replace('DinoLifetimeMin=0', 'DinoLifetimeMin=2h'));
  contents.set(mapIds[4], ini(false).replace('SpawnIntervalMin=0', 'SpawnIntervalMin=7m\nSpawnIntervalMin=0'));
  contents.set(mapIds[5], '[ServerSettings]\nServerAdminPassword=private\n');
  contents.set(mapIds[6], ini(false).replace('DinoLifetimeMin=0', 'DinoLifetimeMin=3h'));
  const writes = [];
  const pool = fakeLockPool();
  pgStore.getPool = () => pool;
  pgStore.getData = async () => ({ rules });
  booster.loadSessions = async () => [];
  legion.readFile = async id => contents.get(id);
  legion.writeFile = async (id, path, updated) => {
    assert.equal(path, file);
    writes.push(id);
    contents.set(id, updated);
  };
  iniLock.withMapIniLock = async (_id, work) => work();
  try {
    const ids = [mapIds[2], mapIds[3]];
    const preview = await shiny.preview({ ids });
    assert.equal(preview.ok, true);
    assert.equal(writes.length, 0);
    assert.equal(preview.maps[2].repairs.missing, 1);
    assert.equal(preview.maps[4].repairs.duplicates, 1);
    assert.equal(preview.maps[5].repairs.missing, 8);
    assert.equal(preview.maps[6].state, 'mixed');
    const applied = await shiny.apply({
      ids, revision: preview.revision,
      expected: preview.maps.map(({ id, hash }) => ({ id, hash })),
    });
    assert.equal(applied.ok, true);
    assert.deepEqual(writes, [mapIds[0], mapIds[1], mapIds[4], mapIds[5], mapIds[6], ...ids]);
    for (const id of mapIds) {
      const expected = ids.includes(id) ? 'active' : 'inactive';
      assert.equal(shiny.planFile(contents.get(id), rules, ids.includes(id)).state, expected);
      assert.equal(shiny.planFile(contents.get(id), rules, ids.includes(id)).changed, false);
    }
    assert.match(contents.get(mapIds[5]), /ServerAdminPassword=private/);
  } finally {
    pgStore.getPool = original.getPool;
    pgStore.getData = original.getData;
    legion.readFile = original.readFile;
    legion.writeFile = original.writeFile;
    booster.loadSessions = original.loadSessions;
    iniLock.withMapIniLock = original.withMapIniLock;
  }
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
  mapState = async id => id === mapIds[4] ? 'running' : 'offline';
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
    assert.equal(preview.maps[4].serverState, 'running');
    assert.equal(preview.maps[4].changed, false);
    assert.equal(preview.maps[4].applySafe, true);
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

test('le précontrôle Shyni bloque tout le lot pour les états non arrêtés ou indisponibles', async () => {
  const original = {
    getPool: pgStore.getPool, getData: pgStore.getData,
    readFile: legion.readFile, writeFile: legion.writeFile,
    loadSessions: booster.loadSessions,
  };
  const pool = fakeLockPool();
  const blockedStates = ['running', 'starting', 'stopping', 'suspended', 'unknown', 'unavailable'];
  let contents;
  let writes = 0;
  pgStore.getPool = () => pool;
  pgStore.getData = async () => ({ rules });
  booster.loadSessions = async () => [];
  legion.readFile = async id => contents.get(id);
  legion.writeFile = async () => { writes++; };
  try {
    for (const blockedState of blockedStates) {
      contents = new Map(mapIds.map((id, index) => [id, ini(index < 2)]));
      writes = 0;
      mapState = async id => {
        if (id !== mapIds[3]) return 'offline';
        if (blockedState === 'unavailable') throw new Error('private api detail');
        return blockedState;
      };
      const ids = [mapIds[2], mapIds[3]];
      const preview = await shiny.preview({ ids });
      assert.equal(preview.ok, true, `preview remains available for ${blockedState}`);
      assert.equal(preview.applySafe, false);
      assert.equal(preview.maps[3].applySafe, false);
      if (blockedState === 'unavailable') {
        assert.equal(preview.maps[3].serverState, 'unknown');
        assert.doesNotMatch(JSON.stringify(preview), /private api detail/);
      } else {
        assert.equal(preview.maps[3].serverState, blockedState);
      }
      await assert.rejects(shiny.apply({
        ids, revision: preview.revision,
        expected: preview.maps.map(({ id, hash }) => ({ id, hash })),
      }), /arrêt confirmé requis/);
      assert.equal(writes, 0, `${blockedState} blocks before any write`);
    }
  } finally {
    pgStore.getPool = original.getPool;
    pgStore.getData = original.getData;
    legion.readFile = original.readFile;
    legion.writeFile = original.writeFile;
    booster.loadSessions = original.loadSessions;
  }
});

test('la rotation revérifie dans le verrou et bloque si une carte démarre après le précontrôle', async () => {
  const original = {
    getPool: pgStore.getPool, getData: pgStore.getData,
    readFile: legion.readFile, writeFile: legion.writeFile,
    loadSessions: booster.loadSessions, withMapIniLock: iniLock.withMapIniLock,
  };
  const contents = new Map(mapIds.map((id, index) => [id, ini(index < 2)]));
  const writes = [];
  let stateReads = 0;
  pgStore.getPool = () => fakeLockPool();
  pgStore.getData = async () => ({ rules });
  booster.loadSessions = async () => [];
  legion.readFile = async id => contents.get(id);
  legion.writeFile = async id => { writes.push(id); };
  iniLock.withMapIniLock = async (_id, work) => work();
  mapState = async id => {
    if (id === mapIds[0] && ++stateReads >= 3) return 'starting';
    return 'offline';
  };
  try {
    const ids = [mapIds[2], mapIds[3]];
    const preview = await shiny.preview({ ids });
    const result = await shiny.apply({
      ids, revision: preview.revision,
      expected: preview.maps.map(({ id, hash }) => ({ id, hash })),
    });
    assert.equal(result.ok, false);
    assert.deepEqual(writes, []);
    assert.match(result.results[0].error, /arrêt confirmé requis/);
  } finally {
    pgStore.getPool = original.getPool;
    pgStore.getData = original.getData;
    legion.readFile = original.readFile;
    legion.writeFile = original.writeFile;
    booster.loadSessions = original.loadSessions;
    iniLock.withMapIniLock = original.withMapIniLock;
  }
});