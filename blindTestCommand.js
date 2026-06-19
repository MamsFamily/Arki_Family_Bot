'use strict';

/**
 * blindTestCommand.js — Gestionnaire de la commande /blindtest
 */

const { startGame, stopGame, showLeaderboard } = require('./blindTestManager');

async function handleBlindTestCommand(interaction) {
  const sub = interaction.options.getSubcommand(false);

  if (!sub || sub === 'start') {
    return startGame(interaction);
  }
  if (sub === 'stop') {
    // Réservé aux admins/modérateurs
    if (!interaction.member.permissions.has('ManageMessages') && !interaction.member.permissions.has('Administrator')) {
      return interaction.reply({ content: '❌ Seuls les modérateurs peuvent arrêter une partie.', ephemeral: true });
    }
    return stopGame(interaction);
  }
  if (sub === 'classement') {
    return showLeaderboard(interaction);
  }

  return interaction.reply({ content: '❌ Sous-commande inconnue.', ephemeral: true });
}

module.exports = { handleBlindTestCommand };
