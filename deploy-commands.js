const { REST, Routes } = require('discord.js');
const commands = require('./commands');

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;

if (!token || !clientId) {
  console.error('❌ Erreur: DISCORD_TOKEN et DISCORD_CLIENT_ID doivent être définis dans les secrets');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    console.log('🔄 Enregistrement des commandes slash...');
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('✅ Commandes slash enregistrées avec succès !');
  } catch (error) {
    console.error('❌ Erreur lors de l\'enregistrement des commandes:', error);
  }
})();
