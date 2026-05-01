'use strict';

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
} = require('discord.js');
const { getSettings } = require('./settingsManager');

const PREFIX = 'evt';

function getEventSettings() {
  return getSettings().eventTicket || {};
}

// Encode event name safely for Discord customId (max 100 chars total, no ::)
function encodeEvtName(name) {
  return (name || 'event').replace(/::/g, '--').replace(/[^\w\- ]/g, '').trim().slice(0, 50);
}

// ── Panel (publié par /event-panel) ──────────────────────────────────────────

async function publishEventPanel(interaction, eventName) {
  const settings = getEventSettings();
  const title = eventName || 'Événement';
  const desc = settings.panelDescription ||
    'Clique sur le bouton ci-dessous pour ouvrir ton ticket et rejoindre l\'événement.';

  const embed = new EmbedBuilder()
    .setTitle(`🎟️ ${title}`)
    .setDescription(desc)
    .setColor(0x5865F2);

  if (settings.panelImageUrl) embed.setImage(settings.panelImageUrl);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}_open::${encodeEvtName(eventName)}`)
      .setLabel(settings.buttonLabel || '🎟️ Rejoindre l\'événement')
      .setStyle(ButtonStyle.Primary),
  );

  await interaction.reply({ content: '✅ Panel publié avec succès !', ephemeral: true });
  await interaction.channel.send({ embeds: [embed], components: [row] });
}

// ── Routeur d'interactions ────────────────────────────────────────────────────

async function handleEventTicketInteraction(interaction) {
  const id = interaction.isButton() ? interaction.customId
    : interaction.isModalSubmit() ? interaction.customId
    : null;
  if (!id || !id.startsWith(`${PREFIX}_`)) return;

  if (id.startsWith(`${PREFIX}_open::`)) {
    const eventName = id.slice(`${PREFIX}_open::`.length);
    return handleOpenEventTicket(interaction, eventName);
  }

  if (id.startsWith(`${PREFIX}_close::`)) {
    return handleCloseEventTicket(interaction);
  }
}

// ── Ouverture du ticket ───────────────────────────────────────────────────────

async function handleOpenEventTicket(interaction, rawEventName) {
  const settings = getEventSettings();
  const guild = interaction.guild;
  const user = interaction.user;

  const eventName = rawEventName.replace(/--/g, ':').trim() || 'Événement';

  // Nom du salon : evt-<event>-<username>
  const safeName  = user.username.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 18);
  const safeEvent = rawEventName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 18);
  const channelName = `evt-${safeEvent}-${safeName}`;

  // Vérification : ticket déjà ouvert
  const existing = guild.channels.cache.find(c => c.name === channelName);
  if (existing) {
    return interaction.reply({
      content: `Tu as déjà un ticket ouvert pour cet événement : <#${existing.id}>`,
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  // Permissions du salon privé
  const perms = [
    { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    {
      id: user.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.AttachFiles,
      ],
    },
  ];

  for (const roleId of (settings.staffRoleIds || [])) {
    if (guild.roles.cache.has(roleId)) {
      perms.push({
        id: roleId,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.ManageMessages,
        ],
      });
    }
  }

  // Création du salon
  const channel = await guild.channels.create({
    name: channelName,
    parent: settings.categoryId || null,
    permissionOverwrites: perms,
  });

  // Message de bienvenue configuré dans le dashboard
  const rawMsg = settings.welcomeMessage ||
    'Bienvenue {user} dans l\'événement **{event}** !\n\nUn membre du staff va bientôt te rejoindre.';
  const welcomeText = rawMsg
    .replace(/\{user\}/g, `<@${user.id}>`)
    .replace(/\{event\}/g, eventName);

  const embed = new EmbedBuilder()
    .setTitle(`🎟️ ${eventName}`)
    .setDescription(welcomeText)
    .setColor(0x5865F2)
    .setFooter({ text: `Ticket de ${user.tag || user.username}` })
    .setTimestamp();

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}_close::${channel.id}`)
      .setLabel('🔒 Fermer le ticket')
      .setStyle(ButtonStyle.Danger),
  );

  await channel.send({ content: `<@${user.id}>`, embeds: [embed], components: [closeRow] });

  // Notification staff (optionnel)
  if (settings.notifChannelId) {
    const notifCh = guild.channels.cache.get(settings.notifChannelId);
    if (notifCh) {
      await notifCh.send(
        `🎟️ **Nouveau ticket — ${eventName}** | <@${user.id}> (\`${user.username}\`) → <#${channel.id}>`
      ).catch(() => {});
    }
  }

  await interaction.editReply({ content: `✅ Ton ticket a été ouvert : <#${channel.id}>` });
}

// ── Fermeture du ticket ───────────────────────────────────────────────────────

async function handleCloseEventTicket(interaction) {
  const channel = interaction.channel;
  const user = interaction.user;

  const embed = new EmbedBuilder()
    .setDescription(`🔒 **Ticket fermé** par <@${user.id}>\nSuppression dans 5 secondes…`)
    .setColor(0xED4245);

  await interaction.reply({ embeds: [embed] });
  setTimeout(() => channel.delete().catch(() => {}), 5000);
}

module.exports = { publishEventPanel, handleEventTicketInteraction };
