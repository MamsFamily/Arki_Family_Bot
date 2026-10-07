const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createBridgeRouter } = require('../nexus-bridge/router');

const TOKEN = 'test-only-bridge-key-not-a-real-secret';
const MAPS = [
  ['9e151580', 'valguero', 'running'],
  ['7c110bf0', 'genesis', 'starting'],
  ['27d0aeff', 'astraeos', 'stopping'],
  ['d8d6185e', 'the-island', 'restarting'],
  ['8efe82b3', 'ragnarok', 'offline'],
  ['8e262f7c', 'lost-colony', 'suspended'],
  ['686c087f', 'aberration', 'running'],
  ['988af27d', 'scorched-earth', 'running'],
  ['e4d5b19e', 'extinction', 'offline'],
  ['b59b0253', 'ragnarok-event', 'running'],
  ['6c0e3a89', 'svartalfheim', 'unknown'],
  ['cf79fe13', 'the-center', 'unexpected'],
];
const SERVERS = MAPS.map(([id, , state]) => ({
  id, state, cpu: 99, resourceError: id === 'e4d5b19e' ? 'PRIVATE GPanel error' : null,
}));

async function fixture(t, options = {}) {
  let mapReads = 0;
  let discordReads = 0;
  const reads = [];
  const queries = [];
  const app = express();
  app.use('/api/nexus/v1', createBridgeRouter({
    store: {
      isPostgres: () => false,
      getData: async key => { reads.push(key); throw new Error('Database must not be called'); },
      getPool: () => ({ query: async () => { queries.push('query'); throw new Error('Database must not be called'); } }),
    },
    settings: { getSettings: () => ({ guild: { guildId: '33333333333333333' } }) },
    legionApi: {
      getServers: async () => {
        mapReads++;
        if (options.failure) throw new Error(options.failure);
        return options.servers ?? SERVERS;
      },
    },
    fetchImpl: async () => { discordReads++; throw new Error('Discord must not be called'); },
    config: () => ({ enabled: options.enabled !== false, token: options.token ?? TOKEN, discordToken: null }),
  }));
  const server = await new Promise(resolve => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value));
  });
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const request = async (method = 'GET', headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/nexus/v1/map-status`, {
      method, headers: { Authorization: `Bearer ${TOKEN}`, ...headers },
    });
    return { response, data: await response.json() };
  };
  return {
    request, reads, queries,
    get mapReads() { return mapReads; },
    get discordReads() { return discordReads; },
  };
}

test('map status requires the bridge key and exposes only the 12 approved slugs and states', async t => {
  const f = await fixture(t);
  const { response, data } = await f.request();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(data.schemaVersion, 1);
  assert.equal(typeof data.checkedAt, 'string');
  assert.deepEqual(data.maps.map(map => map.slug), MAPS.map(([, slug]) => slug));
  assert.deepEqual(data.maps.map(map => map.state), [
    'running', 'starting', 'stopping', 'restarting', 'offline', 'suspended',
    'running', 'running', 'unknown', 'running', 'unknown', 'unknown',
  ]);
  assert.ok(data.maps.every(map => Object.keys(map).sort().join(',') === 'slug,state'));
  assert.doesNotMatch(JSON.stringify(data), /9e151580|private provider detail|PRIVATE GPanel|resourceError|cpu/);
  assert.equal(f.mapReads, 1);
  assert.equal(f.discordReads, 0);
  assert.equal(f.reads.length + f.queries.length, 0);
  await f.request();
  assert.equal(f.mapReads, 1, 'the short cache avoids repeated GPanel calls');
});

test('invalid bridge bearer is rejected before GPanel access', async t => {
  const f = await fixture(t);
  const { response } = await f.request('GET', { Authorization: 'Bearer invalid' });
  assert.equal(response.status, 401);
  assert.equal(f.mapReads, 0);
  assert.equal(f.discordReads, 0);
});

test('whole GPanel failures return a generic 503 without internal details', async t => {
  const f = await fixture(t, { failure: 'PRIVATE GPanel failure details' });
  const { response, data } = await f.request();
  assert.equal(response.status, 503);
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE GPanel/);
  assert.equal(f.mapReads, 1);
});

test('write methods remain disabled on the status route', async t => {
  const f = await fixture(t);
  const { response } = await f.request('POST');
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET');
  assert.equal(f.mapReads, 0);
});

test('map status is rate limited per IP', async t => {
  const f = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 601 }, () => f.request()));
  assert.equal(responses.filter(({ response }) => response.status === 200).length, 600);
  assert.equal(responses.filter(({ response }) => response.status === 429).length, 1);
  assert.equal(f.mapReads, 1);
});
