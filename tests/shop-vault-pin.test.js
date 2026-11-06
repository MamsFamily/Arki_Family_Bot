const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fetchTribeVaultPins, getTribeManageUrl, getMissingTribePinMessage } = require('../shopTicketCommand');

test('missing PIN links directly to the correct tribe on the public player site', () => {
  assert.equal(getTribeManageUrl(122), 'https://arki-identite.replit.app/tribus/122#pin-coffres');
  assert.equal(getTribeManageUrl(7), 'https://arki-identite.replit.app/tribus/7#pin-coffres');
  const message = getMissingTribePinMessage({ tribeId: 122, tribeName: 'Tribu test', pin: null });
  assert.match(message, /Renseigne le code PIN de tes coffres/);
  assert.match(message, /Tribu test/);
  assert.ok(message.includes('https://arki-identite.replit.app/tribus/122#pin-coffres'));
  assert.doesNotMatch(message, /\/gerer/);
});

test('no associated tribe uses the tribe directory instead of another player’s tribe', () => {
  const message = getMissingTribePinMessage();
  assert.match(message, /Retrouve ou crée ta fiche tribu/);
  assert.ok(message.endsWith('https://arki-identite.replit.app/tribus'));
  for (const id of [undefined, null, 0, -1, '122/gerer', '122#other', 'bad']) {
    assert.equal(getTribeManageUrl(id), 'https://arki-identite.replit.app/tribus');
  }
});

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
