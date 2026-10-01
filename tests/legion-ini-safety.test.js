const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const legion = require('../web/legionManager');
const ini = require('../web/legionIni');
const booster = require('../boosterReproManager');
const iniLock = require('../web/legionIniMutationLock');

const mapId = legion.MAPS[0].id;
const realGetMapState = legion.getMapState;
const originals = {
  getMapState: legion.getMapState,
  readFile: legion.readFile,
  writeFile: legion.writeFile,
  loadSessions: booster.loadSessions,
  withMapIniLock: iniLock.withMapIniLock,
};
let mapState;
let content;
let writes;

test.beforeEach(() => {
  mapState = async () => 'offline';
  content = '[ServerSettings]\nXPMultiplier=1\n';
  writes = [];
  legion.getMapState = id => mapState(id);
  legion.readFile = async () => content;
  legion.writeFile = async (_id, _path, updated) => { writes.push(updated); content = updated; };
  booster.loadSessions = async () => [];
  iniLock.withMapIniLock = async (_id, work) => work();
});

test.afterEach(() => {
  legion.getMapState = originals.getMapState;
  legion.readFile = originals.readFile;
  legion.writeFile = originals.writeFile;
  booster.loadSessions = originals.loadSessions;
  iniLock.withMapIniLock = originals.withMapIniLock;
});

test('l’API de ressources ne considère que offline comme éteint et refuse les cartes hors allowlist', async () => {
  const originalCreate = axios.create;
  const originalKey = process.env.LEGION_CLIENT_API_KEY;
  const calls = [];
  let response = { attributes: { current_state: 'offline' } };
  axios.create = () => ({
    get: async path => {
      calls.push(path);
      if (response instanceof Error) throw response;
      return { data: response };
    },
  });
  process.env.LEGION_CLIENT_API_KEY = 'test-only-mock-key';
  try {
    assert.equal(await realGetMapState(mapId), 'offline');
    response = { attributes: { current_state: 'running' } };
    assert.equal(await realGetMapState(mapId), 'running');
    response = { attributes: { is_suspended: true, current_state: 'offline' } };
    assert.equal(await realGetMapState(mapId), 'suspended');
    response = { attributes: { current_state: 'unexpected-state' } };
    assert.equal(await realGetMapState(mapId), 'unknown');
    response = new Error('mock api error');
    response.response = { status: 503 };
    await assert.rejects(realGetMapState(mapId), /GPanel : 503/);
    const count = calls.length;
    await assert.rejects(realGetMapState('not-in-allowlist'), /12 serveurs Legion autorisés/);
    assert.equal(calls.length, count);
    assert.ok(calls.every(path => path === `/servers/${mapId}/resources`));
  } finally {
    axios.create = originalCreate;
    if (originalKey === undefined) delete process.env.LEGION_CLIENT_API_KEY;
    else process.env.LEGION_CLIENT_API_KEY = originalKey;
  }
});

test('les presets bloquent running, transitions, suspended, unknown et erreurs de statut sans écrire', async () => {
  for (const blockedState of ['running', 'starting', 'stopping', 'suspended', 'unknown', 'unavailable']) {
    content = '[ServerSettings]\nXPMultiplier=1\n';
    writes = [];
    mapState = async () => {
      if (blockedState === 'unavailable') throw new Error('private api detail');
      return blockedState;
    };
    await assert.rejects(ini.updateSetting(mapId, 'XPMultiplier', '2'), /arrêt confirmé requis/);
    assert.deepEqual(writes, [], `${blockedState} must not write`);
  }
});

test('un preset inchangé renvoie non modifié et non vérifié sans vérifier l’état serveur', async () => {
  content = '[ServerSettings]\nXPMultiplier=2\n';
  let stateChecks = 0;
  mapState = async () => {
    stateChecks++;
    return 'running';
  };

  const result = await ini.updateSetting(mapId, 'XPMultiplier', '2');
  assert.deepEqual(result, { changed: false, verified: false });
  assert.equal(stateChecks, 0);
  assert.deepEqual(writes, []);
});

test('les presets autorisent offline et recontrôlent le statut juste avant la sauvegarde', async () => {
  const result = await ini.updateSetting(mapId, 'XPMultiplier', '2');
  assert.deepEqual(result, { changed: true, verified: true });
  assert.equal(writes.length, 1);
  assert.match(writes[0], /XPMultiplier=2/);

  content = '[ServerSettings]\nXPMultiplier=1\n';
  writes = [];
  let stateReads = 0;
  mapState = async () => ++stateReads === 1 ? 'offline' : 'running';
  await assert.rejects(ini.updateSetting(mapId, 'XPMultiplier', '3'), /arrêt confirmé requis/);
  assert.equal(stateReads, 2);
  assert.deepEqual(writes, []);
});
