const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fetchTribeVaultPins } = require('../shopTicketCommand');

test('fetchTribeVaultPins requests only the ticket buyer identity and accepts padded numeric PINs', async () => {
  const oldBase = process.env.LENEXUS_API_URL;
  const oldToken = process.env.NEXUS_BRIDGE_TOKEN;
  const oldFetch = global.fetch;
  process.env.LENEXUS_API_URL = 'https://lenexus.example';
  process.env.NEXUS_BRIDGE_TOKEN = 'isolated-ticket-fixture-token';
  let requestedUrl = '';
  global.fetch = async (url, options) => {
    requestedUrl = String(url);
    assert.equal(options.headers.Authorization, 'Bearer isolated-ticket-fixture-token');
    assert.equal(options.headers['X-Arki-Actor-Id'], '1200000000000000001');
    return new Response(JSON.stringify({ schemaVersion: 1, pins: [{ tribeId: 7, tribeName: 'Tribu test', pin: '0042' }] }), { status: 200 });
  };
  try {
    assert.deepEqual(await fetchTribeVaultPins('1200000000000000001'), {
      pins: [{ tribeId: 7, tribeName: 'Tribu test', pin: '0042' }],
    });
    assert.equal(requestedUrl, 'https://lenexus.example/api/tribes/internal/shop-ticket-vault-pins');
  } finally {
    global.fetch = oldFetch;
    if (oldBase === undefined) delete process.env.LENEXUS_API_URL; else process.env.LENEXUS_API_URL = oldBase;
    if (oldToken === undefined) delete process.env.NEXUS_BRIDGE_TOKEN; else process.env.NEXUS_BRIDGE_TOKEN = oldToken;
  }
});

test('fetchTribeVaultPins fails closed when the bridge is missing or returns malformed PIN data', async () => {
  const oldBase = process.env.LENEXUS_API_URL;
  const oldToken = process.env.NEXUS_BRIDGE_TOKEN;
  const oldFetch = global.fetch;
  process.env.LENEXUS_API_URL = 'https://lenexus.example';
  process.env.NEXUS_BRIDGE_TOKEN = 'isolated-ticket-fixture-token';
  try {
    delete process.env.NEXUS_BRIDGE_TOKEN;
    assert.equal(await fetchTribeVaultPins('1200000000000000001'), null);
    process.env.NEXUS_BRIDGE_TOKEN = 'isolated-ticket-fixture-token';
    global.fetch = async () => new Response(JSON.stringify({
      schemaVersion: 1, pins: [{ tribeId: 7, tribeName: 'Tribu test', pin: '@everyone' }],
    }), { status: 200 });
    assert.equal(await fetchTribeVaultPins('1200000000000000001'), null);
  } finally {
    global.fetch = oldFetch;
    if (oldBase === undefined) delete process.env.LENEXUS_API_URL; else process.env.LENEXUS_API_URL = oldBase;
    if (oldToken === undefined) delete process.env.NEXUS_BRIDGE_TOKEN; else process.env.NEXUS_BRIDGE_TOKEN = oldToken;
  }
});
