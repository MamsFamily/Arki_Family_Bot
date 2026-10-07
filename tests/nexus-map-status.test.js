const test = require('node:test');
    const assert = require('node:assert/strict');
    const express = require('express');
    const { createBridgeRouter } = require('../nexus-bridge/router');

    const TOKEN = 'test-only-bridge-key-not-a-real-secret';
    const SLUGS = ['ragnarok', 'valguero', 'astraeos', 'svartalfheim', 'genesis', 'lost-colony',
    'aberration', 'scorched-earth', 'the-island', 'the-center', 'extinction', 'ragnarok-event'];
    const SERVERS = [
    { name: 'Valguero', state: 'running' }, { name: 'Genesis', state: 'starting' },
    { name: 'Astraeos', state: 'stopping' }, { name: 'The Island', state: 'restarting' },
    { name: 'Ragnarok', state: 'offline' }, { name: 'Lost Colony', state: 'suspended' },
    { name: 'Aberration', state: 'running' }, { name: 'Scorched Earth', state: 'running' },
    { name: 'Extinction', state: 'offline', resourceError: 'PRIVATE GPanel error' },
    { name: 'Map Event', state: 'running' }, { name: 'Svartalfheim', state: 'unknown' },
    { name: 'The Center', state: 'running' },
    ].map((server, index) => ({ id: 'private-gpanel-id-' + index, ...server }));

    async function fixture(t, options = {}) {
    let mapReads = 0;
    let discordReads = 0;
    const app = express();
    app.use('/api/nexus/v1', createBridgeRouter({
      store: { isPostgres: () => false },
      settings: { getSettings: () => ({ guild: { guildId: '33333333333333333' } }) },
      fetchImpl: async () => { discordReads++; throw new Error('Discord must not be called'); },
      config: () => ({ enabled: options.enabled !== false, token: options.token || TOKEN, discordToken: null }),
      getMapServers: async () => {
        mapReads++;
        if (options.failure) throw new Error(options.failure);
        return options.servers ?? SERVERS;
      },
    }));
    const server = await new Promise(resolve => {
      const value = app.listen(0, '127.0.0.1', () => resolve(value));
    });
    t.after(() => {
      server.closeAllConnections();
      return new Promise(resolve => server.close(resolve));
    });
    const request = async (method = 'GET', headers = {}) => {
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/nexus/v1/map-status', {
        method, headers: { Authorization: 'Bearer ' + TOKEN, ...headers },
      });
      return { response, data: await response.json() };
    };
    return { request, get mapReads() { return mapReads; }, get discordReads() { return discordReads; } };
    }

    test('map status accepts only the bridge bearer and returns exactly 12 public slug/state pairs', async t => {
    const f = await fixture(t);
    const { response, data } = await f.request();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(data.map(item => item.slug), SLUGS);
    assert.ok(data.every(item => Object.keys(item).sort().join(',') === 'slug,state'));
    assert.equal(data.find(item => item.slug === 'ragnarok').state, 'offline');
    assert.equal(data.find(item => item.slug === 'valguero').state, 'online');
    assert.equal(data.find(item => item.slug === 'genesis').state, 'starting');
    assert.equal(data.find(item => item.slug === 'astraeos').state, 'stopping');
    assert.equal(data.find(item => item.slug === 'the-island').state, 'restarting');
    assert.equal(data.find(item => item.slug === 'lost-colony').state, 'suspended');
    assert.equal(data.find(item => item.slug === 'extinction').state, 'unknown');
    assert.equal(data.find(item => item.slug === 'ragnarok-event').state, 'online');
    assert.doesNotMatch(JSON.stringify(data), /private-gpanel-id|PRIVATE GPanel|resourceError/);
    assert.equal(f.discordReads, 0);
    await f.request();
    assert.equal(f.mapReads, 1, 'the short cache avoids repeat GPanel calls');
    });

    test('invalid bearer is rejected before GPanel access and no Discord identity is needed', async t => {
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
    });

    test('incomplete or unexpected server lists fail closed', async t => {
    const f = await fixture(t, { servers: SERVERS.slice(1) });
    const { response, data } = await f.request();
    assert.equal(response.status, 503);
    assert.doesNotMatch(JSON.stringify(data), /private-gpanel-id/);
    });

    test('write methods remain disabled on the status route', async t => {
    const f = await fixture(t);
    const { response } = await f.request('POST');
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET');
    assert.equal(f.mapReads, 0);
    });
    