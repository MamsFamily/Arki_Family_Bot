const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { MessageFlags } = require('discord.js');
const { SHOP_MAP_BUTTON_ID, SHOP_MAP_FILENAME, SHOP_MAP_PATH,
  buildShopMapButton, buildShopMapRow, showShopMap } = require('../shopMap');

function interactionFixture() {
  const calls = [];
  return {
    calls, customId: SHOP_MAP_BUTTON_ID,
    deferReply: async payload => { calls.push({ method: 'defer', payload }); },
    editReply: async payload => { calls.push({ method: 'edit', payload }); },
  };
}

test('map button and row use the stateless routed action', () => {
  assert.equal(buildShopMapButton().toJSON().custom_id, SHOP_MAP_BUTTON_ID);
  assert.equal(buildShopMapRow().toJSON().components.length, 1);
  const index = fs.readFileSync(require.resolve('../index.js'), 'utf8');
  assert.ok(index.includes("id === 'st_view_shop_map'"));
});

test('map is deferred privately before file access and attached only on request', async () => {
  const interaction = interactionFixture();
  await showShopMap(interaction, { access: async file => {
    assert.equal(file, SHOP_MAP_PATH);
    assert.equal(interaction.calls[0].payload.flags, MessageFlags.Ephemeral);
  } });
  const payload = interaction.calls[1].payload;
  assert.equal(payload.files[0].attachment, SHOP_MAP_PATH);
  assert.equal(payload.files[0].name, SHOP_MAP_FILENAME);
  assert.equal(payload.embeds[0].toJSON().image.url, `attachment://${SHOP_MAP_FILENAME}`);
  assert.ok(fs.statSync(SHOP_MAP_PATH).size < 8 * 1024 * 1024);
});

test('missing map gives an explicit private error without a broken attachment', async () => {
  const interaction = interactionFixture();
  await showShopMap(interaction, { access: async () => { throw new Error('ENOENT'); } });
  assert.equal(interaction.calls[0].payload.flags, MessageFlags.Ephemeral);
  assert.match(interaction.calls[1].payload.content, /indisponible/);
  assert.equal(interaction.calls[1].payload.files, undefined);
});

test('real shop handler displays the map without requiring a user cart or order', async () => {
  const interaction = interactionFixture();
  await require('../shopTicketCommand').handleShopTicketInteraction(interaction);
  assert.equal(interaction.calls.length, 2);
  assert.equal(interaction.calls[1].payload.files[0].name, SHOP_MAP_FILENAME);
});

test('map stays in its own ticket message and is also available on the public panel', () => {
  const source = fs.readFileSync(require.resolve('../shopTicketCommand'), 'utf8');
  assert.ok(source.includes('components: [buildShopMapRow()]'));
  assert.ok(source.includes('addComponents(btn, buildShopMapButton())'));
});
