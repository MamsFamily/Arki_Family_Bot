const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const { jouerBlackjack, tirer, rester, chargerParties } = require('./Utils/blackjack');
const { chargerParis, sauvegarderParis } = require('./Utils/roulette');
const { jouerSlotsProgressif } = require('./Utils/slots');
const { initPartie, ajouterParticipant, lancerPartie, chargerPartie, resetPartie } = require('./Utils/rouletterusse');
const {
  executerPoker,
  executerCreerTable,
  executerRejoindreTable,
  executerQuitterTable,
  executerRejoindreListeAttente,
  executerStartPartie,
  executerVoirMesCartes,
  executerRelaunch,
} = require('./Utils/poker');
const { executerCheck, executerCall, executerRaise, executerFold, executerAllIn } = require('./Utils/pokerLogic');
const { chargerInventaire, sauvegarderInventaire, setBalance } = require('./Utils/inventaire');
const fs = require('fs');
const path = require('path');
const TABLES_PATH = path.join(__dirname, 'data', 'tables.json');

const ROULETTE_MS = 30000;
const ROULETTE_RUSSE_MIN = 2;
const COLOR = '#2b2d31';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildCountdownBar(remaining, total) {
  const BAR_LEN = 20;
  const filled = Math.round(((total - remaining) / total) * BAR_LEN);
  const empty = BAR_LEN - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  return `⏳ \`[${bar}]\``;
}

function menuCasinoEmbed() {
  return new EmbedBuilder()
    .setTitle('🎰 Casino Arki')
    .setDescription(
      '**Choisis ton jeu :**\n\n' +
      '🎰 **Slots** — Tente ta chance sur les rouleaux\n' +
      '🃏 **Blackjack** — Bats le croupier\n' +
      '🎡 **Roulette** — Rouge, noir ou numéro (résolution 30s)\n' +
      '🔫 **Roulette Russe** — Multi-joueurs, un seul survivant... ou plusieurs !\n' +
      '♠️ **Poker** — Texas Hold\'em avec tables privées'
    )
    .setColor(COLOR);
}

function menuCasinoRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('casino_slots').setLabel('🎰 Slots').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('casino_blackjack').setLabel('🃏 Blackjack').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('casino_roulette').setLabel('🎡 Roulette').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('casino_rouletterusse').setLabel('🔫 Roulette Russe').setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('casino_poker').setLabel('♠️ Poker').setStyle(ButtonStyle.Success),
    ),
  ];
}

// ─── Sync DB → local JSON avant une opération poker ──────────────────────────
function syncPlayersToLocalJson(playerIds, getPlayerInventory) {
  const inv = chargerInventaire();
  for (const id of playerIds) {
    const playerInv = getPlayerInventory(id);
    const diamonds = playerInv['diamants'] || 0;
    setBalance(inv, id, diamonds);
  }
  sauvegarderInventaire(inv);
}

// Sync local JSON → DB après la fin d'une partie poker
const { getBalance: getPokerBalance } = require('./Utils/inventaire');
async function syncPokerWinnersToDb(playerIds, getPlayerInventory, addToInventory, removeFromInventory) {
  const inv = chargerInventaire();
  for (const id of playerIds) {
    const localBalance = getPokerBalance(inv, id);
    const dbBalance = (getPlayerInventory(id)['diamants']) || 0;
    const diff = localBalance - dbBalance;
    if (diff > 0) await addToInventory(id, 'diamants', diff, 'Casino', 'Gain poker');
    else if (diff < 0) await removeFromInventory(id, 'diamants', Math.abs(diff), 'Casino', 'Perte poker');
  }
}

async function getCasinoConfig(pgStore) {
  return (await pgStore.getData('casino_config')) || {};
}

async function checkCasinoChannel(interaction, pgStore) {
  const config = await getCasinoConfig(pgStore);
  if (!config.channelId) return true; // pas de restriction configurée
  return interaction.channelId === config.channelId;
}

function getPlayerDiamonds(getPlayerInventory, userId) {
  const inv = getPlayerInventory(userId);
  return inv['diamants'] || 0;
}

// ─── /casino ─────────────────────────────────────────────────────────────────

async function handleCasinoCommand(interaction, pgStore) {
  const allowed = await checkCasinoChannel(interaction, pgStore);
  if (!allowed) {
    const config = await getCasinoConfig(pgStore);
    return interaction.reply({
      content: `❌ Le casino est uniquement disponible dans <#${config.channelId}>.`,
      ephemeral: true,
    });
  }
  await interaction.reply({ embeds: [menuCasinoEmbed()], components: menuCasinoRow() });
}

// ─── BOUTONS MENU ─────────────────────────────────────────────────────────────

async function handleCasinoSlotsButton(interaction) {
  const modal = new ModalBuilder()
    .setCustomId('casino_slots_modal')
    .setTitle('🎰 Machine à Sous');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('mise')
        .setLabel('Mise (💎 diamants)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('ex: 50')
    )
  );
  await interaction.showModal(modal);
}

async function handleCasinoBlackjackButton(interaction) {
  const modal = new ModalBuilder()
    .setCustomId('casino_blackjack_modal')
    .setTitle('🃏 Blackjack');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('mise')
        .setLabel('Mise (💎 diamants)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('ex: 100')
    )
  );
  await interaction.showModal(modal);
}

async function handleCasinoRouletteButton(interaction) {
  const modal = new ModalBuilder()
    .setCustomId('casino_roulette_modal')
    .setTitle('🎡 Roulette');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('mise')
        .setLabel('Mise (💎 diamants)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('ex: 200')
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('choix')
        .setLabel('Choix : rouge / noir / numéro (0-36)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('ex: rouge  ou  17')
    )
  );
  await interaction.showModal(modal);
}

async function handleCasinoRRButton(interaction) {
  const partie = chargerPartie();
  const embed = new EmbedBuilder()
    .setTitle('🔫 Roulette Russe')
    .setColor(COLOR);

  const rows = [];

  if (!partie.participants || partie.participants.length === 0) {
    embed.setDescription('Aucune partie en cours.\nCrée une partie pour commencer !');
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('casino_rr_creer').setLabel('Créer une partie').setStyle(ButtonStyle.Danger)
    ));
  } else {
    const liste = partie.participants.map(p => `• ${p.nom}`).join('\n');
    embed.setDescription(
      `**Mise :** ${partie.mise} 💎\n` +
      `**Participants (${partie.participants.length}/6) :**\n${liste}\n\n` +
      `Minimum ${ROULETTE_RUSSE_MIN} joueurs pour lancer.`
    );
    const row = new ActionRowBuilder();
    row.addComponents(
      new ButtonBuilder().setCustomId('casino_rr_rejoindre').setLabel('Rejoindre').setStyle(ButtonStyle.Secondary)
    );
    if (partie.participants.length >= ROULETTE_RUSSE_MIN) {
      row.addComponents(
        new ButtonBuilder().setCustomId('casino_rr_lancer').setLabel('🔫 Lancer !').setStyle(ButtonStyle.Danger)
      );
    }
    rows.push(row);
  }

  await interaction.reply({ embeds: [embed], components: rows, ephemeral: true });
}

// ─── MODALS ───────────────────────────────────────────────────────────────────

async function handleSlotModal(interaction, { getPlayerInventory, addToInventory, removeFromInventory }) {
  await interaction.deferReply();
  const userId = interaction.user.id;
  const mise = parseInt(interaction.fields.getTextInputValue('mise'), 10);

  if (isNaN(mise) || mise <= 0) {
    return interaction.editReply({ content: '❌ Mise invalide.' });
  }

  const balance = getPlayerDiamonds(getPlayerInventory, userId);
  if (balance < mise) {
    return interaction.editReply({ content: `❌ Solde insuffisant. Tu as **${balance} 💎**.` });
  }

  await removeFromInventory(userId, 'diamants', mise, 'Casino', 'Mise slots');

  const { rouleaux, gain, multiplicateur } = jouerSlotsProgressif(userId, mise);

  if (gain > 0) {
    await addToInventory(userId, 'diamants', gain, 'Casino', 'Gain slots');
  }

  const newBalance = getPlayerDiamonds(getPlayerInventory, userId);
  const affichage = rouleaux.join(' | ');
  const embed = new EmbedBuilder()
    .setTitle('🎰 Machines à Sous')
    .setColor(gain > 0 ? '#57F287' : '#ED4245')
    .addFields(
      { name: 'Résultat', value: affichage, inline: false },
      { name: 'Mise', value: `${mise} 💎`, inline: true },
      { name: 'Gain', value: gain > 0 ? `+${gain} 💎 (×${multiplicateur})` : '❌ Perdu', inline: true },
      { name: 'Solde', value: `${newBalance} 💎`, inline: true }
    );

  await interaction.editReply({ embeds: [embed] });
}

async function handleBlackjackModal(interaction, { getPlayerInventory, addToInventory, removeFromInventory }) {
  const userId = interaction.user.id;
  const mise = parseInt(interaction.fields.getTextInputValue('mise'), 10);

  if (isNaN(mise) || mise <= 0) {
    return interaction.reply({ content: '❌ Mise invalide.', ephemeral: true });
  }

  const balance = getPlayerDiamonds(getPlayerInventory, userId);
  if (balance < mise) {
    return interaction.reply({ content: `❌ Solde insuffisant. Tu as **${balance} 💎**.`, ephemeral: true });
  }

  // Vérifier qu'il n'a pas déjà une partie
  const parties = chargerParties();
  if (parties[userId] && parties[userId].etat === 'en cours') {
    return interaction.reply({ content: '❌ Tu as déjà une partie de Blackjack en cours. Termine-la d\'abord.', ephemeral: true });
  }

  await removeFromInventory(userId, 'diamants', mise, 'Casino', 'Mise blackjack');
  jouerBlackjack(userId, mise);

  const partiesAfter = chargerParties();
  const partie = partiesAfter[userId];
  const score = partie.cartes.reduce((a, b) => a + b, 0);

  const embed = new EmbedBuilder()
    .setTitle('🃏 Blackjack')
    .setColor(COLOR)
    .setDescription(`Mise : **${mise} 💎** | Solde restant : **${getPlayerDiamonds(getPlayerInventory, userId)} 💎**`)
    .addFields(
      { name: 'Tes cartes', value: `${partie.cartes.join(' + ')} = **${score}**`, inline: true }
    );

  if (score === 21) {
    const gainBJ = Math.floor(mise * 2.5);
    await addToInventory(userId, 'diamants', gainBJ, 'Casino', 'Blackjack naturel');
    embed.setColor('#F1C40F').addFields({ name: '🎉 Blackjack Naturel !', value: `Tu remportes **${gainBJ} 💎** !`, inline: false });
    return interaction.reply({ embeds: [embed] });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`casino_bj_tirer_${userId}`).setLabel('Tirer').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`casino_bj_rester_${userId}`).setLabel('Rester').setStyle(ButtonStyle.Secondary),
  );

  await interaction.reply({ embeds: [embed], components: [row] });
}

async function handleRouletteModal(interaction, { getPlayerInventory, addToInventory, removeFromInventory, pgStore, client }) {
  const userId = interaction.user.id;
  const mise = parseInt(interaction.fields.getTextInputValue('mise'), 10);
  const choix = interaction.fields.getTextInputValue('choix').toLowerCase().trim();

  if (isNaN(mise) || mise <= 0) {
    return interaction.reply({ content: '❌ Mise invalide.', ephemeral: true });
  }

  const choixOk = choix === 'rouge' || choix === 'noir' || (!isNaN(parseInt(choix)) && parseInt(choix) >= 0 && parseInt(choix) <= 36);
  if (!choixOk) {
    return interaction.reply({ content: '❌ Choix invalide. Tape `rouge`, `noir`, ou un numéro entre 0 et 36.', ephemeral: true });
  }

  const balance = getPlayerDiamonds(getPlayerInventory, userId);
  if (balance < mise) {
    return interaction.reply({ content: `❌ Solde insuffisant. Tu as **${balance} 💎**.`, ephemeral: true });
  }

  const paris = chargerParis();
  if (paris[userId]) {
    return interaction.reply({ content: '❌ Tu as déjà un pari en attente.', ephemeral: true });
  }

  await removeFromInventory(userId, 'diamants', mise, 'Casino', 'Mise roulette casino');

  paris[userId] = { mise, choix, placedAt: Date.now() };
  sauvegarderParis(paris);

  const channelId = interaction.channelId;
  const totalSeconds = ROULETTE_MS / 1000;

  await interaction.reply({
    content: `✅ Pari enregistré : **${mise} 💎** sur **${choix}**.\n⏳ Résolution dans **${totalSeconds}** secondes...`,
  });

  // Récupère le message envoyé pour l'éditer chaque seconde
  const replyMsg = await interaction.fetchReply();
  let remaining = totalSeconds - 1;

  const ticker = setInterval(async () => {
    try {
      if (remaining > 0) {
        const bar = buildCountdownBar(remaining, totalSeconds);
        await replyMsg.edit({
          content: `✅ Pari enregistré : **${mise} 💎** sur **${choix}**.\n${bar} **${remaining}s**`,
        });
        remaining--;
      } else {
        clearInterval(ticker);

        // ── Résolution ──────────────────────────────────────────────────────
        const allParis = chargerParis();
        const pari = allParis[userId];
        if (!pari) return;

        const tirage = Math.floor(Math.random() * 37);
        const couleur = tirage === 0 ? 'vert' : (tirage % 2 === 0 ? 'noir' : 'rouge');
        let gain = 0;
        let resultLine = '';

        if (pari.choix === 'rouge' || pari.choix === 'noir') {
          if (pari.choix === couleur) {
            gain = pari.mise * 2;
            resultLine = `✅ **Gagné !** Tu misais sur **${pari.choix}**, le tirage est **${couleur}**. +**${gain} 💎**`;
          } else {
            resultLine = `❌ **Perdu.** Tu misais sur **${pari.choix}**, le tirage est **${couleur}**.`;
          }
        } else {
          const numero = parseInt(pari.choix);
          if (numero === tirage) {
            gain = pari.mise * 36;
            resultLine = `🎉 **Numéro exact ! ${tirage}** — Tu remportes **${gain} 💎** (×36) !`;
          } else {
            resultLine = `❌ **Perdu.** Tu misais sur **${pari.choix}**, le tirage est **${tirage} (${couleur})**.`;
          }
        }

        if (gain > 0) {
          await addToInventory(userId, 'diamants', gain, 'Casino', 'Gain roulette casino');
        }

        delete allParis[userId];
        sauvegarderParis(allParis);

        // Édite le message de pari pour signaler la résolution
        try {
          await replyMsg.edit({ content: `🎡 Résolution en cours...` });
        } catch {}

        const embed = new EmbedBuilder()
          .setTitle('🎡 Roulette — Résultat')
          .setColor(gain > 0 ? '#57F287' : '#ED4245')
          .setDescription(`<@${userId}>\n\n**Tirage : ${tirage} (${couleur})**\n\n${resultLine}`);

        try {
          const channel = await client.channels.fetch(channelId);
          await channel.send({ embeds: [embed] });
        } catch {}
      }
    } catch (err) {
      clearInterval(ticker);
      console.error('[Casino Roulette ticker]', err);
    }
  }, 1000);
}

// ─── BLACKJACK : boutons tirer / rester ──────────────────────────────────────

async function handleBJTirer(interaction, targetUserId, { getPlayerInventory }) {
  if (interaction.user.id !== targetUserId) {
    return interaction.reply({ content: '❌ Ce n\'est pas ta partie.', ephemeral: true });
  }
  await interaction.deferUpdate();

  const result = tirer(targetUserId);
  if (!result) return interaction.editReply({ content: '❌ Aucune partie en cours.', components: [] });

  const { cartes, score, etat } = result;
  const embed = new EmbedBuilder().setTitle('🃏 Blackjack').setColor(COLOR)
    .addFields({ name: 'Tes cartes', value: `${cartes.join(' + ')} = **${score}**`, inline: false });

  if (etat === 'perdu') {
    embed.setColor('#ED4245').addFields({ name: 'Résultat', value: '❌ Tu as dépassé 21. Perdu !', inline: false });
    return interaction.editReply({ embeds: [embed], components: [] });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`casino_bj_tirer_${targetUserId}`).setLabel('Tirer').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`casino_bj_rester_${targetUserId}`).setLabel('Rester').setStyle(ButtonStyle.Secondary),
  );
  await interaction.editReply({ embeds: [embed], components: [row] });
}

async function handleBJRester(interaction, targetUserId, { getPlayerInventory, addToInventory }) {
  if (interaction.user.id !== targetUserId) {
    return interaction.reply({ content: '❌ Ce n\'est pas ta partie.', ephemeral: true });
  }
  await interaction.deferUpdate();

  const parties = chargerParties();
  const partie = parties[targetUserId];
  const mise = partie ? partie.mise : 0;

  const result = rester(targetUserId);
  if (!result) return interaction.editReply({ content: '❌ Aucune partie en cours.', components: [] });

  const { joueur, joueurScore, croupier, croupierScore, resultat } = result;

  // Recalculer le gain proprement depuis les scores (le fichier blackjack.js crédite le JSON local — on ignore)
  let gain = 0;
  if (joueurScore <= 21) {
    if (croupierScore > 21 || joueurScore > croupierScore) {
      gain = mise * 2;
    } else if (joueurScore === croupierScore) {
      gain = mise; // remboursement
    }
  }

  if (gain > 0) {
    await addToInventory(targetUserId, 'diamants', gain, 'Casino', 'Gain blackjack');
  }

  const balanceAfter = getPlayerDiamonds(getPlayerInventory, targetUserId);
  const embed = new EmbedBuilder()
    .setTitle('🃏 Blackjack — Résultat')
    .setColor(gain > 0 ? '#57F287' : '#ED4245')
    .addFields(
      { name: 'Tes cartes', value: `${joueur.join(' + ')} = **${joueurScore}**`, inline: true },
      { name: 'Croupier', value: `${croupier.join(' + ')} = **${croupierScore}**`, inline: true },
      { name: 'Résultat', value: resultat, inline: false },
      { name: 'Solde', value: `${balanceAfter} 💎`, inline: true }
    );

  await interaction.editReply({ embeds: [embed], components: [] });
}

// ─── ROULETTE RUSSE ───────────────────────────────────────────────────────────

async function handleRRCreerButton(interaction) {
  const modal = new ModalBuilder()
    .setCustomId('casino_rr_creer_modal')
    .setTitle('🔫 Créer une Roulette Russe');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('mise')
        .setLabel('Mise par joueur (💎 diamants)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('ex: 100')
    )
  );
  await interaction.showModal(modal);
}

async function handleRRCreerModal(interaction, { getPlayerInventory, removeFromInventory }) {
  const userId = interaction.user.id;
  const username = interaction.member?.displayName || interaction.user.username;
  const mise = parseInt(interaction.fields.getTextInputValue('mise'), 10);

  if (isNaN(mise) || mise <= 0) {
    return interaction.reply({ content: '❌ Mise invalide.', ephemeral: true });
  }

  const partie = chargerPartie();
  if (partie.participants && partie.participants.length > 0) {
    return interaction.reply({ content: '❌ Une partie est déjà en cours. Rejoins-la ou attends qu\'elle se termine.', ephemeral: true });
  }

  const balance = getPlayerDiamonds(getPlayerInventory, userId);
  if (balance < mise) {
    return interaction.reply({ content: `❌ Solde insuffisant. Tu as **${balance} 💎**.`, ephemeral: true });
  }

  await removeFromInventory(userId, 'diamants', mise, 'Casino', 'Mise roulette russe');
  initPartie(userId, username, mise);

  const embed = new EmbedBuilder()
    .setTitle('🔫 Roulette Russe — Partie créée !')
    .setColor(COLOR)
    .setDescription(
      `**Mise :** ${mise} 💎\n**Participants :** ${username}\n\n` +
      `Minimum **${ROULETTE_RUSSE_MIN}** joueurs pour lancer. Attends que d'autres rejoignent !`
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('casino_rr_rejoindre').setLabel('Rejoindre').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('casino_rouletterusse').setLabel('Rafraîchir').setStyle(ButtonStyle.Primary),
  );

  await interaction.reply({ embeds: [embed], components: [row] });
}

async function handleRRRejoindre(interaction, { getPlayerInventory, removeFromInventory }) {
  const userId = interaction.user.id;
  const username = interaction.member?.displayName || interaction.user.username;
  const partie = chargerPartie();

  if (!partie.participants || partie.participants.length === 0) {
    return interaction.reply({ content: '❌ Aucune partie en cours. Crée-en une !', ephemeral: true });
  }

  if (partie.participants.find(p => String(p.id) === userId)) {
    return interaction.reply({ content: '❌ Tu participes déjà à cette partie.', ephemeral: true });
  }

  if (partie.participants.length >= 6) {
    return interaction.reply({ content: '❌ La partie est complète (6/6).', ephemeral: true });
  }

  const balance = getPlayerDiamonds(getPlayerInventory, userId);
  if (balance < partie.mise) {
    return interaction.reply({ content: `❌ Solde insuffisant. La mise est de **${partie.mise} 💎** et tu as **${balance} 💎**.`, ephemeral: true });
  }

  await removeFromInventory(userId, 'diamants', partie.mise, 'Casino', 'Mise roulette russe');
  const ok = ajouterParticipant(userId, username);

  if (!ok) {
    return interaction.reply({ content: '❌ Impossible de rejoindre la partie (complète ou déjà lancée).', ephemeral: true });
  }

  const partieApres = chargerPartie();
  const liste = partieApres.participants.map(p => `• ${p.nom}`).join('\n');
  const embed = new EmbedBuilder()
    .setTitle('🔫 Roulette Russe')
    .setColor(COLOR)
    .setDescription(
      `**Mise :** ${partieApres.mise} 💎\n` +
      `**Participants (${partieApres.participants.length}/6) :**\n${liste}`
    );

  const row = new ActionRowBuilder();
  row.addComponents(new ButtonBuilder().setCustomId('casino_rr_rejoindre').setLabel('Rejoindre').setStyle(ButtonStyle.Secondary));
  if (partieApres.participants.length >= ROULETTE_RUSSE_MIN) {
    row.addComponents(new ButtonBuilder().setCustomId('casino_rr_lancer').setLabel('🔫 Lancer !').setStyle(ButtonStyle.Danger));
  }

  await interaction.reply({ embeds: [embed], components: [row] });
}

async function handleRRLancer(interaction, { addToInventory }) {
  const userId = interaction.user.id;
  const partie = chargerPartie();

  if (!partie.participants || partie.participants.length < ROULETTE_RUSSE_MIN) {
    return interaction.reply({ content: `❌ Pas assez de participants (minimum ${ROULETTE_RUSSE_MIN}).`, ephemeral: true });
  }

  if (!partie.participants.find(p => String(p.id) === userId)) {
    return interaction.reply({ content: '❌ Seul un participant peut lancer la partie.', ephemeral: true });
  }

  await interaction.deferReply();

  // Calcul du gain par survivant (fait aussi par lancerPartie mais on le recalcule pour le DB)
  const nbJoueurs = partie.participants.length;
  const potTotal = partie.mise * nbJoueurs;

  const resultat = lancerPartie();
  if (!resultat) {
    return interaction.editReply({ content: '❌ Erreur lors du lancement.' });
  }

  const { victime, survivants, gainParSurvivant } = resultat;

  // Créditer les survivants dans notre DB (lancerPartie crédite dans le JSON local — on l'ignore)
  for (const p of survivants) {
    await addToInventory(String(p.id), 'diamants', gainParSurvivant, 'Casino', 'Gain roulette russe');
  }

  resetPartie();

  await interaction.editReply({ content: '🔫 Le barillet tourne...' });

  setTimeout(async () => {
    try { await interaction.editReply({ content: '😰 Suspense... *clic*...' }); } catch {}
  }, 2000);

  setTimeout(async () => {
    try {
      const texteSurvivants = survivants.map(p => `• ${p.nom} (+${gainParSurvivant} 💎)`).join('\n');
      const embed = new EmbedBuilder()
        .setTitle('🔫 Roulette Russe — Résultat')
        .setColor('#ED4245')
        .setDescription(
          `💥 **BANG !** <@${victime.id}> (${victime.nom}) a été éliminé !\n\n` +
          `😅 **Survivants :**\n${texteSurvivants}\n\n` +
          `**Pot total :** ${potTotal} 💎 réparti entre ${survivants.length} survivant(s).`
        );
      await interaction.editReply({ embeds: [embed], components: [] });
    } catch {}
  }, 4000);
}

// ─── Enregistrement ───────────────────────────────────────────────────────────

function registerCasinoHandlers(client, deps) {
  const { pgStore, getPlayerInventory, addToInventory, removeFromInventory } = deps;
  const ctx = { getPlayerInventory, addToInventory, removeFromInventory, pgStore, client };

  client.on('interactionCreate', async interaction => {
    try {
      // ── Commandes slash ────────────────────────────────────────────────────
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'casino') {
          return await handleCasinoCommand(interaction, pgStore);
        }
        return;
      }

      // ── Boutons menu principal ─────────────────────────────────────────────
      if (interaction.isButton()) {
        const id = interaction.customId;

        if (id === 'casino_slots')       return await handleCasinoSlotsButton(interaction);
        if (id === 'casino_blackjack')   return await handleCasinoBlackjackButton(interaction);
        if (id === 'casino_roulette')    return await handleCasinoRouletteButton(interaction);
        if (id === 'casino_rouletterusse') return await handleCasinoRRButton(interaction);
        if (id === 'casino_rr_creer')    return await handleRRCreerButton(interaction);
        if (id === 'casino_rr_rejoindre') return await handleRRRejoindre(interaction, ctx);
        if (id === 'casino_rr_lancer')   return await handleRRLancer(interaction, ctx);

        if (id.startsWith('casino_bj_tirer_')) {
          const target = id.replace('casino_bj_tirer_', '');
          return await handleBJTirer(interaction, target, ctx);
        }
        if (id.startsWith('casino_bj_rester_')) {
          const target = id.replace('casino_bj_rester_', '');
          return await handleBJRester(interaction, target, ctx);
        }

        // ── Poker ──────────────────────────────────────────────────────────────
        if (id === 'casino_poker')              return await executerPoker(interaction);
        if (id === 'poker_creer_table')         return await executerCreerTable(interaction);
        if (id === 'poker_quitter_table')       return await executerQuitterTable(interaction);
        if (id === 'poker_rejoindreListeAttente') {
          // Sync balance DB → local JSON avant l'inscription
          syncPlayersToLocalJson([interaction.user.id], ctx.getPlayerInventory);
          return await executerRejoindreListeAttente(interaction);
        }
        if (id === 'poker_start_partie') {
          // Sync balances de tous les joueurs en attente avant le démarrage
          try {
            const raw = fs.readFileSync(TABLES_PATH, 'utf8');
            const tables = JSON.parse(raw);
            const table = tables.find(t => t.threadId === interaction.channelId);
            if (table) {
              const allIds = [...new Set([
                ...(table.enAttenteDeLaProchainePartie || []),
                ...(table.participants || []),
              ])];
              syncPlayersToLocalJson(allIds, ctx.getPlayerInventory);
            }
          } catch {}
          return await executerStartPartie(interaction);
        }
        if (id === 'poker_voir_cartes')   return await executerVoirMesCartes(interaction);
        if (id === 'poker_check')         return await executerCheck(interaction);
        if (id === 'poker_call')          return await executerCall(interaction);
        if (id === 'poker_fold')          return await executerFold(interaction);
        if (id === 'poker_allin')         return await executerAllIn(interaction);
        if (id === 'poker_relaunch') {
          // Sync résultats → DB avant de relancer
          try {
            const raw = fs.readFileSync(TABLES_PATH, 'utf8');
            const tables = JSON.parse(raw);
            const table = tables.find(t => t.threadId === interaction.channelId);
            if (table) {
              const allIds = [...new Set([
                ...(table.dansLaPartie || []),
                ...(table.participants || []),
              ])];
              await syncPokerWinnersToDb(allIds, ctx.getPlayerInventory, ctx.addToInventory, ctx.removeFromInventory);
            }
          } catch (err) {
            console.error('[Casino Poker sync relaunch]', err);
          }
          return await executerRelaunch(interaction);
        }
        if (id.startsWith('poker_rejoindre_')) return await executerRejoindreTable(interaction);
        if (id === 'poker_raise') {
          const { ModalBuilder: MB, TextInputBuilder: TIB, TextInputStyle: TIS, ActionRowBuilder: ARB } = require('discord.js');
          const modal = new MB().setCustomId('poker_raise_modal').setTitle('♠️ Raise');
          modal.addComponents(new ARB().addComponents(new TIB().setCustomId('amount').setLabel('Montant du raise').setStyle(TIS.Short).setRequired(true).setPlaceholder('ex: 100')));
          return await interaction.showModal(modal);
        }

        return;
      }

      // ── Modals ─────────────────────────────────────────────────────────────
      if (interaction.isModalSubmit()) {
        const id = interaction.customId;
        if (id === 'casino_slots_modal')     return await handleSlotModal(interaction, ctx);
        if (id === 'casino_blackjack_modal') return await handleBlackjackModal(interaction, ctx);
        if (id === 'casino_roulette_modal')  return await handleRouletteModal(interaction, ctx);
        if (id === 'casino_rr_creer_modal')  return await handleRRCreerModal(interaction, ctx);
        if (id === 'poker_raise_modal') {
          const amt = parseInt(interaction.fields.getTextInputValue('amount'), 10);
          return await executerRaise(interaction, isNaN(amt) ? 0 : amt);
        }
        return;
      }
    } catch (err) {
      console.error('[Casino Handler]', err);
      try {
        const msg = { content: '❌ Une erreur est survenue dans le casino.', ephemeral: true };
        if (interaction.replied || interaction.deferred) await interaction.followUp(msg);
        else await interaction.reply(msg);
      } catch {}
    }
  });
}

module.exports = { registerCasinoHandlers };
