const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const { createMemberShop, buildShopDirectory, getMember } = require('../web/memberShop');

const GUILD = '987654321098765432';
const CHANNELS = ['1485051049654878379', '1485051177845657771', '1485051269977739334',
  '1485051399589855382', '1156938232244752494', '1160538476224196628', '1156938293586427934'];

// Exercise the actual dashboard guard, not a permissive substitute.
const serverSource = fs.readFileSync(require.resolve('../web/server'), 'utf8');
const guardSource = serverSource.slice(serverSource.indexOf('  function requireAuth('),
  serverSource.indexOf('  function requireAdmin('));
const requireAuth = new Function('isApiRequest', `${guardSource}; return requireAuth;`)(req => req.path.startsWith('/api/'));

async function fixture(t, { guild = GUILD, profile = {}, oauthFails = false } = {}) {
  let clock = 1000000;
  let generation = 1;
  const calls = [];
  const store = new session.MemoryStore();
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.resolve(__dirname, '../web/views'));
  app.use(express.urlencoded({ extended: false }));
  app.use(session({ secret: 'unit-test-only-not-production', store, resave: false, saveUninitialized: false }));
  const memberShop = createMemberShop({
    getGuildId: () => guild,
    getBaseUrl: () => 'https://example.invalid',
    getSessionGeneration: async () => generation,
    now: () => clock,
    getOAuthConfig: () => ({ clientId: 'fixture-client', clientSecret: 'fixture-secret' }),
    axiosClient: {
      post: async (url, body, options) => {
        calls.push({ method: 'post', url, body, options });
        if (oauthFails) throw new Error('fixture provider failure');
        return { data: { access_token: 'fixture-access-token' } };
      },
      get: async (url, options) => {
        calls.push({ method: 'get', url, options });
        return { data: { id: '123456789012345678', username: 'joueur-test', global_name: 'Survivant', ...profile } };
      },
    },
  });
  app.use('/boutique', memberShop.router);
  app.get('/auth/discord/callback', memberShop.handleOAuthCallback, (req, res) => res.status(400).send('staff-flow'));
  app.get('/api/admin-probe', requireAuth, (req, res) => res.json({ admin: true }));
  app.post('/fixture/staff-state', (req, res) => {
    req.session.pendingRole = 'admin';
    req.session.oauthState = 'fixture-staff-state';
    res.send('ok');
  });
  const server = await new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  let cookie = '';
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(url, options = {}) {
    const response = await fetch(base + url, {
      ...options, redirect: 'manual', headers: { Cookie: cookie, ...options.headers },
    });
    const newCookie = response.headers.get('set-cookie');
    if (newCookie) cookie = newCookie.split(';')[0];
    return response;
  }
  async function start() {
    const response = await request('/boutique/auth/discord');
    assert.equal(response.status, 302);
    const url = new URL(response.headers.get('location'));
    return url.searchParams.get('state');
  }
  async function signIn() {
    const state = await start();
    const oldCookie = cookie;
    const response = await request('/auth/discord/callback?' + new URLSearchParams({ state, code: 'fixture-code' }));
    assert.equal(response.headers.get('location'), '/boutique');
    assert.notEqual(cookie, oldCookie, 'sign-in must rotate the session ID');
    return state;
  }
  return { request, start, signIn, calls, store,
    advance: ms => { clock += ms; }, revoke: () => { generation++; } };
}

test('all seven supplied channel IDs form exact links without numeric precision loss', () => {
  const directory = buildShopDirectory(GUILD);
  const urls = [...directory.categories.map(c => c.url), directory.orderUrl,
    directory.donations.infoUrl, directory.donations.ticketUrl];
  assert.deepEqual(urls, CHANNELS.map(id => `https://discord.com/channels/${GUILD}/${id}`));
  for (const badGuild of ['', undefined, 12345, 'https://evil.invalid']) assert.throws(() => buildShopDirectory(badGuild));
  assert.equal(getMember({ authenticated: true, discordUser: { id: 'dashboard-direct-admin' } }), null);
});

test('anonymous visitors cannot read shop categories, donation links or destination IDs', async t => {
  const f = await fixture(t);
  const response = await f.request('/boutique');
  assert.equal(response.headers.get('location'), '/boutique/connexion');
  const login = await (await f.request('/boutique/connexion')).text();
  assert.ok(login.includes('Continuer avec Discord'));
  for (const id of CHANNELS) assert.ok(!login.includes(id));
  assert.ok(!login.includes('Informations sur les dons'));
  assert.ok(!login.includes('Dino shop'));
});

test('Discord sign-in uses identify scope and the existing callback, never grants dashboard access', async t => {
  const f = await fixture(t);
  await f.signIn();
  assert.equal(f.calls[0].body.get('redirect_uri'), 'https://example.invalid/auth/discord/callback');
  assert.equal(f.calls[0].options.timeout, 10000);
  const api = await f.request('/api/admin-probe');
  assert.equal(api.status, 401);
  const saved = Object.values(f.store.sessions).map(JSON.parse).find(s => s.shopDiscordUser);
  assert.equal(saved.authenticated, undefined);
  assert.equal(saved.role, undefined);
  assert.equal(saved.discordUser, undefined);
  assert.ok(!JSON.stringify(saved).includes('fixture-access-token'));
  const html = await (await f.request('/boutique')).text();
  for (const id of CHANNELS) assert.ok(html.includes(id));
  assert.ok(html.includes('Passer commande au shop'));
  assert.ok(html.includes('Ouvrir un ticket dons'));
  assert.ok(html.includes('<details class="shop-map-details">'));
  assert.ok(!html.includes('<details class="shop-map-details" open'));
});

test('forged and expired OAuth states never call the provider', async t => {
  const f = await fixture(t);
  await f.start();
  let response = await f.request('/auth/discord/callback?code=fixture-code&state=forged');
  assert.ok(response.headers.get('location').startsWith('/boutique/connexion?error='));
  const state = await f.start();
  f.advance(600001);
  response = await f.request('/auth/discord/callback?' + new URLSearchParams({ state, code: 'fixture-code' }));
  assert.ok(response.headers.get('location').startsWith('/boutique/connexion?error='));
  assert.equal(f.calls.length, 0);
});

test('consumed OAuth states are not replayable', async t => {
  const f = await fixture(t);
  const state = await f.signIn();
  const count = f.calls.length;
  await f.request('/auth/discord/callback?' + new URLSearchParams({ state, code: 'fixture-code' }));
  assert.equal(f.calls.length, count);
});

test('pending staff/admin OAuth remains independent of member OAuth', async t => {
  const f = await fixture(t);
  await f.request('/fixture/staff-state', { method: 'POST' });
  await f.start();
  const response = await f.request('/auth/discord/callback?code=fixture-code&state=fixture-staff-state');
  assert.equal(await response.text(), 'staff-flow');
  assert.equal(f.calls.length, 0);
});

test('profile text is escaped and missing guild configuration fails explicitly', async t => {
  const f = await fixture(t, { guild: '', profile: { global_name: '<script>alert(1)</script>' } });
  await f.signIn();
  const response = await f.request('/boutique');
  assert.equal(response.status, 503);
  const html = await response.text();
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('Les liens Discord ne sont pas encore configurés'));
  assert.ok(!html.includes('discord.com/channels/'));
});

test('logout is CSRF-protected and removes member access', async t => {
  const f = await fixture(t);
  await f.signIn();
  const denied = await f.request('/boutique/deconnexion', { method: 'POST' });
  assert.equal(denied.status, 403);
  const html = await (await f.request('/boutique')).text();
  const csrfToken = html.match(/name="csrfToken" value="([a-f0-9]{64})"/)[1];
  const response = await f.request('/boutique/deconnexion', { method: 'POST', body: new URLSearchParams({ csrfToken }) });
  assert.equal(response.headers.get('location'), '/boutique/connexion');
  assert.equal((await f.request('/boutique')).headers.get('location'), '/boutique/connexion');
});

test('global session revocation also invalidates member sessions', async t => {
  const f = await fixture(t);
  await f.signIn();
  f.revoke();
  const response = await f.request('/boutique');
  assert.ok(response.headers.get('location').startsWith('/boutique/connexion?error='));
  assert.equal((await f.request('/boutique')).headers.get('location'), '/boutique/connexion');
});

test('provider failure gives a safe error without granting any identity', async t => {
  const f = await fixture(t, { oauthFails: true });
  const state = await f.start();
  const response = await f.request('/auth/discord/callback?' + new URLSearchParams({ state, code: 'fixture-code' }));
  assert.ok(response.headers.get('location').startsWith('/boutique/connexion?error='));
  assert.equal((await f.request('/api/admin-probe')).status, 401);
});
