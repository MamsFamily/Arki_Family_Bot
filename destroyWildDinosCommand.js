const crypto = require('crypto');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const legion = require('./web/legionManager');
const journal = require('./web/legionJournal');
const { getSettings } = require('./settingsManager');

const PREFIX = 'legion:wild:';
const ADMIN_ROLE_ID = '1157044417526509578';
const CONFIRMATION_MS = 2 * 60 * 1000;

function createDestroyWildDinosHandler(deps = {}) {
  const maps = deps.legion || legion;
  const events = deps.journal || journal;
  const settings = deps.getSettings || getSettings;
  const pending = new Map();

  function authorized(interaction) {
    if (!interaction.guildId) return false;
    if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
    const roles = interaction.member?.roles;
    const allowed = new Set([ADMIN_ROLE_ID, ...(settings().serverPanel?.adminRoleIds || [])]);
    return [...allowed].some(id => roles?.cache?.has(id) || (Array.isArray(roles) && roles.includes(id)));
  }

  async function handle(interaction) {
    const isCommand = interaction.isChatInputCommand() && interaction.commandName === 'destroywilddinos';
    const isButton = interaction.isButton() && interaction.customId.startsWith(PREFIX);
    if (!isCommand && !isButton) return false;
    if (!authorized(interaction)) {
      await interaction.reply({ content: 'Commande réservée aux administrateurs du serveur.', ephemeral: true });
      return true;
    }

    if (isCommand) {
      const selected = interaction.options.getString('carte', true);
      if (selected !== 'all') {
        try { maps.assertMap(selected); }
        catch (error) {
          await interaction.reply({ content: 'Carte Legion non autorisée.', ephemeral: true });
          return true;
        }
      }
      const ids = selected === 'all' ? maps.MAPS.map(map => map.id) : [selected];
      const names = ids.map(id => maps.MAPS.find(map => map.id === id).name);
      const nonce = crypto.randomUUID();
      for (const [key, request] of pending) {
        if (request.expiresAt < Date.now()) pending.delete(key);
      }
      pending.set(nonce, { ids, userId: interaction.user.id, guildId: interaction.guildId,
        expiresAt: Date.now() + CONFIRMATION_MS });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${PREFIX}confirm:${nonce}`).setLabel('Confirmer le wipe').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`${PREFIX}cancel:${nonce}`).setLabel('Annuler').setStyle(ButtonStyle.Secondary)
      );
      await interaction.reply({
        content: `DestroyWildDinos sur **${names.length} carte${names.length > 1 ? 's' : ''}** : ${names.join(', ')}.\n` +
          'Les dinos sauvages seront supprimés et réapparaîtront naturellement ; les dinos apprivoisés ne sont pas concernés. Confirmer ?',
        components: [row],
        ephemeral: true,
      });
      return true;
    }

    const [, , action, nonce] = interaction.customId.split(':');
    const request = pending.get(nonce);
    if (!request || request.expiresAt < Date.now()) {
      pending.delete(nonce);
      await interaction.update({ content: 'Confirmation expirée. Relance /destroywilddinos.', components: [] });
      return true;
    }
    if (request.userId !== interaction.user.id || request.guildId !== interaction.guildId) {
      await interaction.reply({ content: 'Cette confirmation appartient à un autre administrateur.', ephemeral: true });
      return true;
    }
    if (action !== 'confirm' && action !== 'cancel') {
      await interaction.reply({ content: 'Action non reconnue.', ephemeral: true });
      return true;
    }
    pending.delete(nonce); // Un clic ne peut déclencher qu'une seule série de commandes.
    if (action === 'cancel') {
      await interaction.update({ content: 'DestroyWildDinos annulé. Aucune commande envoyée.', components: [] });
      return true;
    }

    await interaction.deferUpdate();
    await interaction.editReply({ content: `Envoi de DestroyWildDinos sur ${request.ids.length} carte(s)…`, components: [] });
    const results = [];
    for (const id of request.ids) {
      try {
        results.push(await events.execute(id, 'wild_dinos', 'discord', interaction.user.id));
      } catch (error) {
        results.push({ id, ok: false, error: error.message });
      }
    }
    const accepted = results.filter(result => result.ok).length;
    const failed = results.filter(result => !result.ok);
    await interaction.editReply({
      content: `${accepted}/${results.length} commande(s) acceptée(s) par GPanel. L'effet en jeu n'est pas confirmé.` +
        (failed.length ? `\nÉchecs : ${failed.map(result =>
          `${maps.MAPS.find(map => map.id === result.id)?.name || result.id} (${result.error})`).join(', ')}` : ''),
      components: [],
    });
    return true;
  }

  return { handle };
}

module.exports = { createDestroyWildDinosHandler };