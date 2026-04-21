const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
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


const CASINO_LOGO_PATH = path.join(__dirname, '..', 'assets', 'img', 'casino_logo.png');
const SLOTS_LOGO_PATH  = path.join(__dirname, '..', 'assets', 'img', 'slots_logo.png');
const RR_LOGO_PATH     = path.join(__dirname, '..', 'assets', 'img', 'rouletterusse_logo.png');
const ROULETTE_LOGO_PATH = path.join(__dirname, '..', 'assets', 'img', 'roulette_logo.png');
const POKER_LOGO_PATH_HANDLER = path.join(__dirname, '..', 'assets', 'img', 'poker_logo.png');
const BJ_LOGO_PATH = path.join(__dirname, '..', 'assets', 'img', 'blackjack_logo.png');

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
    .setColor(COLOR)
    .setThumbnail('attachment://casino_logo.png');
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
  const casinoLogo = new AttachmentBuilder(CASINO_LOGO_PATH, { name: 'casino_logo.png' });
  await interaction.reply({ embeds: [menuCasinoEmbed()], components: menuCasinoRow(), files: [casinoLogo] });
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
  const rrLogo = new AttachmentBuilder(RR_LOGO_PATH, { name: 'rouletterusse_logo.png' });
  const embed = new EmbedBuilder()
    .setTitle('🔫 Roulette Russe')
    .setColor(COLOR)
    .setThumbnail('attachment://rouletterusse_logo.png');

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

  await interaction.reply({ embeds: [embed], components: rows, files: [rrLogo], ephemeral: true });
}

// ─── MODALS ───────────────────────────────────────────────────────────────────

const SLOT_SYMBOLS = ['🍒', '🍋', '💎', '🔔', '7️⃣'];
const slotRand = () => SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function slotsSpinLine(r1, r2, r3) {
  return `> ${r1 ?? slotRand()} ┃ ${r2 ?? slotRand()} ┃ ${r3 ?? slotRand()}`;
}

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
  const [r1, r2, r3] = rouleaux;

  if (gain > 0) {
    await addToInventory(userId, 'diamants', gain, 'Casino', 'Gain slots');
  }

  // ── Animation : rouleaux qui tournent ──────────────────────────────────────
  // Enveloppée dans un try/catch : si Discord rate-limite ou l'interaction
  // devient inaccessible, on passe directement au résultat final.
  try {
    const spinHeader = '🎰 **Les rouleaux tournent...**';

    for (let i = 0; i < 3; i++) {
      await interaction.editReply({ content: `${spinHeader}\n${slotsSpinLine()}` });
      await sleep(380);
    }

    await interaction.editReply({ content: `${spinHeader}\n${slotsSpinLine(r1)}` });
    await sleep(380);
    await interaction.editReply({ content: `${spinHeader}\n${slotsSpinLine(r1)}` });
    await sleep(380);

    await interaction.editReply({ content: `${spinHeader}\n${slotsSpinLine(r1, r2)}` });
    await sleep(380);
    await interaction.editReply({ content: `${spinHeader}\n${slotsSpinLine(r1, r2)}` });
    await sleep(380);
  } catch {
    // Animation échouée → on affiche directement le résultat final ci-dessous
  }

  // Résultat final — toujours exécuté, même si l'animation a planté
  const newBalance = getPlayerDiamonds(getPlayerInventory, userId);
  const affichage = `${r1} ┃ ${r2} ┃ ${r3}`;

  const slotsLogo = new AttachmentBuilder(SLOTS_LOGO_PATH, { name: 'slots_logo.png' });
  const embed = new EmbedBuilder()
    .setTitle('🎰 Machines à Sous')
    .setColor(gain > 0 ? '#57F287' : '#ED4245')
    .setThumbnail('attachment://slots_logo.png')
    .addFields(
      { name: 'Résultat', value: affichage, inline: false },
      { name: 'Mise', value: `${mise} 💎`, inline: true },
      { name: 'Gain', value: gain > 0 ? `+${gain} 💎 (×${multiplicateur})` : '❌ Perdu', inline: true },
      { name: 'Solde', value: `${newBalance} 💎`, inline: true }
    );

  await interaction.editReply({ content: '', embeds: [embed], files: [slotsLogo] });
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

  const bjLogo1 = new AttachmentBuilder(BJ_LOGO_PATH, { name: 'blackjack_logo.png' });
  const embed = new EmbedBuilder()
    .setTitle('🃏 Blackjack')
    .setColor(COLOR)
    .setThumbnail('attachment://blackjack_logo.png')
    .setDescription(`Mise : **${mise} 💎** | Solde restant : **${getPlayerDiamonds(getPlayerInventory, userId)} 💎**`)
    .addFields(
      { name: 'Tes cartes', value: `${partie.cartes.join(' + ')} = **${score}**`, inline: true }
    );

  if (score === 21) {
    const gainBJ = Math.floor(mise * 2.5);
    await addToInventory(userId, 'diamants', gainBJ, 'Casino', 'Blackjack naturel');
    embed.setColor('#F1C40F').addFields({ name: '🎉 Blackjack Naturel !', value: `Tu remportes **${gainBJ} 💎** !`, inline: false });
    return interaction.reply({ embeds: [embed], files: [bjLogo1] });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`casino_bj_tirer_${userId}`).setLabel('Tirer').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`casino_bj_rester_${userId}`).setLabel('Rester').setStyle(ButtonStyle.Secondary),
  );

  await interaction.reply({ embeds: [embed], components: [row], files: [bjLogo1] });
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
        await replyMsg.edit({
          content: `✅ Pari enregistré : **${mise} 💎** sur **${choix}**.\n⏳ Résolution dans **${remaining}s**...`,
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

        const rouletteLogo = new AttachmentBuilder(ROULETTE_LOGO_PATH, { name: 'roulette_logo.png' });
        const embed = new EmbedBuilder()
          .setTitle('🎡 Roulette — Résultat')
          .setColor(gain > 0 ? '#57F287' : '#ED4245')
          .setThumbnail('attachment://roulette_logo.png')
          .setDescription(`<@${userId}>\n\n**Tirage : ${tirage} (${couleur})**\n\n${resultLine}`);

        try {
          const channel = await client.channels.fetch(channelId);
          await channel.send({ embeds: [embed], files: [rouletteLogo] });
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
  const bjLogo2 = new AttachmentBuilder(BJ_LOGO_PATH, { name: 'blackjack_logo.png' });
  const embed = new EmbedBuilder().setTitle('🃏 Blackjack').setColor(COLOR)
    .setThumbnail('attachment://blackjack_logo.png')
    .addFields({ name: 'Tes cartes', value: `${cartes.join(' + ')} = **${score}**`, inline: false });

  if (etat === 'perdu') {
    embed.setColor('#ED4245').addFields({ name: 'Résultat', value: '❌ Tu as dépassé 21. Perdu !', inline: false });
    return interaction.editReply({ embeds: [embed], components: [], files: [bjLogo2] });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`casino_bj_tirer_${targetUserId}`).setLabel('Tirer').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`casino_bj_rester_${targetUserId}`).setLabel('Rester').setStyle(ButtonStyle.Secondary),
  );
  await interaction.editReply({ embeds: [embed], components: [row], files: [bjLogo2] });
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
  const bjLogo3 = new AttachmentBuilder(BJ_LOGO_PATH, { name: 'blackjack_logo.png' });
  const embed = new EmbedBuilder()
    .setTitle('🃏 Blackjack — Résultat')
    .setColor(gain > 0 ? '#57F287' : '#ED4245')
    .setThumbnail('attachment://blackjack_logo.png')
    .addFields(
      { name: 'Tes cartes', value: `${joueur.join(' + ')} = **${joueurScore}**`, inline: true },
      { name: 'Croupier', value: `${croupier.join(' + ')} = **${croupierScore}**`, inline: true },
      { name: 'Résultat', value: resultat, inline: false },
      { name: 'Solde', value: `${balanceAfter} 💎`, inline: true }
    );

  await interaction.editReply({ embeds: [embed], components: [], files: [bjLogo3] });
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

  const rrLogo2 = new AttachmentBuilder(RR_LOGO_PATH, { name: 'rouletterusse_logo.png' });
  const embed = new EmbedBuilder()
    .setTitle('🔫 Roulette Russe — Partie créée !')
    .setColor(COLOR)
    .setThumbnail('attachment://rouletterusse_logo.png')
    .setDescription(
      `**Mise :** ${mise} 💎\n**Participants :** ${username}\n\n` +
      `Minimum **${ROULETTE_RUSSE_MIN}** joueurs pour lancer. Attends que d'autres rejoignent !`
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('casino_rr_rejoindre').setLabel('Rejoindre').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('casino_rouletterusse').setLabel('Rafraîchir').setStyle(ButtonStyle.Primary),
  );

  await interaction.reply({ embeds: [embed], components: [row], files: [rrLogo2] });
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
  const rrLogo3 = new AttachmentBuilder(RR_LOGO_PATH, { name: 'rouletterusse_logo.png' });
  const embed = new EmbedBuilder()
    .setTitle('🔫 Roulette Russe')
    .setColor(COLOR)
    .setThumbnail('attachment://rouletterusse_logo.png')
    .setDescription(
      `**Mise :** ${partieApres.mise} 💎\n` +
      `**Participants (${partieApres.participants.length}/6) :**\n${liste}`
    );

  const row = new ActionRowBuilder();
  row.addComponents(new ButtonBuilder().setCustomId('casino_rr_rejoindre').setLabel('Rejoindre').setStyle(ButtonStyle.Secondary));
  if (partieApres.participants.length >= ROULETTE_RUSSE_MIN) {
    row.addComponents(new ButtonBuilder().setCustomId('casino_rr_lancer').setLabel('🔫 Lancer !').setStyle(ButtonStyle.Danger));
  }

  await interaction.reply({ embeds: [embed], components: [row], files: [rrLogo3] });
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
  // Note : lancerPartie() appelle déjà resetPartie() en interne — pas besoin de le rappeler ici.

  await interaction.editReply({ content: '🔫 Le barillet tourne...' });

  setTimeout(async () => {
    try { await interaction.editReply({ content: '😰 Suspense... *clic*...' }); } catch {}
  }, 2000);

  setTimeout(async () => {
    try {
      const texteSurvivants = survivants.map(p => `• ${p.nom} (+${gainParSurvivant} 💎)`).join('\n');
      const rrLogo4 = new AttachmentBuilder(RR_LOGO_PATH, { name: 'rouletterusse_logo.png' });
      const embed = new EmbedBuilder()
        .setTitle('🔫 Roulette Russe — Résultat')
        .setColor('#ED4245')
        .setThumbnail('attachment://rouletterusse_logo.png')
        .setDescription(
          `💥 **BANG !** <@${victime.id}> (${victime.nom}) a été éliminé !\n\n` +
          `😅 **Survivants :**\n${texteSurvivants}\n\n` +
          `**Pot total :** ${potTotal} 💎 réparti entre ${survivants.length} survivant(s).`
        );
      await interaction.editReply({ embeds: [embed], components: [], files: [rrLogo4] });
    } catch {}
  }, 4000);
}

// ─── POKER : annonce salon + spectateurs ──────────────────────────────────────

async function handlePokerCreerTable(interaction, ctx) {
  const { client, pgStore } = ctx;
  const userId = interaction.user.id;
  const displayName = interaction.member.displayName;

  // Appel de la fonction originale (crée le thread + reply éphémère)
  await executerCreerTable(interaction);

  // Lire tables.json pour trouver la table fraîchement créée
  let tables = [];
  try {
    const raw = await fs.promises.readFile(TABLES_PATH, 'utf8');
    tables = JSON.parse(raw);
  } catch (e) {
    console.error('[Poker créer table] Lecture tables.json échouée :', e);
    return;
  }

  // Cherche la table du joueur (sans announcementMessageId = pas encore annoncée)
  const table = tables.find(t => t.participants.includes(userId) && !t.announcementMessageId);
  if (!table) {
    console.warn(`[Poker créer table] Table introuvable pour userId=${userId} après création.`);
    return;
  }

  // ── Poser la question spectateurs dans le fil ────────────────────────────
  let thread;
  try {
    thread = await client.channels.fetch(table.threadId);
  } catch (e) {
    console.error(`[Poker créer table] Impossible de fetch le thread ${table.threadId} :`, e);
    return;
  }

  // Verrouiller le fil : les joueurs ne peuvent pas écrire, seul le bot peut.
  // Les boutons restent fonctionnels — les interactions ne nécessitent pas SEND_MESSAGES.
  try {
    await thread.setLocked(true, 'Fil de poker — lecture seule, interactions uniquement');
  } catch (e) {
    console.warn('[Poker créer table] Impossible de verrouiller le thread :', e.message);
  }

  const specRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`poker_spectateurs_oui_${table.threadId}`)
      .setLabel('✅ Oui, autoriser')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`poker_spectateurs_non_${table.threadId}`)
      .setLabel('❌ Non')
      .setStyle(ButtonStyle.Danger),
  );
  try {
    await thread.send({
      content: `<@${userId}> Souhaites-tu autoriser des **spectateurs** à observer la partie ?`,
      components: [specRow],
    });
  } catch (e) {
    console.error('[Poker créer table] Envoi question spectateurs échoué :', e);
  }

  // ── Poster l'annonce dans le salon casino (ou le salon courant si non configuré) ─
  const casinoConfig = await getCasinoConfig(pgStore);

  // Fallback : si aucun salon casino configuré, on poste dans le salon où le bouton a été cliqué
  let casinoChannel;
  if (casinoConfig.channelId) {
    try {
      casinoChannel = await client.channels.fetch(casinoConfig.channelId);
    } catch (e) {
      console.error(`[Poker créer table] Impossible de fetch le salon casino configuré (${casinoConfig.channelId}) :`, e);
    }
  }
  if (!casinoChannel) {
    try {
      casinoChannel = await client.channels.fetch(interaction.channelId);
    } catch (e) {
      console.error('[Poker créer table] Impossible de fetch le salon courant :', e);
      return;
    }
  }

  const announceEmbed = new EmbedBuilder()
    .setTitle('♠️ Nouvelle table de Poker !')
    .setDescription(`**${displayName}** a ouvert une table de Texas Hold'em !\nRejoins la file d'attente pour participer à la prochaine partie.`)
    .setColor('#2ecc71')
    .setFooter({ text: `Fil : ♠️poker-${displayName}` });

  const announceRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`poker_annonce_rejoindre_${table.threadId}`)
      .setLabel('🃏 Rejoindre la partie')
      .setStyle(ButtonStyle.Primary),
  );

  let announceMsg;
  try {
    announceMsg = await casinoChannel.send({ embeds: [announceEmbed], components: [announceRow] });
  } catch (e) {
    console.error('[Poker créer table] Envoi embed annonce échoué :', e);
    return;
  }

  // Sauvegarder les métadonnées dans la table
  table.announcementChannelId = casinoChannel.id;
  table.announcementMessageId = announceMsg.id;
  table.spectatorsAllowed = false;
  try {
    await fs.promises.writeFile(TABLES_PATH, JSON.stringify(tables, null, 2), 'utf8');
  } catch (e) {
    console.error('[Poker créer table] Sauvegarde tables.json échouée :', e);
  }
}

async function handlePokerAnnonceRejoindre(interaction, client) {
  const threadId = interaction.customId.replace('poker_annonce_rejoindre_', '');
  const userId = interaction.user.id;

  // ── Lire tables.json ────────────────────────────────────────────────────────
  let tables = [];
  try {
    const raw = await fs.promises.readFile(TABLES_PATH, 'utf8');
    tables = JSON.parse(raw);
  } catch (e) {
    console.error('[Poker annonce rejoindre] Lecture tables.json :', e);
    return interaction.reply({ content: '❌ Erreur interne, réessaie.', ephemeral: true });
  }

  const table = tables.find(t => t.threadId === threadId);
  if (!table) {
    return interaction.reply({ content: '❌ Cette table n\'existe plus.', ephemeral: true });
  }

  // ── Vérifications file d'attente ────────────────────────────────────────────
  table.enAttenteDeLaProchainePartie ||= [];

  // Seule la file d'attente réelle compte — être dans `participants` (créateur du thread)
  // ne signifie pas être inscrit pour jouer.
  if (table.enAttenteDeLaProchainePartie.includes(userId)) {
    return interaction.reply({
      content: `✅ Tu es déjà inscrit(e) dans la file d'attente ! <#${threadId}>`,
      ephemeral: true,
    });
  }

  if (table.enAttenteDeLaProchainePartie.length >= 10) {
    return interaction.reply({
      content: '❌ La file d\'attente est pleine (10/10).',
      ephemeral: true,
    });
  }

  // ── Ajouter à la file d'attente ──────────────────────────────────────────────
  table.enAttenteDeLaProchainePartie.push(userId);

  try {
    await fs.promises.writeFile(TABLES_PATH, JSON.stringify(tables, null, 2), 'utf8');
  } catch (e) {
    console.error('[Poker annonce rejoindre] Sauvegarde tables.json :', e);
    return interaction.reply({ content: '❌ Erreur lors de l\'enregistrement.', ephemeral: true });
  }

  // ── Ajouter au thread + mettre à jour l'embed de règles ─────────────────────
  let thread;
  try {
    thread = await client.channels.fetch(threadId);
    await thread.members.add(userId);
  } catch (err) {
    console.error('[Poker annonce rejoindre] Accès thread :', err);
    return interaction.reply({
      content: `✅ Tu es inscrit(e) dans la file d'attente, mais le fil est inaccessible. Rejoins-le manuellement : <#${threadId}>`,
      ephemeral: true,
    });
  }

  // ── Trouver le message de règles (celui avec le bouton poker_rejoindreListeAttente) ──
  try {
    const messages = await thread.messages.fetch({ limit: 20 });
    const rulesMsg = messages.find(m =>
      m.components?.some(row =>
        row.components?.some(c => c.customId === 'poker_rejoindreListeAttente')
      )
    );

    if (rulesMsg) {
      const oldEmbed = rulesMsg.embeds[0];
      const waiting = table.enAttenteDeLaProchainePartie;

      // Résolution des noms via Discord
      const names = waiting.length
        ? (await Promise.all(
            waiting.map(async (id, i) => {
              const member = await interaction.guild.members.fetch(id).catch(() => null);
              return `**${i + 1}.** ${member?.displayName || `<@${id}>`}`;
            })
          )).join('\n')
        : 'Aucun joueur';

      // Reconstuire l'embed identiquement à executerRejoindreListeAttente
      const baseFields = (oldEmbed?.fields || []).filter(
        f => !f.name.startsWith('⏱️ En attente de joueurs')
      );
      const newEmbed = new EmbedBuilder()
        .setTitle(oldEmbed?.title || "Règles du Texas Hold'em")
        .setDescription(oldEmbed?.description || '')
        .setColor(COLOR)
        .setThumbnail('attachment://poker_logo.png')
        .addFields([
          ...baseFields,
          { name: `⏱️ En attente de joueurs (${waiting.length}/10)`, value: names },
        ]);

      const inGame = Array.isArray(table.dansLaPartie) && table.dansLaPartie.length > 0;
      const buttons = [
        new ButtonBuilder()
          .setCustomId('poker_rejoindreListeAttente')
          .setLabel('Rejoindre la file')
          .setStyle(ButtonStyle.Primary),
        !inGame && new ButtonBuilder()
          .setCustomId('poker_start_partie')
          .setLabel('Démarrer la partie')
          .setStyle(ButtonStyle.Success)
          .setDisabled(waiting.length < 2),
        new ButtonBuilder()
          .setCustomId('poker_quitter_table')
          .setLabel('Quitter la table')
          .setStyle(ButtonStyle.Danger),
      ].filter(Boolean);

      await rulesMsg.edit({
        embeds: [newEmbed],
        components: [new ActionRowBuilder().addComponents(...buttons)],
        files: [{ attachment: POKER_LOGO_PATH_HANDLER, name: 'poker_logo.png' }],
      });
    }
  } catch (err) {
    console.error('[Poker annonce rejoindre] Mise à jour embed règles :', err);
    // Non bloquant — l'inscription est déjà enregistrée
  }

  // ── Notifier dans le thread ──────────────────────────────────────────────────
  try {
    const pos = table.enAttenteDeLaProchainePartie.length;
    await thread.send(
      `🃏 <@${userId}> a rejoint la file d'attente (**position #${pos}**) et participera à la prochaine partie !`
    );
  } catch {}

  await interaction.reply({
    content: `✅ Tu es inscrit(e) en position **#${table.enAttenteDeLaProchainePartie.length}** dans la file d'attente ! <#${threadId}>`,
    ephemeral: true,
  });
}

async function handlePokerAnnonceSpectateur(interaction, client) {
  const threadId = interaction.customId.replace('poker_annonce_spectateur_', '');
  const userId = interaction.user.id;

  try {
    const thread = await client.channels.fetch(threadId);
    await thread.members.add(userId);
    await thread.send(`👁️ <@${userId}> observe la partie en tant que spectateur.`);
  } catch (err) {
    console.error('[Poker spectateur rejoindre]', err);
    return interaction.reply({ content: '❌ Impossible d\'accéder au fil.', ephemeral: true });
  }

  await interaction.reply({ content: `✅ Tu observes la partie ! <#${threadId}>`, ephemeral: true });
}

async function handlePokerSpectatorsOui(interaction, client) {
  const threadId = interaction.customId.replace('poker_spectateurs_oui_', '');

  let tables = [];
  try {
    const raw = await fs.promises.readFile(TABLES_PATH, 'utf8');
    tables = JSON.parse(raw);
  } catch {
    return interaction.reply({ content: '❌ Erreur lecture tables.', ephemeral: true });
  }

  const table = tables.find(t => t.threadId === threadId);
  if (!table) return interaction.reply({ content: '❌ Table introuvable.', ephemeral: true });
  if (table.participants[0] !== interaction.user.id) {
    return interaction.reply({ content: '❌ Seul le créateur de la table peut modifier ce paramètre.', ephemeral: true });
  }

  table.spectatorsAllowed = true;
  await fs.promises.writeFile(TABLES_PATH, JSON.stringify(tables, null, 2), 'utf8');

  // Mettre à jour l'embed d'annonce pour ajouter le bouton spectateur
  if (table.announcementChannelId && table.announcementMessageId) {
    try {
      const casinoChannel = await client.channels.fetch(table.announcementChannelId);
      const announceMsg = await casinoChannel.messages.fetch(table.announcementMessageId);
      const updatedRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`poker_annonce_rejoindre_${threadId}`)
          .setLabel('🃏 Rejoindre la partie')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`poker_annonce_spectateur_${threadId}`)
          .setLabel('👁️ Spectateur')
          .setStyle(ButtonStyle.Secondary),
      );
      await announceMsg.edit({ embeds: announceMsg.embeds, components: [updatedRow] });
    } catch (err) {
      console.error('[Poker spectateurs update annonce]', err);
    }
  }

  await interaction.update({ content: '✅ Les spectateurs sont autorisés. L\'annonce a été mise à jour.', components: [] });
}

async function handlePokerSpectatorsNon(interaction) {
  const threadId = interaction.customId.replace('poker_spectateurs_non_', '');

  let tables = [];
  try {
    const raw = await fs.promises.readFile(TABLES_PATH, 'utf8');
    tables = JSON.parse(raw);
  } catch {
    return interaction.reply({ content: '❌ Erreur lecture tables.', ephemeral: true });
  }

  const table = tables.find(t => t.threadId === threadId);
  if (!table) return interaction.reply({ content: '❌ Table introuvable.', ephemeral: true });
  if (table.participants[0] !== interaction.user.id) {
    return interaction.reply({ content: '❌ Seul le créateur de la table peut modifier ce paramètre.', ephemeral: true });
  }

  table.spectatorsAllowed = false;
  await fs.promises.writeFile(TABLES_PATH, JSON.stringify(tables, null, 2), 'utf8');
  await interaction.update({ content: '❌ Les spectateurs ne sont pas autorisés.', components: [] });
}

// ─── Enregistrement ───────────────────────────────────────────────────────────

function registerCasinoHandlers(client, deps) {
  const { pgStore, getPlayerInventory, addToInventory, removeFromInventory } = deps;
  const ctx = { getPlayerInventory, addToInventory, removeFromInventory, pgStore, client };

  // ── Guard de démarrage : roulette russe avec participants en attente ────────
  // Si le bot a redémarré pendant qu'une partie était créée mais pas encore lancée,
  // les mises sont déjà déduites. On rembourse et on remet l'état à zéro.
  try {
    const partieRR = chargerPartie();
    if (partieRR.participants && partieRR.participants.length > 0) {
      console.warn(`[Casino RR] Partie orpheline détectée (${partieRR.participants.length} joueur(s)) — remboursement en cours...`);
      (async () => {
        for (const p of partieRR.participants) {
          try {
            await addToInventory(String(p.id), 'diamants', partieRR.mise, 'Casino', 'Remboursement RR (redémarrage bot)');
          } catch (e) {
            console.error(`[Casino RR] Remboursement échoué pour ${p.id}:`, e);
          }
        }
        resetPartie();
        console.log('[Casino RR] Partie orpheline résolue, tous les joueurs remboursés.');
      })();
    }
  } catch (e) {
    console.warn('[Casino RR] Vérification démarrage échouée:', e);
  }

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
        if (id === 'poker_creer_table')         return await handlePokerCreerTable(interaction, ctx);
        if (id === 'poker_quitter_table')       return await executerQuitterTable(interaction);

        if (id.startsWith('poker_annonce_rejoindre_'))  return await handlePokerAnnonceRejoindre(interaction, ctx.client);
        if (id.startsWith('poker_annonce_spectateur_')) return await handlePokerAnnonceSpectateur(interaction, ctx.client);
        if (id.startsWith('poker_spectateurs_oui_'))    return await handlePokerSpectatorsOui(interaction, ctx.client);
        if (id.startsWith('poker_spectateurs_non_'))    return await handlePokerSpectatorsNon(interaction);
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
          const raiseModal = new ModalBuilder().setCustomId('poker_raise_modal').setTitle('♠️ Raise');
          raiseModal.addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('amount')
                .setLabel('Montant du raise (💎)')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setPlaceholder('ex: 100')
            )
          );
          return await interaction.showModal(raiseModal);
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
