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
    description: `Tu n'as pas de pouvoir nocturne. Chaque jour, tu participes aux discussions et tu votes pour éliminer le joueur que tu soupçonnes. Observe les incohérences, compare les comportements et aide le Village à identifier les Loups-Garous. Tu gagnes lorsque tous les Loups-Garous sont éliminés. 🔒 Ton rôle doit rester secret : ne dis pas publiquement que tu es Villageois, sauf si ta stratégie l'exige.`,
    required: true,
    night: false,
  },
  voyante: {
    name: 'Voyante', emoji: '🔮', team: 'village', maxCount: 1,
    description: `Chaque nuit, tu peux inspecter un joueur vivant et découvrir son rôle exact. Cette information est puissante, mais elle fait de toi une cible prioritaire pour les Loups. Tu dois convaincre le Village avec tes déductions sans fournir une preuve trop évidente de ton identité. Tu gagnes avec le Village. 🔒 Secret absolu : ne révèle jamais que tu connais le rôle d'un joueur et ne dis jamais « je suis la Voyante » ; présente tes conclusions comme des soupçons ou des raisonnements.`,
    night: true, nightAction: 'see',
  },
  sorciere: {
    name: 'Sorcière', emoji: '🧪', team: 'village', maxCount: 1,
    description: `Tu possèdes deux potions utilisables chacune une seule fois : la potion de vie peut sauver la victime des Loups pendant la nuit, et la potion de mort peut éliminer le joueur de ton choix. Tu peux conserver une potion pour une nuit ultérieure ou ne rien utiliser. Tu gagnes avec le Village. 🔒 Ne révèle jamais que tu es la Sorcière, quelles potions tu possèdes ou quelle potion tu as utilisée.`,
    night: true, nightAction: 'potion', hasPotions: true,
  },
  chasseur: {
    name: 'Chasseur', emoji: '🏹', team: 'village', maxCount: 1,
    description: `Si tu es éliminé par les Loups ou par le vote du Village, tu peux tirer immédiatement sur un autre joueur avant de mourir. Ton tir est définitif : choisis avec attention, car tu peux éliminer un allié par erreur. Tu gagnes avec le Village. 🔒 Ton rôle et l'existence de ton tir doivent rester secrets tant que tu es vivant.`,
    night: false, onDeath: 'shoot',
  },
  cupidon: {
    name: 'Cupidon', emoji: '💘', team: 'village', maxCount: 1,
    description: `Pendant la première nuit, tu choisis deux joueurs qui deviennent amoureux. Si l'un des amoureux meurt, l'autre meurt immédiatement de chagrin. Les amoureux peuvent appartenir à des camps différents et doivent alors adapter leur stratégie pour être les derniers survivants. Tu gagnes normalement avec le Village, sauf si les conditions des amoureux modifient la victoire. 🔒 Ne révèle jamais l'identité des amoureux ni ton rôle.`,
    night: true, nightAction: 'link', firstNightOnly: true,
  },
  petite_fille: {
    name: 'Petite Fille', emoji: '👧', team: 'village', maxCount: 1,
    description: `Tu appartiens au Village et tu peux tenter d'espionner les échanges ou les actions des Loups pendant la nuit. Cette information peut aider le Village, mais l'espionnage est extrêmement dangereux : si les Loups te repèrent, tu peux devenir leur victime. Tu gagnes lorsque les Loups sont éliminés. 🔒 Ne dis jamais que tu espionnes et ne révèle pas publiquement comment tu as obtenu une information.`,
    night: false,
  },
  ancien: {
    name: 'Ancien', emoji: '🧓', team: 'village', maxCount: 1,
    description: `Ta sagesse te permet de résister à la première attaque des Loups-Garous. En revanche, si le Village t'élimine par erreur, le Village perd ses pouvoirs spéciaux selon les règles de la partie. Les attaques ou effets ultérieurs peuvent alors t'éliminer normalement. Tu gagnes avec le Village. 🔒 Garde ton identité secrète : annoncer que tu es l'Ancien peut pousser les Loups à te cibler.`,
    night: false,
  },
  capitaine: {
    name: 'Capitaine', emoji: '⚓', team: 'village', maxCount: 1,
    description: `Tu es un membre du Village dont la voix a une importance particulière lors des éliminations. Le titre de Capitaine peut être transmis à un joueur de ton choix lorsque tu meurs, selon les règles de la partie. Utilise ton influence pour orienter les débats sans devenir une cible évidente. Tu gagnes avec le Village. 🔒 Ne révèle pas ton rôle uniquement pour justifier le poids de ton vote.`,
    night: false,
  },
  salvateur: {
    name: 'Salvateur', emoji: '🛡️', team: 'village', maxCount: 1,
    description: `Chaque nuit, tu peux protéger un joueur vivant, y compris toi-même, contre l'attaque des Loups. La même personne ne peut pas être protégée deux nuits de suite. Tu ne connais pas forcément le résultat de ta protection : analyse les événements du lendemain pour déduire si elle a fonctionné. Tu gagnes avec le Village. 🔒 Ne révèle jamais qui tu protèges ni que tu es le Salvateur.`,
    night: true, nightAction: 'protect',
  },
  corbeau: {
    name: 'Corbeau', emoji: '🐦‍⬛', team: 'village', maxCount: 1,
    description: `Chaque nuit, tu peux désigner secrètement un joueur. Lors du vote du lendemain, cette cible reçoit deux votes supplémentaires, ce qui peut faire basculer l'élimination. Choisis une cible que tu penses dangereuse et vérifie les conséquences de ton choix avec les débats publics. Tu gagnes avec le Village. 🔒 Ne révèle jamais ta cible ni ton identité de Corbeau.`,
    night: true, nightAction: 'mark',
  },
  idiot_village: {
    name: 'Idiot du Village', emoji: '🃏', team: 'village', maxCount: 1,
    description: `Si le Village vote ton élimination, ton rôle est révélé et tu restes en vie, mais tu perds ton droit de vote pour la suite. Tu peux encore participer aux discussions et être éliminé par les Loups. Ton objectif reste d'aider le Village à trouver les Loups. 🔒 Tant que tu n'es pas révélé par un vote, ne dis pas que tu es l'Idiot pour éviter de devenir une cible.`,
    night: false,
  },
  ange: {
    name: 'Ange', emoji: '😇', team: 'solo', maxCount: 1,
    description: `Tu as un objectif solitaire : être éliminé par le tout premier vote du Village. Si le Village te désigne lors de ce vote, tu gagnes immédiatement seul. Si tu survis au premier vote, tu perds ton objectif et continues la partie comme un Villageois. 🔒 Ne révèle jamais que tu es l'Ange et ne rends pas ton comportement trop évident, sinon les joueurs pourraient comprendre ta stratégie.`,
    night: false,
  },
  servante: {
    name: 'Servante Dévouée', emoji: '🤝', team: 'village', maxCount: 1,
    description: `Lorsqu'un joueur possédant un rôle spécial est éliminé par le vote du Village, tu peux choisir secrètement d'endosser son rôle avant que son identité ne soit révélée, selon les règles de la partie. Tu changes alors de possibilités sans révéler immédiatement ton identité. Tu gagnes avec le camp que tu rejoins. 🔒 Ne révèle jamais que tu es la Servante ni le rôle que tu convoites.`,
    night: false,
  },
  // ── Loups ──────────────────────────────────────────────────────────────────
  loup_garou: {
    name: 'Loup-Garou', emoji: '🐺', team: 'wolves', maxCount: 10,
    description: `Chaque nuit, tu participes au choix de la victime des Loups-Garous. Coordonne-toi avec ton équipe sans te dévoiler, puis le jour, fais semblant d'être un Villageois et oriente les votes contre les bons suspects. Tu gagnes lorsque les Loups deviennent majoritaires ou que le Village ne peut plus les arrêter. 🔒 Ton rôle, l'identité de tes alliés et vos décisions nocturnes doivent rester secrets. Ne dis jamais que tu es un Loup-Garou.`,
    required: true,
    night: true, nightAction: 'devour',
  },
  grand_mechant_loup: {
    name: 'Grand Méchant Loup', emoji: '🐺💀', team: 'wolves', maxCount: 1,
    description: `Tu appartiens aux Loups et participes à leur attaque. Tant qu'aucun joueur possédant un rôle spécial n'a été dévoré, ton pouvoir peut permettre une attaque supplémentaire pendant la nuit. Ce pouvoir disparaît dès que la condition n'est plus remplie. Tu gagnes avec les Loups. 🔒 Ne révèle jamais ton statut de Grand Méchant Loup, ton pouvoir ou l'identité de tes alliés.`,
    night: true, nightAction: 'devour',
  },
  loup_blanc: {
    name: 'Loup Blanc', emoji: '🤍🐺', team: 'solo', maxCount: 1,
    description: `Tu es reconnu par les Loups comme un allié, mais tu poursuis un objectif solitaire. Tu participes aux attaques des Loups et, une nuit sur deux, tu peux tenter d'éliminer un Loup allié. Tu gagnes seul si tu deviens le dernier survivant ou si les conditions prévues par la partie sont remplies. 🔒 Ne révèle jamais que tu es le Loup Blanc : même tes alliés Loups doivent douter de tes intentions.`,
    night: true, nightAction: 'devour',
  },
  loup_infect: {
    name: 'Père des Loups', emoji: '🦠🐺', team: 'wolves', maxCount: 1,
    description: `Une seule fois dans la partie, tu peux remplacer l'attaque des Loups par une infection. La victime rejoint alors secrètement l'équipe des Loups au lieu de mourir et conserve son identité de rôle auprès des autres joueurs. Utilise ce pouvoir au moment où un nouvel allié peut changer l'issue de la partie. Tu gagnes avec les Loups. 🔒 Ne révèle jamais l'infection, la victime convertie ou ton rôle de Loup Infect.`,
    night: true, nightAction: 'devour',
  },
  // ── Neutres ────────────────────────────────────────────────────────────────
  joueur_flute: {
    name: 'Joueur de Flûte', emoji: '🪈', team: 'solo', maxCount: 1,
    description: `Tu n'appartiens ni au Village ni aux Loups. Chaque nuit, tu ensorcelles secrètement jusqu'à deux joueurs vivants. Les joueurs ensorcelés peuvent être informés de leur état, mais ils ne doivent pas connaître ton identité. Tu gagnes seul lorsque tous les survivants sont ensorcelés, selon les conditions de la partie. 🔒 Ne dis jamais que tu es le Joueur de Flûte et cache tes cibles derrière des votes et des arguments crédibles.`,
    night: true, nightAction: 'charm',
  },
  assassin: {
    name: 'Assassin', emoji: '🗡️', team: 'solo', maxCount: 1,
    description: `Tu possèdes un contrat composé de cibles à éliminer dans un ordre précis. Tu peux participer aux débats comme un Villageois, mais ton véritable objectif est de terminer ton contrat avant la fin de la partie. Tu gagnes seul si toutes tes cibles sont éliminées dans le bon ordre. 🔒 Ton contrat, tes cibles et ton rôle sont strictement secrets : ne laisse pas deviner que tes votes suivent une mission personnelle.`,
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

function ensureNightState(game) {
  game.night = game.night || {};
  game.night.wolfVotes = game.night.wolfVotes || {};
  game.night.wolfTarget = game.night.wolfTarget || null;
  game.night.witchSaved = game.night.witchSaved || false;
  game.night.witchKillTarget = game.night.witchKillTarget || null;
  game.night.whiteWolfTarget = game.night.whiteWolfTarget || null;
  game.night.infectTarget = game.night.infectTarget || null;
  game.night.cupidonFirstTarget = game.night.cupidonFirstTarget || null;
  game.night.fluteFirstTarget = game.night.fluteFirstTarget || null;
  game.night.witchResolved = game.night.witchResolved || false;
  game.night.actionRound = game.night.actionRound || 0;
  game.charmed = Array.isArray(game.charmed) ? game.charmed : [];
  game.pendingHunterIds = Array.isArray(game.pendingHunterIds) ? game.pendingHunterIds : [];
  return game.night;
}

function getAlivePlayers(game, { excludeId = null } = {}) {
  return game.assignments.filter(a => a.alive && a.userId !== excludeId);
}

function buildTargetRows(targets, customId, style = 'Secondary', emoji = '🎯') {
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
  const buttonStyle = ButtonStyle[style] || ButtonStyle.Secondary;
  const rows = [];
  let row = new ActionRowBuilder();
  targets.forEach((target, index) => {
    if (index > 0 && index % 5 === 0) {
      rows.push(row);
      row = new ActionRowBuilder();
    }
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${customId}${target.userId}`)
        .setLabel(target.displayName.slice(0, 80))
        .setStyle(buttonStyle)
        .setEmoji(emoji),
    );
  });
  if (row.components.length) rows.push(row);
  return rows.slice(0, 5);
}

async function sendPrivateTargetPrompt(client, userId, content, targets, customId, style = 'Secondary', emoji = '🎯') {
  const user = await client.users.fetch(userId);
  await user.send({
    content,
    components: buildTargetRows(targets, customId, style, emoji),
  });
}

function applyElimination(game, userId, by = 'wolves') {
  const eliminated = [];
  const eliminateOne = (targetId, reason) => {
    const target = game.assignments.find(a => a.userId === targetId && a.alive);
    if (!target) return;
    target.alive = false;
    const record = {
      userId: target.userId,
      displayName: target.displayName,
      roleId: target.roleId,
      round: game.round,
      by: reason,
      eliminatedAt: Date.now(),
    };
    game.eliminated.push(record);
    eliminated.push(target);
  };

  eliminateOne(userId, by);

  // Les amoureux meurent ensemble.
  if (game.lovers?.includes(userId)) {
    const partnerId = game.lovers.find(id => id !== userId);
    if (partnerId) eliminateOne(partnerId, 'lovers');
  }
  return eliminated;
}

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

function getEnabledRoleIds(roleConfig = {}) {
  let ids;
  if (Array.isArray(roleConfig)) {
    ids = roleConfig;
  } else if (Array.isArray(roleConfig.enabledRoles)) {
    ids = roleConfig.enabledRoles;
  } else {
    // Compatibilité avec l'ancien format { roleId: nombre }.
    ids = Object.entries(roleConfig)
      .filter(([, count]) => Number(count) > 0)
      .map(([roleId]) => roleId);
  }

  const enabled = new Set(ids.filter(roleId => ROLES[roleId]));
  Object.entries(ROLES)
    .filter(([, role]) => role.required)
    .forEach(([roleId]) => enabled.add(roleId));
  return [...enabled];
}

function buildAutomaticRoleConfig(playerCount, roleConfig = {}) {
  if (playerCount < 4) throw new Error('Il faut au moins 4 joueurs pour commencer');

  const enabled = new Set(getEnabledRoleIds(roleConfig));
  const hasWolfRole = ['loup_garou', 'grand_mechant_loup', 'loup_infect']
    .some(roleId => enabled.has(roleId));
  if (!hasWolfRole) throw new Error('Active au moins un rôle de Loup-Garou');

  const config = {};
  const add = (roleId, count = 1) => {
    if (count > 0) config[roleId] = (config[roleId] || 0) + count;
  };
  const total = () => Object.values(config).reduce((sum, count) => sum + count, 0);

  // Environ un tiers de Loups, avec toujours au moins un Loup.
  const wolfCount = Math.max(1, Math.floor(playerCount / 3));
  const specialWolf = ['grand_mechant_loup', 'loup_infect']
    .find(roleId => enabled.has(roleId) && wolfCount >= 2);
  if (specialWolf) add(specialWolf);
  add('loup_garou', wolfCount - (specialWolf ? 1 : 0));

  // Un seul rôle solitaire complexe par partie, uniquement quand la partie
  // laisse assez de place aux camps principaux.
  const soloRole = ['joueur_flute', 'loup_blanc', 'assassin', 'ange']
    .find(roleId => enabled.has(roleId));
  if (soloRole && playerCount >= 7) add(soloRole);

  // Les rôles spéciaux actifs sont ajoutés dans un ordre stable. On conserve
  // toujours une place pour au moins un Villageois simple.
  const villageRoles = [
    'voyante', 'sorciere', 'salvateur', 'cupidon', 'chasseur',
    'corbeau', 'ancien', 'capitaine', 'idiot_village', 'petite_fille', 'servante',
  ];
  for (const roleId of villageRoles) {
    if (!enabled.has(roleId) || total() >= playerCount - 1) continue;
    add(roleId);
  }

  add('villageois', Math.max(1, playerCount - total()));
  return config;
}

function buildActiveRoleEmbeds(roleConfig = {}, playerCount = 0) {
  const { EmbedBuilder } = require('discord.js');
  const enabledIds = getEnabledRoleIds(roleConfig);
  const activeRoles = enabledIds.map(roleId => ({ roleId, role: ROLES[roleId] }));
  const automaticConfig = playerCount >= 4
    ? buildAutomaticRoleConfig(playerCount, roleConfig)
    : null;
  const automaticLines = automaticConfig
    ? Object.entries(automaticConfig)
      .map(([roleId, count]) => `${ROLES[roleId]?.emoji || ''} **${ROLES[roleId]?.name || roleId}** ×${count}`)
      .join('\n')
    : 'Ajoute au moins 4 joueurs pour afficher une composition automatique.';

  const embeds = [];
  for (const [team, title, color] of [
    ['village', '🟢 Rôles du Village activés', 0x2ecc71],
    ['wolves', '🔴 Rôles des Loups activés', 0xe74c3c],
    ['solo', '🟣 Rôles solitaires activés', 0x9b59b6],
  ]) {
    const roles = activeRoles.filter(({ role }) => role.team === team);
    if (!roles.length) continue;
    const description = roles.map(({ role }) =>
      `### ${role.emoji} ${role.name}\n${role.description}`,
    ).join('\n\n');
    embeds.push(new EmbedBuilder()
      .setColor(color)
      .setTitle(title)
      .setDescription(description.slice(0, 4096)));
  }

  if (embeds.length) {
    const firstDescription = embeds[0].data.description || '';
    embeds[0].setDescription((
      `**Rôles susceptibles d’être utilisés pour cette partie.**\n` +
      `La composition s’adapte automatiquement au nombre de joueurs.\n\n` +
      `🔒 **Règle essentielle : les rôles, pouvoirs, informations obtenues et actions nocturnes sont secrets.** ` +
      `Ne révèle jamais ton rôle (par exemple, la Voyante ne doit pas dire qu’elle connaît le rôle d’un joueur) et ne divulgue pas les messages privés.\n\n` +
      `**Composition prévue pour ${playerCount || '—'} joueur(s) :**\n${automaticLines}\n\n` +
      firstDescription
    ).slice(0, 4096));
  }
  return embeds;
}

// ─────────────────────────────────────────────────────────────────────────────
// DÉMARRAGE DE LA PARTIE — TIRAGE AU SORT
// ─────────────────────────────────────────────────────────────────────────────
async function startGame(roleConfig) {
  const players = await getPlayers();
  const automaticConfig = buildAutomaticRoleConfig(players.length, roleConfig);

  // Construire le pool de rôles
  const pool = [];
  for (const [roleId, count] of Object.entries(automaticConfig)) {
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
    enabledRoles: getEnabledRoleIds(roleConfig),
    roleConfig:   automaticConfig,
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
    night:       null,      // Actions privées de la nuit en cours
    charmed:     [],        // Joueurs ensorcelés par le Joueur de Flûte
    pendingHunterIds: [],   // Chasseurs à qui envoyer le choix post-mortem
    assassinTarget: null,
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
  if (voter.canVote === false) return { ok: false, reason: 'Tu as perdu ton droit de vote' };
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
  let voteDeaths = [];
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
      eliminated.canVote = false;
      resultEmbed = new EmbedBuilder()
        .setColor(0xe67e22)
        .setTitle(`🃏 ${eliminated.displayName} était… l'Idiot du Village !`)
        .setDescription(
          `Avec **${sorted[0][1]} vote(s)**, ${eliminated.displayName} aurait dû être éliminé(e).\n\n` +
          `Mais c'est **l'Idiot du Village** ! Il/elle reste en vie mais perd son droit de vote.`
        ).setTimestamp();
    } else {
      // Élimination normale
      voteDeaths = applyElimination(game, eliminated.userId, 'vote');
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
  if (voteDeaths.length) {
    const hunterIds = voteDeaths
      .filter(death => death.roleId === 'chasseur')
      .map(death => death.userId);
    if (hunterIds.length) {
      game.pendingHunterIds = [...new Set([...(game.pendingHunterIds || []), ...hunterIds])];
      await saveGame(game);
      await sendPendingDeathActionDMs(client, game);
    }
  }
  return { eliminated, tally, victory: victoryCheck };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONDITION DE VICTOIRE
// ─────────────────────────────────────────────────────────────────────────────
function checkVictory(game) {
  const alive       = game.assignments.filter(a => a.alive);
  const aliveWolves = alive.filter(a => ROLES[a.roleId]?.team === 'wolves');
  const aliveVillagers = alive.filter(a => ROLES[a.roleId]?.team === 'village');
  const flute = alive.find(a => a.roleId === 'joueur_flute');

  if (flute && alive.filter(a => a.userId !== flute.userId).every(a => game.charmed?.includes(a.userId))) return 'flute';
  if (aliveWolves.length === 0) return 'village';
  if (aliveWolves.length >= aliveVillagers.length) return 'wolves';
  return null;
}

function buildVictoryEmbed(game, winner) {
  const { EmbedBuilder } = require('discord.js');
  const isVillage = winner === 'village';
  const isFlute = winner === 'flute';
  const embed = new EmbedBuilder()
    .setColor(isVillage ? 0x2ecc71 : isFlute ? 0x9b59b6 : 0xe74c3c)
    .setTitle(isVillage ? '🎉 VICTOIRE DU VILLAGE !' : isFlute ? '🪈 VICTOIRE DU JOUEUR DE FLÛTE !' : '🐺 VICTOIRE DES LOUPS-GAROUS !')
    .setDescription(
      isVillage
        ? 'Tous les Loups-Garous ont été éliminés ! Le village peut dormir en paix. 🌅'
        : isFlute
          ? 'Tous les survivants ont été ensorcelés. Le Joueur de Flûte gagne seul !'
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
// ACTIONS NOCTURNES PRIVÉES
// ─────────────────────────────────────────────────────────────────────────────
async function sendWitchActionDM(client, game = null) {
  game = game || await getGame();
  if (!game) return false;
  const night = ensureNightState(game);
  const witch = game.assignments.find(a => a.alive && a.roleId === 'sorciere');
  if (!witch || night.witchResolved || !night.wolfTarget) return false;

  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
  const rows = [];
  const controls = new ActionRowBuilder();
  if (game.sorciere?.lifePotion) {
    controls.addComponents(
      new ButtonBuilder()
        .setCustomId('ww_witch_save')
        .setLabel('🧪 Sauver la victime')
        .setStyle(ButtonStyle.Success),
    );
  }
  controls.addComponents(
    new ButtonBuilder()
      .setCustomId('ww_witch_skip')
      .setLabel('⏭️ Ne rien utiliser')
      .setStyle(ButtonStyle.Secondary),
  );
  rows.push(controls);
  if (game.sorciere?.deathPotion) {
    rows.push(...buildTargetRows(
      getAlivePlayers(game, { excludeId: witch.userId }),
      'ww_witch_kill_',
      'Danger',
      '☠️',
    ).slice(0, 4));
  }

  const user = await client.users.fetch(witch.userId);
  await user.send({
    content:
      `🧪 **Nuit ${game.round} — Sorcière**\n\n` +
      `Les Loups-Garous ont ciblé **${game.assignments.find(a => a.userId === night.wolfTarget)?.displayName || 'un joueur'}**.\n` +
      `${game.sorciere?.lifePotion ? 'Tu peux utiliser ta potion de vie. ' : ''}` +
      `${game.sorciere?.deathPotion ? 'Tu peux aussi choisir une victime pour ta potion de mort.' : ''}`,
    components: rows,
  });
  night.witchPrompted = true;
  await saveGame(game);
  return true;
}

async function sendPendingDeathActionDMs(client, game = null) {
  game = game || await getGame();
  if (!game) return;
  const pending = game.pendingHunterIds || [];
  const hunterTargets = getAlivePlayers(game);
  for (const hunterId of pending) {
    const hunter = game.assignments.find(a => a.userId === hunterId);
    if (!hunter || hunter.hunterPrompted || !hunterTargets.length) continue;
    try {
      await sendPrivateTargetPrompt(
        client,
        hunterId,
        '🏹 **Ton dernier pouvoir, Chasseur**\n\nTu as été éliminé. Choisis immédiatement un joueur à abattre.',
        hunterTargets,
        'ww_hunter_',
        'Danger',
        '🏹',
      );
      hunter.hunterPrompted = true;
    } catch (e) {
      console.error(`[Werewolf] hunter DM error for ${hunter.displayName}:`, e.message);
    }
  }
  await saveGame(game);
}

async function sendNightActionDMs(client) {
  const game = await getGame();
  if (!game) return;
  const night = ensureNightState(game);
  if (night.actionRound !== game.round) {
    game.night = {
      actionRound: game.round,
      wolfVotes: {},
      wolfTarget: null,
      witchSaved: false,
      witchKillTarget: null,
      whiteWolfTarget: null,
      infectTarget: null,
      cupidonFirstTarget: null,
      fluteFirstTarget: null,
      witchResolved: false,
      witchPrompted: false,
    };
    game.savedTonight = null;
    await saveGame(game);
  }

  const alive = game.assignments.filter(a => a.alive);
  for (const a of alive) {
    try {
      const targets = getAlivePlayers(game, { excludeId: a.userId });

      if (['loup_garou', 'grand_mechant_loup', 'loup_infect'].includes(a.roleId)) {
        const wolfTargets = targets.filter(p => ROLES[p.roleId]?.team !== 'wolves');
        await sendPrivateTargetPrompt(
          client,
          a.userId,
          `🐺 **Nuit ${game.round} — Repaire des Loups**\n\nChoisis la victime à proposer aux autres Loups-Garous. La cible retenue sera décidée parmi leurs choix.`,
          wolfTargets,
          'ww_devour_',
          'Danger',
          '🐺',
        );
        if (a.roleId === 'loup_infect' && game.infectionAvailable !== false) {
          await sendPrivateTargetPrompt(
            client,
            a.userId,
            '🦠 **Père des Loups — pouvoir d’infection**\n\nChoisis une cible à convertir au lieu de la dévorer.',
            wolfTargets,
            'ww_infect_',
            'Primary',
            '🦠',
          );
        }
        continue;
      }

      if (a.roleId === 'loup_blanc' && game.round % 2 === 0) {
        const wolfTargets = targets.filter(p => ROLES[p.roleId]?.team === 'wolves');
        await sendPrivateTargetPrompt(
          client,
          a.userId,
          `🤍🐺 **Nuit ${game.round} — pouvoir du Loup Blanc**\n\nChoisis un Loup-Garou à éliminer secrètement.`,
          wolfTargets,
          'ww_white_',
          'Danger',
          '🤍',
        );
        continue;
      }

      if (a.roleId === 'voyante') {
        await sendPrivateTargetPrompt(client, a.userId, `🔮 **Nuit ${game.round} — Voyante**\n\nChoisis le joueur dont tu veux connaître le rôle.`, targets, 'ww_see_', 'Primary', '🔮');
      } else if (a.roleId === 'salvateur') {
        await sendPrivateTargetPrompt(client, a.userId, `🛡️ **Nuit ${game.round} — Salvateur**\n\nChoisis le joueur à protéger cette nuit.`, alive, 'ww_protect_', 'Success', '🛡️');
      } else if (a.roleId === 'corbeau') {
        await sendPrivateTargetPrompt(client, a.userId, `🐦‍⬛ **Nuit ${game.round} — Corbeau**\n\nChoisis le joueur qui recevra 2 votes supplémentaires demain.`, targets, 'ww_mark_', 'Danger', '🐦‍⬛');
      } else if (a.roleId === 'cupidon' && game.round === 1 && !game.lovers?.length) {
        await sendPrivateTargetPrompt(client, a.userId, '💘 **Première nuit — Cupidon**\n\nChoisis le premier joueur à unir par les liens de l’amour.', targets, 'ww_link1_', 'Primary', '💘');
      } else if (a.roleId === 'joueur_flute') {
        await sendPrivateTargetPrompt(client, a.userId, `🪈 **Nuit ${game.round} — Joueur de Flûte**\n\nChoisis le premier joueur à ensorceler.`, targets, 'ww_charm1_', 'Primary', '🪈');
      } else if (a.roleId === 'assassin') {
        await sendPrivateTargetPrompt(client, a.userId, `🗡️ **Nuit ${game.round} — Assassin**\n\nChoisis ta cible secrète.`, targets, 'ww_assassin_', 'Danger', '🗡️');
      }
    } catch (e) {
      console.error(`[Werewolf] nightAction DM error for ${a.displayName}:`, e.message);
    }
  }

  const nightAfterPrompts = await getGame();
  if (nightAfterPrompts) await sendWitchActionDM(client, nightAfterPrompts);
}

async function handleNightAction(client, action, actorId, targetId) {
  const game = await getGame();
  if (!game) return { ok: false, reason: 'Aucune partie en cours' };
  const night = ensureNightState(game);

  // Le Chasseur agit après sa mort : il n'est donc plus vivant.
  if (action === 'hunter') {
    if (!game.pendingHunterIds?.includes(actorId)) return { ok: false, reason: 'Aucun pouvoir de Chasseur en attente' };
    const target = game.assignments.find(a => a.userId === targetId && a.alive);
    if (!target) return { ok: false, reason: 'Cible invalide ou déjà éliminée' };
    const deaths = applyElimination(game, targetId, 'hunter');
    game.pendingHunterIds = game.pendingHunterIds.filter(id => id !== actorId);
    await saveGame(game);
    await client.users.fetch(actorId).then(user =>
      user.send(`🏹 **Ton tir est parti.** Tu as éliminé **${target.displayName}**.`).catch(() => {}),
    );
    const publicChannelId = game.voteChannelId || game.wolfChannelId;
    if (publicChannelId) {
      try {
        const publicChannel = await client.channels.fetch(publicChannelId);
        const deathLines = deaths.map(death => {
          const role = ROLES[death.roleId];
          return `☠️ **${death.displayName}** — ${role?.emoji || ''} **${role?.name || 'rôle inconnu'}** (${TEAM_LABELS[role?.team] || role?.team || 'inconnu'})`;
        }).join('\n');
        await publicChannel.send(`🏹 **Le Chasseur a tiré avant de mourir.**\n${deathLines}\n\nLes rôles sont révélés après une élimination ; les rôles des survivants restent secrets.`);
      } catch {}
    }
    return { ok: true, deaths: deaths.map(d => d.userId) };
  }

  const actor = game.assignments.find(a => a.userId === actorId && a.alive);
  const target = targetId ? game.assignments.find(a => a.userId === targetId && a.alive) : null;
  if (!actor) return { ok: false, reason: 'Tu ne peux plus utiliser ce pouvoir' };

  if (action === 'see') {
    if (actor.roleId !== 'voyante' || !target) return { ok: false, reason: 'Action invalide' };
    const role = ROLES[target.roleId];
    await client.users.fetch(actorId).then(user =>
      user.send(`🔮 **Résultat de ta vision :** ${target.displayName} est… **${role?.emoji} ${role?.name}** (${TEAM_LABELS[role?.team] || role?.team})`).catch(() => {}),
    );
    return { ok: true };
  }

  if (action === 'protect') {
    if (actor.roleId !== 'salvateur' || !target) return { ok: false, reason: 'Action invalide' };
    game.savedTonight = targetId;
    await saveGame(game);
    await client.users.fetch(actorId).then(user =>
      user.send(`🛡️ Tu protèges **${target.displayName}** cette nuit.`).catch(() => {}),
    );
    return { ok: true };
  }

  if (action === 'mark') {
    if (actor.roleId !== 'corbeau' || !target) return { ok: false, reason: 'Action invalide' };
    game.extraVotes = game.extraVotes || {};
    game.extraVotes[targetId] = (game.extraVotes[targetId] || 0) + 2;
    await saveGame(game);
    await client.users.fetch(actorId).then(user =>
      user.send(`🐦‍⬛ **${target.displayName}** recevra 2 votes supplémentaires lors du prochain vote.`).catch(() => {}),
    );
    return { ok: true };
  }

  if (action === 'devour' || action === 'infect') {
    if (!['loup_garou', 'grand_mechant_loup', 'loup_infect'].includes(actor.roleId) || !target) {
      return { ok: false, reason: 'Action invalide' };
    }
    if (ROLES[target.roleId]?.team === 'wolves') return { ok: false, reason: 'Les Loups ne peuvent pas cibler un allié' };
    night.wolfVotes[actorId] = targetId;
    if (action === 'infect') {
      if (actor.roleId !== 'loup_infect' || game.infectionAvailable === false) {
        return { ok: false, reason: 'Pouvoir d’infection déjà utilisé' };
      }
      night.infectTarget = targetId;
    }
    const livingWolves = game.assignments.filter(a => a.alive && ROLES[a.roleId]?.team === 'wolves');
    const allVoted = livingWolves.every(wolf => night.wolfVotes[wolf.userId]);
    if (allVoted) {
      const tally = {};
      Object.values(night.wolfVotes).forEach(id => { tally[id] = (tally[id] || 0) + 1; });
      night.wolfTarget = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0] || targetId;
    }
    await saveGame(game);
    if (night.wolfTarget) await sendWitchActionDM(client, game);
    await client.users.fetch(actorId).then(user =>
      user.send(`🐺 Choix enregistré pour **${target.displayName}**.`).catch(() => {}),
    );
    return { ok: true, pending: !night.wolfTarget };
  }

  if (action === 'white') {
    if (actor.roleId !== 'loup_blanc' || game.round % 2 !== 0 || !target || ROLES[target.roleId]?.team !== 'wolves') {
      return { ok: false, reason: 'Action du Loup Blanc invalide cette nuit' };
    }
    night.whiteWolfTarget = targetId;
    await saveGame(game);
    await client.users.fetch(actorId).then(user =>
      user.send(`🤍🐺 **${target.displayName}** a été désigné secrètement.`).catch(() => {}),
    );
    return { ok: true };
  }

  if (action === 'witch_save' || action === 'witch_skip' || action === 'witch_kill') {
    if (actor.roleId !== 'sorciere' || night.witchResolved) return { ok: false, reason: 'Action de Sorcière invalide' };
    if (action === 'witch_save') {
      if (!game.sorciere?.lifePotion || !night.wolfTarget) return { ok: false, reason: 'Potion de vie indisponible' };
      game.sorciere.lifePotion = false;
      night.witchSaved = true;
    } else if (action === 'witch_kill') {
      if (!game.sorciere?.deathPotion || !target) return { ok: false, reason: 'Potion de mort indisponible' };
      game.sorciere.deathPotion = false;
      night.witchKillTarget = targetId;
    }
    night.witchResolved = true;
    await saveGame(game);
    const message = action === 'witch_save'
      ? '🧪 Tu as sauvé la victime des Loups.'
      : action === 'witch_kill'
        ? `☠️ Tu as désigné **${target.displayName}** avec ta potion de mort.`
        : '⏭️ Tu n’utilises aucune potion cette nuit.';
    await client.users.fetch(actorId).then(user => user.send(message).catch(() => {}));
    return { ok: true };
  }

  if (action === 'link1') {
    if (actor.roleId !== 'cupidon' || game.round !== 1 || !target) return { ok: false, reason: 'Action de Cupidon invalide' };
    night.cupidonFirstTarget = targetId;
    await saveGame(game);
    await sendPrivateTargetPrompt(
      client,
      actorId,
      `💘 **${target.displayName}** est le premier amoureux. Choisis maintenant le second.`,
      getAlivePlayers(game, { excludeId: targetId }),
      'ww_link2_',
      'Primary',
      '💘',
    );
    return { ok: true };
  }

  if (action === 'link2') {
    if (actor.roleId !== 'cupidon' || game.round !== 1 || !target || !night.cupidonFirstTarget || targetId === night.cupidonFirstTarget) {
      return { ok: false, reason: 'Second choix de Cupidon invalide' };
    }
    game.lovers = [night.cupidonFirstTarget, targetId];
    await saveGame(game);
    await client.users.fetch(actorId).then(user =>
      user.send('💘 Les deux joueurs sont maintenant liés par les liens de l’amour.').catch(() => {}),
    );
    return { ok: true };
  }

  if (action === 'charm1') {
    if (actor.roleId !== 'joueur_flute' || !target || game.charmed.includes(targetId)) {
      return { ok: false, reason: 'Cible invalide ou déjà ensorcelée' };
    }
    night.fluteFirstTarget = targetId;
    await saveGame(game);
    await sendPrivateTargetPrompt(
      client,
      actorId,
      `🪈 **${target.displayName}** est le premier joueur ensorcelé. Choisis le second.`,
      getAlivePlayers(game, { excludeId: targetId }).filter(p => !game.charmed.includes(p.userId)),
      'ww_charm2_',
      'Primary',
      '🪄',
    );
    return { ok: true };
  }

  if (action === 'charm2') {
    if (actor.roleId !== 'joueur_flute' || !target || !night.fluteFirstTarget || targetId === night.fluteFirstTarget || game.charmed.includes(targetId)) {
      return { ok: false, reason: 'Second choix du Joueur de Flûte invalide' };
    }
    game.charmed.push(night.fluteFirstTarget, targetId);
    await saveGame(game);
    await client.users.fetch(actorId).then(user =>
      user.send(`🪈 **${target.displayName}** et ton autre cible sont maintenant ensorcelés.`).catch(() => {}),
    );
    return { ok: true };
  }

  if (action === 'assassin') {
    if (actor.roleId !== 'assassin' || !target) return { ok: false, reason: 'Action de l’Assassin invalide' };
    game.assassinTarget = targetId;
    await saveGame(game);
    await client.users.fetch(actorId).then(user =>
      user.send(`🗡️ **${target.displayName}** est maintenant ta cible secrète.`).catch(() => {}),
    );
    return { ok: true };
  }

  return { ok: false, reason: 'Action inconnue' };
}

async function resolveNight(client, channelId = null) {
  const game = await getGame();
  if (!game || game.phase !== 'NIGHT') return { ok: false, reason: 'La partie n’est pas en phase nuit' };
  const night = ensureNightState(game);
  const deaths = [];

  if (night.infectTarget && game.infectionAvailable !== false) {
    const infected = game.assignments.find(a => a.userId === night.infectTarget && a.alive);
    if (infected && ROLES[infected.roleId]?.team !== 'wolves') {
      infected.roleId = 'loup_garou';
      game.infectionAvailable = false;
      night.wolfTarget = null;
    }
  }

  if (night.wolfTarget && !night.infectTarget) {
    const victim = game.assignments.find(a => a.userId === night.wolfTarget && a.alive);
    if (victim && victim.userId !== game.savedTonight && !night.witchSaved) {
      if (victim.roleId === 'ancien' && !game.ancienShieldUsed) {
        game.ancienShieldUsed = true;
      } else {
        deaths.push(...applyElimination(game, victim.userId, 'wolves'));
      }
    }
  }

  if (night.witchKillTarget) {
    deaths.push(...applyElimination(game, night.witchKillTarget, 'witch'));
  }
  if (night.whiteWolfTarget) {
    deaths.push(...applyElimination(game, night.whiteWolfTarget, 'white_wolf'));
  }

  const victory = checkVictory(game);
  if (victory) {
    game.phase = 'ENDED';
    game.winner = victory;
  } else {
    game.phase = 'DAY';
  }
  await saveGame(game);

  if (client && deaths.length) {
    const channel = channelId || game.voteChannelId || game.wolfChannelId;
    if (channel) {
      try {
        const discordChannel = await client.channels.fetch(channel);
        const deathLines = deaths.map(d => {
          const role = ROLES[d.roleId];
          const roleLabel = role
            ? `${role.emoji} **${role.name}** (${TEAM_LABELS[role.team] || role.team})`
            : 'rôle inconnu';
          return `☠️ **${d.displayName}** — ${roleLabel}`;
        }).join('\n');
        await discordChannel.send(
          `🌅 **Le jour se lève.**\n${deathLines}\n\n` +
          `Les rôles sont révélés après une élimination ; les rôles et pouvoirs des joueurs encore vivants restent secrets.`,
        );
      } catch {}
    }
  }
  if (deaths.some(a => a.roleId === 'chasseur')) {
    game.pendingHunterIds = [...new Set([
      ...(game.pendingHunterIds || []),
      ...deaths.filter(a => a.roleId === 'chasseur').map(a => a.userId),
    ])];
    await saveGame(game);
    if (client) await sendPendingDeathActionDMs(client, game);
  }
  return { ok: true, deaths, victory };
}

// ─────────────────────────────────────────────────────────────────────────────
// ÉLIMINATION MANUELLE (nuit / capacité spéciale)
// ─────────────────────────────────────────────────────────────────────────────
async function eliminatePlayer(userId, by = 'wolves') {
  const game = await getGame();
  if (!game) throw new Error('Aucune partie en cours');
  const a = game.assignments.find(x => x.userId === userId && x.alive);
  if (!a) throw new Error('Joueur introuvable ou déjà éliminé');
  const deaths = applyElimination(game, userId, by);
  const victory = checkVictory(game);
  if (victory) { game.phase = 'ENDED'; game.winner = victory; }
  if (deaths.some(death => death.roleId === 'chasseur')) {
    game.pendingHunterIds = [...new Set([
      ...(game.pendingHunterIds || []),
      ...deaths.filter(death => death.roleId === 'chasseur').map(death => death.userId),
    ])];
  }
  await saveGame(game);
  return { eliminated: a, deaths, victory };
}

module.exports = {
  ROLES, TEAM_LABELS,
  getPlayers, savePlayers, addPlayer, removePlayer,
  getGame, saveGame,
  getEnabledRoleIds, buildAutomaticRoleConfig, buildActiveRoleEmbeds,
  startGame, sendRoleDMs, handleAck,
  createWolfThread,
  createVotePoll, handleVote, updateVoteMessage, resolveVote,
   sendNightActionDMs, handleNightAction, resolveNight,
  eliminatePlayer,
  checkVictory, buildVictoryEmbed,
};
