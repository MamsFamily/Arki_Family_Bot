const { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const inventory = require('./inventoryManager');

async function showVoteRollbackPreview(interaction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const plan = await inventory.prepareVoteRollback({
      actorId: interaction.user.id, guildId: interaction.guildId,
      month: interaction.options.getString('mois'),
      since: interaction.options.getString('depuis'),
    });
    const lines = Object.entries(plan.summary).map(([playerId, items]) =>
      `<@${playerId}> → ${Object.entries(items).map(([id, qty]) => `${qty} × ${id}`).join(' + ')}`);
    const text = lines.join('\n');
    const format = value => new Date(value).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
    const warning = plan.legacy
      ? `**Ancien versement sans identifiant : sélection selon l’heure fournie. Vérifie qu’elle correspond au début du dernier versement.**\nDepuis : ${format(plan.since)} (Paris)\n\n`
      : '**Sélection : dernier lot de votes uniquement.**\n\n';
    const embed = new EmbedBuilder().setColor(0xe74c3c)
      .setTitle('Annuler le dernier versement de votes — aperçu')
      .setDescription(
        warning + `Crédits du ${format(plan.startedAt)} au ${format(plan.endedAt)} (Paris)\n` +
        `${plan.transactions.length} transaction(s) — ${lines.length} joueur(s)\n\n` +
        text.slice(0, 2900) + (text.length > 2900 ? '\nListe complète dans le fichier joint.' : '')
      )
      .setFooter({ text: 'Aucun retrait avant confirmation. Aperçu valable 15 minutes. Les anciens versements restent conservés.' });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`vote_rollback_confirm::${plan.id}`)
        .setLabel('Confirmer le retrait de ce versement').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('vote_rollback_cancel')
        .setLabel('Ne rien retirer').setStyle(ButtonStyle.Secondary),
    );
    return interaction.editReply({
      embeds: [embed], components: [row], allowedMentions: { parse: [] },
      ...(text.length > 2900 ? { files: [{ attachment: Buffer.from(text), name: 'dernier-versement-votes.txt' }] } : {}),
    });
  } catch (error) {
    return interaction.editReply({ content: `Annulation impossible : ${error.message}`, allowedMentions: { parse: [] } });
  }
}

async function handleVoteRollbackConfirmation(interaction) {
  await interaction.deferUpdate();
  const planId = interaction.customId.split('::')[1];
  // Old broad DATE/NAME buttons must never execute after this upgrade.
  if (!/^[0-9a-f-]{36}$/.test(planId || '')) {
    return interaction.editReply({ content: 'Cet ancien aperçu n’est plus utilisable. Relance /annuler-votes-mois pour cibler le dernier versement.', embeds: [], components: [] });
  }
  try {
    const result = await inventory.confirmVoteRollback({
      planId, actorId: interaction.user.id, guildId: interaction.guildId,
    });
    return interaction.editReply({
      content: result.alreadyApplied
        ? 'Ce versement a déjà été annulé. Aucun retrait supplémentaire.'
        : `Dernier versement annulé : ${result.count} transaction(s), ${result.players} joueur(s). Les versements précédents ont été conservés.`,
      embeds: [], components: [], attachments: [], allowedMentions: { parse: [] },
    });
  } catch (error) {
    return interaction.editReply({
      content: `Annulation impossible : ${error.message}`, embeds: [], components: [],
      attachments: [], allowedMentions: { parse: [] },
    });
  }
}

module.exports = { showVoteRollbackPreview, handleVoteRollbackConfirmation };
