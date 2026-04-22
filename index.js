const { Client, GatewayIntentBits, Partials, AttachmentBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, REST, Routes } = require('discord.js');

// Normalise les séparateurs de milliers de fr-FR : remplace les espaces insécables
// (U+202F narrow no-break space, U+00A0 no-break space) par des espaces normaux
// afin que Discord affiche correctement ex. "1 994 596" au lieu d'un bloc collé.
(function patchLocaleString() {
  const _orig = Number.prototype.toLocaleString;
  Number.prototype.toLocaleString = function(locale, options) {
    const result = _orig.call(this, locale, options);
    return typeof result === 'string' ? result.replace(/[\u202F\u00A0]/g, ' ') : result;
  };
})();

const commands = require('./commands');
const fs = require('fs');
const path = require('path');
const VOTE_BANNER_PATH = path.join(__dirname, 'assets/vote-banner.jpg');
const cron = require('node-cron');
const RouletteWheel = require('./rouletteWheel');
const { initDatabase } = require('./database');
const { fetchTopserveursRanking } = require('./topserveursService');
const { monthNameFr, formatRewards, buildMemberIndex, resolvePlayer } = require('./votesUtils');
const { getVotesConfig } = require('./votesConfig');
const { addCashToUser, generateDraftBotCommands } = require('./unbelievaboatService');
const { translate } = require('@vitalets/google-translate-api');
const OpenAI = require('openai');
const { createWebServer } = require('./web/server');
const { getDinosByLetter, getModdedDinos, getShoulderDinos, getPaidDLCDinos, buildLetterEmbed, buildLetterEmbeds, buildModdedEmbed, buildShoulderEmbed, buildShoulderEmbeds, buildPaidDLCEmbeds, buildCompactAllEmbeds, getVisibleVariantLabels, getDinosByVariant, buildVariantEmbed, buildVariantEmbeds, getAllLetters, getLetterColor } = require('./dinoManager');
const pgStore = require('./pgStore');
const { getConfig, saveConfig: saveRouletteConfig, initConfig } = require('./configManager');
const { initSettings, getSettings } = require('./settingsManager');
const { initDinos } = require('./dinoManager');
const { initShop } = require('./shopManager');
const { initInventory, getItemTypes, getItemTypeById, getPlayerInventory, getAllInventories, addToInventory, removeFromInventory, resetPlayerInventory, getPlayerTransactions, getCategories } = require('./inventoryManager');
const giveawayManager = require('./giveawayManager');
const { initSpecialPacks, getSpecialPacks, getSpecialPack } = require('./specialPacksManager');
const economyManager = require('./economyManager');
const xpManager = require('./xpManager');
const { handleShopCommand, handleShopInteraction } = require('./shopCommand');
const restartScheduler = require('./nitradoRestartScheduler');
const { recordJoin, recordLeave, buildWelcomeEmbed, sendWelcomeDM, getRandomArrivalPhrase, getRandomGreetPhrase, getRandomGreetGonePhrase } = require('./welcomeManager');
const { registerCasinoHandlers } = require('./casino/casinoHandler');


const openaiConfig = {};
if (process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
  openaiConfig.apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  openaiConfig.baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
} else if (process.env.OPENAI_API_KEY) {
  openaiConfig.apiKey = process.env.OPENAI_API_KEY;
}
const openai = openaiConfig.apiKey ? new OpenAI(openaiConfig) : null;

const ARTHUR_EMOJI_ID = '1473289815180050473';
const VOTE_REPORT_CHANNEL_ID = '1156933040795299942';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.Reaction,
  ],
});

let config = { rouletteChoices: [], rouletteTitle: 'ARKI' };

// Stocke temporairement le contexte des modaux d'item libre
const pendingLibreItems = new Map();

function splitMessage(text, maxLength = 1900) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    const addition = (current ? '\n' : '') + line;
    if ((current + addition).length > maxLength) {
      if (current) chunks.push(current);
      current = line.length > maxLength ? line.slice(0, maxLength) : line;
    } else {
      current += addition;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function hasRoulettePermission(member) {
  const votesConfig = getVotesConfig();
  const MODO_ROLE_ID = votesConfig.MODO_ROLE_ID || '1157803768893689877';
  return member.permissions.has(PermissionFlagsBits.Administrator) || 
         member.roles.cache.has(MODO_ROLE_ID);
}

const pendingDistributions = new Map();

function detectDuplicates(ranking, memberIndex) {
  const memberToPlayers = new Map();
  for (const player of ranking) {
    const memberId = resolvePlayer(memberIndex, player.playername);
    if (memberId) {
      if (!memberToPlayers.has(memberId)) {
        memberToPlayers.set(memberId, []);
      }
      memberToPlayers.get(memberId).push(player);
    }
  }
  const duplicates = [];
  for (const [memberId, players] of memberToPlayers) {
    if (players.length > 1) {
      duplicates.push({ memberId, players });
    }
  }
  return duplicates;
}

async function distributeWithChecks(ranking, memberIndex, votesConfig, monthName, adminChannel) {
  const duplicates = detectDuplicates(ranking, memberIndex);
  const duplicateMemberIds = new Set(duplicates.map(d => d.memberId));
  const distributionResults = { success: 0, failed: 0, notFound: [], pendingDuplicates: 0, pendingNotFound: 0, inventoryResults: [] };
  const playerStatus = {};

  for (const player of ranking) {
    const memberId = resolvePlayer(memberIndex, player.playername);
    const rankIdx = ranking.indexOf(player) + 1;
    const totalDiamonds = player.votes * votesConfig.DIAMONDS_PER_VOTE;
    const bonusDiamonds = votesConfig.TOP_DIAMONDS[rankIdx] || 0;
    const totalGain = totalDiamonds + bonusDiamonds;

    if (!memberId) {
      distributionResults.notFound.push(player.playername);
      playerStatus[player.playername] = 'pending';
      distributionResults.pendingNotFound++;

      if (adminChannel) {
        const pendingId = `notfound_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        pendingDistributions.set(pendingId, {
          type: 'notfound',
          playername: player.playername,
          votes: player.votes,
          totalGain,
          monthName,
          resolved: false,
        });

        const ignoreBtn = new ButtonBuilder()
          .setCustomId(`vote_ignore_${pendingId}`)
          .setLabel('Ignorer')
          .setStyle(ButtonStyle.Secondary);
        const assignBtn = new ButtonBuilder()
          .setCustomId(`vote_assign_${pendingId}`)
          .setLabel('Attribuer à un membre')
          .setStyle(ButtonStyle.Primary);
        const row = new ActionRowBuilder().addComponents(assignBtn, ignoreBtn);

        await adminChannel.send({
          content: `## ⚠️ Joueur non trouvé\n\n**${player.playername}** — ${player.votes} votes — ${totalGain.toLocaleString('fr-FR')} 💎\n\nAucun membre Discord correspondant trouvé.\nVoulez-vous attribuer les récompenses à un membre ou ignorer ?`,
          components: [row],
        });
      }
    } else if (duplicateMemberIds.has(memberId)) {
      const dupInfo = duplicates.find(d => d.memberId === memberId);
      const isFirstOccurrence = dupInfo.players[0].playername === player.playername;

      if (isFirstOccurrence) {
        playerStatus[player.playername] = 'pending';
        distributionResults.pendingDuplicates++;

        const pendingId = `dup_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const allEntries = dupInfo.players.map(p => {
          const ri = ranking.indexOf(p) + 1;
          const td = p.votes * votesConfig.DIAMONDS_PER_VOTE;
          const bd = votesConfig.TOP_DIAMONDS[ri] || 0;
          return { playername: p.playername, votes: p.votes, totalGain: td + bd, rankIdx: ri };
        });

        pendingDistributions.set(pendingId, {
          type: 'duplicate',
          memberId,
          entries: allEntries,
          monthName,
          resolved: false,
        });

        let dupMsg = `## 🔄 Doublon détecté\n\n<@${memberId}> a été détecté avec **${dupInfo.players.length} entrées** dans le classement :\n\n`;
        const buttons = [];
        allEntries.forEach((e, idx) => {
          dupMsg += `**${idx + 1}.** "${e.playername}" — ${e.votes} votes — ${e.totalGain.toLocaleString('fr-FR')} 💎\n`;
          buttons.push(
            new ButtonBuilder()
              .setCustomId(`vote_dupkeep_${pendingId}_${idx}`)
              .setLabel(`Garder "${e.playername}"`)
              .setStyle(ButtonStyle.Primary)
          );
        });

        const mergeBtn = new ButtonBuilder()
          .setCustomId(`vote_dupmerge_${pendingId}`)
          .setLabel('Fusionner (cumuler les votes)')
          .setStyle(ButtonStyle.Success);
        const dupAllBtn = new ButtonBuilder()
          .setCustomId(`vote_dupall_${pendingId}`)
          .setLabel('Distribuer les deux')
          .setStyle(ButtonStyle.Danger);

        const rows = [];
        if (buttons.length <= 3) {
          rows.push(new ActionRowBuilder().addComponents(...buttons));
          rows.push(new ActionRowBuilder().addComponents(mergeBtn, dupAllBtn));
        } else {
          rows.push(new ActionRowBuilder().addComponents(...buttons.slice(0, 5)));
          rows.push(new ActionRowBuilder().addComponents(mergeBtn, dupAllBtn));
        }

        dupMsg += `\nQue souhaitez-vous faire ?`;

        if (adminChannel) {
          await adminChannel.send({ content: dupMsg, components: rows });
        }
      } else {
        playerStatus[player.playername] = 'pending';
      }
    } else {
      // Rang 4 et 5 : les diamants bonus vont dans l'inventaire, pas dans UB
      const isRank4or5 = rankIdx === 4 || rankIdx === 5;
      const ubGain = isRank4or5 ? totalDiamonds : totalGain;
      const result = await addCashToUser(memberId, ubGain, `Votes ${monthName}`);
      if (result.success) {
        distributionResults.success++;
        playerStatus[player.playername] = 'success';

        // Top 1 à 5 : ajouter le pack spécial dans l'inventaire si configuré
        if (rankIdx >= 1 && rankIdx <= 5) {
          const packNames = [
            'pack 1ere place vote', 'pack 2eme place vote', 'pack 3eme place vote',
            'pack 4eme place vote', 'pack 5eme place vote',
          ];
          const configuredId = (votesConfig.VOTE_PACK_IDS || {})[rankIdx];
          if (configuredId) {
            let votePack = getSpecialPacks().packs.find(p => p.id === configuredId);
            // Fallback : recherche par nom si l'ID ne correspond plus
            if (!votePack) {
              votePack = getSpecialPacks().packs.find(p =>
                p.name.toLowerCase().replace(/[èéê]/g, 'e').replace(/[àâ]/g, 'a')
                  === packNames[rankIdx - 1].replace(/[èéê]/g, 'e')
              );
            }
            if (votePack) {
              await addToInventory(memberId, votePack.id, 1, 'system', `${votePack.name} — Votes ${monthName}`);
              distributionResults.inventoryResults.push({
                playername: player.playername,
                rankIdx,
                type: 'pack',
                packId: votePack.id,
                packName: votePack.name,
              });
            } else {
              const ordinal = rankIdx === 1 ? '1ère' : `${rankIdx}ème`;
              console.warn(`⚠️ [VOTES] Pack introuvable pour la ${ordinal} place (ID configuré: "${configuredId}")`);
              if (adminChannel) {
                await adminChannel.send(
                  `⚠️ **Pack vote non distribué — ${ordinal} place**\n` +
                  `Le joueur **${player.playername}** (<@${memberId}>) aurait dû recevoir le pack vote ${ordinal} place, mais aucun pack correspondant n'a été trouvé.\n` +
                  `-# Vérifiez que le pack existe dans Packs spéciaux ou reconfigurez le dashboard → Récompenses → Packs vote.`
                );
              }
              distributionResults.inventoryResults.push({
                playername: player.playername,
                rankIdx,
                type: 'pack',
                packId: null,
                packName: packNames[rankIdx - 1],
                notFound: true,
              });
            }
          }
        }

        // Rang 4/5 : ajouter les diamants bonus dans l'inventaire
        if (isRank4or5 && bonusDiamonds > 0) {
          const ordinal = rankIdx === 4 ? '4ème' : '5ème';
          await addToInventory(memberId, 'diamants', bonusDiamonds, 'system', `Bonus ${ordinal} place vote — ${monthName}`);
          distributionResults.inventoryResults.push({
            playername: player.playername,
            rankIdx,
            type: 'diamants',
            quantity: bonusDiamonds,
          });
        }
      } else {
        distributionResults.failed++;
        playerStatus[player.playername] = 'failed';
      }
    }
  }

  return { distributionResults, playerStatus };
}

function buildDistributionReport(ranking, memberIndex, votesConfig, playerStatus, monthName, source) {
  const sparkly = votesConfig.STYLE.sparkly || '💎';
  let msg = `📊 **Rapport de distribution des récompenses — ${monthName}**\n`;
  if (source === 'auto') msg += `-# 🕐 Publication automatique du 1er du mois\n`;
  msg += `\n`;

  // Tous les joueurs du classement
  for (let i = 0; i < ranking.length; i++) {
    const player = ranking[i];
    const rankIdx = i + 1;
    const totalDiamonds = player.votes * votesConfig.DIAMONDS_PER_VOTE;
    const bonusDiamonds = votesConfig.TOP_DIAMONDS[rankIdx] || 0;
    const isRank4or5 = rankIdx === 4 || rankIdx === 5;
    const ubGain = isRank4or5 ? totalDiamonds : totalDiamonds + bonusDiamonds;
    const status = playerStatus[player.playername];
    const statusIcon = status === 'success' ? '✅' : status === 'pending' ? '⏳' : status === 'failed' ? '❌' : '⚠️';
    const memberId = resolvePlayer(memberIndex, player.playername);
    const mention = memberId ? `<@${memberId}>` : `\`${player.playername}\``;

    msg += `**${rankIdx}.** ${mention} — ${player.votes} votes → ${ubGain.toLocaleString('fr-FR')} ${sparkly} ${statusIcon}`;

    if (rankIdx >= 1 && rankIdx <= 5 && (votesConfig.VOTE_PACK_IDS || {})[rankIdx]) {
      const packLabels = ['Pack 1ère place vote', 'Pack 2ème place vote', 'Pack 3ème place vote', 'Pack 4ème place vote', 'Pack 5ème place vote'];
      msg += ` + 📦 ${packLabels[rankIdx - 1]}`;
    }
    msg += `\n`;
  }

  // Résumé global
  msg += `\n`;
  const vals = Object.values(playerStatus);
  const sCount = vals.filter(s => s === 'success').length;
  const pCount = vals.filter(s => s === 'pending').length;
  const fCount = vals.filter(s => s === 'failed').length;
  msg += `✅ ${sCount} distribué(s)`;
  if (pCount > 0) msg += ` | ⏳ ${pCount} en attente`;
  if (fCount > 0) msg += ` | ❌ ${fCount} échec(s)`;

  // Section dédiée aux joueurs non trouvés
  const notFoundPlayers = ranking.filter(p => !resolvePlayer(memberIndex, p.playername));
  if (notFoundPlayers.length > 0) {
    msg += `\n\n⚠️ **${notFoundPlayers.length} joueur(s) non identifié(s) sur Discord — récompenses non envoyées :**\n`;
    for (const p of notFoundPlayers) {
      const rankIdx = ranking.indexOf(p) + 1;
      const totalDiamonds = p.votes * votesConfig.DIAMONDS_PER_VOTE;
      msg += `• \`${p.playername}\` (rank #${rankIdx}) — ${p.votes} votes — **${totalDiamonds.toLocaleString('fr-FR')} ${sparkly} dûs**\n`;
    }
    msg += `-# Utilisez \`/vote-rapport\` pour voir les liens pseudo → Discord, ou résolvez via le salon admin.\n`;
  }

  return msg;
}

async function autoPublishVotes() {
  try {
    const votesConfig = getVotesConfig();
    const guildId = votesConfig.GUILD_ID;
    if (!guildId) {
      console.error('❌ [AUTO-VOTES] GUILD_ID non configuré');
      return;
    }

    let guild;
    try {
      guild = await client.guilds.fetch(guildId);
    } catch (e) {
      console.error('❌ [AUTO-VOTES] Serveur introuvable:', guildId, e.message);
      return;
    }

    console.log('🕐 [AUTO-VOTES] Lancement automatique de la publication des résultats...');

    const ranking = await fetchTopserveursRanking(votesConfig.TOPSERVEURS_RANKING_URL);
    if (ranking.length === 0) {
      console.error('❌ [AUTO-VOTES] Impossible de récupérer le classement');
      return;
    }

    const memberIndex = await buildMemberIndex(guild);

    const parisMonth = parseInt(new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', month: 'numeric' }).format(new Date()), 10);
    const lastMonth = parisMonth === 1 ? 11 : parisMonth - 2;
    const monthName = monthNameFr(lastMonth);

    let adminChannel = null;
    try {
      if (votesConfig.ADMIN_LOG_CHANNEL_ID) adminChannel = await client.channels.fetch(votesConfig.ADMIN_LOG_CHANNEL_ID);
    } catch (e) {
      console.warn('⚠️ [AUTO-VOTES] Salon admin introuvable:', votesConfig.ADMIN_LOG_CHANNEL_ID, e.message);
    }
    let reportChannel = null;
    try { reportChannel = await client.channels.fetch(VOTE_REPORT_CHANNEL_ID); } catch (e) {
      console.warn('⚠️ [AUTO-VOTES] Salon de rapport introuvable:', VOTE_REPORT_CHANNEL_ID);
    }
    const { distributionResults, playerStatus } = await distributeWithChecks(ranking, memberIndex, votesConfig, monthName, adminChannel);

    let resultsMessage = `# ${votesConfig.STYLE.fireworks} Résultats des votes de ${monthName} ${votesConfig.STYLE.fireworks}\n\n`;
    const msg = votesConfig.MESSAGE || {};
    resultsMessage += `${msg.introText || ''}\n\n`;
    resultsMessage += `${votesConfig.STYLE.sparkly} ${msg.creditText || ''}\n\n`;

    const top10 = ranking.slice(0, 10);
    for (let i = 0; i < top10.length; i++) {
      const player = top10[i];
      const totalDiamonds = player.votes * votesConfig.DIAMONDS_PER_VOTE;
      const bonusDiamonds = votesConfig.TOP_DIAMONDS[i + 1] || 0;
      const status = playerStatus[player.playername];
      const statusIcon = status === 'success' ? '' : status === 'failed' ? ' ❌' : ' ⚠️';

      resultsMessage += `${votesConfig.STYLE.animeArrow} **${i + 1}** - **${player.playername}**${statusIcon}\n`;
      resultsMessage += `Votes : ${player.votes} | Gains : ${totalDiamonds.toLocaleString('fr-FR')} ${votesConfig.STYLE.sparkly}\n`;

      if (i === 0) {
        resultsMessage += `+ ${msg.pack1Text || 'Pack vote 1ère place'} + rôle <@&${votesConfig.TOP_VOTER_ROLE_ID}>\n`;
      } else if (i === 1) {
        resultsMessage += `+ ${msg.pack2Text || 'Pack vote 2ème place'}\n`;
      } else if (i === 2) {
        resultsMessage += `+ ${msg.pack3Text || 'Pack vote 3ème place'}\n`;
      } else if (bonusDiamonds > 0) {
        resultsMessage += `+ ${bonusDiamonds.toLocaleString('fr-FR')} ${votesConfig.STYLE.sparkly}\n`;
      }
      resultsMessage += `\n`;
    }

    resultsMessage += `---\n`;
    resultsMessage += `${msg.memoText || 'Pour mémo'} ${votesConfig.STYLE.animeArrow} ${votesConfig.STYLE.memoUrl}\n\n`;
    resultsMessage += `-# ${msg.dinoShinyText || 'Tirage Dino Shiny juste après 🦖'}\n`;

    const fullListData = ranking.filter(p => p.votes >= 10).map(p => {
      const totalDiamonds = p.votes * votesConfig.DIAMONDS_PER_VOTE;
      const idx = ranking.indexOf(p);
      const bonusDiamonds = votesConfig.TOP_DIAMONDS[idx + 1] || 0;
      const status = playerStatus[p.playername];
      return { ...p, totalGain: totalDiamonds + bonusDiamonds, status };
    });

    global.lastVotesFullList = { data: fullListData, monthName, memberIndex };

    const button = new ButtonBuilder()
      .setCustomId('show_full_votes_list')
      .setLabel('📋 Voir la liste complète')
      .setStyle(ButtonStyle.Secondary);
    const row = new ActionRowBuilder().addComponents(button);

    let resultsChannel = null;
    try {
      if (votesConfig.RESULTS_CHANNEL_ID) resultsChannel = await client.channels.fetch(votesConfig.RESULTS_CHANNEL_ID);
    } catch (e) {
      console.error('❌ [AUTO-VOTES] Salon de résultats introuvable:', votesConfig.RESULTS_CHANNEL_ID, e.message);
    }
    if (resultsChannel) {
      const pingPrefix = votesConfig.STYLE.everyonePing ? '|| @everyone ||\n' : '';
      if (fs.existsSync(VOTE_BANNER_PATH)) {
        await resultsChannel.send({ content: pingPrefix || undefined, files: [{ attachment: VOTE_BANNER_PATH, name: 'recompenses-votes.jpg' }] });
      }
      // Découpage automatique si > 1900 chars (limite Discord = 2000)
      const fullText = pingPrefix + resultsMessage;
      const chunks = splitMessage(fullText, 1900);
      for (let ci = 0; ci < chunks.length; ci++) {
        const isLast = ci === chunks.length - 1;
        await resultsChannel.send({ content: chunks[ci], components: isLast ? [row] : [] });
      }
    }

    const dinoTitle = msg.dinoTitle || 'DINO';
    const rouletteWheel = new RouletteWheel(top10.map(p => p.playername), dinoTitle);
    const winningIndex = Math.floor(Math.random() * top10.length);
    const gifBuffer = await rouletteWheel.generateAnimatedGif(winningIndex);
    const winningChoice = rouletteWheel.getWinningChoice(winningIndex);
    const attachment = new AttachmentBuilder(gifBuffer, { name: 'dino-shiny-roulette.gif' });

    if (resultsChannel) {
      const pingPrefix = votesConfig.STYLE.everyonePing ? '|| @everyone ||\n' : '';
      await resultsChannel.send({
        content: `${pingPrefix}## 🦖 Tirage Dino Shiny du mois !\n\nParticipants :\n${top10.map((p, i) => {
          return `${i + 1}. **${p.playername}**`;
        }).join('\n')}\n\n🎰 C'est parti !`,
        files: [attachment]
      });

      const dinoWinText = msg.dinoWinText || 'Tu remportes le **Dino Shiny** du mois ! 🦖✨';
      await resultsChannel.send(`${pingPrefix}## 🎉 Félicitations **${winningChoice}** !\n\n${dinoWinText}`);
    }

    const draftBotCommands = generateDraftBotCommands(ranking, memberIndex, resolvePlayer);

    // Rapport de distribution dans le salon dédié
    if (reportChannel) {
      const reportMsg = buildDistributionReport(ranking, memberIndex, votesConfig, playerStatus, monthName, 'auto');
      for (const chunk of splitMessage(reportMsg, 1900)) {
        await reportChannel.send(chunk);
      }
    }

    // Message admin (doublons, non trouvés, commandes DraftBot)
    let adminMessage = `📊 **Rapport admin — ${monthName}**\n\n`;
    adminMessage += `🕐 *Publication automatique du 1er du mois*\n\n`;
    adminMessage += `💎 **UnbelievaBoat :** ${distributionResults.success} distribué(s)`;
    if (distributionResults.failed > 0) adminMessage += `, ${distributionResults.failed} échec(s)`;
    adminMessage += `\n📦 **Inventaire :** ${distributionResults.inventoryResults.length} crédit(s)\n`;
    if (distributionResults.pendingDuplicates > 0) {
      adminMessage += `⏳ ${distributionResults.pendingDuplicates} doublon(s) en attente de validation (voir messages ci-dessous)\n`;
    }
    if (distributionResults.pendingNotFound > 0) {
      adminMessage += `⏳ ${distributionResults.pendingNotFound} joueur(s) non trouvé(s) en attente (voir messages ci-dessous)\n`;
    }
    if (draftBotCommands.length > 0) {
      adminMessage += `\n🎁 **Commandes DraftBot :**\n\`\`\`\n${draftBotCommands.join('\n')}\n\`\`\``;
    }

    if (adminChannel) {
      await adminChannel.send(adminMessage);
    }

    // Marquer la publication pour éviter les doublons (rattrapage au redémarrage)
    const pubKey = `${new Date().getFullYear()}-${String(lastMonth + 1).padStart(2, '0')}`;
    try { await pgStore.setData('vote_last_publish', pubKey); } catch {}

    console.log(`✅ [AUTO-VOTES] Résultats publiés automatiquement - ${distributionResults.success} récompensés, ${distributionResults.notFound.length} non trouvés`);

  } catch (error) {
    console.error('❌ [AUTO-VOTES] Erreur lors de la publication automatique:', error);
  }
}

client.once('clientReady', async () => {
  initDatabase();

  pgStore.initPool();
  if (pgStore.isPostgres()) {
    await pgStore.initTables();
  }
  await initConfig();
  await initSettings();
  await initDinos();
  await initShop();
  await initInventory();
  await initSpecialPacks();
  await giveawayManager.initGiveaways();

  config = getConfig();

  createWebServer(client);

  // Initialiser les plannings de redémarrage ARK SA + polling 60s
  await restartScheduler.init().catch(e => console.error('[RestartSched] init error:', e.message));
  restartScheduler.startPolling(60000);

  // Nettoyer silencieusement les giveaways expirés bloqués en 'active' dans PG
  // (ne pas envoyer de message Discord, juste mettre à jour le statut en base)
  try {
    await giveawayManager.initGiveaways();
    const stuckGiveaways = giveawayManager.getActiveGiveaways().filter(g => new Date(g.endTime).getTime() <= Date.now());
    for (const g of stuckGiveaways) {
      locallyEndedGiveaways.add(g.id); // Bloquer tout re-scheduling
      await giveawayManager.drawWinners(g.id).catch(() => {}); // Marquer 'ended' en DB silencieusement
      console.log(`[Giveaway] Giveaway expiré nettoyé silencieusement : "${g.title}" (${g.id})`);
    }
  } catch (e) {
    console.error('[Giveaway] Erreur nettoyage giveaways expirés:', e.message);
  }

  // Publier les giveaways sans messageId + programmer les timers
  await publishAndScheduleGiveaways(client);
  // Polling toutes les 60s pour détecter les nouveaux giveaways créés depuis le dashboard
  setInterval(() => publishAndScheduleGiveaways(client), 60 * 1000);

  // Enregistrer les handlers du casino
  registerCasinoHandlers(client, { pgStore, getPlayerInventory, addToInventory, removeFromInventory });

  console.log('✅ Bot Discord Arki Roulette est en ligne !');
  console.log(`📝 Connecté en tant que ${client.user.tag}`);

  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: commands });
    console.log('✅ Commandes slash enregistrées automatiquement');
  } catch (err) {
    console.error('⚠️ Enregistrement commandes slash échoué:', err.message);
  }
  console.log(`🎰 ${config.rouletteChoices.length} choix de roulette chargés`);
  console.log('\n💡 Commandes disponibles:');
  console.log('   /roulette - Lance la roue de la chance');
  console.log('   /set-choices - Modifie les choix de la roulette');
  console.log('   /show-choices - Affiche les choix actuels');
  console.log('   /votes - Affiche le classement des votes');
  console.log('   /publish-votes - Publie les résultats mensuels');

  cron.schedule('0 0 1 * *', () => {
    console.log('🕐 [CRON] Déclenchement publication automatique des votes (1er du mois, 00h00)');
    autoPublishVotes();
  }, {
    timezone: 'Europe/Paris'
  });
  console.log('⏰ Publication automatique des votes programmée : 1er de chaque mois à 00h00 (Europe/Paris)');

  // ─── Rattrapage au démarrage ─────────────────────────────────────────────
  // Si le bot redémarre après minuit le 1er du mois et a raté le cron
  try {
    const nowParis = new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    const dayParis  = parseInt(nowParis.find(p => p.type === 'day').value, 10);
    const monParis  = parseInt(nowParis.find(p => p.type === 'month').value, 10);
    const yearParis = parseInt(nowParis.find(p => p.type === 'year').value, 10);

    if (dayParis === 1) {
      // Mois précédent (le mois dont on publie les votes)
      const prevMon  = monParis === 1 ? 12 : monParis - 1;
      const prevYear = monParis === 1 ? yearParis - 1 : yearParis;
      const expectedKey = `${prevYear}-${String(prevMon).padStart(2, '0')}`;

      const lastPublish = await pgStore.getData('vote_last_publish', null);
      if (lastPublish !== expectedKey) {
        console.log(`⚡ [RATTRAPAGE] Cron manqué — publication des votes ${expectedKey} dans 30s...`);
        setTimeout(() => autoPublishVotes(), 30 * 1000);
      } else {
        console.log(`✅ [RATTRAPAGE] Votes ${expectedKey} déjà publiés, aucun rattrapage nécessaire.`);
      }
    }
  } catch (e) {
    console.warn('[RATTRAPAGE] Vérification échouée:', e.message);
  }
});

const reactionTracker = new Map();

function getReactionKey(messageId, emojiKey) {
  return `${messageId}:${emojiKey}`;
}

function getEmojiKey(emoji) {
  return emoji.id || emoji.name;
}

client.on('messageReactionRemove', async (reaction, user) => {
  if (user.bot) return;
  try {
    if (reaction.partial) await reaction.fetch();
  } catch { return; }

  const key = getReactionKey(reaction.message.id, getEmojiKey(reaction.emoji));
  if (reaction.count === 0) {
    reactionTracker.delete(key);
  }
});

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;

  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
  } catch { return; }

  const emojiKey = getEmojiKey(reaction.emoji);
  const trackerKey = getReactionKey(reaction.message.id, emojiKey);

  if (reactionTracker.has(trackerKey)) return;
  reactionTracker.set(trackerKey, Date.now());

  if (reactionTracker.size > 5000) {
    const entries = [...reactionTracker.entries()].sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < 1000; i++) {
      reactionTracker.delete(entries[i][0]);
    }
  }

  if (reaction.emoji.id === ARTHUR_EMOJI_ID || reaction.emoji.name === 'arthur') {
    console.log(`🎭 Réaction Kaamelott détectée! Emoji: ${reaction.emoji.name} (ID: ${reaction.emoji.id})`);
    if (!openai) {
      console.log('⚠️ OpenAI non configuré, impossible de reformuler');
      return;
    }
    try {
      const messageContent = reaction.message.content;
      if (!messageContent || messageContent.trim() === '') return;

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `Tu es un expert de la série Kaamelott. Tu dois réécrire le texte fourni dans le style et le ton des personnages de Kaamelott (Arthur, Perceval, Karadoc, Léodagan, etc.). Garde le même sens général mais reformule avec :
- Le vocabulaire et les expressions typiques de Kaamelott
- Le ton médiéval-comique de la série
- Des références subtiles à l'univers de Kaamelott si possible
- Les tournures de phrases caractéristiques des personnages
Reste concis. Ne mets pas de guillemets autour du texte. Ne dis pas quel personnage parle. Reformule directement.`
          },
          {
            role: 'user',
            content: messageContent
          }
        ],
        max_tokens: 1000,
        temperature: 0.9,
      });

      const kaamelottText = completion.choices[0]?.message?.content;
      if (!kaamelottText) return;

      let response = `## <:arthur:${ARTHUR_EMOJI_ID}> Traduction d'Arthur\n\n${kaamelottText}`;

      if (response.length > 2000) {
        const chunks = response.match(/[\s\S]{1,1900}/g) || [response];
        for (const chunk of chunks) {
          await reaction.message.channel.send(chunk);
        }
      } else {
        await reaction.message.channel.send(response);
      }
    } catch (error) {
      console.error('Erreur traduction Kaamelott:', error.message || error);
    }
    return;
  }

  const langMap = { '🇫🇷': 'fr', '🇬🇧': 'en' };
  const lang = langMap[reaction.emoji.name];
  if (!lang) return;

  try {
    const messageContent = reaction.message.content;
    if (!messageContent || messageContent.trim() === '') return;

    const lines = messageContent.split('\n');
    const translatedLines = [];

    for (const line of lines) {
      if (line.trim() === '' || line.trim() === '---') {
        translatedLines.push(line);
        continue;
      }

      const mdPrefix = line.match(/^(\s*(?:[#]+\s|[-*]\s|>\s|\d+\.\s|`{3}.*)?)/);
      const prefix = mdPrefix ? mdPrefix[1] : '';
      const textPart = line.slice(prefix.length);

      if (textPart.trim() === '') {
        translatedLines.push(line);
        continue;
      }

      const result = await translate(textPart, { to: lang });
      translatedLines.push(prefix + result.text);
    }

    const translatedText = translatedLines.join('\n');
    const flag = lang === 'fr' ? '🇫🇷' : '🇬🇧';
    let response = `## ${flag} Traduction\n\n${translatedText}`;

    if (response.length > 2000) {
      const chunks = response.match(/[\s\S]{1,1900}/g) || [response];
      for (const chunk of chunks) {
        await reaction.message.channel.send(chunk);
      }
    } else {
      await reaction.message.channel.send(response);
    }
  } catch (error) {
    console.error('Erreur traduction par réaction:', error);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GIVEAWAY HELPERS (bot Railway)
// ────────────────────────────────────────────────────────────────────────────
const giveawayTimers = new Map();
const endingGiveaways = new Set(); // Verrou anti-doublon (en cours de clôture)
const locallyEndedGiveaways = new Set(); // Giveaways déjà terminés en mémoire (survit aux rechargements PG)

function buildGiveawayButton(id) {
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`giveway_join_${id}`)
      .setLabel('🎉 Je participe')
      .setStyle(ButtonStyle.Primary)
  );
}

async function endGiveawayNow(id, botClient) {
  if (endingGiveaways.has(id)) return; // Déjà en cours de clôture
  if (locallyEndedGiveaways.has(id)) return; // Déjà terminé en mémoire (PG peut être en retard)
  const g = giveawayManager.getGiveaway(id);
  if (!g || g.status !== 'active') return;
  endingGiveaways.add(id); // Poser le verrou
  locallyEndedGiveaways.add(id); // Marquer terminé immédiatement (avant toute opération async)

  // Vider les timers
  if (giveawayTimers.has(id)) { clearTimeout(giveawayTimers.get(id)); giveawayTimers.delete(id); }
  if (giveawayTimers.has(`${id}_interval`)) { clearInterval(giveawayTimers.get(`${id}_interval`)); giveawayTimers.delete(`${id}_interval`); }

  const winners = await giveawayManager.drawWinners(id);
  const updated = giveawayManager.getGiveaway(id);

  try {
    const channel = await botClient.channels.fetch(g.channelId);

    // Mettre à jour l'embed en mode "terminé"
    if (g.messageId) {
      const msg = await channel.messages.fetch(g.messageId).catch(() => null);
      if (msg) {
        const endEmbed = buildGiveawayEmbed(updated);
        endEmbed.setColor('#95a5a6');
        const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
        const disabledRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`giveway_join_${id}`).setLabel('🎉 Je participe').setStyle(ButtonStyle.Primary).setDisabled(true)
        );
        await msg.edit({ embeds: [endEmbed], components: [disabledRow] });
      }
    }

    // Annoncer les gagnants
    if (winners && winners.length > 0) {
      const winnerMentions = winners.map(uid => `<@${uid}>`).join(', ');
      const prizeLabel = buildPrizeLabel(g.prize);
      await channel.send(`🎉 **Fin du Giveaway !**\n\n🏆 Félicitations ${winnerMentions} ! Vous remportez **${prizeLabel}** !\n\n> ✅ Votre gain a été crédité dans votre inventaire.`);

      // DM gagnants
      for (const uid of winners) {
        try {
          const user = await botClient.users.fetch(uid);
          await user.send(`🎉 Félicitations ! Tu as gagné le giveaway **${g.title}** sur Arki Family !\nTu remportes : **${prizeLabel}**\n✅ Ton gain a été crédité dans ton inventaire.`);
        } catch (e) {}
      }

      // Distribution auto dans l'inventaire (item défini OU item occasionnel)
      for (const uid of winners) {
        try {
          if (g.prize.type === 'item' && g.prize.itemId) {
            await addToInventory(uid, g.prize.itemId, g.prize.quantity, 'giveaway', g.title);
          } else if (g.prize.type === 'libre' && g.prize.name) {
            // Item occasionnel : stocker avec le nom comme identifiant
            const libreId = 'libre_' + g.prize.name.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 40);
            await addToInventory(uid, libreId, g.prize.quantity, 'giveaway', `${g.title} — ${g.prize.name}`);
          }
        } catch (e) {}
      }
    } else {
      await channel.send(`😔 **Fin du Giveaway "${g.title}"** — Aucun participant éligible pour le tirage.`);
    }
  } catch (e) {
    console.error('[Giveaway] Erreur fin giveaway:', e);
  } finally {
    endingGiveaways.delete(id); // Libérer le verrou dans tous les cas
  }
}

function scheduleGiveawayEnd(g, botClient) {
  // Nettoyer les anciens timers si existants
  if (giveawayTimers.has(g.id)) { clearTimeout(giveawayTimers.get(g.id)); giveawayTimers.delete(g.id); }
  if (giveawayTimers.has(`${g.id}_interval`)) { clearInterval(giveawayTimers.get(`${g.id}_interval`)); giveawayTimers.delete(`${g.id}_interval`); }

  const delay = new Date(g.endTime).getTime() - Date.now();
  if (delay <= 0) {
    giveawayTimers.set(g.id, true); // Sentinelle : empêche le re-scheduling par le polling
    endGiveawayNow(g.id, botClient);
    return;
  }

  const t = setTimeout(() => endGiveawayNow(g.id, botClient), delay);
  giveawayTimers.set(g.id, t);

  // Rafraîchir l'embed toutes les minutes
  const interval = setInterval(async () => {
    const current = giveawayManager.getGiveaway(g.id);
    if (!current || current.status !== 'active') { clearInterval(interval); giveawayTimers.delete(`${g.id}_interval`); return; }
    if (!current.messageId || !current.channelId) return;
    try {
      const channel = await botClient.channels.fetch(current.channelId);
      const msg = await channel.messages.fetch(current.messageId).catch(() => null);
      if (msg) await msg.edit({ embeds: [buildGiveawayEmbed(current)] });
    } catch (e) {}
  }, 60 * 1000);
  giveawayTimers.set(`${g.id}_interval`, interval);
}

async function publishAndScheduleGiveaways(botClient) {
  // Recharger depuis PostgreSQL pour détecter les nouveaux giveaways créés depuis le dashboard
  await giveawayManager.initGiveaways();

  const active = giveawayManager.getActiveGiveaways();
  for (const g of active) {
    // Publier les giveaways qui n'ont pas encore d'embed Discord
    if (!g.messageId && g.channelId) {
      try {
        const channel = await botClient.channels.fetch(g.channelId);
        if (channel) {
          const embed = buildGiveawayEmbed(g);
          const row = buildGiveawayButton(g.id);
          const msg = await channel.send({ embeds: [embed], components: [row] });
          await giveawayManager.updateMessageId(g.id, msg.id);
          console.log(`[Giveaway] Publié : "${g.title}" (${g.id}) dans #${g.channelId}`);
        }
      } catch (e) {
        console.error(`[Giveaway] Erreur publication "${g.id}":`, e.message);
      }
    }

    // Programmer le timer si pas encore fait et pas déjà terminé localement
    if (!giveawayTimers.has(g.id) && !locallyEndedGiveaways.has(g.id)) {
      scheduleGiveawayEnd(g, botClient);
    }
  }
}

function buildPrizeLabel(prize) {
  // Nettoyer les préfixes emoji hérités des anciennes versions (🎁, 📦, etc.)
  const cleanName = (str) => (str || '').replace(/^[🎁📦🎀🎊🎉\s]+/, '').trim() || (str || '');

  if (prize.itemId && prize.itemId !== '__libre__') {
    // Chercher l'emoji de l'item dans les types configurés
    const itemTypes = getItemTypes();
    const found = itemTypes.find(i => i.id === prize.itemId);
    if (found) {
      const isCustomEmoji = /^<a?:\w+:\d+>$/.test(found.emoji);
      const displayName = isCustomEmoji ? found.name : `${found.emoji} ${found.name}`;
      return `${displayName} ×${prize.quantity}`;
    }
    // Fallback : nom stocké sans préfixe parasite
    return `${cleanName(prize.name) || prize.itemId} ×${prize.quantity}`;
  }
  // Item libre : juste le nom propre
  return `${cleanName(prize.name) || prize.itemId || '—'} ×${prize.quantity}`;
}

function buildGiveawayEmbed(g) {
  const timeLeft = giveawayManager.formatTimeLeft(g.endTime);
  const parisOpts = { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' };
  const parisDateOpts = { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit' };
  const endStr = new Date(g.endTime).toLocaleTimeString('fr-FR', parisOpts);
  const endDateStr = new Date(g.endTime).toLocaleDateString('fr-FR', parisDateOpts);
  const prizeLabel = buildPrizeLabel(g.prize);

  const embed = new EmbedBuilder()
    .setColor('#FF6B6B')
    .setAuthor({ name: '🎉 Giveaway Arki Family' })
    .setTimestamp(new Date(g.endTime));

  if (g.imageUrl) {
    try {
      const imgUrl = (g.imageUrl.startsWith('http://') || g.imageUrl.startsWith('https://'))
        ? g.imageUrl
        : (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}${g.imageUrl}` : null);
      if (imgUrl) embed.setImage(imgUrl);
    } catch (e) {}
  }

  let desc = `# ${g.title}\n`;
  if (g.description) desc += `\n${g.description}\n`;
  desc += `\n🏆 **Gain :** ${prizeLabel}\n`;
  desc += `👥 **Gagnant(s) :** ${g.winnerCount}\n`;
  desc += `👤 **Participants :** ${g.participants.length}\n\n`;
  desc += g.status === 'ended'
    ? `✅ **Terminé**`
    : `⏰ **Fin dans :** ${timeLeft} | le ${endDateStr} à ${endStr} *(Paris)*`;
  if (g.conditions) desc += `\n\n📋 **Conditions :** ${g.conditions}`;

  embed.setDescription(desc);
  embed.setFooter({ text: `ID: ${g.id} • Lancé par ${g.createdByName || g.createdBy}` });
  return embed;
}

client.on('interactionCreate', async interaction => {
  // ── Fils poker : bloquer les commandes slash (laisser passer les boutons/modaux) ──
  if (
    interaction.isChatInputCommand() &&
    interaction.channel?.name?.startsWith('♠️poker')
  ) {
    return interaction.reply({
      content: '❌ Les commandes ne sont pas autorisées dans un fil de poker.',
      ephemeral: true
    });
  }

  // ── Shop interactions (buttons + select menus) ──
  if (interaction.isButton() || interaction.isStringSelectMenu()) {
    const id = interaction.customId;
    if (
      id === 'shop_type' || id === 'shop_back_home' ||
      id.startsWith('shop_product::') || id.startsWith('shop_back_type::') ||
      id.startsWith('shop_order::') || id.startsWith('shop_addcart::') ||
      id.startsWith('shop_cartadd::') || id.startsWith('shop_closecart::')
    ) {
      try {
        await handleShopInteraction(interaction);
      } catch (err) {
        console.error('[Shop] Erreur interaction:', err);
        try {
          const reply = { content: '❌ Une erreur est survenue.', ephemeral: true };
          if (interaction.replied || interaction.deferred) await interaction.followUp(reply);
          else await interaction.reply(reply);
        } catch (e) {}
      }
      return;
    }
  }

  // ── Giveaway: soumission modal création ──
  if (interaction.isModalSubmit() && interaction.customId.startsWith('giveway_create_modal_')) {
    const raw = interaction.customId.replace('giveway_create_modal_', '');
    const parts = raw.split('|');
    const targetChannelId = parts[0] || interaction.channelId;
    const pingEveryone = parts[1] === '1';
    const selectedItemId = parts[2] || '';

    const titre = interaction.fields.getTextInputValue('gw_titre').trim();
    // gw_gain : champ libre commun aux deux branches (Nom du lot pour libre, Gain pour item inventaire)
    let gainRaw = '';
    try { gainRaw = interaction.fields.getTextInputValue('gw_gain').trim(); } catch {}

    // Parser la quantité depuis le champ gw_quantite (branche libre) ou depuis gainRaw (branche item)
    let quantity = 1;
    try {
      const qtyStr = interaction.fields.getTextInputValue('gw_quantite').trim();
      const parsed = parseInt(qtyStr, 10);
      if (!isNaN(parsed) && parsed >= 1) quantity = parsed;
    } catch {
      // Branche item inventaire : quantité encodée dans gainRaw ("× N" ou "N item")
    }
    // Extraire quantité depuis gainRaw si pas encore trouvée
    if (quantity === 1 && gainRaw) {
      const qtyMatch = gainRaw.match(/[×x]\s*(\d+)\s*$/i) || gainRaw.match(/^(\d+)\s+/);
      if (qtyMatch) quantity = Math.max(1, parseInt(qtyMatch[1]));
    }
    // Texte du gain sans la partie quantité
    let gainText = gainRaw
      .replace(/\s*[×x]\s*\d+\s*$/i, '')
      .replace(/^\d+\s+/, '')
      .trim();

    const heureRaw = interaction.fields.getTextInputValue('gw_heure').trim();
    let description = '';
    try { description = interaction.fields.getTextInputValue('gw_description').trim(); } catch {}
    let conditions = '';
    try { conditions = interaction.fields.getTextInputValue('gw_conditions').trim(); } catch {}

    // Parser l'heure de fin (format HH:MM) — heure Paris
    const heureMatch = heureRaw.match(/^(\d{1,2}):(\d{2})$/);
    if (!heureMatch) {
      return interaction.reply({ content: '❌ Format d\'heure invalide. Utilise le format **00:00** (ex: 21:00).', ephemeral: true });
    }
    const [, hh, mm] = heureMatch;
    // Construire la date de fin en heure Paris
    const nowParis = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    const endParis = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    endParis.setHours(parseInt(hh), parseInt(mm), 0, 0);
    if (endParis <= nowParis) endParis.setDate(endParis.getDate() + 1);
    // Convertir en UTC correct
    const utcOffset = new Date() - nowParis;
    const endDateTime = new Date(endParis.getTime() + utcOffset);

    const gagnants = 1;
    const endTime = endDateTime.toISOString();

    await interaction.deferReply({ ephemeral: true });

    // Construire la prize selon le type sélectionné
    let prize;
    if (selectedItemId && selectedItemId !== '__libre__') {
      // Item inventaire : utiliser le texte libre du champ Gain (gainText), fallback sur le nom de l'item
      const itemTypes = getItemTypes();
      const found = itemTypes.find(i => i.id === selectedItemId);
      const isCustom = found && /^<a?:\w+:\d+>$/.test(found.emoji);
      const fallbackName = found ? (isCustom ? found.name : `${found.emoji} ${found.name}`) : selectedItemId;
      prize = { type: 'item', itemId: selectedItemId, name: gainText || fallbackName, quantity };
    } else {
      prize = { type: 'libre', name: gainText || gainRaw, quantity };
    }

    const gwSettings = getSettings();
    const giveaway = await giveawayManager.createGiveaway({
      title: titre,
      description,
      conditions,
      prize,
      winnerCount: gagnants,
      endTime,
      channelId: targetChannelId,
      guildId: interaction.guildId,
      createdBy: interaction.user.id,
      createdByName: interaction.member?.displayName || interaction.user.username,
      imageUrl: gwSettings.giveaway?.defaultImageUrl || '',
      roleId: '',
      pingEveryone,
    });

    try {
      const channel = await client.channels.fetch(targetChannelId);
      const embed = buildGiveawayEmbed(giveaway);
      const row = buildGiveawayButton(giveaway.id);
      const msg = await channel.send({ embeds: [embed], components: [row] });
      await giveawayManager.updateMessageId(giveaway.id, msg.id);
      scheduleGiveawayEnd(giveaway, client);
      if (pingEveryone) {
        await channel.send('@everyone 🎉 Un nouveau giveaway vient d\'être lancé ! Cliquez sur **Je participe** pour tenter votre chance !');
      }
      const finStr = endDateTime.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      return interaction.editReply({ content: `✅ Giveaway **${titre}** publié dans <#${targetChannelId}> !\n⏰ Fin : **${finStr}** | 🏆 Gagnants : **${gagnants}** | ID : \`${giveaway.id}\`` });
    } catch (e) {
      console.error('[Giveaway] Erreur publication modal:', e);
      return interaction.editReply({ content: `⚠️ Giveaway créé (ID : \`${giveaway.id}\`) mais erreur de publication : ${e.message}` });
    }
  }

  // ── Giveaway: bouton "Je participe" ──
  if (interaction.isButton() && interaction.customId.startsWith('giveway_join_')) {
    const gid = interaction.customId.replace('giveway_join_', '');
    const g = giveawayManager.getGiveaway(gid);
    if (!g) return interaction.reply({ content: '❌ Ce giveaway est introuvable.', ephemeral: true });
    if (g.status !== 'active') return interaction.reply({ content: '⏸️ Ce giveaway est terminé.', ephemeral: true });

    // Vérif restriction rôle
    if (g.roleId) {
      const member = interaction.member || await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
      if (member && !member.roles.cache.has(g.roleId)) {
        return interaction.reply({ content: `❌ Tu dois avoir le rôle <@&${g.roleId}> pour participer.`, ephemeral: true });
      }
    }

    const already = g.participants.includes(interaction.user.id);
    if (already) {
      // Retirer sa participation
      await giveawayManager.removeParticipant(gid, interaction.user.id);
      const updated = giveawayManager.getGiveaway(gid);
      if (g.messageId) {
        try {
          const msg = await interaction.message.fetch();
          await msg.edit({ embeds: [buildGiveawayEmbed(updated)] });
        } catch (e) {}
      }
      return interaction.reply({ content: '🚫 Tu t\'es retiré du giveaway.', ephemeral: true });
    } else {
      await giveawayManager.addParticipant(gid, interaction.user.id);
      const updated = giveawayManager.getGiveaway(gid);
      if (g.messageId) {
        try {
          const msg = await interaction.message.fetch();
          await msg.edit({ embeds: [buildGiveawayEmbed(updated)] });
        } catch (e) {}
      }
      return interaction.reply({ content: '🎉 Tu participes au giveaway ! Bonne chance !\n-# Pour retirer ta participation, appuie de nouveau sur **Je participe**.', ephemeral: true });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════

  // ════════════════════════════════════════════════════════════════════════════

  // ─── Bouton "Souhaiter la bienvenue / bon retour" ────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('welcome_greet:')) {
    const [, memberId, type] = interaction.customId.split(':');
    const isNew = type === 'new';
    const mention = `<@${memberId}>`;

    // Vérifier si le membre est encore sur le serveur
    const stillHere = await interaction.guild.members.fetch(memberId).catch(() => null);
    const phrase = stillHere
      ? getRandomGreetPhrase(mention, isNew)
      : getRandomGreetGonePhrase(mention);

    await interaction.deferUpdate();
    try {
      const clickerName = (interaction.member?.displayName) || interaction.user.username;
      const clickerAvatar = interaction.user.displayAvatarURL({ extension: 'png', size: 256 });
      const webhooks = await interaction.channel.fetchWebhooks();
      let webhook = webhooks.find(wh => wh.owner?.id === client.user.id && wh.name === 'Arki Welcome');
      if (!webhook) {
        webhook = await interaction.channel.createWebhook({ name: 'Arki Welcome', reason: 'Bouton bienvenue' });
      }
      await webhook.send({ content: `→ ${phrase}`, username: clickerName, avatarURL: clickerAvatar });
    } catch (err) {
      console.error('[Welcome] Erreur webhook greet:', err.message);
      await interaction.channel.send({ content: `→ ${phrase}` });
    }
    return;
  }

  if (interaction.isButton()) {
    if (interaction.customId === 'show_full_votes_list') {
      const fullList = global.lastVotesFullList;
      if (!fullList || !fullList.data) {
        return interaction.reply({ content: '❌ Aucune liste disponible.', ephemeral: true });
      }

      let listMessage = `## 📋 Liste complète des votes - ${fullList.monthName}\n\n`;
      listMessage += `*Joueurs avec 10+ votes :*\n\n`;
      
      for (let i = 0; i < fullList.data.length; i++) {
        const player = fullList.data[i];
        const statusText = player.status === 'success' ? '✅' : player.status === 'pending' ? '⏳ en attente' : player.status === 'failed' ? '❌ échec' : player.status === 'notfound' ? '⚠️ non trouvé' : '✅';
        listMessage += `**${i + 1}.** **${player.playername}** — ${player.votes} votes — 💎 ${player.totalGain} ${statusText}\n`;
      }

      const chunks = listMessage.match(/[\s\S]{1,1900}/g) || [listMessage];
      try {
        await interaction.reply({ content: chunks[0], ephemeral: true });
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp({ content: chunks[i], ephemeral: true });
        }
      } catch (err) {
        console.log('⚠️ Interaction expirée pour le bouton liste complète');
      }
      return;
    }

    const isVoteAdmin = interaction.customId.startsWith('vote_dup') || interaction.customId.startsWith('vote_ignore_') || interaction.customId.startsWith('vote_assign_');
    if (isVoteAdmin && interaction.member && !hasRoulettePermission(interaction.member)) {
      return interaction.reply({ content: '❌ Seuls les administrateurs et Modos peuvent valider les distributions.', ephemeral: true });
    }

    if (interaction.customId.startsWith('vote_dupkeep_')) {
      const parts = interaction.customId.replace('vote_dupkeep_', '').split('_');
      const choiceIdx = parseInt(parts.pop(), 10);
      const pendingId = parts.join('_');
      const pending = pendingDistributions.get(pendingId);
      if (!pending || pending.resolved) {
        return interaction.reply({ content: '❌ Cette demande a déjà été traitée.', ephemeral: true });
      }
      pending.resolved = true;
      const chosen = pending.entries[choiceIdx];
      const result = await addCashToUser(pending.memberId, chosen.totalGain, `Votes ${pending.monthName}`);
      const statusText = result.success ? '✅ Distribué' : '❌ Échec';
      await interaction.update({
        content: `## ✅ Doublon résolu\n\n<@${pending.memberId}> — Entrée retenue : **"${chosen.playername}"** (${chosen.votes} votes)\n${statusText} : **${chosen.totalGain.toLocaleString('fr-FR')}** 💎`,
        components: [],
      });
      return;
    }

    if (interaction.customId.startsWith('vote_dupmerge_')) {
      const pendingId = interaction.customId.replace('vote_dupmerge_', '');
      const pending = pendingDistributions.get(pendingId);
      if (!pending || pending.resolved) {
        return interaction.reply({ content: '❌ Cette demande a déjà été traitée.', ephemeral: true });
      }
      pending.resolved = true;
      const totalVotes = pending.entries.reduce((s, e) => s + e.votes, 0);
      const votesConfig = getVotesConfig();
      const bestRank = Math.min(...pending.entries.map(e => e.rankIdx));
      const totalDiamonds = totalVotes * votesConfig.DIAMONDS_PER_VOTE;
      const bonusDiamonds = votesConfig.TOP_DIAMONDS[bestRank] || 0;
      const totalGain = totalDiamonds + bonusDiamonds;
      const result = await addCashToUser(pending.memberId, totalGain, `Votes ${pending.monthName} (fusionné)`);
      const statusText = result.success ? '✅ Distribué' : '❌ Échec';
      const names = pending.entries.map(e => `"${e.playername}"`).join(' + ');
      await interaction.update({
        content: `## ✅ Doublon fusionné\n\n<@${pending.memberId}> — ${names} fusionnés\nTotal : **${totalVotes} votes** → ${statusText} : **${totalGain.toLocaleString('fr-FR')}** 💎`,
        components: [],
      });
      return;
    }

    if (interaction.customId.startsWith('vote_dupall_')) {
      const pendingId = interaction.customId.replace('vote_dupall_', '');
      const pending = pendingDistributions.get(pendingId);
      if (!pending || pending.resolved) {
        return interaction.reply({ content: '❌ Cette demande a déjà été traitée.', ephemeral: true });
      }
      pending.resolved = true;
      let totalDistributed = 0;
      let allSuccess = true;
      for (const entry of pending.entries) {
        const result = await addCashToUser(pending.memberId, entry.totalGain, `Votes ${pending.monthName} (${entry.playername})`);
        if (result.success) {
          totalDistributed += entry.totalGain;
        } else {
          allSuccess = false;
        }
      }
      const names = pending.entries.map(e => `"${e.playername}" (${e.totalGain.toLocaleString('fr-FR')} 💎)`).join(' + ');
      const statusText = allSuccess ? '✅ Tout distribué' : '⚠️ Distribution partielle';
      await interaction.update({
        content: `## ✅ Doublon — distribution complète\n\n<@${pending.memberId}> — ${names}\n${statusText} : **${totalDistributed.toLocaleString('fr-FR')}** 💎 au total`,
        components: [],
      });
      return;
    }

    if (interaction.customId.startsWith('vote_ignore_')) {
      const pendingId = interaction.customId.replace('vote_ignore_', '');
      const pending = pendingDistributions.get(pendingId);
      if (!pending || pending.resolved) {
        return interaction.reply({ content: '❌ Cette demande a déjà été traitée.', ephemeral: true });
      }
      pending.resolved = true;
      await interaction.update({
        content: `## ⏭️ Ignoré\n\n**${pending.playername}** — ${pending.votes} votes — ${pending.totalGain.toLocaleString('fr-FR')} 💎\n*Aucune distribution effectuée.*`,
        components: [],
      });
      return;
    }

    if (interaction.customId.startsWith('vote_assign_')) {
      const pendingId = interaction.customId.replace('vote_assign_', '');
      const pending = pendingDistributions.get(pendingId);
      if (!pending || pending.resolved) {
        return interaction.reply({ content: '❌ Cette demande a déjà été traitée.', ephemeral: true });
      }
      const { UserSelectMenuBuilder } = require('discord.js');
      const userSelect = new UserSelectMenuBuilder()
        .setCustomId(`vote_assignuser_${pendingId}`)
        .setPlaceholder(`Choisir le membre pour "${pending.playername}"`)
        .setMinValues(1)
        .setMaxValues(1);
      const row = new ActionRowBuilder().addComponents(userSelect);
      await interaction.update({
        content: `## ⚠️ Joueur non trouvé\n\n**${pending.playername}** — ${pending.votes} votes — ${pending.totalGain.toLocaleString('fr-FR')} 💎\n\n👇 Sélectionnez le membre Discord à qui attribuer les récompenses :`,
        components: [row],
      });
      return;
    }
  }

  if (interaction.isUserSelectMenu()) {
    if (interaction.customId.startsWith('vote_assignuser_')) {
      if (interaction.member && !hasRoulettePermission(interaction.member)) {
        return interaction.reply({ content: '❌ Seuls les administrateurs et Modos peuvent valider les distributions.', ephemeral: true });
      }
      const pendingId = interaction.customId.replace('vote_assignuser_', '');
      const pending = pendingDistributions.get(pendingId);
      if (!pending || pending.resolved) {
        return interaction.reply({ content: '❌ Cette demande a déjà été traitée.', ephemeral: true });
      }
      pending.resolved = true;
      const selectedUserId = interaction.values[0];
      const result = await addCashToUser(selectedUserId, pending.totalGain, `Votes ${pending.monthName} (${pending.playername})`);
      const statusText = result.success ? '✅ Distribué' : '❌ Échec';
      await interaction.update({
        content: `## ✅ Joueur attribué\n\n**${pending.playername}** → <@${selectedUserId}>\n${statusText} : **${pending.totalGain.toLocaleString('fr-FR')}** 💎`,
        components: [],
      });
      return;
    }
  }

  if (interaction.isStringSelectMenu()) {
    // ── Sélection du gain pour la création de giveaway ──
    if (interaction.customId.startsWith('giveaway_item_select_')) {
      const parts = interaction.customId.replace('giveaway_item_select_', '').split('|');
      const channelId = parts[0];
      const pingEveryone = parts[1] || '0';
      const selectedItemId = interaction.values[0];

      const modal = new ModalBuilder()
        .setCustomId(`giveway_create_modal_${channelId}|${pingEveryone}|${selectedItemId}`)
        .setTitle('🎉 Créer un Giveaway');

      if (selectedItemId === '__libre__') {
        // Item libre : Titre / Nom du lot / Quantité / Heure / Description
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('gw_titre').setLabel('Titre du giveaway').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100).setPlaceholder('Ex: Giveaway Pack Légendaire')
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('gw_gain').setLabel('Nom du lot').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(120).setPlaceholder('Ex: Pack Légendaire')
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('gw_quantite').setLabel('Quantité').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(6).setPlaceholder('Ex: 5').setValue('1')
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('gw_heure').setLabel('Heure de fin (format 00:00, fuseau Paris)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(5).setPlaceholder('Ex: 21:00')
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('gw_description').setLabel('Description (optionnel)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500).setPlaceholder('Ex: Un giveaway spécial pour les membres actifs !')
          ),
        );
      } else {
        // Item inventaire : Titre / Gain (libre) / Heure / Description / Conditions
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('gw_titre').setLabel('Titre du giveaway').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100).setPlaceholder('Ex: Giveaway Pack Légendaire')
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('gw_gain').setLabel('Quantité').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(150).setPlaceholder('Ex: 5 Diamants, Pack Légendaire ×3...')
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('gw_heure').setLabel('Heure de fin (format 00:00, fuseau Paris)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(5).setPlaceholder('Ex: 21:00')
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('gw_description').setLabel('Description (optionnel)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500).setPlaceholder('Ex: Un giveaway spécial pour les membres actifs !')
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('gw_conditions').setLabel('Conditions (optionnel)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(300).setPlaceholder('Ex: Être membre depuis +30 jours')
          ),
        );
      }

      return interaction.showModal(modal);
    }

    if (interaction.customId === 'dino_letter_select') {
      const selectedLetter = interaction.values[0];

      try {
        await interaction.deferUpdate();
      } catch (err) {
        console.error('Erreur defer select menu:', err);
        return;
      }

      const grouped = getDinosByLetter();
      const letters = Object.keys(grouped).sort();
      const moddedDinos = getModdedDinos();
      const shoulderDinos = getShoulderDinos();
      const paidDLCDinos = getPaidDLCDinos();
      const totalDinos = letters.reduce((sum, l) => sum + grouped[l].length, 0) + moddedDinos.length;

      let embeds;
      if (selectedLetter === 'MODDED') {
        embeds = moddedDinos.length > 0 ? [buildModdedEmbed(moddedDinos)] : [];
      } else if (selectedLetter === 'SHOULDER') {
        embeds = shoulderDinos.length > 0 ? buildShoulderEmbeds(shoulderDinos) : [];
      } else if (selectedLetter === 'PAIDDLC') {
        embeds = paidDLCDinos.length > 0 ? buildPaidDLCEmbeds(paidDLCDinos) : [];
        if (embeds.length > 10) embeds = embeds.slice(0, 10);
      } else if (selectedLetter.startsWith('VAR_')) {
        const varLabel = selectedLetter.replace('VAR_', '');
        const dinoVariants = getDinosByVariant(varLabel);
        embeds = dinoVariants.length > 0 ? buildVariantEmbeds(varLabel, dinoVariants) : [];
        if (embeds.length > 10) embeds = embeds.slice(0, 10);
      } else if (selectedLetter.includes('-')) {
        const parts = selectedLetter.split('-');
        const allEmbeds = [];
        for (const p of parts) {
          const dinos = grouped[p];
          if (dinos && dinos.length > 0) {
            allEmbeds.push(...buildLetterEmbeds(p, dinos));
          }
        }
        embeds = allEmbeds.length > 0 ? allEmbeds : [];
        if (embeds.length > 10) embeds = embeds.slice(0, 10);
      } else {
        const dinos = grouped[selectedLetter];
        embeds = (dinos && dinos.length > 0) ? buildLetterEmbeds(selectedLetter, dinos) : [];
        if (embeds.length > 10) embeds = embeds.slice(0, 10);
      }

      const visibleVariants = getVisibleVariantLabels();
      console.log(`🧬 Menu dino: ${visibleVariants.length} variants visibles, épaule: ${shoulderDinos.length}, moddés: ${moddedDinos.length}, lettres: ${letters.length}`);

      let specialCount = 0;
      if (shoulderDinos.length > 0) specialCount++;
      if (moddedDinos.length > 0) specialCount++;
      if (paidDLCDinos.length > 0) specialCount++;
      specialCount += visibleVariants.length;
      const maxLetters = 25 - specialCount;

      const options = [];

      if (letters.length <= maxLetters) {
        letters.forEach(l => {
          options.push({
            label: `Lettre ${l}`,
            description: `${grouped[l].length} dino${grouped[l].length > 1 ? 's' : ''}`,
            value: l,
            emoji: '📖',
            default: l === selectedLetter,
          });
        });
      } else {
        for (let i = 0; i < letters.length; i += 2) {
          if (options.length >= 25 - specialCount) break;
          const l1 = letters[i];
          const l2 = letters[i + 1];
          if (l2) {
            const count = grouped[l1].length + grouped[l2].length;
            const val = `${l1}-${l2}`;
            options.push({
              label: `Lettres ${l1}-${l2}`,
              description: `${count} dino${count > 1 ? 's' : ''}`,
              value: val,
              emoji: '📖',
              default: val === selectedLetter || l1 === selectedLetter || l2 === selectedLetter,
            });
          } else {
            options.push({
              label: `Lettre ${l1}`,
              description: `${grouped[l1].length} dino${grouped[l1].length > 1 ? 's' : ''}`,
              value: l1,
              emoji: '📖',
              default: l1 === selectedLetter,
            });
          }
        }
      }

      if (shoulderDinos.length > 0) {
        options.push({
          label: 'Dinos d\'épaule',
          description: `${shoulderDinos.length} dino${shoulderDinos.length > 1 ? 's' : ''} d'épaule`,
          value: 'SHOULDER',
          emoji: '🦜',
          default: selectedLetter === 'SHOULDER',
        });
      }
      if (moddedDinos.length > 0) {
        options.push({
          label: 'Dinos Moddés',
          description: `${moddedDinos.length} dino${moddedDinos.length > 1 ? 's' : ''} moddé${moddedDinos.length > 1 ? 's' : ''}`,
          value: 'MODDED',
          emoji: '🔧',
          default: selectedLetter === 'MODDED',
        });
      }
      if (paidDLCDinos.length > 0) {
        options.push({
          label: 'DLC Payant',
          description: `${paidDLCDinos.length} dino${paidDLCDinos.length > 1 ? 's' : ''} DLC payant`,
          value: 'PAIDDLC',
          emoji: '💲',
          default: selectedLetter === 'PAIDDLC',
        });
      }

      for (const vl of visibleVariants) {
        if (options.length >= 25) break;
        options.push({
          label: `Variant ${vl.label}`,
          description: `${vl.count} dino${vl.count > 1 ? 's' : ''}`,
          value: `VAR_${vl.label}`,
          emoji: '🧬',
          default: selectedLetter === `VAR_${vl.label}`,
        });
      }

      if (options.length > 25) options.length = 25;

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('dino_letter_select')
        .setPlaceholder('🦖 Choisir une lettre...')
        .addOptions(options);

      const row = new ActionRowBuilder().addComponents(selectMenu);

      try {
        const totalChars = embeds.reduce((sum, e) => sum + (e.description || '').length, 0);
        console.log(`📤 Envoi: ${embeds.length} embeds, ${totalChars} chars total`);

        const channel = interaction.channel;
        const msgKey = `dino_extra_${interaction.message.id}`;
        const oldExtraIds = interaction.client._dinoExtraMessages?.[msgKey] || [];
        for (const id of oldExtraIds) {
          try { await channel.messages.fetch(id).then(m => m.delete()); } catch (e) {}
        }
        if (!interaction.client._dinoExtraMessages) interaction.client._dinoExtraMessages = {};
        interaction.client._dinoExtraMessages[msgKey] = [];

        if (totalChars <= 5900 || embeds.length <= 1) {
          await interaction.editReply({ content: '', embeds, components: [row] });
        } else {
          await interaction.editReply({ content: '', embeds: [embeds[0]], components: [row] });
          for (let i = 1; i < embeds.length; i++) {
            const extra = await channel.send({ embeds: [embeds[i]] });
            interaction.client._dinoExtraMessages[msgKey].push(extra.id);
          }
        }
      } catch (err) {
        console.error('Erreur select menu dino:', err.message || err);
        if (err.rawError) console.error('Discord raw error:', JSON.stringify(err.rawError));
      }
      return;
    }
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith('inv_libre_')) {
      const context = pendingLibreItems.get(interaction.customId);
      if (!context) {
        return interaction.reply({ content: '❌ Session expirée. Relance la commande.', ephemeral: true });
      }
      pendingLibreItems.delete(interaction.customId);

      const itemName = interaction.fields.getTextInputValue('item_name').trim();
      const qtyRaw = interaction.fields.getTextInputValue('item_qty').trim();
      const modalQty = parseInt(qtyRaw, 10);
      if (!modalQty || modalQty < 1) {
        return interaction.reply({ content: '❌ Quantité invalide. Saisis un nombre entier supérieur à 0.', ephemeral: true });
      }

      const itemLabel = `📦 ${itemName}`;
      const itemTypeId = `[libre] ${itemName}`;

      await addToInventory(context.targetUserId, itemTypeId, modalQty, context.adminId, context.reason);

      const embed = new EmbedBuilder()
        .setColor('#00BFFF')
        .setTitle('✅ Item ajouté')
        .setDescription(`**${itemLabel}** x${modalQty} ajouté à <@${context.targetUserId}>`)
        .setFooter({ text: '📌 Item occasionnel — non enregistré dans la liste' })
        .setTimestamp();

      if (context.reason) {
        embed.addFields({ name: 'Raison', value: context.reason, inline: false });
      }

      await interaction.reply({ embeds: [embed] });

      try {
        const settings = getSettings();
        const logChannelId = settings.guild?.inventoryLogChannelId;
        if (logChannelId) {
          const logChannel = await client.channels.fetch(logChannelId);
          if (logChannel) {
            const member = await interaction.guild.members.fetch(context.adminId).catch(() => null);
            const adminName = member ? member.displayName : context.adminId;
            await logChannel.send(`**${adminName}** a ajouté **${modalQty}x ${itemLabel}** à l'inventaire de <@${context.targetUserId}>`);
          }
        }
      } catch (e) {}
      return;
    }

  }

  if (interaction.isAutocomplete()) {
    const { commandName } = interaction;
    if (commandName === 'attribuer-pack') {
      const search = interaction.options.getFocused().toLowerCase();
      const data = getSpecialPacks();
      const choices = (data.packs || [])
        .filter(p => p.name.toLowerCase().includes(search))
        .slice(0, 25)
        .map(p => ({ name: `${p.type === 'donation' ? '💸' : '🗳️'} ${p.name}`, value: p.id }));
      try { await interaction.respond(choices); } catch (e) {}
      return;
    }
    if (commandName === 'inventaire-admin') {
      const focusedOption = interaction.options.getFocused(true);
      if (focusedOption.name === 'item') {
        const raw = focusedOption.value;
        const subcommand = interaction.options.getSubcommand(false);
        const itemTypes = getItemTypes();

        if (subcommand === 'ajouter') {
          const search = raw.toLowerCase().trim();
          const filtered = itemTypes
            .filter(it => !search || it.name.toLowerCase().includes(search) || it.id.includes(search) || it.emoji.includes(search))
            .slice(0, 24)
            .map(it => {
              const isCustom = /^<a?:\w+:\d+>$/.test(it.emoji);
              const baseName = isCustom ? it.name : `${it.emoji} ${it.name}`;
              return { name: baseName.slice(0, 100), value: it.id };
            });

          filtered.push({ name: '➕ Ajouter item occasionnel', value: '__libre__' });

          try { await interaction.respond(filtered); } catch (e) {}

        } else {
          // Sous-commande retirer — uniquement les items présents dans l'inventaire (qty > 0)
          const search = raw.toLowerCase();
          const joueurId = interaction.options.get('joueur')?.value;
          const playerInventory = joueurId ? getPlayerInventory(joueurId) : null;

          let filtered = [];

          if (playerInventory) {
            // Items standard : seulement ceux avec qty > 0
            filtered = itemTypes
              .filter(it => {
                const qty = playerInventory[it.id] || 0;
                if (qty <= 0) return false;
                return !search || it.name.toLowerCase().includes(search) || it.emoji.includes(search);
              })
              .slice(0, 22)
              .map(it => {
                const isCustom = /^<a?:\w+:\d+>$/.test(it.emoji);
                const baseName = isCustom ? it.name : `${it.emoji} ${it.name}`;
                const qty = playerInventory[it.id] || 0;
                return { name: `${baseName} (dispo: ${qty})`.slice(0, 100), value: it.id };
              });

            // Items occasionnels avec qty > 0
            for (const [key, qty] of Object.entries(playerInventory)) {
              if (key.startsWith('[libre] ') && qty > 0) {
                const name = key.slice('[libre] '.length);
                if (!search || name.toLowerCase().includes(search)) {
                  filtered.push({ name: `📦 ${name} (dispo: ${qty})`.slice(0, 100), value: key });
                }
              }
            }
          } else {
            // Pas de joueur sélectionné : afficher tous les types avec indication
            filtered = itemTypes
              .filter(it => !search || it.name.toLowerCase().includes(search))
              .slice(0, 24)
              .map(it => {
                const isCustom = /^<a?:\w+:\d+>$/.test(it.emoji);
                const baseName = isCustom ? it.name : `${it.emoji} ${it.name}`;
                return { name: baseName.slice(0, 100), value: it.id };
              });
          }

          if (filtered.length === 0 && playerInventory) {
            filtered = [{ name: '⚠️ Inventaire vide ou aucun item correspondant', value: '__empty__' }];
          }

          try { await interaction.respond(filtered.slice(0, 25)); } catch (e) {}
        }
      }
    }
    if (commandName === 'inventaire-distribuer-item') {
      const focusedOption = interaction.options.getFocused(true);
      if (focusedOption.name === 'item') {
        const raw = focusedOption.value;
        const search = raw.toLowerCase().trim();
        const itemTypes = getItemTypes();
        const filtered = itemTypes
          .filter(it => !search || it.name.toLowerCase().includes(search) || it.id.includes(search) || it.emoji.includes(search))
          .slice(0, 24)
          .map(it => {
            const isCustom = /^<a?:\w+:\d+>$/.test(it.emoji);
            const baseName = isCustom ? it.name : `${it.emoji} ${it.name}`;
            return { name: baseName.slice(0, 100), value: it.id };
          });
        filtered.push({ name: '➕ Item occasionnel (remplis le champ "nom")', value: '__libre__' });
        try { await interaction.respond(filtered); } catch (e) {}
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'shop') {
    try {
      await handleShopCommand(interaction);
    } catch (err) {
      console.error('[Shop] Erreur commande /shop:', err);
      try {
        const reply = { content: '❌ Impossible d\'ouvrir le shop. Réessaie.', ephemeral: true };
        if (interaction.replied || interaction.deferred) await interaction.followUp(reply);
        else await interaction.reply(reply);
      } catch (e) {}
    }
    return;
  }

  if (commandName === 'attribuer-pack') {
    if (!hasRoulettePermission(interaction.member)) {
      return interaction.reply({ content: '❌ Réservé aux administrateurs et Modos.', ephemeral: true });
    }
    const targetUser = interaction.options.getUser('joueur');
    const packId = interaction.options.getString('pack');
    const pack = getSpecialPack(packId);
    if (!pack) return interaction.reply({ content: '❌ Pack introuvable.', ephemeral: true });
    if (!pack.items || pack.items.length === 0) {
      return interaction.reply({ content: '❌ Ce pack ne contient aucun item.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: false });
    try {
      const itemTypes = getItemTypes();
      const lines = [];
      for (const item of pack.items) {
        const it = itemTypes.find(t => t.id === item.itemId);
        if (!it) continue;
        await addToInventory(
          targetUser.id,
          item.itemId,
          item.quantity,
          interaction.user.id,
          `Pack ${pack.name}`
        );
        const isCustom = /^<a?:\w+:\d+>$/.test(it.emoji);
        const emojiStr = isCustom ? it.emoji : it.emoji;
        lines.push(`${emojiStr} **${it.name}** ×${item.quantity}`);
      }
      const embed = new EmbedBuilder()
        .setColor(pack.color || '#7c5cfc')
        .setTitle(`🎁 Pack ${pack.name} attribué !`)
        .setDescription(
          `${targetUser} a reçu les items suivants :\n\n${lines.join('\n')}`
        )
        .setFooter({ text: `Attribué par ${interaction.user.displayName || interaction.user.username}` })
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('[attribuer-pack]', err);
      await interaction.editReply({ content: `❌ Erreur : ${err.message}` });
    }
    return;
  }

  if (commandName === 'roulette') {
    if (!hasRoulettePermission(interaction.member)) {
      return interaction.reply({
        content: '❌ Seuls les administrateurs et les Modos peuvent lancer la roulette !',
        ephemeral: true,
      });
    }

    await interaction.deferReply();

    try {
      const choices = config.rouletteChoices;
      const title = config.rouletteTitle || 'ARKI';
      const winningIndex = Math.floor(Math.random() * choices.length);
      const wheel = new RouletteWheel(choices, title);

      const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('🎰 Roulette Arki')
        .setDescription('⏳ Génération de l\'animation...')
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });

      const gifBuffer = await wheel.generateAnimatedGif(winningIndex);
      const winningChoice = wheel.getWinningChoice(winningIndex);

      const finalEmbed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('🎰 Roulette Arki - Résultat')
        .setDescription(`🎉 **Résultat:** ${winningChoice}`)
        .setFooter({ text: `Lancé par ${interaction.user.tag}` })
        .setTimestamp();

      const gifAttachment = new AttachmentBuilder(gifBuffer, { name: 'roulette.gif' });

      await interaction.editReply({
        embeds: [finalEmbed],
        files: [gifAttachment],
      });

      console.log(`🎲 Roulette lancée par ${interaction.user.tag}, résultat: ${winningChoice}`);

    } catch (error) {
      console.error('Erreur lors de la génération de la roulette:', error);
      await interaction.editReply({
        content: '❌ Une erreur est survenue lors de la génération de la roulette.',
      });
    }
  }

  if (commandName === 'set-choices') {
    if (!hasRoulettePermission(interaction.member)) {
      return interaction.reply({
        content: '❌ Seuls les administrateurs et les Modos peuvent modifier la configuration !',
        ephemeral: true,
      });
    }

    const newTitle = interaction.options.getString('title');
    const choicesString = interaction.options.getString('choices');
    const newChoices = choicesString.split(',').map(c => c.trim()).filter(c => c.length > 0);

    if (newTitle.trim().length === 0) {
      return interaction.reply({
        content: '❌ Le titre ne peut pas être vide !',
        ephemeral: true,
      });
    }

    if (newTitle.trim().length > 20) {
      return interaction.reply({
        content: '❌ Le titre ne doit pas dépasser 20 caractères !',
        ephemeral: true,
      });
    }

    if (newChoices.length < 2) {
      return interaction.reply({
        content: '❌ Vous devez fournir au moins 2 choix !',
        ephemeral: true,
      });
    }

    if (newChoices.length > 12) {
      return interaction.reply({
        content: '❌ Maximum 12 choix autorisés !',
        ephemeral: true,
      });
    }

    config.rouletteTitle = newTitle.trim();
    config.rouletteChoices = newChoices;
    await saveRouletteConfig({ rouletteTitle: config.rouletteTitle, rouletteChoices: config.rouletteChoices });

    const embed = new EmbedBuilder()
      .setColor('#00FF00')
      .setTitle('✅ Configuration mise à jour')
      .setDescription(`**🏆 Titre:** ${newTitle.trim()}\n\n**${newChoices.length} choix:**\n${newChoices.map((c, i) => `${i + 1}. ${c}`).join('\n')}`)
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
    console.log(`⚙️ Configuration mise à jour par ${interaction.user.tag} (titre: ${newTitle.trim()})`);
  }

  if (commandName === 'show-choices') {
    const choices = config.rouletteChoices;
    const title = config.rouletteTitle || 'ARKI';
    const embed = new EmbedBuilder()
      .setColor('#3498DB')
      .setTitle('📋 Choix actuels de la roulette')
      .setDescription(`**🏆 Titre:** ${title}\n\n**Choix disponibles:**\n${choices.map((c, i) => `${i + 1}. ${c}`).join('\n')}`)
      .setFooter({ text: `${choices.length} choix au total` })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'votes') {
    if (!hasRoulettePermission(interaction.member)) {
      return interaction.reply({
        content: '❌ Seuls les administrateurs et les Modos peuvent voir le classement !',
        ephemeral: true,
      });
    }

    await interaction.deferReply();

    try {
      const votesConfig = getVotesConfig();
      const ranking = await fetchTopserveursRanking(votesConfig.TOPSERVEURS_RANKING_URL);
      
      if (ranking.length === 0) {
        return interaction.editReply({
          content: '❌ Impossible de récupérer le classement des votes.',
        });
      }

      const now = new Date();
      const lastMonth = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
      const monthName = monthNameFr(lastMonth);

      let description = `**📊 Classement des votes - ${monthName}**\n\n`;
      
      const top10 = ranking.slice(0, 10);
      for (let i = 0; i < top10.length; i++) {
        const player = top10[i];
        const icon = votesConfig.STYLE.placeIcons[i] || `**${i + 1}.**`;
        const diamonds = player.votes * votesConfig.DIAMONDS_PER_VOTE;
        description += `${icon} **${player.playername}** - ${player.votes} votes (💎 ${diamonds})\n`;
      }

      const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle(`${votesConfig.STYLE.logo} Classement des votes`)
        .setDescription(description)
        .setFooter({ text: `Total: ${ranking.length} votants` })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
      console.log(`📊 Classement des votes consulté par ${interaction.user.tag}`);

    } catch (error) {
      console.error('Erreur lors de la récupération des votes:', error);
      await interaction.editReply({
        content: '❌ Une erreur est survenue lors de la récupération du classement.',
      });
    }
  }

  if (commandName === 'publish-votes') {
    if (!hasRoulettePermission(interaction.member)) {
      return interaction.reply({
        content: '❌ Seuls les administrateurs et les Modos peuvent publier les résultats !',
        ephemeral: true,
      });
    }

    await interaction.deferReply();

    try {
      const votesConfig = getVotesConfig();
      const ranking = await fetchTopserveursRanking(votesConfig.TOPSERVEURS_RANKING_URL);
      
      if (ranking.length === 0) {
        return interaction.editReply({
          content: '❌ Impossible de récupérer le classement des votes.',
        });
      }

      const guild = interaction.guild;
      const memberIndex = await buildMemberIndex(guild);

      const now = new Date();
      const lastMonth = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
      const monthName = monthNameFr(lastMonth);

      let adminChannel = null;
      try {
        if (votesConfig.ADMIN_LOG_CHANNEL_ID) adminChannel = await client.channels.fetch(votesConfig.ADMIN_LOG_CHANNEL_ID);
      } catch (e) {
        console.warn('⚠️ [VOTES] Salon admin introuvable:', votesConfig.ADMIN_LOG_CHANNEL_ID, e.message);
      }
      let reportChannel = null;
      try { reportChannel = await client.channels.fetch(VOTE_REPORT_CHANNEL_ID); } catch (e) {
        console.warn('⚠️ [VOTES] Salon de rapport introuvable:', VOTE_REPORT_CHANNEL_ID);
      }
      const { distributionResults, playerStatus } = await distributeWithChecks(ranking, memberIndex, votesConfig, monthName, adminChannel);

      let resultsMessage = `# ${votesConfig.STYLE.fireworks} Résultats des votes de ${monthName} ${votesConfig.STYLE.fireworks}\n\n`;
      const msg = votesConfig.MESSAGE || {};
      resultsMessage += `${msg.introText || ''}\n\n`;
      resultsMessage += `${votesConfig.STYLE.sparkly} ${msg.creditText || ''}\n\n`;

      const top10 = ranking.slice(0, 10);
      for (let i = 0; i < top10.length; i++) {
        const player = top10[i];
        const totalDiamonds = player.votes * votesConfig.DIAMONDS_PER_VOTE;
        const bonusDiamonds = votesConfig.TOP_DIAMONDS[i + 1] || 0;
        const status = playerStatus[player.playername];
        const statusIcon = status === 'success' ? '' : status === 'pending' ? ' ⏳' : status === 'failed' ? ' ❌' : ' ⚠️';
        
        resultsMessage += `${votesConfig.STYLE.animeArrow} **${i + 1}** - **${player.playername}**${statusIcon}\n`;
        resultsMessage += `Votes : ${player.votes} | Gains : ${totalDiamonds.toLocaleString('fr-FR')} ${votesConfig.STYLE.sparkly}\n`;
        
        if (i === 0) {
          resultsMessage += `+ ${msg.pack1Text || 'Pack vote 1ère place'} + rôle <@&${votesConfig.TOP_VOTER_ROLE_ID}>\n`;
        } else if (i === 1) {
          resultsMessage += `+ ${msg.pack2Text || 'Pack vote 2ème place'}\n`;
        } else if (i === 2) {
          resultsMessage += `+ ${msg.pack3Text || 'Pack vote 3ème place'}\n`;
        } else if (bonusDiamonds > 0) {
          resultsMessage += `+ ${bonusDiamonds.toLocaleString('fr-FR')} ${votesConfig.STYLE.sparkly}\n`;
        }
        resultsMessage += `\n`;
      }

      resultsMessage += `---\n`;
      resultsMessage += `${msg.memoText || 'Pour mémo'} ${votesConfig.STYLE.animeArrow} ${votesConfig.STYLE.memoUrl}\n\n`;
      resultsMessage += `-# ${msg.dinoShinyText || 'Tirage Dino Shiny juste après 🦖'}\n`;

      const fullListData = ranking.filter(p => p.votes >= 10).map(p => {
        const totalDiamonds = p.votes * votesConfig.DIAMONDS_PER_VOTE;
        const idx = ranking.indexOf(p);
        const bonusDiamonds = votesConfig.TOP_DIAMONDS[idx + 1] || 0;
        const status = playerStatus[p.playername];
        return { ...p, totalGain: totalDiamonds + bonusDiamonds, status };
      });
      
      global.lastVotesFullList = { data: fullListData, monthName, memberIndex };

      const button = new ButtonBuilder()
        .setCustomId('show_full_votes_list')
        .setLabel('📋 Voir la liste complète')
        .setStyle(ButtonStyle.Secondary);
      const row = new ActionRowBuilder().addComponents(button);

      let resultsChannel = null;
      try {
        if (votesConfig.RESULTS_CHANNEL_ID) resultsChannel = await client.channels.fetch(votesConfig.RESULTS_CHANNEL_ID);
      } catch (e) {
        console.error('❌ [VOTES] Salon de résultats introuvable:', votesConfig.RESULTS_CHANNEL_ID, e.message);
      }
      if (resultsChannel) {
        const pingPrefix = votesConfig.STYLE.everyonePing ? '|| @everyone ||\n' : '';
        if (fs.existsSync(VOTE_BANNER_PATH)) {
          await resultsChannel.send({ content: pingPrefix || undefined, files: [{ attachment: VOTE_BANNER_PATH, name: 'recompenses-votes.jpg' }] });
        }
        const fullText = pingPrefix + resultsMessage;
        const chunks = splitMessage(fullText, 1900);
        for (let ci = 0; ci < chunks.length; ci++) {
          const isLast = ci === chunks.length - 1;
          await resultsChannel.send({ content: chunks[ci], components: isLast ? [row] : [] });
        }
      }

      const dinoTitle = msg.dinoTitle || 'DINO';
      const rouletteWheel = new RouletteWheel(top10.map(p => p.playername), dinoTitle);
      const winningIndex = Math.floor(Math.random() * top10.length);
      const gifBuffer = await rouletteWheel.generateAnimatedGif(winningIndex);
      const winningChoice = rouletteWheel.getWinningChoice(winningIndex);
      const attachment = new AttachmentBuilder(gifBuffer, { name: 'dino-shiny-roulette.gif' });
      
      if (resultsChannel) {
        const pingPrefix = votesConfig.STYLE.everyonePing ? '|| @everyone ||\n' : '';
        await resultsChannel.send({
          content: `${pingPrefix}## 🦖 Tirage Dino Shiny du mois !\n\nParticipants :\n${top10.map((p, i) => {
            return `${i + 1}. **${p.playername}**`;
          }).join('\n')}\n\n🎰 C'est parti !`,
          files: [attachment]
        });
        
        const dinoWinText = msg.dinoWinText || 'Tu remportes le **Dino Shiny** du mois ! 🦖✨';
        await resultsChannel.send(`${pingPrefix}## 🎉 Félicitations **${winningChoice}** !\n\n${dinoWinText}`);
      }

      const draftBotCommands = generateDraftBotCommands(ranking, memberIndex, resolvePlayer);

      // Rapport de distribution dans le salon dédié
      if (reportChannel) {
        const reportMsg = buildDistributionReport(ranking, memberIndex, votesConfig, playerStatus, monthName, 'manual');
        for (const chunk of splitMessage(reportMsg, 1900)) {
          await reportChannel.send(chunk);
        }
      }

      // Message admin (doublons, non trouvés, commandes DraftBot)
      let adminMessage = `📊 **Rapport admin — ${monthName}**\n\n`;
      adminMessage += `💎 **UnbelievaBoat :** ${distributionResults.success} distribué(s)`;
      if (distributionResults.failed > 0) adminMessage += `, ${distributionResults.failed} échec(s)`;
      adminMessage += `\n📦 **Inventaire :** ${distributionResults.inventoryResults.length} crédit(s)\n`;
      if (distributionResults.pendingDuplicates > 0) {
        adminMessage += `⏳ ${distributionResults.pendingDuplicates} doublon(s) en attente de validation\n`;
      }
      if (distributionResults.pendingNotFound > 0) {
        adminMessage += `⏳ ${distributionResults.pendingNotFound} joueur(s) non trouvé(s) en attente\n`;
      }
      if (draftBotCommands.length > 0) {
        adminMessage += `\n🎁 **Commandes DraftBot :**\n\`\`\`\n${draftBotCommands.join('\n')}\n\`\`\``;
      }

      if (adminChannel) {
        await adminChannel.send(adminMessage);
      }

      let replyText = `✅ Résultats publiés dans <#${votesConfig.RESULTS_CHANNEL_ID}> | 📊 Rapport dans <#${VOTE_REPORT_CHANNEL_ID}>`;
      if (distributionResults.pendingDuplicates > 0 || distributionResults.pendingNotFound > 0) {
        replyText += ` | ⏳ ${distributionResults.pendingDuplicates + distributionResults.pendingNotFound} distribution(s) en attente dans <#${votesConfig.ADMIN_LOG_CHANNEL_ID}>`;
      }
      await interaction.editReply({ content: replyText });
      console.log(`📢 Résultats des votes publiés par ${interaction.user.tag} - ${distributionResults.success} récompensés`);

    } catch (error) {
      console.error('Erreur lors de la publication des votes:', error);
      await interaction.editReply({
        content: '❌ Une erreur est survenue lors de la publication des résultats.',
      });
    }
  }

  if (commandName === 'test-votes') {
    if (!hasRoulettePermission(interaction.member)) {
      return interaction.reply({
        content: '❌ Seuls les administrateurs et les Modos peuvent tester !',
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const votesConfig = getVotesConfig();
      const ranking = await fetchTopserveursRanking(votesConfig.TOPSERVEURS_RANKING_URL);
      
      if (ranking.length === 0) {
        return interaction.editReply({
          content: '❌ Impossible de récupérer le classement des votes.',
        });
      }

      const guild = interaction.guild;
      const memberIndex = await buildMemberIndex(guild);

      const now = new Date();
      const lastMonth = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
      const monthName = monthNameFr(lastMonth);

      const msg = votesConfig.MESSAGE || {};
      let previewMessage = `# ${votesConfig.STYLE.fireworks} Résultats des votes de ${monthName} ${votesConfig.STYLE.fireworks}\n\n`;
      previewMessage += `${msg.introText || ''}\n\n`;
      previewMessage += `${votesConfig.STYLE.sparkly} ${msg.creditText || ''}\n\n`;

      const top10 = ranking.slice(0, 10);
      for (let i = 0; i < top10.length; i++) {
        const player = top10[i];
        const totalDiamonds = player.votes * votesConfig.DIAMONDS_PER_VOTE;
        const bonusDiamonds = votesConfig.TOP_DIAMONDS[i + 1] || 0;
        const memberId = resolvePlayer(memberIndex, player.playername);
        
        previewMessage += `${votesConfig.STYLE.animeArrow} **${i + 1}** - **${player.playername}**\n`;
        previewMessage += `Votes : ${player.votes} | Gains : ${totalDiamonds.toLocaleString('fr-FR')} ${votesConfig.STYLE.sparkly}\n`;
        
        if (i === 0) {
          previewMessage += `+ ${msg.pack1Text || 'Pack vote 1ère place'} + rôle <@&${votesConfig.TOP_VOTER_ROLE_ID}>\n`;
        } else if (i === 1) {
          previewMessage += `+ ${msg.pack2Text || 'Pack vote 2ème place'}\n`;
        } else if (i === 2) {
          previewMessage += `+ ${msg.pack3Text || 'Pack vote 3ème place'}\n`;
        } else if (bonusDiamonds > 0) {
          previewMessage += `+ ${bonusDiamonds.toLocaleString('fr-FR')} ${votesConfig.STYLE.sparkly}\n`;
        }
        previewMessage += `\n`;
      }

      previewMessage += `---\n`;
      previewMessage += `${msg.memoText || 'Pour mémo'} ${votesConfig.STYLE.animeArrow} ${votesConfig.STYLE.memoUrl}\n\n`;
      previewMessage += `-# ${msg.dinoShinyText || 'Tirage Dino Shiny juste après 🦖'}\n`;

      const foundCount = ranking.filter(p => resolvePlayer(memberIndex, p.playername)).length;
      const notFoundList = ranking.filter(p => !resolvePlayer(memberIndex, p.playername)).map(p => p.playername);

      const fullListData = ranking.filter(p => p.votes >= 10).map(p => {
        const totalDiamonds = p.votes * votesConfig.DIAMONDS_PER_VOTE;
        const idx = ranking.indexOf(p);
        const bonusDiamonds = votesConfig.TOP_DIAMONDS[idx + 1] || 0;
        const memberId = resolvePlayer(memberIndex, p.playername);
        const status = memberId ? 'pending' : 'notfound';
        return { ...p, totalGain: totalDiamonds + bonusDiamonds, status };
      });
      
      global.lastVotesFullList = { data: fullListData, monthName, memberIndex };

      const button = new ButtonBuilder()
        .setCustomId('show_full_votes_list')
        .setLabel('📋 Voir la liste complète')
        .setStyle(ButtonStyle.Secondary);
      const row = new ActionRowBuilder().addComponents(button);

      const testChannel = interaction.channel;
      await testChannel.send(`⚠️ **TEST - PRÉVISUALISATION** ⚠️`);
      if (fs.existsSync(VOTE_BANNER_PATH)) {
        await testChannel.send({ files: [{ attachment: VOTE_BANNER_PATH, name: 'recompenses-votes.jpg' }] });
      }
      let finalMessage = previewMessage;
      if (votesConfig.STYLE.everyonePing) {
        finalMessage = `|| @everyone ||\n` + finalMessage;
      }
      const chunks = finalMessage.match(/[\s\S]{1,1900}/g) || [finalMessage];
      for (let i = 0; i < chunks.length; i++) {
        if (i === chunks.length - 1) {
          await testChannel.send({ content: chunks[i], components: [row] });
        } else {
          await testChannel.send(chunks[i]);
        }
      }
      
      let statsMessage = `📊 **Statistiques:**\n`;
      statsMessage += `• Total votants: ${ranking.length}\n`;
      statsMessage += `• Reconnus: ${foundCount} ✅\n`;
      statsMessage += `• Non trouvés: ${notFoundList.length} ❌\n`;
      if (notFoundList.length > 0) {
        statsMessage += `\n⚠️ Non trouvés: ${notFoundList.slice(0, 15).join(', ')}${notFoundList.length > 15 ? '...' : ''}`;
      }
      await testChannel.send(statsMessage);

      const dinoTitle2 = msg.dinoTitle || 'DINO';
      const rouletteWheel = new RouletteWheel(top10.map(p => p.playername), dinoTitle2);
      const winningIndex = Math.floor(Math.random() * top10.length);
      const gifBuffer = await rouletteWheel.generateAnimatedGif(winningIndex);
      const winningChoice = rouletteWheel.getWinningChoice(winningIndex);
      const attachment = new AttachmentBuilder(gifBuffer, { name: 'dino-shiny-roulette.gif' });
      
      await testChannel.send({
        content: `## 🦖 Tirage Dino Shiny du mois !\n\nParticipants :\n${top10.map((p, i) => {
          return `${i + 1}. **${p.playername}**`;
        }).join('\n')}\n\n🎰 C'est parti !`,
        files: [attachment]
      });
      
      const dinoWinText2 = msg.dinoWinText || 'Tu remportes le **Dino Shiny** du mois ! 🦖✨';
      await testChannel.send(`## 🎉 Félicitations **${winningChoice}** !\n\n${dinoWinText2}`);

      await interaction.editReply({ 
        content: `✅ Prévisualisation terminée !\n\nSi tout est correct, utilisez \`/publish-votes\` pour publier et distribuer.`
      });
      console.log(`🔍 Test des votes effectué par ${interaction.user.tag}`);

    } catch (error) {
      console.error('Erreur lors du test des votes:', error);
      await interaction.editReply({
        content: '❌ Une erreur est survenue lors du test.',
      });
    }
  }

  if (commandName === 'distribution_recompenses') {
    if (!hasRoulettePermission(interaction.member)) {
      return interaction.reply({
        content: '❌ Seuls les administrateurs et les Modos peuvent utiliser cette commande !',
        ephemeral: true,
      });
    }

    await interaction.deferReply();

    try {
      const votesConfig = getVotesConfig();
      const ranking = await fetchTopserveursRanking(votesConfig.TOPSERVEURS_RANKING_URL);

      if (ranking.length === 0) {
        return interaction.editReply({
          content: '❌ Impossible de récupérer le classement des votes.',
        });
      }

      const guild = interaction.guild;
      const memberIndex = await buildMemberIndex(guild);

      const now = new Date();
      const lastMonth = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
      const monthName = monthNameFr(lastMonth);

      let listMessage = `@here\n# 📋 Liste complète des votes de ${monthName}\n\n`;

      for (let i = 0; i < ranking.length; i++) {
        const player = ranking[i];
        const totalDiamonds = player.votes * votesConfig.DIAMONDS_PER_VOTE;
        const bonusDiamonds = votesConfig.TOP_DIAMONDS[i + 1] || 0;
        const totalGain = totalDiamonds + bonusDiamonds;
        const memberId = resolvePlayer(memberIndex, player.playername);

        let line = `**${i + 1}.** `;
        if (memberId) {
          line += `<@${memberId}>`;
        } else {
          line += `**${player.playername}**`;
        }
        line += ` — ${player.votes} vote${player.votes > 1 ? 's' : ''} — ${totalGain.toLocaleString('fr-FR')} ${votesConfig.STYLE.sparkly}`;

        if (i < 3) {
          const packTexts = [
            votesConfig.MESSAGE?.pack1Text || 'Pack vote 1ère place',
            votesConfig.MESSAGE?.pack2Text || 'Pack vote 2ème place',
            votesConfig.MESSAGE?.pack3Text || 'Pack vote 3ème place',
          ];
          line += ` + ${packTexts[i]}`;
          if (i === 0) line += ` + <@&${votesConfig.TOP_VOTER_ROLE_ID}>`;
        }

        listMessage += line + '\n';
      }

      listMessage += `\n---\n-# Total : **${ranking.length}** votants — **${ranking.reduce((s, p) => s + p.votes, 0)}** votes`;

      const chunks = [];
      let current = '';
      for (const line of listMessage.split('\n')) {
        if ((current + line + '\n').length > 1900) {
          chunks.push(current);
          current = line + '\n';
        } else {
          current += line + '\n';
        }
      }
      if (current.trim()) chunks.push(current);

      const channel = interaction.channel;
      for (let i = 0; i < chunks.length; i++) {
        if (i === 0) {
          await channel.send({ content: chunks[i], allowedMentions: { parse: ['everyone', 'roles', 'users'] } });
        } else {
          await channel.send({ content: chunks[i] });
        }
      }

      await interaction.editReply({ content: '✅ Liste complète publiée !' });

    } catch (error) {
      console.error('Erreur lors de la publication de la liste des votes:', error);
      await interaction.editReply({
        content: '❌ Une erreur est survenue.',
      });
    }
  }

  if (commandName === 'vote-rapport') {
    if (!hasRoulettePermission(interaction.member)) {
      return interaction.reply({ content: '❌ Seuls les administrateurs et les Modos peuvent utiliser cette commande !', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const votesConfig = getVotesConfig();
      const ranking = await fetchTopserveursRanking(votesConfig.TOPSERVEURS_RANKING_URL);

      if (ranking.length === 0) {
        return interaction.editReply({ content: '❌ Impossible de récupérer le classement des votes (API indisponible ou aucun votant).' });
      }

      const guild = interaction.guild;
      const memberIndex = await buildMemberIndex(guild);

      const parisMonth = parseInt(new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', month: 'numeric' }).format(new Date()), 10);
      const lastMonth = parisMonth === 1 ? 11 : parisMonth - 2;
      const monthName = monthNameFr(lastMonth);
      const sparkly = votesConfig.STYLE?.sparkly || '💎';

      let report = `📊 **Rapport de distribution — ${monthName}**\n`;
      report += `-# Généré le ${new Date().toLocaleDateString('fr-FR')} — ne relance pas les paiements\n\n`;

      const notFoundList = [];
      for (let i = 0; i < ranking.length; i++) {
        const player = ranking[i];
        const rankIdx = i + 1;
        const totalDiamonds = player.votes * votesConfig.DIAMONDS_PER_VOTE;
        const bonusDiamonds = votesConfig.TOP_DIAMONDS[rankIdx] || 0;
        const isRank4or5 = rankIdx === 4 || rankIdx === 5;
        const ubGain = isRank4or5 ? totalDiamonds : totalDiamonds + bonusDiamonds;
        const memberId = resolvePlayer(memberIndex, player.playername);

        if (memberId) {
          report += `**${rankIdx}.** <@${memberId}> (\`${player.playername}\`) — ${player.votes} votes → ${ubGain.toLocaleString('fr-FR')} ${sparkly}`;
        } else {
          report += `**${rankIdx}.** ⚠️ \`${player.playername}\` *(non trouvé)* — ${player.votes} votes → ${ubGain.toLocaleString('fr-FR')} ${sparkly} **non envoyé**`;
          notFoundList.push({ player, rankIdx, ubGain });
        }

        if (rankIdx <= 3) {
          const packLabels = ['Pack 1ère place vote', 'Pack 2ème place vote', 'Pack 3ème place vote'];
          report += ` + 📦 ${packLabels[rankIdx - 1]}`;
        }
        if (isRank4or5 && bonusDiamonds > 0) {
          report += ` + ${bonusDiamonds.toLocaleString('fr-FR')} ${sparkly} *(inventaire)*`;
        }
        report += `\n`;
      }

      // Résumé
      const identified = ranking.length - notFoundList.length;
      report += `\n✅ **${identified}** membres identifiés | ⚠️ **${notFoundList.length}** non trouvés`;
      report += ` | ${ranking.length} votants au total\n`;

      if (notFoundList.length > 0) {
        report += `\n⚠️ **Joueurs sans compte Discord identifié — à payer manuellement :**\n`;
        for (const { player, rankIdx, ubGain } of notFoundList) {
          report += `• \`${player.playername}\` — rank #${rankIdx} — ${player.votes} votes — **${ubGain.toLocaleString('fr-FR')} ${sparkly}** dûs\n`;
        }
        report += `-# Pour les relier à un Discord : utilisez le bouton de résolution dans le salon admin lors du prochain \`/publish-votes\`.\n`;
      }

      // Envoi dans le salon courant (visible admin seulement)
      const chunks = splitMessage(report, 1900);
      for (const chunk of chunks) {
        await interaction.channel.send({ content: chunk });
      }

      await interaction.editReply({ content: `✅ Rapport publié dans ce salon (${chunks.length} message(s)).` });

    } catch (error) {
      console.error('Erreur /vote-rapport:', error);
      await interaction.editReply({ content: '❌ Une erreur est survenue lors de la génération du rapport.' });
    }
  }

  if (commandName === 'pay-votes') {
    if (!hasRoulettePermission(interaction.member)) {
      return interaction.reply({
        content: '❌ Seuls les administrateurs et les Modos peuvent distribuer les récompenses !',
        ephemeral: true,
      });
    }

    await interaction.deferReply();

    try {
      const votesConfig = getVotesConfig();
      const ranking = await fetchTopserveursRanking(votesConfig.TOPSERVEURS_RANKING_URL);
      
      if (ranking.length === 0) {
        return interaction.editReply({
          content: '❌ Impossible de récupérer le classement des votes.',
        });
      }

      const guild = interaction.guild;
      const memberIndex = await buildMemberIndex(guild);

      const now = new Date();
      const lastMonth = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
      const monthName = monthNameFr(lastMonth);

      let adminChannel = null;
      try {
        if (votesConfig.ADMIN_LOG_CHANNEL_ID) adminChannel = await client.channels.fetch(votesConfig.ADMIN_LOG_CHANNEL_ID);
      } catch (e) {
        console.warn('⚠️ [VOTES] Salon admin introuvable:', votesConfig.ADMIN_LOG_CHANNEL_ID, e.message);
      }
      const { distributionResults } = await distributeWithChecks(ranking, memberIndex, votesConfig, monthName, adminChannel);

      const draftBotCommands = generateDraftBotCommands(ranking, memberIndex, resolvePlayer);
      
      let adminMessage = `📊 **Rapport de distribution - ${monthName}**\n\n`;
      adminMessage += `💎 **Distribution UnbelievaBoat:**\n`;
      adminMessage += `   • ${distributionResults.success} joueurs récompensés\n`;
      if (distributionResults.failed > 0) {
        adminMessage += `   • ${distributionResults.failed} échecs\n`;
      }
      if (distributionResults.pendingDuplicates > 0) {
        adminMessage += `   • ⏳ ${distributionResults.pendingDuplicates} doublon(s) en attente de validation\n`;
      }
      if (distributionResults.pendingNotFound > 0) {
        adminMessage += `   • ⏳ ${distributionResults.pendingNotFound} joueur(s) non trouvé(s) en attente\n`;
      }

      if (draftBotCommands.length > 0) {
        adminMessage += `\n🎁 **Commandes DraftBot à copier-coller:**\n\`\`\`\n${draftBotCommands.join('\n')}\n\`\`\``;
      }

      if (adminChannel) {
        await adminChannel.send(adminMessage);
      }

      let replyText = `✅ Distribution terminée ! Rapport envoyé dans <#${votesConfig.ADMIN_LOG_CHANNEL_ID}>`;
      if (distributionResults.pendingDuplicates > 0 || distributionResults.pendingNotFound > 0) {
        replyText += ` | ⏳ ${distributionResults.pendingDuplicates + distributionResults.pendingNotFound} en attente`;
      }
      await interaction.editReply({ content: replyText });
      console.log(`💎 Distribution des votes par ${interaction.user.tag} - ${distributionResults.success} récompensés`);

    } catch (error) {
      console.error('Erreur lors de la distribution:', error);
      await interaction.editReply({
        content: '❌ Une erreur est survenue lors de la distribution.',
      });
    }
  }

  if (commandName === 'traduction') {
    const input = interaction.options.getString('message');
    await interaction.deferReply();

    try {
      let messageContent = '';
      let channelId = null;
      let messageId = null;

      const linkMatch = input.match(/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/);
      if (linkMatch) {
        channelId = linkMatch[2];
        messageId = linkMatch[3];
      } else if (/^\d+$/.test(input.trim())) {
        messageId = input.trim();
        channelId = interaction.channelId;
      }

      if (channelId && messageId) {
        const channel = await client.channels.fetch(channelId);
        const msg = await channel.messages.fetch(messageId);
        messageContent = msg.content;
      } else {
        messageContent = input;
      }

      if (!messageContent || messageContent.trim() === '') {
        return interaction.editReply({ content: '❌ Le message est vide ou introuvable.' });
      }

      const lines = messageContent.split('\n');
      const translatedLines = [];
      
      for (const line of lines) {
        if (line.trim() === '' || line.trim() === '---' || /^[#]+\s*$/.test(line.trim())) {
          translatedLines.push(line);
          continue;
        }

        const mdPrefix = line.match(/^(\s*(?:[#]+\s|[-*]\s|>\s|\d+\.\s|`{3}.*)?)/);
        const prefix = mdPrefix ? mdPrefix[1] : '';
        const textPart = line.slice(prefix.length);

        if (textPart.trim() === '') {
          translatedLines.push(line);
          continue;
        }

        const result = await translate(textPart, { to: 'fr' });
        translatedLines.push(prefix + result.text);
      }

      const translatedText = translatedLines.join('\n');
      
      let response = `## 🌐 Traduction\n\n${translatedText}`;
      
      if (response.length > 2000) {
        const chunks = response.match(/[\s\S]{1,1900}/g) || [response];
        await interaction.editReply({ content: chunks[0] });
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp({ content: chunks[i] });
        }
      } else {
        await interaction.editReply({ content: response });
      }
    } catch (error) {
      console.error('Erreur de traduction:', error);
      await interaction.editReply({
        content: '❌ Une erreur est survenue lors de la traduction. Vérifie que le lien ou l\'identifiant du message est correct.',
      });
    }
  }

  if (commandName === 'dino-roulette') {
    if (!hasRoulettePermission(interaction.member)) {
      return interaction.reply({
        content: '❌ Seuls les administrateurs et les Modos peuvent lancer la roulette Dino !',
        ephemeral: true,
      });
    }

    await interaction.deferReply();

    try {
      const votesConfig = getVotesConfig();
      const ranking = await fetchTopserveursRanking(votesConfig.TOPSERVEURS_RANKING_URL);
      
      if (ranking.length === 0) {
        return interaction.editReply({
          content: '❌ Impossible de récupérer le classement des votes.',
        });
      }

      const top10 = ranking.slice(0, 10);
      
      const msg = votesConfig.MESSAGE || {};
      const dinoTitle = msg.dinoTitle || 'DINO';
      const rouletteWheel = new RouletteWheel(top10.map(p => p.playername), dinoTitle);
      const winningIndex = Math.floor(Math.random() * top10.length);
      const gifBuffer = await rouletteWheel.generateAnimatedGif(winningIndex);
      const winningChoice = rouletteWheel.getWinningChoice(winningIndex);
      const attachment = new AttachmentBuilder(gifBuffer, { name: 'dino-shiny-roulette.gif' });

      const resultsChannel = await client.channels.fetch(votesConfig.RESULTS_CHANNEL_ID);
      
      if (resultsChannel) {
        await resultsChannel.send({
          content: `## 🦖 Tirage Dino Shiny du mois !\n\nParticipants :\n${top10.map((p, i) => {
            return `${i + 1}. **${p.playername}**`;
          }).join('\n')}\n\n🎰 C'est parti !`,
          files: [attachment]
        });
        
        const dinoWinText = msg.dinoWinText || 'Tu remportes le **Dino Shiny** du mois ! 🦖✨';
        await resultsChannel.send(`## 🎉 Félicitations **${winningChoice}** !\n\n${dinoWinText}`);
      }

      await interaction.editReply({
        content: `✅ Roulette Dino Shiny lancée dans <#${votesConfig.RESULTS_CHANNEL_ID}>\n🎉 Gagnant: **${winningChoice}**`,
      });
      console.log(`🦖 Roulette Dino Shiny lancée par ${interaction.user.tag}, gagnant: ${winningChoice}`);

    } catch (error) {
      console.error('Erreur lors de la roulette Dino:', error);
      await interaction.editReply({
        content: '❌ Une erreur est survenue lors de la roulette.',
      });
    }
  }

  if (commandName === 'inventaire') {
    const targetUser = interaction.options.getUser('joueur') || interaction.user;

    const inventory = getPlayerInventory(targetUser.id);
    const itemTypes = getItemTypes();

    const categoryMap = {};
    const categories = getCategories();
    for (const cat of categories) {
      categoryMap[cat.id] = { ...cat, items: [] };
    }

    for (const itemType of itemTypes) {
      const qty = inventory[itemType.id] || 0;
      const catId = itemType.category || 'other';
      if (!categoryMap[catId]) {
        categoryMap[catId] = { id: catId, name: catId, emoji: '📦', items: [] };
      }
      categoryMap[catId].items.push({ ...itemType, quantity: qty });
    }

    let description = '';
    let hasItems = false;

    const allCatIds = [...new Set([...categories.map(c => c.id), ...Object.keys(categoryMap)])];
    for (const catId of allCatIds) {
      const catData = categoryMap[catId];
      if (!catData || catData.items.length === 0) continue;

      const itemLines = catData.items
        .filter(it => it.quantity > 0)
        .sort((a, b) => a.order - b.order)
        .map(it => `${it.emoji} **${it.name}** : ${it.quantity.toLocaleString('fr-FR')}`);

      if (itemLines.length > 0) {
        hasItems = true;
        description += `### ${catData.emoji} ${catData.name}\n${itemLines.join('\n')}\n\n`;
      }
    }

    // Section items occasionnels (clés commençant par "[libre]")
    const occasionnelLines = [];
    for (const [key, qty] of Object.entries(inventory)) {
      if (key.startsWith('[libre] ') && qty > 0) {
        const name = key.slice('[libre] '.length);
        occasionnelLines.push(`📦 **${name}** : ${qty.toLocaleString('fr-FR')}`);
      }
    }
    if (occasionnelLines.length > 0) {
      hasItems = true;
      description += `### 📌 Occasionnel\n${occasionnelLines.join('\n')}\n\n`;
    }

    if (!hasItems) {
      description = '*Aucun item dans l\'inventaire.*';
    }

    // Section Pass Discord — XP progression (si le joueur a le rôle)
    const xpConfig   = await xpManager.loadXpConfig();
    const passRoleId = xpConfig.roleId || '1173596259328729189';
    // Priorité : option getMember → interaction.member (si c'est soi) → fetch API
    let targetMemberForXp = interaction.options.getMember('joueur')
      || (targetUser.id === interaction.user.id ? interaction.member : null)
      || await interaction.guild?.members.fetch(targetUser.id).catch(() => null);
    if (targetMemberForXp && targetMemberForXp.roles.cache.has(passRoleId)) {
      const userData = await xpManager.getUserData(targetUser.id);
      const { level, currentXp, xpForNext } = xpManager.calcLevelAndRemainder(userData.totalXp || 0);
      const pct    = xpForNext > 0 ? currentXp / xpForNext : 1;
      const filled = Math.round(pct * 20);
      const bar    = '█'.repeat(filled) + '░'.repeat(20 - filled);
      description += `\n### 🎖️ Pass Discord\nProgression vers le niveau **${level + 1}**\n\`${bar}\`\n${currentXp.toLocaleString('fr-FR')} / ${xpForNext.toLocaleString('fr-FR')} XP`;
    }

    const embed = new EmbedBuilder()
      .setColor('#2ECC71')
      .setTitle(`📦 Inventaire de ${targetUser.displayName || targetUser.username}`)
      .setDescription(description.trim())
      .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
      .setFooter({ text: `Demandé par ${interaction.user.username}` })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'inventaire-historique') {
    const targetUser = interaction.user;
    const { transactions, total } = getPlayerTransactions(targetUser.id, 20);
    const itemTypes = getItemTypes();

    if (transactions.length === 0) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor('#95A5A6')
            .setTitle('📜 Mon historique')
            .setDescription('*Aucune transaction enregistrée.*')
            .setTimestamp(),
        ],
        ephemeral: true,
      });
    }

    let description = '';
    for (const tx of transactions) {
      const itemType = itemTypes.find(it => it.id === tx.itemTypeId);
      const itemName = itemType ? `${itemType.emoji} ${itemType.name}` : tx.itemTypeId;
      const sign = tx.quantity >= 0 ? '+' : '';
      const typeLabel = tx.type === 'reset' ? '🔄' : tx.quantity >= 0 ? '📥' : '📤';
      const date = new Date(tx.timestamp).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });

      description += `${typeLabel} ${sign}${tx.quantity} ${itemName} — ${date}`;
      if (tx.reason) description += ` — *${tx.reason}*`;
      description += '\n';
    }

    if (description.length > 4000) {
      description = description.substring(0, 3990) + '\n...';
    }

    const embed = new EmbedBuilder()
      .setColor('#3498DB')
      .setTitle('📜 Mon historique')
      .setDescription(description.trim())
      .setFooter({ text: `${total} transaction(s) au total • Visible uniquement par toi` })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // ── /niveau ─────────────────────────────────────────────────────────────────
  if (commandName === 'niveau') {
    const targetUser   = interaction.options.getUser('membre') || interaction.user;
    const targetMember = interaction.options.getMember('membre') || interaction.member;
    const isSelf       = targetUser.id === interaction.user.id;
    const userData     = await xpManager.getUserData(targetUser.id);
    const { level, currentXp, xpForNext } = xpManager.calcLevelAndRemainder(userData.totalXp || 0);
    const displayName  = targetMember?.displayName || targetUser.username;
    const avatarURL    = targetUser.displayAvatarURL({ size: 128 });

    // Barre de progression (20 blocs)
    const pct    = xpForNext > 0 ? currentXp / xpForNext : 1;
    const filled = Math.round(pct * 20);
    const bar    = '█'.repeat(filled) + '░'.repeat(20 - filled);

    const xpConfig = await xpManager.loadXpConfig();
    const nextReward = xpConfig.customRewards[level + 1] !== undefined
      ? xpConfig.customRewards[level + 1]
      : xpManager.defaultRewardForLevel(level + 1, xpConfig.rewardMultiplier);

    // Rang au classement XP
    const allXp   = await xpManager.getAllXpData();
    const xpRanks = Object.entries(allXp)
      .map(([id, d]) => ({ id, totalXp: d.totalXp || 0 }))
      .filter(p => p.totalXp > 0)
      .sort((a, b) => b.totalXp - a.totalXp);
    const xpRank   = xpRanks.findIndex(p => p.id === targetUser.id) + 1;
    const xpRankTxt = xpRank > 0 ? `**#${xpRank}** sur ${xpRanks.length} joueur${xpRanks.length > 1 ? 's' : ''}` : '*Non classé*';

    const embed = new EmbedBuilder()
      .setColor(0x7c5cfc)
      .setAuthor({ name: `⭐ Niveau de ${displayName}`, iconURL: avatarURL })
      .setThumbnail(avatarURL)
      .addFields(
        { name: '🏅 Niveau', value: `**${level}**`, inline: true },
        { name: '✨ XP Total', value: `**${(userData.totalXp || 0).toLocaleString('fr-FR')}**`, inline: true },
        { name: '🏆 Classement XP', value: xpRankTxt, inline: true },
        { name: '🎯 Prochain palier', value: `**${nextReward.toLocaleString('fr-FR')} 💎** au niveau ${level + 1}`, inline: true },
        { name: `Progression vers le niveau ${level + 1}`, value: `\`${bar}\`\n${currentXp.toLocaleString('fr-FR')} / ${xpForNext.toLocaleString('fr-FR')} XP` },
      )
      .setFooter({ text: isSelf ? 'Continue à chatter pour gagner de l\'XP !' : `Profil consulté par ${interaction.member?.displayName || interaction.user.username}` })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }

  // ── /xp-donner ──────────────────────────────────────────────────────────────
  if (commandName === 'xp-donner') {
    const target = interaction.options.getUser('joueur');
    const amount = interaction.options.getInteger('montant');
    const result = await xpManager.addXp(target.id, amount);
    const { level, currentXp, xpForNext } = xpManager.calcLevelAndRemainder(result.totalXp);

    const embed = new EmbedBuilder()
      .setColor(0x4caf50)
      .setTitle('✨ XP accordé')
      .setDescription(`**${target.displayName || target.username}** a reçu **+${amount.toLocaleString('fr-FR')} XP**`)
      .addFields(
        { name: '🏅 Niveau actuel', value: `${level}`, inline: true },
        { name: '✨ XP Total', value: result.totalXp.toLocaleString('fr-FR'), inline: true },
      );

    if (result.leveledUp) {
      embed.addFields({ name: '🎉 Level-up !', value: result.levelsGained.map(l => `Niveau **${l.level}** → **+${l.reward.toLocaleString('fr-FR')} 💎**`).join('\n') });
      for (const lg of result.levelsGained) {
        if (lg.reward > 0) await addToInventory(target.id, 'diamants', lg.reward, 'Système XP', `Récompense niveau ${lg.level}`);
      }
    }

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // ── /xp-retirer ─────────────────────────────────────────────────────────────
  if (commandName === 'xp-retirer') {
    const target  = interaction.options.getUser('joueur');
    const amount  = interaction.options.getInteger('montant');
    const result  = await xpManager.addXp(target.id, -amount);
    const { level } = xpManager.calcLevelAndRemainder(result.totalXp);

    const embed = new EmbedBuilder()
      .setColor(0xf44336)
      .setTitle('🔻 XP retiré')
      .setDescription(`**${target.displayName || target.username}** a perdu **-${amount.toLocaleString('fr-FR')} XP**`)
      .addFields(
        { name: '🏅 Niveau actuel', value: `${level}`, inline: true },
        { name: '✨ XP Total', value: result.totalXp.toLocaleString('fr-FR'), inline: true },
      );

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // ── /xp-forcer-niveau ───────────────────────────────────────────────────────
  if (commandName === 'xp-forcer-niveau') {
    const target    = interaction.options.getUser('joueur');
    const targetLvl = interaction.options.getInteger('niveau');

    const oldData  = await xpManager.getUserData(target.id);
    const oldLevel = xpManager.calcLevel(oldData.totalXp || 0);

    // XP exact pour démarrer AU DÉBUT du niveau cible (0 XP dans ce niveau)
    const newTotalXp = xpManager.totalXpForLevel(targetLvl);
    await xpManager.setXp(target.id, newTotalXp);

    const embed = new EmbedBuilder()
      .setColor(0xff9800)
      .setTitle('🔧 Niveau forcé (migration)')
      .setDescription(
        `Le niveau de **${target.displayName || target.username}** a été défini à **${targetLvl}** sans déclencher les récompenses.`
      )
      .addFields(
        { name: '📉 Ancien niveau', value: `${oldLevel}`, inline: true },
        { name: '📈 Nouveau niveau', value: `${targetLvl}`, inline: true },
        { name: '✨ XP défini', value: `${newTotalXp.toLocaleString('fr-FR')}`, inline: true },
      )
      .setFooter({ text: `Action effectuée par ${interaction.member?.displayName || interaction.user.username} • aucun diamant distribué` })
      .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // ── /classement-xp ──────────────────────────────────────────────────────────
  if (commandName === 'classement-xp') {
    await interaction.deferReply();
    const allXp  = await xpManager.getAllXpData();
    const sorted = Object.entries(allXp)
      .map(([id, d]) => ({ id, totalXp: d.totalXp || 0, level: xpManager.calcLevel(d.totalXp || 0) }))
      .filter(p => p.totalXp > 0)
      .sort((a, b) => b.totalXp - a.totalXp || b.level - a.level);

    if (sorted.length === 0) return interaction.editReply({ content: '❌ Aucun joueur n\'a encore d\'XP !' });

    const { embed, row } = await buildXpPage(sorted, 0, interaction.user.id, interaction.guild);
    return interaction.editReply({ embeds: [embed], components: row ? [row] : [] });
  }

  // ── /aide ────────────────────────────────────────────────────────────────────
  if (commandName === 'aide') {
    const lines = [
      '**Arki Family — Commandes joueurs**\n',

      '__💰 Économie__',
      '    **/classement** : Classement des diamants du serveur (paginé, avec ta position).',
      '    **/compte** : Affiche ton solde diamants & fraises + ta place au classement.',
      '    **/envoyer** : Envoie des diamants à un autre joueur (raison obligatoire).',
      '    **/revenus** : Récupère tes revenus hebdomadaires selon tes rôles.',
      '    **/travail** : Gagne entre 50 et 250 💎 (utilisable toutes les 4h).',
      '',
      '__📦 Inventaire__',
      '    **/inventaire** : Affiche ton inventaire complet (ou celui d\'un joueur).',
      '    **/inventaire-historique** : Tes 20 dernières transactions (visible que par toi).',
      '    **/shop** : Parcourir le shop Arki et passer une commande.',
      '',
      '__⭐ Niveaux & XP__',
      '    **/classement-xp** : Classement des joueurs par XP (paginé, avec ta position).',
      '    **/niveau** : Ton niveau, ta progression XP et ta place au classement.',
      '',
      '__🎁 Giveaway__',
      '    **/giveway-participants** : Liste les participants du giveaway en cours.',
      '',
      '__🔤 Divers__',
      '    **/aide** : Affiche ce menu.',
      '    **/traduction** : Traduit un message Discord en français.',
    ];

    const embed = new EmbedBuilder()
      .setColor(0x7c5cfc)
      .setDescription(lines.join('\n'));

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // ── /aide-admin ──────────────────────────────────────────────────────────────
  if (commandName === 'aide-admin') {
    const lines = [
      '**Arki Family — Commandes Administration**\n',

      '__💰 Économie__',
      '    **/amende** : Inflige une amende en diamants à un joueur (log automatique).',
      '    **/revenus-debloquer** : Réinitialise le cooldown /revenus d\'un joueur (si nouveaux rôles non détectés).',
      '',
      '__🎁 Giveaway__',
      '    **/creer-giveway** : Crée et publie un giveaway dans le salon courant.',
      '    **/giveway-retirer** : Retire un participant du giveaway en cours.',
      '    **/relancer-giveway** : Relance le tirage au sort d\'un giveaway terminé.',
      '',
      '__📦 Inventaire__',
      '    **/attribuer-pack** : Attribue un pack spécial complet à un joueur.',
      '    **/inventaire-admin ajouter** : Ajoute des items à l\'inventaire d\'un joueur.',
      '    **/inventaire-admin historique** : Historique des transactions d\'un joueur.',
      '    **/inventaire-admin reset** : Réinitialise entièrement l\'inventaire d\'un joueur.',
      '    **/inventaire-admin retirer** : Retire des items de l\'inventaire d\'un joueur.',
      '    **/inventaire-distribuer-item** : Distribue un item à plusieurs joueurs en masse.',
      '    **/migrer-ub** : Importe les soldes UnbelievaBoat → Diamants Arki.',
      '',
      '__🎡 Roulette__',
      '    **/dino-roulette** : Lance la roulette Dino Shiny avec le top 10 des votants.',
      '    **/roulette** : Lance la roue de la chance Arki.',
      '    **/set-choices** : Modifie le titre et les choix de la roulette.',
      '    **/show-choices** : Affiche les choix actuels de la roulette.',
      '',
      '__🗳️ Votes mensuels__',
      '    **/distribution_recompenses** : Publie la liste complète votes + récompenses.',
      '    **/pay-votes** : Distribue les diamants sans publier de message.',
      '    **/publish-votes** : Publie les résultats officiels des votes du mois.',
      '    **/test-votes** : Prévisualise les résultats sans rien publier ni distribuer.',
      '    **/vote-rapport** : Rapport de distribution — payés / non payés.',
      '    **/votes** : Affiche le classement des votes du mois dernier.',
      '',
      '__⭐ XP__',
      '    **/xp-donner** : Donne de l\'XP à un joueur (déclenche les récompenses).',
      '    **/xp-forcer-niveau** : Force un niveau SANS distribuer les récompenses (migration).',
      '    **/xp-retirer** : Retire de l\'XP à un joueur.',
      '',
      '__🔄 Serveurs ARK SA (Nitrado)__',
      '    **/restart-programmer voir** : Liste tous les plannings de redémarrage automatique.',
      '    **/restart-programmer créer** : Programme un redémarrage quotidien (avec alertes in-game).',
      '    **/restart-programmer toggle** : Activer ou désactiver un planning.',
      '    **/restart-programmer supprimer** : Supprimer un planning.',
      '    **/restart-programmer lancer** : Déclencher immédiatement un redémarrage (SaveWorld + restart).',
    ];

    const embed = new EmbedBuilder()
      .setColor(0xf44336)
      .setDescription(lines.join('\n'));

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // ── /restart-programmer ───────────────────────────────────────────────────
  if (commandName === 'restart-programmer') {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: '❌ Commande réservée aux administrateurs.', ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ ephemeral: true });

    // ── voir ────────────────────────────────────────────────────────────────
    if (sub === 'voir') {
      const list = await restartScheduler.getAll();
      if (!list.length) {
        return interaction.editReply({ content: '📭 Aucun planning de redémarrage configuré.\nUtilise `/restart-programmer créer` pour en ajouter un.' });
      }

      const lines = list.map(s => {
        const statut = s.active ? '🟢' : '🔴';
        const warn   = s.avertissements !== false ? '🔔 30/15/5/1 min' : '🔕 Aucun';
        const maps   = !s.serverIds || !s.serverIds.length ? 'Toutes les maps' : `${s.serverIds.length} map(s) spécifique(s)`;
        const dernier = s.dernierRedemarrage
          ? new Date(s.dernierRedemarrage).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
          : 'Jamais';
        return [
          `${statut} **${s.nom}** — \`ID: ${s.id}\``,
          `  ⏰ Tous les jours à **${s.heure}** (Europe/Paris)`,
          `  🗺️ ${maps}`,
          `  ${warn}`,
          `  ⏱️ Dernier redémarrage : ${dernier}`,
        ].join('\n');
      });

      const embed = new EmbedBuilder()
        .setColor(0x7c5cfc)
        .setTitle('🔄 Plannings de redémarrage ARK SA')
        .setDescription(lines.join('\n\n'))
        .setFooter({ text: 'Utilise /restart-programmer toggle <id> pour activer/désactiver' });

      return interaction.editReply({ embeds: [embed] });
    }

    // ── créer ────────────────────────────────────────────────────────────────
    if (sub === 'créer') {
      const heure          = interaction.options.getString('heure');
      const nom            = interaction.options.getString('nom');
      const avertissements = interaction.options.getBoolean('avertissements') ?? true;

      try {
        const sched = await restartScheduler.create({ nom, heure, avertissements });
        const warn  = avertissements ? '🔔 Actifs (30/15/5/1 min avant)' : '🔕 Désactivés';

        const embed = new EmbedBuilder()
          .setColor(0x4caf50)
          .setTitle('✅ Planning créé')
          .addFields(
            { name: '📌 Nom',            value: nom,          inline: true },
            { name: '⏰ Heure',           value: `${heure} (Paris)`, inline: true },
            { name: '🗺️ Maps',            value: 'Toutes les maps',  inline: true },
            { name: '🔔 Avertissements',  value: warn,         inline: true },
            { name: '🆔 ID',              value: `\`${sched.id}\``,  inline: true },
          )
          .setFooter({ text: 'Le scheduler tourne côté bot (Railway) — il démarrera chaque nuit à l\'heure indiquée' });

        return interaction.editReply({ embeds: [embed] });
      } catch (e) {
        return interaction.editReply({ content: `❌ Erreur : ${e.message}` });
      }
    }

    // ── supprimer ────────────────────────────────────────────────────────────
    if (sub === 'supprimer') {
      const id = interaction.options.getString('id');
      try {
        await restartScheduler.remove(id);
        return interaction.editReply({ content: `✅ Planning \`${id}\` supprimé et jobs arrêtés.` });
      } catch (e) {
        return interaction.editReply({ content: `❌ ${e.message}` });
      }
    }

    // ── toggle ───────────────────────────────────────────────────────────────
    if (sub === 'toggle') {
      const id = interaction.options.getString('id');
      try {
        const sched = await restartScheduler.toggle(id);
        const msg = sched.active
          ? `✅ Planning **${sched.nom}** activé — redémarrage chaque jour à **${sched.heure}**.`
          : `⏸ Planning **${sched.nom}** désactivé.`;
        return interaction.editReply({ content: msg });
      } catch (e) {
        return interaction.editReply({ content: `❌ ${e.message}` });
      }
    }

    // ── lancer ───────────────────────────────────────────────────────────────
    if (sub === 'lancer') {
      const id = interaction.options.getString('id');
      const list = await restartScheduler.getAll();
      const sched = list.find(s => s.id === id);
      if (!sched) return interaction.editReply({ content: '❌ Planning introuvable.' });

      await interaction.editReply({ content: `⏳ Lancement du redémarrage **${sched.nom}**… (SaveWorld puis restart)` });

      try {
        const results = await restartScheduler.runNow(id);
        const ok    = results.filter(r => r.ok).length;
        const total = results.length;
        return interaction.followUp({ content: `✅ Redémarrage lancé sur **${ok}/${total}** serveur(s).`, ephemeral: true });
      } catch (e) {
        return interaction.followUp({ content: `❌ Erreur lors du redémarrage : ${e.message}`, ephemeral: true });
      }
    }

    return interaction.editReply({ content: '❌ Sous-commande inconnue.' });
  }

  if (commandName === 'classement') {
    await interaction.deferReply();
    const allInv   = getAllInventories();
    const sorted   = Object.entries(allInv)
      .map(([id, inv]) => ({ id, diamants: inv['diamants'] || 0 }))
      .filter(p => p.diamants > 0)
      .sort((a, b) => b.diamants - a.diamants);
    if (sorted.length === 0) {
      return interaction.editReply({ content: '❌ Aucun joueur n\'a encore de diamants !' });
    }
    const { embed, row } = await buildClassementPage(sorted, 0, interaction.user.id, interaction.guild);
    return interaction.editReply({ embeds: [embed], components: row ? [row] : [] });
  }

  // ─────────────────────────────────────────────────────────────────────────────

  if (commandName === 'compte') {
    const targetUser  = interaction.options.getUser('membre') || interaction.user;
    const targetMember = interaction.options.getMember('membre') || interaction.member;
    const isSelf      = targetUser.id === interaction.user.id;

    const inventory   = getPlayerInventory(targetUser.id);
    const diamants    = inventory['diamants'] || 0;
    const fraises     = inventory['fraises']  || 0;
    const displayName = targetMember?.displayName || targetUser.username;
    const avatarURL   = targetUser.displayAvatarURL({ size: 128 });

    // Rang au classement diamants
    const allInv    = getAllInventories();
    const diaRanks  = Object.entries(allInv)
      .map(([id, inv]) => ({ id, diamants: inv['diamants'] || 0 }))
      .filter(p => p.diamants > 0)
      .sort((a, b) => b.diamants - a.diamants);
    const diaRank    = diaRanks.findIndex(p => p.id === targetUser.id) + 1;
    const diaRankTxt = diaRank > 0 ? `**#${diaRank}** sur ${diaRanks.length} joueur${diaRanks.length > 1 ? 's' : ''}` : '*Non classé*';

    const embed = new EmbedBuilder()
      .setColor(0x7c5cfc)
      .setAuthor({ name: `💼 Compte de ${displayName}`, iconURL: avatarURL })
      .setThumbnail(avatarURL)
      .addFields(
        {
          name: '<a:SparklyCrystal:1366174439003263087> Diamants',
          value: `\`\`\`\n${diamants.toLocaleString('fr-FR')}\n\`\`\``,
          inline: true,
        },
        {
          name: '<:fraises:1328148609585123379> Fraises',
          value: `\`\`\`\n${fraises.toLocaleString('fr-FR')}\n\`\`\``,
          inline: true,
        },
        {
          name: '🏆 Classement Diamants',
          value: diaRankTxt,
          inline: true,
        },
      )
      .setFooter({ text: isSelf ? 'Utilise /travail toutes les 4h pour gagner des diamants !' : `Compte consulté par ${interaction.member?.displayName || interaction.user.username}` })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'inventaire-admin') {
    if (!hasRoulettePermission(interaction.member)) {
      return interaction.reply({
        content: '❌ Seuls les administrateurs et les Modos peuvent gérer les inventaires !',
        ephemeral: true,
      });
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'ajouter') {
      const targetUser = interaction.options.getUser('joueur');
      const rawItem = interaction.options.getString('item');
      const commandQty = interaction.options.getInteger('quantité');
      const reason = interaction.options.getString('raison') || '';

      // Item occasionnel → ouvrir la modale (nom + quantité)
      if (rawItem === '__libre__') {
        const modalKey = `inv_libre_${interaction.id}`;
        pendingLibreItems.set(modalKey, {
          targetUserId: targetUser.id,
          reason,
          adminId: interaction.user.id,
          guildId: interaction.guild.id,
        });
        setTimeout(() => pendingLibreItems.delete(modalKey), 10 * 60 * 1000);

        const modal = new ModalBuilder()
          .setCustomId(modalKey)
          .setTitle(`Item occasionnel → ${targetUser.displayName || targetUser.username}`);
        const nameInput = new TextInputBuilder()
          .setCustomId('item_name')
          .setLabel('Nom de l\'item')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Ex: Pack Boss Gamma, Selle Dragon Tek...')
          .setRequired(true)
          .setMaxLength(100);
        const qtyInput = new TextInputBuilder()
          .setCustomId('item_qty')
          .setLabel('Quantité')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Ex: 1')
          .setRequired(true)
          .setMaxLength(5)
          .setValue(commandQty ? String(commandQty) : '');
        modal.addComponents(
          new ActionRowBuilder().addComponents(nameInput),
          new ActionRowBuilder().addComponents(qtyInput),
        );
        return interaction.showModal(modal);
      }

      // Item standard
      const itemType = getItemTypeById(rawItem);
      if (!itemType) {
        return interaction.reply({ content: '❌ Item introuvable.', ephemeral: true });
      }

      const isCustomEmoji = /^<a?:\w+:\d+>$/.test(itemType.emoji);
      const itemLabel = isCustomEmoji ? itemType.name : `${itemType.emoji} ${itemType.name}`;

      const quantity = commandQty;
      await addToInventory(targetUser.id, rawItem, quantity, interaction.user.id, reason);

      const embed = new EmbedBuilder()
        .setColor('#00BFFF')
        .setTitle('✅ Item ajouté')
        .setDescription(`**${itemLabel}** x${quantity} ajouté à <@${targetUser.id}>`)
        .setTimestamp();

      if (reason) {
        embed.addFields({ name: 'Raison', value: reason, inline: false });
      }

      await interaction.reply({ embeds: [embed] });

      try {
        const settings = getSettings();
        const logChannelId = settings.guild.inventoryLogChannelId;
        if (logChannelId) {
          const logChannel = await client.channels.fetch(logChannelId);
          if (logChannel) {
            const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
            const adminName = member ? member.displayName : interaction.user.username;
            await logChannel.send(`**${adminName}** a ajouté **${quantity}x ${itemLabel}** à l'inventaire de <@${targetUser.id}>`);
          }
        }
      } catch (e) {}
    }

    if (subcommand === 'retirer') {
      const targetUser = interaction.options.getUser('joueur');
      const itemId = interaction.options.getString('item');
      const quantity = interaction.options.getInteger('quantité');
      const reason = interaction.options.getString('raison') || '';

      let itemLabel;

      if (itemId.startsWith('[libre] ')) {
        // Item occasionnel
        const name = itemId.slice('[libre] '.length);
        itemLabel = `📦 ${name}`;
      } else {
        const itemType = getItemTypeById(itemId);
        if (!itemType) {
          return interaction.reply({ content: '❌ Item introuvable.', ephemeral: true });
        }
        const isCustom = /^<a?:\w+:\d+>$/.test(itemType.emoji);
        itemLabel = isCustom ? itemType.name : `${itemType.emoji} ${itemType.name}`;
      }

      await removeFromInventory(targetUser.id, itemId, quantity, interaction.user.id, reason);

      const embed = new EmbedBuilder()
        .setColor('#E74C3C')
        .setTitle('➖ Item retiré')
        .setDescription(`**${itemLabel}** x${quantity} retiré de <@${targetUser.id}>`)
        .setTimestamp();

      if (reason) {
        embed.addFields({ name: 'Raison', value: reason, inline: false });
      }

      await interaction.reply({ embeds: [embed] });

      try {
        const settings = getSettings();
        const logChannelId = settings.guild.inventoryLogChannelId;
        if (logChannelId) {
          const logChannel = await client.channels.fetch(logChannelId);
          if (logChannel) {
            const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
            const adminName = member ? member.displayName : interaction.user.username;
            await logChannel.send(`**${adminName}** a retiré **${quantity}x ${itemLabel}** de l'inventaire de <@${targetUser.id}>`);
          }
        }
      } catch (e) {}
    }

    if (subcommand === 'reset') {
      const targetUser = interaction.options.getUser('joueur');

      const result = await resetPlayerInventory(targetUser.id, interaction.user.id, 'reset par commande');

      const embed = new EmbedBuilder()
        .setColor('#E67E22')
        .setTitle('🔄 Inventaire réinitialisé')
        .setDescription(`L'inventaire de <@${targetUser.id}> a été vidé.`)
        .addFields(
          { name: 'Items supprimés', value: `${result.itemsCleared}`, inline: true },
          { name: 'Par', value: `<@${interaction.user.id}>`, inline: true },
        )
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });

      try {
        const settings = getSettings();
        const logChannelId = settings.guild.inventoryLogChannelId;
        if (logChannelId) {
          const logChannel = await client.channels.fetch(logChannelId);
          if (logChannel) {
            const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
            const adminName = member ? member.displayName : interaction.user.username;
            await logChannel.send(`🔄 **${adminName}** a réinitialisé l'inventaire de <@${targetUser.id}> (${result.itemsCleared} items supprimés)`);
          }
        }
      } catch (e) {}
    }

    if (subcommand === 'historique') {
      const targetUser = interaction.options.getUser('joueur');

      const { transactions, total } = getPlayerTransactions(targetUser.id, 20);
      const itemTypes = getItemTypes();

      if (transactions.length === 0) {
        return interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor('#95A5A6')
              .setTitle(`📜 Historique de ${targetUser.displayName || targetUser.username}`)
              .setDescription('*Aucune transaction enregistrée.*')
              .setTimestamp(),
          ],
          ephemeral: true,
        });
      }

      let description = '';
      for (const tx of transactions) {
        const itemType = itemTypes.find(it => it.id === tx.itemTypeId);
        const itemName = itemType ? `${itemType.emoji} ${itemType.name}` : tx.itemTypeId;
        const sign = tx.quantity >= 0 ? '+' : '';
        const typeLabel = tx.type === 'reset' ? '🔄' : tx.quantity >= 0 ? '📥' : '📤';
        const date = new Date(tx.timestamp).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });

        description += `${typeLabel} ${sign}${tx.quantity} ${itemName} — <@${tx.adminId}> — ${date}`;
        if (tx.reason) description += ` — *${tx.reason}*`;
        description += '\n';
      }

      if (description.length > 4000) {
        description = description.substring(0, 3990) + '\n...';
      }

      const embed = new EmbedBuilder()
        .setColor('#3498DB')
        .setTitle(`📜 Historique de ${targetUser.displayName || targetUser.username}`)
        .setDescription(description.trim())
        .setFooter({ text: `${total} transaction(s) au total` })
        .setTimestamp();

      await interaction.reply({ embeds: [embed], ephemeral: true });
    }
  }

  if (commandName === 'inventaire-distribuer-item') {
    if (!hasRoulettePermission(interaction.member)) {
      return interaction.reply({ content: '❌ Seuls les administrateurs et les Modos peuvent distribuer des items !', ephemeral: true });
    }

    const joueursMentions = interaction.options.getString('joueurs');
    const rawItem = interaction.options.getString('item');
    const quantity = interaction.options.getInteger('quantité');
    const nomLibre = interaction.options.getString('nom') || '';
    const reason = interaction.options.getString('raison') || '';

    // Extraire les IDs depuis les mentions @user
    const mentionRegex = /<@!?(\d+)>/g;
    const playerIds = [];
    let match;
    while ((match = mentionRegex.exec(joueursMentions)) !== null) {
      if (!playerIds.includes(match[1])) playerIds.push(match[1]);
    }

    if (playerIds.length === 0) {
      return interaction.reply({ content: '❌ Aucun joueur valide trouvé. Mentionne les joueurs avec @.', ephemeral: true });
    }

    // Résoudre l'item
    let itemTypeId, itemLabel;
    if (rawItem === '__libre__') {
      if (!nomLibre.trim()) {
        return interaction.reply({ content: '❌ Pour un item occasionnel, remplis le champ **nom** avec le nom de l\'item.', ephemeral: true });
      }
      itemTypeId = `[libre] ${nomLibre.trim()}`;
      itemLabel = `📦 ${nomLibre.trim()}`;
    } else {
      const itemType = getItemTypeById(rawItem);
      if (!itemType) {
        return interaction.reply({ content: '❌ Item introuvable.', ephemeral: true });
      }
      const isCustom = /^<a?:\w+:\d+>$/.test(itemType.emoji);
      itemLabel = isCustom ? itemType.name : `${itemType.emoji} ${itemType.name}`;
      itemTypeId = rawItem;
    }

    await interaction.deferReply();

    const results = [];
    const errors = [];
    for (const playerId of playerIds) {
      try {
        await addToInventory(playerId, itemTypeId, quantity, interaction.user.id, reason);
        results.push(playerId);
      } catch (e) {
        errors.push(playerId);
      }
    }

    // Embed de confirmation
    const successList = results.map(id => `<@${id}>`).join(', ');
    const embed = new EmbedBuilder()
      .setColor('#00BFFF')
      .setTitle('✅ Distribution effectuée')
      .addFields(
        { name: 'Item', value: `${itemLabel} ×${quantity}`, inline: true },
        { name: 'Joueurs distribués', value: `${results.length}/${playerIds.length}`, inline: true },
      )
      .setTimestamp();

    if (successList) embed.setDescription(successList);
    if (reason) embed.addFields({ name: 'Raison', value: reason, inline: false });
    if (errors.length > 0) {
      embed.addFields({ name: '⚠️ Erreurs', value: errors.map(id => `<@${id}>`).join(', '), inline: false });
    }

    await interaction.editReply({ embeds: [embed] });

    // Log dans le canal inventaire
    try {
      const settings = getSettings();
      const logChannelId = settings.guild?.inventoryLogChannelId;
      if (logChannelId) {
        const logChannel = await client.channels.fetch(logChannelId);
        if (logChannel) {
          const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          const adminName = member ? member.displayName : interaction.user.username;
          await logChannel.send(`**${adminName}** a distribué **${quantity}x ${itemLabel}** à ${results.length} joueur(s) : ${results.map(id => `<@${id}>`).join(', ')}`);
        }
      }
    } catch (e) {}
  }

  // ── Commandes Giveaway ──
  if (commandName === 'creer-giveway') {
    if (!hasRoulettePermission(interaction.member)) {
      return interaction.reply({ content: '❌ Seuls les administrateurs et les Modos peuvent créer un giveaway.', ephemeral: true });
    }
    const pingEveryone = interaction.options.getBoolean('ping_everyone') ? '1' : '0';
    const channelId = interaction.channelId;

    // Étape 1 : afficher un menu de sélection pour choisir le gain
    const itemTypes = getItemTypes();
    const options = itemTypes.slice(0, 24).map(it => {
      const isCustom = /^<a?:\w+:\d+>$/.test(it.emoji);
      return {
        label: it.name.slice(0, 100),
        value: it.id,
        emoji: isCustom ? undefined : it.emoji || undefined,
        description: `Item d'inventaire — crédité automatiquement`.slice(0, 100),
      };
    });
    options.push({ label: 'Item occasionnel', value: '__libre__', emoji: '✨', description: 'Saisir le nom manuellement dans le formulaire' });

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`giveaway_item_select_${channelId}|${pingEveryone}`)
      .setPlaceholder('🎁 Choisir le gain du giveaway...')
      .addOptions(options);

    const row = new ActionRowBuilder().addComponents(selectMenu);

    return interaction.reply({
      content: '## 🎉 Créer un Giveaway\n**Étape 1/2 — Choisissez le gain :**',
      components: [row],
      ephemeral: true,
    });
  }

  if (commandName === 'giveway-participants') {
    if (!hasRoulettePermission(interaction.member)) {
      return interaction.reply({ content: '❌ Permission refusée.', ephemeral: true });
    }
    const gid = interaction.options.getString('id');
    let g;
    if (gid) {
      g = giveawayManager.getGiveaway(gid);
      if (!g) return interaction.reply({ content: `❌ Aucun giveaway avec l'ID \`${gid}\`.`, ephemeral: true });
    } else {
      // Auto-détecter : giveaway actif en cours, sinon dernier terminé
      const actives = giveawayManager.getActiveGiveaways();
      if (actives.length > 0) {
        g = actives.sort((a, b) => new Date(b.createdAt || b.endTime) - new Date(a.createdAt || a.endTime))[0];
      } else {
        const all = giveawayManager.getAllGiveaways();
        const ended = all.filter(x => x.status === 'ended').sort((a, b) => new Date(b.endTime) - new Date(a.endTime));
        if (ended.length === 0) return interaction.reply({ content: '❌ Aucun giveaway trouvé.', ephemeral: true });
        g = ended[0];
      }
    }

    const prizeLabel = buildPrizeLabel(g.prize);
    const embed = new EmbedBuilder()
      .setColor('#FF6B6B')
      .setTitle(`🎉 Participants — ${g.title}`)
      .setDescription(
        g.participants.length === 0
          ? '*Aucun participant.*'
          : g.participants.map((uid, i) => {
              const isWinner = g.winners.includes(uid);
              return `${i + 1}. <@${uid}>${isWinner ? ' 🏆' : ''}`;
            }).join('\n').slice(0, 4000)
      )
      .addFields(
        { name: 'Gain', value: prizeLabel, inline: true },
        { name: 'Participants', value: `${g.participants.length}`, inline: true },
        { name: 'Gagnants', value: `${g.winnerCount}`, inline: true },
        { name: 'Statut', value: g.status === 'active' ? '🟢 Actif' : '⚫ Terminé', inline: true },
      )
      .setFooter({ text: `ID: ${g.id}` })
      .setTimestamp();
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (commandName === 'giveway-retirer') {
    if (!hasRoulettePermission(interaction.member)) {
      return interaction.reply({ content: '❌ Permission refusée.', ephemeral: true });
    }
    const targetUser = interaction.options.getUser('utilisateur');
    const gid = interaction.options.getString('id');

    // Auto-détecter le giveaway actif si pas d'ID fourni
    let g;
    if (gid) {
      g = giveawayManager.getGiveaway(gid);
      if (!g) return interaction.reply({ content: `❌ Aucun giveaway avec l'ID \`${gid}\`.`, ephemeral: true });
    } else {
      const actives = giveawayManager.getActiveGiveaways();
      if (actives.length === 0) return interaction.reply({ content: '❌ Aucun giveaway actif en cours.', ephemeral: true });
      g = actives.sort((a, b) => new Date(b.createdAt || b.endTime) - new Date(a.createdAt || a.endTime))[0];
    }

    if (g.status !== 'active') {
      return interaction.reply({ content: '❌ Ce giveaway est déjà terminé.', ephemeral: true });
    }
    if (!g.participants.includes(targetUser.id)) {
      return interaction.reply({ content: `❌ <@${targetUser.id}> ne participe pas à ce giveaway.`, ephemeral: true });
    }

    await giveawayManager.removeParticipant(g.id, targetUser.id);
    const updated = giveawayManager.getGiveaway(g.id);

    // Mettre à jour l'embed Discord
    if (updated.messageId && updated.channelId) {
      try {
        const channel = await client.channels.fetch(updated.channelId);
        const msg = await channel.messages.fetch(updated.messageId).catch(() => null);
        if (msg) await msg.edit({ embeds: [buildGiveawayEmbed(updated)] });
      } catch (e) {}
    }

    return interaction.reply({
      content: `✅ <@${targetUser.id}> a été retiré du giveaway **${g.title}**.\n👤 Participants restants : **${updated.participants.length}**`,
      ephemeral: true,
    });
  }

  if (commandName === 'relancer-giveway') {
    if (!hasRoulettePermission(interaction.member)) {
      return interaction.reply({ content: '❌ Permission refusée.', ephemeral: true });
    }
    const gid = interaction.options.getString('id');
    const g = giveawayManager.getGiveaway(gid);
    if (!g) return interaction.reply({ content: `❌ Aucun giveaway avec l'ID \`${gid}\`.`, ephemeral: true });
    if (g.status !== 'ended') {
      return interaction.reply({ content: '❌ Ce giveaway est encore actif. Terminez-le d\'abord.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });
    const newWinners = await giveawayManager.rerollGiveaway(gid);
    const updated = giveawayManager.getGiveaway(gid);

    if (!newWinners || newWinners.length === 0) {
      return interaction.editReply({ content: '⚠️ Pas assez de participants éligibles pour un nouveau tirage.' });
    }

    const winnerMentions = newWinners.map(uid => `<@${uid}>`).join(', ');
    const prizeLabel = buildPrizeLabel(updated.prize);

    // Annoncer dans le salon du giveaway
    try {
      const channel = await client.channels.fetch(g.channelId);
      await channel.send(`🔄 **Re-tirage du Giveaway "${g.title}" !**\n\n🏆 Nouveaux gagnants : ${winnerMentions}\n**Gain :** ${prizeLabel}`);
    } catch (e) {}

    // Notifier en DM
    for (const uid of newWinners) {
      try {
        const user = await client.users.fetch(uid);
        await user.send(`🎉 Félicitations ! Suite à un re-tirage, tu remportes **${prizeLabel}** du giveaway **${g.title}** !\nContacte un administrateur pour recevoir ton gain.`);
      } catch (e) {}
    }

    return interaction.editReply({ content: `✅ Re-tirage effectué ! Gagnant(s) : ${winnerMentions}` });
  }
});

// ─── MIGRATION UNBELIEVABOAT → DIAMANTS ────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'migrer-ub') return;

  if (!interaction.memberPermissions?.has('Administrator')) {
    return interaction.reply({ content: '❌ Réservé aux administrateurs.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  const { getClient: getUnbClient, GUILD_ID: UNB_GUILD_ID } = require('./unbelievaboatService');
  const unbClient = getUnbClient();
  if (!unbClient) {
    return interaction.editReply('❌ Token UnbelievaBoat non configuré. Vérifie la variable `UNBELIEVABOAT_TOKEN`.');
  }

  const adminName = interaction.user.username || 'Admin';
  let totalPages = null;
  let currentPage = 1;
  let allUsers = [];

  await interaction.editReply('⏳ Récupération du leaderboard UnbelievaBoat… (peut prendre plusieurs secondes)');

  try {
    do {
      const result = await unbClient.getGuildLeaderboard(UNB_GUILD_ID, { page: currentPage, limit: 1000, sort: 'total' });
      if (result.totalPages !== undefined) {
        totalPages = result.totalPages;
        allUsers = allUsers.concat(result.users);
      } else {
        allUsers = allUsers.concat(Array.isArray(result) ? result : [result]);
        totalPages = 1;
      }
      currentPage++;
    } while (currentPage <= totalPages);
  } catch (err) {
    return interaction.editReply(`❌ Erreur lors de la récupération du leaderboard : ${err.message}`);
  }

  if (!allUsers.length) {
    return interaction.editReply('ℹ️ Aucun utilisateur trouvé dans le leaderboard UnbelievaBoat.');
  }

  let success = 0, skipped = 0, errors = 0;
  let totalDiamonds = 0;
  const errorList = [];

  for (const user of allUsers) {
    const userId = user.user_id || user.id;
    const cash = parseInt(user.cash) || 0;
    const bank = parseInt(user.bank) || 0;
    const total = cash + bank;
    if (total <= 0) { skipped++; continue; }

    try {
      await addToInventory(userId, 'diamants', total, adminName, `Migration UB — cash:${cash} banque:${bank}`);
      totalDiamonds += total;
      success++;
    } catch (err) {
      errors++;
      if (errorList.length < 5) errorList.push(`${userId}: ${err.message}`);
    }

    // Petite pause pour ne pas saturer la DB
    await new Promise(r => setTimeout(r, 30));
  }

  const lines = [
    `✅ **Migration UnbelievaBoat terminée !**`,
    ``,
    `📊 **Résultats :**`,
    `• Joueurs migrés : **${success}**`,
    `• Joueurs ignorés (solde 0) : **${skipped}**`,
    `• Erreurs : **${errors}**`,
    `• Total Diamants transférés : **${totalDiamonds.toLocaleString('fr-FR')}**`,
  ];
  if (errorList.length) lines.push(`\n⚠️ Premières erreurs :\n\`\`\`\n${errorList.join('\n')}\n\`\`\``);
  lines.push(`\n> Une fois vérifiée, tu peux supprimer la commande \`/migrer-ub\` de \`commands.js\`.`);

  return interaction.editReply(lines.join('\n'));
});

// ─── XP : gain automatique sur message ───────────────────────────────────────
client.on('messageCreate', async message => {
  // ── Fils poker : suppression automatique des messages joueurs ─────────────
  if (
    !message.author.bot &&
    message.guild &&
    message.channel?.name?.startsWith('♠️poker')
  ) {
    try { await message.delete(); } catch {}
    return;
  }

  if (message.author.bot || !message.guild) return;

  const xpConfig = await xpManager.loadXpConfig();

  // Vérifier le rôle requis
  const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member) return;
  if (xpConfig.roleId && !member.roles.cache.has(xpConfig.roleId)) return;

  // Vérifier les salons exclus
  if (xpConfig.excludedChannels && xpConfig.excludedChannels.includes(message.channelId)) return;

  // Cooldown anti-spam
  const lastMsg = await xpManager.getCooldown(message.author.id);
  if (Date.now() - lastMsg < xpConfig.cooldownMs) return;
  await xpManager.setCooldown(message.author.id);

  // Gain XP aléatoire
  const gain   = Math.floor(Math.random() * (xpConfig.maxXp - xpConfig.minXp + 1)) + xpConfig.minXp;
  const result = await xpManager.addXp(message.author.id, gain);

  // Level-up
  if (result.leveledUp && xpConfig.channelId) {
    try {
      const channel = message.guild.channels.cache.get(xpConfig.channelId);
      if (channel) {
        for (const lg of result.levelsGained) {
          const reward = lg.reward;
          if (reward > 0) await addToInventory(message.author.id, 'diamants', reward, 'Système XP', `Récompense niveau ${lg.level}`);

          const embed = new EmbedBuilder()
            .setColor(0xf9c740)
            .setTitle('🎉 Niveau supérieur !')
            .setDescription(
              `${message.author}, tu viens de passer au **niveau ${lg.level}** ! <a:emoji_15:11571117439012786216>\n\n` +
              (reward > 0 ? `🎁 Récompense : **+${reward.toLocaleString('fr-FR')} 💎**` : '')
            )
            .setThumbnail(message.author.displayAvatarURL({ size: 128 }))
            .setTimestamp();

          await channel.send({ embeds: [embed] });
        }
      }
    } catch (e) {
      console.error('[XP] Erreur envoi level-up:', e.message);
    }
  } else if (result.leveledUp) {
    // Créditer quand même les diamants si pas de salon configuré
    for (const lg of result.levelsGained) {
      if (lg.reward > 0) await addToInventory(message.author.id, 'diamants', lg.reward, 'Système XP', `Récompense niveau ${lg.level}`);
    }
  }
});

// ─── CLASSEMENT XP : helper de page ──────────────────────────────────────────
async function buildXpPage(sorted, page, callerId, guild) {
  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const safePage   = Math.max(0, Math.min(page, totalPages - 1));
  const slice      = sorted.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const callerRank = sorted.findIndex(p => p.id === callerId) + 1;

  const lines = await Promise.all(slice.map(async (p, i) => {
    const rank  = safePage * PAGE_SIZE + i;
    let name;
    try {
      const m = await guild.members.fetch(p.id);
      name = m.displayName;
    } catch { name = 'Joueur inconnu'; }
    const medal = MEDALS_CLS[rank] ?? `**${rank + 1}.**`;
    const arrow = p.id === callerId ? ' ◄' : '';
    return `${medal} **${name}** — Niv. **${p.level}** *(${p.totalXp.toLocaleString('fr-FR')} XP)*${arrow}`;
  }));

  let callerLine = '';
  const callerPage = callerRank > 0 ? Math.floor((callerRank - 1) / PAGE_SIZE) : -1;
  if (callerRank > 0 && callerPage !== safePage) {
    const ce = sorted[callerRank - 1];
    callerLine = `\n\n*Ta position : **#${callerRank}** — Niv. ${ce.level} (page ${callerPage + 1})*`;
  }

  const embed = new EmbedBuilder()
    .setColor(0x9c27b0)
    .setTitle('🏅 Classement XP')
    .setDescription(lines.join('\n') + callerLine)
    .setFooter({ text: `Page ${safePage + 1} / ${totalPages}  •  ${sorted.length} joueur${sorted.length > 1 ? 's' : ''} classé${sorted.length > 1 ? 's' : ''}` })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`xp_prev_${safePage}`).setLabel('◀ Précédent').setStyle(ButtonStyle.Secondary).setDisabled(safePage === 0),
    new ButtonBuilder().setCustomId(`xp_next_${safePage}`).setLabel('Suivant ▶').setStyle(ButtonStyle.Secondary).setDisabled(safePage >= totalPages - 1),
  );

  return { embed, row };
}

// ─── CLASSEMENT XP : navigation boutons ──────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('xp_prev_') && !interaction.customId.startsWith('xp_next_')) return;
  await interaction.deferUpdate();
  const isPrev  = interaction.customId.startsWith('xp_prev_');
  const curPage = parseInt(interaction.customId.split('_')[2]) ?? 0;
  const newPage = isPrev ? curPage - 1 : curPage + 1;
  const allXp   = await xpManager.getAllXpData();
  const sorted  = Object.entries(allXp)
    .map(([id, d]) => ({ id, totalXp: d.totalXp || 0, level: xpManager.calcLevel(d.totalXp || 0) }))
    .filter(p => p.totalXp > 0)
    .sort((a, b) => b.totalXp - a.totalXp);
  if (sorted.length === 0) return;
  const { embed, row } = await buildXpPage(sorted, newPage, interaction.user.id, interaction.guild);
  await interaction.editReply({ embeds: [embed], components: [row] });
});

// ─── CLASSEMENT : helper de page ─────────────────────────────────────────────
const PAGE_SIZE = 10;
const MEDALS_CLS = ['🥇', '🥈', '🥉'];

async function buildClassementPage(sorted, page, callerId, guild) {
  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const safePage   = Math.max(0, Math.min(page, totalPages - 1));
  const slice      = sorted.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const callerRank = sorted.findIndex(p => p.id === callerId) + 1;

  const lines = await Promise.all(slice.map(async (p, i) => {
    const rank = safePage * PAGE_SIZE + i;
    let name;
    try {
      const member = await guild.members.fetch(p.id);
      name = member.displayName;
    } catch {
      name = 'Joueur inconnu';
    }
    const medal = MEDALS_CLS[rank] ?? `**${rank + 1}.**`;
    const arrow = p.id === callerId ? ' ◄' : '';
    return `${medal} **${name}** — ${p.diamants.toLocaleString('fr-FR')} 💎${arrow}`;
  }));

  // Position du joueur hors de la page courante
  let callerLine = '';
  const callerPage = callerRank > 0 ? Math.floor((callerRank - 1) / PAGE_SIZE) : -1;
  if (callerRank > 0 && callerPage !== safePage) {
    const callerEntry = sorted[callerRank - 1];
    callerLine = `\n\n*Ta position : **#${callerRank}** — ${callerEntry.diamants.toLocaleString('fr-FR')} 💎 (page ${callerPage + 1})*`;
  }

  const embed = new EmbedBuilder()
    .setColor(0xf9c740)
    .setTitle('🏆 Classement des Diamants')
    .setDescription(lines.join('\n') + callerLine)
    .setFooter({ text: `Page ${safePage + 1} / ${totalPages}  •  ${sorted.length} joueur${sorted.length > 1 ? 's' : ''} classé${sorted.length > 1 ? 's' : ''}` })
    .setTimestamp();

  // Boutons navigation
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`cls_prev_${safePage}`)
      .setLabel('◀ Précédent')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage === 0),
    new ButtonBuilder()
      .setCustomId(`cls_next_${safePage}`)
      .setLabel('Suivant ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage >= totalPages - 1),
  );

  return { embed, row };
}

// ─── CLASSEMENT : navigation boutons ─────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('cls_prev_') && !interaction.customId.startsWith('cls_next_')) return;

  await interaction.deferUpdate();

  const isPrev   = interaction.customId.startsWith('cls_prev_');
  const curPage  = parseInt(interaction.customId.split('_')[2]) ?? 0;
  const newPage  = isPrev ? curPage - 1 : curPage + 1;
  const callerId = interaction.user.id;

  const allInv = getAllInventories();
  const sorted = Object.entries(allInv)
    .map(([id, inv]) => ({ id, diamants: inv['diamants'] || 0 }))
    .filter(p => p.diamants > 0)
    .sort((a, b) => b.diamants - a.diamants);

  if (sorted.length === 0) return;

  const { embed, row } = await buildClassementPage(sorted, newPage, callerId, interaction.guild);
  await interaction.editReply({ embeds: [embed], components: [row] });
});

// ─── ÉCONOMIE : commandes préfixées !travail / !revenus / !envoyer ───────────
const TRAVAIL_PHRASES = (gain) => {
  const n = gain.toLocaleString('fr-FR');
  const phrases = [
    `Pas mal la journée ! Tu ramènes **${n} 💎** à la maison. T'as bien mérité ta sieste.`,
    `Aujourd'hui tu as bossé comme un dino enragé… et ça t'a rapporté **${n} 💎** ! Respect.`,
    `**${n} 💎** en poche ! L'économie du serveur te remercie. Et toi, tu mérites un café.`,
    `Tu as trimé dur, et ça se voit : **${n} 💎** débarquent dans ton inventaire !`,
    `La journée a été longue, mais **${n} 💎** plus tard, tu peux sourire !`,
    `**${n} 💎** gagnés ! À ce rythme, tu vas pouvoir racheter la moitié du serveur.`,
    `Le travail, c'est la santé… et apparemment aussi **${n} 💎**. Bonne santé !`,
    `Ton dino patron est fier de toi. Voici **${n} 💎** pour le prouver.`,
    `T'as assuré aujourd'hui ! **${n} 💎** atterrissent dans ta bourse.`,
    `**${n} 💎**… C'est pas le jackpot, mais c'est honnête pour une journée de travail !`,
    `Ohhh, **${n} 💎** ! C'est le destin qui récompense les courageux comme toi.`,
    `Tu t'es levé, t'as travaillé, t'as gagné **${n} 💎**. C'est ça la vie. Magnifique.`,
    `Les diamants ne poussent pas sur les arbres… mais toi tu sais où les trouver : en bossant ! **${n} 💎** !`,
    `**${n} 💎** récoltés ! Les fourmis aussi travaillent dur, mais elles ont moins de style.`,
    `Travail effectué avec brio ! **${n} 💎** pour le grand travailleur que tu es.`,
    `On dit que l'argent ne fait pas le bonheur… mais **${n} 💎** ça aide quand même !`,
    `**${n} 💎** ! Ton dino de compagnie est jaloux, mais tu le mérites bien.`,
    `Journée productive ! Tu empoche **${n} 💎** et tu peux aller te reposer la conscience tranquille.`,
    `Waouh, encore toi ? Décidément tu ne t'arrêtes jamais. **${n} 💎** bien mérités.`,
    `**${n} 💎** récoltés ! À force, tu vas finir plus riche que le serveur lui-même.`,
    `Courage, labeur, persévérance… et **${n} 💎** en bonus. Tu gères.`,
    `**${n} 💎** ! Tu viens d'ajouter une belle ligne à ton relevé de compte. Classe.`,
    `C'est la sueur du front qui forge les champions. Et les champions reçoivent **${n} 💎**.`,
    `**${n} 💎** déposés ! La banque du serveur frémit de plaisir.`,
    `Tu es une machine ! **${n} 💎** de plus et tu as encore un peu de cooldown devant toi. Profites-en pour souffler.`,
    `Quelqu'un a dit diamants ? Oui, toi. Et tu en as gagné **${n} 💎** aujourd'hui !`,
    `Ton investissement en temps a été converti en **${n} 💎**. Taux de change excellent.`,
    `**${n} 💎** ! Le Père Noël est passé en avance, ou c'est juste toi qui bosses bien.`,
    `Chaque pixel de ta journée a compté. Résultat : **${n} 💎** dans la poche !`,
    `Les héros portent des capes, toi tu portes **${n} 💎** de plus dans ton inventaire. Tout aussi impressionnant.`,
    `**${n} 💎** empochés ! Tu mérites une standing ovation… ou au moins un bon repas.`,
    `Encore une session de travail au top ! **${n} 💎** pour toi, et la fierté en bonus.`,
    `**${n} 💎** ! C'est peut-être pas Wall Street, mais sur ce serveur, t'es une légende.`,
    `Tu as trimé et ça paye littéralement : **${n} 💎** viennent d'atterrir chez toi !`,
    `La vie sourit aux travailleurs acharnés. Aujourd'hui elle t'envoie **${n} 💎** avec le sourire.`,
    `Impressive ! **${n} 💎** gagnés. Même les dinos sauvages sont impressionnés.`,
    `**${n} 💎** récoltés à la sueur de tes doigts (de clavier). Ça compte !`,
    `Le travail bien fait mérite salaire. Et le tien vaut **${n} 💎**. Bien joué !`,
    `**${n} 💎** de plus ! Un jour, on écrira des livres sur ta carrière dans ce serveur.`,
    `T'as mis le turbo aujourd'hui ? En tout cas, **${n} 💎** t'attendent dans ton inventaire !`,
  ];
  return phrases[Math.floor(Math.random() * phrases.length)];
};

// ─── ÉCONOMIE : /travail ────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'travail') return;
  const userId = interaction.user.id;
  const now = Date.now();
  const lastBonus = await economyManager.getCooldown(userId, 'bonus');
  const remaining = lastBonus + economyManager.BONUS_COOLDOWN_MS - now;

  if (remaining > 0) {
    const h = Math.floor(remaining / 3600000);
    const m = Math.floor((remaining % 3600000) / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    const timeStr = h > 0 ? `${h}h ${m}min` : m > 0 ? `${m}min ${s}s` : `${s}s`;
    return interaction.reply({ content: `⏳ T'es déjà passé travailler aujourd'hui ! Reviens dans **${timeStr}**.`, ephemeral: true });
  }

  const gain = economyManager.randBonus();
  await addToInventory(userId, 'diamants', gain, '/travail', 'Travail quotidien');
  await economyManager.setCooldown(userId, 'bonus', now);

  const embed = new EmbedBuilder()
    .setColor(0x7c5cfc)
    .setTitle('💼 Journée de travail terminée !')
    .setDescription(TRAVAIL_PHRASES(gain))
    .setFooter({ text: 'Reviens dans 4h pour ton prochain /travail !' })
    .setTimestamp();

  return interaction.reply({ embeds: [embed] });
});

// ─── ÉCONOMIE : /revenus-debloquer ──────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'revenus-debloquer') return;
  const target = interaction.options.getUser('joueur');

  // Effacer le cooldown ET la liste des rôles payés → le joueur repart de zéro
  await economyManager.setCooldown(target.id, 'revenu', 0);
  await economyManager.setClaimedRoles(target.id, []);

  const embed = new EmbedBuilder()
    .setColor(0xff9800)
    .setTitle('🔓 Cooldown /revenus réinitialisé')
    .setDescription(
      `Le cooldown de <@${target.id}> a été réinitialisé.\n` +
      `Il peut maintenant utiliser **/revenus** pour collecter ses revenus immédiatement.`
    )
    .setFooter({ text: `Action effectuée par ${interaction.member?.displayName || interaction.user.username}` })
    .setTimestamp();

  return interaction.reply({ embeds: [embed], ephemeral: true });
});

// ─── ÉCONOMIE : /revenus ────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'revenus') return;
  const userId = interaction.user.id;
  const now    = Date.now();

  const member        = interaction.member;
  const memberRoleIds = [...member.roles.cache.keys()];
  const { lines, total } = await economyManager.calcPlayerRevenue(memberRoleIds);

  if (total <= 0) {
    return interaction.reply({ content: `❌ Aucun de tes rôles ne génère de revenu hebdomadaire pour l'instant.`, ephemeral: true });
  }

  const lastRevenu = await economyManager.getCooldown(userId, 'revenu');
  const remaining  = lastRevenu + economyManager.REVENU_COOLDOWN_MS - now;
  const onCooldown = remaining > 0;

  function fmtRemaining(ms) {
    const d = Math.floor(ms / 86400000);
    const h = Math.floor((ms % 86400000) / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return d > 0 ? `${d}j ${h}h` : h > 0 ? `${h}h ${m}min` : `${m}min`;
  }

  // ── Cooldown actif ────────────────────────────────────────────────────────
  if (onCooldown) {
    let claimedRoles = await economyManager.getClaimedRoles(userId);

    // Initialisation du baseline pour les joueurs sans historique (legacy)
    // On stocke les rôles actuels comme référence, en EXCLUANT ceux ajoutés récemment
    // (addedAt > lastRevenu) qui seront détectés comme nouveaux ci-dessous.
    if (claimedRoles === null) {
      const baseline = lines
        .filter(l => l.addedAt <= lastRevenu)
        .map(l => l.roleId);
      await economyManager.setClaimedRoles(userId, baseline);
      claimedRoles = baseline;
    }

    // Rôle "nouveau" = pas encore dans la liste payée cette semaine
    // (couvre : rôle Discord obtenu après last claim ET rôle économie ajouté après)
    const newLines = lines.filter(l => !claimedRoles.includes(l.roleId));

    if (newLines.length === 0) {
      return interaction.reply({
        content: `⏳ Tu as déjà collecté tes revenus cette semaine ! Reviens dans **${fmtRemaining(remaining)}**.`,
        ephemeral: true,
      });
    }

    // Payer uniquement les nouveaux rôles, sans toucher au cooldown principal
    const newTotal = newLines.reduce((s, r) => s + r.income, 0);
    await addToInventory(userId, 'diamants', newTotal, 'Revenu hebdo (nouveaux rôles)', '/revenus');

    // Marquer ces rôles comme payés cette semaine
    const updated = [...new Set([...claimedRoles, ...newLines.map(l => l.roleId)])];
    await economyManager.setClaimedRoles(userId, updated);

    const rolesDesc = newLines.map(l =>
      `> 🏷️ **${l.name}** → **${l.income.toLocaleString('fr-FR')} 💎**` +
      (l.shopDiscount > 0 ? ` *(${l.shopDiscount}% réduction shop)*` : '')
    ).join('\n');

    const embed = new EmbedBuilder()
      .setColor(0x4caf50)
      .setTitle('🆕 Nouveaux revenus débloqués !')
      .setDescription(
        `Tu as obtenu de nouveaux rôles depuis ta dernière collecte !\n` +
        `**+${newTotal.toLocaleString('fr-FR')} 💎** crédités immédiatement.\n\n${rolesDesc}`
      )
      .setFooter({ text: `Tes revenus habituels reviennent dans ${fmtRemaining(remaining)}.` })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }

  // ── Cooldown expiré : paiement normal de tous les rôles ──────────────────
  await addToInventory(userId, 'diamants', total, 'Revenu hebdo', '/revenus');
  await economyManager.setCooldown(userId, 'revenu', now);
  await economyManager.setClaimedRoles(userId, lines.map(l => l.roleId));

  const rolesDesc = lines.map(l =>
    `> 🏷️ **${l.name}** → **${l.income.toLocaleString('fr-FR')} 💎**` +
    (l.shopDiscount > 0 ? ` *(${l.shopDiscount}% réduction shop)*` : '')
  ).join('\n');

  const embed = new EmbedBuilder()
    .setColor(0xf9c740)
    .setTitle('💰 Revenus hebdomadaires collectés !')
    .setDescription(`**Total reçu : ${total.toLocaleString('fr-FR')} 💎 Diamants**\n\n${rolesDesc}`)
    .setFooter({ text: 'Reviens dans 7 jours pour tes prochains /revenus !' })
    .setTimestamp();

  return interaction.reply({ embeds: [embed] });
});

// ─── ÉCONOMIE : /envoyer ────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'envoyer') return;
  const senderId   = interaction.user.id;
  const senderName = interaction.member?.displayName || interaction.user.username;
  const target     = interaction.options.getUser('joueur');
  const amount     = interaction.options.getInteger('montant');
  const reason     = interaction.options.getString('raison');

  if (target.id === senderId) {
    return interaction.reply({ content: `❌ Tu ne peux pas t'envoyer des diamants à toi-même !`, ephemeral: true });
  }
  if (target.bot) {
    return interaction.reply({ content: `❌ Tu ne peux pas envoyer des diamants à un bot.`, ephemeral: true });
  }

  // ── Vérification suspension transfert ───────────────────────────────────────
  const TRANSFER_BAN_DURATION = 12 * 60 * 60 * 1000;
  const lastBan = await economyManager.getCooldown(senderId, 'transfer_ban');
  if (lastBan && Date.now() - lastBan < TRANSFER_BAN_DURATION) {
    const rem = lastBan + TRANSFER_BAN_DURATION - Date.now();
    const h = Math.floor(rem / 3600000);
    const m = Math.floor((rem % 3600000) / 60000);
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0xe53935)
        .setTitle('🔒 Transferts suspendus')
        .setDescription(
          `Suite à une tentative d'envoi intégral de ton porte-monnaie, tes transferts sont **suspendus pour ${h}h${m > 0 ? ` ${m}min` : ''}**.\n\n` +
          `Cette mesure protège l'économie du serveur.`
        )],
      ephemeral: true,
    });
  }

  const senderInv = getPlayerInventory(senderId);
  const senderDiamants = senderInv['diamants'] || 0;

  // ── Blocage envoi intégral ───────────────────────────────────────────────────
  if (amount >= senderDiamants && senderDiamants > 0) {
    await economyManager.setCooldown(senderId, 'transfer_ban', Date.now());
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0xff9800)
        .setTitle('⚠️ Transfert intégral refusé')
        .setDescription(
          `**L'envoi de la totalité de son inventaire ou porte-monnaie à un autre joueur est strictement interdit** — que ce soit pour un départ du serveur, un arrêt du jeu ou toute autre raison.\n\n` +
          `Cette règle protège l'équilibre de l'économie du serveur pour tous les joueurs.\n\n` +
          `⏳ En raison de cette tentative, tes transferts sont **suspendus pour 12h**.`
        )],
      ephemeral: true,
    });
  }

  if (senderDiamants < amount) {
    return interaction.reply({
      content: `❌ Tu n'as pas assez de diamants ! Tu possèdes **${senderDiamants.toLocaleString('fr-FR')} 💎** et tu veux envoyer **${amount.toLocaleString('fr-FR')} 💎**.`,
      ephemeral: true,
    });
  }

  await removeFromInventory(senderId, 'diamants', amount, `→ ${target.username}`, reason);
  await addToInventory(target.id, 'diamants', amount, `← ${senderName}`, reason);

  const embed = new EmbedBuilder()
    .setColor(0x4caf50)
    .setTitle('🤝 Transfert effectué !')
    .setDescription(`**${senderName}** a envoyé **${amount.toLocaleString('fr-FR')} 💎** à **${target.displayName || target.username}**`)
    .addFields({ name: '📋 Raison', value: reason })
    .setTimestamp();

  return interaction.reply({ embeds: [embed] });
});

// ─── ÉCONOMIE : /amende ─────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'amende') return;
  if (!interaction.memberPermissions?.has('Administrator')) {
    return interaction.reply({ content: '❌ Réservé aux administrateurs.', ephemeral: true });
  }

  const target  = interaction.options.getUser('joueur');
  const amount  = interaction.options.getInteger('montant');
  const reason  = interaction.options.getString('raison');
  const photo   = interaction.options.getAttachment('photo');
  const adminName = interaction.user.displayName || interaction.user.username;

  const targetInv = getPlayerInventory(target.id);
  const currentDiamants = targetInv['diamants'] || 0;
  const actualAmount = Math.min(amount, currentDiamants);

  if (actualAmount > 0) {
    await removeFromInventory(target.id, 'diamants', actualAmount, adminName, `Amende : ${reason}`);
  }

  const embed = new EmbedBuilder()
    .setColor(0xf44336)
    .setTitle('🚨 Amende infligée')
    .addFields(
      { name: '👤 Joueur', value: `${target.displayName || target.username} (${target.id})`, inline: true },
      { name: '💎 Montant', value: `${actualAmount.toLocaleString('fr-FR')} 💎`, inline: true },
      { name: '🛡️ Admin', value: adminName, inline: true },
      { name: '📋 Motif', value: reason },
    )
    .setTimestamp();

  if (actualAmount < amount) {
    embed.setFooter({ text: `⚠️ Solde insuffisant — seulement ${actualAmount.toLocaleString('fr-FR')} sur ${amount.toLocaleString('fr-FR')} 💎 prélevés` });
  }

  const replyPayload = { embeds: [embed] };
  if (photo) replyPayload.files = [{ attachment: photo.url, name: photo.name }];

  await interaction.reply(replyPayload);

  // Log dans le canal d'amendes
  const FINE_LOG_CHANNEL = '1160344266342666250';
  try {
    const logChannel = await client.channels.fetch(FINE_LOG_CHANNEL);
    if (logChannel) {
      const logPayload = { embeds: [embed] };
      if (photo) logPayload.files = [{ attachment: photo.url, name: photo.name }];
      await logChannel.send(logPayload);
    }
  } catch (e) { /* canal introuvable ou inaccessible */ }
});

const token = process.env.DISCORD_TOKEN;

// ─── WELCOME SYSTEM ────────────────────────────────────────────────────────
client.on('guildMemberAdd', async (member) => {
  try {
    recordJoin(member.id, member.guild.id);

    // ── Cadeau de bienvenue : 3 000 💎 ──────────────────────────────────────
    try {
      await addToInventory(member.id, 'diamants', economyManager.WELCOME_DIAMONDS, 'Système', 'Cadeau de bienvenue');
    } catch (e) { console.warn('[Welcome] Erreur cadeau diamants:', e.message); }

    const settings = getSettings();
    const ws = settings.welcome || {};
    if (!ws.enabled || !ws.channelId) return;

    const channel = member.guild.channels.cache.get(ws.channelId);
    if (!channel) return;

    const { embed, attachment, isNew } = await buildWelcomeEmbed(member, member.guild, client);
    const files = attachment ? [attachment] : [];
    await channel.send({ embeds: [embed], files });

    // Attribution automatique des rôles
    const rolesToAdd = isNew ? (ws.autoRolesNew || []) : (ws.autoRolesReturn || []);
    for (const roleData of rolesToAdd) {
      try {
        await member.roles.add(roleData.id, 'Rôle bienvenue automatique');
      } catch (e) {
        console.warn(`[Welcome] Impossible d'ajouter le rôle ${roleData.name} (${roleData.id}):`, e.message);
      }
    }

    // Message de bienvenue + bouton "Souhaiter la bienvenue"
    const displayName = member.displayName || member.user.username;
    const arrivalPhrase = getRandomArrivalPhrase(displayName, isNew);
    const btnLabel = isNew ? '🎉 Souhaiter la bienvenue' : '🤗 Souhaiter un bon retour';
    const greetBtn = new ButtonBuilder()
      .setCustomId(`welcome_greet:${member.id}:${isNew ? 'new' : 'return'}`)
      .setLabel(btnLabel)
      .setStyle(ButtonStyle.Primary);
    const greetRow = new ActionRowBuilder().addComponents(greetBtn);
    await channel.send({ content: arrivalPhrase, components: [greetRow] });

    await sendWelcomeDM(member, member.guild);

    // Ping après délai (s'auto-supprime après 5s)
    const delay = Math.max(0, parseInt(ws.pingDelay) || 10) * 1000;
    if (delay > 0) {
      setTimeout(async () => {
        try {
          const pingMsg = await channel.send({ content: `<@${member.id}>` });
          setTimeout(() => pingMsg.delete().catch(() => {}), 5000);
        } catch {}
      }, delay);
    }
  } catch (err) {
    console.error('[Welcome] guildMemberAdd error:', err.message);
  }
});

client.on('guildMemberRemove', (member) => {
  try {
    recordLeave(member.id, member.guild.id);
  } catch (err) {
    console.error('[Welcome] guildMemberRemove error:', err.message);
  }
});

if (!token) {
  console.error('❌ Erreur: DISCORD_TOKEN manquant !');
  console.log('\n📝 Pour configurer votre bot:');
  console.log('1. Allez sur https://discord.com/developers/applications');
  console.log('2. Créez une nouvelle application ou sélectionnez une existante');
  console.log('3. Allez dans "Bot" et créez un bot si ce n\'est pas déjà fait');
  console.log('4. Copiez le token du bot');
  console.log('5. Ajoutez DISCORD_TOKEN dans les secrets Replit');
  console.log('6. Ajoutez aussi DISCORD_CLIENT_ID (trouvé dans "General Information")');
  console.log('\n⚠️ Permissions requises pour inviter le bot:');
  console.log('   - applications.commands (pour les slash commands)');
  console.log('   - Send Messages');
  console.log('   - Attach Files');
  process.exit(1);
}

client.login(token);
