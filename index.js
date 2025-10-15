const { Client, GatewayIntentBits, AttachmentBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const RouletteWheel = require('./rouletteWheel');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
  ],
});

let config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));

function saveConfig() {
  fs.writeFileSync('./config.json', JSON.stringify(config, null, 2));
}

client.once('clientReady', () => {
  console.log('✅ Bot Discord Arki Roulette est en ligne !');
  console.log(`📝 Connecté en tant que ${client.user.tag}`);
  console.log(`🎰 ${config.rouletteChoices.length} choix de roulette chargés`);
  console.log('\n💡 Commandes disponibles:');
  console.log('   /roulette - Lance la roue de la chance');
  console.log('   /set-choices - Modifie les choix de la roulette');
  console.log('   /show-choices - Affiche les choix actuels');
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'roulette') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({
        content: '❌ Seuls les administrateurs peuvent lancer la roulette !',
        ephemeral: true,
      });
    }

    await interaction.deferReply();

    try {
      const choices = config.rouletteChoices;
      const winningIndex = Math.floor(Math.random() * choices.length);
      const wheel = new RouletteWheel(choices);

      const frames = await wheel.generateAnimation(winningIndex);
      const winningChoice = wheel.getWinningChoice(winningIndex);

      const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('🎰 Roulette Arki')
        .setDescription('La roue tourne...')
        .setTimestamp();

      const initialAttachment = new AttachmentBuilder(frames[0], { name: 'roulette.png' });
      const message = await interaction.editReply({
        embeds: [embed],
        files: [initialAttachment],
      });

      for (let i = 1; i < frames.length; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        
        const frameAttachment = new AttachmentBuilder(frames[i], { name: 'roulette.png' });
        
        if (i === frames.length - 1) {
          const finalEmbed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('🎰 Roulette Arki - Résultat')
            .setDescription(`🎉 **Résultat:** ${winningChoice}`)
            .setFooter({ text: `Lancé par ${interaction.user.tag}` })
            .setTimestamp();

          await interaction.editReply({
            embeds: [finalEmbed],
            files: [frameAttachment],
          });
        } else {
          await interaction.editReply({
            embeds: [embed],
            files: [frameAttachment],
          });
        }
      }

      console.log(`🎲 Roulette lancée par ${interaction.user.tag}, résultat: ${winningChoice}`);

    } catch (error) {
      console.error('Erreur lors de la génération de la roulette:', error);
      await interaction.editReply({
        content: '❌ Une erreur est survenue lors de la génération de la roulette.',
      });
    }
  }

  if (commandName === 'set-choices') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({
        content: '❌ Seuls les administrateurs peuvent modifier les choix !',
        ephemeral: true,
      });
    }

    const choicesString = interaction.options.getString('choices');
    const newChoices = choicesString.split(',').map(c => c.trim()).filter(c => c.length > 0);

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

    config.rouletteChoices = newChoices;
    saveConfig();

    const embed = new EmbedBuilder()
      .setColor('#00FF00')
      .setTitle('✅ Choix mis à jour')
      .setDescription(`**${newChoices.length} nouveaux choix:**\n${newChoices.map((c, i) => `${i + 1}. ${c}`).join('\n')}`)
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
    console.log(`⚙️ Choix mis à jour par ${interaction.user.tag}`);
  }

  if (commandName === 'show-choices') {
    const choices = config.rouletteChoices;
    const embed = new EmbedBuilder()
      .setColor('#3498DB')
      .setTitle('📋 Choix actuels de la roulette')
      .setDescription(choices.map((c, i) => `${i + 1}. ${c}`).join('\n'))
      .setFooter({ text: `${choices.length} choix au total` })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
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
