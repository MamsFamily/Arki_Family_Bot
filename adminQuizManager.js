const { addToInventory, getItemTypes } = require('./inventoryManager');
const pgStore = require('./pgStore');
const { EmbedBuilder } = require('discord.js');

const QUIZ_PG_KEY = 'admin_quiz_state';

const EMOJIS = ['\uD83C\uDDE6', '\uD83C\uDDE7', '\uD83C\uDDE8', '\uD83C\uDDE9'];
const LETTERS = ['A', 'B', 'C', 'D'];

let quizState = null;

function defaultState() {
  return {
    active: false,
    channelId: null,
    introMessageId: null,
    currentQuestionIdx: -1,
    questions: [],
    participants: [],
    eliminated: [],
    distributed: [],
    finalDistributed: null,
    participantNames: {},
    dmSentThisQuestion: {},
    config: {
      introMsg: defaultIntroMsg(),
      rewardPerQuestion: [],
      rewardFinal: [],
    },
    questionMessages: {},
  };
}

function defaultIntroMsg() {
  return '**Connaissez-vous bien vos admins ?** \uD83C\uDFAF\n\nOn lance un petit jeu pour tester vos connaissances sur vos admins \uD83D\uDC40\n\n\uD83D\uDC49 **Principe**\n\nUne question par tour\n\nLes bonnes r\u00E9ponses permettent de passer \u00E0 la question suivante\n\n\u26A0\uFE0F **R\u00E8gles importantes** :\n\n1 seule r\u00E9ponse par personne (sinon \u00E9limination directe)\n\nSi vous \u00EAtes \u00E9limin\u00E9, vous ne participez plus aux questions suivantes.\n\nPr\u00E9parez-vous\u2026 on commence avec la premi\u00E8re question \uD83D\uDE42';
}

async function loadState() {
  try {
    const raw = await pgStore.getData(QUIZ_PG_KEY);
    if (raw && raw.active !== undefined) {
      quizState = raw;
      if (!Array.isArray(quizState.participants)) quizState.participants = [];
      if (!Array.isArray(quizState.eliminated))   quizState.eliminated   = [];
      if (!quizState.config) quizState.config = defaultState().config;
      if (!quizState.config.rewardPerQuestion) quizState.config.rewardPerQuestion = [];
      if (!quizState.config.rewardFinal) quizState.config.rewardFinal = [];
      if (!quizState.questionMessages) quizState.questionMessages = {};
      if (!Array.isArray(quizState.distributed)) quizState.distributed = [];
      if (!quizState.participantNames || typeof quizState.participantNames !== 'object') quizState.participantNames = {};
      if (!quizState.dmSentThisQuestion || typeof quizState.dmSentThisQuestion !== 'object') quizState.dmSentThisQuestion = {};
      console.log('[AdminQuiz] \u00C9tat charg\u00E9 depuis PostgreSQL');
    } else {
      quizState = defaultState();
    }
  } catch (err) {
    console.error('[AdminQuiz] Erreur chargement \u00E9tat:', err.message);
    quizState = defaultState();
  }
}

async function saveState() {
  if (!quizState) return;
  await pgStore.setData(QUIZ_PG_KEY, quizState);
}

function getState() {
  if (!quizState) quizState = defaultState();
  return quizState;
}

function getActivePlayers() {
  const s = getState();
  return s.participants.filter(id => !s.eliminated.includes(id));
}

async function startSession(config) {
  quizState = defaultState();
  quizState.active = true;
  quizState.channelId = config.channelId;
  quizState.config = {
    introMsg: config.introMsg || defaultIntroMsg(),
    rewardPerQuestion: config.rewardPerQuestion || [],
    rewardFinal: config.rewardFinal || [],
  };
  await saveState();
  return quizState;
}

async function stopSession() {
  quizState = defaultState();
  await saveState();
}

async function addQuestion(q) {
  const s = getState();
  s.questions.push({
    text: q.text,
    choices: q.choices,
    correct: parseInt(q.correct, 10),
    published: false,
    revealed: false,
  });
  await saveState();
}

async function removeQuestion(idx) {
  const s = getState();
  s.questions.splice(idx, 1);
  await saveState();
}

async function updateQuestionCorrect(idx, correct) {
  const s = getState();
  if (!s.questions[idx]) throw new Error('Question introuvable');
  s.questions[idx].correct = parseInt(correct, 10);
  await saveState();
}

async function updateConfig(cfg) {
  const s = getState();
  s.config = { ...s.config, ...cfg };
  await saveState();
}

async function publishIntro(guild) {
  const s = getState();
  if (!s.active || !s.channelId) throw new Error('Pas de session active');
  const channel = await guild.channels.fetch(s.channelId).catch(() => null);
  if (!channel) throw new Error('Salon introuvable');

  const embed = new EmbedBuilder()
    .setColor(0xe91e8c)
    .setDescription(s.config.introMsg);

  const msg = await channel.send({ content: '@everyone', embeds: [embed] });
  s.introMessageId = msg.id;
  await saveState();
  return msg;
}

async function publishQuestion(guild, idx) {
  const s = getState();
  if (!s.active || !s.channelId) throw new Error('Pas de session active');
  const q = s.questions[idx];
  if (!q) throw new Error('Question introuvable');

  const channel = await guild.channels.fetch(s.channelId).catch(() => null);
  if (!channel) throw new Error('Salon introuvable');

  const activePlayers = getActivePlayers();
  const footerText = idx === 0
    ? 'Ouvert \u00E0 tous'
    : `${activePlayers.length} joueur(s) encore en course`;

  const choicesText = q.choices.map((c, i) => `R\u00E9ponse ${LETTERS[i]} : ${c}`).join('\n');
  const desc = `**${q.text}**\n\n${choicesText}\n\nLa r\u00E9ponse sera donn\u00E9e par les admins \uD83D\uDD50`;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`\u2753 Question ${idx + 1}`)
    .setDescription(desc)
    .setFooter({ text: footerText });

  const msg = await channel.send({ embeds: [embed] });
  for (const emoji of EMOJIS) await msg.react(emoji).catch(() => {});

  s.currentQuestionIdx = idx;
  s.questions[idx].published = true;
  s.questionMessages[String(idx)] = msg.id;
  await saveState();
  return msg;
}

async function revealAnswer(guild) {
  const s = getState();
  if (!s.active) throw new Error('Pas de session active');
  const idx = s.currentQuestionIdx;
  const q = s.questions[idx];
  if (!q) throw new Error('Aucune question publi\u00E9e');
  if (q.revealed) throw new Error('D\u00E9j\u00E0 r\u00E9v\u00E9l\u00E9e');

  const channel = await guild.channels.fetch(s.channelId).catch(() => null);
  if (!channel) throw new Error('Salon introuvable');

  const messageId = s.questionMessages[String(idx)];
  let qMsg = null;
  if (messageId) qMsg = await channel.messages.fetch(messageId).catch(() => null);

  const correct = q.correct;
  const isFirstQuestion = idx === 0;

  const userReactions = new Map();
  if (qMsg) {
    for (let i = 0; i < EMOJIS.length; i++) {
      const reaction = qMsg.reactions.cache.get(EMOJIS[i]);
      if (!reaction) continue;
      const users = await reaction.users.fetch().catch(() => null);
      if (!users) continue;
      for (const [uid, user] of users) {
        if (user.bot) continue;
        if (!userReactions.has(uid)) userReactions.set(uid, []);
        userReactions.get(uid).push(i);
      }
    }
  }

  const eliminatedNow = [];
  const rewardedUsers = [];
  let itemTypes = [];
  try { itemTypes = getItemTypes() || []; } catch (_) {}
  const rewards = s.config.rewardPerQuestion || [];

  for (const [uid, reactions] of userReactions) {
    if (s.eliminated.includes(uid)) continue;

    if (reactions.length > 1) {
      if (!s.eliminated.includes(uid)) {
        s.eliminated.push(uid);
        eliminatedNow.push(uid);
      }
      continue;
    }

    const answeredCorrect = reactions[0] === correct;

    if (isFirstQuestion) {
      if (answeredCorrect) {
        if (!s.participants.includes(uid)) s.participants.push(uid);
        rewardedUsers.push(uid);
      }
    } else {
      if (!s.participants.includes(uid)) continue;
      if (!answeredCorrect) {
        s.eliminated.push(uid);
        eliminatedNow.push(uid);
      } else {
        rewardedUsers.push(uid);
      }
    }
  }

  if (!isFirstQuestion) {
    for (const uid of s.participants) {
      if (s.eliminated.includes(uid)) continue;
      if (!userReactions.has(uid)) {
        s.eliminated.push(uid);
        eliminatedNow.push(uid);
      }
    }
  }

  for (const uid of rewardedUsers) {
    for (const r of rewards) {
      if (!r.itemId || !r.quantity) continue;
      await addToInventory(uid, r.itemId, Number(r.quantity), 'admin-quiz', `Quiz Admin \u2014 Q${idx + 1}`).catch(() => {});
    }
    s.distributed.push({ userId: uid, questionIdx: idx, rewards });
  }

  s.questions[idx].revealed = true;
  await saveState();

  const activePlayers = getActivePlayers();
  const rewardLabel = rewards.map(r => {
    const it = itemTypes.find(x => x.id === r.itemId);
    return `${r.quantity} ${it ? (it.emoji + ' ' + it.name) : r.itemId}`;
  }).join(', ') || '\u2014';

  return {
    questionIdx: idx,
    questionText: q.text,
    correctLetter: LETTERS[correct],
    correctText: q.choices[correct],
    rewardedCount: rewardedUsers.length,
    eliminatedCount: eliminatedNow.length,
    activePlayers: activePlayers.length,
    activePlayerIds: activePlayers,
    rewardLabel,
    eliminatedUserIds: eliminatedNow,
  };
}

async function postReport(guild, report) {
  const s = getState();
  if (!s.channelId) return;
  const channel = await guild.channels.fetch(s.channelId).catch(() => null);
  if (!channel) return;

  const lines = [
    `✅ **Bonne réponse : ${report.correctLetter} — ${report.correctText}**`,
    '',
  ];

  if (report.rewardedCount > 0 && report.rewardLabel !== '—') {
    lines.push(`🎁 **${report.rewardedCount}** joueur(s) ont bien répondu et reçoivent **${report.rewardLabel}** ✅`);
  } else {
    lines.push(`🎁 **${report.rewardedCount}** joueur(s) ont bien répondu`);
  }

  if (report.eliminatedCount > 0) {
    lines.push(`💀 **${report.eliminatedCount}** joueur(s) éliminé(s) cette question`);
  }

  lines.push('');
  lines.push(`👥 **${report.activePlayers}** joueur(s) encore en course :`);
  if (report.activePlayerIds && report.activePlayerIds.length > 0) {
    lines.push(report.activePlayerIds.map(id => `<@${id}>`).join(' '));
  } else {
    lines.push('*Personne — fin du quiz !*');
  }

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`📊 Résultats — Question ${report.questionIdx + 1}`)
    .setDescription(lines.join('\n'));

  await channel.send({ embeds: [embed] }).catch(() => {});
}

async function distributeFinalReward(guild) {
  const s = getState();
  const activePlayers = getActivePlayers();
  if (activePlayers.length !== 1) {
    throw new Error(`Il reste ${activePlayers.length} joueur(s) en course. Attendez qu\u2019il n\u2019en reste plus qu\u2019un.`);
  }
  const winnerId = activePlayers[0];
  const rewards = s.config.rewardFinal || [];
  let itemTypes = [];
  try { itemTypes = getItemTypes() || []; } catch (_) {}

  for (const r of rewards) {
    if (!r.itemId || !r.quantity) continue;
    await addToInventory(winnerId, r.itemId, Number(r.quantity), 'admin-quiz', 'Quiz Admin \u2014 R\u00E9compense finale').catch(() => {});
  }

  s.finalDistributed = { userId: winnerId, rewards };
  await saveState();

  const rewardLabel = rewards.map(r => {
    const it = itemTypes.find(x => x.id === r.itemId);
    return `${r.quantity} ${it ? (it.emoji + ' ' + it.name) : r.itemId}`;
  }).join(', ') || '\u2014';

  if (s.channelId) {
    const channel = await guild.channels.fetch(s.channelId).catch(() => null);
    if (channel) {
      const embed = new EmbedBuilder()
        .setColor(0xf39c12)
        .setTitle('\uD83C\uDFC6 Grand Gagnant !')
        .setDescription(`F\u00E9licitations <@${winnerId}> ! Tu es le dernier survivant du quiz !\n\n\uD83C\uDF81 Tu remportes **${rewardLabel}** !`);
      await channel.send({ embeds: [embed] }).catch(() => {});
    }
  }

  return { winnerId, rewardLabel };
}

async function handleReactionAdd(reaction, user) {
  if (user.bot) return;
  const s = getState();
  if (!s.active || s.currentQuestionIdx < 0) return;
  const idx = s.currentQuestionIdx;
  if (s.questions[idx]?.revealed) return;
  const msgId = s.questionMessages[String(idx)];
  if (!msgId || reaction.message.id !== msgId) return;
  if (!EMOJIS.includes(reaction.emoji.name)) return;

  const dmKey = `${user.id}_${idx}`;

  // Stocker le nom du joueur au passage
  if (user.username) s.participantNames[user.id] = user.displayName || user.username;

  // Joueur éliminé qui réagit quand même
  if (s.eliminated.includes(user.id)) {
    if (!s.dmSentThisQuestion[dmKey]) {
      s.dmSentThisQuestion[dmKey] = true;
      user.send('❌ Tu as déjà été éliminé(e) du quiz — ta réponse ne sera pas comptée.').catch(() => {});
      await saveState();
    }
    return;
  }

  // Joueur non-participant qui réagit à partir de Q2
  if (idx > 0 && !s.participants.includes(user.id)) {
    if (!s.dmSentThisQuestion[dmKey]) {
      s.dmSentThisQuestion[dmKey] = true;
      user.send('❌ Tu n\'as pas participé dès la première question — tu ne peux plus rejoindre le quiz en cours de route. Ta réponse ne sera pas comptée.').catch(() => {});
      await saveState();
    }
    return;
  }

  const msg = reaction.message.partial ? await reaction.message.fetch().catch(() => null) : reaction.message;
  if (!msg) return;
  let count = 0;
  for (const emoji of EMOJIS) {
    const r = msg.reactions.cache.get(emoji);
    if (!r) continue;
    const users = await r.users.fetch().catch(() => null);
    if (users && users.has(user.id)) count++;
  }
  if (count > 1 && s.participants.includes(user.id) && !s.eliminated.includes(user.id)) {
    s.eliminated.push(user.id);
    await saveState();
    user.send('⚠️ Tu as maintenu plusieurs réponses dans le quiz — tu es éliminé(e) !').catch(() => {});
  }
}

async function handleReactionRemove(reaction, user) {
  if (user.bot) return;
}

async function handleEnCourseCommand(interaction) {
  const s = getState();
  if (!s.active) {
    await interaction.reply({ content: '\u274C Aucun quiz en cours.', ephemeral: true });
    return;
  }
  const active = getActivePlayers();
  if (active.length === 0) {
    await interaction.reply({ content: '\uD83C\uDFC1 Plus aucun joueur en course.', ephemeral: true });
    return;
  }
  const list = active.map(id => `<@${id}>`).join('\n');
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`\uD83D\uDC65 Joueurs encore en course (${active.length})`)
    .setDescription(list)
    .setFooter({ text: `Question actuelle : Q${s.currentQuestionIdx + 1}` });
  await interaction.reply({ embeds: [embed] });
}

module.exports = {
  loadState,
  saveState,
  getState,
  getActivePlayers,
  startSession,
  stopSession,
  addQuestion,
  removeQuestion,
  updateQuestionCorrect,
  updateConfig,
  publishIntro,
  publishQuestion,
  revealAnswer,
  postReport,
  distributeFinalReward,
  handleReactionAdd,
  handleReactionRemove,
  handleEnCourseCommand,
  defaultIntroMsg,
};
