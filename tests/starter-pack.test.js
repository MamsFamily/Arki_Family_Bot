const test = require('node:test');
const assert = require('node:assert/strict');
const { createStarterPackHandler } = require('../starter-pack/discordCommand');
const { requireEosId, requireMap, PACK_VERSION, isDeliveryEnabled, requestClaim, takeClaim } = require('../starter-pack/service');

function interaction(subcommand = 'lier') {
  const replies = [];
  return {
    commandName: 'starterpack',
    guildId: '123456789012345678',
    user: { id: '123456789012345678' },
    options: { getSubcommand: () => subcommand },
    isChatInputCommand: () => true,
    reply: async message => replies.push(message),
    deferReply: async message => replies.push(message),
    editReply: async message => replies.push(message),
    replies,
  };
}

test('starter pack defaults to closed even if the command handler is called', async () => {
  let touched = false;
  const handler = createStarterPackHandler({
    enabled: () => false,
    service: { issueCode: () => { touched = true; } },
  });
  const i = interaction();
  assert.equal(await handler.handle(i), true);
  assert.equal(touched, false);
  assert.match(i.replies[0].content, /préparation/);
});

test('linking displays a private one-time code but only after activation', async () => {
  const handler = createStarterPackHandler({
    enabled: () => true,
    service: {
      getStatus: async () => ({ linked: false }),
      issueCode: async () => ({ code: 'ABCDEFGH23', expiresInMinutes: 10 }),
    },
  });
  const i = interaction();
  await handler.handle(i);
  assert.equal(i.replies[0].ephemeral, true);
  assert.match(i.replies[1], /ABCDEFGH23/);
});

test('delivery cannot be requested while the mod has not been validated', async () => {
  let touched = false;
  const handler = createStarterPackHandler({
    enabled: () => true,
    deliveryEnabled: () => false,
    service: { requestClaim: () => { touched = true; } },
  });
  const i = interaction('recevoir');
  await handler.handle(i);
  assert.equal(touched, false);
  assert.match(i.replies[1], /pas encore activée/);
});

test('only validated EOS format and approved cluster maps can be used', () => {
  assert.equal(requireEosId('A'.repeat(32)), 'a'.repeat(32));
  assert.throws(() => requireEosId('a'.repeat(31)), /EOS invalide/);
  assert.throws(() => requireEosId('a'.repeat(31) + 'x'), /EOS invalide/);
  assert.throws(() => requireMap('serveur-test'), /non autorisée/);
  assert.equal(typeof PACK_VERSION, 'string');
});

test('even environment flags cannot start delivery before the pack is validated in DevKit', async () => {
  const previousLink = process.env.STARTER_PACK_LINK_ENABLED;
  const previousDelivery = process.env.STARTER_PACK_DELIVERY_ENABLED;
  try {
    process.env.STARTER_PACK_LINK_ENABLED = 'true';
    process.env.STARTER_PACK_DELIVERY_ENABLED = 'true';
    assert.equal(isDeliveryEnabled(), false);
    await assert.rejects(requestClaim('123456789012345678'), /non validée/);
    await assert.rejects(takeClaim('a'.repeat(32), '9e151580', PACK_VERSION), /non validée/);
  } finally {
    if (previousLink === undefined) delete process.env.STARTER_PACK_LINK_ENABLED;
    else process.env.STARTER_PACK_LINK_ENABLED = previousLink;
    if (previousDelivery === undefined) delete process.env.STARTER_PACK_DELIVERY_ENABLED;
    else process.env.STARTER_PACK_DELIVERY_ENABLED = previousDelivery;
  }
});