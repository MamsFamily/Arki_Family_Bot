const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getShop, getCategories, buildPackEmbed } = require('./shopManager');
const { getSettings } = require('./settingsManager');

// Map threadId -> { cartMsgId, items: [packId, ...] }
const threadCarts = new Map();

function formatPrice(pack) {
  const hasOptions = Array.isArray(pack.options) && pack.options.length > 0;
  if (hasOptions) return `${pack.options.length} formule(s)`;
  const parts = [];
  if (pack.priceDiamonds > 0) parts.push(`${pack.priceDiamonds.toLocaleString('fr-FR')} 💎`);
  if (pack.priceStrawberries > 0) parts.push(`${pack.priceStrawberries.toLocaleString('fr-FR')} 🍓`);
  return parts.join(' + ') || '—';
}

function getAvailablePacks(type) {
  const shop = getShop();
  let packs = shop.packs.filter(p => p.available !== false);
  if (type && type !== 'all') {
    packs = packs.filter(p => (p.type || 'pack') === type);
  }
  return packs;
}

function buildHomeEmbed() {
  return new EmbedBuilder()
    .setTitle('🛒 Arki\' Family Shop')
    .setDescription('Bienvenue dans la boutique !\nSélectionne un type de produit pour commencer.')
    .setColor(0x7c5cfc)
    .setFooter({ text: 'Arki\'s Family Shop — Navigation visible uniquement par toi' });
}

function buildTypeMenu() {
  return new StringSelectMenuBuilder()
    .setCustomId('shop_type')
    .setPlaceholder('Choisir un type de produit...')
    .addOptions([
      { label: '📦 Packs', description: 'Packs composés multi-items', value: 'pack' },
      { label: '💎 Produits unitaires', description: 'Items, dinos, ressources à l\'unité', value: 'unitaire' },
      { label: '🛒 Tout voir', description: 'Tous les produits disponibles', value: 'all' },
    ]);
}

function buildProductMenu(type) {
  const packs = getAvailablePacks(type);
  if (packs.length === 0) return null;

  const options = packs.slice(0, 25).map(p => {
    const cats = getCategories();
    const cat = cats.find(c => c.id === p.category);
    const emoji = cat?.emoji || '🛒';
    return {
      label: `${emoji} ${p.name}`.slice(0, 100),
      description: formatPrice(p).slice(0, 100),
      value: p.id,
    };
  });

  return new StringSelectMenuBuilder()
    .setCustomId(`shop_product::${type}`)
    .setPlaceholder('Sélectionne un produit...')
    .addOptions(options);
}

function buildProductListEmbed(type) {
  const label = type === 'unitaire' ? '💎 Produits unitaires' : type === 'pack' ? '📦 Packs' : '🛒 Tous les produits';
  const packs = getAvailablePacks(type);
  const embed = new EmbedBuilder()
    .setTitle(label)
    .setColor(type === 'unitaire' ? 0x3498db : 0xe74c3c)
    .setFooter({ text: `${packs.length} produit(s) disponible(s)` });

  if (packs.length === 0) {
    embed.setDescription('*Aucun produit disponible pour le moment.*');
  } else {
    embed.setDescription('Sélectionne un produit dans le menu pour voir ses détails.');
  }
  return embed;
}

function buildProductDetailEmbed(pack) {
  const raw = buildPackEmbed(pack);
  const embed = new EmbedBuilder()
    .setTitle(raw.title)
    .setDescription(raw.description)
    .setColor(raw.color);
  if (pack.imageUrl && pack.imageUrl.trim()) {
    embed.setThumbnail(pack.imageUrl.trim());
  }
  return embed;
}

function buildCartEmbed(items) {
  const shop = getShop();
  let desc = '';
  let total = { diamonds: 0, strawberries: 0 };

  items.forEach((packId, i) => {
    const pack = shop.packs.find(p => p.id === packId);
    if (!pack) return;
    const hasOptions = Array.isArray(pack.options) && pack.options.length > 0;
    desc += `**${i + 1}.** ${pack.name}\n`;
    if (hasOptions) {
      desc += `> ${pack.options.map(o => o.name).join(' / ')}\n`;
    } else {
      const parts = [];
      if (pack.priceDiamonds > 0) { parts.push(`${pack.priceDiamonds.toLocaleString('fr-FR')} 💎`); total.diamonds += pack.priceDiamonds; }
      if (pack.priceStrawberries > 0) { parts.push(`${pack.priceStrawberries.toLocaleString('fr-FR')} 🍓`); total.strawberries += pack.priceStrawberries; }
      if (parts.length) desc += `> ${parts.join(' + ')}\n`;
    }
    desc += '\n';
  });

  const embed = new EmbedBuilder()
    .setTitle('🛒 Récapitulatif de ta commande')
    .setDescription(desc.trim() || '*Panier vide*')
    .setColor(0x7c5cfc);

  if (total.diamonds > 0 || total.strawberries > 0) {
    const totalParts = [];
    if (total.diamonds > 0) totalParts.push(`${total.diamonds.toLocaleString('fr-FR')} 💎`);
    if (total.strawberries > 0) totalParts.push(`${total.strawberries.toLocaleString('fr-FR')} 🍓`);
    embed.addFields({ name: '💰 Total estimé', value: totalParts.join(' + ') });
  }

  embed.setFooter({ text: 'Un admin viendra te contacter dans ce ticket.' });
  return embed;
}

async function handleShopCommand(interaction) {
  const embed = buildHomeEmbed();
  const row = new ActionRowBuilder().addComponents(buildTypeMenu());
  await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

async function handleShopInteraction(interaction) {
  const id = interaction.customId;

  // ── Type selected ──
  if (id === 'shop_type') {
    const type = interaction.values[0];
    const productMenu = buildProductMenu(type);

    if (!productMenu) {
      return interaction.update({
        embeds: [new EmbedBuilder().setColor(0xe74c3c).setDescription('❌ Aucun produit disponible dans cette catégorie.')],
        components: [new ActionRowBuilder().addComponents(buildTypeMenu())],
      });
    }

    const listEmbed = buildProductListEmbed(type);
    const row1 = new ActionRowBuilder().addComponents(productMenu);
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('shop_back_home').setLabel('← Retour').setStyle(ButtonStyle.Secondary)
    );
    return interaction.update({ embeds: [listEmbed], components: [row1, row2] });
  }

  // ── Product selected ──
  if (id.startsWith('shop_product::')) {
    const type = id.split('::')[1];
    const packId = interaction.values[0];
    const shop = getShop();
    const pack = shop.packs.find(p => p.id === packId);
    if (!pack) return interaction.update({ content: '❌ Produit introuvable.', embeds: [], components: [] });

    const detailEmbed = buildProductDetailEmbed(pack);
    const productMenu = buildProductMenu(type);
    const rows = [];
    if (productMenu) rows.push(new ActionRowBuilder().addComponents(productMenu));
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`shop_order::${packId}`).setLabel('🛒 Commander ce produit').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`shop_back_type::${type}`).setLabel('← Retour').setStyle(ButtonStyle.Secondary)
    ));
    return interaction.update({ embeds: [detailEmbed], components: rows });
  }

  // ── Back to home ──
  if (id === 'shop_back_home') {
    const embed = buildHomeEmbed();
    const row = new ActionRowBuilder().addComponents(buildTypeMenu());
    return interaction.update({ embeds: [embed], components: [row] });
  }

  // ── Back to type list ──
  if (id.startsWith('shop_back_type::')) {
    const type = id.split('::')[1];
    const productMenu = buildProductMenu(type);
    const listEmbed = buildProductListEmbed(type);
    const rows = [];
    if (productMenu) rows.push(new ActionRowBuilder().addComponents(productMenu));
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('shop_back_home').setLabel('← Retour').setStyle(ButtonStyle.Secondary)
    ));
    return interaction.update({ embeds: [listEmbed], components: rows });
  }

  // ── Commander ──
  if (id.startsWith('shop_order::')) {
    const packId = id.split('::')[1];
    const shop = getShop();
    const settings = getSettings();
    const pack = shop.packs.find(p => p.id === packId);
    if (!pack) return interaction.update({ content: '❌ Produit introuvable.', embeds: [], components: [] });

    const ticketChannelId = shop.shopTicketChannelId;
    if (!ticketChannelId) {
      return interaction.update({
        embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle('❌ Configuration manquante').setDescription('Le salon de tickets shop n\'est pas configuré. Contacte un admin.')],
        components: [],
      });
    }

    try {
      const ticketChannel = await interaction.guild.channels.fetch(ticketChannelId);
      if (!ticketChannel) throw new Error('Salon introuvable');

      const member = interaction.member;
      const username = member.displayName || interaction.user.username;
      const threadName = `🛒 ${username} — ${pack.name}`.slice(0, 100);

      const thread = await ticketChannel.threads.create({
        name: threadName,
        autoArchiveDuration: 10080,
        reason: `Ticket shop de ${username}`,
      });

      const cartEmbed = buildCartEmbed([packId]);
      const productEmbed = buildProductDetailEmbed(pack);

      const addRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`shop_addcart::${thread.id}`)
          .setLabel('➕ Ajouter un produit au panier')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`shop_closecart::${thread.id}`)
          .setLabel('✅ Panier finalisé')
          .setStyle(ButtonStyle.Success)
      );

      await thread.send({ content: `Bonjour <@${interaction.user.id}> ! 👋\n\nUn admin va prendre en charge ta commande très bientôt.`, embeds: [cartEmbed] });
      const productMsg = await thread.send({ embeds: [productEmbed], components: [addRow] });

      threadCarts.set(thread.id, { cartMsgId: productMsg.id, items: [packId] });

      return interaction.update({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle('✅ Ticket créé !')
            .setDescription(`Ton ticket a été ouvert : <#${thread.id}>\n\nTu peux y ajouter d'autres produits directement depuis le ticket.`)
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('shop_back_home').setLabel('🛒 Continuer mes achats').setStyle(ButtonStyle.Secondary)
          )
        ],
      });
    } catch (err) {
      console.error('[Shop] Erreur création ticket:', err);
      return interaction.update({
        embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle('❌ Erreur').setDescription('Impossible de créer le ticket. Réessaie ou contacte un admin.')],
        components: [],
      });
    }
  }

  // ── Add to cart (from ticket thread) ──
  if (id.startsWith('shop_addcart::')) {
    const threadId = id.split('::')[1];
    const productMenu = buildProductMenu('all');
    if (!productMenu) {
      return interaction.reply({ content: '❌ Aucun produit disponible.', ephemeral: true });
    }
    productMenu.setCustomId(`shop_cartadd::${threadId}`).setPlaceholder('Ajouter un produit au panier...');
    const row = new ActionRowBuilder().addComponents(productMenu);
    return interaction.reply({ content: '**Ajoute un produit à ta commande :**', components: [row], ephemeral: true });
  }

  // ── Product added to cart ──
  if (id.startsWith('shop_cartadd::')) {
    const threadId = id.split('::')[1];
    const packId = interaction.values[0];
    const shop = getShop();
    const pack = shop.packs.find(p => p.id === packId);
    if (!pack) return interaction.update({ content: '❌ Produit introuvable.', components: [] });

    let cart = threadCarts.get(threadId);
    if (!cart) cart = { items: [] };
    cart.items.push(packId);
    threadCarts.set(threadId, cart);

    try {
      const thread = await interaction.guild.channels.fetch(threadId);
      if (thread) {
        const productEmbed = buildProductDetailEmbed(pack);
        const addRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`shop_addcart::${threadId}`)
            .setLabel('➕ Ajouter un produit au panier')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(`shop_closecart::${threadId}`)
            .setLabel('✅ Panier finalisé')
            .setStyle(ButtonStyle.Success)
        );
        await thread.send({ content: `✅ Ajouté au panier : **${pack.name}**`, embeds: [productEmbed], components: [addRow] });
      }
    } catch (e) {}

    return interaction.update({ content: `✅ **${pack.name}** ajouté au panier !`, components: [] });
  }

  // ── Close cart ──
  if (id.startsWith('shop_closecart::')) {
    const threadId = id.split('::')[1];
    const cart = threadCarts.get(threadId);
    try {
      const thread = await interaction.guild.channels.fetch(threadId);
      if (thread && cart && cart.items.length > 0) {
        const cartEmbed = buildCartEmbed(cart.items);
        await thread.send({ content: '📋 **Récapitulatif final de la commande :**', embeds: [cartEmbed] });
      }
    } catch (e) {}
    threadCarts.delete(threadId);
    try {
      await interaction.message.edit({ components: [] });
    } catch (e) {}
    return interaction.reply({ content: '✅ Panier finalisé ! Un admin va traiter ta commande.', ephemeral: true });
  }
}

module.exports = { handleShopCommand, handleShopInteraction };
