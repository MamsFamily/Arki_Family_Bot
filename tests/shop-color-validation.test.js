const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { planColorCredits, createShopColorRewards } = require('../shopColorRewards');

const source = fs.readFileSync(require.resolve('../shopTicketCommand.js'), 'utf8');
const start = source.indexOf('async function handleAdminValidate(');
const end = source.indexOf('\n// ── Joueur : roulette inventaire', start);
if (start < 0 || end < 0) throw new Error('Could not extract shop validation functions');
const extracted = source.slice(start, end);

const catalog = [{ id: 'custom-color-item', name: 'Couleur', emoji: '🖌️' }];

function fixture({
  order = pendingOrder(),
  failCredits = false,
  failPayment = false,
  beforeRemove = async () => {},
} = {}) {
  const calls = { debits: [], credits: [], saves: [], ticket: [], report: [], replies: [], edits: [] };
  const receipts = new Map();
  const interaction = {
    user: { id: 'admin-42', username: 'Admin' },
    member: { displayName: 'Admin' },
    channelId: 'ticket-1',
    channel: {
      id: 'ticket-1',
      send: async message => { calls.ticket.push(message); },
    },
    guild: {
      channels: {
        fetch: async () => ({ send: async message => { calls.report.push(message); } }),
      },
    },
    message: { edit: async payload => { calls.edits.push(payload); } },
    deferReply: async () => { calls.deferred = true; },
    editReply: async payload => { calls.edits.push(payload); return payload; },
    reply: async payload => { calls.replies.push(payload); return payload; },
  };
  const validatingOrders = new Set();
  const service = createShopColorRewards({
    inventory: {
      getItemTypes: () => catalog,
      applyInventoryCredits: async (playerId, credits, adminId, reason, options) => {
        calls.credits.push({ playerId, credits, adminId, reason, options });
        if (receipts.has(options.idempotencyKey)) return receipts.get(options.idempotencyKey);
        if (failCredits) throw new Error('inventory write rejected');
        const result = {
          transactions: credits.map(credit => ({ ...credit, playerId, adminId, reason })),
        };
        receipts.set(options.idempotencyKey, result);
        return result;
      },
    },
    store: {
      saveShopOrder: async savedOrder => {
        calls.saves.push(JSON.parse(JSON.stringify(savedOrder)));
      },
    },
    settings: { getSettings: () => ({ guild: { inventoryLogChannelId: 'inventory-log' } }) },
  });
  const context = {
    validatingOrders,
    getOrReloadOrder: async () => order,
    getItemTypes: () => catalog,
    planColorCredits,
    deliverShopColors: service.deliver,
    isColorDeliveryComplete: require('../shopColorRewards').isColorDeliveryComplete,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    calcCartTotal: items => ({
      totalDiamonds: items.reduce((sum, item) => sum + (item.priceDiamonds || 0) * (item.quantity || 1), 0),
      totalStrawberries: items.reduce((sum, item) => sum + (item.priceStrawberries || 0) * (item.quantity || 1), 0),
    }),
    formatPrice: (diamonds, strawberries) => `${diamonds} diamants / ${strawberries} fraises`,
    getPlayerInventory: () => ({ diamants: 1000, fraises: 1000 }),
    removeFromInventory: async (...args) => {
      await beforeRemove();
      calls.debits.push(args);
      if (failPayment) throw new Error('payment removal failed');
    },
    pgStore: { saveShopOrder: async savedOrder => { calls.saves.push(JSON.parse(JSON.stringify(savedOrder))); } },
    getSettings: () => ({ guild: { inventoryLogChannelId: 'inventory-log' } }),
    console: { error() {}, warn() {} },
  };
  const funcs = new Function(...Object.keys(context), `${extracted}\nreturn { handleAdminValidate, validateAndDeliverOrder, buildPostValidationRow };`)(...Object.values(context));
  return { ...funcs, calls, interaction, order, validatingOrders, receipts };
}

function pendingOrder(items = [{ id: 'color-pack', type: 'pack', name: 'Pack de 10 couleurs', quantity: 1 }], paymentChoice = { id: 'direct' }) {
  return {
    orderId: 'order-123',
    status: 'pending',
    userId: 'player-7',
    channelId: 'ticket-1',
    cart: { items },
    discount: 0,
    discountRoleName: '',
    paymentChoice,
  };
}

test('pack de 10 et pack de 1 selectedOption sont crédités seulement après paiement', async () => {
  const order = pendingOrder([
    { id: 'pack-ten', type: 'pack', name: 'Pack de 10 couleurs', quantity: 2 },
    { id: 'pack-one', type: 'pack', name: 'Pack de 10 couleurs', selectedOption: 'Une couleur', quantity: 1 },
  ]);
  const h = fixture({ order });

  assert.equal(h.calls.credits.length, 0);
  await h.handleAdminValidate(h.interaction, order.orderId);

  assert.equal(order.status, 'paid');
  assert.deepEqual(order.shopColorCredits, [{
    itemTypeId: 'custom-color-item', quantity: 21, name: 'Couleur', emoji: '🖌️',
  }]);
  assert.equal(h.calls.debits.length, 0);
  assert.equal(h.calls.credits.length, 1);
  assert.deepEqual(h.calls.credits[0].credits, [{ itemTypeId: 'custom-color-item', quantity: 21 }]);
  assert.equal(h.calls.ticket.filter(message => message.content?.includes('a ajouté')).length, 1);
  assert.equal(h.calls.report.filter(message => message.content?.includes('a ajouté')).length, 1);
});

test('un paiement multi utilise sa sélection et crédite le pack couleur après les retraits', async () => {
  const order = pendingOrder([
    { id: 'color-one', type: 'pack', name: 'Pack de 10 couleurs', selectedOption: 'Une couleur' },
  ], { id: 'multi', selectedDeductions: [{ inventoryId: 'jetons', usedQty: 1, label: 'Jetons (1)' }] });
  const h = fixture({ order });
  await h.handleAdminValidate(h.interaction, order.orderId);

  assert.equal(order.status, 'paid');
  assert.equal(h.calls.debits.length, 1);
  assert.equal(h.calls.credits[0].credits[0].quantity, 1);
});

test('une commande sans pack couleur ne génère ni crédit ni annonce de récompense', async () => {
  const order = pendingOrder([{ id: 'other', type: 'product', name: 'Produit ordinaire', quantity: 1 }]);
  const h = fixture({ order });
  await h.handleAdminValidate(h.interaction, order.orderId);

  assert.equal(order.status, 'paid');
  assert.equal(h.calls.credits.length, 0);
  assert.equal(h.calls.ticket.filter(message => message.content?.includes('a ajouté')).length, 0);
  assert.equal(h.calls.report.filter(message => message.content?.includes('a ajouté')).length, 0);
});

test('deux validations simultanées ne débitent et créditent qu’une seule fois', async () => {
  let release;
  let reachedRemoval;
  const atRemoval = new Promise(resolve => { reachedRemoval = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const order = pendingOrder([{ id: 'color-pack', type: 'pack', name: 'Pack de 10 couleurs', priceDiamonds: 1 }]);
  const h = fixture({
    order,
    beforeRemove: async () => { reachedRemoval(); await blocked; },
  });

  const first = h.handleAdminValidate(h.interaction, order.orderId);
  await atRemoval;
  await h.handleAdminValidate(h.interaction, order.orderId);
  assert.equal(h.calls.replies.length, 1);
  assert.match(h.calls.replies[0].content, /déjà en cours/);
  release();
  await first;

  assert.equal(h.calls.debits.length, 1);
  assert.equal(h.calls.credits.length, 1);
});

test('le paiement déjà validé incomplet reprend les couleurs sans nouveau débit', async () => {
  const order = pendingOrder();
  order.status = 'paid';
  order.shopColorCredits = [{ itemTypeId: 'custom-color-item', quantity: 10, name: 'Couleur', emoji: '🖌️' }];
  order.shopColorDelivery = {};
  const h = fixture({ order });
  await h.handleAdminValidate(h.interaction, order.orderId);

  assert.equal(h.calls.debits.length, 0);
  assert.equal(h.calls.credits.length, 1);
  assert.match(h.calls.edits[0].content, /Aucun nouveau paiement débité/);
});

test('une ancienne commande payée sans plan explicite ne reçoit aucun crédit', async () => {
  const order = pendingOrder();
  order.status = 'paid';
  delete order.shopColorCredits;
  const h = fixture({ order });
  await h.handleAdminValidate(h.interaction, order.orderId);

  assert.equal(h.calls.credits.length, 0);
  assert.equal(h.calls.ticket.length, 0);
  assert.match(h.calls.replies[0].content, /déjà été \*\*encaissée\*\*/);
});

test('échec de crédit affiche un avertissement explicite et le bouton de reprise, sans annoncer le succès', async () => {
  const h = fixture({ failCredits: true });
  await h.handleAdminValidate(h.interaction, h.order.orderId);

  const reply = h.calls.edits.find(payload => payload.embeds);
  assert.equal(h.order.status, 'paid');
  assert.match(reply.embeds[0].data.description, /Couleurs — action requise/);
  assert.match(reply.embeds[0].data.description, /ne sera pas débité à nouveau/);
  assert.doesNotMatch(reply.embeds[0].data.description, /Couleurs enregistrées en inventaire/);
  const retry = reply.components[0].components.find(button => button.toJSON().custom_id === 'st_admin_validate::order-123');
  assert.ok(retry, 'retry validation button should be present');
  assert.equal(h.calls.ticket.filter(message => message.content?.includes('a ajouté')).length, 0);
  assert.equal(h.calls.report.filter(message => message.content?.includes('a ajouté')).length, 0);
});

test('si le retrait du paiement échoue, aucun crédit ni annonce couleur n’a lieu', async () => {
  const order = pendingOrder([{ id: 'color-pack', type: 'pack', name: 'Pack de 10 couleurs', priceDiamonds: 50 }]);
  const h = fixture({ order, failPayment: true });
  await h.handleAdminValidate(h.interaction, order.orderId);

  assert.equal(order.status, 'pending');
  assert.equal(h.calls.credits.length, 0);
  assert.equal(h.calls.ticket.filter(message => message.content?.includes('a ajouté')).length, 0);
  assert.equal(h.calls.report.filter(message => message.content?.includes('a ajouté')).length, 0);
  assert.match(h.calls.edits[0].content, /payment removal failed/);
});

test('le bouton de paiement direct forcé converge vers le validateur admin', () => {
  const forceBranch = source.slice(
    source.indexOf("if (id.startsWith('st_admin_force_validate::'))"),
    source.indexOf("// ── Bouton admin : annuler", source.indexOf("if (id.startsWith('st_admin_force_validate::'))")),
  );
  assert.match(forceBranch, /order\.paymentChoice = \{ id: 'direct'/);
  assert.match(forceBranch, /return handleAdminValidate\(interaction, orderId\)/);
});