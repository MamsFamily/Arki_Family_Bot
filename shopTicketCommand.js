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

const path = require('path');
const { getDinoData, getDino } = require('./dinoManager');
const { getShop, getCategories } = require('./shopManager');
const { getPlayerInventory, addToInventory, removeFromInventory, getItemTypes } = require('./inventoryManager');
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

// ── Vérification admin ticket ─────────────────────────────────────────────────
// Autorisé si : Administrator Discord OU l'un des rôles définis dans shopTicketAdminRoleIds du dashboard
function isTicketAdmin(member) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const shop = getShop();
  const adminRoleIds = Array.isArray(shop?.shopTicketAdminRoleIds) ? shop.shopTicketAdminRoleIds : [];
  return adminRoleIds.some(roleId => member.roles.cache.has(roleId));
}

// ── Helper : détecte les wyverns (nécessitent un choix d'élément) ─────────────
function isWyvern(dino) {
  return dino.name.toLowerCase().includes('wyvern');
}

// ── Helper : envoie un avertissement si fraises ou diamants insuffisants ───────
async function sendPaymentWarnings(channel, userId, needDiamonds, needStrawberries, playerInv) {
  const fraisesDispo = playerInv['fraises'] || 0;
  const diamantsDispo = playerInv['diamants'] || 0;
  const fraisesMissing = needStrawberries > 0 && fraisesDispo < needStrawberries;
  const diamondsMissing = needDiamonds > 0 && diamantsDispo < needDiamonds;
  if (!fraisesMissing && !diamondsMissing) return;

  const lines = [];
  if (fraisesMissing) {
    const manque = needStrawberries - fraisesDispo;
    lines.push(
      `🍓 **Fraises insuffisantes :** <@${userId}> possède **${fraisesDispo.toLocaleString('fr-FR')} 🍓** sur les **${needStrawberries.toLocaleString('fr-FR')} 🍓** nécessaires *(manque : ${manque.toLocaleString('fr-FR')} 🍓)*.\n` +
      `> L'admin devra récupérer les fraises **in game** lors de la livraison.`
    );
  }
  if (diamondsMissing) {
    const manque = needDiamonds - diamantsDispo;
    lines.push(
      `💎 **Diamants insuffisants :** <@${userId}> possède **${diamantsDispo.toLocaleString('fr-FR')} 💎** sur les **${needDiamonds.toLocaleString('fr-FR')} 💎** nécessaires *(manque : ${manque.toLocaleString('fr-FR')} 💎)*.\n` +
      `> ⚠️ Les diamants sont une **monnaie Discord** — impossible de les donner in game. Le joueur doit **annuler la commande** ou **demander à un membre de sa tribu** de lui en fournir.`
    );
  }

  await channel.send({
    embeds: [new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle('⚠️ Solde insuffisant — Action requise avant livraison')
      .setDescription(lines.join('\n\n'))
      .setTimestamp()
    ],
  }).catch(() => {});
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
  // Source 1 : interaction.member est toujours fiable pour les interactions boutons en guilde
  if (interaction.member?.roles?.cache?.size > 0) {
    const ids = [...interaction.member.roles.cache.keys()];
    console.log(`[ShopTicket][Roles] Source: interaction.member — ${ids.length} rôle(s): [${ids.join(', ')}]`);
    return ids;
  }
  // Source 2 : fetch depuis l'API Discord
  try {
    const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
    if (member?.roles?.cache?.size > 0) {
      const ids = [...member.roles.cache.keys()];
      console.log(`[ShopTicket][Roles] Source: guild.members.fetch — ${ids.length} rôle(s): [${ids.join(', ')}]`);
      return ids;
    }
  } catch (e) {
    console.warn(`[ShopTicket][Roles] Erreur fetch member:`, e.message);
  }
  console.warn(`[ShopTicket][Roles] Impossible de récupérer les rôles de ${interaction.user.tag}`);
  return [];
}

// ── Calcul réduction max du joueur ────────────────────────────────────────────
async function getMaxDiscount(memberRoleIds) {
  const roles = await getRoleIncomes();
  const rolesWithDiscount = Object.entries(roles).filter(([, cfg]) => parseFloat(cfg.shopDiscount) > 0);
  console.log(`[ShopTicket][Discount] Rôles en DB avec shopDiscount: ${rolesWithDiscount.map(([id, c]) => `${id}(${c.shopDiscount}%)`).join(', ') || 'aucun'}`);

  let maxDiscount = 0;
  let discountRoleName = null;
  for (const [roleId, cfg] of Object.entries(roles)) {
    const pct = parseFloat(cfg.shopDiscount) || 0;
    if (pct > 0 && memberRoleIds.includes(roleId) && pct > maxDiscount) {
      maxDiscount = pct;
      discountRoleName = cfg.name;
      console.log(`[ShopTicket][Discount] Match: rôle ${roleId} (${cfg.name}) → ${pct}%`);
    }
  }
  console.log(`[ShopTicket][Discount] Résultat final: ${maxDiscount}% (${discountRoleName || 'aucun'})`);
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

// ── Helper : emoji pour un inventoryId (depuis les types d'items) ─────────────
function getInvEmoji(inventoryId) {
  const types = getItemTypes();
  const found = types.find(t => t.id === inventoryId);
  return found?.emoji || '📦';
}

// ── Helper : nom lisible pour un inventoryId ──────────────────────────────────
function getInvName(inventoryId) {
  const types = getItemTypes();
  const found = types.find(t => t.id === inventoryId);
  return found?.name || inventoryId.replace(/_/g, ' ');
}

// ── Construire les options de paiement depuis l'inventaire ────────────────────
// Retourne un tableau d'options proposables au joueur
// discount : pourcentage de réduction à appliquer sur les articles sans noReduction
function getPaymentOptions(cartItems, playerInventory, discount = 0) {
  const inv = playerInventory || {};
  const options = [];

  // Helper : calcule le coût restant (avec réduction) des articles non couverts
  function calcRemaining(coveredIds) {
    const remaining = cartItems.filter(i => !coveredIds.has(i.id));
    return calcCartTotal(remaining, discount);
  }

  // Séparer dinos normaux et dinos d'épaule (sans inventoryItemIds propres → chemin legacy)
  // Les items avec inventoryItemIds explicites sont gérés par invItemGroups plus bas
  const hasExplicitInvIds = i => !!(i.inventoryItemIds?.length || i.inventoryItemId);
  const regularDinos = cartItems.filter(i => i.type === 'dino' && !i.isShoulder && !i.notAvailableDona && !hasExplicitInvIds(i));
  const shoulderDinos = cartItems.filter(i => i.type === 'dino' && i.isShoulder && !hasExplicitInvIds(i));
  // Packs compatibles pack inventaire = donationAvailable ET sans lien inventoryItemIds spécifique
  // (les packs avec inventoryItemIds propres sont couverts par leur item spécifique)
  const packCompatItems = cartItems.filter(i =>
    (i.type === 'pack' || i.type === 'unitaire') &&
    i.donationAvailable &&
    !(i.inventoryItemIds?.length || i.inventoryItemId)
  );

  // Tous les types d'items "dino classique" (catégorie dino OU id contenant 'dino', sans 'epaule')
  // → peuvent couvrir les dinos normaux du panier
  // Les dinos avec coupleInventaire=true coûtent 2 slots d'inventaire chacun
  if (regularDinos.length > 0) {
    const allItemTypes = getItemTypes();
    const classicDinoTypes = allItemTypes.filter(t => {
      const isDino = t.category === 'dino' || t.id === 'dino' || t.id.startsWith('dino');
      const isShoulder = t.id.includes('epaule');
      return isDino && !isShoulder;
    });
    for (const itemType of classicDinoTypes) {
      const stock = inv[itemType.id] || 0;
      if (stock <= 0) continue;
      let slotsUsed = 0;
      const covered = [];
      for (const item of regularDinos) {
        const cost = item.coupleInventaire ? 2 : 1;
        if (slotsUsed + cost <= stock) {
          slotsUsed += cost;
          covered.push(item.id);
        }
      }
      if (covered.length === 0) continue;
      const { totalDiamonds: remD, totalStrawberries: remS } = calcRemaining(new Set(covered));
      options.push({
        id: itemType.id,
        inventoryId: itemType.id,
        label: `${getInvEmoji(itemType.id)} ${getInvName(itemType.id)} (${slotsUsed}/${stock} stock)`,
        usedQty: slotsUsed,
        coveredItemIds: covered,
        remainingDiamonds: remD,
        remainingStrawberries: remS,
      });
    }
  }

  // Tous les types d'items "dino d'épaule" (id contenant 'epaule')
  // → peuvent couvrir les dinos d'épaule du panier
  if (shoulderDinos.length > 0) {
    const allItemTypes = getItemTypes();
    const shoulderDinoTypes = allItemTypes.filter(t =>
      (t.category === 'dino' || t.id.startsWith('dino')) && t.id.includes('epaule')
    );
    for (const itemType of shoulderDinoTypes) {
      const stock = inv[itemType.id] || 0;
      if (stock <= 0) continue;
      const usable = Math.min(stock, shoulderDinos.length);
      const covered = shoulderDinos.slice(0, usable).map(i => i.id);
      const { totalDiamonds: remD, totalStrawberries: remS } = calcRemaining(new Set(covered));
      options.push({
        id: itemType.id,
        inventoryId: itemType.id,
        label: `${getInvEmoji(itemType.id)} ${getInvName(itemType.id)} (${usable}/${stock} stock)`,
        usedQty: usable,
        coveredItemIds: covered,
        remainingDiamonds: remD,
        remainingStrawberries: remS,
      });
    }
  }

  // pack → couvre les items compatibles (donationAvailable)
  const packQty = inv['pack'] || 0;
  if (packQty > 0 && packCompatItems.length > 0) {
    const usable = Math.min(packQty, packCompatItems.length);
    const covered = packCompatItems.slice(0, usable).map(i => i.id);
    const { totalDiamonds: remD, totalStrawberries: remS } = calcRemaining(new Set(covered));
    options.push({
      id: 'pack',
      inventoryId: 'pack',
      label: `${getInvEmoji('pack')} ${getInvName('pack')} (${usable}/${packQty} stock)`,
      usedQty: usable,
      coveredItemIds: covered,
      remainingDiamonds: remD,
      remainingStrawberries: remS,
    });
  }

  // inventoryItemIds → couvre les items shop liés à un type d'inventaire spécifique
  const invItemGroups = {};
  for (const item of cartItems) {
    // Support tableau inventoryItemIds (nouveau) et legacy inventoryItemId
    const ids = item.inventoryItemIds?.length ? item.inventoryItemIds
      : (item.inventoryItemId ? [item.inventoryItemId] : []);
    for (const invId of ids) {
      if (!invItemGroups[invId]) invItemGroups[invId] = [];
      if (!invItemGroups[invId].includes(item)) invItemGroups[invId].push(item);
    }
  }
  for (const [invItemId, matchedItems] of Object.entries(invItemGroups)) {
    const stock = inv[invItemId] || 0;
    if (stock > 0) {
      const usable = Math.min(stock, matchedItems.length);
      const covered = matchedItems.slice(0, usable).map(i => i.id);
      const { totalDiamonds: remD, totalStrawberries: remS } = calcRemaining(new Set(covered));
      options.push({
        id: `inv_${invItemId}`,
        inventoryId: invItemId,
        label: `${getInvEmoji(invItemId)} ${getInvName(invItemId)} (${usable}/${stock} stock)`,
        usedQty: usable,
        coveredItemIds: covered,
        remainingDiamonds: remD,
        remainingStrawberries: remS,
      });
    }
  }

  return options;
}

// ── Construire le message de sélection de paiement (select menu roulette) ─────
function buildPaymentSelectMessage(orderId, order) {
  const selectedDeductions = order.selectedDeductions || [];
  const allCovered = new Set(selectedDeductions.flatMap(d => d.coveredItemIds || []));

  // Options inventaire encore disponibles (couvrent au moins un article non encore couvert)
  const remainingOpts = (order.paymentOptions || []).filter(opt =>
    (opt.coveredItemIds || []).some(id => !allCovered.has(id))
  );

  // Montant restant à payer
  const remainingItems = order.cart.items.filter(i => !allCovered.has(i.id));
  const { totalDiamonds: remD, totalStrawberries: remS } = calcCartTotal(remainingItems, order.discount || 0);

  // Description embed
  let desc = '';
  if (selectedDeductions.length > 0) {
    desc += '**✅ Retraits sélectionnés :**\n';
    for (const d of selectedDeductions) {
      desc += `• ${d.label.split(' (')[0]}\n`;
      for (const covId of (d.coveredItemIds || [])) {
        const item = order.cart.items.find(i => i.id === covId);
        if (item) desc += `  ↳ ${item.name}\n`;
      }
    }
    desc += '\n';
  }

  if (remainingOpts.length > 0) {
    desc += '*Sélectionne un retrait dans la liste, ou paye le reste directement.*';
  } else if (remD > 0 || remS > 0) {
    desc += '*Plus de retraits disponibles — paye le reste ci-dessous.*';
  } else {
    desc += '✅ *Toute la commande est couverte par tes retraits inventaire !*';
  }

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('💳 Mode de paiement')
    .setDescription(desc || '\u200b')
    .setFooter({ text: 'Le paiement n\'est débité qu\'après la livraison.' });

  const components = [];

  // Select menu des retraits restants
  if (remainingOpts.length > 0) {
    const selectOptions = remainingOpts.map(opt => {
      const globalIdx = order.paymentOptions.indexOf(opt);
      // Calculer la couverture effective (hors items déjà couverts) pour l'affichage
      const effectiveCovered = (opt.coveredItemIds || []).filter(id => !allCovered.has(id));
      const effectiveQty = effectiveCovered.reduce((acc, id) => {
        const item = order.cart.items.find(i => i.id === id);
        return acc + (item?.coupleInventaire ? 2 : 1);
      }, 0);
      const adjustedLabel = opt.label.replace(/\(\d+\//, `(${effectiveQty}/`);
      const coveredNames = effectiveCovered
        .map(id => order.cart.items.find(i => i.id === id)?.name)
        .filter(Boolean).join(', ');
      return {
        label: adjustedLabel.slice(0, 100),
        description: coveredNames ? `Couvre : ${coveredNames}`.slice(0, 100) : 'Retrait inventaire',
        value: globalIdx.toString(),
      };
    });
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`st_inv_pick::${orderId}`)
        .setPlaceholder('🎰 Retirer un article de ton inventaire...')
        .addOptions(selectOptions)
    ));
  }

  // Bouton "payer le reste" (toujours visible, prix mis à jour)
  const nothingToPay = remD === 0 && remS === 0;
  const btnLabel = nothingToPay
    ? '✅ Confirmer (tout couvert par inventaire)'
    : `💎 Payer le reste : ${formatPrice(remD, remS)}`;

  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`st_inv_direct::${orderId}`)
      .setLabel(btnLabel.slice(0, 80))
      .setStyle(nothingToPay ? ButtonStyle.Success : ButtonStyle.Secondary)
  ));

  return { embeds: [embed], components };
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
      { label: '♂️ Mâle',    value: 'Mâle',   emoji: '♂️' },
      { label: '♀️ Femelle', value: 'Femelle', emoji: '♀️' },
      { label: '💑 Couple',  value: 'Couple',  emoji: '💑' },
    ]);
}

// ── Menu stat forte pour couple (customId distinct) ───────────────────────────
function buildCoupleStatMenu(dinoId, variantLabel, forSexe, maleStat = '') {
  const cid = forSexe === 'Mâle'
    ? `st_couple_m_stat::${dinoId}::${variantLabel}`
    : `st_couple_f_stat::${dinoId}::${variantLabel}::${maleStat}`;
  return new StringSelectMenuBuilder()
    .setCustomId(cid)
    .setPlaceholder(`Stat forte — ${forSexe}...`)
    .addOptions(STATS.map(s => ({ label: `${STAT_EMOJIS[s]} ${s}`, value: s })));
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
      if (item.elementNote) desc += `\n> 🔥 Élément : **${item.elementNote}**`;
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
    embed.addFields(
      { name: '\u200b', value: '───────────────────────', inline: false },
      { name: '💬 Commentaire', value: cart.comment.split('\n').map(l => l.trim() ? `***${l}***` : '\u200b').join('\n'), inline: false },
      { name: '\u200b', value: '───────────────────────', inline: false },
    );
  }

  if (discount > 0 && discountRoleName) {
    embed.addFields({ name: '🏷️ Réduction', value: `−${discount}% (${discountRoleName})`, inline: true });
  } else {
    embed.setFooter({ text: 'Aucune réduction de rôle active sur cette commande.' });
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
      if (item.elementNote) desc += `\n> 🔥 Élément : **${item.elementNote}**`;
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
    embed.addFields(
      { name: '\u200b', value: '───────────────────────', inline: false },
      { name: '💬 Commentaire du joueur', value: cart.comment.split('\n').map(l => l.trim() ? `***${l}***` : '\u200b').join('\n'), inline: false },
      { name: '\u200b', value: '───────────────────────', inline: false },
    );
  }

  embed.addFields({ name: '👤 Joueur', value: `<@${userId}>`, inline: true });

  if (discount > 0 && discountRoleName) {
    embed.addFields({ name: '🏷️ Réduction appliquée', value: `−${discount}% (${discountRoleName})`, inline: true });
  }

  embed.setFooter({ text: '⏳ En attente : joueur doit choisir son mode de paiement' });
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

    if (sexe === 'Couple') {
      // Couple : d'abord stat forte du mâle
      const maleStatMenu = buildCoupleStatMenu(dinoId, variantLabel, 'Mâle');
      return interaction.update({
        embeds: [new EmbedBuilder()
          .setTitle(`🦕 ${dino.name.trim()} — Couple`)
          .setDescription('💑 **Couple sélectionné** (= 2 dinos)\n\n**1/2 — Choisis la stat forte du ♂️ mâle.**')
          .setColor(0x9b59b6)],
        components: [
          new ActionRowBuilder().addComponents(maleStatMenu),
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('st_back_home').setLabel('⌂ Accueil').setStyle(ButtonStyle.Secondary)
          ),
        ],
      });
    }

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

  // ── Couple : stat forte du mâle sélectionnée → demander celle de la femelle ──
  if (id.startsWith('st_couple_m_stat::')) {
    const [, dinoId, variantLabel] = id.split('::');
    const maleStat = interaction.values[0];
    const dino = getDino(dinoId);
    if (!dino) return;

    const femaleStatMenu = buildCoupleStatMenu(dinoId, variantLabel, 'Femelle', maleStat);
    return interaction.update({
      embeds: [new EmbedBuilder()
        .setTitle(`🦕 ${dino.name.trim()} — Couple`)
        .setDescription(`♂️ Mâle → **${STAT_EMOJIS[maleStat] || ''}${maleStat}** ✅\n\n**2/2 — Choisis la stat forte de la ♀️ femelle.**`)
        .setColor(0x9b59b6)],
      components: [
        new ActionRowBuilder().addComponents(femaleStatMenu),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('st_back_home').setLabel('⌂ Accueil').setStyle(ButtonStyle.Secondary)
        ),
      ],
    });
  }

  // ── Couple : stat forte de la femelle → ajouter les 2 dinos au panier ────────
  if (id.startsWith('st_couple_f_stat::')) {
    const parts = id.split('::');
    const dinoId = parts[1];
    const variantLabel = parts[2];
    const maleStat = parts[3];
    const femaleStat = interaction.values[0];
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

    const baseItem = { type: 'dino', dinoId: dino.id, name: displayName, variant: variantLabel,
      priceDiamonds, priceStrawberries, noReduction: dino.noReduction || false,
      notAvailableDona: dino.notAvailableDona || false, isShoulder: dino.isShoulder || false,
      coupleInventaire: dino.coupleInventaire || false };

    const maleItem   = { ...baseItem, id: genId(), sexe: 'Mâle',    stat: maleStat };
    const femaleItem = { ...baseItem, id: genId(), sexe: 'Femelle',  stat: femaleStat };

    // Wyverns → demander l'élément avant d'ajouter au panier
    if (isWyvern(dino)) {
      cart.pendingWyvernItem = [maleItem, femaleItem];
      const modal = new ModalBuilder()
        .setCustomId('st_wyvern_element_modal')
        .setTitle('🔥 Élément de la Wyvern');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('element_text')
          .setLabel('Élément souhaité')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Ex : Foudre, Glace, Poison, Feu, Vent...')
          .setRequired(true)
          .setMaxLength(50)
      ));
      return interaction.showModal(modal);
    }

    cart.items.push(maleItem);
    cart.items.push(femaleItem);

    return interaction.update({
      embeds: [new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle('✅ Couple ajouté au panier !')
        .setDescription(
          `**${displayName}**\n` +
          `♂️ Mâle · ${STAT_EMOJIS[maleStat] || ''}${maleStat}\n` +
          `♀️ Femelle · ${STAT_EMOJIS[femaleStat] || ''}${femaleStat}\n` +
          `💰 ${formatPrice(priceDiamonds * 2, priceStrawberries * 2)} *(×2)*`
        )
        .setFooter({ text: `${cart.items.length} article(s) dans ton panier` })],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('st_back_home').setLabel('🛍️ Continuer mes achats').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('st_view_cart_btn').setLabel('🛒 Voir mon panier').setStyle(ButtonStyle.Success),
      )],
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
      coupleInventaire: dino.coupleInventaire || false,
    };

    // Wyverns → demander l'élément avant d'ajouter au panier
    if (isWyvern(dino)) {
      cart.pendingWyvernItem = cartItem;
      const modal = new ModalBuilder()
        .setCustomId('st_wyvern_element_modal')
        .setTitle('🔥 Élément de la Wyvern');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('element_text')
          .setLabel('Élément souhaité')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Ex : Foudre, Glace, Poison, Feu, Vent...')
          .setRequired(true)
          .setMaxLength(50)
      ));
      return interaction.showModal(modal);
    }

    cart.items.push(cartItem);

    return interaction.update({
      embeds: [new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('✅ Ajouté au panier !')
        .setDescription(`**${displayName}**\n${sexe} · ${STAT_EMOJIS[stat]}${stat}\n💰 ${formatPrice(priceDiamonds, priceStrawberries)}`)
        .setFooter({ text: `${cart.items.length} article(s) dans ton panier` })],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('st_back_home').setLabel('🛍️ Continuer mes achats').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('st_view_cart_btn').setLabel('🛒 Voir mon panier').setStyle(ButtonStyle.Success),
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
        new ButtonBuilder().setCustomId('st_back_home').setLabel('🛍️ Continuer mes achats').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('st_view_cart_btn').setLabel('🛒 Voir mon panier').setStyle(ButtonStyle.Success),
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
        new ButtonBuilder().setCustomId('st_back_home').setLabel('🛍️ Continuer mes achats').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('st_view_cart_btn').setLabel('🛒 Voir mon panier').setStyle(ButtonStyle.Success),
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
    const textInput = new TextInputBuilder()
      .setCustomId('comment_text')
      .setLabel('Commentaire (infos, questions...)')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('Ex: Je voudrais un dino avec les couleurs bleues...')
      .setRequired(false)
      .setMaxLength(500);
    // setValue crash si chaîne vide — Discord.js l'interdit
    if (cart.comment) textInput.setValue(cart.comment);
    const modal = new ModalBuilder()
      .setCustomId('st_comment_modal')
      .setTitle('Ajouter un commentaire');
    modal.addComponents(new ActionRowBuilder().addComponents(textInput));
    return interaction.showModal(modal);
  }

  // ── Modal commentaire soumis ────────────────────────────────────────────────
  if (id === 'st_comment_modal') {
    if (!cart) {
      return interaction.reply({ content: '❌ Ton panier a expiré. Utilise `/shop-ticket` pour recommencer.', ephemeral: true });
    }
    cart.comment = interaction.fields.getTextInputValue('comment_text') || '';
    const memberRoleIds = await getMemberRoleIds(interaction);
    const { discount: disc, roleName: rn } = await getMaxDiscount(memberRoleIds);
    const updatedEmbed = buildCartEmbed(cart, disc, rn);
    const rows = buildCartButtons(cart.items.length === 0);
    // Le modal a été ouvert depuis un bouton de message : on met à jour ce message
    if (interaction.message) {
      await interaction.update({ embeds: [updatedEmbed], components: rows });
    } else {
      await interaction.reply({ content: '✅ Commentaire enregistré !', embeds: [updatedEmbed], components: rows, ephemeral: true });
    }
    return;
  }

  // ── Modal wyvern : élément saisi ────────────────────────────────────────────
  if (id === 'st_wyvern_element_modal') {
    if (!cart) {
      return interaction.reply({ content: '❌ Ton panier a expiré. Utilise `/shop-ticket` pour recommencer.', ephemeral: true });
    }
    const pendingItem = cart.pendingWyvernItem;
    if (!pendingItem) {
      return interaction.reply({ content: '❌ Aucune wyvern en attente. Réessaie depuis le menu dinos.', ephemeral: true });
    }
    const element = interaction.fields.getTextInputValue('element_text').trim();
    cart.pendingWyvernItem = null;

    if (Array.isArray(pendingItem)) {
      // Couple
      const [maleItem, femaleItem] = pendingItem;
      maleItem.elementNote = element;
      femaleItem.elementNote = element;
      cart.items.push(maleItem, femaleItem);
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x9b59b6)
          .setTitle('✅ Couple ajouté au panier !')
          .setDescription(
            `**${maleItem.name}**\n` +
            `♂️ Mâle · ${STAT_EMOJIS[maleItem.stat] || ''}${maleItem.stat}\n` +
            `♀️ Femelle · ${STAT_EMOJIS[femaleItem.stat] || ''}${femaleItem.stat}\n` +
            `🔥 Élément : **${element}**\n` +
            `💰 ${formatPrice(maleItem.priceDiamonds * 2, maleItem.priceStrawberries * 2)} *(×2)*`
          )
          .setFooter({ text: `${cart.items.length} article(s) dans ton panier` })],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('st_back_home').setLabel('🛍️ Continuer mes achats').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('st_view_cart_btn').setLabel('🛒 Voir mon panier').setStyle(ButtonStyle.Success),
        )],
        ephemeral: true,
      });
    } else {
      // Solo
      pendingItem.elementNote = element;
      cart.items.push(pendingItem);
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x2ecc71)
          .setTitle('✅ Ajouté au panier !')
          .setDescription(
            `**${pendingItem.name}**\n` +
            `${pendingItem.sexe} · ${STAT_EMOJIS[pendingItem.stat] || ''}${pendingItem.stat}\n` +
            `🔥 Élément : **${element}**\n` +
            `💰 ${formatPrice(pendingItem.priceDiamonds, pendingItem.priceStrawberries)}`
          )
          .setFooter({ text: `${cart.items.length} article(s) dans ton panier` })],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('st_back_home').setLabel('🛍️ Continuer mes achats').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('st_view_cart_btn').setLabel('🛒 Voir mon panier').setStyle(ButtonStyle.Success),
        )],
        ephemeral: true,
      });
    }
  }

  // ── Valider commande ────────────────────────────────────────────────────────
  if (id === 'st_cart_validate') {
    return handleCartValidation(interaction, cart);
  }

  // ── Bouton : ouvrir un ticket depuis le panneau ──────────────────────────────
  if (id === 'st_open_ticket_shop') {
    return handleShopTicketCommand(interaction);
  }

  // ── Actions admin : guard unique ─────────────────────────────────────────────
  const isAdminAction = id.startsWith('st_admin_validate::') || id.startsWith('st_admin_force_validate::') ||
    id.startsWith('st_admin_cancel::') || id.startsWith('st_admin_modify::') || id.startsWith('st_admin_close::') ||
    id.startsWith('st_close_confirm::') || id.startsWith('st_close_cancel::') ||
    id.startsWith('st_delete_ticket::') || id.startsWith('st_admin_straw_ok::');

  if (isAdminAction && !isTicketAdmin(interaction.member)) {
    return interaction.reply({
      content: '🔒 Tu n\'as pas la permission d\'effectuer cette action. Seuls les administrateurs ou les rôles autorisés peuvent gérer les tickets.',
      ephemeral: true,
    });
  }

  // ── Bouton admin : valider & encaisser ──────────────────────────────────────
  if (id.startsWith('st_admin_validate::')) {
    const orderId = id.split('::')[1];
    return handleAdminValidate(interaction, orderId);
  }

  // ── Bouton admin : forcer paiement direct (sans choix joueur) ───────────────
  if (id.startsWith('st_admin_force_validate::')) {
    const orderId = id.split('::')[1];
    const order = activeOrders.get(orderId);
    if (!order) return interaction.reply({ content: '❌ Commande introuvable.', ephemeral: true });
    // Injecter un paymentChoice "direct" puis valider
    order.paymentChoice = { id: 'direct', label: 'Paiement direct (forcé par admin)', coveredItemIds: [] };
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

  // ── Bouton admin : fraises récupérées in game ────────────────────────────────
  if (id.startsWith('st_admin_straw_ok::')) {
    const orderId = id.split('::')[1];
    const order = activeOrders.get(orderId);
    if (!order) return interaction.reply({ content: '❌ Commande introuvable.', ephemeral: true });
    order.pendingStrawberries = 0;
    try { await interaction.message.edit({ components: [] }); } catch (e) {}
    const adminName = interaction.member?.displayName || interaction.user.username;
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('✅ Fraises récupérées — Confirmé !')
        .setDescription(
          `**${adminName}** confirme avoir récupéré les fraises in game.\n\n` +
          `Le ticket peut maintenant être fermé.`
        )
        .setTimestamp()],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`st_admin_close::${orderId}`)
          .setLabel('🔒 Fermer le ticket')
          .setStyle(ButtonStyle.Secondary),
      )],
    });
  }

  // ── Confirmation fermeture ────────────────────────────────────────────────
  if (id.startsWith('st_close_confirm::')) {
    const orderId = id.split('::')[1];
    return handleCloseConfirm(interaction, orderId);
  }

  // ── Suppression définitive du ticket fermé ───────────────────────────────
  if (id.startsWith('st_delete_ticket::')) {
    return handleDeleteTicket(interaction);
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

  // ── Roulette inventaire : sélection d'un retrait ───────────────────────────
  if (id.startsWith('st_inv_pick::')) {
    const orderId = id.split('::')[1];
    return handleInvPick(interaction, orderId);
  }

  // ── Roulette inventaire : payer le reste (ou confirmer si tout couvert) ─────
  if (id.startsWith('st_inv_direct::')) {
    const orderId = id.split('::')[1];
    return handleInvDirect(interaction, orderId);
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
    inventoryItemIds: (option?.inventoryItemIds?.length ? option.inventoryItemIds
      : (pack.inventoryItemIds?.length ? pack.inventoryItemIds
      : (pack.inventoryItemId ? [pack.inventoryItemId] : []))),
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
  console.log(`[ShopTicket] Réduction pour ${interaction.user.tag} — rôles: [${memberRoleIds.join(', ')}] — discount: ${discount}% (${roleName || 'aucun rôle configuré'})`);


  // 2. Analyser l'inventaire pour préparer les options de paiement (sans déduire)
  const playerInventory = getPlayerInventory(interaction.user.id);
  const paymentOptions = getPaymentOptions(cart.items, playerInventory, discount);

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
    const _nick        = interaction.member?.nickname       || null;
    const _globalName  = interaction.user.globalName         || null;
    const _memberDisp  = interaction.member?.displayName     || null;
    const _username    = interaction.user.username           || null;
    const username = _nick || _globalName || _memberDisp || _username || 'joueur';
    console.log(`[ShopTicket] Nom: nick=${_nick} | globalName=${_globalName} | memberDisp=${_memberDisp} | username=${_username} → ${username}`);

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

    // Rôles admin configurés dans le shop (uniquement ceux définis dans le dashboard)
    const adminRoleIds = Array.isArray(shop.shopTicketAdminRoleIds) ? shop.shopTicketAdminRoleIds : [];
    const allAdminRoles = adminRoleIds.filter(Boolean);

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

    // ── Nom du salon (basé sur le username Discord, toujours ASCII) ──────────
    const safeName = (_username || 'joueur')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 25) || 'joueur';
    const channelName = `shop-${safeName}`;

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
      paymentMethod: null,
      paymentChoice: null,
      selectedDeductions: [],  // retraits inventaire sélectionnés étape par étape
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

    // ── Message joueur : select menu roulette de paiement ────────────────────
    const payMsg = buildPaymentSelectMessage(orderId, orderData);
    await ticketChannel.send(payMsg);

    // ── Notification "nouvelle commande" dans le salon configuré ─────────────
    const notifChannelId = shop.shopTicketNotifChannelId;
    if (notifChannelId) {
      try {
        const notifChannel = await interaction.guild.channels.fetch(notifChannelId).catch(() => null);
        if (notifChannel) {
          await notifChannel.send({
            content: `🛍️ **Une nouvelle commande vient de POP !** → <#${ticketChannel.id}>`,
          });
        }
      } catch (e) {
        console.error('[ShopTicket] Erreur notification nouvelle commande:', e);
      }
    }

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
  const bannerPath = path.join(__dirname, 'web', 'public', 'images', 'shop-ticket-banner.png');

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
    .setThumbnail('attachment://shop-ticket-banner.png')
    .setFooter({ text: 'Le paiement est encaissé après livraison.' });

  const btn = new ButtonBuilder()
    .setCustomId('st_open_ticket_shop')
    .setLabel('🎫 Ouvrir un ticket')
    .setStyle(ButtonStyle.Primary);

  const row = new ActionRowBuilder().addComponents(btn);

  await interaction.channel.send({
    embeds: [embed],
    components: [row],
    files: [{ attachment: bannerPath, name: 'shop-ticket-banner.png' }],
  });
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

  // ── Bloquer si le joueur n'a pas encore choisi son mode de paiement ──────────
  if (!paymentChoice) {
    const { totalDiamonds, totalStrawberries } = calcCartTotal(cart.items, discount);
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0xe67e22)
        .setTitle('⏳ Paiement non sélectionné')
        .setDescription(
          `Le joueur <@${userId}> n'a **pas encore choisi** son mode de paiement.\n\n` +
          `Si tu valides maintenant, tout sera débité directement en diamants/fraises (**${formatPrice(totalDiamonds, totalStrawberries)}**).\n\n` +
          `➡ Attends que le joueur clique sur un bouton de paiement, ou utilise le bouton ci-dessous pour forcer le paiement direct.`
        )],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`st_admin_force_validate::${orderId}`)
          .setLabel('💎 Forcer paiement direct')
          .setStyle(ButtonStyle.Danger),
      )],
      ephemeral: true,
    });
  }

  try {
    let paymentDesc = '';
    const warnings = [];
    let pendingStrawberries = 0;
    let pendingDiamonds = 0;
    const playerInv = getPlayerInventory(userId);

    if (paymentChoice.id === 'multi') {
      // ── Retraits inventaire multiples (roulette) + reste en diamants ─────────
      for (const ded of (paymentChoice.selectedDeductions || [])) {
        const invStock = playerInv[ded.inventoryId] || 0;
        if (invStock < ded.usedQty) {
          warnings.push(`⚠️ Stock **${ded.inventoryId}** insuffisant : joueur a ${invStock} mais on essaie d'en retirer ${ded.usedQty}.`);
        }
        await removeFromInventory(userId, ded.inventoryId, ded.usedQty, interaction.user.id, `Commande shop #${orderId}`);
        paymentDesc += `> ${ded.label.split(' (')[0]} : −${ded.usedQty}\n`;
      }
      const remD = paymentChoice.remainingDiamonds || 0;
      const remS = paymentChoice.remainingStrawberries || 0;
      if (remD > 0) {
        const playerDiamonds = playerInv['diamants'] || 0;
        if (playerDiamonds < remD) {
          pendingDiamonds += (remD - playerDiamonds);
          warnings.push(`⚠️ Solde insuffisant : joueur a **${playerDiamonds.toLocaleString('fr-FR')} 💎** mais doit payer **${remD.toLocaleString('fr-FR')} 💎** (manque **${(remD - playerDiamonds).toLocaleString('fr-FR')} 💎**).`);
        }
        await removeFromInventory(userId, 'diamants', remD, interaction.user.id, `Commande shop #${orderId}`);
        paymentDesc += `> 💎 ${remD.toLocaleString('fr-FR')} diamants\n`;
      }
      if (remS > 0) {
        const playerFraises = playerInv['fraises'] || 0;
        if (playerFraises < remS) {
          pendingStrawberries += (remS - playerFraises);
          warnings.push(`⚠️ Solde insuffisant : joueur a **${playerFraises.toLocaleString('fr-FR')} 🍓** mais doit payer **${remS.toLocaleString('fr-FR')} 🍓** (manque **${(remS - playerFraises).toLocaleString('fr-FR')} 🍓**).`);
        }
        await removeFromInventory(userId, 'fraises', remS, interaction.user.id, `Commande shop #${orderId}`);
        paymentDesc += `> 🍓 ${remS.toLocaleString('fr-FR')} fraises\n`;
      }
    } else if (paymentChoice.id !== 'direct') {
      // ── Paiement par item inventaire (legacy — un seul retrait) ────────────
      const invStock = playerInv[paymentChoice.inventoryId] || 0;
      if (invStock < paymentChoice.usedQty) {
        warnings.push(`⚠️ Stock **${paymentChoice.inventoryId}** insuffisant : joueur a ${invStock} mais on essaie d'en retirer ${paymentChoice.usedQty}.`);
      }
      await removeFromInventory(userId, paymentChoice.inventoryId, paymentChoice.usedQty, interaction.user.id, `Commande shop #${orderId}`);
      paymentDesc += `> ${paymentChoice.label.split(' (')[0]} : −${paymentChoice.usedQty}\n`;

      const coveredIds = new Set(paymentChoice.coveredItemIds || []);
      const remainingItems = cart.items.filter(i => !coveredIds.has(i.id));
      const { totalDiamonds: remD, totalStrawberries: remS } = calcCartTotal(remainingItems, discount);

      if (remD > 0) {
        const playerDiamonds = playerInv['diamants'] || 0;
        if (playerDiamonds < remD) {
          pendingDiamonds += (remD - playerDiamonds);
          warnings.push(`⚠️ Solde insuffisant pour les diamants : joueur a **${playerDiamonds.toLocaleString('fr-FR')} 💎** mais doit payer **${remD.toLocaleString('fr-FR')} 💎** (manque **${(remD - playerDiamonds).toLocaleString('fr-FR')} 💎**).`);
        }
        await removeFromInventory(userId, 'diamants', remD, interaction.user.id, `Commande shop #${orderId}`);
        paymentDesc += `> 💎 ${remD.toLocaleString('fr-FR')} diamants\n`;
      }
      if (remS > 0) {
        const playerFraises = playerInv['fraises'] || 0;
        if (playerFraises < remS) {
          pendingStrawberries += (remS - playerFraises);
          warnings.push(`⚠️ Solde insuffisant pour les fraises : joueur a **${playerFraises.toLocaleString('fr-FR')} 🍓** mais doit payer **${remS.toLocaleString('fr-FR')} 🍓** (manque **${(remS - playerFraises).toLocaleString('fr-FR')} 🍓**).`);
        }
        await removeFromInventory(userId, 'fraises', remS, interaction.user.id, `Commande shop #${orderId}`);
        paymentDesc += `> 🍓 ${remS.toLocaleString('fr-FR')} fraises\n`;
      }
    } else {
      // ── Paiement direct diamants + fraises ──────────────────────────────────
      const { totalDiamonds, totalStrawberries } = calcCartTotal(cart.items, discount);
      if (totalDiamonds > 0) {
        const playerDiamonds = playerInv['diamants'] || 0;
        if (playerDiamonds < totalDiamonds) {
          pendingDiamonds += (totalDiamonds - playerDiamonds);
          warnings.push(`⚠️ Solde insuffisant : joueur a **${playerDiamonds.toLocaleString('fr-FR')} 💎** mais doit payer **${totalDiamonds.toLocaleString('fr-FR')} 💎** (manque **${(totalDiamonds - playerDiamonds).toLocaleString('fr-FR')} 💎**).`);
        }
        await removeFromInventory(userId, 'diamants', totalDiamonds, interaction.user.id, `Commande shop #${orderId}`);
        paymentDesc += `> 💎 ${totalDiamonds.toLocaleString('fr-FR')} diamants\n`;
      }
      if (totalStrawberries > 0) {
        const playerFraises = playerInv['fraises'] || 0;
        if (playerFraises < totalStrawberries) {
          pendingStrawberries += (totalStrawberries - playerFraises);
          warnings.push(`⚠️ Solde insuffisant : joueur a **${playerFraises.toLocaleString('fr-FR')} 🍓** mais doit payer **${totalStrawberries.toLocaleString('fr-FR')} 🍓** (manque **${(totalStrawberries - playerFraises).toLocaleString('fr-FR')} 🍓**).`);
        }
        await removeFromInventory(userId, 'fraises', totalStrawberries, interaction.user.id, `Commande shop #${orderId}`);
        paymentDesc += `> 🍓 ${totalStrawberries.toLocaleString('fr-FR')} fraises\n`;
      }
    }

    if (!paymentDesc.trim()) paymentDesc = '> *Aucun débit (commande gratuite ou gérée manuellement)*\n';

    order.status = 'paid';
    if (pendingStrawberries > 0) order.pendingStrawberries = pendingStrawberries;
    if (pendingDiamonds > 0) order.pendingDiamonds = pendingDiamonds;

    // Retirer les boutons du message admin
    try { await interaction.message.edit({ components: [] }); } catch (e) {}

    const paidEmbed = new EmbedBuilder()
      .setColor(warnings.length > 0 ? 0xe67e22 : 0x2ecc71)
      .setTitle(warnings.length > 0 ? '⚠️ Commande validée — Solde insuffisant !' : '✅ Commande validée & Paiement encaissé !')
      .setDescription(
        `**Admin :** ${adminName}\n` +
        `**Paiement débité :**\n${paymentDesc}\n` +
        (warnings.length > 0 ? `\n**Avertissements :**\n${warnings.join('\n')}\n\n*Le solde a été ramené à 0. Gérer manuellement via UnbelievaBoat si nécessaire.*\n\n` : '') +
        `*Merci pour ta commande <@${userId}> !* 🎉`
      )
      .setTimestamp();

    const postValidationRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('st_new_order')
        .setLabel('🛒 Passer une nouvelle commande')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`st_admin_close::${orderId}`)
        .setLabel('🔒 Fermer le ticket')
        .setStyle(ButtonStyle.Secondary),
    );

    await interaction.reply({ embeds: [paidEmbed], components: [postValidationRow] });

    // ── Messages post-validation si paiement incomplet ────────────────────────
    if (pendingStrawberries > 0) {
      await interaction.channel.send({
        embeds: [new EmbedBuilder()
          .setColor(0xe74c3c)
          .setTitle('🍓 Fraises à récupérer In Game')
          .setDescription(
            `Le solde de <@${userId}> était insuffisant pour les fraises.\n` +
            `**Montant à récupérer in game :** ${pendingStrawberries.toLocaleString('fr-FR')} 🍓\n\n` +
            `➡️ L'admin doit récupérer les fraises **in game** lors ou après la livraison.\n` +
            `Une fois les fraises récupérées, clique sur le bouton ci-dessous pour confirmer.`
          )
          .setTimestamp()],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`st_admin_straw_ok::${orderId}`)
            .setLabel('✅ Fraises récupérées In Game')
            .setStyle(ButtonStyle.Success),
        )],
      }).catch(e => console.error('[ShopTicket] Erreur message fraises pending:', e));
    }

    if (pendingDiamonds > 0) {
      await interaction.channel.send({
        embeds: [new EmbedBuilder()
          .setColor(0xe67e22)
          .setTitle('💎 Diamants insuffisants — Action requise')
          .setDescription(
            `Le solde de <@${userId}> était insuffisant pour les diamants.\n` +
            `**Montant manquant :** ${pendingDiamonds.toLocaleString('fr-FR')} 💎\n\n` +
            `⚠️ Les diamants sont une **monnaie Discord** — impossible de les donner in game.\n\n` +
            `Le joueur doit soit :\n` +
            `> 🚫 **Annuler la commande** (contacter le staff)\n` +
            `> 👥 **Demander à un membre de sa tribu** de lui fournir les diamants manquants`
          )
          .setTimestamp()],
      }).catch(e => console.error('[ShopTicket] Erreur message diamonds pending:', e));
    }

    // ── Rapport d'achat dans le salon log ─────────────────────────────────────
    try {
      const settings = getSettings();
      const shop = settings.shop || {};
      const logChannelId = settings.guild?.inventoryLogChannelId || shop.shopTicketChannelId;
      if (logChannelId) {
        const logChannel = await interaction.guild.channels.fetch(logChannelId).catch(() => null);
        if (logChannel) {
          const itemLines = cart.items.map(item => {
            const variantLabel = item.variantLabel ? ` — ${item.variantLabel}` : '';
            const qty = item.quantity > 1 ? ` ×${item.quantity}` : '';
            return `• ${item.name}${variantLabel}${qty}`;
          }).join('\n');

          const discountLine = discount > 0
            ? `\n🏷️ Réduction appliquée : **−${discount}%** *(${discountRoleName || 'rôle'})*`
            : '';

          const rapportEmbed = new EmbedBuilder()
            .setColor(warnings.length > 0 ? 0xe67e22 : 0x2ecc71)
            .setTitle('🧾 Rapport d\'achat')
            .setDescription(
              `**Client :** <@${userId}>\n` +
              `**Admin :** ${adminName}` +
              discountLine +
              `\n\n**Articles :**\n${itemLines}` +
              (cart.comment ? `\n\n**Commentaire :** ${cart.comment}` : '') +
              `\n\n**Paiement débité :**\n${paymentDesc}` +
              (warnings.length > 0 ? `\n⚠️ *Solde insuffisant — à vérifier manuellement.*` : '')
            )
            .setFooter({ text: `Ticket #${orderId}` })
            .setTimestamp();

          const threadLink = order.channelId
            ? ` · <#${order.channelId}>`
            : '';
          await logChannel.send({ content: `✅ Vente validée${threadLink}`, embeds: [rapportEmbed] });
        }
      }
    } catch (e) {
      console.error('[ShopTicket] Erreur rapport achat:', e);
    }

  } catch (err) {
    console.error('[ShopTicket] Erreur encaissement:', err);
    return interaction.reply({ content: `❌ Erreur lors de l'encaissement : ${err.message}`, ephemeral: true });
  }
}

// ── Joueur : roulette inventaire — sélectionne un retrait ────────────────────
async function handleInvPick(interaction, orderId) {
  let order = activeOrders.get(orderId);
  if (!order) {
    for (const [, o] of activeOrders) {
      if (o.channelId === interaction.channelId) { order = o; break; }
    }
  }
  if (!order) return interaction.reply({ content: '❌ Commande introuvable.', ephemeral: true });
  if (order.status !== 'pending') return interaction.reply({ content: '⚠️ Cette commande a déjà été traitée.', ephemeral: true });

  const optIdx = parseInt(interaction.values[0], 10);
  const opt = (order.paymentOptions || [])[optIdx];
  if (!opt) return interaction.reply({ content: '❌ Option invalide.', ephemeral: true });

  if (!order.selectedDeductions) order.selectedDeductions = [];

  // Ne pas ajouter deux fois le même inventoryId
  const alreadySelected = order.selectedDeductions.some(d => d.inventoryId === opt.inventoryId);
  if (!alreadySelected) {
    // Calculer la couverture effective : seulement les items pas encore couverts
    const alreadyCoveredSet = new Set(order.selectedDeductions.flatMap(d => d.coveredItemIds || []));
    const effectiveCovered = (opt.coveredItemIds || []).filter(id => !alreadyCoveredSet.has(id));
    // Calculer les slots réellement consommés (coupleInventaire = 2 slots par item)
    const effectiveQty = effectiveCovered.reduce((acc, id) => {
      const item = order.cart.items.find(i => i.id === id);
      return acc + (item?.coupleInventaire ? 2 : 1);
    }, 0);
    // Ajuster le label pour refléter la quantité réelle retirée
    const adjustedLabel = opt.label.replace(/\(\d+\//, `(${effectiveQty}/`);
    order.selectedDeductions.push({
      ...opt,
      coveredItemIds: effectiveCovered,
      usedQty: effectiveQty,
      label: adjustedLabel,
    });
  }

  // Mettre à jour le message avec le nouveau menu (prix mis à jour)
  const msg = buildPaymentSelectMessage(orderId, order);
  await interaction.update(msg);
}

// ── Joueur : roulette inventaire — payer le reste (ou confirmer tout couvert) ─
async function handleInvDirect(interaction, orderId) {
  let order = activeOrders.get(orderId);
  if (!order) {
    for (const [, o] of activeOrders) {
      if (o.channelId === interaction.channelId) { order = o; break; }
    }
  }
  if (!order) return interaction.reply({ content: '❌ Commande introuvable.', ephemeral: true });
  if (order.status !== 'pending') return interaction.reply({ content: '⚠️ Cette commande a déjà été traitée.', ephemeral: true });

  const selectedDeductions = order.selectedDeductions || [];
  const allCovered = new Set(selectedDeductions.flatMap(d => d.coveredItemIds || []));
  const remainingItems = order.cart.items.filter(i => !allCovered.has(i.id));
  const { totalDiamonds: remD, totalStrawberries: remS } = calcCartTotal(remainingItems, order.discount || 0);

  order.paymentChoice = {
    id: 'multi',
    selectedDeductions,
    coveredItemIds: [...allCovered],
    remainingDiamonds: remD,
    remainingStrawberries: remS,
  };

  // Désactiver le menu
  try { await interaction.message.edit({ components: [] }); } catch (e) {}

  // Construire le récap du paiement confirmé
  let summary = '';
  for (const d of selectedDeductions) {
    summary += `• ${d.label.split(' (')[0]}\n`;
  }
  const nothingRemains = remD === 0 && remS === 0;
  if (!nothingRemains) {
    summary += `\n💎 Reste à payer après livraison : **${formatPrice(remD, remS)}**`;
    if (order.discount > 0 && order.discountRoleName) summary += ` *(${order.discountRoleName} −${order.discount}%)*`;
  } else if (selectedDeductions.length === 0) {
    const { totalDiamonds, totalStrawberries } = calcCartTotal(order.cart.items, order.discount || 0);
    summary = `💎 Paiement direct : **${formatPrice(totalDiamonds, totalStrawberries)}**`;
    if (order.discount > 0 && order.discountRoleName) summary += ` *(${order.discountRoleName} −${order.discount}%)*`;
  } else {
    summary += '\n✅ Toute la commande est couverte par tes retraits inventaire.';
  }

  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('✅ Mode de paiement enregistré')
      .setDescription(`${summary}\n\nL'admin va valider ta commande et encaisser **après livraison**.`)
      .setTimestamp()],
  });

  // Avertir si solde insuffisant (visible par l'admin dans le ticket)
  const playerInvCheck = getPlayerInventory(order.userId);
  await sendPaymentWarnings(interaction.channel, order.userId, remD, remS, playerInvCheck);
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

  // Désactiver les boutons de paiement
  try { await interaction.message.edit({ components: [] }); } catch (e) {}

  // Construire le résumé du choix
  let summary = '';
  if (choice.id === 'direct') {
    const { totalDiamonds, totalStrawberries } = calcCartTotal(order.cart.items, order.discount || 0);
    summary = `💎 Paiement direct : **${formatPrice(totalDiamonds, totalStrawberries)}**`;
    if (order.discount > 0 && order.discountRoleName) summary += ` *(${order.discountRoleName} −${order.discount}%)*`;
  } else {
    summary = `**${choice.label}**\n`;
    const hasRemainder = (choice.remainingDiamonds || 0) > 0 || (choice.remainingStrawberries || 0) > 0;
    if (hasRemainder) {
      summary += `↳ Reste à payer après livraison : **${formatPrice(choice.remainingDiamonds || 0, choice.remainingStrawberries || 0)}**`;
      if (order.discount > 0 && order.discountRoleName) summary += ` *(${order.discountRoleName} −${order.discount}%)*`;
    } else {
      summary += '↳ Couvre toute la commande ✅';
    }
  }

  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('✅ Mode de paiement enregistré')
      .setDescription(`${summary}\n\nL'admin va maintenant valider ta commande et encaisser après livraison.`)
      .setTimestamp()],
  });

  // Avertir si solde insuffisant (visible par l'admin dans le ticket)
  const needD = choice.id === 'direct'
    ? (calcCartTotal(order.cart.items, order.discount || 0).totalDiamonds)
    : (choice.remainingDiamonds || 0);
  const needS = choice.id === 'direct'
    ? (calcCartTotal(order.cart.items, order.discount || 0).totalStrawberries)
    : (choice.remainingStrawberries || 0);
  const playerInvCheck = getPlayerInventory(order.userId);
  await sendPaymentWarnings(interaction.channel, order.userId, needD, needS, playerInvCheck);
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
    let payLabel = '';
    if (order.paymentChoice.id === 'multi') {
      const deds = (order.paymentChoice.selectedDeductions || []).map(d => d.label.split(' (')[0]).join(', ');
      const remD = order.paymentChoice.remainingDiamonds || 0;
      const remS = order.paymentChoice.remainingStrawberries || 0;
      payLabel = (deds ? `${deds}\n` : '') + (remD > 0 || remS > 0 ? `💎 Reste : ${formatPrice(remD, remS)}` : '✅ Tout couvert par inventaire');
    } else if (order.paymentChoice.id === 'direct') {
      const { totalDiamonds, totalStrawberries } = calcCartTotal(order.cart.items, order.discount || 0);
      payLabel = `💎 Paiement direct : ${formatPrice(totalDiamonds, totalStrawberries)}`;
    } else {
      payLabel = order.paymentChoice.label?.split(' (')[0] || '?';
    }
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
      .setDescription(`La commande de <@${order.userId}> a été annulée par **${adminName}**.\n\nAucun paiement n'a été effectué.`)
      .setTimestamp()],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`st_admin_close::${orderId}`)
        .setLabel('🔒 Fermer le ticket')
        .setStyle(ButtonStyle.Danger),
    )],
  });
}

// ── Admin : demander confirmation avant de fermer le ticket ──────────────────
async function handleAdminClose(interaction, orderId) {
  const order = activeOrders.get(orderId);

  // Bloquer si la commande est toujours en cours (paiement non confirmé ni annulé)
  if (order && order.status === 'pending') {
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle('🔒 Fermeture impossible')
        .setDescription(
          '❌ Ce ticket ne peut pas être fermé car la commande est **toujours en attente**.\n\n' +
          'Pour pouvoir fermer le ticket, l\'une des conditions suivantes doit être remplie :\n' +
          '> ✅ Le paiement a été **validé & encaissé**\n' +
          '> ❌ La commande a été **annulée**'
        )],
      ephemeral: true,
    });
  }

  // Bloquer si les fraises n'ont pas encore été récupérées in game
  if (order && order.pendingStrawberries > 0) {
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle('🔒 Fermeture impossible — Fraises non récupérées')
        .setDescription(
          `❌ Ce ticket ne peut pas être fermé tant que les fraises n'ont pas été récupérées in game.\n\n` +
          `Montant restant à récupérer : **${order.pendingStrawberries.toLocaleString('fr-FR')} 🍓**\n\n` +
          `Clique sur le bouton **"✅ Fraises récupérées In Game"** dans le message ci-dessus pour confirmer, puis ferme le ticket.`
        )],
      ephemeral: true,
    });
  }

  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0xe67e22)
      .setTitle('⚠️ Fermer ce ticket ?')
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
  const order = activeOrders.get(orderId);
  const userId = order?.userId;
  activeOrders.delete(orderId);

  // Retirer l'accès visuel du joueur
  if (userId) {
    try {
      await interaction.channel.permissionOverwrites.edit(userId, {
        ViewChannel: false,
        SendMessages: false,
      });
    } catch (e) {
      console.error('[ShopTicket] Impossible de modifier les permissions du joueur:', e.message);
    }
  }

  // Renommer le salon avec le préfixe ferme-
  try {
    const currentName = interaction.channel.name;
    const newName = `ferme-${currentName}`.slice(0, 100);
    await interaction.channel.edit({ name: newName, reason: `Ticket fermé par ${adminName}` });
  } catch (e) {
    console.error('[ShopTicket] Impossible de renommer le salon ticket:', e.message);
  }

  // Mettre à jour l'embed de confirmation
  try {
    await interaction.update({
      embeds: [new EmbedBuilder()
        .setColor(0x95a5a6)
        .setTitle('🔒 Ticket fermé')
        .setDescription(`Fermé par **${adminName}**.\nLe joueur ne voit plus ce salon.`)
      ],
      components: [],
    });
  } catch (e) {}

  // Message public dans le salon avec bouton de suppression
  try {
    await interaction.channel.send({
      embeds: [new EmbedBuilder()
        .setColor(0x95a5a6)
        .setTitle('🔒 Ticket fermé')
        .setDescription(
          `Ce ticket a été fermé par **${adminName}**.\n` +
          `Le joueur n'a plus accès à ce salon.\n\n` +
          `Le staff peut continuer à écrire ici. Supprime le ticket quand tu es prêt(e).`
        )
        .setTimestamp()],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`st_delete_ticket::${orderId}`)
          .setLabel('🗑️ Supprimer le ticket')
          .setStyle(ButtonStyle.Danger),
      )],
    });
  } catch (e) {
    console.error('[ShopTicket] Impossible d\'envoyer le message de fermeture:', e.message);
  }
}

// ── Admin : suppression définitive du ticket fermé ───────────────────────────
async function handleDeleteTicket(interaction) {
  const adminName = interaction.member?.displayName || interaction.user.username;

  try {
    await interaction.update({
      embeds: [new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle('🗑️ Suppression en cours...')
        .setDescription('Ce salon sera supprimé dans 3 secondes.')
      ],
      components: [],
    });
  } catch (e) {}

  setTimeout(async () => {
    try {
      await interaction.channel.delete(`Ticket supprimé par ${adminName}`);
    } catch (e) {
      console.error('[ShopTicket] Impossible de supprimer le salon ticket:', e.message);
    }
  }, 3000);
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

// ── Embed récap public (sans prix) ───────────────────────────────────────────
function buildPublicRecapEmbed(order) {
  const { cart, username, userId, createdAt } = order;
  const items = cart.items || [];

  let desc = '';
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    desc += `**${i + 1}.** `;
    if (item.type === 'dino') {
      desc += `🦕 **${item.name}**`;
      if (item.variant && item.variant !== 'base') desc += ` *(${item.variant})*`;
      desc += `\n> ${item.sexe === 'Femelle' ? '♀️' : '♂️'} ${item.sexe}`;
      desc += ` · ${STAT_EMOJIS[item.stat] || ''}${item.stat}`;
      if (item.elementNote) desc += `\n> 🔥 Élément : **${item.elementNote}**`;
      if (item.isShoulder) desc += `\n> 👤 Dino d'épaule`;
    } else {
      desc += `📦 **${item.name}**`;
      if (item.selectedOption) desc += ` — *${item.selectedOption}*`;
    }
    desc += '\n\n';
  }

  if (!desc.trim()) desc = '*Aucun article dans cette commande.*';

  const embed = new EmbedBuilder()
    .setTitle('📋 Récapitulatif de commande')
    .setDescription(desc.trim())
    .setColor(0x7c5cfc);

  if (cart.comment) {
    embed.addFields({
      name: '💬 Commentaire',
      value: cart.comment,
      inline: false,
    });
  }

  const date = createdAt ? new Date(createdAt).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }) : 'Inconnue';
  embed.setFooter({ text: `Commande de ${username} · ${items.length} article(s) · ${date}` });

  return embed;
}

// ── Commande /récap ───────────────────────────────────────────────────────────
async function handleRecapCommand(interaction) {
  // Vérifier que l'utilisateur est admin ticket
  if (!isTicketAdmin(interaction.member)) {
    return interaction.reply({
      content: '❌ Tu n\'as pas la permission d\'utiliser cette commande.',
      ephemeral: true,
    });
  }

  // Trouver la commande liée à ce salon
  let order = null;
  for (const [, o] of activeOrders) {
    if (o.channelId === interaction.channelId) { order = o; break; }
  }

  if (!order) {
    return interaction.reply({
      content: '❌ Aucune commande active trouvée dans ce salon. Cette commande ne fonctionne que dans un ticket shop.',
      ephemeral: true,
    });
  }

  const embed = buildPublicRecapEmbed(order);
  const adminBtns = buildAdminButtons(order.orderId);

  return interaction.reply({
    content: `📋 Récapitulatif posté par <@${interaction.user.id}>`,
    embeds: [embed],
    components: adminBtns,
  });
}

module.exports = {
  handleShopTicketCommand,
  handleShopTicketInteraction,
  publishShopTicketPanel,
  handleRecapCommand,
  activeOrders,
};
