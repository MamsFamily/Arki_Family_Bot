const { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, parseEmoji } = require('discord.js');
const { getSettings } = require('./settingsManager');

const PREFIX = 'selfrole:v1:';
const ADMIN_ROLE_ID = '1157044417526509578';
const MODO_ROLE_ID = '1157803768893689877';
const STYLES = { bleu: ButtonStyle.Primary, vert: ButtonStyle.Success, rouge: ButtonStyle.Danger, gris: ButtonStyle.Secondary };
const SENSITIVE_PERMISSIONS = [
  'Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'ManageWebhooks',
  'KickMembers', 'BanMembers', 'ModerateMembers', 'ManageMessages', 'ManageThreads',
  'ManageEvents', 'ManageGuildExpressions', 'ViewAuditLog', 'MentionEveryone',
  'MuteMembers', 'DeafenMembers', 'MoveMembers', 'ManageNicknames',
].map(name => PermissionFlagsBits[name]).filter(Boolean);

function protectedRoles(settings) {
  const ids = new Set([ADMIN_ROLE_ID, MODO_ROLE_ID]);
  function visit(value, path = '') {
    if (typeof value === 'string' && /admin|staff|modo|moderator/i.test(path) && /role/i.test(path)) {
      if (/^\d{17,20}$/.test(value)) ids.add(value);
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
    }
  }
  visit(settings);
  return ids;
}

function assertSafeRole(role, guild, bot, settings) {
  if (!role || role.id === guild.id || role.managed) {
    throw new Error('Choisis un rôle normal, pas @everyone ni un rôle géré par une intégration.');
  }
  if (protectedRoles(settings).has(role.id) || SENSITIVE_PERMISSIONS.some(permission => role.permissions.has(permission))) {
    throw new Error('Les rôles administrateur, staff ou dotés de permissions sensibles ne peuvent pas être proposés en libre-service.');
  }
  if (!bot.permissions.has(PermissionFlagsBits.ManageRoles) || bot.roles.highest.comparePositionTo(role) <= 0) {
    throw new Error('Le bot doit avoir « Gérer les rôles » et son rôle doit être placé au-dessus du rôle choisi.');
  }
}

function createRoleButtonHandler(deps = {}) {
  const settingsSource = deps.getSettings || getSettings;
  const busy = new Set();

  async function publish(interaction) {
    await interaction.deferReply({ ephemeral: true });
    try {
      const guild = interaction.guild;
      const settings = settingsSource();
      const actor = await guild.members.fetch({ user: interaction.user.id, force: true });
      const admins = new Set([ADMIN_ROLE_ID, ...(settings.serverPanel?.adminRoleIds || [])]);
      const authorized = actor.permissions.has(PermissionFlagsBits.Administrator) ||
        actor.permissions.has(PermissionFlagsBits.ManageRoles) || [...admins].some(id => actor.roles.cache.has(id));
      if (!authorized) throw new Error('Publication réservée aux administrateurs et aux membres autorisés à gérer les rôles.');

      const chosen = interaction.options.getRole('role', true);
      const role = await guild.roles.fetch(chosen.id, { force: true });
      const bot = await guild.members.fetchMe({ force: true });
      assertSafeRole(role, guild, bot, settings);
      if (actor.id !== guild.ownerId && actor.roles.highest.comparePositionTo(role) <= 0) {
        throw new Error('Le rôle choisi doit être placé en dessous de ton rôle le plus élevé.');
      }
      const message = interaction.options.getString('message', true).replace(/\\n/g, '\n');
      const label = interaction.options.getString('bouton') || 'Prendre / retirer le rôle';
      const color = interaction.options.getString('couleur') || 'bleu';
      if (!message.trim() || message.length > 2000) throw new Error('Le message doit contenir entre 1 et 2 000 caractères.');
      if (!label.trim() || label.length > 80) throw new Error('Le texte du bouton doit contenir entre 1 et 80 caractères.');
      if (!STYLES[color]) throw new Error('Couleur de bouton non reconnue.');
      const button = new ButtonBuilder().setCustomId(`${PREFIX}${guild.id}:${role.id}`)
        .setLabel(label).setStyle(STYLES[color]);
      const emoji = interaction.options.getString('emoji');
      if (emoji) {
        const custom = /^<a?:\w{2,32}:\d{17,20}>$/.test(emoji);
        if (!custom && !/\p{Extended_Pictographic}|\p{Emoji_Presentation}|[0-9#*]\uFE0F?\u20E3/u.test(emoji)) {
          throw new Error('Utilise un emoji Unicode ou un emoji Discord au format <:nom:identifiant>.');
        }
        const parsed = parseEmoji(emoji);
        if (!parsed) throw new Error('Emoji non reconnu.');
        button.setEmoji(parsed);
      }
      const channel = interaction.options.getChannel('salon') || interaction.channel;
      if (!channel || channel.guildId !== guild.id || !channel.isTextBased() || !channel.isSendable()) {
        throw new Error('Choisis un salon textuel accessible de ce serveur.');
      }
      const sendPermission = channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
      for (const member of [actor, bot]) {
        const permissions = channel.permissionsFor(member);
        if (!permissions?.has([PermissionFlagsBits.ViewChannel, sendPermission])) {
          throw new Error('Toi et le bot devez pouvoir voir ce salon et y envoyer des messages.');
        }
      }
      const sent = await channel.send({
        content: message, components: [new ActionRowBuilder().addComponents(button)],
        allowedMentions: { parse: [] },
      });
      await interaction.editReply({
        content: `Message publié : ${sent.url}\nLe bouton ajoute ou retire le rôle <@&${role.id}> à la personne qui clique.`,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      await interaction.editReply({
        content: error.code
          ? 'Publication impossible : vérifie les accès au salon, la hiérarchie des rôles et l’emoji choisi.'
          : error.message,
        allowedMentions: { parse: [] },
      });
    }
  }

  async function toggle(interaction) {
    const match = interaction.customId.match(/^selfrole:v1:(\d{17,20}):(\d{17,20})$/);
    if (!match || match[1] !== interaction.guildId ||
        interaction.message?.author?.id !== interaction.client.user.id) {
      await interaction.reply({ content: 'Ce bouton de rôle n’est pas valide sur ce serveur.', ephemeral: true });
      return;
    }
    const key = `${interaction.guildId}:${interaction.user.id}:${match[2]}`;
    if (busy.has(key)) {
      await interaction.reply({ content: 'Ton changement de rôle est déjà en cours. Patiente un instant.', ephemeral: true });
      return;
    }
    busy.add(key);
    try {
      await interaction.deferReply({ ephemeral: true });
      const guild = interaction.guild;
      const role = await guild.roles.fetch(match[2], { force: true });
      if (!role) throw new Error('Ce rôle n’existe plus. Demande au staff de remplacer le message.');
      const bot = await guild.members.fetchMe({ force: true });
      assertSafeRole(role, guild, bot, settingsSource());
      // Force a REST read: cached roles may be outdated after another change.
      const member = await guild.members.fetch({ user: interaction.user.id, force: true });
      const hadRole = member.roles.cache.has(role.id);
      if (hadRole) await member.roles.remove(role.id, 'Retrait volontaire via un bouton de rôle');
      else await member.roles.add(role.id, 'Attribution volontaire via un bouton de rôle');
      await interaction.editReply({
        content: `Le rôle <@&${role.id}> t’a été ${hadRole ? 'retiré' : 'ajouté'}.`,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      const response = {
        content: error.code ? 'Impossible de modifier ton rôle. Demande au staff de vérifier les permissions et la hiérarchie du bot.' : error.message,
        allowedMentions: { parse: [] },
      };
      if (interaction.deferred || interaction.replied) await interaction.editReply(response);
      else await interaction.reply({ ...response, ephemeral: true });
    } finally {
      busy.delete(key);
    }
  }

  async function handle(interaction) {
    const command = interaction.isChatInputCommand() && interaction.commandName === 'bouton-role';
    const button = interaction.isButton() && interaction.customId.startsWith('selfrole:');
    if (!command && !button) return false;
    if (!interaction.guildId || !interaction.guild) {
      await interaction.reply({ content: 'Cette fonctionnalité s’utilise uniquement dans un serveur.', ephemeral: true });
      return true;
    }
    if (command) await publish(interaction);
    else await toggle(interaction);
    return true;
  }

  return { handle };
}

module.exports = { createRoleButtonHandler, assertSafeRole, protectedRoles };
