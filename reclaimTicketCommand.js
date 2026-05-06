'use strict';

/**
 * reclaimTicketCommand.js
 * Système de ticket Réclamation :
 * - Panneau publié par /reclamation-panel
 * - Ouverture crée un salon privé recl-username
 * - Choix du type via select menu : Récupération inventaire | Résurrection dino | ...
 * - Flux Récupération : visu inventaire → sélection item perdu → choix item shop → note si OCCASIONNEL
 * - Flux Résurrection : info 500💎 → confirmation → formulaire dino → résumé staff
 * - Fermeture 2 étapes (comme spawn/event ticket)
 * - Persistance PostgreSQL
 */

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');

const { getSettings } = require('./settingsManager');
const { getPlayerInventory, getItemTypes, getCategories } = require('./inventoryManager');
const { getShop } = require('./shopManager');
const { getDinoData } = require('./dinoManager');
const pgStore = require('./pgStore');

const PREFIX = 'rcl';

// ── Map mémoire ───────────────────────────────────────────────────────────────
const activeReclaimTickets = new Map();

// ── Init au démarrage ─────────────────────────────────────────────────────────
async function initReclaimTickets(client) {
  try {
    const rows = await pgStore.loadAllOpenReclaimTickets();
    let loaded = 0;
    for (const data of rows) {
      if (client) {
        const channel = client.channels.cache.get(data.channelId);
        if (!channel) { await pgStore.deleteReclaimTicket(data.ticketId); continue; }
      }
      activeReclaimTickets.set(data.ticketId, data);
      loaded++;
    }
    if (loaded > 0) console.log(`✅ [ReclaimTicket] ${loaded} ticket(s) rechargé(s) depuis PostgreSQL`);
  } catch (err) {
    console.error('[ReclaimTicket] Erreur chargement depuis DB:', err.message);
  }
}

// ── Reconstruction depuis DB si absent de la Map ──────────────────────────────
async function getOrReloadReclaimTicket(ticketId, channelId) {
  if (activeReclaimTickets.has(ticketId)) return activeReclaimTickets.get(ticketId);
  try {
    const rows = await pgStore.loadAllOpenReclaimTickets();
    for (const data of rows) {
      if (data.ticketId === ticketId || (channelId && data.channelId === channelId)) {
        activeReclaimTickets.set(data.ticketId, data);
        return data;
      }
    }
  } catch (e) {
    console.error('[ReclaimTicket] Erreur rechargement ticket:', e.message);
  }
  return null;
}

// ── Paramètres ────────────────────────────────────────────────────────────────
function getReclaimSettings() {
  return getSettings().reclaimTicket || {};
}

// ── Vérification staff ────────────────────────────────────────────────────────
function isStaff(interaction) {
  const settings = getReclaimSettings();
  const roleIds = settings.staffRoleIds || [];
  if (!roleIds.length) return interaction.member?.permissions?.has('ManageChannels') ?? false;
  return interaction.member?.roles?.cache?.some(r => roleIds.includes(r.id)) ?? false;
}

// ── Génération ID ─────────────────────────────────────────────────────────────
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── Couleur du type ───────────────────────────────────────────────────────────
function typeColor(type) {
  if (type === 'inventory') return 0x3498db;
  if (type === 'resurrection') return 0xe74c3c;
  return 0x9b59b6;
}

// ══════════════════════════════════════════════════════════════════════════════
// PANNEAU
// ══════════════════════════════════════════════════════════════════════════════

async function publishReclaimPanel(interaction) {
  const settings = getReclaimSettings();

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('📋 Réclamations — Arki\'Family')
    .setDescription(
      settings.panelDescription ||
      '**Un problème en jeu ?** Ouvre un ticket de réclamation.\n\n' +
      '🎒 **Récupération d\'inventaire** — Un item perdu ? Retrouve-le.\n' +
      '💀 **Résurrection de dino** — Dino mort ? Ça arrive.\n\n' +
      '*Clique sur le bouton ci-dessous pour ouvrir ton ticket.*'
    );

  if (settings.panelImageUrl) embed.setImage(settings.panelImageUrl);

  const btn = new ButtonBuilder()
    .setCustomId(`${PREFIX}_open`)
    .setLabel(settings.buttonLabel || '📋 Ouvrir une réclamation')
    .setStyle(ButtonStyle.Primary);

  await interaction.channel.send({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(btn)],
  });
  return interaction.reply({ content: '✅ Panneau de réclamation publié !', ephemeral: true });
}

// ══════════════════════════════════════════════════════════════════════════════
// OUVERTURE DU TICKET
// ══════════════════════════════════════════════════════════════════════════════

async function handleOpenReclaim(interaction) {
  const settings = getReclaimSettings();
  const guild = interaction.guild;
  const user = interaction.user;

  const safeName = user.username.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 20);
  const channelName = `recl-${safeName}`;

  const existing = guild.channels.cache.find(c => c.name === channelName && !c.name.startsWith('ferme-'));
  if (existing) {
    return interaction.reply({
      content: `📋 Tu as déjà un ticket de réclamation ouvert : <#${existing.id}>`,
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  const perms = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
      ],
    },
  ];

  for (const roleId of (settings.staffRoleIds || [])) {
    if (guild.roles.cache.has(roleId)) {
      perms.push({
        id: roleId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageMessages,
        ],
      });
    }
  }

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: settings.categoryId || null,
    permissionOverwrites: perms,
  });

  const ticketId = genId();
  const ticketData = {
    ticketId,
    channelId: channel.id,
    userId: user.id,
    username: user.displayName || user.username,
    status: 'open',
    type: null,
    createdAt: Date.now(),
    claimData: {},
  };

  activeReclaimTickets.set(ticketId, ticketData);
  pgStore.saveReclaimTicket(ticketData).catch(() => {});

  if (settings.notifChannelId) {
    const notifCh = guild.channels.cache.get(settings.notifChannelId);
    if (notifCh) {
      notifCh.send(`📋 **Nouvelle réclamation** — <@${user.id}> (\`${user.username}\`) → <#${channel.id}>`).catch(() => {});
    }
  }

  await channel.send({
    content: `<@${user.id}>`,
    embeds: [buildWelcomeEmbed(ticketData, settings)],
    components: [buildTypeSelectRow(ticketId)],
  });

  await interaction.editReply({ content: `✅ Ton ticket a été ouvert : <#${channel.id}>` });
}

// ── Embed de bienvenue ────────────────────────────────────────────────────────
function buildWelcomeEmbed(ticketData, settings) {
  const msg = settings.welcomeMessage ||
    'Bienvenue {user} !\n\nDis-nous ce qui s\'est passé en sélectionnant le type de réclamation ci-dessous.\nL\'équipe staff traitera ta demande dès que possible.';

  return new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('📋 Nouveau ticket de réclamation')
    .setDescription(msg.replace(/\{user\}/g, `<@${ticketData.userId}>`))
    .setFooter({ text: `Ticket ID : ${ticketData.ticketId}` })
    .setTimestamp();
}

// ── Select menu de choix du type ─────────────────────────────────────────────
function buildTypeSelectRow(ticketId) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${PREFIX}_type_select::${ticketId}`)
    .setPlaceholder('📋 Choisir le type de réclamation...')
    .addOptions([
      {
        label: '🎒 Récupération d\'inventaire',
        description: 'Tu as perdu un item de ton inventaire',
        value: 'inventory',
        emoji: '🎒',
      },
      {
        label: '💀 Résurrection de dino',
        description: 'Ton dino est mort, 500💎 seront prélevés',
        value: 'resurrection',
        emoji: '💀',
      },
    ]);

  return new ActionRowBuilder().addComponents(select);
}

// ══════════════════════════════════════════════════════════════════════════════
// CHOIX DU TYPE
// ══════════════════════════════════════════════════════════════════════════════

async function handleTypeSelect(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  const type = interaction.values[0];
  data.type = type;
  pgStore.saveReclaimTicket(data).catch(() => {});

  try { await interaction.message.edit({ components: [] }); } catch (e) {}

  if (type === 'inventory') return startInventoryReclaim(interaction, data);
  if (type === 'resurrection') return startResurrectionReclaim(interaction, data);

  return interaction.reply({ content: '❌ Type inconnu.', ephemeral: true });
}

// ══════════════════════════════════════════════════════════════════════════════
// FLUX RÉCUPÉRATION D'INVENTAIRE
// ══════════════════════════════════════════════════════════════════════════════

async function startInventoryReclaim(interaction, data) {
  const inv = getPlayerInventory(data.userId);
  const itemTypes = getItemTypes();
  const categories = getCategories();

  const invLines = [];
  let hasItems = false;

  for (const cat of categories) {
    const catItems = itemTypes.filter(t => t.category === cat.id);
    const lines = [];
    for (const t of catItems) {
      const qty = inv[t.id] || 0;
      if (qty > 0) {
        const isOcc = cat.id === 'occasionnel';
        lines.push(`${t.emoji || '📦'} **${t.name}** × ${qty.toLocaleString('fr-FR')}${isOcc ? ' ✨' : ''}`);
        hasItems = true;
      }
    }
    if (lines.length > 0) {
      invLines.push(`**${cat.emoji || ''} ${cat.name}**\n${lines.join('\n')}`);
    }
  }

  const invDesc = hasItems
    ? invLines.join('\n\n')
    : '*Ton inventaire est vide ou aucun item enregistré.*';

  const embed = new EmbedBuilder()
    .setColor(typeColor('inventory'))
    .setTitle('🎒 Récupération d\'inventaire')
    .setDescription(
      `Voici ton inventaire actuel :\n\n${invDesc.slice(0, 3800)}\n\n` +
      `---\n✨ = Item **OCCASIONNEL** (une note sera demandée)\n\n` +
      `**Utilise le menu ci-dessous** pour sélectionner l'item que tu souhaites récupérer.`
    );

  await interaction.reply({ embeds: [embed] });

  await buildInventoryItemSelectAndSend(interaction.channel, data);
}

async function buildInventoryItemSelectAndSend(channel, data) {
  const itemTypes = getItemTypes();
  const categories = getCategories();

  const options = [];

  for (const cat of categories) {
    const catItems = itemTypes.filter(t => t.category === cat.id);
    for (const t of catItems) {
      if (options.length >= 25) break;
      const isOcc = cat.id === 'occasionnel';
      options.push({
        label: `${t.name}${isOcc ? ' ✨' : ''}`.slice(0, 100),
        description: `Catégorie : ${cat.name}${isOcc ? ' — OCCASIONNEL' : ''}`.slice(0, 100),
        value: `${t.id}::${isOcc ? '1' : '0'}`,
        emoji: t.emoji || '📦',
      });
    }
    if (options.length >= 25) break;
  }

  if (options.length === 0) {
    return channel.send({ content: '❌ Aucun type d\'item configuré. Contacte un admin.' });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`${PREFIX}_inv_item_lost::${data.ticketId}`)
    .setPlaceholder('Quel item as-tu perdu ?')
    .addOptions(options);

  await channel.send({
    embeds: [new EmbedBuilder()
      .setColor(typeColor('inventory'))
      .setTitle('📦 Étape 1 — Quel item as-tu perdu ?')
      .setDescription('Sélectionne l\'item que tu n\'as plus et que tu veux récupérer.')
    ],
    components: [new ActionRowBuilder().addComponents(select)],
  });
}

// ── Joueur sélectionne l'item perdu ──────────────────────────────────────────
async function handleInvItemLost(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  const [itemId, isOccStr] = interaction.values[0].split('::');
  const isOccasionnel = isOccStr === '1';
  const itemTypes = getItemTypes();
  const itemType = itemTypes.find(t => t.id === itemId);

  data.claimData.lostItemId = itemId;
  data.claimData.lostItemName = itemType?.name || itemId;
  data.claimData.lostItemIsOccasionnel = isOccasionnel;
  pgStore.saveReclaimTicket(data).catch(() => {});

  try { await interaction.message.edit({ components: [] }); } catch (e) {}

  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(typeColor('inventory'))
      .setDescription(`✅ Item perdu sélectionné : **${itemType?.emoji || '📦'} ${data.claimData.lostItemName}**${isOccasionnel ? ' *(OCCASIONNEL)*' : ''}`)
    ],
  });

  await buildShopItemSelectAndSend(interaction.channel, data);
}

// ── Étape 2 : choisir l'item de remplacement dans le shop ────────────────────
async function buildShopItemSelectAndSend(channel, data) {
  const shop = getShop();
  const dinos = getDinoData();

  const options = [];

  // Ajouter les dinos du shop
  for (const dino of (dinos || [])) {
    if (options.length >= 20) break;
    if (dino.notAvailableShop) continue;
    options.push({
      label: `🦕 ${dino.name}`.slice(0, 100),
      description: (dino.location || 'Dino').slice(0, 100),
      value: `dino::${dino.id}`,
      emoji: '🦕',
    });
  }

  // Ajouter les packs du shop
  for (const pack of (shop.packs || [])) {
    if (options.length >= 25) break;
    if (!pack.visible) continue;
    options.push({
      label: `📦 ${pack.name}`.slice(0, 100),
      description: (pack.description || 'Pack').slice(0, 100),
      value: `pack::${pack.id}`,
      emoji: '📦',
    });
  }

  if (options.length === 0) {
    const modal = new ModalBuilder()
      .setCustomId(`${PREFIX}_inv_shop_manual::${data.ticketId}`)
      .setTitle('Item de remplacement');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('shop_item_name')
          .setLabel('Quel item souhaites-tu récupérer ?')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder('Ex : Argentavis, Pack Survie, ...')
      )
    );
    return channel.send({ content: 'Aucun item en boutique trouvé. Un admin te contactera directement.' });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`${PREFIX}_inv_shop_item::${data.ticketId}`)
    .setPlaceholder('Quel item veux-tu récupérer ?')
    .addOptions(options);

  await channel.send({
    embeds: [new EmbedBuilder()
      .setColor(typeColor('inventory'))
      .setTitle('🛒 Étape 2 — Quel item souhaites-tu récupérer ?')
      .setDescription('Choisis l\'item que tu veux récupérer dans la boutique.\n\n*Aucun paiement ne sera demandé — le staff vérifiera et livrera manuellement.*')
    ],
    components: [new ActionRowBuilder().addComponents(select)],
  });
}

// ── Joueur sélectionne l'item du shop ────────────────────────────────────────
async function handleInvShopItem(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  const [shopType, shopId] = interaction.values[0].split('::');
  data.claimData.shopItemId = shopId;
  data.claimData.shopItemType = shopType;

  let shopItemName = shopId;
  if (shopType === 'dino') {
    const dinos = getDinoData();
    const dino = dinos?.find(d => d.id === shopId);
    shopItemName = dino ? `🦕 ${dino.name}` : shopId;
  } else {
    const shop = getShop();
    const pack = (shop.packs || []).find(p => p.id === shopId);
    shopItemName = pack ? `📦 ${pack.name}` : shopId;
  }

  data.claimData.shopItemName = shopItemName;
  pgStore.saveReclaimTicket(data).catch(() => {});

  try { await interaction.message.edit({ components: [] }); } catch (e) {}

  if (data.claimData.lostItemIsOccasionnel) {
    const modal = new ModalBuilder()
      .setCustomId(`${PREFIX}_inv_occ_note::${ticketId}`)
      .setTitle('✨ Item OCCASIONNEL — Note requise');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('occ_note')
          .setLabel('Explique comment tu as obtenu cet item')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setPlaceholder('Ex : Gagné lors du giveaway du 12 mars, reçu en récompense vote...')
          .setMaxLength(500)
      )
    );
    return interaction.showModal(modal);
  }

  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(typeColor('inventory'))
      .setDescription(`✅ Item sélectionné : **${shopItemName}**`)
    ],
  });

  await sendInventoryReclaimSummary(interaction.channel, data);
}

// ── Modal note item occasionnel ───────────────────────────────────────────────
async function handleOccNote(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  data.claimData.occasionnelNote = interaction.fields.getTextInputValue('occ_note');
  pgStore.saveReclaimTicket(data).catch(() => {});

  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(typeColor('inventory'))
      .setDescription(`✅ Note enregistrée.`)
    ],
  });

  await sendInventoryReclaimSummary(interaction.channel, data);
}

// ── Résumé récupération d'inventaire (affiché dans le ticket) ─────────────────
async function sendInventoryReclaimSummary(channel, data) {
  const embed = new EmbedBuilder()
    .setColor(typeColor('inventory'))
    .setTitle('🎒 Réclamation — Récupération d\'inventaire')
    .addFields(
      { name: '👤 Joueur', value: `<@${data.userId}>`, inline: true },
      { name: '📦 Item perdu', value: `${data.claimData.lostItemName}${data.claimData.lostItemIsOccasionnel ? ' ✨ *(OCCASIONNEL)*' : ''}`, inline: true },
      { name: '🛒 Item à récupérer', value: data.claimData.shopItemName || '?', inline: true },
    )
    .setTimestamp();

  if (data.claimData.occasionnelNote) {
    embed.addFields({ name: '📝 Note (item OCCASIONNEL)', value: data.claimData.occasionnelNote });
  }

  embed.setFooter({ text: '⏳ En attente de traitement par le staff' });

  const staffRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}_mark_done::${data.ticketId}`)
      .setLabel('✅ Réclamation traitée')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}_mark_refused::${data.ticketId}`)
      .setLabel('❌ Refuser')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}_close::${data.ticketId}`)
      .setLabel('🔒 Fermer le ticket')
      .setStyle(ButtonStyle.Secondary),
  );

  await channel.send({ embeds: [embed], components: [staffRow] });
}

// ══════════════════════════════════════════════════════════════════════════════
// FLUX RÉSURRECTION
// ══════════════════════════════════════════════════════════════════════════════

async function startResurrectionReclaim(interaction, data) {
  const inv = getPlayerInventory(data.userId);
  const diamonds = inv['diamants'] || 0;
  const enough = diamonds >= 500;

  const embed = new EmbedBuilder()
    .setColor(typeColor('resurrection'))
    .setTitle('💀 Résurrection de dino')
    .setDescription(
      `**Coût :** 500 💎 prélevés depuis ton compte Discord.\n\n` +
      `💎 Ton solde actuel : **${diamonds.toLocaleString('fr-FR')} 💎**\n` +
      (enough ? '✅ Tu as suffisamment de diamants.' : `⚠️ Solde insuffisant — tu as **${diamonds.toLocaleString('fr-FR')} 💎** sur les **500 💎** nécessaires.\n\n*Le staff décidera au cas par cas.*`) +
      `\n\n**Le staff prélèvera manuellement les 500 💎 après vérification.**\n\nClique sur **Confirmer** pour continuer et renseigner les infos de ton dino.`
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}_resur_confirm::${data.ticketId}`)
      .setLabel('✅ Confirmer — Renseigner les infos')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}_close::${data.ticketId}`)
      .setLabel('❌ Annuler')
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.reply({ embeds: [embed], components: [row] });
}

// ── Joueur confirme la résurrection → modal ───────────────────────────────────
async function handleResurConfirm(interaction, ticketId) {
  const modal = new ModalBuilder()
    .setCustomId(`${PREFIX}_resur_modal::${ticketId}`)
    .setTitle('💀 Infos du dino à ressusciter');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('dino_name')
        .setLabel('Nom du dino (espèce)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('Ex : Rex, Argentavis, Wyvern de Feu...')
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('dino_level')
        .setLabel('Niveau du dino (si connu)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setPlaceholder('Ex : 250')
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('dino_details')
        .setLabel('Détails supplémentaires')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setPlaceholder('Circonstances, carte, nom du dino, couleurs...')
        .setMaxLength(500)
    )
  );

  await interaction.showModal(modal);
}

// ── Modal résurrection soumis ─────────────────────────────────────────────────
async function handleResurModal(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  data.claimData.dinoName = interaction.fields.getTextInputValue('dino_name');
  data.claimData.dinoLevel = interaction.fields.getTextInputValue('dino_level') || 'Non précisé';
  data.claimData.dinoDetails = interaction.fields.getTextInputValue('dino_details') || '';
  pgStore.saveReclaimTicket(data).catch(() => {});

  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(typeColor('resurrection'))
      .setDescription(`✅ Informations enregistrées. Résumé en cours...`)
    ],
  });

  await sendResurrectionSummary(interaction.channel, data);
}

// ── Résumé résurrection ───────────────────────────────────────────────────────
async function sendResurrectionSummary(channel, data) {
  const inv = getPlayerInventory(data.userId);
  const diamonds = inv['diamants'] || 0;

  const embed = new EmbedBuilder()
    .setColor(typeColor('resurrection'))
    .setTitle('💀 Réclamation — Résurrection de dino')
    .addFields(
      { name: '👤 Joueur', value: `<@${data.userId}>`, inline: true },
      { name: '💎 Solde actuel', value: `${diamonds.toLocaleString('fr-FR')} 💎`, inline: true },
      { name: '💸 Coût', value: '500 💎 *(prélèvement manuel par le staff)*', inline: true },
      { name: '🦕 Espèce', value: data.claimData.dinoName || '?', inline: true },
      { name: '⭐ Niveau', value: data.claimData.dinoLevel || 'Non précisé', inline: true },
    )
    .setTimestamp();

  if (data.claimData.dinoDetails) {
    embed.addFields({ name: '📝 Détails', value: data.claimData.dinoDetails });
  }

  embed.setFooter({ text: '⏳ En attente de traitement par le staff — prélèvement manuel des 500💎' });

  const staffRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}_mark_done::${data.ticketId}`)
      .setLabel('✅ Réclamation traitée')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}_mark_refused::${data.ticketId}`)
      .setLabel('❌ Refuser')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}_close::${data.ticketId}`)
      .setLabel('🔒 Fermer le ticket')
      .setStyle(ButtonStyle.Secondary),
  );

  await channel.send({ embeds: [embed], components: [staffRow] });
}

// ══════════════════════════════════════════════════════════════════════════════
// ACTIONS STAFF
// ══════════════════════════════════════════════════════════════════════════════

async function handleMarkDone(interaction, ticketId) {
  if (!isStaff(interaction)) return interaction.reply({ content: '🚫 Réservé au staff.', ephemeral: true });

  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  const adminName = interaction.member?.displayName || interaction.user.username;
  data.status = 'done';
  pgStore.saveReclaimTicket(data).catch(() => {});

  try { await interaction.message.edit({ components: [] }); } catch (e) {}

  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('✅ Réclamation traitée')
      .setDescription(
        `La réclamation de <@${data.userId}> a été **traitée** par **${adminName}**.\n\n` +
        `Le ticket peut maintenant être fermé.`
      )
      .setTimestamp()
    ],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${PREFIX}_close::${ticketId}`)
        .setLabel('🔒 Fermer le ticket')
        .setStyle(ButtonStyle.Secondary),
    )],
  });
}

async function handleMarkRefused(interaction, ticketId) {
  if (!isStaff(interaction)) return interaction.reply({ content: '🚫 Réservé au staff.', ephemeral: true });

  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  const adminName = interaction.member?.displayName || interaction.user.username;
  data.status = 'refused';
  pgStore.saveReclaimTicket(data).catch(() => {});

  try { await interaction.message.edit({ components: [] }); } catch (e) {}

  const modal = new ModalBuilder()
    .setCustomId(`${PREFIX}_refuse_reason::${ticketId}`)
    .setTitle('Motif du refus');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('Motif du refus (visible par le joueur)')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setPlaceholder('Ex : Item non éligible, conditions non remplies...')
        .setMaxLength(300)
    )
  );

  return interaction.showModal(modal);
}

async function handleRefuseReason(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  const adminName = interaction.member?.displayName || interaction.user.username;
  const reason = interaction.fields.getTextInputValue('reason') || 'Aucun motif précisé.';

  await interaction.reply({
    content: `<@${data?.userId || ''}>`,
    embeds: [new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle('❌ Réclamation refusée')
      .setDescription(
        `Ta réclamation a été **refusée** par **${adminName}**.\n\n**Motif :** ${reason}\n\n*Si tu penses qu'il y a une erreur, n'hésite pas à contacter le staff directement.*`
      )
      .setTimestamp()
    ],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${PREFIX}_close::${ticketId}`)
        .setLabel('🔒 Fermer le ticket')
        .setStyle(ButtonStyle.Secondary),
    )],
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// FERMETURE (2 étapes)
// ══════════════════════════════════════════════════════════════════════════════

async function handleClose(interaction, ticketId) {
  if (!isStaff(interaction)) return interaction.reply({ content: '🚫 Réservé au staff.', ephemeral: true });

  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0xe67e22)
      .setTitle('⚠️ Fermer ce ticket ?')
      .setDescription('Le joueur n\'aura plus accès à ce salon.\nLe ticket restera visible pour le staff jusqu\'à sa suppression.')
    ],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${PREFIX}_close_confirm::${ticketId}`)
        .setLabel('✅ Oui, fermer')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`${PREFIX}_close_cancel::${ticketId}`)
        .setLabel('❌ Annuler')
        .setStyle(ButtonStyle.Secondary),
    )],
    ephemeral: true,
  });
}

async function handleCloseConfirm(interaction, ticketId) {
  if (!isStaff(interaction)) return interaction.reply({ content: '🚫 Réservé au staff.', ephemeral: true });

  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  const adminName = interaction.member?.displayName || interaction.user.username;
  const userId = data?.userId;

  if (userId) {
    try {
      await interaction.channel.permissionOverwrites.edit(userId, { ViewChannel: false, SendMessages: false });
    } catch (e) {}
  }

  try {
    const newName = `ferme-${interaction.channel.name}`.slice(0, 100);
    await interaction.channel.edit({ name: newName, reason: `Ticket fermé par ${adminName}` });
  } catch (e) {}

  if (data) {
    data.status = 'closed';
    pgStore.saveReclaimTicket(data).catch(() => {});
  }

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

  await interaction.channel.send({
    embeds: [new EmbedBuilder()
      .setColor(0x95a5a6)
      .setTitle('🔒 Ticket fermé')
      .setDescription(
        `Ce ticket a été fermé par **${adminName}**.\n` +
        `Le joueur n'a plus accès à ce salon.\n\n` +
        `Supprime le ticket quand tu es prêt(e).`
      )
      .setTimestamp()
    ],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${PREFIX}_delete::${ticketId}`)
        .setLabel('🗑️ Supprimer le ticket')
        .setStyle(ButtonStyle.Danger),
    )],
  }).catch(() => {});
}

async function handleDelete(interaction, ticketId) {
  if (!isStaff(interaction)) return interaction.reply({ content: '🚫 Réservé au staff.', ephemeral: true });

  const adminName = interaction.member?.displayName || interaction.user.username;

  try {
    await interaction.update({
      embeds: [new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle('🗑️ Suppression en cours…')
        .setDescription('Ce salon sera supprimé dans 3 secondes.')
      ],
      components: [],
    });
  } catch (e) {}

  setTimeout(async () => {
    try {
      await interaction.channel.delete(`Ticket supprimé par ${adminName}`);
      activeReclaimTickets.delete(ticketId);
      await pgStore.deleteReclaimTicket(ticketId);
    } catch (err) {
      console.error('[ReclaimTicket] Erreur suppression salon:', err.message);
    }
  }, 3000);
}

// ══════════════════════════════════════════════════════════════════════════════
// COMMANDE SLASH
// ══════════════════════════════════════════════════════════════════════════════

async function handleReclaimCommand(interaction) {
  if (interaction.commandName !== 'reclamation-panel') return;
  return publishReclaimPanel(interaction);
}

// ══════════════════════════════════════════════════════════════════════════════
// DISPATCHER
// ══════════════════════════════════════════════════════════════════════════════

async function handleReclaimTicketInteraction(interaction) {
  const isBtn = interaction.isButton();
  const isSelect = interaction.isStringSelectMenu();
  const isModal = interaction.isModalSubmit();

  const id = interaction.customId;
  if (!id || !id.startsWith(`${PREFIX}_`)) return;

  // ── Bouton ouverture ──────────────────────────────────────────────────────
  if (id === `${PREFIX}_open`) return handleOpenReclaim(interaction);

  // ── Select type ───────────────────────────────────────────────────────────
  if (isSelect && id.startsWith(`${PREFIX}_type_select::`)) {
    const ticketId = id.split('::')[1];
    return handleTypeSelect(interaction, ticketId);
  }

  // ── Select item perdu ─────────────────────────────────────────────────────
  if (isSelect && id.startsWith(`${PREFIX}_inv_item_lost::`)) {
    const ticketId = id.split('::')[1];
    return handleInvItemLost(interaction, ticketId);
  }

  // ── Select item shop ──────────────────────────────────────────────────────
  if (isSelect && id.startsWith(`${PREFIX}_inv_shop_item::`)) {
    const ticketId = id.split('::')[1];
    return handleInvShopItem(interaction, ticketId);
  }

  // ── Modal note occasionnel ────────────────────────────────────────────────
  if (isModal && id.startsWith(`${PREFIX}_inv_occ_note::`)) {
    const ticketId = id.split('::')[1];
    return handleOccNote(interaction, ticketId);
  }

  // ── Résurrection : confirmation ───────────────────────────────────────────
  if (isBtn && id.startsWith(`${PREFIX}_resur_confirm::`)) {
    const ticketId = id.split('::')[1];
    return handleResurConfirm(interaction, ticketId);
  }

  // ── Résurrection : modal ──────────────────────────────────────────────────
  if (isModal && id.startsWith(`${PREFIX}_resur_modal::`)) {
    const ticketId = id.split('::')[1];
    return handleResurModal(interaction, ticketId);
  }

  // ── Staff : traité ────────────────────────────────────────────────────────
  if (isBtn && id.startsWith(`${PREFIX}_mark_done::`)) {
    const ticketId = id.split('::')[1];
    return handleMarkDone(interaction, ticketId);
  }

  // ── Staff : refuser ───────────────────────────────────────────────────────
  if (isBtn && id.startsWith(`${PREFIX}_mark_refused::`)) {
    const ticketId = id.split('::')[1];
    return handleMarkRefused(interaction, ticketId);
  }

  // ── Modal motif de refus ──────────────────────────────────────────────────
  if (isModal && id.startsWith(`${PREFIX}_refuse_reason::`)) {
    const ticketId = id.split('::')[1];
    return handleRefuseReason(interaction, ticketId);
  }

  // ── Fermeture ─────────────────────────────────────────────────────────────
  if (isBtn && id.startsWith(`${PREFIX}_close::`)) {
    const ticketId = id.split('::')[1];
    return handleClose(interaction, ticketId);
  }

  if (isBtn && id.startsWith(`${PREFIX}_close_confirm::`)) {
    const ticketId = id.split('::')[1];
    return handleCloseConfirm(interaction, ticketId);
  }

  if (isBtn && id.startsWith(`${PREFIX}_close_cancel::`)) {
    return interaction.update({ components: [] });
  }

  if (isBtn && id.startsWith(`${PREFIX}_delete::`)) {
    const ticketId = id.split('::')[1];
    return handleDelete(interaction, ticketId);
  }
}

module.exports = {
  handleReclaimCommand,
  handleReclaimTicketInteraction,
  initReclaimTickets,
  publishReclaimPanel,
};
