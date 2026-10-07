const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createBridgeRouter } = require('../nexus-bridge/router');
const ACTOR = '11111111111111111', OTHER = '22222222222222222', GUILD = '33333333333333333';
const TOKEN = 'test-only-bridge-key-not-a-real-secret';

async function fixture(t, options = {}) {
  const reads = [], queries = [], discordRequests = [];
  const data = {
    inventory_data: { [ACTOR]: { diamants: 42, custom: 2 }, [OTHER]: { diamants: 9000 } },
    inventory_item_types: [{ id: 'diamants', name: 'Diamants', category: 'currency' }],
    inventory_transactions: [{ playerId: OTHER, action: 'credit', itemTypeId: 'diamants', quantity: 99, reason: 'private' },
      { playerId: ACTOR, type: 'add', itemTypeId: 'diamants', quantity: 42, timestamp: '2026-10-01', adminId: 'private-admin', reason: 'private-note' }],
    shop: { packs: [{ id: 'pack', name: 'Pack', priceDiamonds: 10, options: [{ name: 'Double', priceDiamonds: 20 }], privateKey: 'DO NOT EXPOSE' }],
      shopTicketAdminRoleIds: ['44444444444444444'] },
    dinos: { dinos: [{ id: 'dino', name: 'Rex', priceDiamonds: 100, variants: [
      { label: 'Tek', priceDiamonds: 200 }, { label: 'Hidden', hidden: true, private: 'x' }] },
      { id: 'unavailable', name: 'Unavailable', notAvailableShop: true }] },
    ...options.data,
  };
  const row = { order_id: 'order', user_id: ACTOR, username: 'Synthetic customer', channel_id: '55555555555555555',
    status: 'paid', created_at: 1, data: { discount: 10, cart: { comment: 'private-comment', items: [{ name: 'Pack', quantity: 2, priceDiamonds: 10 }] },
      secret: 'DO NOT EXPOSE', messages: ['private transcript'] } };
  const store = {
    isPostgres: () => options.postgres !== false,
    getData: async (key, fallback, opts) => {
      reads.push(key); assert.equal(opts.throwOnError, true);
      if (options.dbFail) throw new Error('PRIVATE SQL FAILURE');
      return data[key] ?? fallback;
    },
    getPool: () => ({ query: async (sql, parameters) => {
      queries.push({ sql, parameters });
      assert.match(sql, /^SELECT /);
      if (sql.includes('shop_orders')) return { rows: options.rows || [row] };
      return { rows: [{ ticket_id: 'ticket', status: 'closed', channel_id: row.channel_id, created_at: 1 }] };
    } }),
  };
  const router = createBridgeRouter({
    store, settings: { getSettings: () => ({ guild: { guildId: GUILD } }) },
    config: () => ({ enabled: options.enabled !== false, token: options.token ?? TOKEN, discordToken: 'test-only-discord-placeholder' }),
    fetchImpl: async url => {
      discordRequests.push(url);
      if (options.discordFail) throw new Error('timeout');
      const value = url.endsWith('/roles') ? [{ id: '44444444444444444', permissions: options.admin ? '8' : '0' }]
        : url.endsWith(`/guilds/${GUILD}`) ? { owner_id: options.owner ? ACTOR : OTHER }
          : { user: { id: options.memberId || ACTOR, bot: false }, roles: options.staff || options.admin ? ['44444444444444444'] : [] };
      return { status: options.absent ? 404 : 200, ok: !options.absent, json: async () => value };
    },
  });
  const app = express(); app.use('/api/nexus/v1', router);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const request = async (path, init = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/nexus/v1/${path}`, {
      ...init, headers: { Authorization: `Bearer ${TOKEN}`, 'X-Arki-Actor-Id': ACTOR, 'X-Arki-Guild-Id': GUILD, ...init.headers },
    });
    return { response, data: await response.json() };
  };
  return { request, reads, queries, discordRequests };
}

test('account is scoped to asserted actor, ignores subject query, and minimizes private fields', async t => {
  const f = await fixture(t);
  const { response, data } = await f.request(`account?userId=${OTHER}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(data.discordUserId, ACTOR);
  assert.equal(data.inventory.find(i => i.id === 'diamants').quantity, 42);
  assert.equal(data.inventory.find(i => i.id === 'custom').name, 'custom');
  assert.equal(data.activity.length, 1);
  assert.equal(data.activity[0].action, 'add');
  assert.equal(data.tickets.length, 3);
  assert.ok(f.queries.every(q => q.parameters[0] === ACTOR));
  assert.doesNotMatch(JSON.stringify(data), /private|9000|DO NOT EXPOSE|customerName|discordUserId.*222222222/);
});
test('requests read fresh values each time instead of an inventory cache', async t => {
  const f = await fixture(t); await f.request('account'); await f.request('account');
  assert.equal(f.reads.filter(k => k === 'inventory_data').length, 2);
});
test('catalog includes available products/options and omits hidden/internal fields', async t => {
  const f = await fixture(t); const { data } = await f.request('catalog');
  assert.equal(data.products.length, 2);
  assert.equal(data.products[0].prices[1].diamonds, 20);
  assert.equal(data.products[1].prices[1].label, 'Tek');
  assert.doesNotMatch(JSON.stringify(data), /Hidden|Unavailable|privateKey|DO NOT EXPOSE/);
  assert.match(data.pricingNotice, /Prix de base/);
});
test('unconfigured bridge is closed', async t => {
  const f = await fixture(t, { enabled: false });
  assert.equal((await f.request('account')).response.status, 503);
  assert.equal(f.reads.length + f.discordRequests.length, 0);
});
test('wrong service key is denied before Discord/database access', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('account', { headers: { Authorization: 'Bearer invalid' } })).response.status, 401);
  assert.equal(f.reads.length + f.discordRequests.length, 0);
});
test('malformed subject or different guild cannot access data', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('account', { headers: { 'X-Arki-Actor-Id': '1;DROP' } })).response.status, 400);
  assert.equal((await f.request('account', { headers: { 'X-Arki-Guild-Id': OTHER } })).response.status, 403);
  assert.equal(f.reads.length, 0);
});
test('non-members and mismatched Discord responses are denied', async t => {
  const f = await fixture(t, { absent: true });
  assert.equal((await f.request('account')).response.status, 403);
  assert.equal(f.reads.length, 0);
});
test('Discord outages and unavailable PostgreSQL fail explicitly', async t => {
  const f = await fixture(t, { discordFail: true });
  assert.equal((await f.request('account')).response.status, 503);
});
test('PostgreSQL is required; no local JSON fallback', async t => {
  const f = await fixture(t, { postgres: false });
  assert.equal((await f.request('account')).response.status, 503);
  assert.equal(f.reads.length, 0);
});
test('database errors are not silently empty results or leaked SQL', async t => {
  const f = await fixture(t, { dbFail: true });
  const { response, data } = await f.request('account');
  assert.equal(response.status, 503);
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE SQL/);
});
test('staff overview rejects ordinary members', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('staff')).response.status, 403);
  assert.equal(f.queries.length, 0);
});
test('configured shop role can read staff orders with pagination', async t => {
  const f = await fixture(t, { staff: true });
  const { response, data } = await f.request('staff?page=2');
  assert.equal(response.status, 200);
  assert.equal(data.orders[0].discordUserId, ACTOR);
  assert.deepEqual(f.queries[0].parameters, [50]);
  assert.equal((await f.request('staff?page=-1')).response.status, 400);
});
test('Discord administrator and guild owner are allowed', async t => {
  const f = await fixture(t, { admin: true });
  assert.equal((await f.request('staff')).response.status, 200);
});
test('all write methods are refused', async t => {
  const f = await fixture(t);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const { response } = await f.request('account', { method });
    assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'GET');
  }
  assert.equal(f.queries.length, 0);
});
