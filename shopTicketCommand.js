/**
 * shopTicketCommand.js
 * Système de ticket shop complet :
 * - Navigation dinos (variantes, sexe M/F, stat forte)
 * - Navigation packs/unitaires
 * - Panier virtuel persistant (ajouter, retirer, commentaire)
 * - Calcul paiement : inventaire (déductions possibles) + réduction rôle
 * - Création thread ticket avec récap
 * - Bouton admin pour valider et encaisser automatiquement
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

// ── Calcul réduction max du joueur ────────────────────────────────────────────
async function getMaxDiscount(memberRoleIds) {
  const roles = await getRoleIncomes();
  let maxDiscount = 0;
  let discountRoleName = null;
  for (const [roleId, cfg] of Object.entries(roles)) {
    if (memberRoleIds.includes(roleId) && (cfg.shopDiscount || 0) > maxDiscount) {
      maxDiscount = cfg.shopDiscount;
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

// ── Déterminer ce qui est déductible de l'inventaire ─────────────────────────
function getInventoryDeductions(cartItems, playerInventory) {
  const inv = playerInventory || {};
  const deductions = [];

  // Compter les dinos "dona" dans l'inventaire du joueur
  const dinoDona = inv['dino_dona'] || 0;
  const pack = inv['pack'] || 0;

  // Items comptabilisables par catégorie
  let dinoCount = 0;
  let packCompatCount = 0;

  for (const item of cartItems) {
    if (item.type === 'dino') {
      if (!item.notAvailableDona) dinoCount++;
    } else if (item.type === 'pack') {
      if (item.donationAvailable) packCompatCount++;
    } else if (item.type === 'unitaire') {
      if (item.donationAvailable) packCompatCount++;
    }
  }

  if (dinoDona > 0 && dinoCount > 0) {
    deductions.push({
      id: 'dino_dona',
      label: '🦕 Dino Dona',
      available: dinoDona,
      usable: Math.min(dinoDona, dinoCount),
      appliesToCount: dinoCount,
    });
  }
  if (pack > 0 && packCompatCount > 0) {
    deductions.push({
      id: 'pack',
      label: '📦 Pack inventaire',
      available: pack,
      usable: Math.min(pack, packCompatCount),
      appliesToCount: packCompatCount,
    });
  }

  return deductions;
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

    let d = item.priceDiamonds || 0;
    let s = item.priceStrawberries || 0;
    if (!item.noReduction && discount > 0) {
      d = applyDiscount(d, discount);
      s = applyDiscount(s, discount);
    }
    desc += `\n> 💰 ${formatPrice(d, s)}`;
    if (!item.noReduction && discount > 0) desc += ` *(−${discount}%)*`;
    desc += '\n\n';
  }

  const { totalDiamonds, totalStrawberries } = calcCartTotal(items, discount);
  const embed = new EmbedBuilder()
    .setTitle('🛒 Ton panier')
    .setDescription(desc.trim())
    .setColor(0x7c5cfc);

  embed.addFields({
    name: '💰 Total estimé',
    value: formatPrice(totalDiamonds, totalStrawberries) + (discount > 0 && discountRoleName ? `\n*Réduction **${discountRoleName}** (−${discount}%) appliquée*` : ''),
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
    let d = item.priceDiamonds || 0;
    let s = item.priceStrawberries || 0;
    if (!item.noReduction && discount > 0) {
      d = applyDiscount(d, discount);
      s = applyDiscount(s, discount);
    }
    desc += `\n> ${formatPrice(d, s)}\n`;
  }

  const embed = new EmbedBuilder()
    .setTitle('📋 Récapitulatif de commande')
    .setDescription(desc.trim())
    .setColor(0xe67e22)
    .addFields({ name: '💰 Total brut', value: formatPrice(totalDiamonds, totalStrawberries), inline: true });

  if (discount > 0 && discountRoleName) {
    embed.addFields({ name: `🏷️ Réduction (${discountRoleName})`, value: `−${discount}%`, inline: true });
  }

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
  return new ActionRowBuilder().addComponents(
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
    await interaction.reply({ content: '✅ Commentaire enregistré !', ephemeral: true });
    return;
  }

  // ── Valider commande ────────────────────────────────────────────────────────
  if (id === 'st_cart_validate') {
    return handleCartValidation(interaction, cart);
  }

  // ── Choix déductions inventaire ─────────────────────────────────────────────
  if (id.startsWith('st_ded_choice::')) {
    const dedId = id.split('::')[1];
    const choice = interaction.values[0]; // 'all', 'partial', 'none'
    cart.pendingDeductions = cart.pendingDeductions || {};
    cart.pendingDeductions[dedId] = choice;
    return handleCartValidation(interaction, cart, true);
  }

  // ── Choix devise ────────────────────────────────────────────────────────────
  if (id === 'st_currency_choice') {
    const currency = interaction.values[0]; // 'diamants', 'fraises', 'split'
    cart.chosenCurrency = currency;
    return createTicketThread(interaction, cart);
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
      content: `✏️ Pour modifier cette commande, utilisez directement les boutons dans ce thread. La commande reste ouverte et le paiement n'a pas encore été déclenché.`,
      ephemeral: true,
    });
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
  const memberRoles = interaction.member?.roles?.cache?.map(r => r.id) || [];
  const { discount, roleName } = await getMaxDiscount(memberRoles);
  const embed = buildCartEmbed(cart, discount, roleName);
  const rows = buildCartButtons(cart.items.length === 0);
  return interaction.update({ embeds: [embed], components: rows });
}

// ── Afficher le panier en followup (après retrait) ───────────────────────────
async function showCartFollowup(interaction, cart) {
  const memberRoles = interaction.member?.roles?.cache?.map(r => r.id) || [];
  const { discount, roleName } = await getMaxDiscount(memberRoles);
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
async function handleCartValidation(interaction, cart, isUpdate = false) {
  if (cart.items.length === 0) {
    const reply = { content: '❌ Ton panier est vide !', ephemeral: true };
    return isUpdate ? interaction.update(reply) : interaction.reply(reply);
  }

  const memberRoles = interaction.member?.roles?.cache?.map(r => r.id) || [];
  const { discount, roleName } = await getMaxDiscount(memberRoles);
  const playerInventory = getPlayerInventory(interaction.user.id);
  const deductions = getInventoryDeductions(cart.items, playerInventory);

  cart.pendingDeductions = cart.pendingDeductions || {};

  // Vérifier s'il reste des déductions à traiter
  const unhandled = deductions.filter(d => !(d.id in cart.pendingDeductions));

  if (unhandled.length > 0) {
    // Présenter la première déduction non traitée
    const ded = unhandled[0];
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`st_ded_choice::${ded.id}`)
      .setPlaceholder(`Utiliser ${ded.label} ?`)
      .addOptions([
        { label: `✅ Utiliser tout (${ded.usable} disponible)`, value: 'all' },
        { label: '🔸 Utiliser une partie', value: 'partial' },
        { label: '❌ Ne pas utiliser', value: 'none' },
      ]);

    const embed = new EmbedBuilder()
      .setTitle('📦 Déductions possibles depuis ton inventaire')
      .setDescription(
        `Tu as **${ded.available}x ${ded.label}** dans ton inventaire.\n` +
        `Cela pourrait couvrir **${ded.usable}** article(s) de ta commande.\n\n` +
        `Veux-tu utiliser des ${ded.label} pour payer une partie de ta commande ?`
      )
      .setColor(0xf39c12);

    const method = isUpdate ? 'update' : 'reply';
    return interaction[method]({ embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)], ephemeral: !isUpdate });
  }

  // Toutes les déductions traitées → choix de la devise
  const { totalDiamonds, totalStrawberries } = calcCartTotal(cart.items, discount);

  const currencyOptions = [];
  if (totalDiamonds > 0) currencyOptions.push({ label: `💎 Payer en Diamants (${totalDiamonds.toLocaleString('fr-FR')})`, value: 'diamants' });
  if (totalStrawberries > 0) currencyOptions.push({ label: `🍓 Payer en Fraises (${totalStrawberries.toLocaleString('fr-FR')})`, value: 'fraises' });
  if (totalDiamonds > 0 && totalStrawberries > 0) {
    currencyOptions.push({ label: '💎+🍓 Payer avec les deux devises', value: 'split' });
  }

  if (currencyOptions.length === 0) {
    return createTicketThread(interaction, cart);
  }

  const currencyMenu = new StringSelectMenuBuilder()
    .setCustomId('st_currency_choice')
    .setPlaceholder('Choisir le mode de paiement...')
    .addOptions(currencyOptions);

  const embed = new EmbedBuilder()
    .setTitle('💳 Choix du mode de paiement')
    .setDescription(
      buildCartSummaryText(cart, discount, roleName) +
      '\n\nChoisis comment tu veux régler ta commande :'
    )
    .setColor(0x7c5cfc);

  const method = isUpdate ? 'update' : 'reply';
  return interaction[method]({ embeds: [embed], components: [new ActionRowBuilder().addComponents(currencyMenu)], ephemeral: !isUpdate });
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
async function createTicketThread(interaction, cart) {
  const settings = getSettings();
  const shop = require('./shopManager').getShop();
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

    // Résumé des dinos pour le nom du thread
    const dinoNames = cart.items.filter(i => i.type === 'dino').map(i => i.name).slice(0, 2).join(', ');
    const threadLabel = dinoNames || cart.items[0]?.name || 'Commande';
    const threadName = `🛒 ${username} — ${threadLabel}`.slice(0, 100);

    const thread = await ticketChannel.threads.create({
      name: threadName,
      autoArchiveDuration: 10080,
      reason: `Ticket shop de ${username}`,
    });

    const memberRoles = interaction.member?.roles?.cache?.map(r => r.id) || [];
    const { discount, roleName } = await getMaxDiscount(memberRoles);

    // Déductions choisies
    const playerInventory = getPlayerInventory(interaction.user.id);
    const deductionsAll = getInventoryDeductions(cart.items, playerInventory);
    const deductionsChosen = deductionsAll
      .filter(d => cart.pendingDeductions && cart.pendingDeductions[d.id] !== 'none')
      .map(d => ({
        ...d,
        usedQty: cart.pendingDeductions?.[d.id] === 'all' ? d.usable : 1,
      }));

    const orderId = genId();
    const orderData = {
      orderId,
      threadId: thread.id,
      userId: interaction.user.id,
      username,
      cart: JSON.parse(JSON.stringify(cart)),
      discount,
      discountRoleName: roleName,
      deductionsChosen,
      chosenCurrency: cart.chosenCurrency || 'split',
      createdAt: Date.now(),
      status: 'pending',
    };
    activeOrders.set(orderId, orderData);

    const recapEmbed = buildOrderRecapEmbed(cart, discount, roleName, deductionsChosen, interaction.user.id);
    const adminBtns = buildAdminButtons(orderId);

    await thread.members.add(interaction.user.id);
    await thread.send({
      content: `Bonjour <@${interaction.user.id}> ! 👋\n\nTa commande a été enregistrée. Un admin va la prendre en charge et valider le paiement une fois la livraison effectuée.\n\n*Tu peux ajouter un commentaire ici directement dans ce salon si tu as des précisions à donner.*`,
      embeds: [recapEmbed],
      components: [adminBtns],
    });

    // Notifier dans un salon log admin si configuré
    try {
      const logChannelId = settings.guild?.inventoryLogChannelId;
      if (logChannelId) {
        const logChannel = await interaction.guild.channels.fetch(logChannelId);
        if (logChannel) {
          const { totalDiamonds, totalStrawberries } = calcCartTotal(cart.items, discount);
          await logChannel.send(`🛒 **Nouveau ticket shop** de <@${interaction.user.id}> : <#${thread.id}>\n> ${cart.items.length} article(s) — Total estimé : ${formatPrice(totalDiamonds, totalStrawberries)}`);
        }
      }
    } catch (e) {}

    // Nettoyer le panier de navigation
    activeCarts.delete(interaction.user.id);

    return interaction.update({
      embeds: [new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('✅ Commande enregistrée !')
        .setDescription(`Ton ticket a été créé : <#${thread.id}>\n\nUn admin va prendre en charge ta commande et valider le paiement après livraison. Tu peux ajouter des informations directement dans le thread.`)],
      components: [],
    });
  } catch (err) {
    console.error('[ShopTicket] Erreur création thread:', err);
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle('❌ Erreur').setDescription('Impossible de créer le ticket. Réessaie ou contacte un admin.')],
      components: [],
    });
  }
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

  const { cart, discount, deductionsChosen, chosenCurrency, userId } = order;
  const { totalDiamonds, totalStrawberries } = calcCartTotal(cart.items, discount);

  const adminName = interaction.member?.displayName || interaction.user.username;

  try {
    // 1. Déduire les items inventaire choisis
    for (const ded of (deductionsChosen || [])) {
      if (ded.usedQty > 0) {
        await removeFromInventory(userId, ded.id, ded.usedQty, interaction.user.id, `Commande shop #${orderId}`);
      }
    }

    // 2. Déduire la devise choisie
    if (chosenCurrency === 'diamants' || chosenCurrency === 'split') {
      if (totalDiamonds > 0) {
        await removeFromInventory(userId, 'diamants', totalDiamonds, interaction.user.id, `Commande shop #${orderId}`);
      }
    }
    if (chosenCurrency === 'fraises' || chosenCurrency === 'split') {
      if (totalStrawberries > 0) {
        await removeFromInventory(userId, 'fraises', totalStrawberries, interaction.user.id, `Commande shop #${orderId}`);
      }
    }

    order.status = 'paid';

    // 3. Mettre à jour le message du thread
    try {
      await interaction.message.edit({ components: [] });
    } catch (e) {}

    const paidEmbed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('✅ Commande validée & Paiement encaissé !')
      .setDescription(
        `**Admin :** ${adminName}\n` +
        `**Paiement débit\u00e9 :**\n` +
        (totalDiamonds > 0 && (chosenCurrency === 'diamants' || chosenCurrency === 'split') ? `> 💎 ${totalDiamonds.toLocaleString('fr-FR')} diamants\n` : '') +
        (totalStrawberries > 0 && (chosenCurrency === 'fraises' || chosenCurrency === 'split') ? `> 🍓 ${totalStrawberries.toLocaleString('fr-FR')} fraises\n` : '') +
        (deductionsChosen?.length > 0 ? deductionsChosen.map(d => `> ${d.label} : −${d.usedQty}`).join('\n') + '\n' : '') +
        `\n*Merci pour ta commande <@${userId}> !* 🎉`
      )
      .setTimestamp();

    await interaction.reply({ embeds: [paidEmbed] });

  } catch (err) {
    console.error('[ShopTicket] Erreur encaissement:', err);
    return interaction.reply({ content: `❌ Erreur lors de l'encaissement : ${err.message}`, ephemeral: true });
  }
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
      .setDescription(`La commande de <@${order.userId}> a été annulée par **${adminName}**.\n\nAucun paiement n'a été effectué.`)
      .setTimestamp()],
  });
}

module.exports = {
  handleShopTicketCommand,
  handleShopTicketInteraction,
  activeOrders,
};
