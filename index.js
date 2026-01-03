const { Client, GatewayIntentBits, AttachmentBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
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

      let resultsMessage = `# Hello la Family\n${votesConfig.STYLE.logo} \n\n`;
      resultsMessage += `## ${votesConfig.STYLE.fireworks} C'est le jour de Paie ${votesConfig.STYLE.fireworks} \n`;
      resultsMessage += `${votesConfig.STYLE.logo} \n\n\n`;
      resultsMessage += `Voici donc les résultats des votes du mois de ${monthName} :\n\n\n`;

      const top10 = ranking.slice(0, 10);
      for (let i = 0; i < top10.length; i++) {
        const player = top10[i];
        resultsMessage += `    •    ${i + 1} ${votesConfig.STYLE.arrow} ${player.votes} ${player.playername}\n`;
      }

      const others = ranking.slice(10);
      if (others.length > 0) {
        resultsMessage += '\n';
        for (const player of others) {
          resultsMessage += `    •    ${player.votes} ${player.playername}\n`;
        }
      }

      const topVoterMemberId = resolvePlayer(memberIndex, ranking[0]?.playername);
      resultsMessage += `\nUn grand Bravo à notre <@&${votesConfig.TOP_VOTER_ROLE_ID}>  qui remporte la première place et le rôle qui va avec ! 🎉\n\n`;

      resultsMessage += `Merci à notre podium de ce mois-ci :\n`;
      const placeNames = ['Première', 'Seconde', 'Troisième', 'Quatrième', 'Cinquième'];
      const top5 = ranking.slice(0, 5);
      for (let i = 0; i < top5.length; i++) {
        const player = top5[i];
        const memberId = resolvePlayer(memberIndex, player.playername);
        const mention = memberId ? `<@${memberId}>` : `@${player.playername}`;
        resultsMessage += `    •    ${votesConfig.STYLE.animeArrow} ${votesConfig.STYLE.placeIcons[i]} ${placeNames[i]} place ${mention} \n`;
      }

      resultsMessage += `\nPour les règles des votes, toujours les mêmes, ${votesConfig.VOTES_PER_REWARD_DISPLAY} votes = ${votesConfig.DIAMONDS_PER_REWARD_DISPLAY} diamants ${votesConfig.STYLE.sparkly} que l'on vous verse le mois suivant 🤩\n\n`;
      resultsMessage += `En mémo, voici les récompenses pour le top 10 ${votesConfig.STYLE.animeArrow} ${votesConfig.STYLE.memoUrl}\n\n`;
      resultsMessage += `.\n\n`;
      resultsMessage += `-# Tirage au sort des 10 premiers pour le Dino Shiny juste après la distribution des récompenses votes\n\n`;
      resultsMessage += `🫶\n\n`;

      if (votesConfig.STYLE.everyonePing) {
        resultsMessage += `|| @everyone ||`;
      }

      const resultsChannel = await client.channels.fetch(votesConfig.RESULTS_CHANNEL_ID);
      if (resultsChannel) {
        const chunks = resultsMessage.match(/[\s\S]{1,1900}/g) || [resultsMessage];
        for (const chunk of chunks) {
          await resultsChannel.send(chunk);
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

      let previewMessage = `# Hello la Family\n${votesConfig.STYLE.logo} \n\n`;
      previewMessage += `## ${votesConfig.STYLE.fireworks} C'est le jour de Paie ${votesConfig.STYLE.fireworks} \n`;
      previewMessage += `${votesConfig.STYLE.logo} \n\n\n`;
      previewMessage += `Voici donc les résultats des votes du mois de ${monthName} :\n\n\n`;

      const top10 = ranking.slice(0, 10);
      for (let i = 0; i < top10.length; i++) {
        const player = top10[i];
        previewMessage += `    •    ${i + 1} ${votesConfig.STYLE.arrow} ${player.votes} ${player.playername}\n`;
      }

      const others = ranking.slice(10);
      if (others.length > 0) {
        previewMessage += '\n';
        for (const player of others) {
          previewMessage += `    •    ${player.votes} ${player.playername}\n`;
        }
      }

      previewMessage += `\nUn grand Bravo à notre <@&${votesConfig.TOP_VOTER_ROLE_ID}>  qui remporte la première place et le rôle qui va avec ! 🎉\n\n`;

      previewMessage += `Merci à notre podium de ce mois-ci :\n`;
      const placeNames = ['Première', 'Seconde', 'Troisième', 'Quatrième', 'Cinquième'];
      const top5 = ranking.slice(0, 5);
      for (let i = 0; i < top5.length; i++) {
        const player = top5[i];
        const memberId = resolvePlayer(memberIndex, player.playername);
        const mention = memberId ? `<@${memberId}>` : `@${player.playername}`;
        previewMessage += `    •    ${votesConfig.STYLE.animeArrow} ${votesConfig.STYLE.placeIcons[i]} ${placeNames[i]} place ${mention} \n`;
      }

      previewMessage += `\nPour les règles des votes, toujours les mêmes, ${votesConfig.VOTES_PER_REWARD_DISPLAY} votes = ${votesConfig.DIAMONDS_PER_REWARD_DISPLAY} diamants ${votesConfig.STYLE.sparkly} que l'on vous verse le mois suivant 🤩\n\n`;
      previewMessage += `En mémo, voici les récompenses pour le top 10 ${votesConfig.STYLE.animeArrow} ${votesConfig.STYLE.memoUrl}\n\n`;
      previewMessage += `.\n\n`;
      previewMessage += `-# Tirage au sort des 10 premiers pour le Dino Shiny juste après la distribution des récompenses votes\n\n`;
      previewMessage += `🫶\n\n`;
      previewMessage += `|| @everyone ||`;

      const foundCount = ranking.filter(p => resolvePlayer(memberIndex, p.playername)).length;
      const notFoundList = ranking.filter(p => !resolvePlayer(memberIndex, p.playername)).map(p => p.playername);

      const testChannel = await client.channels.fetch(votesConfig.ADMIN_LOG_CHANNEL_ID);
      if (testChannel) {
        const chunks = previewMessage.match(/[\s\S]{1,1900}/g) || [previewMessage];
        await testChannel.send(`⚠️ **TEST - PRÉVISUALISATION** ⚠️`);
        for (const chunk of chunks) {
          await testChannel.send(chunk);
        }
        
        let statsMessage = `📊 **Statistiques:**\n`;
        statsMessage += `• Total votants: ${ranking.length}\n`;
        statsMessage += `• Reconnus: ${foundCount} ✅\n`;
        statsMessage += `• Non trouvés: ${notFoundList.length} ❌\n`;
        if (notFoundList.length > 0) {
          statsMessage += `\n⚠️ Non trouvés: ${notFoundList.slice(0, 15).join(', ')}${notFoundList.length > 15 ? '...' : ''}`;
        }
        await testChannel.send(statsMessage);
      }

      await interaction.editReply({ 
        content: `✅ Prévisualisation envoyée dans <#${votesConfig.ADMIN_LOG_CHANNEL_ID}>\n\nSi tout est correct, utilisez \`/publish-votes\` pour publier et distribuer.`
      });
      console.log(`🔍 Test des votes effectué par ${interaction.user.tag}`);

    } catch (error) {
      console.error('Erreur lors du test des votes:', error);
      await interaction.editReply({
        content: '❌ Une erreur est survenue lors du test.',
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
