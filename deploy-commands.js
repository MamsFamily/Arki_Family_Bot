const { REST, Routes } = require('discord.js');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));

const commands = [
  {
    name: 'roulette',
    description: 'Lance la roue de la chance Arki (Admin seulement)',
  },
  {
    name: 'set-choices',
    description: 'Modifie les choix de la roulette (Admin seulement)',
    options: [
      {
        name: 'choices',
        type: 3,
        description: 'Les choix séparés par des virgules (ex: Choix1,Choix2,Choix3)',
        required: true,
      },
      {
        name: 'title',
        type: 3,
        description: 'Le titre au centre (optionnel, max 15 caractères)',
        required: false,
      },
    ],
  },
  {
    name: 'show-choices',
    description: 'Affiche les choix actuels de la roulette',
  },
  {
    name: 'set-title',
    description: 'Modifie le titre au centre de la roulette (Admin seulement)',
    options: [
      {
        name: 'title',
        type: 3,
        description: 'Le nouveau titre (ex: ARKI, CHAMPION, etc.)',
        required: true,
      },
    ],
  },
];

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;

if (!token || !clientId) {
  console.error('❌ Erreur: DISCORD_TOKEN et DISCORD_CLIENT_ID doivent être définis dans les secrets');
  console.log('💡 Ajoutez ces secrets dans l\'onglet "Secrets" de Replit:');
  console.log('   - DISCORD_TOKEN: Le token de votre bot Discord');
  console.log('   - DISCORD_CLIENT_ID: L\'ID client de votre application Discord');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    console.log('🔄 Enregistrement des commandes slash...');

    await rest.put(
      Routes.applicationCommands(clientId),
      { body: commands }
    );

    console.log('✅ Commandes slash enregistrées avec succès !');
  } catch (error) {
    console.error('❌ Erreur lors de l\'enregistrement des commandes:', error);
  }
})();
