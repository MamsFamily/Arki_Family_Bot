const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P } = require('discord.js');
const { SOURCE_CHANNELS } = require('../web/shopDirectory');
const { createShopContentSync, dailySlot } = require('../web/shopContentSync');
const { canReadChannel, normalizeMessage, safeAssetUrl } = require('../web/discordShopContent');

const GUILD = '987654321098765432';
const USER = '333333333333333333';
const BOT = '222222222222222222';
const READ = (P.ViewChannel | P.ReadMessageHistory).toString();
const guild = { id: GUILD, owner_id: '777777777777777777' };
const roles = [{ id: GUILD, permissions: READ }];
const member = id => ({ user: { id }, roles: [] });
const channel = id => ({ id, guild_id: GUILD, name: 'salon-shop', type: 0, permission_overwrites: [] });
const message = (id = '111111111111111111', content = 'Prix : 10 diamants') => ({
  id, content, timestamp: '2026-10-05T00:00:00Z', edited_timestamp: null, embeds: [], attachments: [],
});

function fixture() {
  let clock = Date.parse('2026-10-06T05:00:00Z');
  let locked = false;
  let writesFail = false;
  const rows = new Map();
  const calls = [];
  const failed = new Set();
  const denied = new Set();
  const publications = new Map(SOURCE_CHANNELS.map(s => [s.id, [message()]]));
  const store = {
    getData: async key => structuredClone(rows.get(key) || null),
    setData: async (key, data) => { if (writesFail) return false; rows.set(key, structuredClone(data)); return true; },
  };
  const api = {
    getCurrentUser: async () => ({ id: BOT }),
    getGuild: async () => guild,
    getRoles: async () => roles,
    getMember: async (g, id) => {
      if (![USER, BOT].includes(id)) throw new Error('not a guild member');
      return member(id);
    },
    getChannel: async id => {
      assert.ok(SOURCE_CHANNELS.some(s => s.id === id), 'ticket channels must never be inspected');
      return { ...channel(id), permission_overwrites: denied.has(id)
        ? [{ id: USER, type: 1, deny: P.ViewChannel.toString(), allow: '0' }] : [] };
    },
    getMessages: async (id, before, limit = 100) => {
      calls.push({ id, before });
      if (failed.has(id)) throw new Error('Discord unavailable');
      const all = publications.get(id);
      const filtered = before ? all.filter(m => BigInt(m.id) < BigInt(before)) : all;
      return filtered.slice(0, limit);
    },
  };
  const withLock = async (key, work) => {
    if (locked) return { status: 'busy' };
    locked = true;
    try { return await work(); } finally { locked = false; }
  };
  const options = { getGuildId: () => GUILD, api, store, withLock, now: () => clock };
  return { service: createShopContentSync(options), another: () => createShopContentSync(options),
    calls, publications, failed, denied, rows,
    snapshot: () => structuredClone([...rows.values()][0]),
    advance: ms => { clock += ms; }, failWrites: () => { writesFail = true; } };
}

test('daily slot is 06h Paris and follows summer/winter time', () => {
  assert.equal(dailySlot(Date.parse('2026-10-06T03:59:00Z')), '2026-10-05');
  assert.equal(dailySlot(Date.parse('2026-10-06T04:00:00Z')), '2026-10-06');
  assert.equal(dailySlot(Date.parse('2026-12-06T04:59:00Z')), '2026-12-05');
  assert.equal(dailySlot(Date.parse('2026-12-06T05:00:00Z')), '2026-12-06');
});

test('sync reads exactly the five info channels, once per daily slot', async () => {
  const f = fixture();
  const first = await f.service.refreshIfDue();
  assert.equal(first.successful, 5);
  assert.deepEqual(f.calls.map(c => c.id), SOURCE_CHANNELS.map(s => s.id));
  assert.equal((await f.service.refreshIfDue()).status, 'fresh');
  assert.equal(f.calls.length, 5);
  f.advance(24 * 60 * 60 * 1000);
  assert.equal((await f.service.refreshIfDue()).status, 'updated');
  assert.equal(f.calls.length, 10);
});

test('a fresh full snapshot reflects edits and removals, including a genuinely empty channel', async () => {
  const f = fixture();
  await f.service.refreshIfDue();
  const id = SOURCE_CHANNELS[0].id;
  f.publications.set(id, [message('111111111111111112', 'Nouveau prix : 20 diamants')]);
  f.publications.set(SOURCE_CHANNELS[1].id, []);
  f.advance(24 * 60 * 60 * 1000);
  await f.service.refreshIfDue();
  assert.equal(f.snapshot().channels.infos.messages[0].text, 'Nouveau prix : 20 diamants');
  assert.equal(f.snapshot().channels.infos.messages.length, 1);
  assert.deepEqual(f.snapshot().channels['petit-shop'].messages, []);
});

test('two instances and repeated calls cannot perform duplicate daily synchronizations', async () => {
  const f = fixture();
  const second = f.another();
  await Promise.all([f.service.refreshIfDue(), f.service.refreshIfDue(), second.refreshIfDue()]);
  assert.equal(f.calls.length, 5);
});

test('failed channel retains its last valid content, warns, and retries after one hour', async () => {
  const f = fixture();
  await f.service.refreshIfDue();
  const old = f.snapshot().channels.infos.syncedAt;
  f.advance(24 * 60 * 60 * 1000);
  f.failed.add(SOURCE_CHANNELS[0].id);
  assert.equal((await f.service.refreshIfDue()).status, 'partial');
  assert.equal(f.snapshot().channels.infos.syncedAt, old);
  assert.equal(f.snapshot().channels.infos.messages[0].text, 'Prix : 10 diamants');
  const view = await f.service.getForMember(USER);
  assert.equal(view.channels.infos.status, 'stale');
  assert.ok(view.warning);
  const count = f.calls.length;
  await f.service.refreshIfDue();
  assert.equal(f.calls.length, count);
  f.failed.clear();
  f.advance(60 * 60 * 1000);
  assert.equal((await f.service.refreshIfDue()).status, 'updated');
});

test('current Discord channel denial hides previously cached content, and outsiders see no cache', async () => {
  const f = fixture();
  await f.service.refreshIfDue();
  f.denied.add(SOURCE_CHANNELS[0].id);
  const view = await f.service.getForMember(USER);
  assert.equal(view.channels.infos.status, 'forbidden');
  assert.deepEqual(view.channels.infos.messages, []);
  assert.equal(view.channels.packs.messages.length, 1);
  const outsider = await f.service.getForMember('444444444444444444');
  assert.deepEqual(outsider.channels, {});
  assert.ok(outsider.warning);
});

test('pagination reads older publications and explicitly flags its 500-post limit', async () => {
  const f = fixture();
  f.publications.set(SOURCE_CHANNELS[0].id, Array.from({ length: 501 }, (_, i) =>
    message((999999999999999999n - BigInt(i)).toString(), `Publication ${i}`)));
  await f.service.refreshIfDue();
  assert.equal(f.snapshot().channels.infos.messages.length, 500);
  assert.equal(f.snapshot().channels.infos.truncated, true);
  assert.equal(f.calls.filter(c => c.id === SOURCE_CHANNELS[0].id).length, 6);
});

test('storage failure is explicit and has a short cooldown, without fetching Discord content', async () => {
  const f = fixture();
  f.failWrites();
  await assert.rejects(f.service.refreshIfDue(), /Sauvegarde/);
  assert.equal((await f.service.refreshIfDue()).status, 'cooldown');
  assert.equal(f.calls.length, 0);
});

test('channel permissions respect guild ownership, admin, roles and personal overrides', () => {
  const c = channel(SOURCE_CHANNELS[0].id);
  assert.equal(canReadChannel(c, guild, member(USER), roles), true);
  c.permission_overwrites = [{ id: USER, type: 1, deny: P.ViewChannel.toString(), allow: '0' }];
  assert.equal(canReadChannel(c, guild, member(USER), roles), false);
  assert.equal(canReadChannel(c, guild, member(guild.owner_id), roles), true);
  assert.equal(canReadChannel(c, guild, member(USER), [{ id: GUILD, permissions: P.Administrator.toString() }]), true);
  assert.equal(canReadChannel({ ...c, guild_id: '555555555555555555' }, guild, member(USER), roles), false);
  const roleId = '666666666666666666';
  const roleMember = { user: { id: USER }, roles: [roleId] };
  c.permission_overwrites = [{ id: GUILD, type: 0, deny: READ, allow: '0' },
    { id: roleId, type: 0, deny: '0', allow: READ }];
  assert.equal(canReadChannel(c, guild, roleMember, roles), true);
  c.permission_overwrites.push({ id: USER, type: 1, deny: P.ReadMessageHistory.toString(), allow: '0' });
  assert.equal(canReadChannel(c, guild, roleMember, roles), false);
});

test('normalization keeps real text/embeds and only safe Discord-hosted image/file URLs', () => {
  const raw = message();
  raw.embeds = [{ title: 'Pack A', description: '<script>not HTML</script>',
    fields: [{ name: 'Prix', value: '100 diamants' }],
    image: { url: 'https://tracking.invalid/image.png' } }];
  raw.attachments = [
    { filename: 'pack.png', content_type: 'image/png', url: 'https://cdn.discordapp.com/attachments/a/pack.png' },
    { filename: 'tarifs.pdf', url: 'https://cdn.discordapp.com/attachments/a/tarifs.pdf' },
  ];
  const normalized = normalizeMessage(raw, GUILD, SOURCE_CHANNELS[0].id);
  assert.ok(normalized.text.includes('100 diamants'));
  assert.ok(normalized.text.includes('<script>not HTML</script>'));
  assert.equal(normalized.images.length, 1);
  assert.equal(normalized.files.length, 1);
  assert.equal(safeAssetUrl('javascript:alert(1)'), null);
  assert.equal(safeAssetUrl('https://cdn.discordapp.com.evil.invalid/img.png'), null);
  assert.equal(safeAssetUrl('https://user:pass@cdn.discordapp.com/img.png'), null);
  assert.equal(normalizeMessage({ id: 'invalid' }, GUILD, SOURCE_CHANNELS[0].id), null);
});
