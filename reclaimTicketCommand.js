'use strict';

/**
 * reclaimTicketCommand.js — Système de ticket Réclamation
 *
 * Types disponibles (dans l'ordre du select menu) :
 *   inventory    → Récupération d'inventaire
 *   resurrection → Résurrection de dino (500💎, vérif auto solde, prélèvement admin)
 *   structures   → Structures abandonnées/gênantes (map + coords + note)
 *   autres       → Autres demandes (texte libre — toujours en dernier)
 *
 * Fonctionnalités :
 *   - Salon nommé par type : inventaire-username, resurrection-username, etc.
 *   - Renommage du salon après sélection du type
 *   - Résurrection : blocage si solde insuffisant (configurable), bouton admin prélèvement auto
 *   - Fermeture 2 étapes : Fermer → (Supprimer + Ajouter une note)
 *   - Compte-rendu envoyé dans salon log admin à la suppression
 *   - Note staff optionnelle affichée dans le compte-rendu
 *   - Persistance PostgreSQL + rechargement propre au redémarrage
 */

const {
  EmbedBuilder,
  AttachmentBuilder,
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

const path = require('path');
const RECLAIM_IMG = path.join(__dirname, 'web/public/img/reclamation.png');

const { getSettings } = require('./settingsManager');
const { getPlayerInventory, getItemTypes, getCategories, removeFromInventory } = require('./inventoryManager');
const { getShop } = require('./shopManager');
const { getDinoData } = require('./dinoManager');
const pgStore = require('./pgStore');

const PREFIX = 'rcl';

// ── Map mémoire ───────────────────────────────────────────────────────────────
const activeReclaimTickets = new Map();

// ══════════════════════════════════════════════════════════════════════════════
// INIT & PERSISTENCE
// ══════════════════════════════════════════════════════════════════════════════

async function initReclaimTickets(client) {
  try {
    const rows = await pgStore.loadAllOpenReclaimTickets();
    let loaded = 0;
    for (const data of rows) {
      if (client) {
        const channel = client.channels.cache.get(data.channelId);
        if (!channel) {
          await pgStore.deleteReclaimTicket(data.ticketId);
          continue;
        }
      }
      activeReclaimTickets.set(data.ticketId, data);
      loaded++;
    }
    if (loaded > 0) console.log(`✅ [ReclaimTicket] ${loaded} ticket(s) rechargé(s) depuis PostgreSQL`);
  } catch (err) {
    console.error('[ReclaimTicket] Erreur chargement depuis DB:', err.message);
  }
}

async function getOrReloadReclaimTicket(ticketId, channelId) {
  if (ticketId && activeReclaimTickets.has(ticketId)) return activeReclaimTickets.get(ticketId);
  try {
    const rows = await pgStore.loadAllOpenReclaimTickets();
    for (const data of rows) {
      if ((ticketId && data.ticketId === ticketId) || (channelId && data.channelId === channelId)) {
        activeReclaimTickets.set(data.ticketId, data);
        return data;
      }
    }
  } catch (e) {
    console.error('[ReclaimTicket] Erreur rechargement ticket:', e.message);
  }
  return null;
}

function saveTicket(data) {
  activeReclaimTickets.set(data.ticketId, data);
  pgStore.saveReclaimTicket(data).catch(() => {});
}

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function getReclaimSettings() {
  return getSettings().reclaimTicket || {};
}

// ── Log inventaire dans le salon shop (même canal que les ventes) ─────────────
async function sendInventoryLog(guild, message) {
  try {
    const settings = getSettings();
    const shop = getShop();
    const logChannelId = settings.guild?.inventoryLogChannelId || shop.shopTicketChannelId;
    if (!logChannelId) return;
    const logCh = await guild.channels.fetch(logChannelId).catch(() => null);
    if (logCh) await logCh.send(message);
  } catch (e) {
    console.error('[ReclaimTicket] Erreur log inventaire:', e.message);
  }
}

function isStaff(interaction) {
  const settings = getReclaimSettings();
  const roleIds = settings.staffRoleIds || [];
  if (!roleIds.length) return interaction.member?.permissions?.has('ManageChannels') ?? false;
  return interaction.member?.roles?.cache?.some(r => roleIds.includes(r.id)) ?? false;
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function typeColor(type) {
  if (type === 'inventory')    return 0x3498db;
  if (type === 'resurrection') return 0xe74c3c;
  if (type === 'structures')   return 0xe67e22;
  if (type === 'autres')       return 0x95a5a6;
  return 0x9b59b6;
}

function typePrefix(type) {
  if (type === 'inventory')    return 'inventaire';
  if (type === 'resurrection') return 'resurrection';
  if (type === 'structures')   return 'structures';
  if (type === 'autres')       return 'autres';
  return 'recl';
}

function typeLabel(type) {
  if (type === 'inventory')    return '🎒 Récupération d\'inventaire';
  if (type === 'resurrection') return '💀 Résurrection de dino';
  if (type === 'structures')   return '🧱 Structures abandonnées/gênantes';
  if (type === 'autres')       return '💬 Autres demandes';
  return '📋 Réclamation';
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
      '🎒 **Récupération inventaire** — Tu souhaites récupérer un ou plusieurs items de ton inventaire\n' +
      '💀 **Résurrection de dino** — Tu as l\'essence de ton Dino et tu souhaites avoir recours à un Oasisaure\n' +
      '🧱 **Structures abandonnées** — Des constructions gênantes ou abandonnées ?\n' +
      '💬 **Autres demandes** — Explique nous tout 📝\n\n' +
      '*Clique sur le bouton ci-dessous pour ouvrir ton ticket.*'
    );

  const btn = new ButtonBuilder()
    .setCustomId(`${PREFIX}_open`)
    .setLabel(settings.buttonLabel || '📋 Ouvrir une réclamation')
    .setStyle(ButtonStyle.Primary);

  const sendOpts = { embeds: [embed], components: [new ActionRowBuilder().addComponents(btn)] };
  if (settings.panelImageUrl) {
    embed.setThumbnail(settings.panelImageUrl);
  } else {
    const attachment = new AttachmentBuilder(RECLAIM_IMG, { name: 'reclamation.png' });
    embed.setThumbnail('attachment://reclamation.png');
    sendOpts.files = [attachment];
  }

  await interaction.channel.send(sendOpts);
  return interaction.reply({ content: '✅ Panneau de réclamation publié !', ephemeral: true });
}

// ══════════════════════════════════════════════════════════════════════════════
// OUVERTURE DU TICKET
// ══════════════════════════════════════════════════════════════════════════════

async function handleOpenReclaim(interaction) {
  const guild = interaction.guild;
  const user  = interaction.user;
  const safeName = user.username.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 20);

  // Vérifier si un ticket est déjà ouvert pour cet utilisateur
  const existing = guild.channels.cache.find(ch => {
    if (ch.type !== ChannelType.GuildText) return false;
    const prefixes = ['inventaire-', 'resurrection-', 'structures-', 'autres-'];
    return prefixes.some(p => ch.name === `${p}${safeName}`);
  });
  if (existing) {
    return interaction.reply({
      content: `📋 Tu as déjà un ticket de réclamation ouvert : <#${existing.id}>`,
      ephemeral: true,
    });
  }

  // Afficher le select de type AVANT la création du salon
  const preEmbed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('📋 Quel type de réclamation ?')
    .setDescription(
      '**Sélectionne le type de ta demande** dans le menu ci-dessous.\n\n' +
      'Un salon privé sera créé automatiquement.'
    )
    .setThumbnail('attachment://reclamation.png');

  const preAttachment = new AttachmentBuilder(RECLAIM_IMG, { name: 'reclamation.png' });
  return interaction.reply({
    embeds: [preEmbed],
    components: [buildPreTypeSelectRow()],
    files: [preAttachment],
    ephemeral: true,
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// SÉLECTION DU TYPE AVANT OUVERTURE → CRÉATION DU SALON
// ══════════════════════════════════════════════════════════════════════════════

async function handlePreTypeSelect(interaction) {
  const type     = interaction.values[0];
  const user     = interaction.user;
  const guild    = interaction.guild;
  const settings = getReclaimSettings();
  const safeName = user.username.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 20);

  // Double-vérification ticket existant
  const existing = guild.channels.cache.find(ch => {
    if (ch.type !== ChannelType.GuildText) return false;
    const prefixes = ['inventaire-', 'resurrection-', 'structures-', 'autres-'];
    return prefixes.some(p => ch.name === `${p}${safeName}`);
  });
  if (existing) {
    return interaction.update({
      content: `📋 Tu as déjà un ticket ouvert : <#${existing.id}>`,
      embeds: [], components: [], files: [],
    });
  }

  await interaction.deferUpdate();

  // Permissions
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

  // Créer le salon directement avec le bon préfixe de type
  const channel = await guild.channels.create({
    name: `${typePrefix(type)}-${safeName}`,
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
    safeName,
    status: 'open',
    type,
    createdAt: Date.now(),
    claimData: {},
    staffNote: '',
  };
  saveTicket(ticketData);

  if (settings.notifChannelId) {
    const notifCh = guild.channels.cache.get(settings.notifChannelId);
    if (notifCh) notifCh.send(`📋 **Nouvelle réclamation** — <@${user.id}> (\`${user.username}\`) → <#${channel.id}>`).catch(() => {});
  }

  // Message de bienvenue dans le salon
  const welcomeAttachment = new AttachmentBuilder(RECLAIM_IMG, { name: 'reclamation.png' });
  await channel.send({
    content: `<@${user.id}>`,
    embeds: [buildWelcomeEmbed(ticketData, settings)],
    files: [welcomeAttachment],
  });

  // Lancer le flux du type directement dans le salon (channel.send)
  if (type === 'inventory')    await startInventoryReclaimToChannel(channel, ticketData);
  if (type === 'resurrection') await startResurrectionReclaimToChannel(channel, ticketData, settings);
  if (type === 'structures')   await startStructuresReclaimToChannel(channel, ticketData);
  if (type === 'autres')       await startAutresReclaimToChannel(channel, ticketData);

  await interaction.editReply({
    content: `✅ Ton ticket a été ouvert : <#${channel.id}>`,
    embeds: [], components: [], files: [],
  });
}

// ── Embed de bienvenue ────────────────────────────────────────────────────────
function buildWelcomeEmbed(ticketData, settings) {
  const msg = settings.welcomeMessage ||
    'Bienvenue {user} !\n\nDis-nous ce qui s\'est passé en sélectionnant le type de réclamation ci-dessous.\nL\'équipe staff traitera ta demande dès que possible.';

  return new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('📋 Nouveau ticket de réclamation')
    .setDescription(msg.replace(/\{user\}/g, `<@${ticketData.userId}>`))
    .setThumbnail('attachment://reclamation.png')
    .setFooter({ text: `Ticket ID : ${ticketData.ticketId}` })
    .setTimestamp();
}

// ── Select menu pré-ouverture (éphémère, affiché AVANT la création du salon) ──
function buildPreTypeSelectRow() {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${PREFIX}_pretype`)
    .setPlaceholder('📋 Choisir le type de réclamation...')
    .addOptions([
      {
        label: '🎒 Récupération inventaire',
        description: 'Récupérer un ou plusieurs items de ton inventaire',
        value: 'inventory',
      },
      {
        label: '💀 Résurrection de dino',
        description: 'Tu as l\'essence et veux faire appel à un Oasisaure',
        value: 'resurrection',
      },
      {
        label: '🧱 Structures abandonnées',
        description: 'Des constructions gênantes ou abandonnées ?',
        value: 'structures',
      },
      {
        label: '💬 Autres demandes',
        description: 'Explique nous tout !',
        value: 'autres',
      },
    ]);

  return new ActionRowBuilder().addComponents(select);
}

// ── Select menu dans le ticket (fallback pour anciens tickets) ────────────────
function buildTypeSelectRow(ticketId) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${PREFIX}_type_select::${ticketId}`)
    .setPlaceholder('📋 Choisir le type de réclamation...')
    .addOptions([
      {
        label: '🎒 Récupération inventaire',
        description: 'Récupérer un ou plusieurs items de ton inventaire',
        value: 'inventory',
      },
      {
        label: '💀 Résurrection de dino',
        description: 'Tu as l\'essence et veux faire appel à un Oasisaure',
        value: 'resurrection',
      },
      {
        label: '🧱 Structures abandonnées',
        description: 'Des constructions gênantes ou abandonnées ?',
        value: 'structures',
      },
      {
        label: '💬 Autres demandes',
        description: 'Explique nous tout !',
        value: 'autres',
      },
    ]);

  return new ActionRowBuilder().addComponents(select);
}

// ══════════════════════════════════════════════════════════════════════════════
// SÉLECTION DU TYPE → RENOMMAGE DU SALON
// ══════════════════════════════════════════════════════════════════════════════

async function handleTypeSelect(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  const type = interaction.values[0];
  data.type = type;
  saveTicket(data);

  // Renommer le salon avec le préfixe du type
  const newName = `${typePrefix(type)}-${data.safeName || data.username.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20)}`;
  try { await interaction.channel.edit({ name: newName }); } catch (e) {}

  try { await interaction.message.edit({ components: [] }); } catch (e) {}

  if (type === 'inventory')    return startInventoryReclaim(interaction, data);
  if (type === 'resurrection') return startResurrectionReclaim(interaction, data);
  if (type === 'structures')   return startStructuresReclaim(interaction, data);
  if (type === 'autres')       return startAutresReclaim(interaction, data);

  return interaction.reply({ content: '❌ Type inconnu.', ephemeral: true });
}

// ══════════════════════════════════════════════════════════════════════════════
// FLUX — RÉCUPÉRATION D'INVENTAIRE
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
        const isOcc = isOccasionnelCat(cat);
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
      `---\n✨ = Item **OCCASIONNEL** (une note te sera demandée)\n\n` +
      `**Utilise le menu ci-dessous** pour sélectionner l'item que tu souhaites récupérer.`
    );

  await interaction.reply({ embeds: [embed] });
  await buildInventoryItemSelectAndSend(interaction.channel, data);
}

function isOccasionnelCat(cat) {
  return (cat.id || '').toLowerCase().includes('occasionnel') ||
         (cat.name || '').toLowerCase().includes('occasionnel');
}

async function buildInventoryItemSelectAndSend(channel, data) {
  const itemTypes = getItemTypes();
  const categories = getCategories();
  const options = [];

  for (const cat of categories) {
    const catItems = itemTypes.filter(t => t.category === cat.id);
    for (const t of catItems) {
      if (options.length >= 25) break;
      const isOcc = isOccasionnelCat(cat);
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

async function handleInvItemLost(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  const [itemId, isOccStr] = interaction.values[0].split('::');
  const isOccasionnel = isOccStr === '1';
  const itemType = getItemTypes().find(t => t.id === itemId);

  data.claimData.lostItemId = itemId;
  data.claimData.lostItemName = itemType?.name || itemId;
  data.claimData.lostItemIsOccasionnel = isOccasionnel;
  saveTicket(data);

  try { await interaction.message.edit({ components: [] }); } catch (e) {}

  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(typeColor('inventory'))
      .setDescription(`✅ Item perdu sélectionné : **${itemType?.emoji || '📦'} ${data.claimData.lostItemName}**${isOccasionnel ? ' *(OCCASIONNEL)*' : ''}`)
    ],
  });

  await buildShopItemSelectAndSend(interaction.channel, data);
}

async function buildShopItemSelectAndSend(channel, data) {
  const shop = getShop();
  const dinos = getDinoData();
  const options = [];

  for (const dino of (dinos || [])) {
    if (options.length >= 20) break;
    if (dino.notAvailableShop) continue;
    options.push({
      label: `🦕 ${dino.name}`.slice(0, 100),
      description: (dino.location || 'Dino').slice(0, 100),
      value: `dino::${dino.id}`,
    });
  }

  for (const pack of (shop.packs || [])) {
    if (options.length >= 25) break;
    if (!pack.visible) continue;
    options.push({
      label: `📦 ${pack.name}`.slice(0, 100),
      description: (pack.description || 'Pack').slice(0, 100),
      value: `pack::${pack.id}`,
    });
  }

  if (options.length === 0) {
    return channel.send({ content: '❌ Aucun item en boutique configuré. Un admin te contactera.' });
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

async function handleInvShopItem(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  const [shopType, shopId] = interaction.values[0].split('::');
  data.claimData.shopItemId = shopId;
  data.claimData.shopItemType = shopType;

  let shopItemName = shopId;
  if (shopType === 'dino') {
    const dino = (getDinoData() || []).find(d => d.id === shopId);
    shopItemName = dino ? `🦕 ${dino.name}` : shopId;
  } else {
    const pack = (getShop().packs || []).find(p => p.id === shopId);
    shopItemName = pack ? `📦 ${pack.name}` : shopId;
  }

  data.claimData.shopItemName = shopItemName;
  saveTicket(data);

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

async function handleOccNote(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  data.claimData.occasionnelNote = interaction.fields.getTextInputValue('occ_note');
  saveTicket(data);

  await interaction.reply({
    embeds: [new EmbedBuilder().setColor(typeColor('inventory')).setDescription('✅ Note enregistrée.')],
  });

  await sendInventoryReclaimSummary(interaction.channel, data);
}

async function sendInventoryReclaimSummary(channel, data) {
  const embed = new EmbedBuilder()
    .setColor(typeColor('inventory'))
    .setTitle('🎒 Réclamation — Récupération d\'inventaire')
    .addFields(
      { name: '👤 Joueur',         value: `<@${data.userId}>`, inline: true },
      { name: '📦 Item perdu',     value: `${data.claimData.lostItemName}${data.claimData.lostItemIsOccasionnel ? ' ✨' : ''}`, inline: true },
      { name: '🛒 Item à livrer',  value: data.claimData.shopItemName || '?', inline: true },
    )
    .setTimestamp()
    .setFooter({ text: '⏳ En attente de traitement' });

  if (data.claimData.occasionnelNote) {
    embed.addFields({ name: '📝 Note (OCCASIONNEL)', value: data.claimData.occasionnelNote });
  }

  await channel.send({ embeds: [embed], components: [buildStaffActionsRow(data.ticketId)] });
}

// ══════════════════════════════════════════════════════════════════════════════
// FLUX — RÉSURRECTION DE DINO
// ══════════════════════════════════════════════════════════════════════════════

async function startResurrectionReclaim(interaction, data) {
  const settings = getReclaimSettings();
  const inv = getPlayerInventory(data.userId);
  const diamonds = inv['diamants'] || 0;
  const enough = diamonds >= 500;
  const block = settings.blockResurrectionIfInsufficient && !enough;

  const statusLine = enough
    ? '✅ Tu as suffisamment de diamants.'
    : `⚠️ Solde insuffisant — tu as **${diamonds.toLocaleString('fr-FR')} 💎** sur les **500 💎** nécessaires.`;

  const embed = new EmbedBuilder()
    .setColor(block ? 0x95a5a6 : typeColor('resurrection'))
    .setTitle('💀 Résurrection de dino')
    .setDescription(
      `**Coût :** 500 💎 prélevés depuis ton compte.\n\n` +
      `💎 Ton solde actuel : **${diamonds.toLocaleString('fr-FR')} 💎**\n${statusLine}` +
      (block
        ? '\n\n❌ **Tu ne peux pas ouvrir une demande de résurrection sans les 500 💎 nécessaires.**'
        : '\n\nLes 500 💎 seront prélevés automatiquement par le staff une fois ta demande acceptée.\n\nClique sur **Confirmer** pour renseigner les infos de ton dino.')
    );

  if (block) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${PREFIX}_close::${data.ticketId}`)
        .setLabel('🔒 Fermer ce ticket')
        .setStyle(ButtonStyle.Secondary),
    );
    await interaction.reply({ embeds: [embed], components: [row] });
    return;
  }

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

async function handleResurConfirm(interaction, ticketId) {
  const modal = new ModalBuilder()
    .setCustomId(`${PREFIX}_resur_modal::${ticketId}`)
    .setTitle('💀 Infos du dino à ressusciter');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('dino_name')
        .setLabel('Espèce du dino')
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
        .setLabel('Détails (carte, nom, circonstances...)')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setPlaceholder('Sur quelle map ? Quel nom de dino ? Comment il est mort ?')
        .setMaxLength(500)
    )
  );

  await interaction.showModal(modal);
}

async function handleResurModal(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  data.claimData.dinoName    = interaction.fields.getTextInputValue('dino_name');
  data.claimData.dinoLevel   = interaction.fields.getTextInputValue('dino_level') || 'Non précisé';
  data.claimData.dinoDetails = interaction.fields.getTextInputValue('dino_details') || '';
  saveTicket(data);

  await interaction.reply({
    embeds: [new EmbedBuilder().setColor(typeColor('resurrection')).setDescription('✅ Informations enregistrées.')],
  });

  await sendResurrectionSummary(interaction.channel, data);
}

async function sendResurrectionSummary(channel, data) {
  const inv = getPlayerInventory(data.userId);
  const diamonds = inv['diamants'] || 0;
  const enough = diamonds >= 500;

  const embed = new EmbedBuilder()
    .setColor(typeColor('resurrection'))
    .setTitle('💀 Réclamation — Résurrection de dino')
    .addFields(
      { name: '👤 Joueur',       value: `<@${data.userId}>`, inline: true },
      { name: '💎 Solde actuel', value: `${diamonds.toLocaleString('fr-FR')} 💎 ${enough ? '✅' : '⚠️'}`, inline: true },
      { name: '💸 Coût',        value: '500 💎', inline: true },
      { name: '🦕 Espèce',      value: data.claimData.dinoName || '?', inline: true },
      { name: '⭐ Niveau',       value: data.claimData.dinoLevel || 'Non précisé', inline: true },
    )
    .setTimestamp()
    .setFooter({ text: '⏳ En attente de traitement — prélèvement 500💎 via bouton staff' });

  if (data.claimData.dinoDetails) {
    embed.addFields({ name: '📝 Détails', value: data.claimData.dinoDetails });
  }

  if (!enough) {
    embed.addFields({ name: '⚠️ Attention', value: `Solde insuffisant : **${diamonds.toLocaleString('fr-FR')} 💎** disponibles sur 500 💎 requis.` });
  }

  const staffRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}_resur_deduct::${data.ticketId}`)
      .setLabel('💎 Prélever 500💎 et traiter')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}_mark_refused::${data.ticketId}`)
      .setLabel('❌ Refuser')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}_close::${data.ticketId}`)
      .setLabel('🔒 Fermer')
      .setStyle(ButtonStyle.Secondary),
  );

  await channel.send({ embeds: [embed], components: [staffRow] });
}

// ── Admin : prélever 500💎 et marquer traité ──────────────────────────────────
async function handleResurDeduct(interaction, ticketId) {
  if (!isStaff(interaction)) return interaction.reply({ content: '🚫 Réservé au staff.', ephemeral: true });

  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  const adminName = interaction.member?.displayName || interaction.user.username;
  const inv = getPlayerInventory(data.userId);
  const diamonds = inv['diamants'] || 0;

  try {
    if (diamonds >= 500) {
      await removeFromInventory(data.userId, 'diamants', 500, interaction.user.id, `Résurrection dino — Ticket ${ticketId}`);
      data.claimData.diamondsDeducted = 500;
      data.claimData.deductedBy = adminName;
      saveTicket(data);
      await sendInventoryLog(
        interaction.guild,
        `💀 **${adminName}** a prélevé **500 💎** du compte de <@${data.userId}> (\`${data.username}\`) — Résurrection dino \`${data.claimData.dinoName || '?'}\` — Ticket <#${data.channelId}>`
      );
    } else {
      data.claimData.deductedBy = adminName;
      data.claimData.diamondsDeducted = 0;
      data.claimData.deductionNote = `Solde insuffisant (${diamonds}💎) — prélèvement manuel nécessaire`;
      saveTicket(data);
      await sendInventoryLog(
        interaction.guild,
        `⚠️ **${adminName}** a tenté de prélever **500 💎** pour <@${data.userId}> (\`${data.username}\`) — solde insuffisant (**${diamonds} 💎**) — prélèvement manuel requis — Ticket <#${data.channelId}>`
      );
    }
  } catch (e) {
    return interaction.reply({ content: `❌ Erreur lors du prélèvement : ${e.message}`, ephemeral: true });
  }

  try { await interaction.message.edit({ components: [] }); } catch (e) {}

  const deductedOk = data.claimData.diamondsDeducted === 500;

  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(deductedOk ? 0x2ecc71 : 0xe67e22)
      .setTitle(deductedOk ? '✅ 500 💎 prélevés — Résurrection acceptée' : '⚠️ Prélèvement partiel')
      .setDescription(
        deductedOk
          ? `**${adminName}** a prélevé **500 💎** du compte de <@${data.userId}>.\n\nLa résurrection peut maintenant être effectuée en jeu.`
          : `Solde insuffisant (**${diamonds} 💎**). Aucun prélèvement automatique.\n\n**${adminName}** doit gérer le prélèvement manuellement.`
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
// FLUX — STRUCTURES ABANDONNÉES / GÊNANTES
// ══════════════════════════════════════════════════════════════════════════════

async function startStructuresReclaim(interaction, data) {
  const modal = new ModalBuilder()
    .setCustomId(`${PREFIX}_struct_modal::${data.ticketId}`)
    .setTitle('🏗️ Structures abandonnées / gênantes');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('struct_map')
        .setLabel('Sur quelle map ?')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('Ex : The Island, Ragnarok, Crystal Isles...')
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('struct_coords')
        .setLabel('Coordonnées (lat / lon)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('Ex : 45.2 / 67.8')
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('struct_notes')
        .setLabel('Informations complémentaires')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setPlaceholder('Décris le problème, la taille des structures, si c\'est abandonné depuis longtemps...')
        .setMaxLength(500)
    )
  );

  await interaction.showModal(modal);
}

// ══════════════════════════════════════════════════════════════════════════════
// FLUX DIRECTS VERS LE SALON (channel.send) — appelés par handlePreTypeSelect
// ══════════════════════════════════════════════════════════════════════════════

async function startInventoryReclaimToChannel(channel, data) {
  const inv        = getPlayerInventory(data.userId);
  const itemTypes  = getItemTypes();
  const categories = getCategories();
  const invLines   = [];
  let hasItems     = false;

  for (const cat of categories) {
    const catItems = itemTypes.filter(t => t.category === cat.id);
    const lines = [];
    for (const t of catItems) {
      const qty = inv[t.id] || 0;
      if (qty > 0) {
        const isOcc = isOccasionnelCat(cat);
        lines.push(`${t.emoji || '📦'} **${t.name}** × ${qty.toLocaleString('fr-FR')}${isOcc ? ' ✨' : ''}`);
        hasItems = true;
      }
    }
    if (lines.length > 0) invLines.push(`**${cat.emoji || ''} ${cat.name}**\n${lines.join('\n')}`);
  }

  const invDesc = hasItems ? invLines.join('\n\n') : '*Ton inventaire est vide ou aucun item enregistré.*';
  const embed = new EmbedBuilder()
    .setColor(typeColor('inventory'))
    .setTitle('🎒 Récupération d\'inventaire')
    .setDescription(
      `Voici ton inventaire actuel :\n\n${invDesc.slice(0, 3800)}\n\n` +
      `---\n✨ = Item **OCCASIONNEL** (une note te sera demandée)\n\n` +
      `**Utilise le menu ci-dessous** pour sélectionner l'item que tu souhaites récupérer.`
    );

  await channel.send({ embeds: [embed] });
  await buildInventoryItemSelectAndSend(channel, data);
}

async function startResurrectionReclaimToChannel(channel, data, settings) {
  const inv     = getPlayerInventory(data.userId);
  const diamonds = inv['diamants'] || 0;
  const enough  = diamonds >= 500;
  const block   = settings.blockResurrectionIfInsufficient && !enough;

  const statusLine = enough
    ? '✅ Tu as suffisamment de diamants.'
    : `⚠️ Solde insuffisant — tu as **${diamonds.toLocaleString('fr-FR')} 💎** sur les **500 💎** nécessaires.`;

  const embed = new EmbedBuilder()
    .setColor(block ? 0x95a5a6 : typeColor('resurrection'))
    .setTitle('💀 Résurrection de dino')
    .setDescription(
      `**Coût :** 500 💎 prélevés depuis ton compte.\n\n` +
      `💎 Ton solde actuel : **${diamonds.toLocaleString('fr-FR')} 💎**\n${statusLine}` +
      (block
        ? '\n\n❌ **Tu ne peux pas ouvrir une demande de résurrection sans les 500 💎 nécessaires.**'
        : '\n\nLes 500 💎 seront prélevés automatiquement par le staff une fois ta demande acceptée.\n\nClique sur **Confirmer** pour renseigner les infos de ton dino.')
    );

  if (block) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${PREFIX}_close::${data.ticketId}`)
        .setLabel('🔒 Fermer ce ticket')
        .setStyle(ButtonStyle.Secondary)
    );
    await channel.send({ embeds: [embed], components: [row] });
    return;
  }

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
  await channel.send({ embeds: [embed], components: [row] });
}

async function startStructuresReclaimToChannel(channel, data) {
  const embed = new EmbedBuilder()
    .setColor(typeColor('structures'))
    .setTitle('🧱 Structures abandonnées / gênantes')
    .setDescription(
      'Merci de nous renseigner les informations nécessaires.\n\n' +
      'Clique sur le bouton ci-dessous pour ouvrir le formulaire.'
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}_struct_form::${data.ticketId}`)
      .setLabel('📝 Ouvrir le formulaire')
      .setStyle(ButtonStyle.Primary),
  );
  await channel.send({ embeds: [embed], components: [row] });
}

async function startAutresReclaimToChannel(channel, data) {
  const embed = new EmbedBuilder()
    .setColor(typeColor('autres'))
    .setTitle('💬 Autres demandes')
    .setDescription(
      'Merci de décrire ta demande.\n\n' +
      'Clique sur le bouton ci-dessous pour ouvrir le formulaire.'
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}_autres_form::${data.ticketId}`)
      .setLabel('📝 Décrire ma demande')
      .setStyle(ButtonStyle.Primary),
  );
  await channel.send({ embeds: [embed], components: [row] });
}

// ── Boutons formulaire (ouvrent le modal depuis l'intérieur du salon) ─────────
async function handleStructFormBtn(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });
  try { await interaction.message.edit({ components: [] }); } catch (e) {}
  await startStructuresReclaim(interaction, data);
}

async function handleAutresFormBtn(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });
  try { await interaction.message.edit({ components: [] }); } catch (e) {}
  await startAutresReclaim(interaction, data);
}

async function handleStructModal(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  data.claimData.structMap    = interaction.fields.getTextInputValue('struct_map');
  data.claimData.structCoords = interaction.fields.getTextInputValue('struct_coords');
  data.claimData.structNotes  = interaction.fields.getTextInputValue('struct_notes') || '';
  saveTicket(data);

  const embed = new EmbedBuilder()
    .setColor(typeColor('structures'))
    .setTitle('🧱 Réclamation — Structures abandonnées / gênantes')
    .addFields(
      { name: '👤 Joueur',       value: `<@${data.userId}>`, inline: true },
      { name: '🗺️ Map',          value: data.claimData.structMap, inline: true },
      { name: '📍 Coordonnées',  value: data.claimData.structCoords, inline: true },
    )
    .setTimestamp()
    .setFooter({ text: '⏳ En attente de vérification par le staff' });

  if (data.claimData.structNotes) {
    embed.addFields({ name: '📝 Notes', value: data.claimData.structNotes });
  }

  await interaction.reply({
    embeds: [embed],
    components: [buildStaffActionsRow(data.ticketId)],
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// FLUX — AUTRES DEMANDES
// ══════════════════════════════════════════════════════════════════════════════

async function startAutresReclaim(interaction, data) {
  const modal = new ModalBuilder()
    .setCustomId(`${PREFIX}_autres_modal::${data.ticketId}`)
    .setTitle('💬 Autres demandes');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('autres_text')
        .setLabel('Décris ta demande')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setPlaceholder('Explique ici ta situation, ta demande ou ton problème...')
        .setMaxLength(1000)
    )
  );

  await interaction.showModal(modal);
}

async function handleAutresModal(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  data.claimData.autresText = interaction.fields.getTextInputValue('autres_text');
  saveTicket(data);

  const embed = new EmbedBuilder()
    .setColor(typeColor('autres'))
    .setTitle('💬 Réclamation — Autres demandes')
    .addFields(
      { name: '👤 Joueur',  value: `<@${data.userId}>`, inline: true },
      { name: '📝 Demande', value: data.claimData.autresText },
    )
    .setTimestamp()
    .setFooter({ text: '⏳ En attente de réponse du staff' });

  await interaction.reply({
    embeds: [embed],
    components: [buildStaffActionsRow(data.ticketId)],
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// BOUTONS STAFF COMMUNS
// ══════════════════════════════════════════════════════════════════════════════

function buildStaffActionsRow(ticketId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}_mark_done::${ticketId}`)
      .setLabel('✅ Réclamation traitée')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}_mark_refused::${ticketId}`)
      .setLabel('❌ Refuser')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}_close::${ticketId}`)
      .setLabel('🔒 Fermer le ticket')
      .setStyle(ButtonStyle.Secondary),
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// ACTIONS STAFF — TRAITÉ / REFUSÉ
// ══════════════════════════════════════════════════════════════════════════════

async function handleMarkDone(interaction, ticketId) {
  if (!isStaff(interaction)) return interaction.reply({ content: '🚫 Réservé au staff.', ephemeral: true });

  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  const adminName = interaction.member?.displayName || interaction.user.username;
  data.status = 'done';
  data.claimData.resolvedBy = adminName;
  saveTicket(data);

  try { await interaction.message.edit({ components: [] }); } catch (e) {}

  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('✅ Réclamation traitée')
      .setDescription(`La réclamation de <@${data.userId}> a été **traitée** par **${adminName}**.\n\nLe ticket peut maintenant être fermé.`)
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

  if (data) {
    data.status = 'refused';
    data.claimData.refusedBy = adminName;
    data.claimData.refuseReason = reason;
    saveTicket(data);
  }

  try { await interaction.message.edit({ components: [] }); } catch (e) {}

  await interaction.reply({
    content: `<@${data?.userId || ''}>`,
    embeds: [new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle('❌ Réclamation refusée')
      .setDescription(
        `Ta réclamation a été **refusée** par **${adminName}**.\n\n**Motif :** ${reason}\n\n*Pour toute question, contacte directement le staff.*`
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
// FERMETURE — 2 ÉTAPES
// ══════════════════════════════════════════════════════════════════════════════

async function handleClose(interaction, ticketId) {
  if (!isStaff(interaction)) return interaction.reply({ content: '🚫 Réservé au staff.', ephemeral: true });

  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0xe67e22)
      .setTitle('⚠️ Fermer ce ticket ?')
      .setDescription('Le joueur n\'aura plus accès à ce salon.\nVous pourrez ensuite ajouter une note ou supprimer le ticket.')
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

  // Retirer l'accès du joueur
  if (userId) {
    try { await interaction.channel.permissionOverwrites.edit(userId, { ViewChannel: false, SendMessages: false }); } catch (e) {}
  }

  // Renommer avec préfixe "ferme-"
  const currentName = interaction.channel.name;
  const closedName = `ferme-${currentName}`.slice(0, 100);
  try { await interaction.channel.edit({ name: closedName, reason: `Ticket fermé par ${adminName}` }); } catch (e) {}

  if (data) {
    if (data.status === 'open') data.status = 'closed';
    data.claimData.closedBy = adminName;
    data.claimData.closedAt = Date.now();
    saveTicket(data);
  }

  try {
    await interaction.update({
      embeds: [new EmbedBuilder()
        .setColor(0x95a5a6)
        .setTitle('🔒 Ticket fermé')
        .setDescription(`Fermé par **${adminName}**. Le joueur ne peut plus voir ce salon.`)
      ],
      components: [],
    });
  } catch (e) {}

  // Message dans le ticket avec boutons Supprimer + Ajouter note
  await interaction.channel.send({
    embeds: [new EmbedBuilder()
      .setColor(0x95a5a6)
      .setTitle('🔒 Ticket fermé')
      .setDescription(
        `Ce ticket a été fermé par **${adminName}**.\n\n` +
        `Le joueur n'a plus accès à ce salon.\n\n` +
        `Vous pouvez **ajouter une note staff** ou **supprimer le ticket** directement.`
      )
      .setTimestamp()
    ],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${PREFIX}_add_note::${ticketId}`)
        .setLabel('📝 Ajouter une note')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`${PREFIX}_delete::${ticketId}`)
        .setLabel('🗑️ Supprimer le ticket')
        .setStyle(ButtonStyle.Danger),
    )],
  }).catch(() => {});
}

// ══════════════════════════════════════════════════════════════════════════════
// NOTE STAFF
// ══════════════════════════════════════════════════════════════════════════════

async function handleAddNote(interaction, ticketId) {
  if (!isStaff(interaction)) return interaction.reply({ content: '🚫 Réservé au staff.', ephemeral: true });

  const modal = new ModalBuilder()
    .setCustomId(`${PREFIX}_note_modal::${ticketId}`)
    .setTitle('📝 Note staff');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('note_text')
        .setLabel('Note interne (affichée dans le compte-rendu)')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setPlaceholder('Ex : Structure supprimée le 06/05 — Dino ressuscité correctement...')
        .setMaxLength(500)
    )
  );

  return interaction.showModal(modal);
}

async function handleNoteModal(interaction, ticketId) {
  if (!isStaff(interaction)) return interaction.reply({ content: '🚫 Réservé au staff.', ephemeral: true });

  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  const adminName = interaction.member?.displayName || interaction.user.username;
  const noteText  = interaction.fields.getTextInputValue('note_text');

  data.staffNote = noteText;
  data.claimData.noteBy = adminName;
  saveTicket(data);

  try { await interaction.message.edit({ components: [] }); } catch (e) {}

  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle('📝 Note enregistrée')
      .setDescription(`**Note de ${adminName} :**\n${noteText}`)
      .setTimestamp()
    ],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${PREFIX}_delete::${ticketId}`)
        .setLabel('🗑️ Supprimer le ticket')
        .setStyle(ButtonStyle.Danger),
    )],
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// SUPPRESSION + COMPTE-RENDU LOG
// ══════════════════════════════════════════════════════════════════════════════

async function handleDelete(interaction, ticketId) {
  if (!isStaff(interaction)) return interaction.reply({ content: '🚫 Réservé au staff.', ephemeral: true });

  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  const adminName = interaction.member?.displayName || interaction.user.username;

  // Envoyer le compte-rendu dans le salon log avant suppression
  try {
    await sendLogRecap(interaction.guild, data, adminName);
  } catch (e) {
    console.error('[ReclaimTicket] Erreur envoi log:', e.message);
  }

  try {
    await interaction.update({
      embeds: [new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle('🗑️ Suppression dans 3 secondes…')
        .setDescription('Le compte-rendu a été envoyé dans le salon admin.')
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

// ── Compte-rendu dans le salon log ───────────────────────────────────────────
async function sendLogRecap(guild, data, deletedBy) {
  const settings = getReclaimSettings();
  const logChannelId = settings.logChannelId;
  if (!logChannelId) return;

  const logCh = guild.channels.cache.get(logChannelId);
  if (!logCh) return;

  const type = data?.type;
  const cd   = data?.claimData || {};

  const embed = new EmbedBuilder()
    .setColor(type ? typeColor(type) : 0x9b59b6)
    .setTitle(`📋 Compte-rendu — ${typeLabel(type)}`)
    .addFields(
      { name: '👤 Joueur',       value: `<@${data?.userId}> (\`${data?.username}\`)`, inline: true },
      { name: '📁 Statut final', value: data?.status === 'done' ? '✅ Traité' : data?.status === 'refused' ? '❌ Refusé' : '🔒 Fermé', inline: true },
      { name: '🗑️ Supprimé par', value: deletedBy, inline: true },
    )
    .setTimestamp();

  // Champs spécifiques au type
  if (type === 'inventory') {
    embed.addFields(
      { name: '📦 Item perdu',    value: `${cd.lostItemName || '?'}${cd.lostItemIsOccasionnel ? ' ✨' : ''}`, inline: true },
      { name: '🛒 Item à livrer', value: cd.shopItemName || '?', inline: true },
    );
    if (cd.occasionnelNote) embed.addFields({ name: '📝 Note OCCASIONNEL', value: cd.occasionnelNote });
  }

  if (type === 'resurrection') {
    embed.addFields(
      { name: '🦕 Espèce', value: cd.dinoName || '?', inline: true },
      { name: '⭐ Niveau', value: cd.dinoLevel || '?', inline: true },
      { name: '💎 Prélèvement', value: cd.diamondsDeducted === 500 ? `✅ 500💎 prélevés par ${cd.deductedBy}` : (cd.deductionNote || '⚠️ Non prélevé automatiquement'), inline: false },
    );
    if (cd.dinoDetails) embed.addFields({ name: '📝 Détails', value: cd.dinoDetails });
  }

  if (type === 'structures') {
    embed.addFields(
      { name: '🗺️ Map',         value: cd.structMap || '?', inline: true },
      { name: '📍 Coordonnées', value: cd.structCoords || '?', inline: true },
    );
    if (cd.structNotes) embed.addFields({ name: '📝 Notes', value: cd.structNotes });
  }

  if (type === 'autres') {
    embed.addFields({ name: '📝 Demande', value: cd.autresText || '?' });
  }

  // Actions staff
  const actions = [];
  if (cd.resolvedBy)  actions.push(`✅ Traité par **${cd.resolvedBy}**`);
  if (cd.refusedBy)   actions.push(`❌ Refusé par **${cd.refusedBy}** — ${cd.refuseReason || ''}`);
  if (cd.closedBy)    actions.push(`🔒 Fermé par **${cd.closedBy}**`);
  if (actions.length) embed.addFields({ name: '👮 Actions staff', value: actions.join('\n') });

  // Note staff
  if (data?.staffNote) {
    embed.addFields({ name: `📝 Note staff${cd.noteBy ? ` (${cd.noteBy})` : ''}`, value: data.staffNote });
  }

  const openedAt = data?.createdAt ? new Date(data.createdAt).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }) : '?';
  embed.setFooter({ text: `Ticket ${data?.ticketId} • Ouvert le ${openedAt}` });
  embed.setThumbnail('attachment://reclamation.png');

  const recapAttachment = new AttachmentBuilder(RECLAIM_IMG, { name: 'reclamation.png' });
  await logCh.send({ embeds: [embed], files: [recapAttachment] });
}

// ══════════════════════════════════════════════════════════════════════════════
// COMMANDE SLASH
// ══════════════════════════════════════════════════════════════════════════════

async function handleReclaimCommand(interaction) {
  if (interaction.commandName !== 'reclamation-panel') return;
  return publishReclaimPanel(interaction);
}

// ══════════════════════════════════════════════════════════════════════════════
// DISPATCHER PRINCIPAL
// ══════════════════════════════════════════════════════════════════════════════

async function handleReclaimTicketInteraction(interaction) {
  const id = interaction.customId;
  if (!id || !id.startsWith(`${PREFIX}_`)) return;

  const isBtn    = interaction.isButton();
  const isSelect = interaction.isStringSelectMenu();
  const isModal  = interaction.isModalSubmit();

  // ── Panneau : ouverture ───────────────────────────────────────────────────
  if (isBtn && id === `${PREFIX}_open`) return handleOpenReclaim(interaction);

  // ── Select type AVANT ouverture (éphémère) ────────────────────────────────
  if (isSelect && id === `${PREFIX}_pretype`) return handlePreTypeSelect(interaction);

  // ── Select type dans le ticket (fallback anciens tickets) ─────────────────
  if (isSelect && id.startsWith(`${PREFIX}_type_select::`)) {
    return handleTypeSelect(interaction, id.split('::')[1]);
  }

  // ── Formulaires structures / autres (bouton → modal depuis le salon) ──────
  if (isBtn && id.startsWith(`${PREFIX}_struct_form::`)) {
    return handleStructFormBtn(interaction, id.split('::')[1]);
  }
  if (isBtn && id.startsWith(`${PREFIX}_autres_form::`)) {
    return handleAutresFormBtn(interaction, id.split('::')[1]);
  }

  // ── Inventaire : item perdu ───────────────────────────────────────────────
  if (isSelect && id.startsWith(`${PREFIX}_inv_item_lost::`)) {
    return handleInvItemLost(interaction, id.split('::')[1]);
  }

  // ── Inventaire : item shop ────────────────────────────────────────────────
  if (isSelect && id.startsWith(`${PREFIX}_inv_shop_item::`)) {
    return handleInvShopItem(interaction, id.split('::')[1]);
  }

  // ── Inventaire : note OCCASIONNEL ─────────────────────────────────────────
  if (isModal && id.startsWith(`${PREFIX}_inv_occ_note::`)) {
    return handleOccNote(interaction, id.split('::')[1]);
  }

  // ── Résurrection : confirmation ───────────────────────────────────────────
  if (isBtn && id.startsWith(`${PREFIX}_resur_confirm::`)) {
    return handleResurConfirm(interaction, id.split('::')[1]);
  }

  // ── Résurrection : modal infos ────────────────────────────────────────────
  if (isModal && id.startsWith(`${PREFIX}_resur_modal::`)) {
    return handleResurModal(interaction, id.split('::')[1]);
  }

  // ── Résurrection : prélèvement admin ─────────────────────────────────────
  if (isBtn && id.startsWith(`${PREFIX}_resur_deduct::`)) {
    return handleResurDeduct(interaction, id.split('::')[1]);
  }

  // ── Structures : modal ────────────────────────────────────────────────────
  if (isModal && id.startsWith(`${PREFIX}_struct_modal::`)) {
    return handleStructModal(interaction, id.split('::')[1]);
  }

  // ── Autres : modal ────────────────────────────────────────────────────────
  if (isModal && id.startsWith(`${PREFIX}_autres_modal::`)) {
    return handleAutresModal(interaction, id.split('::')[1]);
  }

  // ── Staff : traité ────────────────────────────────────────────────────────
  if (isBtn && id.startsWith(`${PREFIX}_mark_done::`)) {
    return handleMarkDone(interaction, id.split('::')[1]);
  }

  // ── Staff : refus + modal ─────────────────────────────────────────────────
  if (isBtn && id.startsWith(`${PREFIX}_mark_refused::`)) {
    return handleMarkRefused(interaction, id.split('::')[1]);
  }

  if (isModal && id.startsWith(`${PREFIX}_refuse_reason::`)) {
    return handleRefuseReason(interaction, id.split('::')[1]);
  }

  // ── Fermeture ─────────────────────────────────────────────────────────────
  if (isBtn && id.startsWith(`${PREFIX}_close::`)) {
    return handleClose(interaction, id.split('::')[1]);
  }

  if (isBtn && id.startsWith(`${PREFIX}_close_confirm::`)) {
    return handleCloseConfirm(interaction, id.split('::')[1]);
  }

  if (isBtn && id.startsWith(`${PREFIX}_close_cancel::`)) {
    return interaction.update({ components: [] });
  }

  // ── Note staff ────────────────────────────────────────────────────────────
  if (isBtn && id.startsWith(`${PREFIX}_add_note::`)) {
    return handleAddNote(interaction, id.split('::')[1]);
  }

  if (isModal && id.startsWith(`${PREFIX}_note_modal::`)) {
    return handleNoteModal(interaction, id.split('::')[1]);
  }

  // ── Suppression ───────────────────────────────────────────────────────────
  if (isBtn && id.startsWith(`${PREFIX}_delete::`)) {
    return handleDelete(interaction, id.split('::')[1]);
  }
}

module.exports = {
  handleReclaimCommand,
  handleReclaimTicketInteraction,
  initReclaimTickets,
  publishReclaimPanel,
};
