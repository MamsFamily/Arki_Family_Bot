const { Client, GatewayIntentBits, Partials, AttachmentBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const fs = require('fs');
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
const { initSettings } = require('./settingsManager');
const { initDinos } = require('./dinoManager');
const { initShop } = require('./shopManager');

const openaiConfig = {};
if (process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
  openaiConfig.apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  openaiConfig.baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
} else if (process.env.OPENAI_API_KEY) {
  openaiConfig.apiKey = process.env.OPENAI_API_KEY;
}
const openai = openaiConfig.apiKey ? new OpenAI(openaiConfig) : null;

const ARTHUR_EMOJI_ID = '1473289815180050473';

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

function hasRoulettePermission(member) {
  const votesConfig = getVotesConfig();
  const MODO_ROLE_ID = votesConfig.MODO_ROLE_ID || '1157803768893689877';
  return member.permissions.has(PermissionFlagsBits.Administrator) || 
         member.roles.cache.has(MODO_ROLE_ID);
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

    const distributionResults = { success: 0, failed: 0, notFound: [] };
    const playerStatus = {};

    for (const player of ranking) {
      const memberId = resolvePlayer(memberIndex, player.playername);
      if (memberId) {
        const totalDiamonds = player.votes * votesConfig.DIAMONDS_PER_VOTE;
        const bonusDiamonds = votesConfig.TOP_DIAMONDS[ranking.indexOf(player) + 1] || 0;
        const result = await addCashToUser(memberId, totalDiamonds + bonusDiamonds, `Votes ${monthName}`);
        if (result.success) {
          distributionResults.success++;
          playerStatus[player.playername] = 'success';
        } else {
          distributionResults.failed++;
          playerStatus[player.playername] = 'failed';
        }
      } else {
        distributionResults.notFound.push(player.playername);
        playerStatus[player.playername] = 'notfound';
      }
    }

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

      resultsMessage += `**${i + 1}** - **${player.playername}**${statusIcon}\n`;
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

    const resultsChannel = await client.channels.fetch(votesConfig.RESULTS_CHANNEL_ID);
    if (resultsChannel) {
      let finalMessage = resultsMessage;
      if (votesConfig.STYLE.everyonePing) {
        finalMessage = `|| @everyone ||\n` + finalMessage;
      }
      await resultsChannel.send({ content: finalMessage, components: [row] });
    }

    const dinoTitle = msg.dinoTitle || 'DINO';
    const rouletteWheel = new RouletteWheel(top10.map(p => p.playername), dinoTitle);
    const winningIndex = Math.floor(Math.random() * top10.length);
    const gifBuffer = await rouletteWheel.generateAnimatedGif(winningIndex);
    const winningChoice = rouletteWheel.getWinningChoice(winningIndex);
    const attachment = new AttachmentBuilder(gifBuffer, { name: 'dino-shiny-roulette.gif' });

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

    const draftBotCommands = generateDraftBotCommands(ranking, memberIndex, resolvePlayer);

    let adminMessage = `📊 **Rapport de distribution automatique - ${monthName}**\n\n`;
    adminMessage += `🕐 *Publication automatique du 1er du mois*\n\n`;
    adminMessage += `💎 **Distribution UnbelievaBoat:**\n`;
    adminMessage += `   • ${distributionResults.success} joueurs récompensés\n`;
    if (distributionResults.failed > 0) {
      adminMessage += `   • ${distributionResults.failed} échecs\n`;
    }
    if (distributionResults.notFound.length > 0) {
      adminMessage += `   • ${distributionResults.notFound.length} joueurs non trouvés: ${distributionResults.notFound.join(', ')}\n`;
    }

    if (draftBotCommands.length > 0) {
      adminMessage += `\n🎁 **Commandes DraftBot à copier-coller:**\n\`\`\`\n${draftBotCommands.join('\n')}\n\`\`\``;
    }

    const adminChannel = await client.channels.fetch(votesConfig.ADMIN_LOG_CHANNEL_ID);
    if (adminChannel) {
      await adminChannel.send(adminMessage);
    }

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

  config = getConfig();

  createWebServer(client);
  console.log('✅ Bot Discord Arki Roulette est en ligne !');
  console.log(`📝 Connecté en tant que ${client.user.tag}`);
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

client.on('interactionCreate', async interaction => {
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
        const statusText = player.status === 'success' ? '✅' : player.status === 'failed' ? '❌ échec' : player.status === 'notfound' ? '⚠️ non trouvé' : '✅';
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
  }

  if (interaction.isStringSelectMenu()) {
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

  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

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

      const distributionResults = { success: 0, failed: 0, notFound: [] };
      const playerStatus = {};

      for (const player of ranking) {
        const memberId = resolvePlayer(memberIndex, player.playername);
        if (memberId) {
          const totalDiamonds = player.votes * votesConfig.DIAMONDS_PER_VOTE;
          const bonusDiamonds = votesConfig.TOP_DIAMONDS[ranking.indexOf(player) + 1] || 0;
          const result = await addCashToUser(memberId, totalDiamonds + bonusDiamonds, `Votes ${monthName}`);
          if (result.success) {
            distributionResults.success++;
            playerStatus[player.playername] = 'success';
          } else {
            distributionResults.failed++;
            playerStatus[player.playername] = 'failed';
          }
        } else {
          distributionResults.notFound.push(player.playername);
          playerStatus[player.playername] = 'notfound';
        }
      }

      let resultsMessage = `# ${votesConfig.STYLE.fireworks} Résultats des votes de ${monthName} ${votesConfig.STYLE.fireworks}\n\n`;
      const msg = votesConfig.MESSAGE || {};
      resultsMessage += `${msg.introText || ''}\n\n`;
      resultsMessage += `${votesConfig.STYLE.sparkly} ${msg.creditText || ''}\n\n`;

      const top10 = ranking.slice(0, 10);
      for (let i = 0; i < top10.length; i++) {
        const player = top10[i];
        const totalDiamonds = player.votes * votesConfig.DIAMONDS_PER_VOTE;
        const bonusDiamonds = votesConfig.TOP_DIAMONDS[i + 1] || 0;
        const memberId = resolvePlayer(memberIndex, player.playername);
        const status = playerStatus[player.playername];
        const statusIcon = status === 'success' ? '' : status === 'failed' ? ' ❌' : ' ⚠️';
        
        resultsMessage += `**${i + 1}** - **${player.playername}**${statusIcon}\n`;
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

      const resultsChannel = await client.channels.fetch(votesConfig.RESULTS_CHANNEL_ID);
      if (resultsChannel) {
        let finalMessage = resultsMessage;
        if (votesConfig.STYLE.everyonePing) {
          finalMessage = `|| @everyone ||\n` + finalMessage;
        }
        await resultsChannel.send({ content: finalMessage, components: [row] });
      }

      const dinoTitle = msg.dinoTitle || 'DINO';
      const rouletteWheel = new RouletteWheel(top10.map(p => p.playername), dinoTitle);
      const winningIndex = Math.floor(Math.random() * top10.length);
      const gifBuffer = await rouletteWheel.generateAnimatedGif(winningIndex);
      const winningChoice = rouletteWheel.getWinningChoice(winningIndex);
      const attachment = new AttachmentBuilder(gifBuffer, { name: 'dino-shiny-roulette.gif' });
      
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

      const draftBotCommands = generateDraftBotCommands(ranking, memberIndex, resolvePlayer);
      
      let adminMessage = `📊 **Rapport de distribution - ${monthName}**\n\n`;
      adminMessage += `💎 **Distribution UnbelievaBoat:**\n`;
      adminMessage += `   • ${distributionResults.success} joueurs récompensés\n`;
      if (distributionResults.failed > 0) {
        adminMessage += `   • ${distributionResults.failed} échecs\n`;
      }
      if (distributionResults.notFound.length > 0) {
        adminMessage += `   • ${distributionResults.notFound.length} joueurs non trouvés: ${distributionResults.notFound.join(', ')}\n`;
      }

      if (draftBotCommands.length > 0) {
        adminMessage += `\n🎁 **Commandes DraftBot à copier-coller:**\n\`\`\`\n${draftBotCommands.join('\n')}\n\`\`\``;
      }

      const adminChannel = await client.channels.fetch(votesConfig.ADMIN_LOG_CHANNEL_ID);
      if (adminChannel) {
        await adminChannel.send(adminMessage);
      }

      await interaction.editReply({ content: `✅ Résultats publiés dans <#${votesConfig.RESULTS_CHANNEL_ID}> et rapport envoyé dans <#${votesConfig.ADMIN_LOG_CHANNEL_ID}>` });
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
        
        previewMessage += `**${i + 1}** - **${player.playername}**\n`;
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

  if (commandName === 'list-votes') {
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

      const distributionResults = { success: 0, failed: 0, notFound: [] };

      for (const player of ranking) {
        const memberId = resolvePlayer(memberIndex, player.playername);
        if (memberId) {
          const totalDiamonds = player.votes * votesConfig.DIAMONDS_PER_VOTE;
          const bonusDiamonds = votesConfig.TOP_DIAMONDS[ranking.indexOf(player) + 1] || 0;
          const result = await addCashToUser(memberId, totalDiamonds + bonusDiamonds, `Votes ${monthName}`);
          if (result.success) {
            distributionResults.success++;
          } else {
            distributionResults.failed++;
          }
        } else {
          distributionResults.notFound.push(player.playername);
        }
      }

      const draftBotCommands = generateDraftBotCommands(ranking, memberIndex, resolvePlayer);
      
      let adminMessage = `📊 **Rapport de distribution - ${monthName}**\n\n`;
      adminMessage += `💎 **Distribution UnbelievaBoat:**\n`;
      adminMessage += `   • ${distributionResults.success} joueurs récompensés\n`;
      if (distributionResults.failed > 0) {
        adminMessage += `   • ${distributionResults.failed} échecs\n`;
      }
      if (distributionResults.notFound.length > 0) {
        adminMessage += `   • ${distributionResults.notFound.length} joueurs non trouvés: ${distributionResults.notFound.join(', ')}\n`;
      }

      if (draftBotCommands.length > 0) {
        adminMessage += `\n🎁 **Commandes DraftBot à copier-coller:**\n\`\`\`\n${draftBotCommands.join('\n')}\n\`\`\``;
      }

      const adminChannel = await client.channels.fetch(votesConfig.ADMIN_LOG_CHANNEL_ID);
      if (adminChannel) {
        await adminChannel.send(adminMessage);
      }

      await interaction.editReply({ content: `✅ Distribution terminée ! Rapport envoyé dans <#${votesConfig.ADMIN_LOG_CHANNEL_ID}>` });
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
});

const token = process.env.DISCORD_TOKEN;

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
