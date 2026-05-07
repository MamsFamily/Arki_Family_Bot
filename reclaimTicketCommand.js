'use strict';

/**
 * reclaimTicketCommand.js — Système de ticket Réclamation (v2)
 *
 * Types :
 *   inventory    → Récupération d'inventaire (panier + navigation dino/pack/note)
 *   resurrection → Résurrection de dino (500💎 staff, texte libre joueur)
 *   structures   → Structures abandonnées/gênantes (formulaire AVANT création du salon)
 *   autres       → Autres demandes (texte libre, pas de formulaire)
 *
 * Nouveautés v2 :
 *   - Structures : modal ouvert AVANT création du salon (depuis le select éphémère)
 *   - Résurrection : pas de formulaire, texte libre + bouton staff « Confirmer la réa »
 *   - Autres : pas de formulaire, texte libre, ping joueur
 *   - Bouton Fermer cliquable par le joueur (avec avertissement si panier en cours)
 *   - Navigation dino/pack dans le panier inventaire (comme le shop)
 *   - Note modale pour schémas, imprinting, traits génétiques
 *   - « Liste terminée » → « Commande livrée → Valider retrait » (staff)
 *   - Pas de bouton « Refuser » sauf pour l'ancien flux (compat)
 */

const {
  EmbedBuilder, AttachmentBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelType, PermissionFlagsBits,
} = require('discord.js');

const path = require('path');
const RECLAIM_IMG = path.join(__dirname, 'web/public/img/reclamation.png');

const { getSettings }      = require('./settingsManager');
const {
  getPlayerInventory, getItemTypes, getCategories, removeFromInventory,
} = require('./inventoryManager');
const { getShop }    = require('./shopManager');
const { getDinoData } = require('./dinoManager');
const pgStore         = require('./pgStore');

const PREFIX = 'rcl';

const STATS = ['Vie', 'Énergie', 'Nourriture', 'Poids', 'Oxygène', 'Attaque'];
const STAT_EMOJIS = {
  Vie: '❤️', Énergie: '⚡', Nourriture: '🍖',
  Poids: '⚖️', Oxygène: '💨', Attaque: '⚔️',
};

// ══════════════════════════════════════════════════════════════════════════════
// INIT & PERSISTENCE
// ══════════════════════════════════════════════════════════════════════════════

const activeReclaimTickets = new Map();

async function initReclaimTickets(client) {
  try {
    const rows = await pgStore.loadAllOpenReclaimTickets();
    let loaded = 0;
    for (const data of rows) {
      if (client) {
        const ch = client.channels.cache.get(data.channelId);
        if (!ch) { await pgStore.deleteReclaimTicket(data.ticketId); continue; }
      }
      activeReclaimTickets.set(data.ticketId, data);
      loaded++;
    }
    if (loaded > 0) console.log(`✅ [ReclaimTicket] ${loaded} ticket(s) rechargé(s)`);
  } catch (err) {
    console.error('[ReclaimTicket] Erreur chargement DB:', err.message);
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
  } catch (e) { console.error('[ReclaimTicket] Erreur rechargement:', e.message); }
  return null;
}

function saveTicket(data) {
  activeReclaimTickets.set(data.ticketId, data);
  pgStore.saveReclaimTicket(data).catch(() => {});
}

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function getReclaimSettings() { return getSettings().reclaimTicket || {}; }

async function sendInventoryLog(guild, message) {
  try {
    const settings = getSettings();
    const shop = getShop();
    const id = settings.guild?.inventoryLogChannelId || shop.shopTicketChannelId;
    if (!id) return;
    const ch = await guild.channels.fetch(id).catch(() => null);
    if (ch) await ch.send(message);
  } catch (e) { console.error('[ReclaimTicket] Erreur log inv:', e.message); }
}

function isStaff(interaction) {
  const s = getReclaimSettings();
  const ids = s.staffRoleIds || [];
  if (!ids.length) return interaction.member?.permissions?.has('ManageChannels') ?? false;
  return interaction.member?.roles?.cache?.some(r => ids.includes(r.id)) ?? false;
}

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function typeColor(type) {
  if (type === 'inventory')    return 0x3498db;
  if (type === 'resurrection') return 0xe74c3c;
  if (type === 'structures')   return 0xe67e22;
  if (type === 'autres')       return 0x95a5a6;
  return 0x9b59b6;
}
function typePrefix(type) {
  return { inventory: 'inventaire', resurrection: 'resurrection', structures: 'structures', autres: 'autres' }[type] || 'recl';
}
function typeLabel(type) {
  return {
    inventory:    '🎒 Récupération d\'inventaire',
    resurrection: '💀 Résurrection de dino',
    structures:   '🧱 Structures abandonnées/gênantes',
    autres:       '💬 Autres demandes',
  }[type] || '📋 Réclamation';
}

// Retire les emojis Discord custom (animés ou non) d'une chaîne
function stripCustomEmoji(str) { return (str || '').replace(/<a?:\w+:\d+>/g, '').trim(); }

// Emoji sûr pour un option de select menu
function menuEmoji(raw, fallback = '') {
  if (!raw) return fallback;
  if (/^<a?:\w+:\d+>$/.test(raw.trim())) return fallback;
  return raw;
}

// Détermine le comportement de navigation selon le type d'item inventaire
function getItemBehavior(itemType) {
  if (!itemType) return 'direct';
  const id  = (itemType.id       || '').toLowerCase();
  const cat = (itemType.category || '').toLowerCase();
  const nm  = (itemType.name     || '').toLowerCase();
  if (id.includes('epaule'))                                              return 'dino-shoulder';
  if (cat === 'dino')                                                     return 'dino-regular';
  if (cat === 'pack' || id.includes('pack'))                             return 'pack';
  if (nm.includes('schéma') || nm.includes('schema') || id.includes('schema')) return 'note-schema';
  if (nm.includes('imprint') || id.includes('imprint'))                  return 'note-imprint';
  if (nm.includes('trait génétique') || nm.includes('trait')|| id.includes('trait')) return 'note-trait';
  return 'direct';
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
      '*Un ticket ouvert avec un petit coucou est toujours plus accueillant pour le staff et donne davantage envie de le traiter rapidement 🙃*\n\n' +
      '*Clique sur le bouton ci-dessous pour ouvrir ton ticket.*'
    );

  const btn = new ButtonBuilder()
    .setCustomId(`${PREFIX}_open`)
    .setLabel(settings.buttonLabel || '📋 Ouvrir une réclamation')
    .setStyle(ButtonStyle.Primary);

  const sendOpts = { embeds: [embed], components: [new ActionRowBuilder().addComponents(btn)] };
  if (settings.panelImageUrl) {
    embed.setImage(settings.panelImageUrl);
  } else {
    const att = new AttachmentBuilder(RECLAIM_IMG, { name: 'reclamation.png' });
    embed.setImage('attachment://reclamation.png');
    sendOpts.files = [att];
  }

  await interaction.channel.send(sendOpts);
  return interaction.reply({ content: '✅ Panneau de réclamation publié !', ephemeral: true });
}

// ══════════════════════════════════════════════════════════════════════════════
// OUVERTURE DU TICKET
// ══════════════════════════════════════════════════════════════════════════════

async function handleOpenReclaim(interaction) {
  const guild   = interaction.guild;
  const user    = interaction.user;
  const safeName = user.username.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 20);

  const existing = guild.channels.cache.find(ch => {
    if (ch.type !== ChannelType.GuildText) return false;
    return ['inventaire-', 'resurrection-', 'structures-', 'autres-'].some(p => ch.name === `${p}${safeName}`);
  });
  if (existing) {
    return interaction.reply({ content: `📋 Tu as déjà un ticket ouvert : <#${existing.id}>`, ephemeral: true });
  }

  const preEmbed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('📋 Quel type de réclamation ?')
    .setDescription('**Sélectionne le type de ta demande** dans le menu ci-dessous.\n\nUn salon privé sera créé automatiquement.')
    .setThumbnail('attachment://reclamation.png');

  const preAtt = new AttachmentBuilder(RECLAIM_IMG, { name: 'reclamation.png' });
  return interaction.reply({ embeds: [preEmbed], components: [buildPreTypeSelectRow()], files: [preAtt], ephemeral: true });
}

// ══════════════════════════════════════════════════════════════════════════════
// SELECT TYPE (éphémère, avant création du salon)
// ══════════════════════════════════════════════════════════════════════════════

async function handlePreTypeSelect(interaction) {
  const type     = interaction.values[0];
  const user     = interaction.user;
  const guild    = interaction.guild;
  const settings = getReclaimSettings();
  const safeName = user.username.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 20);

  // Ticket déjà ouvert ?
  const existing = guild.channels.cache.find(ch => {
    if (ch.type !== ChannelType.GuildText) return false;
    return ['inventaire-', 'resurrection-', 'structures-', 'autres-'].some(p => ch.name === `${p}${safeName}`);
  });
  if (existing) {
    return interaction.update({ content: `📋 Tu as déjà un ticket ouvert : <#${existing.id}>`, embeds: [], components: [], files: [] });
  }

  // Pour les structures : afficher le formulaire AVANT de créer le salon
  if (type === 'structures') {
    return showStructuresPreModal(interaction);
  }

  await interaction.deferUpdate();
  const channel = await createReclaimChannel(guild, user, safeName, type, settings);
  const ticketData = await makeTicketData(channel.id, user, safeName, type);
  saveTicket(ticketData);
  notifyStaff(guild, settings, user, channel);

  // Message de bienvenue
  const att = new AttachmentBuilder(RECLAIM_IMG, { name: 'reclamation.png' });
  await channel.send({ content: `<@${user.id}>`, embeds: [buildWelcomeEmbed(ticketData, settings)], files: [att] });

  if (type === 'inventory')    await startInventoryReclaimToChannel(channel, ticketData);
  if (type === 'resurrection') await startResurrectionReclaimToChannel(channel, ticketData, settings);
  if (type === 'autres')       await startAutresReclaimToChannel(channel, ticketData);

  await interaction.editReply({ content: `✅ Ton ticket a été ouvert : <#${channel.id}>`, embeds: [], components: [], files: [] });
}

async function createReclaimChannel(guild, user, safeName, type, settings) {
  const perms = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: user.id,
      allow: [
        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles,
      ],
    },
  ];
  for (const roleId of (settings.staffRoleIds || [])) {
    if (guild.roles.cache.has(roleId)) {
      perms.push({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] });
    }
  }
  return guild.channels.create({
    name: `${typePrefix(type)}-${safeName}`,
    type: ChannelType.GuildText,
    parent: settings.categoryId || null,
    permissionOverwrites: perms,
  });
}

function makeTicketData(channelId, user, safeName, type) {
  return {
    ticketId:  genId(),
    channelId,
    userId:    user.id,
    username:  user.displayName || user.username,
    safeName,
    status:    'open',
    type,
    createdAt: Date.now(),
    claimData: {},
    staffNote: '',
  };
}

function notifyStaff(guild, settings, user, channel) {
  if (!settings.notifChannelId) return;
  const ch = guild.channels.cache.get(settings.notifChannelId);
  if (ch) ch.send(`📋 **Nouvelle réclamation** — <@${user.id}> (\`${user.username}\`) → <#${channel.id}>`).catch(() => {});
}

// ══════════════════════════════════════════════════════════════════════════════
// STRUCTURES — FORMULAIRE AVANT CRÉATION DU SALON
// ══════════════════════════════════════════════════════════════════════════════

async function showStructuresPreModal(interaction) {
  const modal = new ModalBuilder()
    .setCustomId(`${PREFIX}_struct_pretypemodal`)
    .setTitle('🧱 Structures abandonnées / gênantes');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('struct_map').setLabel('Sur quelle map ?')
        .setStyle(TextInputStyle.Short).setRequired(true)
        .setPlaceholder('Ex : The Island, Ragnarok, Crystal Isles…')
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('struct_coords').setLabel('Coordonnées (lat / lon)')
        .setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Ex : 45.2 / 67.8')
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('struct_notes').setLabel('Informations complémentaires')
        .setStyle(TextInputStyle.Paragraph).setRequired(false)
        .setPlaceholder('Décris le problème, la taille des structures, si c\'est abandonné…').setMaxLength(500)
    )
  );
  await interaction.showModal(modal);
}

async function handleStructPreTypeModal(interaction) {
  const user     = interaction.user;
  const guild    = interaction.guild;
  const settings = getReclaimSettings();
  const safeName = user.username.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 20);

  // Vérif ticket existant
  const existing = guild.channels.cache.find(ch => {
    if (ch.type !== ChannelType.GuildText) return false;
    return ['inventaire-', 'resurrection-', 'structures-', 'autres-'].some(p => ch.name === `${p}${safeName}`);
  });
  if (existing) {
    return interaction.reply({ content: `📋 Tu as déjà un ticket ouvert : <#${existing.id}>`, ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  const structMap    = interaction.fields.getTextInputValue('struct_map');
  const structCoords = interaction.fields.getTextInputValue('struct_coords');
  const structNotes  = interaction.fields.getTextInputValue('struct_notes') || '';

  const channel    = await createReclaimChannel(guild, user, safeName, 'structures', settings);
  const ticketData = makeTicketData(channel.id, user, safeName, 'structures');
  ticketData.claimData.structMap    = structMap;
  ticketData.claimData.structCoords = structCoords;
  ticketData.claimData.structNotes  = structNotes;
  ticketData.status = 'pending';
  saveTicket(ticketData);
  notifyStaff(guild, settings, user, channel);

  // Bienvenue
  const att = new AttachmentBuilder(RECLAIM_IMG, { name: 'reclamation.png' });
  await channel.send({ content: `<@${user.id}>`, embeds: [buildWelcomeEmbed(ticketData, settings)], files: [att] });

  // Résumé avec boutons staff
  const embed = new EmbedBuilder()
    .setColor(typeColor('structures'))
    .setTitle('🧱 Réclamation — Structures abandonnées / gênantes')
    .addFields(
      { name: '👤 Joueur',       value: `<@${ticketData.userId}>`, inline: true },
      { name: '🗺️ Map',          value: structMap,                 inline: true },
      { name: '📍 Coordonnées',  value: structCoords,              inline: true },
    )
    .setTimestamp()
    .setFooter({ text: '⏳ En attente de vérification par le staff' });
  if (structNotes) embed.addFields({ name: '📝 Notes', value: structNotes });

  await channel.send({ embeds: [embed], components: [buildStaffActionsRow(ticketData.ticketId, 'structures')] });
  await interaction.editReply({ content: `✅ Ton ticket a été ouvert : <#${channel.id}>` });
}

// ══════════════════════════════════════════════════════════════════════════════
// WELCOME EMBED (personnalisé par type)
// ══════════════════════════════════════════════════════════════════════════════

function buildWelcomeEmbed(ticketData, settings) {
  const type = ticketData.type;
  let desc;
  if (type === 'inventory') {
    desc = 'Sélectionne ci-dessous les éléments de ton inventaire que tu souhaites récupérer.';
  } else if (type === 'resurrection') {
    desc = 'Note-nous un petit bonjour et des détails si tu le souhaites juste en dessous. Un membre du staff reviendra vers toi dès que possible pour te donner rendez-vous !';
  } else if (type === 'structures') {
    desc = 'Voici le récapitulatif des informations renseignées. Un staff traitera ta demande dès que possible.';
  } else if (type === 'autres') {
    desc = 'Décris ta demande librement juste en dessous. Un membre du staff reviendra vers toi dès que possible.';
  } else {
    desc = settings.welcomeMessage
      ? settings.welcomeMessage.replace(/\{user\}/g, `<@${ticketData.userId}>`)
      : 'Bienvenue ! L\'équipe staff traitera ta demande dès que possible.';
  }

  return new EmbedBuilder()
    .setColor(typeColor(type))
    .setTitle('📋 Nouveau ticket de réclamation')
    .setDescription(desc)
    .setThumbnail('attachment://reclamation.png')
    .setFooter({ text: `Ticket ID : ${ticketData.ticketId}` })
    .setTimestamp();
}

// ── Select menu pré-ouverture ─────────────────────────────────────────────────
function buildPreTypeSelectRow() {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${PREFIX}_pretype`)
    .setPlaceholder('📋 Choisir le type de réclamation...')
    .addOptions([
      { label: '🎒 Récupération inventaire',    description: 'Récupérer un ou plusieurs items de ton inventaire', value: 'inventory' },
      { label: '💀 Résurrection de dino',        description: 'Tu as l\'essence et veux faire appel à un Oasisaure', value: 'resurrection' },
      { label: '🧱 Structures abandonnées',     description: 'Des constructions gênantes ou abandonnées ?',        value: 'structures' },
      { label: '💬 Autres demandes',            description: 'Explique nous tout !',                               value: 'autres' },
    ]);
  return new ActionRowBuilder().addComponents(select);
}

// ══════════════════════════════════════════════════════════════════════════════
// SELECT TYPE (fallback — anciens tickets avec select dans le salon)
// ══════════════════════════════════════════════════════════════════════════════

async function handleTypeSelect(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  const type = interaction.values[0];
  data.type = type;
  saveTicket(data);

  const newName = `${typePrefix(type)}-${data.safeName || data.username.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20)}`;
  try { await interaction.channel.edit({ name: newName }); } catch (e) {}
  try { await interaction.message.edit({ components: [] }); } catch (e) {}

  const settings = getReclaimSettings();
  if (type === 'inventory')    return startInventoryReclaim(interaction, data);
  if (type === 'resurrection') return startResurrectionReclaim(interaction, data, settings);
  if (type === 'structures')   return startStructuresReclaim(interaction, data);
  if (type === 'autres')       return startAutresReclaim(interaction, data);
  return interaction.reply({ content: '❌ Type inconnu.', ephemeral: true });
}

// ══════════════════════════════════════════════════════════════════════════════
// FLUX — RÉCLAMATION INVENTAIRE — prefix rcl_ic_
// ══════════════════════════════════════════════════════════════════════════════

function isOccasionnelCat(cat) {
  return (cat.id || '').toLowerCase().includes('occasionnel') ||
         (cat.name || '').toLowerCase().includes('occasionnel');
}

function getAvailableStock(userId, cart) {
  const inv      = getPlayerInventory(userId);
  const reserved = {};
  for (const e of (cart || [])) reserved[e.itemId] = (reserved[e.itemId] || 0) + e.qty;
  const result = {};
  for (const [id, qty] of Object.entries(inv)) result[id] = Math.max(0, qty - (reserved[id] || 0));
  return result;
}

// ── Embed principal du panier ─────────────────────────────────────────────────
function buildInvCartEmbed(data) {
  const inv       = getPlayerInventory(data.userId);
  const cart      = data.claimData.invCart || [];
  const itemTypes = getItemTypes();
  const cats      = getCategories();
  const avail     = getAvailableStock(data.userId, cart);

  const stockLines = [];
  for (const cat of cats) {
    const catItems = itemTypes.filter(t => t.category === cat.id && (inv[t.id] || 0) > 0);
    if (!catItems.length) continue;
    const lines = catItems.map(t => {
      const total    = inv[t.id] || 0;
      const av       = avail[t.id] ?? total;
      const reserved = total - av;
      if (reserved > 0) return `${t.emoji || '📦'} **${t.name}** : ~~${total}~~ → **${av} disponible** *(${reserved} dans le panier)*`;
      return `${t.emoji || '📦'} **${t.name}** × ${total}`;
    });
    stockLines.push(`**${menuEmoji(cat.emoji, '📦')} ${cat.name}**\n${lines.join('\n')}`);
  }

  const cartLines = cart.map(e => {
    let line = `• **${e.itemName}** × ${e.qty}`;
    if (e.details && e.details.length > 0) {
      line += '\n' + e.details.map(d => {
        const v = d.variant && d.variant !== 'base' ? ` (${d.variant})` : '';
        if (d.isCouple) return `  > ${d.dinoName}${v} — Couple ♀ ${d.femaleStat} / ♂ ${d.maleStat}`;
        return `  > ${d.dinoName}${v} — ${d.sex} — ${d.stat}`;
      }).join('\n');
    }
    if (e.packName) line += `\n  > ${e.packName}`;
    if (e.note)     line += `\n  > 💬 ${e.note.slice(0, 80)}`;
    return line;
  });

  let desc = '';
  if (stockLines.length > 0) {
    desc += `📦 **Ton stock :**\n${stockLines.join('\n\n')}\n\n`;
  } else {
    desc += '❌ *Ton inventaire est vide — aucun item à réclamer.*\n\n';
  }
  if (cart.length > 0) {
    desc += `🛒 **Panier :**\n${cartLines.join('\n')}\n\n`;
    desc += `*${cart.reduce((s, e) => s + e.qty, 0)} article(s) — ${cart.length} type(s)*`;
  } else {
    desc += '🛒 **Panier vide** — utilise ➕ pour ajouter des articles.';
  }

  return new EmbedBuilder()
    .setColor(typeColor('inventory'))
    .setTitle('🎒 Réclamation Inventaire')
    .setDescription(desc.slice(0, 4096))
    .setFooter({ text: `Ticket ${data.ticketId}` })
    .setTimestamp();
}

// ── Boutons du panier ─────────────────────────────────────────────────────────
function buildInvCartRows(ticketId, cart) {
  const hasCart = cart && cart.length > 0;
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`rcl_ic_add::${ticketId}`).setLabel('➕ Ajouter un article').setStyle(ButtonStyle.Primary),
  );
  if (hasCart) {
    row1.addComponents(
      new ButtonBuilder().setCustomId(`rcl_ic_rmv_sel::${ticketId}`).setLabel('🗑️ Retirer').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`rcl_ic_done::${ticketId}`).setLabel('✅ Liste terminée').setStyle(ButtonStyle.Success),
    );
  }
  return [
    row1,
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}_close::${ticketId}`).setLabel('🔒 Annuler / Fermer').setStyle(ButtonStyle.Danger),
    ),
  ];
}

// ── Lancer le panier dans le salon ───────────────────────────────────────────
async function startInventoryReclaimToChannel(channel, data) {
  await startInvCartFlow(channel, data);
}

async function startInvCartFlow(channel, data) {
  const inv       = getPlayerInventory(data.userId);
  const itemTypes = getItemTypes();
  const hasInv    = itemTypes.some(t => (inv[t.id] || 0) > 0);

  if (!hasInv) {
    await channel.send({
      embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle('🎒 Inventaire vide')
        .setDescription('Ton inventaire ne contient aucun item à réclamer.\n\nContacte un admin si tu penses que c\'est une erreur.')
        .setFooter({ text: `Ticket ${data.ticketId}` })],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${PREFIX}_close::${data.ticketId}`).setLabel('🔒 Fermer le ticket').setStyle(ButtonStyle.Secondary),
      )],
    });
    return;
  }

  if (!data.claimData.invCart) data.claimData.invCart = [];
  saveTicket(data);

  await channel.send({ embeds: [buildInvCartEmbed(data)], components: buildInvCartRows(data.ticketId, data.claimData.invCart) });
}

// Fallback (anciens tickets)
async function startInventoryReclaim(interaction, data) {
  try { await interaction.message?.edit({ components: [] }); } catch (e) {}
  await interaction.reply({ embeds: [new EmbedBuilder().setColor(typeColor('inventory')).setDescription('🎒 Chargement du panier…')], ephemeral: true });
  await startInvCartFlow(interaction.channel, data);
}

// ── ➕ Ajouter : catégorie ────────────────────────────────────────────────────
async function handleInvAddBtn(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  const avail     = getAvailableStock(data.userId, data.claimData.invCart || []);
  const itemTypes = getItemTypes();
  const cats      = getCategories();

  const catsWithItems = cats.filter(cat => itemTypes.some(t => t.category === cat.id && (avail[t.id] || 0) > 0));
  if (!catsWithItems.length) return interaction.reply({ content: '❌ Plus aucun article disponible.', ephemeral: true });

  const select = new StringSelectMenuBuilder()
    .setCustomId(`rcl_ic_cat::${ticketId}`)
    .setPlaceholder('Dans quelle catégorie ?')
    .addOptions(catsWithItems.slice(0, 25).map(cat => {
      const isDinoCat = (cat.id || '').toLowerCase() === 'dino' || (cat.name || '').toLowerCase().includes('dino');
      const em = isDinoCat ? '🦖' : menuEmoji(cat.emoji, '📦');
      return { label: `${em} ${cat.name}`.trim().slice(0, 100), value: cat.id };
    }));

  await interaction.update({
    embeds: [buildInvCartEmbed(data)],
    components: [
      new ActionRowBuilder().addComponents(select),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`rcl_ic_back::${ticketId}`).setLabel('↩️ Retour').setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

// ── Catégorie sélectionnée ────────────────────────────────────────────────────
async function handleInvCatSelect(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  const catId  = interaction.values[0];
  const avail  = getAvailableStock(data.userId, data.claimData.invCart || []);
  const items  = getItemTypes().filter(t => t.category === catId && (avail[t.id] || 0) > 0);
  if (!items.length) return interaction.reply({ content: '❌ Plus aucun article dans cette catégorie.', ephemeral: true });

  const select = new StringSelectMenuBuilder()
    .setCustomId(`rcl_ic_item::${ticketId}::${catId}`)
    .setPlaceholder('Quel article réclamer ?')
    .addOptions(items.slice(0, 25).map(t => ({
      label: `${menuEmoji(t.emoji, '📦')} ${t.name}`.trim().slice(0, 100),
      description: `Dispo : ${avail[t.id] || 0}`,
      value: t.id,
    })));

  await interaction.update({
    embeds: [buildInvCartEmbed(data)],
    components: [
      new ActionRowBuilder().addComponents(select),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`rcl_ic_back::${ticketId}`).setLabel('↩️ Retour').setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

// ── Item sélectionné : quantité ───────────────────────────────────────────────
async function handleInvItemSelect(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  const itemId   = interaction.values[0];
  const avail    = getAvailableStock(data.userId, data.claimData.invCart || []);
  const av       = avail[itemId] || 0;
  const itemType = getItemTypes().find(t => t.id === itemId);
  if (av <= 0) return interaction.reply({ content: '❌ Aucun stock disponible.', ephemeral: true });

  const maxQty = Math.min(av, 25);
  const select = new StringSelectMenuBuilder()
    .setCustomId(`rcl_ic_qty::${ticketId}`)
    .setPlaceholder(`Quantité à réclamer (dispo : ${av})`)
    .addOptions(Array.from({ length: maxQty }, (_, i) => ({
      label: `${i + 1}`,
      description: `${i + 1}× ${itemType?.name || itemId}`,
      value: `${itemId}::${i + 1}`,
    })));

  await interaction.update({
    embeds: [buildInvCartEmbed(data)],
    components: [
      new ActionRowBuilder().addComponents(select),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`rcl_ic_back::${ticketId}`).setLabel('↩️ Retour').setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

// ── Quantité sélectionnée : brancher selon le type d'item ────────────────────
async function handleInvQtySelect(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  const [itemId, qtyStr] = interaction.values[0].split('::');
  const qty      = parseInt(qtyStr, 10);
  const itemType = getItemTypes().find(t => t.id === itemId);

  if (!data.claimData.invCart) data.claimData.invCart = [];
  const avail = getAvailableStock(data.userId, data.claimData.invCart);
  if ((avail[itemId] || 0) < qty) return interaction.reply({ content: '❌ Stock insuffisant.', ephemeral: true });

  const behavior = getItemBehavior(itemType);

  if (behavior === 'dino-shoulder' || behavior === 'dino-regular') {
    return startDinoNav(interaction, ticketId, itemId, qty, itemType, behavior);
  }
  if (behavior === 'pack') {
    return startPackNav(interaction, ticketId, itemId, qty, itemType);
  }
  if (behavior === 'note-schema' || behavior === 'note-imprint' || behavior === 'note-trait') {
    return showItemNoteModal(interaction, ticketId, itemId, qty, itemType, behavior);
  }

  // Direct : ajouter au panier
  const existing = data.claimData.invCart.find(e => e.itemId === itemId);
  if (existing) existing.qty += qty;
  else data.claimData.invCart.push({ itemId, itemName: itemType?.name || itemId, emoji: menuEmoji(itemType?.emoji, '📦'), qty });
  saveTicket(data);

  await interaction.update({ embeds: [buildInvCartEmbed(data)], components: buildInvCartRows(ticketId, data.claimData.invCart) });
}

// ══════════════════════════════════════════════════════════════════════════════
// NAVIGATION DINO DANS LE PANIER
// ══════════════════════════════════════════════════════════════════════════════

async function startDinoNav(interaction, ticketId, itemId, totalSlots, itemType, behavior) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return;

  data.claimData.invSelState = {
    itemTypeId: itemId, itemTypeName: itemType?.name || itemId,
    emoji: menuEmoji(itemType?.emoji, '📦'), behavior, totalSlots,
    usedSlots: 0, pendingItems: [],
    currentDinoId: null, currentDinoName: null,
    currentCoupleInventaire: false, currentVariant: 'base',
    currentPairType: null, currentSex: null, currentMaleStat: null,
  };
  saveTicket(data);

  await showDinoLetterSelect(interaction, data);
}

function getNavDinos(behavior) {
  const data = getDinoData();
  const all  = data?.dinos || [];
  if (behavior === 'dino-shoulder') return all.filter(d => d.isShoulder && !d.notAvailableShop);
  return all.filter(d => !d.isShoulder && !d.notAvailableShop);
}

async function showDinoLetterSelect(interaction, data) {
  const state   = data.claimData.invSelState;
  const dinos   = getNavDinos(state.behavior);
  const remaining = state.totalSlots - state.usedSlots;
  const progressLine = state.pendingItems.length > 0
    ? `*${state.pendingItems.length} dino(s) ajouté(s) — ${remaining} slot(s) restant(s)*\n\n`
    : '';

  const embed = new EmbedBuilder()
    .setColor(typeColor('inventory'))
    .setTitle(`🦕 ${state.itemTypeName} — ${state.usedSlots + 1}/${state.totalSlots}`)
    .setDescription(`${progressLine}Choisis la première lettre du dino :`);

  // Si peu de dinos, montrer directement la liste
  if (dinos.length <= 25) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`rcl_ic_dn_dino::${data.ticketId}::ALL`)
      .setPlaceholder('Choisir un dino…')
      .addOptions(dinos.slice(0, 25).map(d => ({ label: d.name.trim().slice(0, 100), value: d.id })));
    return interaction.update({ embeds: [embed], components: [
      new ActionRowBuilder().addComponents(select),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`rcl_ic_dn_cancel::${data.ticketId}`).setLabel('↩️ Annuler → retour panier').setStyle(ButtonStyle.Secondary),
      ),
    ]});
  }

  const letters = [...new Set(dinos.map(d => d.name.trim()[0].toUpperCase()))].sort();
  const select = new StringSelectMenuBuilder()
    .setCustomId(`rcl_ic_dn_letter::${data.ticketId}`)
    .setPlaceholder('Choisir une lettre…')
    .addOptions(letters.slice(0, 25).map(l => ({ label: `Lettre ${l}`, value: l, emoji: '🔤' })));

  await interaction.update({ embeds: [embed], components: [
    new ActionRowBuilder().addComponents(select),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`rcl_ic_dn_cancel::${data.ticketId}`).setLabel('↩️ Annuler → retour panier').setStyle(ButtonStyle.Secondary),
    ),
  ]});
}

async function handleDinoLetter(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  const letter = interaction.values[0];
  const state  = data.claimData.invSelState;
  const dinos  = getNavDinos(state.behavior).filter(d => d.name.trim()[0].toUpperCase() === letter);

  if (!dinos.length) return interaction.reply({ content: '❌ Aucun dino disponible pour cette lettre.', ephemeral: true });

  const select = new StringSelectMenuBuilder()
    .setCustomId(`rcl_ic_dn_dino::${ticketId}::${letter}`)
    .setPlaceholder('Choisir un dino…')
    .addOptions(dinos.slice(0, 25).map(d => ({
      label: d.name.trim().slice(0, 100),
      description: d.coupleInventaire ? '💑 1 slot = couple M+F' : undefined,
      value: d.id,
    })));

  const embed = new EmbedBuilder()
    .setColor(typeColor('inventory'))
    .setTitle(`🦕 ${state.itemTypeName} — Lettre ${letter}`)
    .setDescription('Sélectionne un dino :');

  const backSelect = new StringSelectMenuBuilder()
    .setCustomId(`rcl_ic_dn_letter::${ticketId}`)
    .setPlaceholder('← Changer de lettre…')
    .addOptions([...new Set(getNavDinos(state.behavior).map(d => d.name.trim()[0].toUpperCase()))].sort().slice(0, 25)
      .map(l => ({ label: `Lettre ${l}`, value: l, emoji: '🔤' })));

  await interaction.update({ embeds: [embed], components: [
    new ActionRowBuilder().addComponents(backSelect),
    new ActionRowBuilder().addComponents(select),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`rcl_ic_dn_cancel::${ticketId}`).setLabel('↩️ Annuler').setStyle(ButtonStyle.Secondary),
    ),
  ]});
}

async function handleDinoPick(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  const dinoId = interaction.values[0];
  const allDinos = getDinoData()?.dinos || [];
  const dino     = allDinos.find(d => d.id === dinoId);
  if (!dino) return interaction.reply({ content: '❌ Dino introuvable.', ephemeral: true });

  const state = data.claimData.invSelState;
  state.currentDinoId   = dino.id;
  state.currentDinoName = dino.name.trim();
  state.currentCoupleInventaire = !!dino.coupleInventaire;
  state.currentVariant  = 'base';

  // Variantes ?
  const visibleVariants = (dino.variants || []).filter(v => !v.hidden && !v.notAvailableShop);
  if (visibleVariants.length > 0) {
    state.currentVariant = null; // à choisir
    saveTicket(data);
    return showDinoVariantSelect(interaction, data, dino, visibleVariants);
  }

  saveTicket(data);
  await showDinoSexSelect(interaction, data, dino);
}

async function showDinoVariantSelect(interaction, data, dino, visibleVariants) {
  const state = data.claimData.invSelState;
  const options = [
    { label: `${dino.name.trim()} (standard)`, value: 'base' },
    ...visibleVariants.map(v => ({ label: `${dino.name.trim()} — ${v.label}`, value: v.label })),
  ];
  const select = new StringSelectMenuBuilder()
    .setCustomId(`rcl_ic_dn_variant::${data.ticketId}`)
    .setPlaceholder('Choisir la variante…')
    .addOptions(options.slice(0, 25));

  await interaction.update({ embeds: [new EmbedBuilder().setColor(typeColor('inventory'))
    .setTitle(`🦕 ${dino.name.trim()} — Variante`)
    .setDescription('Choisis la variante souhaitée :')],
    components: [
      new ActionRowBuilder().addComponents(select),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`rcl_ic_dn_cancel::${data.ticketId}`).setLabel('↩️ Annuler').setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

async function handleDinoVariant(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  const state = data.claimData.invSelState;
  state.currentVariant = interaction.values[0];
  saveTicket(data);

  const allDinos = getDinoData()?.dinos || [];
  const dino     = allDinos.find(d => d.id === state.currentDinoId);
  await showDinoSexSelect(interaction, data, dino);
}

async function showDinoSexSelect(interaction, data, dino) {
  const state   = data.claimData.invSelState;
  const remaining = state.totalSlots - state.usedSlots;
  const ci        = state.currentCoupleInventaire;

  // Pour un dino coupleInventaire, 1 slot = couple → offrir M, F, Couple (quel que soit le remaining)
  // Pour les autres, couple si remaining >= 2
  const offerCouple = ci || remaining >= 2;
  const sexOptions  = [
    { label: '♂️ Mâle',    value: 'Mâle',   emoji: '♂️' },
    { label: '♀️ Femelle', value: 'Femelle', emoji: '♀️' },
  ];
  if (offerCouple) sexOptions.push({ label: '💑 Couple (M+F)', value: 'Couple', emoji: '💑' });

  const select = new StringSelectMenuBuilder()
    .setCustomId(`rcl_ic_dn_sex::${data.ticketId}`)
    .setPlaceholder('Sexe / arrangement…')
    .addOptions(sexOptions);

  const variantTxt = state.currentVariant && state.currentVariant !== 'base' ? ` (${state.currentVariant})` : '';
  const embed = new EmbedBuilder()
    .setColor(typeColor('inventory'))
    .setTitle(`🦕 ${state.currentDinoName}${variantTxt}`)
    .setDescription(`**${state.usedSlots + 1}/${state.totalSlots}** — Choisis le sexe :`);

  await interaction.update({ embeds: [embed], components: [
    new ActionRowBuilder().addComponents(select),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`rcl_ic_dn_cancel::${data.ticketId}`).setLabel('↩️ Annuler').setStyle(ButtonStyle.Secondary),
    ),
  ]});
}

async function handleDinoSex(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  const sex   = interaction.values[0];
  const state = data.claimData.invSelState;
  state.currentSex = sex;
  saveTicket(data);

  if (sex === 'Couple') {
    state.currentPairType = 'couple';
    saveTicket(data);
    return showDinoStatSelect(interaction, data, 'couple-male');
  }

  state.currentPairType = 'single';
  saveTicket(data);
  return showDinoStatSelect(interaction, data, 'single');
}

async function showDinoStatSelect(interaction, data, context) {
  const state   = data.claimData.invSelState;
  const varTxt  = state.currentVariant && state.currentVariant !== 'base' ? ` (${state.currentVariant})` : '';

  let placeholder, customId, titleSuffix;
  if (context === 'single') {
    placeholder  = `Stat forte — ${state.currentSex}…`;
    customId     = `rcl_ic_dn_stat::${data.ticketId}`;
    titleSuffix  = state.currentSex;
  } else if (context === 'couple-male') {
    placeholder  = 'Stat forte — ♂️ Mâle…';
    customId     = `rcl_ic_dn_mstat::${data.ticketId}`;
    titleSuffix  = '♂️ Mâle';
  } else {
    placeholder  = 'Stat forte — ♀️ Femelle…';
    customId     = `rcl_ic_dn_fstat::${data.ticketId}`;
    titleSuffix  = '♀️ Femelle';
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .addOptions(STATS.map(s => ({ label: `${STAT_EMOJIS[s] || ''} ${s}`, value: s })));

  const embed = new EmbedBuilder()
    .setColor(typeColor('inventory'))
    .setTitle(`🦕 ${state.currentDinoName}${varTxt}`)
    .setDescription(`Stat forte souhaitée — **${titleSuffix}** :`);

  await interaction.update({ embeds: [embed], components: [
    new ActionRowBuilder().addComponents(select),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`rcl_ic_dn_cancel::${data.ticketId}`).setLabel('↩️ Annuler').setStyle(ButtonStyle.Secondary),
    ),
  ]});
}

async function handleDinoStat(interaction, ticketId) {
  const data  = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data)  return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });
  const state = data.claimData.invSelState;
  const stat  = interaction.values[0];

  state.pendingItems.push({
    dinoId:   state.currentDinoId,
    dinoName: state.currentDinoName,
    variant:  state.currentVariant,
    isCouple: false,
    sex:      state.currentSex,
    stat,
  });
  state.usedSlots += 1;
  saveTicket(data);
  await finalizeDinoStep(interaction, data);
}

async function handleDinoMaleStat(interaction, ticketId) {
  const data  = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data)  return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });
  const state = data.claimData.invSelState;
  state.currentMaleStat = interaction.values[0];
  saveTicket(data);
  await showDinoStatSelect(interaction, data, 'couple-female');
}

async function handleDinoFemaleStat(interaction, ticketId) {
  const data  = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data)  return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });
  const state = data.claimData.invSelState;
  const fstat = interaction.values[0];
  const ci    = state.currentCoupleInventaire;

  state.pendingItems.push({
    dinoId:    state.currentDinoId,
    dinoName:  state.currentDinoName,
    variant:   state.currentVariant,
    isCouple:  true,
    sex:       'Couple',
    maleStat:  state.currentMaleStat,
    femaleStat: fstat,
  });
  // coupleInventaire = 1 slot = couple ; sinon couple = 2 slots
  state.usedSlots += ci ? 1 : 2;
  saveTicket(data);
  await finalizeDinoStep(interaction, data);
}

async function finalizeDinoStep(interaction, data) {
  const state = data.claimData.invSelState;

  if (state.usedSlots >= state.totalSlots) {
    // Tout sélectionné → ajouter au panier
    if (!data.claimData.invCart) data.claimData.invCart = [];
    data.claimData.invCart.push({
      itemId:   state.itemTypeId,
      itemName: state.itemTypeName,
      emoji:    state.emoji,
      qty:      state.totalSlots,
      details:  state.pendingItems,
    });
    delete data.claimData.invSelState;
    saveTicket(data);
    await interaction.update({ embeds: [buildInvCartEmbed(data)], components: buildInvCartRows(data.ticketId, data.claimData.invCart) });
  } else {
    // Continuer avec le prochain dino
    saveTicket(data);
    await showDinoLetterSelect(interaction, data);
  }
}

async function handleDinoNavCancel(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });
  delete data.claimData.invSelState;
  saveTicket(data);
  await interaction.update({ embeds: [buildInvCartEmbed(data)], components: buildInvCartRows(ticketId, data.claimData.invCart || []) });
}

// ══════════════════════════════════════════════════════════════════════════════
// NAVIGATION PACK DANS LE PANIER
// ══════════════════════════════════════════════════════════════════════════════

async function startPackNav(interaction, ticketId, itemId, qty, itemType) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return;

  const shop  = getShop();
  const packs = (shop.packs || []).filter(p => p.donationAvailable && p.visible !== false);

  if (!packs.length) {
    return interaction.update({ embeds: [buildInvCartEmbed(data)], components: buildInvCartRows(ticketId, data.claimData.invCart || []) });
  }

  data.claimData.invSelPack = { itemTypeId: itemId, itemTypeName: itemType?.name || itemId, emoji: menuEmoji(itemType?.emoji, '📦'), qty };
  saveTicket(data);

  const select = new StringSelectMenuBuilder()
    .setCustomId(`rcl_ic_pk_pick::${ticketId}`)
    .setPlaceholder('Quel pack veux-tu récupérer ?')
    .addOptions(packs.slice(0, 25).map(p => ({
      label: `📦 ${p.name}`.slice(0, 100),
      description: (p.description || '').slice(0, 100) || undefined,
      value: p.id,
    })));

  const embed = new EmbedBuilder()
    .setColor(typeColor('inventory'))
    .setTitle(`📦 ${itemType?.name || 'Pack'} — Choix du pack`)
    .setDescription('Sélectionne le pack souhaité *(compatibles inventaire/dona uniquement)* :');

  await interaction.update({ embeds: [embed], components: [
    new ActionRowBuilder().addComponents(select),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`rcl_ic_back::${ticketId}`).setLabel('↩️ Annuler').setStyle(ButtonStyle.Secondary),
    ),
  ]});
}

async function handlePackPick(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  const packId  = interaction.values[0];
  const shop    = getShop();
  const pack    = (shop.packs || []).find(p => p.id === packId);
  const sel     = data.claimData.invSelPack || {};

  if (!data.claimData.invCart) data.claimData.invCart = [];
  data.claimData.invCart.push({
    itemId:   sel.itemTypeId,
    itemName: sel.itemTypeName,
    emoji:    sel.emoji,
    qty:      sel.qty,
    packId,
    packName: pack?.name || packId,
  });
  delete data.claimData.invSelPack;
  saveTicket(data);

  await interaction.update({ embeds: [buildInvCartEmbed(data)], components: buildInvCartRows(ticketId, data.claimData.invCart) });
}

// ══════════════════════════════════════════════════════════════════════════════
// NOTE MODALE (schémas, imprinting, traits génétiques)
// ══════════════════════════════════════════════════════════════════════════════

async function showItemNoteModal(interaction, ticketId, itemId, qty, itemType, behavior) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  data.claimData.invSelNote = { itemTypeId: itemId, itemTypeName: itemType?.name || itemId, emoji: menuEmoji(itemType?.emoji, '📦'), qty };
  saveTicket(data);

  let title, placeholder;
  if (behavior === 'note-schema') {
    title       = '📐 Quel schéma souhaites-tu récupérer ?';
    placeholder = 'Ex : Schéma Saddle Rex niveau 80+, Schéma Forge…';
  } else if (behavior === 'note-imprint') {
    title       = '🧬 Détails de l\'imprinting';
    placeholder = 'Espèce du dino, niveau, date d\'imprint souhaité…';
  } else {
    title       = '🧬 Trait génétique souhaité';
    placeholder = 'Espèce du dino, quel trait génétique, toute info utile…';
  }

  const modal = new ModalBuilder()
    .setCustomId(`rcl_ic_note::${ticketId}`)
    .setTitle(title);
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('note_text').setLabel('Note')
        .setStyle(TextInputStyle.Paragraph).setRequired(true)
        .setPlaceholder(placeholder).setMaxLength(500)
    )
  );
  await interaction.showModal(modal);
}

async function handleItemNoteModal(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  const note = interaction.fields.getTextInputValue('note_text');
  const sel  = data.claimData.invSelNote || {};

  if (!data.claimData.invCart) data.claimData.invCart = [];
  data.claimData.invCart.push({
    itemId:   sel.itemTypeId,
    itemName: sel.itemTypeName,
    emoji:    sel.emoji,
    qty:      sel.qty,
    note,
  });
  delete data.claimData.invSelNote;
  saveTicket(data);

  await interaction.reply({
    embeds: [new EmbedBuilder().setColor(typeColor('inventory')).setDescription('✅ Noté ! Article ajouté au panier.')],
    ephemeral: true,
  });

  // Éditer le message du panier
  try {
    const ch  = interaction.channel;
    const msgs = await ch.messages.fetch({ limit: 10 });
    const cartMsg = msgs.find(m => m.author.id === interaction.client.user.id && m.components.length > 0 && m.embeds.some(e => e.title?.includes('Réclamation Inventaire')));
    if (cartMsg) await cartMsg.edit({ embeds: [buildInvCartEmbed(data)], components: buildInvCartRows(ticketId, data.claimData.invCart) });
  } catch (e) {}
}

// ── Retour panier ─────────────────────────────────────────────────────────────
async function handleInvBackBtn(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });
  delete data.claimData.invSelState;
  delete data.claimData.invSelPack;
  delete data.claimData.invSelNote;
  saveTicket(data);
  await interaction.update({ embeds: [buildInvCartEmbed(data)], components: buildInvCartRows(ticketId, data.claimData.invCart || []) });
}

// ── 🗑️ Retirer ────────────────────────────────────────────────────────────────
async function handleInvRmvSelBtn(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  const cart = data.claimData.invCart || [];
  if (!cart.length) return interaction.reply({ content: '🛒 Le panier est vide.', ephemeral: true });

  const select = new StringSelectMenuBuilder()
    .setCustomId(`rcl_ic_remove::${ticketId}`)
    .setPlaceholder('Quel article retirer ?')
    .addOptions(cart.map(e => ({
      label: `${menuEmoji(e.emoji, '📦')} ${e.itemName} × ${e.qty}`.slice(0, 100),
      description: 'Supprimer entièrement du panier',
      value: e.itemId,
    })));

  await interaction.update({ embeds: [buildInvCartEmbed(data)], components: [
    new ActionRowBuilder().addComponents(select),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`rcl_ic_back::${ticketId}`).setLabel('↩️ Retour').setStyle(ButtonStyle.Secondary),
    ),
  ]});
}

async function handleInvRemoveSelect(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  const itemId = interaction.values[0];
  data.claimData.invCart = (data.claimData.invCart || []).filter(e => e.itemId !== itemId);
  saveTicket(data);
  await interaction.update({ embeds: [buildInvCartEmbed(data)], components: buildInvCartRows(ticketId, data.claimData.invCart) });
}

// ── ✅ Liste terminée ─────────────────────────────────────────────────────────
async function handleInvDoneBtn(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  const cart = data.claimData.invCart || [];
  if (!cart.length) return interaction.reply({ content: '🛒 Le panier est vide.', ephemeral: true });

  // Vérification stock final
  const inv    = getPlayerInventory(data.userId);
  const issues = cart.filter(e => (inv[e.itemId] || 0) < e.qty);
  if (issues.length) {
    return interaction.reply({
      content: `❌ Stock insuffisant pour : ${issues.map(e => `**${e.itemName}**`).join(', ')}. Retire ces articles.`,
      ephemeral: true,
    });
  }

  data.status = 'pending';
  saveTicket(data);
  try { await interaction.message.edit({ components: [] }); } catch (e) {}

  await sendInvCartSummary(interaction, data);
}

function buildInvCartSummaryLines(cart) {
  return cart.map(e => {
    if (e.details && e.details.length > 0) {
      const dinoLines = e.details.map(d => {
        const v = d.variant && d.variant !== 'base' ? ` (${d.variant})` : '';
        if (d.isCouple) return `• ${d.dinoName}${v}\n  ◦ Couple - ♀ ${d.femaleStat} / ♂ ${d.maleStat}`;
        return `• ${d.dinoName}${v}\n  ◦ ${d.sex} - ${d.stat}`;
      }).join('\n');
      return `**${e.itemName} × ${e.qty} :**\n${dinoLines}`;
    }
    if (e.packName) return `**${e.itemName} × ${e.qty} :**\n• ${e.packName}`;
    if (e.note)     return `**${e.itemName} × ${e.qty} :**\n💬 ${e.note.slice(0, 200)}`;
    return `**${e.itemName} × ${e.qty}**`;
  }).join('\n\n');
}

async function sendInvCartSummary(interaction, data) {
  const cart    = data.claimData.invCart || [];
  const total   = cart.reduce((s, e) => s + e.qty, 0);
  const summary = buildInvCartSummaryLines(cart);

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('🎒 Réclamation Inventaire — Liste en attente de livraison')
    .setDescription(
      `**Joueur :** <@${data.userId}> (\`${data.username}\`) — **${total} article(s)**\n\n` +
      `**Panier :**\n\n${summary}`.slice(0, 4096)
    )
    .setTimestamp()
    .setFooter({ text: '⏳ En attente de livraison — retrait inventaire à confirmer par le staff' });

  await interaction.reply({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`rcl_ic_deliver::${data.ticketId}`)
        .setLabel('📦 Commande livrée → Valider le retrait inventaire')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${PREFIX}_close::${data.ticketId}`)
        .setLabel('🔒 Fermer le ticket')
        .setStyle(ButtonStyle.Secondary),
    )],
  });
}

// ── Staff : "Commande livrée → Valider retrait" ───────────────────────────────
async function handleInvDeliver(interaction, ticketId) {
  if (!isStaff(interaction)) return interaction.reply({ content: '🚫 Réservé au staff.', ephemeral: true });

  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data)  return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  const adminName = interaction.member?.displayName || interaction.user.username;
  const cart      = data.claimData.invCart || [];
  const lines     = [];

  for (const entry of cart) {
    try {
      await removeFromInventory(data.userId, entry.itemId, entry.qty, interaction.user.id, `Réclamation inventaire — Ticket ${ticketId}`);
      lines.push(`• ${menuEmoji(entry.emoji, '📦')} **${entry.itemName}** × ${entry.qty} ✅`);
    } catch (err) {
      lines.push(`• ⚠️ ${entry.itemName} × ${entry.qty} — erreur : ${err.message}`);
    }
  }

  data.status = 'done';
  data.claimData.resolvedBy = adminName;
  saveTicket(data);

  try { await interaction.message.edit({ components: [] }); } catch (e) {}

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('✅ Commande livrée — Inventaire déduit')
    .setDescription(`Livraison confirmée par **${adminName}**.\n\nLes articles ont été retirés de l'inventaire de <@${data.userId}>.`)
    .addFields({ name: '📦 Déductions', value: lines.join('\n').slice(0, 1024) || '—' })
    .setTimestamp();

  await interaction.reply({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}_close::${ticketId}`).setLabel('🔒 Fermer le ticket').setStyle(ButtonStyle.Secondary),
    )],
  });

  await sendInventoryLog(
    interaction.guild,
    `📦 **${adminName}** a livré la commande inventaire de <@${data.userId}> (\`${data.username}\`) — ${cart.length} type(s) d\'items — Ticket <#${data.channelId}>`
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// ANCIEN FLUX INVENTAIRE (compat — item perdu → item shop)
// ══════════════════════════════════════════════════════════════════════════════

async function handleInvItemLost(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  const [itemId, isOccStr] = interaction.values[0].split('::');
  const isOccasionnel = isOccStr === '1';
  const itemType      = getItemTypes().find(t => t.id === itemId);

  data.claimData.lostItemId           = itemId;
  data.claimData.lostItemName         = itemType?.name || itemId;
  data.claimData.lostItemIsOccasionnel = isOccasionnel;
  saveTicket(data);

  try { await interaction.message.edit({ components: [] }); } catch (e) {}

  await interaction.reply({ embeds: [new EmbedBuilder().setColor(typeColor('inventory'))
    .setDescription(`✅ Item perdu sélectionné : **${menuEmoji(itemType?.emoji, '📦')} ${data.claimData.lostItemName}**${isOccasionnel ? ' *(OCCASIONNEL)*' : ''}`)
  ]});
  await buildShopItemSelectAndSend(interaction.channel, data);
}

async function buildShopItemSelectAndSend(channel, data) {
  const shop  = getShop();
  const dinos = getDinoData()?.dinos || [];
  const opts  = [];

  for (const dino of dinos) {
    if (opts.length >= 20) break;
    if (dino.notAvailableShop) continue;
    opts.push({ label: `🦕 ${dino.name}`.slice(0, 100), description: (dino.location || 'Dino').slice(0, 100), value: `dino::${dino.id}` });
  }
  for (const pack of (shop.packs || [])) {
    if (opts.length >= 25) break;
    if (!pack.visible) continue;
    opts.push({ label: `📦 ${pack.name}`.slice(0, 100), description: (pack.description || 'Pack').slice(0, 100), value: `pack::${pack.id}` });
  }
  if (!opts.length) return channel.send({ content: '❌ Aucun item en boutique configuré.' });

  const select = new StringSelectMenuBuilder()
    .setCustomId(`${PREFIX}_inv_shop_item::${data.ticketId}`)
    .setPlaceholder('Quel item veux-tu récupérer ?')
    .addOptions(opts);

  await channel.send({
    embeds: [new EmbedBuilder().setColor(typeColor('inventory'))
      .setTitle('🛒 Étape 2 — Item à récupérer')
      .setDescription('Choisis l\'item que tu veux récupérer dans la boutique.')],
    components: [new ActionRowBuilder().addComponents(select)],
  });
}

async function handleInvShopItem(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  const [shopType, shopId] = interaction.values[0].split('::');
  data.claimData.shopItemId   = shopId;
  data.claimData.shopItemType = shopType;

  let shopItemName = shopId;
  if (shopType === 'dino') {
    const dino = (getDinoData()?.dinos || []).find(d => d.id === shopId);
    shopItemName = dino ? `🦕 ${dino.name}` : shopId;
  } else {
    const pack = (getShop().packs || []).find(p => p.id === shopId);
    shopItemName = pack ? `📦 ${pack.name}` : shopId;
  }
  data.claimData.shopItemName = shopItemName;
  saveTicket(data);

  try { await interaction.message.edit({ components: [] }); } catch (e) {}

  if (data.claimData.lostItemIsOccasionnel) {
    const modal = new ModalBuilder().setCustomId(`${PREFIX}_inv_occ_note::${ticketId}`).setTitle('✨ Item OCCASIONNEL — Note requise');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('occ_note').setLabel('Explique comment tu as obtenu cet item')
        .setStyle(TextInputStyle.Paragraph).setRequired(true)
        .setPlaceholder('Ex : Gagné lors du giveaway du 12 mars…').setMaxLength(500)
    ));
    return interaction.showModal(modal);
  }

  await interaction.reply({ embeds: [new EmbedBuilder().setColor(typeColor('inventory')).setDescription(`✅ Item sélectionné : **${shopItemName}**`)] });
  await sendInventoryReclaimSummary(interaction.channel, data);
}

async function handleOccNote(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  data.claimData.occasionnelNote = interaction.fields.getTextInputValue('occ_note');
  saveTicket(data);
  await interaction.reply({ embeds: [new EmbedBuilder().setColor(typeColor('inventory')).setDescription('✅ Note enregistrée.')] });
  await sendInventoryReclaimSummary(interaction.channel, data);
}

async function sendInventoryReclaimSummary(channel, data) {
  const embed = new EmbedBuilder()
    .setColor(typeColor('inventory'))
    .setTitle('🎒 Réclamation — Récupération d\'inventaire')
    .addFields(
      { name: '👤 Joueur',        value: `<@${data.userId}>`, inline: true },
      { name: '📦 Item perdu',    value: `${data.claimData.lostItemName || '?'}${data.claimData.lostItemIsOccasionnel ? ' ✨' : ''}`, inline: true },
      { name: '🛒 Item à livrer', value: data.claimData.shopItemName || '?', inline: true },
    )
    .setTimestamp()
    .setFooter({ text: '⏳ En attente de traitement' });

  if (data.claimData.occasionnelNote) embed.addFields({ name: '📝 Note OCCASIONNEL', value: data.claimData.occasionnelNote });
  await channel.send({ embeds: [embed], components: [buildStaffActionsRow(data.ticketId, 'inventory-legacy')] });
}

// ══════════════════════════════════════════════════════════════════════════════
// FLUX — RÉSURRECTION DE DINO (v2 — sans formulaire)
// ══════════════════════════════════════════════════════════════════════════════

async function startResurrectionReclaimToChannel(channel, data, settings) {
  const inv      = getPlayerInventory(data.userId);
  const diamonds = inv['diamants'] || 0;
  const enough   = diamonds >= 500;
  const block    = settings.blockResurrectionIfInsufficient && !enough;

  const statusLine = enough
    ? '✅ Tu as suffisamment de diamants.'
    : `⚠️ Solde insuffisant — tu as **${diamonds.toLocaleString('fr-FR')} 💎** sur les **500 💎** nécessaires.`;

  const desc = block
    ? `**Coût :** 500 💎\n\n💎 Solde actuel : **${diamonds.toLocaleString('fr-FR')} 💎**\n${statusLine}\n\n❌ **Tu ne peux pas ouvrir une demande de résurrection sans les 500 💎 nécessaires.**`
    : `**Coût :** 500 💎 prélevés depuis ton compte.\n\n💎 Solde actuel : **${diamonds.toLocaleString('fr-FR')} 💎**\n${statusLine}\n\n` +
      `Note-nous un petit bonjour et des détails si tu le souhaites juste en dessous, un membre du staff revient vers toi dès que possible pour te donner rendez-vous pour la réa. ` +
      `En attendant, tu peux stocker l'essence de ton dino dans les données d'un émetteur pour prolonger sa durée de vie qui est de 24h. ` +
      `⚠️ Attention, au bout de 48h les données stockées dans l'émetteur s'effacent — pense à le retirer avant ce délai.`;

  const embed = new EmbedBuilder()
    .setColor(block ? 0x95a5a6 : typeColor('resurrection'))
    .setTitle('💀 Résurrection de dino')
    .setDescription(desc);

  const rows = [];
  if (!block) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${PREFIX}_resur_staff_confirm::${data.ticketId}`)
        .setLabel('💀 Confirmer la réa (STAFF)')
        .setStyle(ButtonStyle.Success),
    ));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}_close::${data.ticketId}`)
      .setLabel('🔒 Fermer ce ticket')
      .setStyle(ButtonStyle.Secondary),
  ));

  await channel.send({ embeds: [embed], components: rows });
}

// Fallback pour les anciens tickets via handleTypeSelect
async function startResurrectionReclaim(interaction, data, settings) {
  if (!settings) settings = getReclaimSettings();
  const inv      = getPlayerInventory(data.userId);
  const diamonds = inv['diamants'] || 0;
  const enough   = diamonds >= 500;
  const block    = settings.blockResurrectionIfInsufficient && !enough;

  const statusLine = enough
    ? '✅ Tu as suffisamment de diamants.'
    : `⚠️ Solde insuffisant — tu as **${diamonds.toLocaleString('fr-FR')} 💎** sur les **500 💎** nécessaires.`;

  const desc = block
    ? `**Coût :** 500 💎\n\n💎 Solde actuel : **${diamonds.toLocaleString('fr-FR')} 💎**\n${statusLine}\n\n❌ **Tu ne peux pas ouvrir une demande de résurrection sans les 500 💎 nécessaires.**`
    : `**Coût :** 500 💎\n\n💎 Solde actuel : **${diamonds.toLocaleString('fr-FR')} 💎**\n${statusLine}\n\n` +
      `Note-nous un petit bonjour et des détails juste en dessous. Un staff reviendra vers toi pour la réa.\n\n` +
      `*Tu peux stocker l'essence dans un émetteur (durée de vie 24h, données effacées à 48h).*`;

  const embed = new EmbedBuilder()
    .setColor(block ? 0x95a5a6 : typeColor('resurrection'))
    .setTitle('💀 Résurrection de dino')
    .setDescription(desc);

  const rows = [];
  if (!block) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${PREFIX}_resur_staff_confirm::${data.ticketId}`)
        .setLabel('💀 Confirmer la réa (STAFF)')
        .setStyle(ButtonStyle.Success),
    ));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}_close::${data.ticketId}`)
      .setLabel('🔒 Fermer ce ticket')
      .setStyle(ButtonStyle.Secondary),
  ));

  await interaction.reply({ embeds: [embed], components: rows });
}

// ── Staff : Confirmer la réa (prélève 500💎) ──────────────────────────────────
async function handleResurStaffConfirm(interaction, ticketId) {
  if (!isStaff(interaction)) return interaction.reply({ content: '🚫 Réservé au staff.', ephemeral: true });

  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data)  return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  const adminName = interaction.member?.displayName || interaction.user.username;
  const inv       = getPlayerInventory(data.userId);
  const diamonds  = inv['diamants'] || 0;

  try {
    if (diamonds >= 500) {
      await removeFromInventory(data.userId, 'diamants', 500, interaction.user.id, `Résurrection dino — Ticket ${ticketId}`);
      data.claimData.diamondsDeducted = 500;
      data.claimData.deductedBy       = adminName;
    } else {
      data.claimData.diamondsDeducted = 0;
      data.claimData.deductedBy       = adminName;
      data.claimData.deductionNote    = `Solde insuffisant (${diamonds}💎) — prélèvement manuel nécessaire`;
    }
  } catch (e) {
    return interaction.reply({ content: `❌ Erreur prélèvement : ${e.message}`, ephemeral: true });
  }

  data.status = 'done';
  data.claimData.resolvedBy = adminName;
  saveTicket(data);

  const deductedOk = data.claimData.diamondsDeducted === 500;
  try { await interaction.message.edit({ components: [] }); } catch (e) {}

  await interaction.reply({
    content: `<@${data.userId}>`,
    embeds: [new EmbedBuilder()
      .setColor(deductedOk ? 0x2ecc71 : 0xe67e22)
      .setTitle(deductedOk ? '✅ Réa confirmée — 500 💎 prélevés' : '⚠️ Réa confirmée — Prélèvement manuel requis')
      .setDescription(
        deductedOk
          ? `**${adminName}** a confirmé la résurrection et prélevé **500 💎** du compte de <@${data.userId}>.\n\nBonne réa ! 🦕`
          : `Solde insuffisant (**${diamonds} 💎**). **${adminName}** doit gérer le prélèvement manuellement.`
      ).setTimestamp()
    ],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}_close::${ticketId}`).setLabel('🔒 Fermer le ticket').setStyle(ButtonStyle.Secondary),
    )],
  });

  await sendInventoryLog(
    interaction.guild,
    `💀 **${adminName}** a confirmé la réa de <@${data.userId}> (\`${data.username}\`) — ${deductedOk ? '500 💎 prélevés ✅' : '⚠️ prélèvement manuel requis'} — Ticket <#${data.channelId}>`
  );
}

// Anciens handlers résurrection (compat — si ticket avec bouton "Confirmer — renseigner infos")
async function handleResurConfirm(interaction, ticketId) {
  // Redirige vers le nouveau staff confirm
  return handleResurStaffConfirm(interaction, ticketId);
}

// ══════════════════════════════════════════════════════════════════════════════
// FLUX — STRUCTURES ABANDONNÉES / GÊNANTES
// ══════════════════════════════════════════════════════════════════════════════

// Maintenant appelé uniquement via handleStructPreTypeModal (modal avant salon).
// Les fonctions ci-dessous restent pour la compat des anciens tickets.

async function startStructuresReclaimToChannel(channel, data) {
  // Ne devrait plus être appelé pour les nouveaux tickets (le salon est créé depuis le modal)
  // Gardé pour compat anciens tickets
  const embed = new EmbedBuilder()
    .setColor(typeColor('structures'))
    .setTitle('🧱 Structures abandonnées / gênantes')
    .setDescription('Clique sur le bouton ci-dessous pour renseigner les informations.');
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}_struct_form::${data.ticketId}`).setLabel('📝 Ouvrir le formulaire').setStyle(ButtonStyle.Primary),
  );
  await channel.send({ embeds: [embed], components: [row] });
}

async function startStructuresReclaim(interaction, data) {
  const modal = new ModalBuilder()
    .setCustomId(`${PREFIX}_struct_modal::${data.ticketId}`)
    .setTitle('🏗️ Structures abandonnées / gênantes');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('struct_map').setLabel('Sur quelle map ?')
        .setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Ex : The Island, Ragnarok…')
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('struct_coords').setLabel('Coordonnées (lat / lon)')
        .setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Ex : 45.2 / 67.8')
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('struct_notes').setLabel('Informations complémentaires')
        .setStyle(TextInputStyle.Paragraph).setRequired(false)
        .setPlaceholder('Décris le problème…').setMaxLength(500)
    )
  );
  await interaction.showModal(modal);
}

async function handleStructFormBtn(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });
  try { await interaction.message.edit({ components: [] }); } catch (e) {}
  await startStructuresReclaim(interaction, data);
}

async function handleStructModal(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  data.claimData.structMap    = interaction.fields.getTextInputValue('struct_map');
  data.claimData.structCoords = interaction.fields.getTextInputValue('struct_coords');
  data.claimData.structNotes  = interaction.fields.getTextInputValue('struct_notes') || '';
  data.status = 'pending';
  saveTicket(data);

  const embed = new EmbedBuilder()
    .setColor(typeColor('structures'))
    .setTitle('🧱 Réclamation — Structures abandonnées / gênantes')
    .addFields(
      { name: '👤 Joueur',      value: `<@${data.userId}>`, inline: true },
      { name: '🗺️ Map',         value: data.claimData.structMap,    inline: true },
      { name: '📍 Coordonnées', value: data.claimData.structCoords, inline: true },
    )
    .setTimestamp()
    .setFooter({ text: '⏳ En attente de vérification' });
  if (data.claimData.structNotes) embed.addFields({ name: '📝 Notes', value: data.claimData.structNotes });

  await interaction.reply({ embeds: [embed], components: [buildStaffActionsRow(ticketId, 'structures')] });
}

// ══════════════════════════════════════════════════════════════════════════════
// FLUX — AUTRES DEMANDES (v2 — sans formulaire)
// ══════════════════════════════════════════════════════════════════════════════

async function startAutresReclaimToChannel(channel, data) {
  const embed = new EmbedBuilder()
    .setColor(typeColor('autres'))
    .setTitle('💬 Autres demandes')
    .setDescription(
      `Décris ta demande librement juste en dessous 👇\n\nUn membre du staff reviendra vers toi dès que possible.`
    );

  await channel.send({
    content: `<@${data.userId}>`,
    embeds: [embed],
    components: [buildStaffActionsRow(data.ticketId, 'autres')],
  });
}

// Fallback (anciens tickets)
async function startAutresReclaim(interaction, data) {
  const modal = new ModalBuilder()
    .setCustomId(`${PREFIX}_autres_modal::${data.ticketId}`)
    .setTitle('💬 Autres demandes');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('autres_text').setLabel('Décris ta demande')
        .setStyle(TextInputStyle.Paragraph).setRequired(true)
        .setPlaceholder('Explique ta situation, ta demande ou ton problème…').setMaxLength(1000)
    )
  );
  await interaction.showModal(modal);
}

async function handleAutresFormBtn(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });
  try { await interaction.message.edit({ components: [] }); } catch (e) {}
  await startAutresReclaim(interaction, data);
}

async function handleAutresModal(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  data.claimData.autresText = interaction.fields.getTextInputValue('autres_text');
  data.status = 'pending';
  saveTicket(data);

  const embed = new EmbedBuilder()
    .setColor(typeColor('autres'))
    .setTitle('💬 Réclamation — Autres demandes')
    .addFields(
      { name: '👤 Joueur', value: `<@${data.userId}>`, inline: true },
      { name: '📝 Demande', value: data.claimData.autresText },
    )
    .setTimestamp()
    .setFooter({ text: '⏳ En attente de traitement' });

  await interaction.reply({ embeds: [embed], components: [buildStaffActionsRow(ticketId, 'autres')] });
}

// ══════════════════════════════════════════════════════════════════════════════
// BOUTONS STAFF
// ══════════════════════════════════════════════════════════════════════════════

function buildStaffActionsRow(ticketId, type) {
  const row = new ActionRowBuilder();

  if (type === 'inventory') {
    // Nouvelle gestion : livraison + fermer (pas de refuser)
    row.addComponents(
      new ButtonBuilder().setCustomId(`rcl_ic_deliver::${ticketId}`).setLabel('📦 Commande livrée → Valider le retrait').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${PREFIX}_close::${ticketId}`).setLabel('🔒 Fermer le ticket').setStyle(ButtonStyle.Secondary),
    );
  } else if (type === 'inventory-legacy') {
    // Ancien flux inventaire (item perdu / shop) : traitée + fermer
    row.addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}_mark_done::${ticketId}`).setLabel('✅ Réclamation traitée').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${PREFIX}_close::${ticketId}`).setLabel('🔒 Fermer le ticket').setStyle(ButtonStyle.Secondary),
    );
  } else {
    // structures, autres, resurrection, fallback : traitée + fermer (sans refuser)
    row.addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}_mark_done::${ticketId}`).setLabel('✅ Réclamation traitée').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${PREFIX}_close::${ticketId}`).setLabel('🔒 Fermer le ticket').setStyle(ButtonStyle.Secondary),
    );
  }
  return row;
}

// ── Réclamation traitée ───────────────────────────────────────────────────────
async function handleMarkDone(interaction, ticketId) {
  if (!isStaff(interaction)) return interaction.reply({ content: '🚫 Réservé au staff.', ephemeral: true });

  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data)  return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });

  const adminName = interaction.member?.displayName || interaction.user.username;
  data.status = 'done';
  data.claimData.resolvedBy = adminName;

  // Compat : déduction auto pour ancien flux inventaire (invCart sans passage par handleInvDeliver)
  const deductionLines = [];
  if (data.type === 'inventory' && (data.claimData.invCart || []).length > 0 && !data.claimData.resolvedViaDeliver) {
    for (const entry of (data.claimData.invCart || [])) {
      try {
        await removeFromInventory(data.userId, entry.itemId, entry.qty, interaction.user.id, `Réclamation inventaire — Ticket ${ticketId}`);
        deductionLines.push(`• ${menuEmoji(entry.emoji, '📦')} **${entry.itemName}** × ${entry.qty} ✅`);
      } catch (err) {
        deductionLines.push(`• ⚠️ ${entry.itemName} × ${entry.qty} — erreur : ${err.message}`);
      }
    }
  }
  saveTicket(data);
  try { await interaction.message.edit({ components: [] }); } catch (e) {}

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('✅ Réclamation traitée')
    .setDescription(`La réclamation de <@${data.userId}> a été **traitée** par **${adminName}**.\n\nLe ticket peut maintenant être fermé.`)
    .setTimestamp();
  if (deductionLines.length) embed.addFields({ name: '📦 Inventaire déduit', value: deductionLines.join('\n') });

  await interaction.reply({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}_close::${ticketId}`).setLabel('🔒 Fermer le ticket').setStyle(ButtonStyle.Secondary),
    )],
  });
}

// Gardé pour compat (anciens tickets avec le bouton refuser)
async function handleMarkRefused(interaction, ticketId) {
  if (!isStaff(interaction)) return interaction.reply({ content: '🚫 Réservé au staff.', ephemeral: true });
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  if (!data) return interaction.reply({ content: '❌ Ticket introuvable.', ephemeral: true });
  const modal = new ModalBuilder().setCustomId(`${PREFIX}_refuse_reason::${ticketId}`).setTitle('Motif du refus');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('reason').setLabel('Motif du refus (visible par le joueur)')
      .setStyle(TextInputStyle.Paragraph).setRequired(false).setPlaceholder('Ex : Item non éligible…').setMaxLength(300)
  ));
  return interaction.showModal(modal);
}

async function handleRefuseReason(interaction, ticketId) {
  const data      = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  const adminName = interaction.member?.displayName || interaction.user.username;
  const reason    = interaction.fields.getTextInputValue('reason') || 'Aucun motif précisé.';
  if (data) { data.status = 'refused'; data.claimData.refusedBy = adminName; data.claimData.refuseReason = reason; saveTicket(data); }
  try { await interaction.message.edit({ components: [] }); } catch (e) {}
  await interaction.reply({
    content: `<@${data?.userId || ''}>`,
    embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle('❌ Réclamation refusée')
      .setDescription(`Ta réclamation a été **refusée** par **${adminName}**.\n\n**Motif :** ${reason}`)
      .setTimestamp()],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}_close::${ticketId}`).setLabel('🔒 Fermer le ticket').setStyle(ButtonStyle.Secondary),
    )],
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// FERMETURE — ACCESSIBLE JOUEUR + GESTION PANIER EN COURS
// ══════════════════════════════════════════════════════════════════════════════

async function handleClose(interaction, ticketId) {
  const data = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  const isPlayer    = data?.userId === interaction.user.id;
  const isStaffUser = isStaff(interaction);

  if (!isPlayer && !isStaffUser) {
    return interaction.reply({ content: '🚫 Action non autorisée.', ephemeral: true });
  }

  // Joueur ferme avec un panier non finalisé → avertissement staff
  if (isPlayer && !isStaffUser && data?.type === 'inventory') {
    const cart = data.claimData?.invCart || [];
    if (cart.length > 0 && data.status === 'open') {
      await interaction.reply({ content: '✅ Ta demande de fermeture a été transmise au staff.', ephemeral: true });
      await interaction.channel.send({
        content: `<@${data.userId}>`,
        embeds: [new EmbedBuilder()
          .setColor(0xe67e22)
          .setTitle('⚠️ Demande d\'annulation — Liste en cours')
          .setDescription(`**<@${data.userId}>** demande l'annulation de sa commande et la fermeture du ticket.\n\n**Liste en cours :**\n${buildInvCartSummaryLines(cart).slice(0, 800)}`)
          .setFooter({ text: 'Valider ou refuser ci-dessous (staff uniquement)' })
        ],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`rcl_cancel_list_ok::${ticketId}`).setLabel('✅ Valider l\'annulation et fermer').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`rcl_cancel_list_no::${ticketId}`).setLabel('❌ Ne pas fermer').setStyle(ButtonStyle.Secondary),
        )],
      });
      return;
    }
  }

  // Confirmation normale (2 étapes)
  await interaction.reply({
    embeds: [new EmbedBuilder().setColor(0xe67e22).setTitle('⚠️ Fermer ce ticket ?')
      .setDescription('Le salon sera fermé. Le joueur n\'aura plus accès.')],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}_close_confirm::${ticketId}`).setLabel('✅ Oui, fermer').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`${PREFIX}_close_cancel::${ticketId}`).setLabel('❌ Annuler').setStyle(ButtonStyle.Secondary),
    )],
    ephemeral: true,
  });
}

async function handleCloseConfirm(interaction, ticketId) {
  const data      = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  const closedBy  = interaction.member?.displayName || interaction.user.username;
  const userId    = data?.userId;

  if (userId) {
    try { await interaction.channel.permissionOverwrites.edit(userId, { ViewChannel: false, SendMessages: false }); } catch (e) {}
  }

  const currentName = interaction.channel.name;
  try { await interaction.channel.edit({ name: `ferme-${currentName}`.slice(0, 100), reason: `Fermé par ${closedBy}` }); } catch (e) {}

  if (data) {
    if (data.status === 'open') data.status = 'closed';
    data.claimData.closedBy = closedBy;
    data.claimData.closedAt = Date.now();
    saveTicket(data);
  }

  try {
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(0x95a5a6).setTitle('🔒 Ticket fermé').setDescription(`Fermé par **${closedBy}**.`)],
      components: [],
    });
  } catch (e) {}

  await interaction.channel.send({
    embeds: [new EmbedBuilder().setColor(0x95a5a6).setTitle('🔒 Ticket fermé')
      .setDescription(`Ce ticket a été fermé par **${closedBy}**.\n\nVous pouvez ajouter une note ou supprimer le ticket.`)
      .setTimestamp()],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}_add_note::${ticketId}`).setLabel('📝 Ajouter une note').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${PREFIX}_delete::${ticketId}`).setLabel('🗑️ Supprimer le ticket').setStyle(ButtonStyle.Danger),
    )],
  }).catch(() => {});
}

// ── Annulation avec liste — staff valide ou refuse ───────────────────────────

async function handleCancelListOk(interaction, ticketId) {
  if (!isStaff(interaction)) return interaction.reply({ content: '🚫 Réservé au staff.', ephemeral: true });

  const data      = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  const closedBy  = interaction.member?.displayName || interaction.user.username;
  const userId    = data?.userId;

  try { await interaction.message.edit({ components: [] }); } catch (e) {}

  if (userId) {
    try { await interaction.channel.permissionOverwrites.edit(userId, { ViewChannel: false, SendMessages: false }); } catch (e) {}
  }

  if (data) {
    data.status             = 'closed';
    data.claimData.closedBy = closedBy;
    data.claimData.closedAt = Date.now();
    data.claimData.invCart  = [];
    saveTicket(data);
  }

  try { await interaction.channel.edit({ name: `ferme-${interaction.channel.name}`.slice(0, 100) }); } catch (e) {}

  await interaction.reply({
    embeds: [new EmbedBuilder().setColor(0x95a5a6).setTitle('🔒 Annulation validée')
      .setDescription(`Commande annulée et ticket fermé par **${closedBy}**. Le joueur n\'a plus accès.`)
      .setTimestamp()],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}_delete::${ticketId}`).setLabel('🗑️ Supprimer le ticket').setStyle(ButtonStyle.Danger),
    )],
  });
}

async function handleCancelListNo(interaction, ticketId) {
  if (!isStaff(interaction)) return interaction.reply({ content: '🚫 Réservé au staff.', ephemeral: true });
  try { await interaction.message.edit({ components: [] }); } catch (e) {}
  await interaction.reply({ content: '↩️ Fermeture annulée. La commande reste en cours.', ephemeral: true });
}

// ══════════════════════════════════════════════════════════════════════════════
// NOTE STAFF
// ══════════════════════════════════════════════════════════════════════════════

async function handleAddNote(interaction, ticketId) {
  if (!isStaff(interaction)) return interaction.reply({ content: '🚫 Réservé au staff.', ephemeral: true });
  const modal = new ModalBuilder().setCustomId(`${PREFIX}_note_modal::${ticketId}`).setTitle('📝 Note staff');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('note_text').setLabel('Note interne (affichée dans le compte-rendu)')
      .setStyle(TextInputStyle.Paragraph).setRequired(true)
      .setPlaceholder('Ex : Structure supprimée le 06/05…').setMaxLength(500)
  ));
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
    embeds: [new EmbedBuilder().setColor(0x3498db).setTitle('📝 Note enregistrée')
      .setDescription(`**Note de ${adminName} :**\n${noteText}`).setTimestamp()],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}_delete::${ticketId}`).setLabel('🗑️ Supprimer le ticket').setStyle(ButtonStyle.Danger),
    )],
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// SUPPRESSION + COMPTE-RENDU LOG
// ══════════════════════════════════════════════════════════════════════════════

async function handleDelete(interaction, ticketId) {
  if (!isStaff(interaction)) return interaction.reply({ content: '🚫 Réservé au staff.', ephemeral: true });

  const data      = await getOrReloadReclaimTicket(ticketId, interaction.channelId);
  const adminName = interaction.member?.displayName || interaction.user.username;

  try { await sendLogRecap(interaction.guild, data, adminName); } catch (e) { console.error('[ReclaimTicket] Erreur log:', e.message); }

  try {
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle('🗑️ Suppression dans 3 secondes…')
        .setDescription('Le compte-rendu a été envoyé dans le salon admin.')],
      components: [],
    });
  } catch (e) {}

  setTimeout(async () => {
    try {
      await interaction.channel.delete(`Ticket supprimé par ${adminName}`);
      activeReclaimTickets.delete(ticketId);
      await pgStore.deleteReclaimTicket(ticketId);
    } catch (err) { console.error('[ReclaimTicket] Erreur suppression:', err.message); }
  }, 3000);
}

async function sendLogRecap(guild, data, deletedBy) {
  const settings = getReclaimSettings();
  if (!settings.logChannelId) return;
  const logCh = guild.channels.cache.get(settings.logChannelId);
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

  if (type === 'inventory') {
    const cart = cd.invCart || [];
    if (cart.length > 0) {
      embed.addFields({ name: '📦 Panier réclamé', value: buildInvCartSummaryLines(cart).slice(0, 1024) || '—' });
    } else if (cd.lostItemName) {
      embed.addFields(
        { name: '📦 Item perdu',    value: `${cd.lostItemName}${cd.lostItemIsOccasionnel ? ' ✨' : ''}`, inline: true },
        { name: '🛒 Item à livrer', value: cd.shopItemName || '?', inline: true },
      );
      if (cd.occasionnelNote) embed.addFields({ name: '📝 Note OCCASIONNEL', value: cd.occasionnelNote });
    }
  }
  if (type === 'resurrection') {
    embed.addFields(
      { name: '💎 Prélèvement', value: cd.diamondsDeducted === 500 ? `✅ 500💎 par ${cd.deductedBy}` : (cd.deductionNote || '⚠️ Non prélevé'), inline: false },
    );
  }
  if (type === 'structures') {
    embed.addFields(
      { name: '🗺️ Map',         value: cd.structMap || '?',    inline: true },
      { name: '📍 Coordonnées', value: cd.structCoords || '?', inline: true },
    );
    if (cd.structNotes) embed.addFields({ name: '📝 Notes', value: cd.structNotes });
  }
  if (type === 'autres') {
    embed.addFields({ name: '📝 Demande', value: cd.autresText || '(texte libre dans le ticket)' });
  }

  const actions = [];
  if (cd.resolvedBy) actions.push(`✅ Traité par **${cd.resolvedBy}**`);
  if (cd.refusedBy)  actions.push(`❌ Refusé par **${cd.refusedBy}** — ${cd.refuseReason || ''}`);
  if (cd.closedBy)   actions.push(`🔒 Fermé par **${cd.closedBy}**`);
  if (actions.length) embed.addFields({ name: '👮 Actions staff', value: actions.join('\n') });
  if (data?.staffNote) embed.addFields({ name: `📝 Note staff${cd.noteBy ? ` (${cd.noteBy})` : ''}`, value: data.staffNote });

  const openedAt = data?.createdAt ? new Date(data.createdAt).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }) : '?';
  embed.setFooter({ text: `Ticket ${data?.ticketId} • Ouvert le ${openedAt}` });
  embed.setThumbnail('attachment://reclamation.png');

  const att = new AttachmentBuilder(RECLAIM_IMG, { name: 'reclamation.png' });
  await logCh.send({ embeds: [embed], files: [att] });
}

// ══════════════════════════════════════════════════════════════════════════════
// /RECAP DANS UN TICKET INVENTAIRE
// ══════════════════════════════════════════════════════════════════════════════

async function handleReclaimRecapCommand(interaction) {
  const data = await getOrReloadReclaimTicket(null, interaction.channelId);
  if (!data || data.type !== 'inventory') return false; // pas un ticket inventaire

  const cart    = data.claimData.invCart || [];
  const total   = cart.reduce((s, e) => s + e.qty, 0);
  const statusLabels = { open: 'En cours', pending: 'En attente de livraison', done: 'Traitée', closed: 'Fermée', refused: 'Refusée' };

  let desc = `**Joueur :** <@${data.userId}> (\`${data.username}\`)\n`;
  desc += `**Statut :** ${statusLabels[data.status] || data.status}`;
  if (cart.length > 0) {
    desc += ` — **${total} article(s)**\n\n**Panier :**\n\n${buildInvCartSummaryLines(cart)}`;
  } else {
    desc += '\n\n*Panier vide.*';
  }

  const embed = new EmbedBuilder()
    .setColor(typeColor('inventory'))
    .setTitle('🎒 Récapitulatif — Réclamation Inventaire')
    .setDescription(desc.slice(0, 4096))
    .setTimestamp()
    .setFooter({ text: `Ticket ${data.ticketId}` });

  await interaction.reply({ embeds: [embed] });
  return true;
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
  if (!id) return;

  const isBtn    = interaction.isButton();
  const isSelect = interaction.isStringSelectMenu();
  const isModal  = interaction.isModalSubmit();

  // ── Panneau ───────────────────────────────────────────────────────────────
  if (isBtn && id === `${PREFIX}_open`) return handleOpenReclaim(interaction);

  // ── Select type éphémère (pré-ouverture) ──────────────────────────────────
  if (isSelect && id === `${PREFIX}_pretype`) return handlePreTypeSelect(interaction);

  // ── Structures : modal avant création salon ───────────────────────────────
  if (isModal && id === `${PREFIX}_struct_pretypemodal`) return handleStructPreTypeModal(interaction);

  // ── Select type dans le salon (fallback) ──────────────────────────────────
  if (isSelect && id.startsWith(`${PREFIX}_type_select::`)) {
    return handleTypeSelect(interaction, id.split('::')[1]);
  }

  // ── Structures / Autres : bouton formulaire (compat) ──────────────────────
  if (isBtn && id.startsWith(`${PREFIX}_struct_form::`))  return handleStructFormBtn(interaction, id.split('::')[1]);
  if (isBtn && id.startsWith(`${PREFIX}_autres_form::`))  return handleAutresFormBtn(interaction, id.split('::')[1]);

  // ── Panier inventaire ─────────────────────────────────────────────────────
  if (isBtn  && id.startsWith('rcl_ic_add::'))       return handleInvAddBtn(interaction, id.split('::')[1]);
  if (isBtn  && id.startsWith('rcl_ic_back::'))       return handleInvBackBtn(interaction, id.split('::')[1]);
  if (isBtn  && id.startsWith('rcl_ic_rmv_sel::'))    return handleInvRmvSelBtn(interaction, id.split('::')[1]);
  if (isBtn  && id.startsWith('rcl_ic_done::'))       return handleInvDoneBtn(interaction, id.split('::')[1]);
  if (isBtn  && id.startsWith('rcl_ic_deliver::'))    return handleInvDeliver(interaction, id.split('::')[1]);
  if (isSelect && id.startsWith('rcl_ic_cat::'))      return handleInvCatSelect(interaction, id.split('::')[1]);
  if (isSelect && id.startsWith('rcl_ic_item::'))     return handleInvItemSelect(interaction, id.split('::')[1]);
  if (isSelect && id.startsWith('rcl_ic_qty::'))      return handleInvQtySelect(interaction, id.split('::')[1]);
  if (isSelect && id.startsWith('rcl_ic_remove::'))   return handleInvRemoveSelect(interaction, id.split('::')[1]);

  // ── Navigation dino ───────────────────────────────────────────────────────
  if (isSelect && id.startsWith('rcl_ic_dn_letter::'))   return handleDinoLetter(interaction, id.split('::')[1]);
  if (isSelect && id.startsWith('rcl_ic_dn_dino::'))     return handleDinoPick(interaction, id.split('::')[1]);
  if (isSelect && id.startsWith('rcl_ic_dn_variant::'))  return handleDinoVariant(interaction, id.split('::')[1]);
  if (isSelect && id.startsWith('rcl_ic_dn_sex::'))      return handleDinoSex(interaction, id.split('::')[1]);
  if (isSelect && id.startsWith('rcl_ic_dn_stat::'))     return handleDinoStat(interaction, id.split('::')[1]);
  if (isSelect && id.startsWith('rcl_ic_dn_mstat::'))    return handleDinoMaleStat(interaction, id.split('::')[1]);
  if (isSelect && id.startsWith('rcl_ic_dn_fstat::'))    return handleDinoFemaleStat(interaction, id.split('::')[1]);
  if (isBtn    && id.startsWith('rcl_ic_dn_cancel::'))   return handleDinoNavCancel(interaction, id.split('::')[1]);

  // ── Navigation pack ───────────────────────────────────────────────────────
  if (isSelect && id.startsWith('rcl_ic_pk_pick::'))     return handlePackPick(interaction, id.split('::')[1]);

  // ── Note modale inventaire ────────────────────────────────────────────────
  if (isModal && id.startsWith('rcl_ic_note::'))          return handleItemNoteModal(interaction, id.split('::')[1]);

  // ── Ancien flux inventaire (item perdu) ────────────────────────────────────
  if (isSelect && id.startsWith(`${PREFIX}_inv_item_lost::`)) return handleInvItemLost(interaction, id.split('::')[1]);
  if (isSelect && id.startsWith(`${PREFIX}_inv_shop_item::`)) return handleInvShopItem(interaction, id.split('::')[1]);
  if (isModal  && id.startsWith(`${PREFIX}_inv_occ_note::`))  return handleOccNote(interaction, id.split('::')[1]);

  // ── Résurrection ──────────────────────────────────────────────────────────
  if (isBtn  && id.startsWith(`${PREFIX}_resur_confirm::`) )   return handleResurConfirm(interaction, id.split('::')[1]);
  if (isBtn  && id.startsWith(`${PREFIX}_resur_staff_confirm::`) ) return handleResurStaffConfirm(interaction, id.split('::')[1]);
  // Anciens handlers compat
  if (isModal && id.startsWith(`${PREFIX}_resur_modal::`) )   return interaction.reply({ content: '❌ Ce formulaire n\'est plus utilisé.', ephemeral: true });
  if (isBtn   && id.startsWith(`${PREFIX}_resur_deduct::`) )   return handleResurStaffConfirm(interaction, id.split('::')[1]);

  // ── Structures : modal ────────────────────────────────────────────────────
  if (isModal && id.startsWith(`${PREFIX}_struct_modal::`)) return handleStructModal(interaction, id.split('::')[1]);

  // ── Autres : modal ────────────────────────────────────────────────────────
  if (isModal && id.startsWith(`${PREFIX}_autres_modal::`) ) return handleAutresModal(interaction, id.split('::')[1]);

  // ── Staff : traité ────────────────────────────────────────────────────────
  if (isBtn && id.startsWith(`${PREFIX}_mark_done::`) )      return handleMarkDone(interaction, id.split('::')[1]);

  // ── Staff : refus (compat) ────────────────────────────────────────────────
  if (isBtn  && id.startsWith(`${PREFIX}_mark_refused::`) )  return handleMarkRefused(interaction, id.split('::')[1]);
  if (isModal && id.startsWith(`${PREFIX}_refuse_reason::`) ) return handleRefuseReason(interaction, id.split('::')[1]);

  // ── Fermeture ─────────────────────────────────────────────────────────────
  if (isBtn && id.startsWith(`${PREFIX}_close::`) )          return handleClose(interaction, id.split('::')[1]);
  if (isBtn && id.startsWith(`${PREFIX}_close_confirm::`) )  return handleCloseConfirm(interaction, id.split('::')[1]);
  if (isBtn && id.startsWith(`${PREFIX}_close_cancel::`) )   return interaction.update({ components: [] });

  // ── Annulation avec liste ─────────────────────────────────────────────────
  if (isBtn && id.startsWith('rcl_cancel_list_ok::') ) return handleCancelListOk(interaction, id.split('::')[1]);
  if (isBtn && id.startsWith('rcl_cancel_list_no::') ) return handleCancelListNo(interaction, id.split('::')[1]);

  // ── Note staff ────────────────────────────────────────────────────────────
  if (isBtn  && id.startsWith(`${PREFIX}_add_note::`) )      return handleAddNote(interaction, id.split('::')[1]);
  if (isModal && id.startsWith(`${PREFIX}_note_modal::`) )   return handleNoteModal(interaction, id.split('::')[1]);

  // ── Suppression ───────────────────────────────────────────────────────────
  if (isBtn && id.startsWith(`${PREFIX}_delete::`) )         return handleDelete(interaction, id.split('::')[1]);
}

module.exports = {
  handleReclaimCommand,
  handleReclaimTicketInteraction,
  initReclaimTickets,
  publishReclaimPanel,
  handleReclaimRecapCommand,
};
