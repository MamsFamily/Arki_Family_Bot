'use strict';

/**
 * blindTestManager.js — Système de Blind Test musical pour Discord
 *
 * Flux d'une partie :
 *  1. /blindtest lance une série de 15 chansons piochées aléatoirement
 *  2. Pour chaque manche, le bot récupère un extrait 30s via l'API Deezer
 *  3. Les joueurs tapent le titre / l'artiste dans le salon pendant 20s
 *  4. Scoring : titre = 1 pt, artiste = 1 pt, les deux en premier = +1 bonus
 *  5. Révélation + classement partiel → pause 8s → manche suivante
 *  6. Fin de partie : podium final + mise à jour du classement persistant
 */

const axios        = require('axios');
const { EmbedBuilder } = require('discord.js');
const pgStore      = require('./pgStore');

const library = require('./blindTestLibrary.json');

// ══════════════════════════════════════════════════════════════════════════════
// CONSTANTES
// ══════════════════════════════════════════════════════════════════════════════

const ROUND_COUNT    = 15;     // nombre de manches par partie
const ROUND_DURATION = 20000;  // ms de fenêtre de réponse
const PAUSE_BETWEEN  = 8000;   // ms entre la révélation et la manche suivante
const LEADERBOARD_KEY = (guildId) => `blindtest_leaderboard_${guildId}`;

const MEDALS = ['🥇', '🥈', '🥉'];

// ── État des parties en cours (une par serveur) ───────────────────────────────
const activeGames = new Map(); // guildId → gameState

// ══════════════════════════════════════════════════════════════════════════════
// NORMALISATION & MATCHING
// ══════════════════════════════════════════════════════════════════════════════

function normalize(str) {
  return String(str)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // suppr. accents
    .replace(/[^a-z0-9 ]/g, ' ')                      // ponctuation → espace
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return a;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Vérifie si `answer` contient (ou ressemble à) `target`.
 * Accepte les alias, l'inclusion partielle et la tolérance aux fautes (~2 char).
 */
function isMatch(answer, target, aliases = []) {
  const normAns = normalize(answer);
  const targets = [normalize(target), ...aliases.map(normalize)].filter(Boolean);

  for (const t of targets) {
    if (!t) continue;
    // Inclusion directe (cas le plus courant)
    if (normAns.includes(t)) return true;
    // La cible est dans la réponse
    if (t.includes(normAns) && normAns.length >= 4) return true;
    // Comparaison Levenshtein (tolérance ~20% des caractères, min 2)
    const tolerance = Math.max(2, Math.floor(t.length * 0.20));
    if (levenshtein(normAns, t) <= tolerance) return true;
    // Comparaison mot-à-mot (chaque mot important de la cible présent dans la réponse)
    const keyWords = t.split(' ').filter(w => w.length > 2);
    if (keyWords.length >= 1 && keyWords.every(w =>
      normAns.includes(w) || normAns.split(' ').some(aw => levenshtein(aw, w) <= 1)
    )) return true;
  }
  return false;
}

/**
 * Analyse un message et retourne ce que le joueur a trouvé pour la manche courante.
 */
function checkAnswer(messageContent, song) {
  return {
    titleFound:  isMatch(messageContent, song.title,  song.titleAliases  || []),
    artistFound: isMatch(messageContent, song.artist, song.artistAliases || []),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// API DEEZER — extrait 30s
// ══════════════════════════════════════════════════════════════════════════════

async function getDeezerPreview(song) {
  const query = `${song.title} ${song.artist}`;
  const url   = `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=10`;
  const res   = await axios.get(url, { timeout: 8000 });
  const tracks = (res.data?.data || []).filter(t => t.preview);
  if (!tracks.length) throw new Error('Aucun extrait disponible');
  // Préférer le track dont le titre/artiste coïncide le mieux
  const best = tracks.find(t =>
    normalize(t.title).includes(normalize(song.title)) ||
    normalize(t.artist?.name || '').includes(normalize(song.artist))
  ) || tracks[0];
  return best.preview; // URL directe mp3 30s
}

// ══════════════════════════════════════════════════════════════════════════════
// PERSISTANCE DU CLASSEMENT
// ══════════════════════════════════════════════════════════════════════════════

async function loadLeaderboard(guildId) {
  try {
    const raw = await pgStore.getData(LEADERBOARD_KEY(guildId));
    return raw || {};
  } catch { return {}; }
}

async function saveLeaderboard(guildId, board) {
  try { await pgStore.setData(LEADERBOARD_KEY(guildId), board); } catch {}
}

async function addScores(guildId, scoreMap) {
  // scoreMap : Map(userId → { username, points })
  const board = await loadLeaderboard(guildId);
  for (const [uid, { username, points }] of scoreMap) {
    if (!points) continue;
    if (!board[uid]) board[uid] = { username, total: 0 };
    board[uid].total    += points;
    board[uid].username  = username; // mise à jour pseudo
  }
  await saveLeaderboard(guildId, board);
}

// ══════════════════════════════════════════════════════════════════════════════
// LOGIQUE DE JEU
// ══════════════════════════════════════════════════════════════════════════════

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Crée et démarre une nouvelle partie dans le salon donné.
 */
async function startGame(interaction) {
  const guildId   = interaction.guildId;
  const channelId = interaction.channelId;

  if (activeGames.has(guildId)) {
    return interaction.reply({
      content: '❌ Une partie de Blind Test est déjà en cours sur ce serveur !',
      ephemeral: true,
    });
  }

  const songs = shuffle(library.songs).slice(0, ROUND_COUNT);

  const game = {
    guildId,
    channelId,
    songs,
    currentRound: 0,
    scores:      new Map(), // userId → { username, points }
    roundAnswers: new Map(), // userId → { titleFound, artistFound }
    firstFullId:  null,     // premier userId à trouver titre+artiste
    timer:        null,
    isRunning:    true,
  };

  activeGames.set(guildId, game);

  const startEmbed = new EmbedBuilder()
    .setColor(0xE91E63)
    .setTitle('🎵 Blind Test — C\'est parti !')
    .setDescription(
      `**${ROUND_COUNT} manches** — ${ROUND_DURATION / 1000} secondes par extrait\n\n` +
      '📝 **Comment jouer ?**\n' +
      '→ Tapez le **titre** et/ou le **nom de l\'artiste** dans ce salon.\n' +
      '→ **Titre trouvé = 1 pt** • **Artiste trouvé = 1 pt**\n' +
      '→ Premier à trouver les deux : **+1 pt bonus** ⚡\n\n' +
      '*Bonne chance à tous !*'
    )
    .setFooter({ text: 'Première manche dans 5 secondes…' });

  await interaction.reply({ embeds: [startEmbed] });

  setTimeout(() => runRound(game, interaction.channel), 5000);
}

/**
 * Lance la manche courante.
 */
async function runRound(game, channel) {
  if (!game.isRunning || game.currentRound >= game.songs.length) {
    return endGame(game, channel);
  }

  const song = game.songs[game.currentRound];
  game.currentRound++;
  game.roundAnswers = new Map();
  game.firstFullId  = null;

  // ── Récupération de l'extrait Deezer ──────────────────────────────────────
  let previewUrl = null;
  try { previewUrl = await getDeezerPreview(song); } catch {}

  // ── Embed de la manche ────────────────────────────────────────────────────
  const roundEmbed = new EmbedBuilder()
    .setColor(0x9B59B6)
    .setTitle(`🎵 Manche ${game.currentRound} / ${game.songs.length}`)
    .setDescription(
      '**Quelle est cette chanson ?**\n\n' +
      `⏱️ Vous avez **${ROUND_DURATION / 1000} secondes** pour répondre.\n` +
      '-# Écrivez le titre et/ou le nom de l\'artiste dans le chat.'
    )
    .setFooter({ text: `Question ${game.currentRound} sur ${game.songs.length}` });

  await channel.send({ embeds: [roundEmbed] });

  if (previewUrl) {
    await channel.send(previewUrl);
  } else {
    await channel.send('⚠️ *Extrait audio indisponible pour ce titre — tentez votre chance !*');
  }

  // ── Timer de révélation ───────────────────────────────────────────────────
  game.timer = setTimeout(async () => {
    await revealRound(game, channel, song);
  }, ROUND_DURATION);
}

/**
 * Révèle la réponse et affiche les résultats de la manche.
 */
async function revealRound(game, channel, song) {
  if (game.timer) { clearTimeout(game.timer); game.timer = null; }

  // ── Calcul des scores de la manche ───────────────────────────────────────
  const lines = [];
  let anyoneAnswered = false;

  for (const [userId, ans] of game.roundAnswers) {
    const entry = game.scores.get(userId) || { points: 0, username: ans.username };
    let pts = 0;
    if (ans.titleFound)  pts += 1;
    if (ans.artistFound) pts += 1;
    if (userId === game.firstFullId) pts += 1; // bonus vitesse
    entry.points += pts;
    entry.username = ans.username;
    game.scores.set(userId, entry);

    const icon    = (ans.titleFound && ans.artistFound) ? '🟢' : (pts > 0 ? '🟡' : '🔴');
    const badges  = [
      ans.titleFound  ? '✅ Titre'   : '❌ Titre',
      ans.artistFound ? '✅ Artiste' : '❌ Artiste',
    ].join(' • ');
    const bonus   = userId === game.firstFullId ? ' ⚡ +1 bonus' : '';
    lines.push(`${icon} **${ans.username}** — ${badges} **(+${pts}${bonus})**`);
    anyoneAnswered = true;
  }

  if (!anyoneAnswered) lines.push('*Personne n\'a répondu…*');

  // ── Classement intermédiaire (top 5) ─────────────────────────────────────
  const sorted = [...game.scores.entries()]
    .sort((a, b) => b[1].points - a[1].points)
    .slice(0, 5);
  const scoreBoard = sorted.map(([ , v], i) =>
    `${MEDALS[i] || `${i + 1}.`} **${v.username}** — ${v.points} pt${v.points > 1 ? 's' : ''}`
  ).join('\n');

  const revealEmbed = new EmbedBuilder()
    .setColor(0x2ECC71)
    .setTitle(`✅ Réponse — Manche ${game.currentRound}`)
    .addFields(
      { name: '🎵 C\'était…', value: `**${song.title}** — *${song.artist}*`, inline: false },
      { name: '📊 Résultats de la manche', value: lines.join('\n') || '—', inline: false },
      { name: '🏅 Classement provisoire', value: scoreBoard || '—', inline: false },
    )
    .setFooter({ text: game.currentRound < game.songs.length ? `Prochaine manche dans ${PAUSE_BETWEEN / 1000}s…` : 'Fin de partie dans quelques secondes…' });

  await channel.send({ embeds: [revealEmbed] });

  // ── Manche suivante ou fin ────────────────────────────────────────────────
  if (game.currentRound < game.songs.length) {
    game.timer = setTimeout(() => runRound(game, channel), PAUSE_BETWEEN);
  } else {
    game.timer = setTimeout(() => endGame(game, channel), PAUSE_BETWEEN);
  }
}

/**
 * Termine la partie et affiche le podium final.
 */
async function endGame(game, channel) {
  if (game.timer) { clearTimeout(game.timer); game.timer = null; }
  game.isRunning = false;
  activeGames.delete(game.guildId);

  const sorted = [...game.scores.entries()]
    .sort((a, b) => b[1].points - a[1].points);

  let podium = '';
  sorted.forEach(([, v], i) => {
    const medal = MEDALS[i] || `${i + 1}.`;
    podium += `${medal} **${v.username}** — **${v.points} pt${v.points > 1 ? 's' : ''}**\n`;
  });

  const finalEmbed = new EmbedBuilder()
    .setColor(0xF1C40F)
    .setTitle('🎤 Blind Test terminé ! Voici le podium final')
    .setDescription(podium || '*Aucun joueur n\'a marqué de points.*')
    .setFooter({ text: `${ROUND_COUNT} manches — Merci d'avoir joué !` })
    .setTimestamp();

  await channel.send({ embeds: [finalEmbed] });

  // ── Mise à jour du classement persistant ─────────────────────────────────
  if (game.scores.size) await addScores(game.guildId, game.scores);
}

/**
 * Traite un message d'un joueur pendant une partie active.
 * Appelé depuis le handler messageCreate de index.js.
 * Retourne true si le message a été consommé par le blind test.
 */
function handleMessage(message) {
  const game = activeGames.get(message.guildId);
  if (!game || !game.isRunning) return false;
  if (message.channelId !== game.channelId) return false;
  if (message.author.bot) return false;
  if (!game.timer) return false; // entre deux manches

  const userId   = message.author.id;
  const username = message.author.displayName || message.author.username;
  const song     = game.songs[game.currentRound - 1];
  if (!song) return false;

  // Récupérer ou créer l'entrée du joueur pour ce round
  const prev = game.roundAnswers.get(userId) || {
    username,
    titleFound:  false,
    artistFound: false,
  };

  const { titleFound, artistFound } = checkAnswer(message.content, song);

  // Cumuler les nouvelles trouvailles (on garde les précédentes)
  const updated = {
    username,
    titleFound:  prev.titleFound  || titleFound,
    artistFound: prev.artistFound || artistFound,
  };

  game.roundAnswers.set(userId, updated);

  // Bonus : premier à trouver titre + artiste
  if (updated.titleFound && updated.artistFound && !game.firstFullId) {
    game.firstFullId = userId;
  }

  // Réaction discrète pour confirmer qu'une réponse (même partielle) a été prise en compte
  if (titleFound || artistFound) {
    message.react('✅').catch(() => {});
  }

  return false; // on ne bloque PAS le message pour que les autres le voient
}

/**
 * Arrête une partie en cours (commande admin ou arrêt manuel).
 */
async function stopGame(interaction) {
  const game = activeGames.get(interaction.guildId);
  if (!game) {
    return interaction.reply({ content: '❌ Aucune partie en cours.', ephemeral: true });
  }
  if (game.timer) { clearTimeout(game.timer); game.timer = null; }
  game.isRunning = false;
  activeGames.delete(interaction.guildId);
  await interaction.reply({ content: '⛔ Blind Test arrêté.' });
}

/**
 * Affiche le classement global persistant.
 */
async function showLeaderboard(interaction) {
  const board  = await loadLeaderboard(interaction.guildId);
  const sorted = Object.entries(board)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 15);

  if (!sorted.length) {
    return interaction.reply({ content: '📭 Aucune donnée de classement pour l\'instant.', ephemeral: true });
  }

  let desc = '';
  sorted.forEach(([, v], i) => {
    const medal = MEDALS[i] || `**${i + 1}.**`;
    desc += `${medal} **${v.username}** — ${v.total} pt${v.total > 1 ? 's' : ''}\n`;
  });

  const embed = new EmbedBuilder()
    .setColor(0xF39C12)
    .setTitle('🏆 Classement Blind Test — Toutes parties confondues')
    .setDescription(desc)
    .setTimestamp();

  return interaction.reply({ embeds: [embed] });
}

module.exports = {
  startGame,
  stopGame,
  handleMessage,
  showLeaderboard,
};
