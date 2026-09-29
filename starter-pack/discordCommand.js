const service = require('./service');

function createStarterPackHandler(deps = {}) {
  const packs = deps.service || service;
  const enabled = deps.enabled || (() => process.env.STARTER_PACK_LINK_ENABLED === 'true');
  const deliveryEnabled = deps.deliveryEnabled || packs.isDeliveryEnabled;

  async function handle(interaction) {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'starterpack') return false;
    if (!interaction.guildId) {
      await interaction.reply({ content: 'Cette commande est disponible sur le serveur Discord.', ephemeral: true });
      return true;
    }
    if (!enabled()) {
      await interaction.reply({ content: 'Le starter pack est en préparation et ne peut pas encore être récupéré.', ephemeral: true });
      return true;
    }
    await interaction.deferReply({ ephemeral: true });
    try {
      const action = interaction.options.getSubcommand();
      const id = interaction.user.id;
      if (action === 'lier') {
        const status = await packs.getStatus(id);
        if (status.linked) {
          await interaction.editReply('Ton compte de jeu est déjà lié. Consulte /starterpack statut.');
        } else {
          const { code, expiresInMinutes } = await packs.issueCode(id);
          await interaction.editReply(
            `Ton code de liaison : **${code}** (valide ${expiresInMinutes} minutes). ` +
            'Saisis-le uniquement dans le système de liaison en jeu. Ne le partage pas.',
          );
        }
      } else if (action === 'statut') {
        const status = await packs.getStatus(id);
        if (!status.linked) {
          await interaction.editReply('Compte de jeu non lié. Utilise /starterpack lier lorsque la liaison en jeu est disponible.');
        } else {
          const label = {
            available: 'Non récupéré', pending: 'Demande en attente de connexion en jeu',
            delivering: 'Remise en cours ou à vérifier par le staff', delivered: 'Pack remis',
          }[status.status] || 'État inconnu';
          await interaction.editReply(`Compte EOS lié (…${status.eosSuffix}). Starter pack : **${label}**.`);
        }
      } else if (action === 'recevoir') {
        if (!deliveryEnabled()) {
          await interaction.editReply('La distribution en jeu n’est pas encore activée : le mod et le pack doivent être validés sur le serveur d’essai.');
        } else {
          const status = await packs.requestClaim(id);
          const messages = {
            pending: 'Demande enregistrée. Connecte-toi en jeu sur une carte du cluster pour recevoir le pack.',
            delivering: 'Une remise est déjà en cours ou doit être vérifiée par le staff. Ne refais pas la demande.',
            delivered: 'Tu as déjà reçu ton starter pack.',
          };
          await interaction.editReply(messages[status] || 'État de demande inconnu : contacte le staff.');
        }
      } else {
        await interaction.editReply('Action inconnue.');
      }
    } catch (error) {
      console.error('[StarterPack] Commande:', error.message);
      await interaction.editReply('Starter pack indisponible ou demande impossible. Réessaie plus tard ou contacte le staff.');
    }
    return true;
  }

  return { handle };
}

module.exports = { createStarterPackHandler };