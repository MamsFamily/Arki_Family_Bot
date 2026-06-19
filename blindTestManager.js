'use strict';

/**
 * blindTestManager.js — Système de Blind Test musical pour Discord
 *
 * Flux d'une partie :
 *  1. /blindtest start (depuis un salon texte, l'utilisateur DOIT être en vocal)
 *  2. Le bot rejoint le salon vocal de l'utilisateur
 *  3. Pour chaque manche, le bot récupère un extrait 30s via Deezer et le joue en vocal
 *  4. Les joueurs tapent titre / artiste dans le salon texte pendant 20s
 *  5. Scoring : titre = 1 pt, artiste = 1 pt, les deux en premier = +1 bonus
 *  6. Révélation + classement partiel → pause 8s → manche suivante
 *  7. Fin de partie : podium final + déconnexion vocale + mise à jour classement PostgreSQL
 */

const axios        = require('axios');
const { EmbedBuilder } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
  NoSubscriberBehavior,
} = require('@discordjs/voice');

// Diagnostic au démarrage : vérifie la lib de chiffrement vocal
(function checkVoiceCrypto() {
  const candidates = ['sodium-native', 'libsodium-wrappers', 'tweetnacl'];
  const found = candidates.find(lib => { try { require(lib); return true; } catch { return false; } });
  if (found) console.log(`[BlindTest] ✅ Chiffrement vocal : ${found}`);
  else console.warn('[BlindTest] ⚠️  Aucune lib de chiffrement vocal trouvée (sodium-native / libsodium-wrappers / tweetnacl) — la connexion vocale échouera.');
})();
const pgStore      = require('./pgStore');

const library = require('./blindTestLibrary.json');

// ══════════════════════════════════════════════════════════════════════════════
// CONSTANTES
// ══════════════════════════════════════════════════════════════════════════════

const ROUND_COUNT    = 15;     // nombre de manches par partie
const ROUND_DURATION = 25000;  // ms de fenêtre de réponse (audio 30s, on attend 25s)
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
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
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

function isMatch(answer, target, aliases = []) {
  const normAns = normalize(answer);
  const targets = [normalize(target), ...aliases.map(normalize)].filter(Boolean);

  for (const t of targets) {
    if (!t) continue;
    if (normAns.includes(t)) return true;
    if (t.includes(normAns) && normAns.length >= 4) return true;
    const tolerance = Math.max(2, Math.floor(t.length * 0.20));
    if (levenshtein(normAns, t) <= tolerance) return true;
    const keyWords = t.split(' ').filter(w => w.length > 2);
    if (keyWords.length >= 1 && keyWords.every(w =>
      normAns.includes(w) || normAns.split(' ').some(aw => levenshtein(aw, w) <= 1)
    )) return true;
  }
  return false;
}

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
  const best = tracks.find(t =>
    normalize(t.title).includes(normalize(song.title)) ||
    normalize(t.artist?.name || '').includes(normalize(song.artist))
  ) || tracks[0];
  return best.preview;
}

// ══════════════════════════════════════════════════════════════════════════════
// AUDIO VOCAL
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Connecte le bot au salon vocal et retourne { connection, player }.
 */
async function connectToVoice(voiceChannel) {
  const guild  = voiceChannel.guild;
  const client = guild.client;

  // ── Correctif Discord.js 14.23+ / @discordjs/ws incompatibilité ────────────
  // guild.voiceAdapterCreator utilise Status.Ready=0 (ancienne enum Discord.js)
  // mais guild.shard.status vaut 3 (WebSocketShardStatus.Ready de @discordjs/ws).
  // Résultat : sendPayload() retournait toujours false → OP 4 jamais envoyé →
  // Discord ne répondait jamais → connexion bloquée en "signalling".
  // Fix : adapter personnalisé qui vérifie shard.status === 3 (Ready réel).
  const SHARD_READY = 3; // WebSocketShardStatus.Ready dans @discordjs/ws
  const customAdapterCreator = (methods) => {
    client.voice.adapters.set(guild.id, methods);
    return {
      sendPayload: (data) => {
        const shard = guild.shard;
        if (!shard || shard.status !== SHARD_READY) {
          console.warn(`[BlindTest][Voice] sendPayload: shard status=${shard?.status} (attendu ${SHARD_READY}) → payload ignoré`);
          return false;
        }
        shard.send(data);
        return true;
      },
      destroy: () => {
        client.voice.adapters.delete(guild.id);
      },
    };
  };

  const connection = joinVoiceChannel({
    channelId:      voiceChannel.id,
    guildId:        guild.id,
    adapterCreator: customAdapterCreator,
    selfDeaf:       false,
    selfMute:       false,
  });

  // Log de chaque transition d'état pour diagnostic
  const stateLog = [];
  const onStateChange = (oldState, newState) => {
    stateLog.push(newState.status);
    console.log(`[BlindTest][Voice] ${oldState.status} → ${newState.status}`);
  };
  connection.on('stateChange', onStateChange);

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (err) {
    connection.off('stateChange', onStateChange);
    connection.destroy();
    const lastState = stateLog[stateLog.length - 1] || 'initial';
    console.error(`[BlindTest][Voice] Timeout — dernier état : ${lastState} — états traversés : ${stateLog.join(' → ') || 'aucun'}`);
    const hint =
      lastState === 'signalling'   ? 'Aucune réponse de la gateway Discord. Vérifiez l\'intent GuildVoiceStates et les permissions du bot.' :
      lastState === 'connecting'   ? 'Handshake UDP échoué. Le réseau du serveur bloque peut-être les ports UDP Discord (50000-65535).' :
      'Connexion interrompue avant d\'être prête.';
    throw new Error(`Impossible de rejoindre le salon vocal (bloqué en : ${lastState}). ${hint}`);
  }

  connection.off('stateChange', onStateChange);

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });
  connection.subscribe(player);

  return { connection, player };
}

/**
 * Joue l'extrait mp3 via le player vocal et attend la fin ou le timeout.
 * Résout quand l'audio est terminé ou après `maxMs` ms.
 */
function playPreview(player, previewUrl, maxMs) {
  return new Promise(async (resolve) => {
    let timeout;

    try {
      const response = await axios({ url: previewUrl, method: 'GET', responseType: 'stream', timeout: 10000 });
      const resource = createAudioResource(response.data, { inputType: StreamType.Arbitrary });

      player.play(resource);

      const onIdle = () => {
        clearTimeout(timeout);
        player.removeListener(AudioPlayerStatus.Idle, onIdle);
        resolve('finished');
      };
      player.once(AudioPlayerStatus.Idle, onIdle);

      timeout = setTimeout(() => {
        player.removeListener(AudioPlayerStatus.Idle, onIdle);
        player.stop(true);
        resolve('timeout');
      }, maxMs);

    } catch (err) {
      clearTimeout(timeout);
      resolve('error');
    }
  });
}

/**
 * Déconnecte proprement le bot du vocal.
 */
function leaveVoice(game) {
  try {
    if (game.player) { game.player.stop(true); game.player = null; }
    if (game.voiceConnection) { game.voiceConnection.destroy(); game.voiceConnection = null; }
  } catch {}
}

// ══════════════════════════════════════════════════════════════════════════════
// SETTINGS (persistés en PostgreSQL)
// ══════════════════════════════════════════════════════════════════════════════

const SETTINGS_KEY     = 'blindtest_settings';
const DEFAULT_SETTINGS = { roundCount: 15, roundDuration: 25, pauseBetween: 8 };

async function loadSettings() {
  try { return Object.assign({}, DEFAULT_SETTINGS, await pgStore.getData(SETTINGS_KEY) || {}); }
  catch { return { ...DEFAULT_SETTINGS }; }
}

async function saveSettings(settings) {
  await pgStore.setData(SETTINGS_KEY, {
    roundCount:    Math.min(25, Math.max(5,  settings.roundCount    || 15)),
    roundDuration: Math.min(30, Math.max(15, settings.roundDuration || 25)),
    pauseBetween:  Math.min(15, Math.max(5,  settings.pauseBetween  || 8)),
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// PERSISTANCE DU CLASSEMENT
// ══════════════════════════════════════════════════════════════════════════════

async function loadLeaderboard(guildId) {
  try { return (await pgStore.getData(LEADERBOARD_KEY(guildId))) || {}; }
  catch { return {}; }
}

async function saveLeaderboard(guildId, board) {
  try { await pgStore.setData(LEADERBOARD_KEY(guildId), board); } catch {}
}

async function resetLeaderboard(guildId) {
  await pgStore.setData(LEADERBOARD_KEY(guildId), {});
}

async function addScores(guildId, scoreMap) {
  const board = await loadLeaderboard(guildId);
  for (const [uid, { username, points }] of scoreMap) {
    if (!points) continue;
    if (!board[uid]) board[uid] = { username, total: 0 };
    board[uid].total    += points;
    board[uid].username  = username;
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

async function startGame(interaction) {
  const guildId = interaction.guildId;

  if (activeGames.has(guildId)) {
    return interaction.reply({
      content: '❌ Une partie de Blind Test est déjà en cours sur ce serveur !',
      ephemeral: true,
    });
  }

  // ── Vérification : l'utilisateur doit être dans un salon vocal ─────────────
  // Fetch du membre pour forcer le cache de l'état vocal (les interactions slash
  // ne garantissent pas que voice.channel est peuplé sans fetch explicite)
  let member = interaction.member;
  try { member = await interaction.guild.members.fetch(interaction.user.id); } catch {}
  const voiceChannel = member?.voice?.channel;
  if (!voiceChannel) {
    return interaction.reply({
      content: '🎙️ Tu dois être dans un **salon vocal** pour lancer le Blind Test !\nRejoins un salon vocal et relance la commande.',
      ephemeral: true,
    });
  }

  // ── Vérification des permissions ──────────────────────────────────────────
  const permissions = voiceChannel.permissionsFor(interaction.client.user);
  if (!permissions?.has('Connect') || !permissions?.has('Speak')) {
    return interaction.reply({
      content: `❌ Je n'ai pas la permission de rejoindre ou parler dans **${voiceChannel.name}**.`,
      ephemeral: true,
    });
  }

  await interaction.deferReply();

  // ── Chargement des settings dynamiques ────────────────────────────────────
  const cfg = await loadSettings();
  const roundCount    = cfg.roundCount;
  const roundDuration = cfg.roundDuration * 1000;
  const pauseBetween  = cfg.pauseBetween  * 1000;

  // ── Connexion vocale ───────────────────────────────────────────────────────
  let voiceConnection, player;
  try {
    ({ connection: voiceConnection, player } = await connectToVoice(voiceChannel));
  } catch (err) {
    return interaction.editReply({ content: `❌ ${err.message}` });
  }

  const songs = shuffle(library.songs).slice(0, roundCount);

  const game = {
    guildId,
    channelId:      interaction.channelId,
    channel:        interaction.channel,
    songs,
    currentRound:   0,
    scores:         new Map(),
    roundAnswers:   new Map(),
    firstFullId:    null,
    timer:          null,
    isRunning:      true,
    voiceConnection,
    player,
    voiceChannelName: voiceChannel.name,
    roundDuration,
    pauseBetween,
  };

  activeGames.set(guildId, game);

  const startEmbed = new EmbedBuilder()
    .setColor(0xE91E63)
    .setTitle('🎵 Blind Test — C\'est parti !')
    .setDescription(
      `🎙️ Le bot a rejoint **${voiceChannel.name}** et va jouer les extraits directement !\n\n` +
      `**${roundCount} manches** — ${roundDuration / 1000} secondes par extrait\n\n` +
      '📝 **Comment jouer ?**\n' +
      '→ Écoutez l\'extrait en vocal, puis tapez dans **ce salon**.\n' +
      '→ **Titre trouvé = 1 pt** • **Artiste trouvé = 1 pt**\n' +
      '→ Premier à trouver les deux : **+1 pt bonus** ⚡\n\n' +
      '*Bonne chance à tous !*'
    )
    .setFooter({ text: 'Première manche dans 5 secondes…' });

  await interaction.editReply({ embeds: [startEmbed] });

  setTimeout(() => runRound(game), 5000);
}

async function runRound(game) {
  if (!game.isRunning || game.currentRound >= game.songs.length) {
    return endGame(game);
  }

  const channel = game.channel;
  const song    = game.songs[game.currentRound];
  game.currentRound++;
  game.roundAnswers = new Map();
  game.firstFullId  = null;
  game.acceptingAnswers = false;

  // ── Récupération de l'extrait Deezer ──────────────────────────────────────
  let previewUrl = null;
  try { previewUrl = await getDeezerPreview(song); } catch {}

  // ── Embed de la manche ────────────────────────────────────────────────────
  const roundEmbed = new EmbedBuilder()
    .setColor(0x9B59B6)
    .setTitle(`🎵 Manche ${game.currentRound} / ${game.songs.length}`)
    .setDescription(
      `🎙️ Écoutez dans **${game.voiceChannelName}** !\n\n` +
      '**Quelle est cette chanson ?**\n\n' +
      `⏱️ Vous avez **${game.roundDuration / 1000} secondes** pour répondre.\n` +
      '-# Tapez le titre et/ou le nom de l\'artiste dans ce salon.'
    )
    .setFooter({ text: `Question ${game.currentRound} sur ${game.songs.length}` });

  await channel.send({ embeds: [roundEmbed] });

  // ── Lecture audio en vocal ─────────────────────────────────────────────────
  game.acceptingAnswers = true;
  game.roundStartTime   = Date.now();

  if (previewUrl && game.player && game.voiceConnection) {
    // Lance l'audio ET le timer en parallèle
    const audioPromise = playPreview(game.player, previewUrl, game.roundDuration);

    game.timer = setTimeout(async () => {
      game.timer = null;
      game.acceptingAnswers = false;
      if (game.player) game.player.stop(true);
      await revealRound(game, channel, song);
    }, game.roundDuration);

    await audioPromise;
  } else {
    if (!previewUrl) {
      await channel.send('⚠️ *Extrait audio indisponible pour ce titre — tentez votre chance !*');
    }
    game.timer = setTimeout(async () => {
      game.timer = null;
      game.acceptingAnswers = false;
      await revealRound(game, channel, song);
    }, game.roundDuration);
  }
}

async function revealRound(game, channel, song) {
  if (game.timer) { clearTimeout(game.timer); game.timer = null; }

  const lines = [];

  for (const [userId, ans] of game.roundAnswers) {
    const entry = game.scores.get(userId) || { points: 0, username: ans.username };
    let pts = 0;
    if (ans.titleFound)  pts += 1;
    if (ans.artistFound) pts += 1;
    if (userId === game.firstFullId) pts += 1;
    entry.points += pts;
    entry.username = ans.username;
    game.scores.set(userId, entry);

    const icon   = (ans.titleFound && ans.artistFound) ? '🟢' : (pts > 0 ? '🟡' : '🔴');
    const badges = [
      ans.titleFound  ? '✅ Titre'   : '❌ Titre',
      ans.artistFound ? '✅ Artiste' : '❌ Artiste',
    ].join(' • ');
    const bonus  = userId === game.firstFullId ? ' ⚡ +1 bonus' : '';
    lines.push(`${icon} **${ans.username}** — ${badges} **(+${pts}${bonus})**`);
  }

  if (!lines.length) lines.push('*Personne n\'a répondu…*');

  const sorted = [...game.scores.entries()]
    .sort((a, b) => b[1].points - a[1].points)
    .slice(0, 5);
  const scoreBoard = sorted.map(([, v], i) =>
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
    .setFooter({
      text: game.currentRound < game.songs.length
        ? `Prochaine manche dans ${game.pauseBetween / 1000}s…`
        : 'Fin de partie dans quelques secondes…',
    });

  await channel.send({ embeds: [revealEmbed] });

  if (game.currentRound < game.songs.length) {
    game.timer = setTimeout(() => runRound(game), game.pauseBetween);
  } else {
    game.timer = setTimeout(() => endGame(game), game.pauseBetween);
  }
}

async function endGame(game) {
  if (game.timer) { clearTimeout(game.timer); game.timer = null; }
  game.isRunning = false;
  game.acceptingAnswers = false;
  activeGames.delete(game.guildId);

  leaveVoice(game);

  const channel = game.channel;
  const sorted  = [...game.scores.entries()].sort((a, b) => b[1].points - a[1].points);

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

  if (game.scores.size) await addScores(game.guildId, game.scores);
}

// ══════════════════════════════════════════════════════════════════════════════
// HANDLERS PUBLICS
// ══════════════════════════════════════════════════════════════════════════════

function handleMessage(message) {
  const game = activeGames.get(message.guildId);
  if (!game || !game.isRunning || !game.acceptingAnswers) return false;
  if (message.channelId !== game.channelId) return false;
  if (message.author.bot) return false;

  const userId   = message.author.id;
  const username = message.member?.displayName || message.author.username;
  const song     = game.songs[game.currentRound - 1];
  if (!song) return false;

  const prev = game.roundAnswers.get(userId) || { username, titleFound: false, artistFound: false };
  const { titleFound, artistFound } = checkAnswer(message.content, song);

  const updated = {
    username,
    titleFound:  prev.titleFound  || titleFound,
    artistFound: prev.artistFound || artistFound,
  };

  game.roundAnswers.set(userId, updated);

  if (updated.titleFound && updated.artistFound && !game.firstFullId) {
    game.firstFullId = userId;
  }

  if (titleFound || artistFound) {
    message.react('✅').catch(() => {});
  }

  return false;
}

async function stopGame(interaction) {
  const game = activeGames.get(interaction.guildId);
  if (!game) {
    return interaction.reply({ content: '❌ Aucune partie en cours.', ephemeral: true });
  }
  if (game.timer) { clearTimeout(game.timer); game.timer = null; }
  game.isRunning = false;
  game.acceptingAnswers = false;
  activeGames.delete(interaction.guildId);
  leaveVoice(game);
  await interaction.reply({ content: '⛔ Blind Test arrêté. Le bot a quitté le salon vocal.' });
}

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

module.exports = { startGame, stopGame, handleMessage, showLeaderboard, loadSettings, saveSettings, loadLeaderboard, resetLeaderboard };
