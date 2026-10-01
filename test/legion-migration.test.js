const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const legion = require('../web/legionManager');
const journal = require('../web/legionJournal');
const scheduler = require('../nitradoRestartScheduler');
const booster = require('../boosterReproManager');
const legionIni = require('../web/legionIni');
const iniLock = require('../web/legionIniMutationLock');
const { getBoosterMaps } = require('../boosterReproMaps');
const { createDestroyWildDinosHandler } = require('../destroyWildDinosCommand');

test('les actions groupées refusent tout serveur hors des 12 cartes', () => {
  assert.equal(legion.MAPS.length, 12);
  const ids = legion.MAPS.map(map => map.id);
  assert.equal(new Set(ids).size, 12);
  assert.deepEqual(journal.validateIds(ids), ids);
  assert.throws(() => journal.validateIds([...ids, 'test']), /invalide|autorisés/);
  assert.throws(() => journal.validateIds(['test']), /autorisés/);
  assert.throws(() => journal.validateIds([ids[0], ids[0]]), /invalide/);
});

test('les plannings refusent les anciens identifiants Nitrado avant sauvegarde', async () => {
  await assert.rejects(
    scheduler.create({ nom: 'Legacy', heure: '12:00', serverIds: ['123456'] }),
    /autorisés/,
  );
  await assert.rejects(
    scheduler.create({ nom: 'Ancien toutes les cartes', heure: '12:00', serverIds: [] }),
    /invalide/,
  );
  await assert.rejects(
    scheduler.create({ nom: 'Cible absente', heure: '12:00' }),
    /invalide/,
  );
});

test('les anciens plannings stockés ne sont jamais repris comme plannings Legion', async () => {
  const store = require('../pgStore');
  const original = store.getData;
  const keys = [];
  store.getData = async key => {
    keys.push(key);
    return key === 'nitrado_restart_schedules'
      ? [{ id: 'ancien', active: true, serverIds: [], heure: '12:00' }]
      : [];
  };
  try {
    assert.deepEqual(await scheduler.getAll(), []);
    await assert.rejects(scheduler.runNow('ancien'), /introuvable/);
    assert.deepEqual(keys, ['legion_restart_schedules', 'legion_restart_schedules']);
  } finally {
    store.getData = original;
  }
});

test('le dashboard initialise le journal sans prendre les plannings du bot', async () => {
  const store = require('../pgStore');
  const cron = require('node-cron');
  const originalPool = store.getPool;
  const originalSchedule = cron.schedule;
  const scheduled = [];
  store.getPool = () => ({ query: async () => ({ rows: [] }) });
  cron.schedule = (expression, callback) => {
    scheduled.push(callback.toString());
    return { stop() {} };
  };
  try {
    await journal.init({ runSchedules: false });
    assert.equal(scheduled.length, 1);
    assert.match(scheduled[0], /observeStates/);
    assert.doesNotMatch(scheduled[0], /runDueSchedules/);
    const serverSource = require('fs').readFileSync(require.resolve('../web/server'), 'utf8');
    assert.match(serverSource, /legionJournal'\)\.init\(\{ runSchedules: false \}\)/);
  } finally {
    store.getPool = originalPool;
    cron.schedule = originalSchedule;
  }
});

test('fichiers et commandes refusés avant tout appel réseau si hors périmètre', async () => {
  const original = axios.create;
  let calls = 0;
  axios.create = () => ({ get: async () => { calls++; }, post: async () => { calls++; } });
  try {
    await assert.rejects(legion.readFile('test', '/ShooterGame/Saved/Config/WindowsServer/Game.ini'));
    await assert.rejects(legion.writeFile('test', '/ShooterGame/Saved/Config/WindowsServer/Game.ini', 'hello'));
    await assert.rejects(legion.sendCommand('test', 'SaveWorld'));
    await assert.rejects(legion.writeFile(legion.MAPS[0].id, '/other.ini', 'hello'));
    await assert.rejects(legion.sendCommand(legion.MAPS[0].id, 'Stop'));
    await assert.rejects(legion.sendCommand(legion.MAPS[0].id, 'SaveWorld\nStop'));
    assert.equal(calls, 0);
  } finally {
    axios.create = original;
  }
});

test('le client GPanel lit et écrit Game.ini avec le format attendu', async () => {
  const original = axios.create;
  const requests = [];
  axios.create = () => ({
    get: async (...args) => { requests.push(['get', ...args]); return { data: '[ServerSettings]\nValue=1' }; },
    post: async (...args) => { requests.push(['post', ...args]); return { status: 204 }; },
  });
  try {
    const id = legion.MAPS[0].id;
    const path = '/ShooterGame/Saved/Config/WindowsServer/Game.ini';
    assert.match(await legion.readFile(id, path), /ServerSettings/);
    await legion.writeFile(id, path, '[ServerSettings]\nValue=2');
    await legion.sendCommand(id, 'SaveWorld');
    assert.deepEqual(requests.map(r => [r[0], r[1]]), [
      ['get', `/servers/${id}/files/contents`],
      ['post', `/servers/${id}/files/write`],
      ['post', `/servers/${id}/command`],
    ]);
    assert.deepEqual(requests[1][3].params, { file: path });
    assert.equal(requests[1][3].headers['Content-Type'], 'text/plain');
  } finally {
    axios.create = original;
  }
});

test('le booster sauvegarde les valeurs réelles, les restaure, et refuse une annulation dangereuse', async () => {
  const store = require('../pgStore');
  const originals = {
    getData: store.getData, setData: store.setData,
    readFile: legion.readFile, writeFile: legion.writeFile,
    withMapIniLock: iniLock.withMapIniLock,
  };
  const mapId = legion.MAPS[0].id;
  const path = '/ShooterGame/Saved/Config/WindowsServer/Game.ini';
  let ini = '[/Script/ShooterGame.ShooterGameMode]\nMatingSpeedMultiplier=1.75\nEggHatchSpeedMultiplier=2.5\n';
  let sessions = [];
  const writes = [];
  store.getData = async () => sessions;
  store.setData = async (_key, data) => { sessions = structuredClone(data); };
  iniLock.withMapIniLock = async (_id, work) => work();
  legion.readFile = async (id, file) => {
    assert.equal(id, mapId);
    assert.equal(file, path);
    return ini;
  };
  legion.writeFile = async (id, file, content) => {
    assert.equal(id, mapId);
    assert.equal(file, path);
    writes.push(content);
    ini = content;
  };
  try {
    const config = {
      itemName: 'Test',
      iniKey1: { key: 'MatingSpeedMultiplier', boostValue: '4' },
      iniKey2: { key: 'EggHatchSpeedMultiplier', boostValue: '8' },
    };
    const session = await booster.createSession({
      userId: 'test', username: 'test', serviceId: mapId, mapDisplayName: 'Valguero',
      itemName: 'Test', durationHours: 1, expiresAt: Date.now() + 3600000,
      iniConfig: {},
    });
    await booster.applyBoostIni(mapId, config, session.id);
    assert.equal(writes.length, 1);
    assert.match(ini, /MatingSpeedMultiplier=4/);
    assert.match(ini, /EggHatchSpeedMultiplier=8/);
    assert.deepEqual(sessions[0].iniBackup, { key1: '1.75', key2: '2.5' });
    await assert.rejects(booster.cancelSession(session.id), /Annulation refusée/);
    assert.equal(sessions[0].status, 'active');
    await booster.restoreNormalIni(mapId, sessions[0], config);
    assert.equal(writes.length, 2);
    assert.match(ini, /MatingSpeedMultiplier=1\.75/);
    assert.match(ini, /EggHatchSpeedMultiplier=2\.5/);
  } finally {
    store.getData = originals.getData;
    store.setData = originals.setData;
    legion.readFile = originals.readFile;
    legion.writeFile = originals.writeFile;
    iniLock.withMapIniLock = originals.withMapIniLock;
  }
});

test('l’éditeur INI refuse les fichiers, clés et cartes non autorisés sans exposer les fichiers', async () => {
  const store = require('../pgStore');
  const id = legion.MAPS[0].id;
  const originals = { getData: store.getData, readFile: legion.readFile, writeFile: legion.writeFile,
    getMapState: legion.getMapState, withMapIniLock: iniLock.withMapIniLock };
  const path = '/ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini';
  let contents = '[ServerSettings]\r\nServerAdminPassword=private\r\nXPMultiplier=1\r\n';
  let writes = 0;
  store.getData = async () => [];
  // Never contact GPanel in this fixture; the preset's offline preflight is
  // mocked as a successful read-only resources response.
  legion.getMapState = async mapId => {
    assert.equal(mapId, id);
    return 'offline';
  };
  iniLock.withMapIniLock = async (mapId, work) => { legion.assertMap(mapId); return work(); };
  legion.readFile = async (_id, file) => {
    assert.equal(file, path);
    return contents;
  };
  legion.writeFile = async (_id, file, value) => {
    assert.equal(file, path);
    writes++;
    contents = value;
  };
  try {
    await assert.rejects(legionIni.updateSetting('test', 'XPMultiplier', '2'), /autorisés/);
    await assert.rejects(legionIni.updateSetting(id, 'ServerAdminPassword', '2'), /non autorisé/);
    await assert.rejects(legionIni.updateSetting(id, 'XPMultiplier', '2\nAdmin'), /invalide/);
    assert.equal(writes, 0);
    assert.deepEqual(await legionIni.updateSetting(id, 'XPMultiplier', '2'),
      { changed: true, verified: true });
    assert.equal(writes, 1);
    assert.match(contents, /ServerAdminPassword=private\r\nXPMultiplier=2/);
    assert.equal(legionIni.PRESETS.XPMultiplier.path, path);
  } finally {
    store.getData = originals.getData;
    legion.readFile = originals.readFile;
    legion.writeFile = originals.writeFile;
    legion.getMapState = originals.getMapState;
    iniLock.withMapIniLock = originals.withMapIniLock;
  }
});

test('le Booster propose toujours exactement les 12 cartes Legion, sans ancienne carte ni serveur d’essai', () => {
  const maps = getBoosterMaps();
  assert.equal(maps.length, 12);
  assert.deepEqual(maps.map(map => map.serviceId), legion.MAPS.map(map => map.id));
  assert.deepEqual(maps.map(map => map.displayName), legion.MAPS.map(map => map.name));
  assert.ok(maps.every(map => map.id === map.serviceId));
});

test('la commande Discord de wipe demande confirmation puis exécute uniquement la carte choisie', async () => {
  const executions = [];
  const handler = createDestroyWildDinosHandler({
    legion,
    journal: { execute: async (...args) => {
      executions.push(args);
      return { id: args[0], ok: true };
    } },
    getSettings: () => ({ serverPanel: {} }),
  });
  const replies = [];
  const base = {
    guildId: 'guild',
    user: { id: 'admin' },
    memberPermissions: { has: () => true },
    member: { roles: { cache: new Map() } },
  };
  const command = {
    ...base,
    isChatInputCommand: () => true,
    isButton: () => false,
    commandName: 'destroywilddinos',
    options: { getString: () => legion.MAPS[0].id },
    reply: async payload => { replies.push(payload); },
  };
  assert.equal(await handler.handle(command), true);
  assert.equal(executions.length, 0);
  const customId = replies[0].components[0].components[0].data.custom_id;
  const button = {
    ...base,
    isChatInputCommand: () => false,
    isButton: () => true,
    customId,
    deferUpdate: async () => {},
    editReply: async payload => { replies.push(payload); },
  };
  assert.equal(await handler.handle(button), true);
  assert.deepEqual(executions, [[legion.MAPS[0].id, 'wild_dinos', 'discord', 'admin']]);
  assert.match(replies.at(-1).content, /1\/1 commande/);
  const source = require('fs').readFileSync(require.resolve('../index.js'), 'utf8');
  assert.match(source, /destroyWildDinosHandler\.handle\(interaction\)/);
});