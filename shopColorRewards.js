const inventoryManager = require('./inventoryManager');
const pgStore = require('./pgStore');
const settingsManager = require('./settingsManager');
const crypto = require('node:crypto');
const { PermissionFlagsBits } = require('discord.js');

async function findExistingNotice(channel, marker, attempt, botId) {
  if (!botId || !channel.permissionsFor) throw new Error('Impossible de vérifier les permissions du bot pour l’annonce précédente.');
  const member = channel.guild?.members.me || (channel.guild?.members.fetchMe ? await channel.guild.members.fetchMe() : botId);
  const permissions = channel.permissionsFor(member);
  if (!permissions?.has || !permissions.has(PermissionFlagsBits.ViewChannel) ||
      !permissions.has(PermissionFlagsBits.ReadMessageHistory)) {
    throw new Error('Le bot doit pouvoir voir le salon et lire son historique pour vérifier l’annonce précédente.');
  }
  if (!channel.messages?.fetch) throw new Error('Impossible de vérifier l’annonce précédente dans ce salon.');
  let before;
  // Scan back to the persisted attempt, not just the latest messages. If the
  // bounded scan cannot establish absence, fail rather than risk a duplicate.
  for (let page = 0; page < 10; page++) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    const messages = [...batch.values()];
    const found = messages.find(message =>
      (botId ? message.author?.id === botId : message.author?.bot) &&
      (String(message.nonce || '') === attempt.nonce || message.content?.includes(`*${marker}*`))
    );
    if (found) return found;
    if (messages.length < 100) return null;
    const oldest = messages.reduce((a, b) => a.createdTimestamp < b.createdTimestamp ? a : b);
    if (oldest.createdTimestamp < attempt.startedAt - 300000) return null;
    before = oldest.id;
  }
  throw new Error('Historique trop long pour confirmer l’annonce précédente ; aucune annonce renvoyée.');
}

function normalize(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function getColorPackSize(item) {
  if (!['pack', 'unitaire'].includes(item.type)) return 0;
  const name = normalize(item.name);
  const option = normalize(item.selectedOption);
  if (!/\bcouleurs?\b/.test(`${name} ${option}`)) return 0;
  // The selected formula overrides the general product name.
  const optionHasCount = /\b(?:\d+|un|une|dix)\b/.test(option);
  const label = optionHasCount ? option : (/\bcouleurs?\b/.test(name) ? name : option);
  const amount = label.match(/\b(\d+|un|une|dix)\s+couleurs?\b/) || label.match(/\b(\d+|un|une|dix)\b/);
  if (amount) {
    const count = ['un', 'une'].includes(amount[1]) ? 1 : amount[1] === 'dix' ? 10 : Number(amount[1]);
    return [1, 10].includes(count) ? count : 0;
  }
  return /\bcouleur\b/.test(label) ? 1 : 0;
}

function planColorCredits(items, itemTypes) {
  let quantity = 0;
  for (const item of items) {
    const size = getColorPackSize(item);
    if (!size) continue;
    const count = item.quantity === undefined ? 1 : Number(item.quantity);
    if (!Number.isSafeInteger(count) || count <= 0 || !Number.isSafeInteger(size * count)) {
      throw new Error('Quantité de packs couleur invalide.');
    }
    quantity += size * count;
  }
  if (!quantity) return [];
  if (!Number.isSafeInteger(quantity)) throw new Error('Quantité de couleurs trop élevée.');

  // Payment-compatible inventory IDs are NOT purchase rewards. Resolve the
  // actual color resource, including custom catalog IDs used by the live bot.
  const named = itemTypes.filter(type => /^couleurs?(?: (?:de |pour )?dinos?)?$/.test(normalize(type.name)));
  if (named.length > 1) throw new Error('Plusieurs objets Couleur existent dans l’inventaire : attribution ambiguë.');
  const color = named[0] || itemTypes.find(type => type.id === 'peinture_dino');
  if (!color) throw new Error('Objet Couleur / Peinture Dino introuvable dans le catalogue inventaire.');
  return [{ itemTypeId: color.id, quantity, name: color.name, emoji: color.emoji || '🎨' }];
}

function isColorDeliveryComplete(order) {
  const state = order.shopColorDelivery;
  return !!(state?.credited && state.ticketSent && state.reportSent && !state.persistencePending);
}

function createShopColorRewards({ inventory = inventoryManager, store = pgStore, settings = settingsManager } = {}) {
  async function deliver(order, interaction, adminName) {
    const plan = order.shopColorCredits || [];
    if (!plan.length) return { complete: true, errors: [], credits: [] };
    if (order.status !== 'paid') {
      return { complete: false, errors: ['La commande doit être validée avant l’ajout des couleurs.'], credits: [] };
    }
    const state = order.shopColorDelivery || (order.shopColorDelivery = {});
    async function saveProgress() {
      state.persistencePending = false;
      try {
        await store.saveShopOrder(order, { throwOnError: true });
      } catch (error) {
        state.persistencePending = true;
        error.shopColorPersistenceError = true;
        throw error;
      }
    }
    const errors = [];
    let credits;
    try {
      const result = await inventory.applyInventoryCredits(
        order.userId, plan.map(({ itemTypeId, quantity }) => ({ itemTypeId, quantity })),
        interaction.user.id, `Achat pack couleur — Commande shop #${order.orderId}`,
        { idempotencyKey: `shop:${order.orderId}:colors` }
      );
      credits = result.transactions.map(tx => ({
        itemTypeId: tx.itemTypeId, quantity: tx.quantity,
        name: plan.find(item => item.itemTypeId === tx.itemTypeId)?.name || tx.itemTypeId,
        emoji: plan.find(item => item.itemTypeId === tx.itemTypeId)?.emoji || '🎨',
      }));
      state.credited = true;
      state.adminName ||= adminName;
      await saveProgress();
    } catch (error) {
      return { complete: false, errors: [`Ajout des couleurs : ${error.message}`], credits: [] };
    }

    const lines = credits.map(item =>
      `**${state.adminName}** a ajouté **${item.quantity}x ${item.emoji} ${item.name}** à l'inventaire de <@${order.userId}>`
    ).join('\n');
    const marker = `Achat shop — commande #${order.orderId}`;
    const message = {
      content: `${lines}\n*${marker}*`,
      allowedMentions: { parse: [], users: [order.userId] },
    };
    const reportId = settings.getSettings().guild?.inventoryLogChannelId;

    for (const destination of ['ticket', 'report']) {
      const flag = `${destination}Sent`;
      if (state[flag]) continue;
      try {
        let channel;
        if (destination === 'ticket') {
          channel = interaction.channel;
        } else {
          if (!reportId) throw new Error('Salon de rapport inventaire non configuré.');
          if (reportId === interaction.channel?.id && state.ticketSent) {
            state.reportSent = true;
            await saveProgress();
            continue;
          }
          channel = await interaction.guild.channels.fetch(reportId);
        }
        if (!channel?.send) throw new Error('Salon introuvable ou inaccessible.');
        const attemptKey = `${destination}Attempt`;
        const previousAttempt = state[attemptKey];
        if (previousAttempt) {
          const existing = await findExistingNotice(channel, marker, previousAttempt, interaction.client?.user?.id);
          if (existing) {
            state[flag] = true;
            await saveProgress();
            continue;
          }
        } else {
          state[attemptKey] = {
            startedAt: Date.now(),
            nonce: crypto.createHash('sha256').update(`shop-colors:${order.orderId}:${destination}`).digest('hex').slice(0, 24),
          };
          // Durable sending intent permits reconciliation after a crash or a
          // failed checkpoint, even if Discord accepted the notice.
          await saveProgress();
        }
        await channel.send({ ...message, nonce: state[attemptKey].nonce, enforceNonce: true });
        state[flag] = true;
        await saveProgress();
      } catch (error) {
        errors.push(`${destination === 'ticket' ? 'Annonce dans le ticket' : 'Rapport inventaire'} : ${error.message}`);
        if (error.shopColorPersistenceError) break;
      }
    }
    return { complete: isColorDeliveryComplete(order) && !errors.length, errors, credits };
  }
  return { deliver };
}

module.exports = { getColorPackSize, planColorCredits, isColorDeliveryComplete,
  createShopColorRewards, ...createShopColorRewards() };