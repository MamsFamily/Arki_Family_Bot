const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, PermissionFlagsBits: P, ButtonStyle } = require('discord.js');
const { createRoleButtonHandler, protectedRoles } = require('../roleButtonCommand');
const commands = require('../commands');

const GUILD = '1200000000000000001';
const ROLE = '1200000000000000002';
const USER = '1200000000000000003';
const BOT = '1200000000000000004';
const ADMIN = '1157044417526509578';
const permissions = bits => new PermissionsBitField(bits);

function fixture({ actorPermissions = [P.ManageRoles], botPermissions = [P.ManageRoles], held = false } = {}) {
  const calls = [];
  const heldRoles = new Set(held ? [ROLE] : []);
  const actorRoles = new Set();
  const role = { id: ROLE, managed: false, permissions: permissions([]) };
  const actor = {
    id: USER, permissions: permissions(actorPermissions),
    roles: { highest: { comparePositionTo: () => 1 }, cache: { has: id => actorRoles.has(id) } },
  };
  const member = {
    roles: {
      cache: { has: id => heldRoles.has(id) },
      add: async id => { calls.push(['add', id]); heldRoles.add(id); },
      remove: async id => { calls.push(['remove', id]); heldRoles.delete(id); },
    },
  };
  const bot = { permissions: permissions(botPermissions), roles: { highest: { comparePositionTo: () => 1 } } };
  const channel = {
    guildId: GUILD, isTextBased: () => true, isSendable: () => true, isThread: () => false,
    permissionsFor: () => permissions([P.ViewChannel, P.SendMessages]),
    send: async data => { calls.push(['send', data]); return { url: 'https://discord.com/channels/test/message' }; },
  };
  const guild = {
    id: GUILD, ownerId: 'owner',
    roles: { fetch: async (id, options) => { calls.push(['fetchRole', id, options]); return role; } },
    members: {
      fetch: async options => { calls.push(['fetchMember', options]); return options.user === USER && state.command ? actor : member; },
      fetchMe: async options => { calls.push(['fetchBot', options]); return bot; },
    },
  };
  const settings = { serverPanel: { adminRoleIds: [ADMIN] } };
  const options = { message: 'Clique pour les annonces !', role, bouton: 'Annonces', couleur: 'vert', emoji: '🔔' };
  const state = { command: false };
  const handler = createRoleButtonHandler({ getSettings: () => settings });
  function interaction(command = false) {
    state.command = command;
    const i = {
      guildId: GUILD, guild, channel, user: { id: USER }, client: { user: { id: BOT } },
      commandName: command ? 'bouton-role' : undefined,
      customId: `selfrole:v1:${GUILD}:${ROLE}`,
      message: { author: { id: BOT } },
      deferred: false, replied: false,
      isChatInputCommand: () => command, isButton: () => !command,
      options: {
        getString: name => options[name] || null, getRole: () => options.role, getChannel: () => options.salon || null,
      },
      reply: async data => { i.replied = true; calls.push(['reply', data]); },
      deferReply: async data => { i.deferred = true; calls.push(['defer', data]); },
      editReply: async data => { calls.push(['edit', data]); },
    };
    return i;
  }
  return { handler, interaction, calls, role, bot, actor, actorRoles, member, heldRoles, settings, channel, guild, options };
}

test('slash schema exposes message, role, label, color, emoji and target channel within Discord limits', () => {
  const command = commands.find(c => c.name === 'bouton-role');
  assert.equal(command.dm_permission, false);
  assert.deepEqual(command.options.map(o => o.name), ['message', 'role', 'bouton', 'couleur', 'emoji', 'salon']);
  assert.ok(command.description.length <= 100);
  assert.equal(command.options.find(o => o.name === 'bouton').max_length, 80);
  assert.equal(command.options.find(o => o.name === 'message').max_length, 2000);
  for (const option of command.options) assert.ok(option.description.length <= 100);
});

test('publishing creates a custom message/button without mentions and acknowledges privately', async () => {
  const f = fixture();
  f.options.message = 'Bonjour !\\nAbonne-toi aux annonces.';
  assert.equal(await f.handler.handle(f.interaction(true)), true);
  const sent = f.calls.find(c => c[0] === 'send')[1];
  assert.equal(sent.content, 'Bonjour !\nAbonne-toi aux annonces.');
  assert.deepEqual(sent.allowedMentions, { parse: [] });
  const button = sent.components[0].toJSON().components[0];
  assert.equal(button.label, 'Annonces');
  assert.equal(button.style, ButtonStyle.Success);
  assert.equal(button.emoji.name, '🔔');
  assert.equal(button.custom_id, `selfrole:v1:${GUILD}:${ROLE}`);
  assert.equal(f.calls[0][0], 'defer');
  assert.equal(f.calls[0][1].ephemeral, true);
  assert.match(f.calls.at(-1)[1].content, /Message publié/);
});

test('default button works and optional destination is used', async () => {
  const f = fixture();
  f.options.bouton = null; f.options.couleur = null; f.options.emoji = null;
  let posted;
  f.options.salon = { ...f.channel, send: async data => { posted = data; return { url: 'link' }; } };
  await f.handler.handle(f.interaction(true));
  assert.equal(posted.components[0].toJSON().components[0].label, 'Prendre / retirer le rôle');
  assert.equal(posted.components[0].toJSON().components[0].style, ButtonStyle.Primary);
});

test('configured admin role can publish without Discord Administrator permission', async () => {
  const f = fixture({ actorPermissions: [] });
  f.actorRoles.add(ADMIN);
  await f.handler.handle(f.interaction(true));
  assert.ok(f.calls.some(c => c[0] === 'send'));
});

test('ordinary players cannot publish role panels', async () => {
  const f = fixture({ actorPermissions: [] });
  await f.handler.handle(f.interaction(true));
  assert.ok(!f.calls.some(c => c[0] === 'send'));
  assert.match(f.calls.at(-1)[1].content, /réservée/);
});

test('first click adds, next click removes only the role belonging to the clicking player', async () => {
  const f = fixture();
  await f.handler.handle(f.interaction());
  assert.equal(f.heldRoles.has(ROLE), true);
  assert.match(f.calls.at(-1)[1].content, /ajouté/);
  await f.handler.handle(f.interaction());
  assert.equal(f.heldRoles.has(ROLE), false);
  assert.match(f.calls.at(-1)[1].content, /retiré/);
  assert.deepEqual(f.calls.filter(c => ['add', 'remove'].includes(c[0])), [['add', ROLE], ['remove', ROLE]]);
  assert.ok(f.calls.filter(c => c[0] === 'fetchMember').every(c => c[1].force && c[1].user === USER));
  assert.ok(f.calls.filter(c => c[0] === 'defer').every(c => c[1].ephemeral));
});

test('existing messages still toggle after a new handler instance (restart)', async () => {
  const f = fixture({ held: true });
  const restarted = createRoleButtonHandler({ getSettings: () => f.settings });
  await restarted.handle(f.interaction());
  assert.equal(f.heldRoles.has(ROLE), false);
});

for (const scenario of ['everyone', 'managed', 'admin-permission', 'staff-role', 'bot-hierarchy', 'no-manage-roles']) {
  test(`unsafe role configuration is refused both at publication and click: ${scenario}`, async () => {
    const f = fixture();
    if (scenario === 'everyone') f.role.id = GUILD;
    if (scenario === 'managed') f.role.managed = true;
    if (scenario === 'admin-permission') f.role.permissions = permissions([P.Administrator]);
    if (scenario === 'staff-role') f.settings.spawnTicket = { staffRoleIds: [ROLE] };
    if (scenario === 'bot-hierarchy') f.bot.roles.highest.comparePositionTo = () => 0;
    if (scenario === 'no-manage-roles') f.bot.permissions = permissions([]);
    await f.handler.handle(f.interaction(true));
    await f.handler.handle(f.interaction());
    assert.ok(!f.calls.some(c => ['send', 'add', 'remove'].includes(c[0])));
  });
}

test('a role made privileged after publication cannot be self-assigned', async () => {
  const f = fixture();
  await f.handler.handle(f.interaction(true));
  f.role.permissions = permissions([P.ManageRoles]);
  await f.handler.handle(f.interaction());
  assert.ok(!f.calls.some(c => c[0] === 'add'));
  assert.match(f.calls.at(-1)[1].content, /sensibles/);
});

test('publisher cannot choose a role above their own or publish into an inaccessible channel', async () => {
  const f = fixture();
  f.actor.roles.highest.comparePositionTo = () => -1;
  await f.handler.handle(f.interaction(true));
  assert.match(f.calls.at(-1)[1].content, /en dessous/);
  f.actor.roles.highest.comparePositionTo = () => 1;
  f.channel.permissionsFor = () => permissions([]);
  await f.handler.handle(f.interaction(true));
  assert.match(f.calls.at(-1)[1].content, /voir ce salon/);
  assert.ok(!f.calls.some(c => c[0] === 'send'));
});

test('cross-guild buttons and messages not authored by this bot are rejected', async () => {
  const f = fixture();
  const i = f.interaction(); i.message.author.id = 'other-bot';
  await f.handler.handle(i);
  const j = f.interaction(); j.customId = `selfrole:v1:1200000000000000009:${ROLE}`;
  await f.handler.handle(j);
  assert.ok(!f.calls.some(c => ['add', 'remove', 'fetchRole'].includes(c[0])));
});

test('deleted roles give an explicit private error', async () => {
  const f = fixture();
  f.guild.roles.fetch = async () => null;
  await f.handler.handle(f.interaction());
  assert.match(f.calls.at(-1)[1].content, /n’existe plus/);
  assert.ok(!f.calls.some(c => c[0] === 'add'));
});

test('overlapping clicks are rejected while a change is in flight', async () => {
  const f = fixture();
  let release;
  let started;
  const pending = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  f.member.roles.add = async () => { started(); await pending; f.heldRoles.add(ROLE); };
  const first = f.handler.handle(f.interaction());
  await entered;
  await f.handler.handle(f.interaction());
  assert.match(f.calls.at(-1)[1].content, /déjà en cours/);
  release();
  await first;
  assert.equal(f.heldRoles.has(ROLE), true);
});

test('API failures do not claim success or leave a permanent busy lock', async () => {
  const f = fixture();
  f.member.roles.add = async () => { throw Object.assign(new Error('Missing permissions'), { code: 50013 }); };
  await f.handler.handle(f.interaction());
  assert.match(f.calls.at(-1)[1].content, /Impossible/);
  f.member.roles.add = async id => f.heldRoles.add(id);
  await f.handler.handle(f.interaction());
  assert.match(f.calls.at(-1)[1].content, /ajouté/);
});

test('DMs and unrelated interactions are handled without changing roles', async () => {
  const f = fixture();
  const i = f.interaction(); i.guildId = null; i.guild = null;
  await f.handler.handle(i);
  assert.match(f.calls.at(-1)[1].content, /uniquement dans un serveur/);
  const j = f.interaction(true); j.commandName = 'other-command';
  assert.equal(await f.handler.handle(j), false);
});

test('invalid content or emoji fails before publishing', async () => {
  for (const overrides of [{ message: ' ' }, { bouton: 'x'.repeat(81) }, { emoji: 'not-an-emoji' }, { couleur: 'inconnue' }]) {
    const f = fixture();
    Object.assign(f.options, overrides);
    await f.handler.handle(f.interaction(true));
    assert.ok(!f.calls.some(c => c[0] === 'send'));
  }
});

test('privileged role IDs are collected from configured staff and moderator settings', () => {
  assert.ok(protectedRoles({ votes: { modoRoleId: ROLE } }).has(ROLE));
  assert.ok(protectedRoles({ tickets: { staffRoleIds: [ROLE] } }).has(ROLE));
});
