const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits } = require('discord.js');
const {
  getColorPackSize,
  planColorCredits,
  createShopColorRewards,
  isColorDeliveryComplete,
} = require('../shopColorRewards');

const catalog = [
  { id: 'custom-color-item', name: 'Couleur', emoji: '🖌️' },
  { id: 'peinture_dino', name: 'Peinture Dino', emoji: '🎨' },
];

function fixture({
  reportId = 'report-channel',
  failCredits = false,
  failReportSends = 0,
  failSaveAt = null,
  denyReadHistory = false,
} = {}) {
  const receipts = new Map();
  const savedOrders = new Map();
  const sends = { ticket: [], report: [] };
  const history = { ticket: [], report: [] };
  const historyFetches = { ticket: 0, report: 0 };
  let creditApplications = 0;
  let reportFailures = failReportSends;
  let saveCalls = 0;
  let messageId = 0;

  const inventory = {
    getItemTypes: () => catalog,
    applyInventoryCredits: async (playerId, credits, adminId, reason, options) => {
      const key = options.idempotencyKey;
      if (receipts.has(key)) return receipts.get(key);
      if (failCredits) throw new Error('Écriture des crédits refusée.');
      creditApplications++;
      const result = {
        transactions: credits.map(credit => ({
          ...credit, playerId, adminId, reason,
        })),
      };
      receipts.set(key, result);
      return result;
    },
  };
  const store = {
    saveShopOrder: async order => {
      saveCalls++;
      if (saveCalls === failSaveAt) throw new Error('Écriture de commande refusée.');
      savedOrders.set(order.orderId, JSON.parse(JSON.stringify(order)));
    },
  };
  function createChannel(id, destination) {
    return {
      id,
      guild: { members: { me: { id: 'bot-99' } } },
      permissionsFor: member => {
        assert.equal(member.id, 'bot-99');
        return {
          has: permission => !(denyReadHistory && permission === PermissionFlagsBits.ReadMessageHistory),
        };
      },
      messages: {
        fetch: async ({ before } = {}) => {
          historyFetches[destination]++;
          const available = history[destination].filter(message =>
            before === undefined || Number(message.id) < Number(before));
          return new Map(available.slice(-100).map(message => [message.id, message]));
        },
      },
      send: async payload => {
        if (destination === 'report' && reportFailures > 0) {
          reportFailures--;
          throw new Error('Rapport temporairement indisponible.');
        }
        sends[destination].push(payload);
        const sent = {
          id: String(++messageId),
          author: { id: 'bot-99', bot: true },
          content: payload.content,
          nonce: payload.nonce,
          createdTimestamp: Date.now(),
        };
        history[destination].push(sent);
        return sent;
      },
    };
  }
  const ticket = createChannel('ticket-channel', 'ticket');
  const report = createChannel(reportId, 'report');
  const interaction = {
    user: { id: 'admin-42' },
    client: { user: { id: 'bot-99' } },
    channel: ticket,
    guild: {
      channels: {
        fetch: async id => id === reportId ? report : null,
      },
    },
  };
  const service = createShopColorRewards({
    inventory,
    store,
    settings: { getSettings: () => ({ guild: { inventoryLogChannelId: reportId } }) },
  });

  return {
    service, interaction, sends, receipts, savedOrders, history, historyFetches,
    get creditApplications() { return creditApplications; },
  };
}

function paidOrder(plan = [{ itemTypeId: 'custom-color-item', quantity: 21, name: 'Couleur', emoji: '🖌️' }]) {
  return {
    orderId: 'order-123',
    status: 'paid',
    userId: 'player-7',
    shopColorCredits: plan,
  };
}

test('reconnaît les packs de 10 et 1 couleur, dont « Pack d’une couleur »', () => {
  assert.equal(getColorPackSize({ type: 'pack', name: 'Pack de 10 couleurs' }), 10);
  assert.equal(getColorPackSize({ type: 'unitaire', name: 'Pack d’une couleur' }), 1);
});

test('la formule sélectionnée prime sur le nom général du produit', () => {
  assert.equal(getColorPackSize({
    type: 'pack',
    name: 'Pack de 10 couleurs',
    selectedOption: 'Une couleur',
  }), 1);
  assert.equal(getColorPackSize({
    type: 'pack',
    name: 'Pack de 10 couleurs',
    selectedOption: '10 couleurs',
  }), 10);
  assert.equal(getColorPackSize({
    type: 'pack',
    name: 'Pack de 10 couleurs',
    selectedOption: 'Couleur bleue',
  }), 10);
});

test('planifie le total des quantités et ignore dinos, autres produits et IDs de paiement', () => {
  const plan = planColorCredits([
    { type: 'pack', name: 'Pack de 10 couleurs', quantity: 2 },
    { type: 'unitaire', name: 'Pack d’une couleur', quantity: 1 },
    { type: 'dino', name: 'Dino couleur 10', quantity: 4, paymentID: 'custom-color-item' },
    { type: 'product', name: 'Produit sans rapport', quantity: 2, paymentIDs: ['peinture_dino'] },
  ], catalog);
  assert.deepEqual(plan, [{
    itemTypeId: 'custom-color-item',
    quantity: 21,
    name: 'Couleur',
    emoji: '🖌️',
  }]);
  assert.deepEqual(planColorCredits([
    { type: 'product', name: 'Dino acheté', paymentID: 'custom-color-item' },
  ], catalog), []);
});

test('préfère l’objet Couleur personnalisé puis utilise peinture_dino en repli', () => {
  assert.equal(planColorCredits([{ type: 'pack', name: 'Pack 10 couleurs' }], catalog)[0].itemTypeId,
    'custom-color-item');
  assert.equal(planColorCredits([{ type: 'pack', name: 'Pack 10 couleurs' }], [catalog[1]])[0].itemTypeId,
    'peinture_dino');
});

test('rejette les quantités invalides, un catalogue ambigu et un objet absent', () => {
  for (const quantity of [0, -1, 1.5, 'pas-un-nombre']) {
    assert.throws(
      () => planColorCredits([{ type: 'pack', name: 'Pack 10 couleurs', quantity }], catalog),
      /Quantité de packs couleur invalide/,
    );
  }
  assert.throws(
    () => planColorCredits([{ type: 'pack', name: 'Pack 10 couleurs' }], [
      catalog[0], { id: 'second-color', name: 'Couleurs de dinos' },
    ]),
    /attribution ambiguë/,
  );
  assert.throws(
    () => planColorCredits([{ type: 'pack', name: 'Pack 10 couleurs' }], []),
    /introuvable/,
  );
});

test('crédite une fois après répétition et rechargement de la commande sauvegardée', async () => {
  const f = fixture();
  const order = paidOrder();
  const first = await f.service.deliver(order, f.interaction, 'Modérateur');
  assert.equal(first.complete, true);
  assert.equal(f.creditApplications, 1);

  const reloadedOrder = JSON.parse(JSON.stringify(f.savedOrders.get(order.orderId)));
  const retry = await f.service.deliver(reloadedOrder, f.interaction, 'Autre modérateur');
  assert.equal(retry.complete, true);
  assert.equal(f.creditApplications, 1);
  assert.equal(f.receipts.size, 1);
  assert.equal(isColorDeliveryComplete(reloadedOrder), true);
  assert.equal(f.sends.ticket.length, 1);
  assert.equal(f.sends.report.length, 1);
});

test('notifie le ticket et le rapport avec quantité, formulation et mention utilisateur', async () => {
  const f = fixture();
  const result = await f.service.deliver(paidOrder(), f.interaction, 'Modérateur');
  assert.equal(result.complete, true);
  for (const message of [...f.sends.ticket, ...f.sends.report]) {
    assert.match(message.content, /\*\*Modérateur\*\* a ajouté \*\*21x 🖌️ Couleur\*\* à l'inventaire de <@player-7>/);
    assert.match(message.content, /commande #order-123/);
    assert.deepEqual(message.allowedMentions, { parse: [], users: ['player-7'] });
  }
});

test('un échec de crédit ne déclenche aucune notification', async () => {
  const f = fixture({ failCredits: true });
  const result = await f.service.deliver(paidOrder(), f.interaction, 'Modérateur');
  assert.equal(result.complete, false);
  assert.match(result.errors[0], /Ajout des couleurs/);
  assert.deepEqual(f.sends, { ticket: [], report: [] });
  assert.equal(f.savedOrders.size, 0);
});

test('une commande non payée ne crédite rien et n’envoie aucune notification', async () => {
  const f = fixture();
  for (const status of ['pending', 'cancelled', 'unapproved']) {
    const result = await f.service.deliver({ ...paidOrder(), status }, f.interaction, 'Modérateur');
    assert.equal(result.complete, false);
    assert.deepEqual(result.credits, []);
  }
  assert.equal(f.creditApplications, 0);
  assert.deepEqual(f.sends, { ticket: [], report: [] });
});

test('réconcilie une annonce envoyée malgré l’échec du checkpoint après envoi', async () => {
  const f = fixture({ failSaveAt: 3 });
  const order = paidOrder();
  const first = await f.service.deliver(order, f.interaction, 'Modérateur');
  assert.equal(first.complete, false);
  assert.equal(f.sends.ticket.length, 1);
  assert.equal(f.sends.report.length, 0);
  assert.equal(f.creditApplications, 1);

  // The failed post-send write was not persisted; reload only the last
  // successful snapshot, which contains the pre-send attempt intent.
  const reloadedOrder = JSON.parse(JSON.stringify(f.savedOrders.get(order.orderId)));
  assert.ok(reloadedOrder.shopColorDelivery.ticketAttempt);
  assert.equal(reloadedOrder.shopColorDelivery.ticketSent, undefined);
  const retry = await f.service.deliver(reloadedOrder, f.interaction, 'Modérateur');

  assert.equal(retry.complete, true);
  assert.equal(f.sends.ticket.length, 1);
  assert.equal(f.sends.report.length, 1);
  assert.equal(f.creditApplications, 1);
  assert.equal(f.receipts.size, 1);
  assert.equal(isColorDeliveryComplete(reloadedOrder), true);
});

test('un historique illisible interdit de renvoyer une annonce incertaine', async () => {
  const f = fixture({ failSaveAt: 3, denyReadHistory: true });
  const order = paidOrder();
  const first = await f.service.deliver(order, f.interaction, 'Modérateur');
  assert.equal(first.complete, false);
  assert.equal(f.sends.ticket.length, 1);
  assert.equal(f.creditApplications, 1);

  const reloadedOrder = JSON.parse(JSON.stringify(f.savedOrders.get(order.orderId)));
  // Simulate unavailable history that would look empty if it were trusted.
  f.history.ticket.length = 0;
  const retry = await f.service.deliver(reloadedOrder, f.interaction, 'Modérateur');

  assert.equal(retry.complete, false);
  assert.ok(retry.errors.some(error => /voir le salon et lire son historique/.test(error)));
  assert.equal(f.historyFetches.ticket, 0);
  assert.equal(f.sends.ticket.length, 1);
  assert.equal(f.creditApplications, 1);
});

test('un checkpoint en échec définit persistencePending, puis la relance sauvegardée finit la livraison', async () => {
  const f = fixture({ failSaveAt: 2 });
  const order = paidOrder();
  const first = await f.service.deliver(order, f.interaction, 'Modérateur');
  assert.equal(first.complete, false);
  assert.equal(order.shopColorDelivery.persistencePending, true);
  assert.equal(f.sends.ticket.length, 0);

  const retry = await f.service.deliver(order, f.interaction, 'Modérateur');
  assert.equal(retry.complete, true);
  assert.equal(order.shopColorDelivery.persistencePending, false);
  assert.equal(f.sends.ticket.length, 1);
  assert.equal(f.sends.report.length, 1);
  assert.equal(f.creditApplications, 1);
});

test('après un échec du rapport, la relance n’envoie que la notification manquante sans recréditer', async () => {
  const f = fixture({ failReportSends: 1 });
  const order = paidOrder();
  const first = await f.service.deliver(order, f.interaction, 'Modérateur');
  assert.equal(first.complete, false);
  assert.equal(f.sends.ticket.length, 1);
  assert.equal(f.sends.report.length, 0);
  assert.equal(f.creditApplications, 1);

  const reloadedOrder = JSON.parse(JSON.stringify(f.savedOrders.get(order.orderId)));
  const retry = await f.service.deliver(reloadedOrder, f.interaction, 'Modérateur');
  assert.equal(retry.complete, true);
  assert.equal(f.sends.ticket.length, 1);
  assert.equal(f.sends.report.length, 1);
  assert.equal(f.creditApplications, 1);
});

test('ne double pas la notification quand ticket et rapport sont le même salon', async () => {
  const f = fixture({ reportId: 'ticket-channel' });
  const result = await f.service.deliver(paidOrder(), f.interaction, 'Modérateur');
  assert.equal(result.complete, true);
  assert.equal(f.sends.ticket.length, 1);
  assert.equal(f.sends.report.length, 0);
});