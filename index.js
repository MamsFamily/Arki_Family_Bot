const { Client, GatewayIntentBits, AttachmentBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');
const RouletteWheel = require('./rouletteWheel');
const { initDatabase } = require('./database');
const { fetchTopserveursRanking } = require('./topserveursService');
const { monthNameFr, formatRewards, buildMemberIndex, resolvePlayer } = require('./votesUtils');
const votesConfig = require('./votesConfig');
const { addCashToUser, generateDraftBotCommands } = require('./unbelievaboatService');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
});

let config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));

function saveConfig() {
  fs.writeFileSync('./config.json', JSON.stringify(config, null, 2));
}

function hasRoulettePermission(member) {
  const MODO_ROLE_ID = '1157803768893689877';
  return member.permissions.has(PermissionFlagsBits.Administrator) || 
         member.roles.cache.has(MODO_ROLE_ID);
}

client.once('clientReady', () => {
  initDatabase();
  console.log('✅ Bot Discord Arki Roulette est en ligne !');
  console.log(`📝 Connecté en tant que ${client.user.tag}`);
  console.log(`🎰 ${config.rouletteChoices.length} choix de roulette chargés`);
  console.log('\n💡 Commandes disponibles:');
  console.log('   /roulette - Lance la roue de la chance');
  console.log('   /set-choices - Modifie les choix de la roulette');
  console.log('   /show-choices - Affiche les choix actuels');
  console.log('   /votes - Affiche le classement des votes');
  console.log('   /publish-votes - Publie les résultats mensuels');
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
    saveConfig();

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
      resultsMessage += `Merci à tous les votants ! Grâce à vous, notre serveur gagne en visibilité. Continuez comme ça ! 💪\n\n`;
      resultsMessage += `${votesConfig.STYLE.sparkly} Les diamants ont été **automatiquement crédités** sur vos comptes !\n\n`;

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
          resultsMessage += `+ Pack vote 1ère place + rôle <@&${votesConfig.TOP_VOTER_ROLE_ID}>\n`;
        } else if (i === 1) {
          resultsMessage += `+ Pack vote 2ème place\n`;
        } else if (i === 2) {
          resultsMessage += `+ Pack vote 3ème place\n`;
        } else if (bonusDiamonds > 0) {
          resultsMessage += `+ ${bonusDiamonds.toLocaleString('fr-FR')} ${votesConfig.STYLE.sparkly}\n`;
        }
        resultsMessage += `\n`;
      }

      resultsMessage += `---\n`;
      resultsMessage += `Pour mémo, vous retrouverez la liste des récompenses votes à gagner ici ${votesConfig.STYLE.animeArrow} ${votesConfig.STYLE.memoUrl}\n\n`;
      resultsMessage += `-# Tirage Dino Shiny juste après 🦖\n`;

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

      const rouletteWheel = new RouletteWheel(top10.map(p => p.playername), 'DINO');
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
        
        await resultsChannel.send(`## 🎉 Félicitations **${winningChoice}** !\n\nTu remportes le **Dino Shiny** du mois ! 🦖✨`);
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

      let previewMessage = `# ${votesConfig.STYLE.fireworks} Résultats des votes de ${monthName} ${votesConfig.STYLE.fireworks}\n\n`;
      previewMessage += `Merci à tous les votants ! Grâce à vous, notre serveur gagne en visibilité. Continuez comme ça ! 💪\n\n`;
      previewMessage += `${votesConfig.STYLE.sparkly} Les diamants ont été **automatiquement crédités** sur vos comptes !\n\n`;

      const top10 = ranking.slice(0, 10);
      for (let i = 0; i < top10.length; i++) {
        const player = top10[i];
        const totalDiamonds = player.votes * votesConfig.DIAMONDS_PER_VOTE;
        const bonusDiamonds = votesConfig.TOP_DIAMONDS[i + 1] || 0;
        const memberId = resolvePlayer(memberIndex, player.playername);
        
        previewMessage += `**${i + 1}** - **${player.playername}**\n`;
        previewMessage += `Votes : ${player.votes} | Gains : ${totalDiamonds.toLocaleString('fr-FR')} ${votesConfig.STYLE.sparkly}\n`;
        
        if (i === 0) {
          previewMessage += `+ Pack vote 1ère place + rôle <@&${votesConfig.TOP_VOTER_ROLE_ID}>\n`;
        } else if (i === 1) {
          previewMessage += `+ Pack vote 2ème place\n`;
        } else if (i === 2) {
          previewMessage += `+ Pack vote 3ème place\n`;
        } else if (bonusDiamonds > 0) {
          previewMessage += `+ ${bonusDiamonds.toLocaleString('fr-FR')} ${votesConfig.STYLE.sparkly}\n`;
        }
        previewMessage += `\n`;
      }

      previewMessage += `---\n`;
      previewMessage += `Pour mémo, vous retrouverez la liste des récompenses votes à gagner ici ${votesConfig.STYLE.animeArrow} ${votesConfig.STYLE.memoUrl}\n\n`;
      previewMessage += `-# Tirage Dino Shiny juste après 🦖\n`;

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

      const rouletteWheel = new RouletteWheel(top10.map(p => p.playername), 'DINO');
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
      
      await testChannel.send(`## 🎉 Félicitations **${winningChoice}** !\n\nTu remportes le **Dino Shiny** du mois ! 🦖✨`);

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

  if (commandName === 'pay-votes') {
    if (!hasRoulettePermission(interaction.member)) {
      return interaction.reply({
        content: '❌ Seuls les administrateurs et les Modos peuvent distribuer les récompenses !',
        ephemeral: true,
      });
    }

    await interaction.deferReply();

    try {
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

  if (commandName === 'dino-roulette') {
    if (!hasRoulettePermission(interaction.member)) {
      return interaction.reply({
        content: '❌ Seuls les administrateurs et les Modos peuvent lancer la roulette Dino !',
        ephemeral: true,
      });
    }

    await interaction.deferReply();

    try {
      const ranking = await fetchTopserveursRanking(votesConfig.TOPSERVEURS_RANKING_URL);
      
      if (ranking.length === 0) {
        return interaction.editReply({
          content: '❌ Impossible de récupérer le classement des votes.',
        });
      }

      const top10 = ranking.slice(0, 10);
      
      const rouletteWheel = new RouletteWheel(top10.map(p => p.playername), 'DINO');
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
        
        await resultsChannel.send(`## 🎉 Félicitations **${winningChoice}** !\n\nTu remportes le **Dino Shiny** du mois ! 🦖✨`);
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
