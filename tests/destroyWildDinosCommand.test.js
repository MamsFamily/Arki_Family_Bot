const test = require('node:test');
const assert = require('node:assert/strict');
const { createDestroyWildDinosHandler } = require('../destroyWildDinosCommand');
const { MAPS } = require('../web/legionManager');

function setup() {
  const sent = [];
  const handler = createDestroyWildDinosHandler({
    legion: {
      MAPS,
      assertMap(id) {
        if (!MAPS.some(map => map.id === id)) throw new Error('Carte non autorisée');
      },
    },
    journal: {
      async execute(id, type, origin, actor) {
        sent.push({ id, type, origin, actor });
        return { id, ok: true };
      },
    },
    getSettings: () => ({ serverPanel: { adminRoleIds: ['admin-role'] } }),
  });
  return { handler, sent };
}

function interaction(kind, { userId = 'author', roles = ['admin-role'], selected = MAPS[0].id,
  customId = '', admin = false, guildId = 'guild' } = {}) {
  const messages = [];
  return {
    commandName: kind === 'command' ? 'destroywilddinos' : '',
    customId,
    guildId,
    user: { id: userId },
    member: { roles: { cache: { has: id => roles.includes(id) } } },
    memberPermissions: { has: () => admin },
    options: { getString: () => selected },
    isChatInputCommand: () => kind === 'command',
    isButton: () => kind === 'button',
    messages,
    async reply(value) { messages.push({ method: 'reply', value }); },
    async update(value) { messages.push({ method: 'update', value }); },
    async deferUpdate() { messages.push({ method: 'deferUpdate' }); },
    async editReply(value) { messages.push({ method: 'editReply', value }); },
  };
}

function confirmId(command) {
  return command.messages[0].value.components[0].toJSON().components[0].custom_id;
}

test('refuse un membre sans rôle admin, sans envoyer de commande', async () => {
  const { handler, sent } = setup();
  const request = interaction('command', { roles: [] });
  assert.equal(await handler.handle(request), true);
  assert.equal(request.messages[0].value.ephemeral, true);
  assert.equal(sent.length, 0);
});

test('la confirmation privée envoie une seule commande et journalise son origine Discord', async () => {
  const { handler, sent } = setup();
  const request = interaction('command');
  await handler.handle(request);
  assert.equal(sent.length, 0);
  assert.equal(request.messages[0].value.ephemeral, true);
  const customId = confirmId(request);
  const button = interaction('button', { customId });
  await handler.handle(button);
  assert.deepEqual(sent, [{ id: MAPS[0].id, type: 'wild_dinos', origin: 'discord', actor: 'author' }]);
  assert.match(button.messages.at(-1).value.content, /acceptée\(s\) par GPanel/);
  await handler.handle(interaction('button', { customId }));
  assert.equal(sent.length, 1);
});

test('« toutes » cible exclusivement les 12 cartes approuvées', async () => {
  const { handler, sent } = setup();
  const request = interaction('command', { selected: 'all', roles: [], admin: true });
  await handler.handle(request);
  assert.equal(sent.length, 0);
  await handler.handle(interaction('button', { customId: confirmId(request), roles: [], admin: true }));
  assert.deepEqual(sent.map(result => result.id), MAPS.map(map => map.id));
});

test('refuse une carte inconnue et une confirmation par une autre personne', async () => {
  const { handler, sent } = setup();
  const invalid = interaction('command', { selected: 'serveur-essai' });
  await handler.handle(invalid);
  assert.match(invalid.messages[0].value.content, /non autorisée/);
  const request = interaction('command');
  await handler.handle(request);
  const customId = confirmId(request);
  const other = interaction('button', { customId, userId: 'other' });
  await handler.handle(other);
  assert.match(other.messages[0].value.content, /autre administrateur/);
  await handler.handle(interaction('button', { customId: customId.replace('confirm:', 'cancel:') }));
  assert.equal(sent.length, 0);
});