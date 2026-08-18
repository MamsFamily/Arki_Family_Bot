'use strict';
/**
 * werewolfManager.js — Système Loup-Garou pour Arki Family
 *
 * Phases : LOBBY → NIGHT → DAY → VOTE → RESULT → ENDED
 */
const pgStore = require('./pgStore');

// ─────────────────────────────────────────────────────────────────────────────
// RÔLES
// ─────────────────────────────────────────────────────────────────────────────
const ROLES = {
  // ── Village ────────────────────────────────────────────────────────────────
  villageois: {
    name: 'Villageois', emoji: '🧑‍🌾', team: 'village', maxCount: 20,
    description: 'Simple villageois. Ton seul pouvoir est ton vote lors des débats. Travaille avec les autres pour démasquer les Loups-Garous.',
    night: false,
  },
  voyante: {
    name: 'Voyante', emoji: '🔮', team: 'village', maxCount: 1,
    description: 'Chaque nuit, tu peux regarder dans les étoiles et découvrir la véritable nature (rôle) d\'un joueur de ton choix. Utilise cette information avec sagesse.',
    night: true, nightAction: 'see',
  },
  sorciere: {
    name: 'Sorcière', emoji: '🧪', team: 'village', maxCount: 1,
    description: 'Tu possèdes deux potions : une de vie (ressuscite la victime des loups) et une de mort (élimine un joueur). Chacune ne peut être utilisée qu\'une seule fois dans la partie.',
    night: true, nightAction: 'potion', hasPotions: true,
  },
  chasseur: {
    name: 'Chasseur', emoji: '🏹', team: 'village', maxCount: 1,
    description: 'Si tu es éliminé (par vote ou par les loups), tu peux immédiatement abattre un autre joueur de ton choix avant de mourir. Ton fusil ne rate jamais.',
    night: false, onDeath: 'shoot',
  },
  cupidon: {
    name: 'Cupidon', emoji: '💘', team: 'village', maxCount: 1,
    description: 'Au début de la partie (première nuit), tu choisis deux joueurs et les unis par les liens de l\'amour. Si l\'un des amoureux meurt, l\'autre meurt de chagrin immédiatement.',
    night: true, nightAction: 'link', firstNightOnly: true,
  },
  petite_fille: {
    name: 'Petite Fille', emoji: '👧', team: 'village', maxCount: 1,
    description: 'Pendant la phase nuit, tu peux essayer d\'espionner les Loups-Garous. Si tu es surprise en train d\'épier, tu es dévorée à leur place.',
    night: false,
  },
  ancien: {
    name: 'Ancien', emoji: '🧓', team: 'village', maxCount: 1,
    description: 'Tu possèdes la sagesse des années et résistes à la première attaque des Loups-Garous. Mais si tu es éliminé par vote du village, tous les villageois perdent leurs pouvoirs spéciaux.',
    night: false,
  },
  capitaine: {
    name: 'Capitaine', emoji: '⚓', team: 'village', maxCount: 1,
    description: 'Ton vote compte double lors des éliminations. À ta mort, tu transmets le titre de Capitaine à un joueur de ton choix.',
    night: false,
  },
  salvateur: {
    name: 'Salvateur', emoji: '🛡️', team: 'village', maxCount: 1,
    description: 'Chaque nuit, tu peux protéger un joueur (y compris toi-même) contre les Loups-Garous. Tu ne peux pas protéger la même personne deux nuits de suite.',
    night: true, nightAction: 'protect',
  },
  corbeau: {
    name: 'Corbeau', emoji: '🐦‍⬛', team: 'village', maxCount: 1,
    description: 'Chaque nuit, tu peux désigner un joueur qui recevra 2 votes supplémentaires lors du vote du lendemain. Un pouvoir subtil et dangereux entre de bonnes mains.',
    night: true, nightAction: 'mark',
  },
  idiot_village: {
    name: 'Idiot du Village', emoji: '🃏', team: 'village', maxCount: 1,
    description: 'Si le village vote ton élimination, ton rôle est révélé mais tu restes en vie — tu perds simplement ton droit de vote. Les Loups-Garous peuvent toujours te tuer.',
    night: false,
  },
  ange: {
    name: 'Ange', emoji: '😇', team: 'solo', maxCount: 1,
    description: 'Tu gagnes seul si tu es éliminé lors du premier vote du village. Si tu survis au premier vote, tu deviens un simple Villageois.',
    night: false,
  },
  servante: {
    name: 'Servante Dévouée', emoji: '🤝', team: 'village', maxCount: 1,
    description: 'Si un joueur avec un rôle spécial est éliminé par vote, tu peux choisir secrètement d\'endosser son rôle avant que son identité ne soit révélée.',
    night: false,
  },
  // ── Loups ──────────────────────────────────────────────────────────────────
  loup_garou: {
    name: 'Loup-Garou', emoji: '🐺', team: 'wolves', maxCount: 10,
    description: 'Chaque nuit, tu te réunis avec les autres Loups-Garous pour choisir une victime à dévorer. Le jour, tu te fondas dans la masse pour passer inaperçu. Élimine tous les Villageois.',
    night: true, nightAction: 'devour',
  },
  grand_mechant_loup: {
    name: 'Grand Méchant Loup', emoji: '🐺💀', team: 'wolves', maxCount: 1,
    description: 'Tu es un Loup-Garou mais plus puissant. Tant qu\'aucun joueur ayant un rôle spécial n\'a été dévoré, tu peux attaquer une victime supplémentaire chaque nuit.',
    night: true, nightAction: 'devour',
  },
  loup_blanc: {
    name: 'Loup Blanc', emoji: '🤍🐺', team: 'solo', maxCount: 1,
    description: 'Tu joues comme un Loup-Garou mais ton but est de gagner seul. Une nuit sur deux, tu peux éliminer un de tes alliés Loups-Garous. Tu gagnes si tu es le dernier survivant.',
    night: true, nightAction: 'devour',
  },
  loup_infect: {
    name: 'Père des Loups', emoji: '🦠🐺', team: 'wolves', maxCount: 1,
    description: 'Une fois dans la partie, au lieu de dévorer la victime choisie, tu peux l\'infecter et la convertir en Loup-Garou. La victime garde secrètement son rôle mais rejoint l\'équipe des loups.',
    night: true, nightAction: 'devour',
  },
  // ── Neutres ────────────────────────────────────────────────────────────────
  joueur_flute: {
    name: 'Joueur de Flûte', emoji: '🪈', team: 'solo', maxCount: 1,
    description: 'Tu n\'appartiens à aucun camp. Chaque nuit, tu ensorcèles deux joueurs. Tu gagnes si tu réussis à ensorceler tous les survivants avant la fin de la partie.',
    night: true, nightAction: 'charm',
  },
  assassin: {
    name: 'Assassin', emoji: '🗡️', team: 'solo', maxCount: 1,
    description: 'Tu as une liste secrète de cibles à éliminer dans un ordre précis. Si tu remplis ton contrat, tu gagnes. Tu joues comme un Villageois en apparence.',
    night: false,
  },
};

const TEAM_LABELS = {
  village: '🟢 Village',
  wolves:  '🔴 Loups',
  solo:    '🟣 Solitaire',
};

// ─────────────────────────────────────────────────────────────────────────────
// PERSISTANCE
// ─────────────────────────────────────────────────────────────────────────────
const KEY_PLAYERS = 'werewolf_players';
const KEY_GAME    = 'werewolf_game';

async function getPlayers() {
  const r = await pgStore.getData(KEY_PLAYERS, null);
  return Array.isArray(r) ? r : (r ? JSON.parse(r) : []);
}
async function savePlayers(list) { await pgStore.setData(KEY_PLAYERS, list); }

async function getGame() {
  const r = await pgStore.getData(KEY_GAME, null);
  return r && typeof r === 'object' ? r : (r ? JSON.parse(r) : null);
}
async function saveGame(state) { await pgStore.setData(KEY_GAME, state); }

// ─────────────────────────────────────────────────────────────────────────────
// GESTION DES JOUEURS (LOBBY)
// ─────────────────────────────────────────────────────────────────────────────
async function addPlayer({ userId, username, displayName }) {
  const players = await getPlayers();
  if (players.find(p => p.userId === userId)) throw new Error('Joueur déjà dans la liste');
  players.push({ userId, username, displayName, addedAt: Date.now() });
  await savePlayers(players);
  return players;
}

async function removePlayer(userId) {
  let players = await getPlayers();
  const before = players.length;
  players = players.filter(p => p.userId !== userId);
  if (players.length === before) throw new Error('Joueur introuvable');
  await savePlayers(players);
  return players;
}

// ─────────────────────────────────────────────────────────────────────────────
// DÉMARRAGE DE LA PARTIE — TIRAGE AU SORT
// ─────────────────────────────────────────────────────────────────────────────
async function startGame(roleConfig) {
  const players = await getPlayers();
  if (players.length < 4) throw new Error('Il faut au moins 4 joueurs pour commencer');

  // Construire le pool de rôles
  const pool = [];
  for (const [roleId, count] of Object.entries(roleConfig)) {
    if (!ROLES[roleId] || count <= 0) continue;
    for (let i = 0; i < count; i++) pool.push(roleId);
  }
  if (pool.length !== players.length) {
    throw new Error(`${pool.length} rôle(s) configuré(s) pour ${players.length} joueur(s) — ils doivent être égaux`);
  }

  // Mélange Fisher-Yates
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const assignments = players.map((p, i) => ({
    userId:      p.userId,
    username:    p.username,
    displayName: p.displayName,
    roleId:      pool[i],
    alive:       true,
    ackReceived: false,
    dmSent:      false,
    dmError:     null,
  }));

  const state = {
    phase:       'LOBBY',   // LOBBY | NIGHT | DAY | VOTE | RESULT | ENDED
    round:       0,
    startedAt:   Date.now(),
    assignments,
    votes:       {},        // { voterId: targetId }
    voteDeadline: null,     // timestamp fin du vote
    voteMessageId: null,
    voteChannelId: null,
    wolfThreadId:  null,
    wolfChannelId: null,
    eliminated:  [],        // { userId, roleId, round, by: 'vote'|'wolves'|'ability' }
    extraVotes:  {},        // { userId: bonus } (Corbeau)
    lovers:      [],        // [userId, userId]
    sorciere:    { lifePotion: true, deathPotion: true },
    savedTonight: null,     // Salvateur
    history:     [],
  };

  await saveGame(state);
  return state;
}

// ─────────────────────────────────────────────────────────────────────────────
// ENVOI DES DMs DE RÔLE
// ─────────────────────────────────────────────────────────────────────────────
function buildRoleMessage(assignment) {
  const role = ROLES[assignment.roleId];
  const teamLabel = TEAM_LABELS[role.team] || role.team;
  return (
    `## ${role.emoji} Tu es : **${role.name}**\n\n` +
    `**Camp :** ${teamLabel}\n\n` +
    `**Ton rôle :**\n${role.description}\n\n` +
    `> Garde ton rôle **absolument secret** — ne le révèle jamais sauf si ton rôle l'exige.\n\n` +
    `Clique sur le bouton ci-dessous pour confirmer que tu as bien reçu et compris ton rôle ↓`
  );
}

async function sendRoleDMs(client, guildId) {
  const game = await getGame();
  if (!game) throw new Error('Aucune partie en cours');

  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
  const results = [];

  for (const a of game.assignments) {
    if (a.dmSent) { results.push({ userId: a.userId, ok: true, cached: true }); continue; }
    try {
      const user = await client.users.fetch(a.userId);
      const row  = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`ww_ack_${a.userId}`)
          .setLabel('✅ J\'ai bien reçu et compris mon rôle')
          .setStyle(ButtonStyle.Success)
      );
      await user.send({ content: buildRoleMessage(a), components: [row] });
      a.dmSent  = true;
      a.dmError = null;
      results.push({ userId: a.userId, displayName: a.displayName, ok: true });
    } catch (e) {
      a.dmError = e.message;
      results.push({ userId: a.userId, displayName: a.displayName, ok: false, error: e.message });
    }
  }

  game.phase = 'NIGHT';
  game.round = 1;
  await saveGame(game);
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// ACCUSÉ DE RÉCEPTION
// ─────────────────────────────────────────────────────────────────────────────
async function handleAck(userId) {
  const game = await getGame();
  if (!game) return false;
  const a = game.assignments.find(x => x.userId === userId);
  if (!a) return false;
  a.ackReceived = true;
  await saveGame(game);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// THREAD PRIVÉ LOUPS-GAROUS
// ─────────────────────────────────────────────────────────────────────────────
async function createWolfThread(client, guildId, channelId, adminId) {
  const game = await getGame();
  if (!game) throw new Error('Aucune partie en cours');

  const guild   = await client.guilds.fetch(guildId);
  const channel = await client.channels.fetch(channelId);
  const wolves  = game.assignments.filter(a => ROLES[a.roleId]?.team === 'wolves' && a.alive);

  // Créer un fil privé
  const thread = await channel.threads.create({
    name:                 `🐺 Loups-Garous — Nuit ${game.round}`,
    autoArchiveDuration:  10080, // 7 jours
    type:                 12,    // PRIVATE_THREAD
    invitable:            false,
    reason:               'Thread privé Loups-Garous — Loup Garou game',
  });

  // Ajouter les loups
  for (const wolf of wolves) {
    try { await thread.members.add(wolf.userId); } catch {}
  }
  // Ajouter l'admin
  if (adminId) { try { await thread.members.add(adminId); } catch {} }

  // Message d'accueil
  const wolfNames = wolves.map(w => `<@${w.userId}>`).join(', ');
  await thread.send(
    `## 🐺 Bienvenue dans le repaire des Loups-Garous !\n\n` +
    `Loups présents : ${wolfNames}\n\n` +
    `Utilisez ce fil pour vous concerter chaque nuit. **L'administrateur peut lire ce fil.**\n` +
    `Choisissez votre victime et communiquez-la à l'administrateur.`
  );

  game.wolfThreadId  = thread.id;
  game.wolfChannelId = channelId;
  await saveGame(game);
  return thread;
}

// ─────────────────────────────────────────────────────────────────────────────
// VOTE D'ÉLIMINATION
// ─────────────────────────────────────────────────────────────────────────────
async function createVotePoll(client, guildId, channelId, durationMinutes = 5) {
  const game = await getGame();
  if (!game) throw new Error('Aucune partie en cours');

  const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

  const alivePlayers = game.assignments.filter(a => a.alive);
  const deadline     = Date.now() + durationMinutes * 60 * 1000;
  game.votes         = {};
  game.extraVotes    = game.extraVotes || {};
  game.voteDeadline  = deadline;
  game.voteChannelId = channelId;
  game.phase         = 'VOTE';

  const guild   = await client.guilds.fetch(guildId);
  const channel = await client.channels.fetch(channelId);

  // Embed principal
  const embed = buildVoteEmbed(game, alivePlayers, deadline);

  // Boutons (un par joueur vivant, max 25)
  const rows = [];
  let currentRow = new ActionRowBuilder();
  let btnCount   = 0;
  for (const p of alivePlayers) {
    if (btnCount > 0 && btnCount % 5 === 0) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder();
    }
    currentRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`ww_vote_${p.userId}`)
        .setLabel(p.displayName.slice(0, 80))
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('🗳️')
    );
    btnCount++;
  }
  if (btnCount % 5 !== 0 || btnCount === 0) rows.push(currentRow);

  const msg = await channel.send({ embeds: [embed], components: rows.slice(0, 5) });
  game.voteMessageId = msg.id;
  await saveGame(game);

  // Auto-résolution après le délai
  setTimeout(() => resolveVote(client, guildId, channelId).catch(() => {}), durationMinutes * 60 * 1000 + 2000);

  return msg;
}

function buildVoteEmbed(game, alivePlayers, deadline) {
  const { EmbedBuilder } = require('discord.js');
  const deadlineTs = Math.floor((deadline || game.voteDeadline) / 1000);
  const voteCount  = Object.keys(game.votes || {}).length;
  const totalVoters = alivePlayers ? alivePlayers.length : game.assignments.filter(a => a.alive).length;

  // Résumé des votes (sans révéler qui a voté pour qui pendant le vote)
  const tally = {};
  for (const targetId of Object.values(game.votes || {})) {
    tally[targetId] = (tally[targetId] || 0) + 1;
  }
  const tallyLines = Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .map(([uid, cnt]) => {
      const p = game.assignments.find(x => x.userId === uid);
      return `• **${p?.displayName || uid}** — ${cnt} vote(s)`;
    });

  return new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle('🗳️ VOTE D\'ÉLIMINATION')
    .setDescription(
      `Le village doit désigner un suspect !\n\n` +
      `⏳ **Temps restant :** <t:${deadlineTs}:R> (fin <t:${deadlineTs}:T>)\n` +
      `📊 **Votes reçus :** ${voteCount} / ${totalVoters}\n\n` +
      (tallyLines.length ? `**Décompte en cours :**\n${tallyLines.join('\n')}` : '_Aucun vote pour l\'instant…_')
    )
    .setFooter({ text: `Manche ${game.round} • Votez en cliquant sur le nom du suspect` })
    .setTimestamp();
}

async function handleVote(userId, targetId) {
  const game = await getGame();
  if (!game || game.phase !== 'VOTE') return { ok: false, reason: 'Pas de vote en cours' };

  const voter  = game.assignments.find(a => a.userId === userId && a.alive);
  const target = game.assignments.find(a => a.userId === targetId && a.alive);
  if (!voter)  return { ok: false, reason: 'Tu n\'es pas un joueur vivant' };
  if (!target) return { ok: false, reason: 'Cible invalide ou éliminée' };
  if (userId === targetId) return { ok: false, reason: 'Tu ne peux pas voter pour toi-même' };

  const previous = game.votes[userId];
  game.votes[userId] = targetId;
  await saveGame(game);
  return { ok: true, changed: previous !== targetId, previous };
}

async function updateVoteMessage(client) {
  const game = await getGame();
  if (!game?.voteMessageId || !game?.voteChannelId) return;
  try {
    const channel = await client.channels.fetch(game.voteChannelId);
    const msg     = await channel.messages.fetch(game.voteMessageId);
    const alive   = game.assignments.filter(a => a.alive);
    const embed   = buildVoteEmbed(game, alive, game.voteDeadline);
    await msg.edit({ embeds: [embed] });
  } catch {}
}

async function resolveVote(client, guildId, channelId) {
  const game = await getGame();
  if (!game || game.phase !== 'VOTE') return null;

  const { EmbedBuilder } = require('discord.js');

  // Décompte
  const tally = { ...game.extraVotes };
  for (const targetId of Object.values(game.votes)) {
    tally[targetId] = (tally[targetId] || 0) + 1;
  }

  // Capitaine — vote double
  const capitaine = game.assignments.find(a => a.roleId === 'capitaine' && a.alive && game.votes[a.userId]);
  if (capitaine && game.votes[capitaine.userId]) {
    const capTarget = game.votes[capitaine.userId];
    tally[capTarget] = (tally[capTarget] || 0) + 1; // +1 bonus
  }

  const sorted    = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const eliminated = sorted[0] ? game.assignments.find(a => a.userId === sorted[0][0]) : null;

  let resultEmbed;
  if (!eliminated || sorted[0][1] === 0) {
    resultEmbed = new EmbedBuilder()
      .setColor(0x95a5a6)
      .setTitle('🗳️ Vote terminé — Aucun résultat')
      .setDescription('Personne n\'a reçu de votes. Le village se divise…')
      .setTimestamp();
  } else {
    // Idiot du village — survit à l'élimination
    if (eliminated.roleId === 'idiot_village') {
      eliminated.alive = true;
      game.assignments.find(a => a.userId === eliminated.userId).ackReceived = true;
      resultEmbed = new EmbedBuilder()
        .setColor(0xe67e22)
        .setTitle(`🃏 ${eliminated.displayName} était… l'Idiot du Village !`)
        .setDescription(
          `Avec **${sorted[0][1]} vote(s)**, ${eliminated.displayName} aurait dû être éliminé(e).\n\n` +
          `Mais c'est **l'Idiot du Village** ! Il/elle reste en vie mais perd son droit de vote.`
        ).setTimestamp();
    } else {
      // Élimination normale
      eliminated.alive = false;
      game.eliminated.push({
        userId:      eliminated.userId,
        displayName: eliminated.displayName,
        roleId:      eliminated.roleId,
        round:       game.round,
        by:          'vote',
        votes:       sorted[0][1],
      });
      const role = ROLES[eliminated.roleId];
      resultEmbed = new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle(`☠️ ${eliminated.displayName} a été éliminé(e) !`)
        .setDescription(
          `Avec **${sorted[0][1]} vote(s)**, le village a choisi.\n\n` +
          `${eliminated.displayName} était… **${role?.emoji} ${role?.name}** (${TEAM_LABELS[role?.team] || role?.team}) !`
        ).setTimestamp();
    }
  }

  game.phase      = 'NIGHT';
  game.round      += 1;
  game.votes      = {};
  game.extraVotes = {};

  // Supprimer les boutons du message de vote
  try {
    const channel = await client.channels.fetch(game.voteChannelId || channelId);
    if (game.voteMessageId) {
      const msg = await channel.messages.fetch(game.voteMessageId);
      await msg.edit({ components: [] });
    }
    await channel.send({ embeds: [resultEmbed] });
  } catch {}

  // Vérifier conditions de victoire
  const victoryCheck = checkVictory(game);
  if (victoryCheck) {
    game.phase = 'ENDED';
    game.winner = victoryCheck;
    try {
      const channel = await client.channels.fetch(game.voteChannelId || channelId);
      await channel.send({ embeds: [buildVictoryEmbed(game, victoryCheck)] });
    } catch {}
  }

  await saveGame(game);
  return { eliminated, tally, victory: victoryCheck };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONDITION DE VICTOIRE
// ─────────────────────────────────────────────────────────────────────────────
function checkVictory(game) {
  const alive       = game.assignments.filter(a => a.alive);
  const aliveWolves = alive.filter(a => ROLES[a.roleId]?.team === 'wolves');
  const aliveVillagers = alive.filter(a => ROLES[a.roleId]?.team === 'village');

  if (aliveWolves.length === 0) return 'village';
  if (aliveWolves.length >= aliveVillagers.length) return 'wolves';
  return null;
}

function buildVictoryEmbed(game, winner) {
  const { EmbedBuilder } = require('discord.js');
  const isVillage = winner === 'village';
  const embed = new EmbedBuilder()
    .setColor(isVillage ? 0x2ecc71 : 0xe74c3c)
    .setTitle(isVillage ? '🎉 VICTOIRE DU VILLAGE !' : '🐺 VICTOIRE DES LOUPS-GAROUS !')
    .setDescription(
      isVillage
        ? 'Tous les Loups-Garous ont été éliminés ! Le village peut dormir en paix. 🌅'
        : 'Les Loups-Garous ont pris le contrôle du village ! La nuit règne pour toujours. 🌑'
    )
    .addFields({
      name: '📋 Révélation des rôles',
      value: game.assignments.map(a => {
        const role = ROLES[a.roleId];
        return `${a.alive ? '✅' : '☠️'} **${a.displayName}** — ${role?.emoji} ${role?.name}`;
      }).join('\n') || '—',
    })
    .setTimestamp();
  return embed;
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIONS NOCTURNES (VOYANTE, SORCIÈRE, SALVATEUR, CORBEAU)
// ─────────────────────────────────────────────────────────────────────────────
async function sendNightActionDMs(client) {
  const game = await getGame();
  if (!game) return;
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

  for (const a of game.assignments.filter(x => x.alive)) {
    const role = ROLES[a.roleId];
    if (!role?.night || !role?.nightAction) continue;
    if (a.roleId === 'loup_garou' || a.roleId === 'grand_mechant_loup' || a.roleId === 'loup_infect' || a.roleId === 'loup_blanc') continue;

    try {
      const user = await client.users.fetch(a.userId);
      const alive = game.assignments.filter(x => x.alive && x.userId !== a.userId);

      if (a.roleId === 'voyante') {
        const rows = [];
        let row = new ActionRowBuilder();
        let i = 0;
        for (const p of alive) {
          if (i > 0 && i % 5 === 0) { rows.push(row); row = new ActionRowBuilder(); }
          row.addComponents(new ButtonBuilder().setCustomId(`ww_see_${p.userId}`).setLabel(p.displayName.slice(0,80)).setStyle(ButtonStyle.Primary));
          i++;
        }
        if (i % 5 !== 0 || i === 0) rows.push(row);
        await user.send({ content: `🔮 **Nuit ${game.round}** — Voyante, qui veux-tu observer ce soir ?`, components: rows.slice(0,5) });
      }
      if (a.roleId === 'salvateur') {
        const rows = [];
        let row = new ActionRowBuilder();
        let i = 0;
        const targets = game.assignments.filter(x => x.alive);
        for (const p of targets) {
          if (i > 0 && i % 5 === 0) { rows.push(row); row = new ActionRowBuilder(); }
          row.addComponents(new ButtonBuilder().setCustomId(`ww_protect_${p.userId}`).setLabel(p.displayName.slice(0,80)).setStyle(ButtonStyle.Success));
          i++;
        }
        if (i % 5 !== 0 || i === 0) rows.push(row);
        await user.send({ content: `🛡️ **Nuit ${game.round}** — Salvateur, qui veux-tu protéger cette nuit ?`, components: rows.slice(0,5) });
      }
      if (a.roleId === 'corbeau') {
        const rows = [];
        let row = new ActionRowBuilder();
        let i = 0;
        for (const p of alive) {
          if (i > 0 && i % 5 === 0) { rows.push(row); row = new ActionRowBuilder(); }
          row.addComponents(new ButtonBuilder().setCustomId(`ww_mark_${p.userId}`).setLabel(p.displayName.slice(0,80)).setStyle(ButtonStyle.Danger));
          i++;
        }
        if (i % 5 !== 0 || i === 0) rows.push(row);
        await user.send({ content: `🐦‍⬛ **Nuit ${game.round}** — Corbeau, qui veux-tu marquer (+2 votes demain) ?`, components: rows.slice(0,5) });
      }
    } catch (e) {
      console.error(`[Werewolf] nightAction DM error for ${a.displayName}:`, e.message);
    }
  }
}

async function handleNightAction(client, action, actorId, targetId) {
  const game = await getGame();
  if (!game) return { ok: false };
  const actor  = game.assignments.find(a => a.userId === actorId && a.alive);
  const target = game.assignments.find(a => a.userId === targetId);
  if (!actor || !target) return { ok: false };

  if (action === 'see') {
    const role = ROLES[target.roleId];
    const user = await client.users.fetch(actorId);
    await user.send(`🔮 **Résultat de ta vision :** ${target.displayName} est… **${role?.emoji} ${role?.name}** (${TEAM_LABELS[role?.team] || role?.team})`).catch(() => {});
    return { ok: true };
  }
  if (action === 'protect') {
    game.savedTonight = targetId;
    await saveGame(game);
    const user = await client.users.fetch(actorId);
    await user.send(`🛡️ Tu protèges **${target.displayName}** cette nuit.`).catch(() => {});
    return { ok: true };
  }
  if (action === 'mark') {
    game.extraVotes = game.extraVotes || {};
    game.extraVotes[targetId] = (game.extraVotes[targetId] || 0) + 2;
    await saveGame(game);
    const user = await client.users.fetch(actorId);
    await user.send(`🐦‍⬛ **${target.displayName}** recevra +2 votes lors du prochain vote.`).catch(() => {});
    return { ok: true };
  }
  return { ok: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// ÉLIMINATION MANUELLE (nuit / capacité spéciale)
// ─────────────────────────────────────────────────────────────────────────────
async function eliminatePlayer(userId, by = 'wolves') {
  const game = await getGame();
  if (!game) throw new Error('Aucune partie en cours');
  const a = game.assignments.find(x => x.userId === userId && x.alive);
  if (!a) throw new Error('Joueur introuvable ou déjà éliminé');
  a.alive = false;
  game.eliminated.push({
    userId:      a.userId,
    displayName: a.displayName,
    roleId:      a.roleId,
    round:       game.round,
    by,
    eliminatedAt: Date.now(),
  });
  // Amoureux — si un des deux meurt, l'autre aussi
  if (game.lovers?.includes(userId)) {
    const partnerId = game.lovers.find(id => id !== userId);
    if (partnerId) {
      const partner = game.assignments.find(x => x.userId === partnerId && x.alive);
      if (partner) {
        partner.alive = false;
        game.eliminated.push({
          userId:      partner.userId,
          displayName: partner.displayName,
          roleId:      partner.roleId,
          round:       game.round,
          by:          'lovers',
          eliminatedAt: Date.now(),
        });
      }
    }
  }
  const victory = checkVictory(game);
  if (victory) { game.phase = 'ENDED'; game.winner = victory; }
  await saveGame(game);
  return { eliminated: a, victory };
}

module.exports = {
  ROLES, TEAM_LABELS,
  getPlayers, savePlayers, addPlayer, removePlayer,
  getGame, saveGame,
  startGame, sendRoleDMs, handleAck,
  createWolfThread,
  createVotePoll, handleVote, updateVoteMessage, resolveVote,
  sendNightActionDMs, handleNightAction,
  eliminatePlayer,
  checkVictory, buildVictoryEmbed,
};
