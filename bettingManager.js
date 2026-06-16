const { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const pgStore = require('./pgStore');
const inventoryManager = require('./inventoryManager');

const pgKey = id => `bet_match_${id}`;
const pgLeaderboardKey = () => `bet_leaderboard`;

async function getAllMatches() {
  const data = await pgStore.getData('bet_all_matches');
  return data || [];
}

async function saveAllMatches(list) {
  await pgStore.setData('bet_all_matches', list);
}

async function getMatch(matchId) {
  return await pgStore.getData(pgKey(matchId));
}

async function saveMatch(match) {
  await pgStore.setData(pgKey(match.id), match);
  const all = await getAllMatches();
  if (!all.includes(match.id)) {
    all.push(match.id);
    await saveAllMatches(all);
  }
}

async function getLeaderboard() {
  return (await pgStore.getData(pgLeaderboardKey())) || {};
}

async function updateLeaderboard(userId, username, gain) {
  const lb = await getLeaderboard();
  if (!lb[userId]) lb[userId] = { username, totalGain: 0, wins: 0, losses: 0, bets: 0 };
  lb[userId].username = username;
  lb[userId].totalGain += gain;
  lb[userId].bets += 1;
  if (gain > 0) lb[userId].wins += 1;
  else if (gain < 0) lb[userId].losses += 1;
  await pgStore.setData(pgLeaderboardKey(), lb);
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function createMatch({ name, teamA, teamB, deadline, multTeam, multExact, minBet, maxBet, channelId, messageId }) {
  const match = {
    id: generateId(),
    name,
    teamA,
    teamB,
    deadline: new Date(deadline).getTime(),
    multTeam: parseFloat(multTeam) || 1.5,
    multExact: parseFloat(multExact) || 4.0,
    minBet: parseInt(minBet) || 10,
    maxBet: parseInt(maxBet) || 0,
    channelId,
    messageId: messageId || null,
    closed: false,
    resolved: false,
    result: null,
    bets: {},
    createdAt: Date.now(),
  };
  await saveMatch(match);
  return match;
}

async function placeBet(matchId, userId, username, teamPick, scorePick, amount) {
  const match = await getMatch(matchId);
  if (!match) throw new Error('Match introuvable.');
  if (match.closed || match.resolved) throw new Error('Les paris sont fermés pour ce match.');
  if (Date.now() > match.deadline) throw new Error('La deadline de ce match est passée.');
  if (match.bets[userId]) throw new Error('Tu as déjà placé un pari sur ce match.');

  amount = parseInt(amount);
  if (isNaN(amount) || amount <= 0) throw new Error('Montant invalide.');
  if (amount < match.minBet) throw new Error(`La mise minimum est de **${match.minBet} 💎**.`);
  if (match.maxBet > 0 && amount > match.maxBet) throw new Error(`La mise maximum est de **${match.maxBet} 💎**.`);

  const inv = inventoryManager.getPlayerInventory(userId);
  const balance = inv?.diamants || 0;
  if (balance < amount) throw new Error(`Tu n'as que **${balance} 💎** — mise insuffisante.`);

  await inventoryManager.removeFromInventory(userId, 'diamants', amount, 'bot', `Pari sur ${match.name}`);

  match.bets[userId] = {
    username,
    teamPick,
    scorePick: scorePick.trim(),
    amount,
    placedAt: Date.now(),
  };
  await saveMatch(match);
  return match;
}

async function closeMatch(matchId) {
  const match = await getMatch(matchId);
  if (!match) throw new Error('Match introuvable.');
  match.closed = true;
  await saveMatch(match);
  return match;
}

async function resolveMatch(matchId, winnerTeam, exactScore) {
  const match = await getMatch(matchId);
  if (!match) throw new Error('Match introuvable.');
  if (match.resolved) throw new Error('Ce match est déjà résolu.');

  match.closed = true;
  match.resolved = true;
  match.result = { winnerTeam, exactScore: exactScore.trim() };

  const results = [];

  for (const [userId, bet] of Object.entries(match.bets)) {
    const correctTeam = bet.teamPick.toLowerCase() === winnerTeam.toLowerCase();
    const correctScore = bet.scorePick.toLowerCase() === exactScore.toLowerCase().trim();

    let mult = 0;
    let label = '❌ Perdu';
    if (correctScore) {
      mult = match.multExact;
      label = `🎯 Score exact (×${mult})`;
    } else if (correctTeam) {
      mult = match.multTeam;
      label = `✅ Bonne équipe (×${mult})`;
    }

    const gain = mult > 0 ? Math.floor(bet.amount * mult) : 0;
    const netGain = gain - bet.amount;

    if (gain > 0) {
      await inventoryManager.addToInventory(userId, 'diamants', gain, 'bot', `Gain pari ${match.name}`);
    }

    await updateLeaderboard(userId, bet.username, netGain);

    results.push({ userId, username: bet.username, bet, mult, gain, netGain, label });
  }

  await saveMatch(match);
  return { match, results };
}

function buildMatchEmbed(match) {
  const now = Date.now();
  const deadlineTs = Math.floor(match.deadline / 1000);
  const totalBets = Object.keys(match.bets).length;
  const totalPool = Object.values(match.bets).reduce((s, b) => s + b.amount, 0);

  let status = match.resolved ? '🏁 Résolu' : match.closed ? '🔒 Fermé' : `⏳ Fermeture <t:${deadlineTs}:R>`;
  let color = match.resolved ? 0x2ecc71 : match.closed ? 0x95a5a6 : 0xe67e22;

  let desc = `**${match.teamA}** vs **${match.teamB}**\n\n`;
  desc += `⏰ Clôture des paris : <t:${deadlineTs}:F>\n`;
  desc += `💰 Mise min : **${match.minBet} 💎**`;
  if (match.maxBet > 0) desc += ` · Mise max : **${match.maxBet} 💎**`;
  desc += `\n📈 Mult. bonne équipe : **×${match.multTeam}** · Score exact : **×${match.multExact}**`;
  desc += `\n\n👥 **${totalBets}** pari${totalBets !== 1 ? 's' : ''} · 💎 Pool : **${totalPool}**`;

  if (match.resolved && match.result) {
    desc += `\n\n🏆 Résultat : **${match.result.winnerTeam}** · Score : **${match.result.exactScore}**`;
  }

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`⚽ Paris Sportifs — ${match.name}`)
    .setDescription(desc)
    .setFooter({ text: status });
}

function buildMatchComponents(match) {
  if (match.closed || match.resolved) return [];
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`bet_place_${match.id}`)
        .setLabel('🎯 Placer mon pari')
        .setStyle(ButtonStyle.Primary),
    ),
  ];
}

function buildResultEmbed(match, results) {
  let desc = `**${match.teamA}** vs **${match.teamB}**\n`;
  desc += `🏆 Résultat officiel : **${match.result.winnerTeam}** — **${match.result.exactScore}**\n\n`;

  if (results.length === 0) {
    desc += '*Aucun pari enregistré.*';
  } else {
    results.sort((a, b) => b.gain - a.gain);
    for (const r of results) {
      const sign = r.netGain >= 0 ? `+${r.netGain}` : `${r.netGain}`;
      desc += `**${r.username}** · Pari : ${r.bet.teamPick} ${r.bet.scorePick} (${r.bet.amount}💎) → ${r.label} → **${sign} 💎**\n`;
    }
  }

  return new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`🏁 Résultats — ${match.name}`)
    .setDescription(desc);
}

function buildLeaderboardEmbed(lb) {
  const sorted = Object.entries(lb).sort((a, b) => b[1].totalGain - a[1].totalGain).slice(0, 15);

  let desc = '';
  for (let i = 0; i < sorted.length; i++) {
    const [, p] = sorted[i];
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;
    const sign = p.totalGain >= 0 ? `+${p.totalGain}` : `${p.totalGain}`;
    desc += `${medal} **${p.username}** — ${sign} 💎 · ${p.wins}W/${p.losses}L (${p.bets} paris)\n`;
  }

  if (!desc) desc = '*Aucun pari résolu pour l\'instant.*';

  return new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('🏆 Classement Paris Sportifs')
    .setDescription(desc);
}

async function deleteMatch(matchId) {
  const match = await getMatch(matchId);
  if (!match) throw new Error('Match introuvable.');
  await pgStore.setData(pgKey(matchId), null);
  const all = await getAllMatches();
  await saveAllMatches(all.filter(id => id !== matchId));
  return match;
}

module.exports = {
  createMatch, getMatch, saveMatch, getAllMatches,
  placeBet, closeMatch, resolveMatch, deleteMatch,
  buildMatchEmbed, buildMatchComponents, buildResultEmbed, buildLeaderboardEmbed,
  getLeaderboard,
};
