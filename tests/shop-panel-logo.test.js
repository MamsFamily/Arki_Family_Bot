const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { publishShopTicketPanel } = require('../shopTicketCommand');

test('shop panel uses the supplied building as its thumbnail and preserves its buttons', async () => {
  let panel;
  let confirmation;
  await publishShopTicketPanel({
    channel: { send: async payload => { panel = payload; } },
    reply: async payload => { confirmation = payload; },
  });
  const embed = panel.embeds[0].toJSON();
  assert.equal(embed.title, '🛒 Shop Arki Family');
  assert.equal(embed.thumbnail.url, 'attachment://shop-ticket-logo.png');
  assert.equal(embed.image, undefined);
  assert.equal(panel.files[0].name, 'shop-ticket-logo.png');
  const image = fs.readFileSync(panel.files[0].attachment);
  assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(image.length < 8 * 1024 * 1024);
  assert.deepEqual(panel.components[0].toJSON().components.map(button => button.custom_id),
    ['st_open_ticket_shop', 'st_view_shop_map']);
  assert.equal(confirmation.ephemeral, true);
});
