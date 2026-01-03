const { Client } = require('unb-api');

const GUILD_ID = '1156256997403000874';
const token = process.env.UNBELIEVABOAT_TOKEN;

let unbClient = null;

function getClient() {
  if (!unbClient && token) {
    unbClient = new Client(token);
  }
  return unbClient;
}

async function addCashToUser(userId, amount, reason = 'Récompense votes mensuels') {
  const client = getClient();
  if (!client) {
    console.error('❌ Token UnbelievaBoat non configuré');
    return { success: false, error: 'Token non configuré' };
  }

  try {
    const result = await client.editUserBalance(GUILD_ID, userId, { cash: amount }, reason);
    console.log(`💎 ${amount} diamants ajoutés à ${userId}`);
    return { success: true, data: result };
  } catch (error) {
    console.error(`❌ Erreur lors de l'ajout de diamants à ${userId}:`, error.message);
    return { success: false, error: error.message };
  }
}

async function getUserBalance(userId) {
  const client = getClient();
  if (!client) {
    return null;
  }

  try {
    return await client.getUserBalance(GUILD_ID, userId);
  } catch (error) {
    console.error(`❌ Erreur lors de la récupération du solde de ${userId}:`, error.message);
    return null;
  }
}

function generateDraftBotCommands(players, memberIndex, resolvePlayer) {
  const { TOP_LOTS } = require('./votesConfig');
  const commands = [];

  for (let i = 0; i < Math.min(players.length, 3); i++) {
    const player = players[i];
    const rank = i + 1;
    const lots = TOP_LOTS[rank];
    
    if (!lots) continue;

    const memberId = resolvePlayer(memberIndex, player.playername);
    const mention = memberId ? `<@${memberId}>` : player.playername;

    for (const [item, qty] of Object.entries(lots)) {
      commands.push(`/admininventaire donner membre:${mention} objet:"${item}" quantité:${qty}`);
    }
  }

  return commands;
}

module.exports = {
  getClient,
  addCashToUser,
  getUserBalance,
  generateDraftBotCommands,
  GUILD_ID,
};
