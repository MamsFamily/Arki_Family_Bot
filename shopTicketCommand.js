/**
 * shopTicketCommand.js
 * Système de ticket shop complet :
 * - Navigation dinos (variantes, sexe M/F, stat forte)
 * - Navigation packs/unitaires
 * - Panier virtuel persistant (ajouter, retirer, commentaire)
 * - Calcul paiement : inventaire (déductions auto) + réduction rôle
 * - Création d'un salon ticket privé (ChannelType.GuildText)
 * - Bouton admin pour valider & encaisser automatiquement
 * - Bouton admin pour fermer le ticket (supprime le salon)
 */

const {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');

const { getDinoData, getDino } = require('./dinoManager');
const { getShop, getCategories } = require('./shopManager');
const { getPlayerInventory, addToInventory, removeFromInventory } = require('./inventoryManager');
const { getRoleIncomes } = require('./economyManager');
const { getSettings } = require('./settingsManager');

// ── Constantes ───────────────────────────────────────────────────────────────
const SEXES = ['Mâle', 'Femelle'];
const STATS = ['Vie', 'Énergie', 'Nourriture', 'Poids', 'Oxygène', 'Attaque'];
const STAT_EMOJIS = { 'Vie': '❤️', 'Énergie': '⚡', 'Nourriture': '🍖', 'Poids': '⚖️', 'Oxygène': '💨', 'Attaque': '⚔️' };

// ── Stockage en mémoire ───────────────────────────────────────────────────────
// Map userId -> cart session (éphémère, navigation en cours)
const activeCarts = new Map();
// Map threadId -> orderData (ticket créé, en attente de validation admin)
const activeOrders = new Map();

// ── Génération d'ID ───────────────────────────────────────────────────────────
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── Helpers formatage ─────────────────────────────────────────────────────────
function formatPrice(diamonds, strawberries) {
  const parts = [];
  if (diamonds > 0) parts.push(`${diamonds.toLocaleString('fr-FR')} 💎`);
  if (strawberries > 0) parts.push(`${strawberries.toLocaleString('fr-FR')} 🍓`);
  return parts.join(' + ') || 'Gratuit';
}

function applyDiscount(price, pct) {
  return Math.floor(price * (1 - pct / 100));
}

// ── Récupérer les IDs de rôles d'un membre (robuste) ─────────────────────────
async function getMemberRoleIds(interaction) {
  try {
    // Préférer un fetch fresh pour être sûr d'avoir les rôles à jour
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (member) return [...member.roles.cache.keys()];
    // Fallback sur le cache de l'interaction
    if (interaction.member?.roles?.cache?.size > 0) {
      return [...interaction.member.roles.cache.keys()];
    }
  } catch (e) {}
  return [];
}

// ── Calcul réduction max du joueur ────────────────────────────────────────────
async function getMaxDiscount(memberRoleIds) {
  const roles = await getRoleIncomes();
  let maxDiscount = 0;
  let discountRoleName = null;
  for (const [roleId, cfg] of Object.entries(roles)) {
    const pct = parseFloat(cfg.shopDiscount) || 0;
    if (memberRoleIds.includes(roleId) && pct > maxDiscount) {
      maxDiscount = pct;
      discountRoleName = cfg.name;
    }
  }
  return { discount: maxDiscount, roleName: discountRoleName };
}

// ── Calcul total du panier ────────────────────────────────────────────────────
function calcCartTotal(cartItems, discount = 0) {
  let totalDiamonds = 0;
  let totalStrawberries = 0;

  for (const item of cartItems) {
    let d = item.priceDiamonds || 0;
    let s = item.priceStrawberries || 0;
    if (!item.noReduction && discount > 0) {
      d = applyDiscount(d, discount);
      s = applyDiscount(s, discount);
    }
    totalDiamonds += d;
    totalStrawberries += s;
  }
  return { totalDiamonds, totalStrawberries };
}

// ── Construire les options de paiement depuis l'inventaire ────────────────────
// Retourne un tableau d'options proposables au joueur
function getPaymentOptions(cartItems, playerInventory) {
  const inv = playerInventory || {};
  const options = [];

  // Séparer dinos normaux et dinos d'épaule
  const regularDinos = cartItems.filter(i => i.type === 'dino' && !i.isShoulder && !i.notAvailableDona);
  const shoulderDinos = cartItems.filter(i => i.type === 'dino' && i.isShoulder);
  const packCompatItems = cartItems.filter(i => (i.type === 'pack' || i.type === 'unitaire') && i.donationAvailable);

  // dino_dona → couvre les dinos normaux
  const dinoDona = inv['dino_dona'] || 0;
  if (dinoDona > 0 && regularDinos.length > 0) {
    const usable = Math.min(dinoDona, regularDinos.length);
    options.push({
      id: 'dino_dona',
      inventoryId: 'dino_dona',
      label: `🦕 Dino Dona (${dinoDona} en stock, ${usable} utilisable${usable > 1 ? 's' : ''})`,
      usedQty: usable,
      coveredItemIds: regularDinos.slice(0, usable).map(i => i.id),
    });
  }

  // dino_epaule_shop → couvre les dinos d'épaule
  const dinoEpauleShop = inv['dino_epaule_shop'] || 0;
  if (dinoEpauleShop > 0 && shoulderDinos.length > 0) {
    const usable = Math.min(dinoEpauleShop, shoulderDinos.length);
    options.push({
      id: 'dino_epaule_shop',
      inventoryId: 'dino_epaule_shop',
      label: `🦎 Dino d'épaule Shop (${dinoEpauleShop} en stock, ${usable} utilisable${usable > 1 ? 's' : ''})`,
      usedQty: usable,
      coveredItemIds: shoulderDinos.slice(0, usable).map(i => i.id),
    });
  }

  // dino_epaule (générique) → couvre aussi les dinos d'épaule si pas de dino_epaule_shop
  const dinoEpaule = inv['dino_epaule'] || 0;
  const alreadyCoveredShoulder = options.find(o => o.id === 'dino_epaule_shop')?.usedQty || 0;
  const remainingShoulder = shoulderDinos.length - alreadyCoveredShoulder;
  if (dinoEpaule > 0 && remainingShoulder > 0) {
    const usable = Math.min(dinoEpaule, remainingShoulder);
    options.push({
      id: 'dino_epaule',
      inventoryId: 'dino_epaule',
      label: `🦎 Dino d'épaule (${dinoEpaule} en stock, ${usable} utilisable${usable > 1 ? 's' : ''})`,
      usedQty: usable,
      coveredItemIds: shoulderDinos.slice(alreadyCoveredShoulder, alreadyCoveredShoulder + usable).map(i => i.id),
    });
  }

  // pack → couvre les items compatibles
  const packQty = inv['pack'] || 0;
  if (packQty > 0 && packCompatItems.length > 0) {
    const usable = Math.min(packQty, packCompatItems.length);
    options.push({
      id: 'pack',
      inventoryId: 'pack',
      label: `📦 Pack inventaire (${packQty} en stock, ${usable} utilisable${usable > 1 ? 's' : ''})`,
      usedQty: usable,
      coveredItemIds: packCompatItems.slice(0, usable).map(i => i.id),
    });
  }

  return options;
}

// ── Construire les boutons de choix de paiement (pour le salon ticket) ────────
function buildPaymentChoiceComponents(orderId, paymentOptions) {
  const btns = paymentOptions.map((opt, idx) =>
    new ButtonBuilder()
      .setCustomId(`st_pay_method::${orderId}::${idx}`)
      .setLabel(opt.label.slice(0, 80))
      .setStyle(ButtonStyle.Primary)
  );

  btns.push(
    new ButtonBuilder()
      .setCustomId(`st_pay_method::${orderId}::direct`)
      .setLabel('💎 Paiement direct (💎 + 🍓)')
      .setStyle(ButtonStyle.Secondary)
  );

  const rows = [];
  for (let i = 0; i < btns.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(btns.slice(i, i + 5)));
  }
  return rows;
}

// Compatibilité ancienne interface (non utilisé directement mais gardé)
function getInventoryDeductions(cartItems, playerInventory) {
  return getPaymentOptions(cartItems, playerInventory);
}

// ── Initialiser un panier vide ────────────────────────────────────────────────
function newCart(userId) {
  return {
    userId,
    items: [],
    comment: '',
    step: 'home',
    pendingDino: null,
    createdAt: Date.now(),
  };
}

// ── Obtenir ou créer le panier ────────────────────────────────────────────────
function getCart(userId) {
  if (!activeCarts.has(userId)) {
    activeCarts.set(userId, newCart(userId));
  }
  return activeCarts.get(userId);
}

// ── Embed accueil panier ──────────────────────────────────────────────────────
function buildHomeEmbed(cart) {
  const count = cart.items.length;
  return new EmbedBuilder()
    .setTitle('🛒 Arki\'s Family — Ticket Shop')
    .setDescription(
      'Bienvenue dans la boutique ! Navigue pour ajouter des produits à ton panier.\n\n' +
      (count > 0 ? `🛒 **${count} article(s) dans ton panier**` : '*Ton panier est vide.*')
    )
    .setColor(0x7c5cfc)
    .setFooter({ text: 'Navigation visible uniquement par toi' });
}

// ── Menu navigation principal ─────────────────────────────────────────────────
function buildMainMenu() {
  return new StringSelectMenuBuilder()
    .setCustomId('st_main_menu')
    .setPlaceholder('Que veux-tu faire ?')
    .addOptions([
      { label: '🦕 Dinos', description: 'Sélectionner un ou plusieurs dinos', value: 'dinos' },
      { label: '📦 Packs & Produits', description: 'Packs composés et produits unitaires', value: 'packs' },
      { label: '🛒 Voir mon panier', description: 'Consulter et finaliser ta commande', value: 'cart' },
    ]);
}

// ── Liste des dinos (paginée par lettre) ──────────────────────────────────────
function buildDinoLetterMenu() {
  const data = getDinoData();
  const dinos = (data.dinos || []).filter(d => !d.notAvailableShop);
  const letters = [...new Set(dinos.map(d => d.name.trim()[0].toUpperCase()))].sort();

  const options = letters.slice(0, 25).map(l => ({
    label: `Lettre ${l}`,
    value: `letter_${l}`,
    emoji: '🔤',
  }));

  return new StringSelectMenuBuilder()
    .setCustomId('st_dino_letter')
    .setPlaceholder('Choisir une lettre...')
    .addOptions(options);
}

// ── Liste des dinos pour une lettre ──────────────────────────────────────────
function buildDinoListMenu(letter) {
  const data = getDinoData();
  const dinos = (data.dinos || []).filter(
    d => d.name.trim()[0].toUpperCase() === letter && !d.notAvailableShop
  );

  if (dinos.length === 0) return null;

  const options = dinos.slice(0, 25).map(d => {
    const basePrice = formatPrice(d.priceDiamonds, d.priceStrawberries);
    const hasVariants = d.variants && d.variants.filter(v => !v.hidden && !v.notAvailableShop).length > 0;
    return {
      label: d.name.trim().slice(0, 100),
      description: (hasVariants ? `Variantes dispo · ` : '') + basePrice,
      value: d.id,
    };
  });

  return new StringSelectMenuBuilder()
    .setCustomId(`st_dino_select::${letter}`)
    .setPlaceholder('Sélectionner un dino...')
    .addOptions(options);
}

// ── Embed détail d'un dino ────────────────────────────────────────────────────
function buildDinoDetailEmbed(dino) {
  const embed = new EmbedBuilder()
    .setTitle(`🦕 ${dino.name.trim()}`)
    .setColor(0x2ecc71);

  const lines = [];
  lines.push(`**Prix de base :** ${formatPrice(dino.priceDiamonds, dino.priceStrawberries)}`);

  if (dino.noReduction) lines.push('> ⛔ *Réductions non applicables*');
  if (dino.notAvailableDona) lines.push('> 🚫 *Non disponible avec packs dona*');
  if (dino.uniquePerTribe) lines.push('> 👥 *Unique par tribu*');
  if (dino.coupleInventaire) lines.push('> 💑 *Un achat via inventaire = x2 dinos*');

  const visibleVariants = (dino.variants || []).filter(v => !v.hidden && !v.notAvailableShop);
  if (visibleVariants.length > 0) {
    lines.push('\n**Variantes disponibles :**');
    for (const v of visibleVariants) {
      lines.push(`• ${v.label} — ${formatPrice(v.priceDiamonds, v.priceStrawberries)}`);
    }
  }

  embed.setDescription(lines.join('\n'));
  return embed;
}

// ── Menu variante d'un dino ───────────────────────────────────────────────────
function buildVariantMenu(dino) {
  const visibleVariants = (dino.variants || []).filter(v => !v.hidden && !v.notAvailableShop);
  const options = [
    { label: `${dino.name.trim()} (standard)`, value: 'base', description: formatPrice(dino.priceDiamonds, dino.priceStrawberries) },
    ...visibleVariants.map(v => ({
      label: `${dino.name.trim()} — ${v.label}`,
      value: v.label,
      description: formatPrice(v.priceDiamonds, v.priceStrawberries),
    })),
  ];

  return new StringSelectMenuBuilder()
    .setCustomId(`st_dino_variant::${dino.id}`)
    .setPlaceholder('Choisir la variante...')
    .addOptions(options.slice(0, 25));
}

// ── Menu sexe ─────────────────────────────────────────────────────────────────
function buildSexeMenu(dinoId, variantLabel) {
  return new StringSelectMenuBuilder()
    .setCustomId(`st_dino_sexe::${dinoId}::${variantLabel}`)
    .setPlaceholder('Sexe souhaité...')
    .addOptions([
      { label: '♂️ Mâle', value: 'Mâle', emoji: '♂️' },
      { label: '♀️ Femelle', value: 'Femelle', emoji: '♀️' },
    ]);
}

// ── Menu stat forte ───────────────────────────────────────────────────────────
function buildStatMenu(dinoId, variantLabel, sexe) {
  return new StringSelectMenuBuilder()
    .setCustomId(`st_dino_stat::${dinoId}::${variantLabel}::${sexe}`)
    .setPlaceholder('Stat forte souhaitée...')
    .addOptions(
      STATS.map(s => ({ label: `${STAT_EMOJIS[s]} ${s}`, value: s }))
    );
}

// ── Embed panier ──────────────────────────────────────────────────────────────
function buildCartEmbed(cart, discount = 0, discountRoleName = null) {
  const items = cart.items;
  if (items.length === 0) {
    return new EmbedBuilder()
      .setTitle('🛒 Ton panier')
      .setDescription('*Ton panier est vide.*')
      .setColor(0x7c5cfc);
  }

  let desc = '';
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    desc += `**${i + 1}.** `;
    if (item.type === 'dino') {
      desc += `🦕 **${item.name}**`;
      if (item.variant !== 'base') desc += ` (${item.variant})`;
      desc += `\n> ♟️ ${item.sexe} · ${STAT_EMOJIS[item.stat] || ''} ${item.stat}`;
    } else {
      desc += `📦 **${item.name}**`;
      if (item.selectedOption) desc += ` — *${item.selectedOption}*`;
    }

    const dBase = item.priceDiamonds || 0;
    const sBase = item.priceStrawberries || 0;
    let d = dBase;
    let s = sBase;
    const hasDiscount = !item.noReduction && discount > 0;
    if (hasDiscount) {
      d = applyDiscount(d, discount);
      s = applyDiscount(s, discount);
    }
    if (hasDiscount && (dBase > 0 || sBase > 0)) {
      desc += `\n> 💰 ~~${formatPrice(dBase, sBase)}~~ → ${formatPrice(d, s)} *(−${discount}%)*`;
    } else {
      desc += `\n> 💰 ${formatPrice(d, s)}`;
      if (item.noReduction && discount > 0) desc += ' *(réd. non applicable)*';
    }
    desc += '\n\n';
  }

  const { totalDiamonds, totalStrawberries } = calcCartTotal(items, discount);
  const { totalDiamonds: totalBase, totalStrawberries: totalBaseS } = calcCartTotal(items, 0);
  const embed = new EmbedBuilder()
    .setTitle('🛒 Ton panier')
    .setDescription(desc.trim())
    .setColor(0x7c5cfc);

  let totalLine = '';
  if (discount > 0 && discountRoleName && (totalBase !== totalDiamonds || totalBaseS !== totalStrawberries)) {
    totalLine = `~~${formatPrice(totalBase, totalBaseS)}~~ → **${formatPrice(totalDiamonds, totalStrawberries)}** *(${discountRoleName} −${discount}%)*`;
  } else {
    totalLine = `**${formatPrice(totalDiamonds, totalStrawberries)}**`;
  }
  embed.addFields({
    name: '💰 Total estimé',
    value: totalLine,
    inline: false,
  });

  if (cart.comment) {
    embed.addFields({ name: '💬 Commentaire', value: cart.comment, inline: false });
  }

  return embed;
}

// ── Boutons panier ────────────────────────────────────────────────────────────
function buildCartButtons(cartIsEmpty) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('st_cart_remove').setLabel('➖ Retirer un article').setStyle(ButtonStyle.Danger).setDisabled(cartIsEmpty),
    new ButtonBuilder().setCustomId('st_cart_comment').setLabel('💬 Ajouter un commentaire').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('st_cart_validate').setLabel('✅ Valider ma commande').setStyle(ButtonStyle.Success).setDisabled(cartIsEmpty),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('st_back_home').setLabel('← Retour boutique').setStyle(ButtonStyle.Secondary),
  );
  return [row1, row2];
}

// ── Embed récap ticket (dans le thread) ──────────────────────────────────────
function buildOrderRecapEmbed(cart, discount, discountRoleName, deductionsChosen, userId) {
  const { totalDiamonds, totalStrawberries } = calcCartTotal(cart.items, discount);

  let desc = '';
  for (let i = 0; i < cart.items.length; i++) {
    const item = cart.items[i];
    desc += `**${i + 1}.** `;
    if (item.type === 'dino') {
      desc += `🦕 **${item.name}**`;
      if (item.variant !== 'base') desc += ` *(${item.variant})*`;
      desc += `\n> ${item.sexe} · ${STAT_EMOJIS[item.stat] || ''}${item.stat}`;
    } else {
      desc += `📦 **${item.name}**`;
      if (item.selectedOption) desc += ` *(${item.selectedOption})*`;
    }
    const dBase = item.priceDiamonds || 0;
    const sBase = item.priceStrawberries || 0;
    let d = dBase;
    let s = sBase;
    const hasDiscount = !item.noReduction && discount > 0;
    if (hasDiscount) {
      d = applyDiscount(d, discount);
      s = applyDiscount(s, discount);
    }
    if (hasDiscount && (dBase > 0 || sBase > 0)) {
      desc += `\n> 💰 ~~${formatPrice(dBase, sBase)}~~ → ${formatPrice(d, s)} *(−${discount}%)*\n`;
    } else {
      desc += `\n> 💰 ${formatPrice(d, s)}\n`;
    }
  }

  const { totalDiamonds: totalBase, totalStrawberries: totalBaseS } = calcCartTotal(cart.items, 0);
  let totalValue = '';
  if (discount > 0 && discountRoleName && (totalBase !== totalDiamonds || totalBaseS !== totalStrawberries)) {
    totalValue = `~~${formatPrice(totalBase, totalBaseS)}~~\n→ **${formatPrice(totalDiamonds, totalStrawberries)}** *(${discountRoleName} −${discount}%)*`;
  } else {
    totalValue = `**${formatPrice(totalDiamonds, totalStrawberries)}**`;
  }

  const embed = new EmbedBuilder()
    .setTitle('📋 Récapitulatif de commande')
    .setDescription(desc.trim())
    .setColor(0xe67e22)
    .addFields({ name: '💰 Total à régler', value: totalValue, inline: false });

  if (deductionsChosen && deductionsChosen.length > 0) {
    const ded = deductionsChosen.map(d => `${d.label} : −${d.usedQty} utilisé(s)`).join('\n');
    embed.addFields({ name: '📦 Déductions inventaire', value: ded, inline: false });
  }

  if (cart.comment) {
    embed.addFields({ name: '💬 Commentaire du joueur', value: cart.comment, inline: false });
  }

  embed.addFields({ name: '👤 Joueur', value: `<@${userId}>`, inline: true });
  embed.setFooter({ text: '⏳ En attente de validation admin' });
  embed.setTimestamp();

  return embed;
}

// ── Boutons admin dans le thread ──────────────────────────────────────────────
function buildAdminButtons(orderId) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`st_admin_validate::${orderId}`)
      .setLabel('✅ Valider & Encaisser')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`st_admin_cancel::${orderId}`)
      .setLabel('❌ Annuler la commande')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`st_admin_modify::${orderId}`)
      .setLabel('✏️ Modifier avant paiement')
      .setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`st_admin_close::${orderId}`)
      .setLabel('🔒 Fermer le ticket')
      .setStyle(ButtonStyle.Secondary),
  );
  return [row1, row2];
}

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLERS PRINCIPAUX
// ═══════════════════════════════════════════════════════════════════════════════

async function handleShopTicketCommand(interaction) {
  const cart = newCart(interaction.user.id);
  activeCarts.set(interaction.user.id, cart);

  const embed = buildHomeEmbed(cart);
  const row = new ActionRowBuilder().addComponents(buildMainMenu());
  await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

async function handleShopTicketInteraction(interaction) {
  const id = interaction.customId;
  const userId = interaction.user.id;
  const cart = getCart(userId);

  // ── Menu principal ──────────────────────────────────────────────────────────
  if (id === 'st_main_menu') {
    const val = interaction.values[0];

    if (val === 'dinos') {
      const letterMenu = buildDinoLetterMenu();
      const row1 = new ActionRowBuilder().addComponents(letterMenu);
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('st_back_home').setLabel('← Retour').setStyle(ButtonStyle.Secondary)
      );
      return interaction.update({
        embeds: [new EmbedBuilder().setTitle('🦕 Dinos — Choix de la lettre').setColor(0x2ecc71).setDescription('Sélectionne la première lettre du dino souhaité.')],
        components: [row1, row2],
      });
    }

    if (val === 'packs') {
      return showPackMenu(interaction);
    }

    if (val === 'cart') {
      return showCart(interaction, cart);
    }
  }

  // ── Retour accueil ──────────────────────────────────────────────────────────
  if (id === 'st_back_home') {
    const embed = buildHomeEmbed(cart);
    const row = new ActionRowBuilder().addComponents(buildMainMenu());
    return interaction.update({ embeds: [embed], components: [row] });
  }

  // ── Lettre sélectionnée (dinos) ─────────────────────────────────────────────
  if (id === 'st_dino_letter') {
    const letter = interaction.values[0].replace('letter_', '');
    const dinoMenu = buildDinoListMenu(letter);
    if (!dinoMenu) {
      return interaction.update({
        embeds: [new EmbedBuilder().setColor(0xe74c3c).setDescription('❌ Aucun dino disponible pour cette lettre.')],
        components: [new ActionRowBuilder().addComponents(buildDinoLetterMenu()),
          new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('st_back_home').setLabel('← Retour').setStyle(ButtonStyle.Secondary))],
      });
    }
    const letterMenu = buildDinoLetterMenu();
    return interaction.update({
      embeds: [new EmbedBuilder().setTitle(`🦕 Dinos — ${letter}`).setColor(0x2ecc71).setDescription('Sélectionne un dino pour voir ses détails.')],
      components: [
        new ActionRowBuilder().addComponents(letterMenu),
        new ActionRowBuilder().addComponents(dinoMenu),
        new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('st_back_home').setLabel('← Retour').setStyle(ButtonStyle.Secondary)),
      ],
    });
  }

  // ── Dino sélectionné ────────────────────────────────────────────────────────
  if (id.startsWith('st_dino_select::')) {
    const letter = id.split('::')[1];
    const dinoId = interaction.values[0];
    const dino = getDino(dinoId);
    if (!dino) return interaction.update({ content: '❌ Dino introuvable.', components: [], embeds: [] });

    const detailEmbed = buildDinoDetailEmbed(dino);
    const visibleVariants = (dino.variants || []).filter(v => !v.hidden && !v.notAvailableShop);
    const rows = [];

    if (visibleVariants.length > 0) {
      rows.push(new ActionRowBuilder().addComponents(buildVariantMenu(dino)));
    } else {
      rows.push(new ActionRowBuilder().addComponents(buildSexeMenu(dino.id, 'base')));
    }
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`st_dino_letter_back::${letter}`).setLabel('← Retour').setStyle(ButtonStyle.Secondary)
    ));

    return interaction.update({ embeds: [detailEmbed], components: rows });
  }

  // ── Retour liste dinos par lettre ───────────────────────────────────────────
  if (id.startsWith('st_dino_letter_back::')) {
    const letter = id.split('::')[1];
    const dinoMenu = buildDinoListMenu(letter);
    const letterMenu = buildDinoLetterMenu();
    const rows = [new ActionRowBuilder().addComponents(letterMenu)];
    if (dinoMenu) rows.push(new ActionRowBuilder().addComponents(dinoMenu));
    rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('st_back_home').setLabel('← Retour').setStyle(ButtonStyle.Secondary)));
    return interaction.update({
      embeds: [new EmbedBuilder().setTitle(`🦕 Dinos — ${letter}`).setColor(0x2ecc71).setDescription('Sélectionne un dino.')],
      components: rows,
    });
  }

  // ── Variante sélectionnée ───────────────────────────────────────────────────
  if (id.startsWith('st_dino_variant::')) {
    const dinoId = id.split('::')[1];
    const variantLabel = interaction.values[0];
    const dino = getDino(dinoId);
    if (!dino) return;

    const sexeMenu = buildSexeMenu(dinoId, variantLabel);
    let price;
    if (variantLabel === 'base') {
      price = formatPrice(dino.priceDiamonds, dino.priceStrawberries);
    } else {
      const v = (dino.variants || []).find(x => x.label === variantLabel);
      price = v ? formatPrice(v.priceDiamonds, v.priceStrawberries) : '?';
    }

    return interaction.update({
      embeds: [new EmbedBuilder()
        .setTitle(`🦕 ${dino.name.trim()}${variantLabel !== 'base' ? ` — ${variantLabel}` : ''}`)
        .setDescription(`**Prix :** ${price}\n\nChoisis maintenant le **sexe** souhaité.`)
        .setColor(0x2ecc71)],
      components: [
        new ActionRowBuilder().addComponents(sexeMenu),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`st_dino_select::${dino.name.trim()[0].toUpperCase()}`).setLabel('← Changer de dino').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('st_back_home').setLabel('⌂ Accueil').setStyle(ButtonStyle.Secondary)
        ),
      ],
    });
  }

  // ── Sexe sélectionné ────────────────────────────────────────────────────────
  if (id.startsWith('st_dino_sexe::')) {
    const [, dinoId, variantLabel] = id.split('::');
    const sexe = interaction.values[0];
    const dino = getDino(dinoId);
    if (!dino) return;

    const statMenu = buildStatMenu(dinoId, variantLabel, sexe);
    return interaction.update({
      embeds: [new EmbedBuilder()
        .setTitle(`🦕 ${dino.name.trim()}`)
        .setDescription(`**Sexe :** ${sexe}\n\nChoisis la **stat forte** souhaitée.`)
        .setColor(0x2ecc71)],
      components: [
        new ActionRowBuilder().addComponents(statMenu),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('st_back_home').setLabel('⌂ Accueil').setStyle(ButtonStyle.Secondary)
        ),
      ],
    });
  }

  // ── Stat forte sélectionnée → ajout au panier ───────────────────────────────
  if (id.startsWith('st_dino_stat::')) {
    const parts = id.split('::');
    const dinoId = parts[1];
    const variantLabel = parts[2];
    const sexe = parts[3];
    const stat = interaction.values[0];
    const dino = getDino(dinoId);
    if (!dino) return;

    let priceDiamonds = dino.priceDiamonds;
    let priceStrawberries = dino.priceStrawberries;
    let displayName = dino.name.trim();

    if (variantLabel !== 'base') {
      const v = (dino.variants || []).find(x => x.label === variantLabel);
      if (v) {
        priceDiamonds = v.priceDiamonds;
        priceStrawberries = v.priceStrawberries;
        displayName += ` (${variantLabel})`;
      }
    }

    const cartItem = {
      id: genId(),
      type: 'dino',
      dinoId: dino.id,
      name: displayName,
      variant: variantLabel,
      sexe,
      stat,
      priceDiamonds,
      priceStrawberries,
      noReduction: dino.noReduction || false,
      notAvailableDona: dino.notAvailableDona || false,
      isShoulder: dino.isShoulder || false,
    };

    cart.items.push(cartItem);

    return interaction.update({
      embeds: [new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('✅ Ajouté au panier !')
        .setDescription(`**${displayName}**\n${sexe} · ${STAT_EMOJIS[stat]}${stat}\n💰 ${formatPrice(priceDiamonds, priceStrawberries)}`)
        .setFooter({ text: `${cart.items.length} article(s) dans ton panier` })],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('st_main_menu_dinos').setLabel('🦕 Ajouter un autre dino').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('st_view_cart_btn').setLabel('🛒 Voir mon panier').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('st_back_home').setLabel('⌂ Accueil').setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
  }

  // ── Bouton rapide : autre dino ──────────────────────────────────────────────
  if (id === 'st_main_menu_dinos') {
    const letterMenu = buildDinoLetterMenu();
    const row1 = new ActionRowBuilder().addComponents(letterMenu);
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('st_back_home').setLabel('← Retour').setStyle(ButtonStyle.Secondary)
    );
    return interaction.update({
      embeds: [new EmbedBuilder().setTitle('🦕 Dinos — Choix de la lettre').setColor(0x2ecc71).setDescription('Sélectionne la première lettre du dino souhaité.')],
      components: [row1, row2],
    });
  }

  // ── Bouton rapide : voir panier ─────────────────────────────────────────────
  if (id === 'st_view_cart_btn') {
    return showCart(interaction, cart);
  }

  // ── Packs & unitaires ───────────────────────────────────────────────────────
  if (id === 'st_packs_select') {
    const packId = interaction.values[0];
    const shop = getShop();
    const pack = shop.packs.find(p => p.id === packId);
    if (!pack) return interaction.update({ content: '❌ Produit introuvable.', components: [], embeds: [] });

    const hasOptions = Array.isArray(pack.options) && pack.options.length > 0;
    if (hasOptions) {
      const optMenu = new StringSelectMenuBuilder()
        .setCustomId(`st_pack_option::${packId}`)
        .setPlaceholder('Choisir une formule...')
        .addOptions(pack.options.slice(0, 25).map(o => ({
          label: o.name.slice(0, 100),
          description: formatPrice(o.priceDiamonds || 0, o.priceStrawberries || 0),
          value: o.name,
        })));

      return interaction.update({
        embeds: [buildPackDetailEmbed(pack)],
        components: [
          new ActionRowBuilder().addComponents(optMenu),
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('st_back_packs').setLabel('← Retour').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('st_back_home').setLabel('⌂ Accueil').setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
    }

    // Pas d'options → ajout direct
    addPackToCart(cart, pack, null);
    return interaction.update({
      embeds: [new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('✅ Ajouté au panier !')
        .setDescription(`**${pack.name}**\n💰 ${formatPrice(pack.priceDiamonds, pack.priceStrawberries)}`)
        .setFooter({ text: `${cart.items.length} article(s) dans ton panier` })],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('st_back_packs').setLabel('📦 Continuer les achats').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('st_view_cart_btn').setLabel('🛒 Voir mon panier').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('st_back_home').setLabel('⌂ Accueil').setStyle(ButtonStyle.Secondary),
      )],
    });
  }

  // ── Option de formule sélectionnée ─────────────────────────────────────────
  if (id.startsWith('st_pack_option::')) {
    const packId = id.split('::')[1];
    const optionName = interaction.values[0];
    const shop = getShop();
    const pack = shop.packs.find(p => p.id === packId);
    if (!pack) return;
    const option = (pack.options || []).find(o => o.name === optionName);
    if (!option) return;

    addPackToCart(cart, pack, option);
    return interaction.update({
      embeds: [new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('✅ Ajouté au panier !')
        .setDescription(`**${pack.name}** — *${optionName}*\n💰 ${formatPrice(option.priceDiamonds || 0, option.priceStrawberries || 0)}`)
        .setFooter({ text: `${cart.items.length} article(s) dans ton panier` })],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('st_back_packs').setLabel('📦 Continuer les achats').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('st_view_cart_btn').setLabel('🛒 Voir mon panier').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('st_back_home').setLabel('⌂ Accueil').setStyle(ButtonStyle.Secondary),
      )],
    });
  }

  // ── Retour liste packs ──────────────────────────────────────────────────────
  if (id === 'st_back_packs') {
    return showPackMenu(interaction);
  }

  // ── Panier : retirer un article ─────────────────────────────────────────────
  if (id === 'st_cart_remove') {
    if (cart.items.length === 0) {
      return interaction.reply({ content: '❌ Ton panier est déjà vide.', ephemeral: true });
    }
    const options = cart.items.slice(0, 25).map((item, i) => ({
      label: `${i + 1}. ${item.type === 'dino' ? '🦕 ' : '📦 '}${item.name}${item.type === 'dino' ? ` · ${item.sexe} · ${item.stat}` : ''}`.slice(0, 100),
      value: item.id,
    }));
    const removeMenu = new StringSelectMenuBuilder()
      .setCustomId('st_cart_remove_select')
      .setPlaceholder('Sélectionner l\'article à retirer...')
      .addOptions(options);
    return interaction.reply({
      content: 'Quel article veux-tu retirer de ton panier ?',
      components: [new ActionRowBuilder().addComponents(removeMenu)],
      ephemeral: true,
    });
  }

  // ── Confirmation retrait article ────────────────────────────────────────────
  if (id === 'st_cart_remove_select') {
    const itemId = interaction.values[0];
    const idx = cart.items.findIndex(x => x.id === itemId);
    if (idx !== -1) cart.items.splice(idx, 1);
    await interaction.update({ content: '✅ Article retiré du panier.', components: [] });
    return showCartFollowup(interaction, cart);
  }

  // ── Commentaire ─────────────────────────────────────────────────────────────
  if (id === 'st_cart_comment') {
    const modal = new ModalBuilder()
      .setCustomId('st_comment_modal')
      .setTitle('Ajouter un commentaire');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('comment_text')
          .setLabel('Ton commentaire (infos spéciales, questions...)')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Ex: Je voudrais un dino avec les couleurs bleues...')
          .setRequired(false)
          .setMaxLength(500)
          .setValue(cart.comment || '')
      )
    );
    return interaction.showModal(modal);
  }

  // ── Modal commentaire soumis ────────────────────────────────────────────────
  if (id === 'st_comment_modal') {
    cart.comment = interaction.fields.getTextInputValue('comment_text') || '';
    const memberRoleIds = await getMemberRoleIds(interaction);
    const { discount: disc, roleName: rn } = await getMaxDiscount(memberRoleIds);
    const updatedEmbed = buildCartEmbed(cart, disc, rn);
    const rows = buildCartButtons(cart.items.length === 0);
    await interaction.reply({ content: '✅ Commentaire enregistré !', embeds: [updatedEmbed], components: rows, ephemeral: true });
    return;
  }

  // ── Valider commande ────────────────────────────────────────────────────────
  if (id === 'st_cart_validate') {
    return handleCartValidation(interaction, cart);
  }

  // ── Bouton : ouvrir un ticket depuis le panneau ──────────────────────────────
  if (id === 'st_open_ticket_shop') {
    return handleShopTicketCommand(interaction);
  }

  // ── Bouton admin : valider & encaisser ──────────────────────────────────────
  if (id.startsWith('st_admin_validate::')) {
    const orderId = id.split('::')[1];
    return handleAdminValidate(interaction, orderId);
  }

  // ── Bouton admin : annuler ──────────────────────────────────────────────────
  if (id.startsWith('st_admin_cancel::')) {
    const orderId = id.split('::')[1];
    return handleAdminCancel(interaction, orderId);
  }

  // ── Bouton admin : modifier ─────────────────────────────────────────────────
  if (id.startsWith('st_admin_modify::')) {
    const orderId = id.split('::')[1];
    const order = activeOrders.get(orderId);
    if (!order) return interaction.reply({ content: '❌ Commande introuvable.', ephemeral: true });
    return interaction.reply({
      content: `✏️ La commande reste ouverte et le paiement n'a pas encore été déclenché. Tu peux modifier les informations ici directement.`,
      ephemeral: true,
    });
  }

  // ── Bouton admin : fermer le ticket (confirmation) ───────────────────────────
  if (id.startsWith('st_admin_close::')) {
    const orderId = id.split('::')[1];
    return handleAdminClose(interaction, orderId);
  }

  // ── Confirmation fermeture ────────────────────────────────────────────────
  if (id.startsWith('st_close_confirm::')) {
    const orderId = id.split('::')[1];
    return handleCloseConfirm(interaction, orderId);
  }

  // ── Annuler fermeture ─────────────────────────────────────────────────────
  if (id.startsWith('st_close_cancel::')) {
    const orderId = id.split('::')[1];
    return handleCloseCancel(interaction, orderId);
  }

  // ── Joueur : choix du mode de paiement ───────────────────────────────────
  if (id.startsWith('st_pay_method::')) {
    const parts = id.split('::');
    const orderId = parts[1];
    const methodKey = parts[2];
    return handlePayMethod(interaction, orderId, methodKey);
  }

  // ── Voir le récap de commande ──────────────────────────────────────────────
  if (id.startsWith('st_view_order::')) {
    const orderId = id.split('::')[1];
    return handleViewOrder(interaction, orderId);
  }

  // ── Nouvelle commande depuis le ticket ────────────────────────────────────
  if (id === 'st_new_order') {
    return handleNewOrder(interaction);
  }
}

// ── Afficher le menu packs ────────────────────────────────────────────────────
async function showPackMenu(interaction) {
  const shop = getShop();
  const cats = getCategories();
  const packs = (shop.packs || []).filter(p => p.available !== false);

  if (packs.length === 0) {
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(0xe74c3c).setDescription('❌ Aucun produit disponible.')],
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('st_back_home').setLabel('← Retour').setStyle(ButtonStyle.Secondary))],
    });
  }

  const options = packs.slice(0, 25).map(p => {
    const cat = cats.find(c => c.id === p.category);
    const emoji = cat?.emoji || '📦';
    const hasOptions = Array.isArray(p.options) && p.options.length > 0;
    const priceStr = hasOptions ? `${p.options.length} formule(s)` : formatPrice(p.priceDiamonds || 0, p.priceStrawberries || 0);
    return {
      label: `${emoji} ${p.name}`.slice(0, 100),
      description: priceStr.slice(0, 100),
      value: p.id,
    };
  });

  const packMenu = new StringSelectMenuBuilder()
    .setCustomId('st_packs_select')
    .setPlaceholder('Choisir un produit...')
    .addOptions(options);

  return interaction.update({
    embeds: [new EmbedBuilder()
      .setTitle('📦 Packs & Produits unitaires')
      .setDescription('Sélectionne un produit pour voir ses détails.')
      .setColor(0xe74c3c)
      .setFooter({ text: `${packs.length} produit(s) disponible(s)` })],
    components: [
      new ActionRowBuilder().addComponents(packMenu),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('st_back_home').setLabel('← Retour').setStyle(ButtonStyle.Secondary)
      ),
    ],
  });
}

// ── Afficher le panier ────────────────────────────────────────────────────────
async function showCart(interaction, cart) {
  const memberRoleIds = await getMemberRoleIds(interaction);
  const { discount, roleName } = await getMaxDiscount(memberRoleIds);
  const embed = buildCartEmbed(cart, discount, roleName);
  const rows = buildCartButtons(cart.items.length === 0);
  return interaction.update({ embeds: [embed], components: rows });
}

// ── Afficher le panier en followup (après retrait) ───────────────────────────
async function showCartFollowup(interaction, cart) {
  const memberRoleIds = await getMemberRoleIds(interaction);
  const { discount, roleName } = await getMaxDiscount(memberRoleIds);
  const embed = buildCartEmbed(cart, discount, roleName);
  const rows = buildCartButtons(cart.items.length === 0);
  try {
    await interaction.followUp({ embeds: [embed], components: rows, ephemeral: true });
  } catch (e) {}
}

// ── Embed détail pack ─────────────────────────────────────────────────────────
function buildPackDetailEmbed(pack) {
  const embed = new EmbedBuilder().setTitle(`📦 ${pack.name}`).setColor(0xe74c3c);
  const lines = [];
  if (pack.content) lines.push(pack.content);
  const hasOptions = Array.isArray(pack.options) && pack.options.length > 0;
  if (hasOptions) {
    lines.push('\n**Formules disponibles :**');
    for (const o of pack.options) lines.push(`• **${o.name}** — ${formatPrice(o.priceDiamonds || 0, o.priceStrawberries || 0)}`);
  } else {
    lines.push(`\n**Prix :** ${formatPrice(pack.priceDiamonds, pack.priceStrawberries)}`);
  }
  if (pack.noReduction) lines.push('> ⛔ *Réductions non applicables*');
  if (pack.donationAvailable) lines.push('> ✅ *Compatible pack inventaire dona*');
  if (pack.notCompatible) lines.push('> 🚫 *Non compatible avec les packs inventaire*');
  embed.setDescription(lines.join('\n'));
  return embed;
}

// ── Ajouter un pack au panier ─────────────────────────────────────────────────
function addPackToCart(cart, pack, option) {
  const item = {
    id: genId(),
    type: pack.type === 'unitaire' ? 'unitaire' : 'pack',
    packId: pack.id,
    name: pack.name,
    selectedOption: option ? option.name : null,
    priceDiamonds: option ? (option.priceDiamonds || 0) : (pack.priceDiamonds || 0),
    priceStrawberries: option ? (option.priceStrawberries || 0) : (pack.priceStrawberries || 0),
    noReduction: pack.noReduction || false,
    donationAvailable: pack.donationAvailable || false,
    notCompatible: pack.notCompatible || false,
  };
  cart.items.push(item);
}

// ── Flux validation du panier ─────────────────────────────────────────────────
async function handleCartValidation(interaction, cart) {
  if (cart.items.length === 0) {
    return interaction.reply({ content: '❌ Ton panier est vide !', ephemeral: true });
  }

  // 1. Récupérer la réduction de rôle max
  const memberRoleIds = await getMemberRoleIds(interaction);
  const { discount, roleName } = await getMaxDiscount(memberRoleIds);

  // 2. Analyser l'inventaire pour préparer les options de paiement (sans déduire)
  const playerInventory = getPlayerInventory(interaction.user.id);
  const paymentOptions = getPaymentOptions(cart.items, playerInventory);

  // 3. Créer le ticket — le joueur choisira son mode de paiement dans le salon
  return createTicketThread(interaction, cart, discount, roleName, paymentOptions);
}

// ── Texte récap du panier ─────────────────────────────────────────────────────
function buildCartSummaryText(cart, discount, roleName) {
  const { totalDiamonds, totalStrawberries } = calcCartTotal(cart.items, discount);
  const lines = [];
  for (const item of cart.items) {
    lines.push(`• ${item.type === 'dino' ? '🦕' : '📦'} **${item.name}**${item.type === 'dino' ? ` · ${item.sexe} · ${STAT_EMOJIS[item.stat]}${item.stat}` : ''}`);
  }
  lines.push('');
  lines.push(`**Total :** ${formatPrice(totalDiamonds, totalStrawberries)}`);
  if (discount > 0 && roleName) lines.push(`*Réduction ${roleName} : −${discount}%*`);
  return lines.join('\n');
}

// ── Créer le thread ticket ────────────────────────────────────────────────────
async function createTicketThread(interaction, cart, discount = 0, discountRoleName = null, paymentOptions = []) {
  const settings = getSettings();
  const shop = require('./shopManager').getShop();

  try {
    const guildMember = await interaction.guild.members.fetch(interaction.user.id).catch(() => interaction.member);
    const username = guildMember?.displayName || interaction.user.username;

    // ── Construire les overwrites de permissions ─────────────────────────────
    const permOverwrites = [
      // @everyone : aucun accès
      {
        id: interaction.guild.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      // L'acheteur : lecture + envoi
      {
        id: interaction.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
        ],
      },
    ];

    // Rôles admin configurés dans le shop
    const adminRoleIds = Array.isArray(shop.shopTicketAdminRoleIds) ? shop.shopTicketAdminRoleIds : [];
    // Fallback : modoRoleId depuis les paramètres globaux
    const modoRoleId = settings.guild?.modoRoleId;
    const allAdminRoles = [...new Set([...adminRoleIds, modoRoleId].filter(Boolean))];

    for (const roleId of allAdminRoles) {
      permOverwrites.push({
        id: roleId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageMessages,
        ],
      });
    }

    // ── Nom du salon ─────────────────────────────────────────────────────────
    const safeName = username.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '-').slice(0, 20);
    const channelName = `🛒-ticket-${safeName}`;

    // ── Créer le salon privé ─────────────────────────────────────────────────
    const ticketChannel = await interaction.guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: shop.shopTicketCategoryId || null,
      permissionOverwrites: permOverwrites,
      reason: `Ticket shop de ${username}`,
    });

    const orderId = genId();
    const orderData = {
      orderId,
      channelId: ticketChannel.id,
      userId: interaction.user.id,
      username,
      cart: JSON.parse(JSON.stringify(cart)),
      discount,
      discountRoleName,
      paymentOptions: JSON.parse(JSON.stringify(paymentOptions)),
      paymentMethod: null,   // sera défini par le joueur
      paymentChoice: null,   // option choisie (objet)
      createdAt: Date.now(),
      status: 'pending',
    };
    activeOrders.set(orderId, orderData);

    const recapEmbed = buildOrderRecapEmbed(cart, discount, discountRoleName, [], interaction.user.id);
    const adminBtns = buildAdminButtons(orderId);

    // ── Message admin (recap + boutons admin) ─────────────────────────────────
    await ticketChannel.send({
      content: `Bonjour <@${interaction.user.id}> ! 👋\n\nTa commande a bien été enregistrée. Un admin va la prendre en charge et valider le paiement une fois la livraison effectuée.\n\n*Tu peux ajouter des précisions directement ici.*`,
      embeds: [recapEmbed],
      components: adminBtns,
    });

    // ── Message joueur (choix du paiement + voir commande) ────────────────────
    const paymentEmbed = new EmbedBuilder()
      .setColor(0x9b59b6)
      .setTitle('💳 Mode de paiement')
      .setDescription(
        paymentOptions.length > 0
          ? 'Tu peux régler ta commande avec des items de ton inventaire ou en paiement direct.\n\nChaque option n\'est débitée **qu\'après la livraison** (validation admin).'
          : '💎 Tu régleras cette commande directement en diamants/fraises après la livraison.'
      );

    const payRows = buildPaymentChoiceComponents(orderId, paymentOptions);
    const viewRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`st_view_order::${orderId}`)
        .setLabel('📋 Voir ma commande')
        .setStyle(ButtonStyle.Secondary)
    );

    await ticketChannel.send({
      embeds: [paymentEmbed],
      components: paymentOptions.length > 0 ? [...payRows, viewRow] : [viewRow],
    });

    // ── Notifier dans le salon log admin ─────────────────────────────────────
    try {
      const logChannelId = settings.guild?.inventoryLogChannelId || shop.shopTicketChannelId;
      if (logChannelId) {
        const logChannel = await interaction.guild.channels.fetch(logChannelId).catch(() => null);
        if (logChannel) {
          const { totalDiamonds, totalStrawberries } = calcCartTotal(cart.items, discount);
          await logChannel.send(`🛒 **Nouveau ticket shop** de <@${interaction.user.id}> : <#${ticketChannel.id}>\n> ${cart.items.length} article(s) — Total estimé : ${formatPrice(totalDiamonds, totalStrawberries)}`);
        }
      }
    } catch (e) {}

    // ── Nettoyer le panier de navigation ─────────────────────────────────────
    activeCarts.delete(interaction.user.id);

    return interaction.update({
      embeds: [new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('✅ Ticket créé !')
        .setDescription(`Ton ticket a été ouvert : <#${ticketChannel.id}>\n\nUn admin va prendre en charge ta commande. Le paiement sera encaissé après la livraison.`)],
      components: [],
    });
  } catch (err) {
    console.error('[ShopTicket] Erreur création salon ticket:', err);
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle('❌ Erreur').setDescription(`Impossible de créer le ticket : ${err.message}\n\nVérifie que la catégorie ticket est configurée dans le dashboard.`)],
      components: [],
    });
  }
}

// ── Publication du panneau shop (embed + bouton) ──────────────────────────────
async function publishShopTicketPanel(interaction) {
  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('🛒 Shop Arki Family')
    .setDescription(
      '**Bienvenue dans le shop !**\n\n' +
      'Clique sur le bouton ci-dessous pour passer une commande.\n' +
      'Un ticket privé sera créé pour toi et un admin prendra en charge ta demande.\n\n' +
      '🦕 Dinos (variantes, sexe, stat forte)\n' +
      '📦 Packs & articles unitaires'
    )
    .setFooter({ text: 'Le paiement est encaissé après livraison.' });

  const btn = new ButtonBuilder()
    .setCustomId('st_open_ticket_shop')
    .setLabel('🎫 Ouvrir un ticket')
    .setStyle(ButtonStyle.Primary);

  const row = new ActionRowBuilder().addComponents(btn);

  await interaction.channel.send({ embeds: [embed], components: [row] });
  return interaction.reply({ content: '✅ Panneau shop publié dans ce salon !', ephemeral: true });
}

// ── Admin : valider & encaisser ───────────────────────────────────────────────
async function handleAdminValidate(interaction, orderId) {
  const order = activeOrders.get(orderId);
  if (!order) {
    return interaction.reply({ content: '❌ Commande introuvable ou déjà traitée.', ephemeral: true });
  }
  if (order.status !== 'pending') {
    return interaction.reply({ content: `⚠️ Cette commande a déjà été **${order.status === 'paid' ? 'encaissée' : 'annulée'}**.`, ephemeral: true });
  }

  const { cart, discount, discountRoleName, paymentChoice, userId } = order;
  const adminName = interaction.member?.displayName || interaction.user.username;

  try {
    let paymentDesc = '';

    if (paymentChoice && paymentChoice.id !== 'direct') {
      // ── Paiement par item inventaire ────────────────────────────────────────
      await removeFromInventory(
        userId, paymentChoice.inventoryId, paymentChoice.usedQty,
        interaction.user.id, `Commande shop #${orderId}`
      );
      paymentDesc += `> ${paymentChoice.label.split(' (')[0]} : −${paymentChoice.usedQty}\n`;

      // Calculer le reste à payer (items NON couverts par l'inventaire)
      const coveredIds = new Set(paymentChoice.coveredItemIds || []);
      const remainingItems = cart.items.filter(i => !coveredIds.has(i.id));
      const { totalDiamonds: remD, totalStrawberries: remS } = calcCartTotal(remainingItems, discount);
      if (remD > 0) {
        await removeFromInventory(userId, 'diamants', remD, interaction.user.id, `Commande shop #${orderId}`);
        paymentDesc += `> 💎 ${remD.toLocaleString('fr-FR')} diamants\n`;
      }
      if (remS > 0) {
        await removeFromInventory(userId, 'fraises', remS, interaction.user.id, `Commande shop #${orderId}`);
        paymentDesc += `> 🍓 ${remS.toLocaleString('fr-FR')} fraises\n`;
      }
    } else {
      // ── Paiement direct diamants + fraises ──────────────────────────────────
      const { totalDiamonds, totalStrawberries } = calcCartTotal(cart.items, discount);
      if (totalDiamonds > 0) {
        await removeFromInventory(userId, 'diamants', totalDiamonds, interaction.user.id, `Commande shop #${orderId}`);
        paymentDesc += `> 💎 ${totalDiamonds.toLocaleString('fr-FR')} diamants\n`;
      }
      if (totalStrawberries > 0) {
        await removeFromInventory(userId, 'fraises', totalStrawberries, interaction.user.id, `Commande shop #${orderId}`);
        paymentDesc += `> 🍓 ${totalStrawberries.toLocaleString('fr-FR')} fraises\n`;
      }
    }

    if (!paymentDesc.trim()) paymentDesc = '> *Aucun débit (commande gratuite ou gérée manuellement)*\n';

    order.status = 'paid';

    // Retirer les boutons du message admin
    try { await interaction.message.edit({ components: [] }); } catch (e) {}

    const paidEmbed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('✅ Commande validée & Paiement encaissé !')
      .setDescription(
        `**Admin :** ${adminName}\n` +
        `**Paiement débité :**\n${paymentDesc}\n` +
        `*Merci pour ta commande <@${userId}> !* 🎉`
      )
      .setTimestamp();

    const newOrderRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('st_new_order')
        .setLabel('🛒 Passer une nouvelle commande')
        .setStyle(ButtonStyle.Primary)
    );

    await interaction.reply({ embeds: [paidEmbed], components: [newOrderRow] });

  } catch (err) {
    console.error('[ShopTicket] Erreur encaissement:', err);
    return interaction.reply({ content: `❌ Erreur lors de l'encaissement : ${err.message}`, ephemeral: true });
  }
}

// ── Joueur : sélectionne son mode de paiement ─────────────────────────────────
async function handlePayMethod(interaction, orderId, methodKey) {
  // Chercher l'order depuis le channelId (le salon ticket)
  let order = activeOrders.get(orderId);
  if (!order) {
    // Fallback : chercher par channelId
    for (const [, o] of activeOrders) {
      if (o.channelId === interaction.channelId) { order = o; break; }
    }
  }
  if (!order) {
    return interaction.reply({ content: '❌ Commande introuvable.', ephemeral: true });
  }
  if (order.status !== 'pending') {
    return interaction.reply({ content: '⚠️ Cette commande a déjà été traitée.', ephemeral: true });
  }

  let choice;
  if (methodKey === 'direct') {
    choice = { id: 'direct', label: 'Paiement direct (💎+🍓)', coveredItemIds: [] };
  } else {
    const idx = parseInt(methodKey, 10);
    choice = (order.paymentOptions || [])[idx];
    if (!choice) {
      return interaction.reply({ content: '❌ Option de paiement invalide.', ephemeral: true });
    }
  }

  order.paymentMethod = choice.id;
  order.paymentChoice = choice;

  const label = choice.id === 'direct'
    ? '💎 Paiement direct (diamants + fraises)'
    : choice.label;

  // Désactiver les boutons de paiement
  try { await interaction.message.edit({ components: [] }); } catch (e) {}

  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('✅ Mode de paiement enregistré')
      .setDescription(`**Choix :** ${label}\n\nL'admin pourra maintenant valider ta commande et encaisser le paiement après livraison.`)
      .setTimestamp()],
  });
}

// ── Joueur/Admin : voir le récap de commande ──────────────────────────────────
async function handleViewOrder(interaction, orderId) {
  let order = activeOrders.get(orderId);
  if (!order) {
    for (const [, o] of activeOrders) {
      if (o.channelId === interaction.channelId) { order = o; break; }
    }
  }
  if (!order) {
    return interaction.reply({ content: '❌ Commande introuvable.', ephemeral: true });
  }

  const embed = buildOrderRecapEmbed(order.cart, order.discount, order.discountRoleName, [], order.userId);
  if (order.paymentChoice) {
    const payLabel = order.paymentChoice.id === 'direct'
      ? '💎 Paiement direct'
      : order.paymentChoice.label.split(' (')[0];
    embed.addFields({ name: '💳 Mode de paiement choisi', value: payLabel, inline: false });
  } else {
    embed.addFields({ name: '💳 Mode de paiement', value: '⏳ En attente du choix du joueur', inline: false });
  }

  return interaction.reply({ embeds: [embed], ephemeral: true });
}

// ── Joueur : passer une nouvelle commande depuis le ticket ────────────────────
async function handleNewOrder(interaction) {
  return handleShopTicketCommand(interaction);
}

// ── Admin : annuler la commande ───────────────────────────────────────────────
async function handleAdminCancel(interaction, orderId) {
  const order = activeOrders.get(orderId);
  if (!order) return interaction.reply({ content: '❌ Commande introuvable.', ephemeral: true });
  if (order.status !== 'pending') return interaction.reply({ content: '⚠️ Cette commande a déjà été traitée.', ephemeral: true });

  order.status = 'cancelled';
  try { await interaction.message.edit({ components: [] }); } catch (e) {}

  const adminName = interaction.member?.displayName || interaction.user.username;
  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle('❌ Commande annulée')
      .setDescription(`La commande de <@${order.userId}> a été annulée par **${adminName}**.\n\nAucun paiement n'a été effectué.\n\n*Utilise 🔒 Fermer le ticket pour supprimer ce salon.*`)
      .setTimestamp()],
  });
}

// ── Admin : demander confirmation avant de fermer le ticket ──────────────────
async function handleAdminClose(interaction, orderId) {
  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0xe67e22)
      .setTitle('⚠️ Fermer ce ticket ?')
      .setDescription('Cette action va **supprimer définitivement** ce salon.\nEs-tu sûr(e) de vouloir fermer le ticket ?')
    ],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`st_close_confirm::${orderId}`)
        .setLabel('✅ Oui, fermer le ticket')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`st_close_cancel::${orderId}`)
        .setLabel('❌ Annuler')
        .setStyle(ButtonStyle.Secondary),
    )],
    ephemeral: true,
  });
}

// ── Admin : confirme la fermeture ─────────────────────────────────────────────
async function handleCloseConfirm(interaction, orderId) {
  const adminName = interaction.member?.displayName || interaction.user.username;
  activeOrders.delete(orderId);

  try {
    await interaction.update({
      embeds: [new EmbedBuilder()
        .setColor(0x95a5a6)
        .setTitle('🔒 Ticket fermé')
        .setDescription(`Fermeture par **${adminName}** — salon supprimé dans 5 secondes.`)
      ],
      components: [],
    });
  } catch (e) {}

  // Envoyer un message public dans le salon avant de le supprimer
  try {
    await interaction.channel.send({
      embeds: [new EmbedBuilder()
        .setColor(0x95a5a6)
        .setTitle('🔒 Ticket fermé')
        .setDescription(`Ce ticket a été fermé par **${adminName}**.\nSuppression dans 5 secondes.`)
        .setTimestamp()],
    });
  } catch (e) {}

  setTimeout(async () => {
    try {
      await interaction.channel.delete(`Ticket fermé par ${adminName}`);
    } catch (e) {
      console.error('[ShopTicket] Impossible de supprimer le salon ticket:', e.message);
    }
  }, 5000);
}

// ── Admin : annule la fermeture ───────────────────────────────────────────────
async function handleCloseCancel(interaction, orderId) {
  await interaction.update({
    embeds: [new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('✅ Fermeture annulée')
      .setDescription('Le ticket reste ouvert.')],
    components: [],
  });
}

module.exports = {
  handleShopTicketCommand,
  handleShopTicketInteraction,
  publishShopTicketPanel,
  activeOrders,
};
