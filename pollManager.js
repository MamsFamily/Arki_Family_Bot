const pgStore = require('./pgStore');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const LETTERS = ['🇦','🇧','🇨','🇩','🇪','🇫','🇬','🇭','🇮','🇯','🇰','🇱','🇲','🇳','🇴','🇵','🇶','🇷','🇸','🇹'];
const MAX_OPTIONS = 20;
const CLASSIC_POLL_INDEX_KEY = 'classic_poll_index';
const MAX_TIMEOUT = 2_147_000_000;
const classicCloseTimers = new Map();
const classicVoteQueues = new Map();

function pgKey(messageId) { return `poll_${messageId}`; }

async function createPoll({ messageId, channelId, question, createdBy }) {
  const poll = {
    messageId,
    channelId,
    question,
    options: [],
    closed: false,
    createdBy,
    createdAt: Date.now(),
  };
  await pgStore.setData(pgKey(messageId), poll);
  return poll;
}

async function getPoll(messageId) {
  return await pgStore.getData(pgKey(messageId));
}

async function savePoll(poll) {
  await pgStore.setData(pgKey(poll.messageId), poll);
}

async function addOption(messageId, text, userId, username) {
  const poll = await getPoll(messageId);
  if (!poll) throw new Error('Sondage introuvable.');
  if (poll.closed) throw new Error('Ce sondage est clôturé.');
  if (poll.options.length >= MAX_OPTIONS) throw new Error(`Maximum ${MAX_OPTIONS} réponses atteint.`);
  const alreadyAdded = poll.options.some(o => o.voters.includes(userId));
  if (alreadyAdded) throw new Error('Tu as déjà ajouté une réponse à ce sondage.');
  const dup = poll.options.find(o => o.text.toLowerCase().trim() === text.toLowerCase().trim());
  if (dup) throw new Error('Cette réponse existe déjà dans le sondage.');
  poll.options.push({ id: poll.options.length, text: text.trim(), voters: [userId], addedBy: username || userId });
  await savePoll(poll);
  return poll;
}

async function toggleVote(messageId, optionIdx, userId) {
  const poll = await getPoll(messageId);
  if (!poll) throw new Error('Sondage introuvable.');
  if (poll.closed) throw new Error('Ce sondage est clôturé.');
  const option = poll.options[optionIdx];
  if (!option) throw new Error('Option introuvable.');
  const idx = option.voters.indexOf(userId);
  if (idx >= 0) option.voters.splice(idx, 1);
  else option.voters.push(userId);
  await savePoll(poll);
  return poll;
}

async function closePoll(messageId) {
  const poll = await getPoll(messageId);
  if (!poll) throw new Error('Sondage introuvable.');
  poll.closed = true;
  await savePoll(poll);
  return poll;
}

function voterId(voter) {
  return typeof voter === 'string' ? voter : voter?.id;
}

function displayVoter(voter) {
  const name = typeof voter === 'string' ? voter : voter?.name;
  return String(name || 'Joueur inconnu')
    .replace(/@/g, '@\u200b')
    .replace(/[`*_~|]/g, '\\$&')
    .slice(0, 80);
}

function displayOption(option, index) {
  return `${LETTERS[index] || '•'} ${String(option.text || '').slice(0, 80)}`;
}

function parseClassicAnswers(input) {
  if (typeof input !== 'string') throw new Error('Saisis les réponses séparées par |.');
  const answers = input.split('|').map(answer => answer.trim());
  if (answers.length < 2 || answers.length > 10 || answers.some(answer => !answer)) {
    throw new Error('Indique de 2 à 10 réponses, séparées par |.');
  }
  if (answers.some(answer => answer.length > 80)) {
    throw new Error('Chaque réponse est limitée à 80 caractères.');
  }
  const normalized = answers.map(answer => answer.toLocaleLowerCase('fr-FR'));
  if (new Set(normalized).size !== answers.length) {
    throw new Error('Les réponses doivent toutes être différentes.');
  }
  return answers;
}

async function getClassicPollIndex() {
  const index = await pgStore.getData(CLASSIC_POLL_INDEX_KEY, []);
  return Array.isArray(index) ? index : [];
}

async function createClassicPoll({
  messageId,
  channelId,
  question,
  options,
  createdBy,
  allowMultiple = false,
  anonymous = false,
  endsAt = null,
  imageName = null,
}) {
  const poll = {
    kind: 'classic',
    messageId,
    channelId,
    question,
    options: options.map((text, index) => ({ id: index, text, voters: [] })),
    createdBy,
    createdAt: Date.now(),
    allowMultiple: !!allowMultiple,
    anonymous: !!anonymous,
    endsAt: endsAt || null,
    imageName: imageName || null,
    closed: false,
    closedAt: null,
  };
  await savePoll(poll);

  await pgStore.appendUniqueToArray(CLASSIC_POLL_INDEX_KEY, messageId);
  return poll;
}

async function toggleClassicVote(messageId, optionIdx, voter, onUpdated) {
  const previous = classicVoteQueues.get(messageId) || Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    const poll = await getPoll(messageId);
    if (!poll || poll.kind !== 'classic') throw new Error('Sondage introuvable.');
    if (poll.closed || (poll.endsAt && poll.endsAt <= Date.now())) {
      throw new Error('Ce sondage est clôturé.');
    }

    const option = poll.options[optionIdx];
    if (!option) throw new Error('Réponse introuvable.');

    const alreadyVoted = option.voters.some(entry => voterId(entry) === voter.id);
    if (alreadyVoted) {
      option.voters = option.voters.filter(entry => voterId(entry) !== voter.id);
    } else {
      if (!poll.allowMultiple) {
        for (const answer of poll.options) {
          answer.voters = answer.voters.filter(entry => voterId(entry) !== voter.id);
        }
      }
      option.voters.push({ id: voter.id, name: voter.name });
    }

    await savePoll(poll);
    if (onUpdated) await onUpdated(poll);
    return { poll, voted: !alreadyVoted };
  });
  classicVoteQueues.set(messageId, task);
  task.finally(() => {
    if (classicVoteQueues.get(messageId) === task) classicVoteQueues.delete(messageId);
  }).catch(() => {});
  return task;
}

async function closeClassicPoll(messageId) {
  const previous = classicVoteQueues.get(messageId) || Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    const poll = await getPoll(messageId);
    if (!poll || poll.kind !== 'classic') throw new Error('Sondage introuvable.');
    if (poll.closed) return poll;

    poll.closed = true;
    poll.closedAt = Date.now();
    poll.messageClosed = false;
    await savePoll(poll);
    const timer = classicCloseTimers.get(messageId);
    if (timer) clearTimeout(timer);
    classicCloseTimers.delete(messageId);
    return poll;
  });
  classicVoteQueues.set(messageId, task);
  task.finally(() => {
    if (classicVoteQueues.get(messageId) === task) classicVoteQueues.delete(messageId);
  }).catch(() => {});
  return task;
}

function buildClassicEmbed(poll) {
  const totalVotes = poll.options.reduce((total, option) =>
    total + (Array.isArray(option.voters) ? option.voters.length : 0), 0);
  const highestVoteCount = Math.max(0, ...poll.options.map(option =>
    Array.isArray(option.voters) ? option.voters.length : 0));
  const description = [
    poll.closed ? '🔒 Sondage clôturé' : 'Clique sur un choix pour voter, puis reclique pour retirer ton vote.',
    `${poll.allowMultiple ? 'Choix multiples' : 'Choix unique'} · ${poll.anonymous ? 'votes anonymes' : 'votes publics'}`,
    `**${totalVotes} vote${totalVotes !== 1 ? 's' : ''} au total**`,
    'Les pourcentages indiquent la part des votes exprimés.',
  ];
  if (!poll.closed && poll.endsAt) {
    description.push(`Fermeture automatique <t:${Math.floor(poll.endsAt / 1000)}:R>`);
  }

  const embed = new EmbedBuilder()
    .setColor(poll.closed ? 0x95a5a6 : 0x5865f2)
    .setTitle(`📊 ${poll.question}`)
    .setDescription(description.join('\n'));

  embed.addFields(poll.options.map((option, index) => {
    const voters = Array.isArray(option.voters) ? option.voters : [];
    const count = voters.length;
    const percentage = totalVotes ? Math.round(count / totalVotes * 100) : 0;
    const filled = Math.round(percentage / 10);
    const bar = `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
    const isWinner = poll.closed && highestVoteCount > 0 && count === highestVoteCount;
    const value = [`${bar} **${percentage}%**`, `**${count} vote${count !== 1 ? 's' : ''}**`];

    if (!poll.anonymous) {
      if (!count) {
        value.push('Aucun votant');
      } else {
        const names = voters.slice(0, 5).map(voter => displayVoter(voter).slice(0, 36));
        const remaining = count - names.length;
        value.push(`👥 ${names.join(', ')}${remaining ? ` · +${remaining} autre${remaining > 1 ? 's' : ''}` : ''}`);
      }
    }

    return {
      name: `${isWinner ? '🏆 ' : ''}${displayOption(option, index)}`,
      value: value.join('\n'),
      inline: false,
    };
  }));
  embed.setFooter({
    text: poll.closed
      ? 'Sondage clôturé · 🏆 indique le ou les choix en tête'
      : 'Les résultats se mettent à jour à chaque vote',
  });

  if (poll.imageName) embed.setImage(`attachment://${poll.imageName}`);
  return embed;
}

function buildClassicComponents(poll) {
  if (poll.closed) return [];
  const rows = [];
  for (let start = 0; start < poll.options.length; start += 5) {
    const buttons = poll.options.slice(start, start + 5).map((option, offset) => {
      const index = start + offset;
      return new ButtonBuilder()
        .setCustomId(`classic_poll_vote_${poll.messageId}_${index}`)
        .setLabel(String(option.text).slice(0, 80))
        .setEmoji(LETTERS[index])
        .setStyle(ButtonStyle.Primary);
    });
    rows.push(new ActionRowBuilder().addComponents(...buttons));
  }
  return rows;
}

async function refreshClassicPollMessage(client, poll) {
  try {
    const channel = await client.channels.fetch(poll.channelId).catch(() => null);
    if (!channel?.isTextBased?.()) return false;
    const message = await channel.messages.fetch(poll.messageId).catch(() => null);
    if (!message) return false;
    await message.edit({
      embeds: [buildClassicEmbed(poll)],
      components: buildClassicComponents(poll),
    });
    if (poll.closed && !poll.messageClosed) {
      poll.messageClosed = true;
      await savePoll(poll);
    }
    return true;
  } catch (error) {
    console.error('[Poll] Erreur mise à jour sondage:', error.message);
    return false;
  }
}

function scheduleClosedPollRefresh(client, messageId) {
  const timer = setTimeout(async () => {
    const poll = await getPoll(messageId);
    if (!poll?.closed || poll.messageClosed) return;
    const refreshed = await refreshClassicPollMessage(client, poll);
    if (!refreshed) scheduleClosedPollRefresh(client, messageId);
  }, 60 * 1000);
  classicCloseTimers.set(messageId, timer);
}

function scheduleClassicPollClose(client, poll) {
  if (poll.closed || !poll.endsAt) return;
  const existing = classicCloseTimers.get(poll.messageId);
  if (existing) clearTimeout(existing);

  const schedule = () => {
    const delay = poll.endsAt - Date.now();
    const safeDelay = Math.max(0, Math.min(delay, MAX_TIMEOUT));
    const timer = setTimeout(async () => {
      if (delay > MAX_TIMEOUT) return schedule();
      try {
        const closedPoll = await closeClassicPoll(poll.messageId);
        const refreshed = await refreshClassicPollMessage(client, closedPoll);
        if (!refreshed) scheduleClosedPollRefresh(client, closedPoll.messageId);
      } catch (error) {
        console.error('[Poll] Erreur fermeture automatique:', error.message);
      }
    }, safeDelay);
    classicCloseTimers.set(poll.messageId, timer);
  };

  schedule();
}

async function initClassicPolls(client) {
  const pollIds = await getClassicPollIndex();
  for (const messageId of pollIds) {
    const poll = await getPoll(messageId);
    if (!poll || poll.kind !== 'classic') continue;

    if (poll.closed) {
      if (!poll.messageClosed) {
        const refreshed = await refreshClassicPollMessage(client, poll);
        if (!refreshed) scheduleClosedPollRefresh(client, messageId);
      }
      continue;
    }
    if (!poll.endsAt) continue;

    if (poll.endsAt <= Date.now()) {
      try {
        const closedPoll = await closeClassicPoll(messageId);
        const refreshed = await refreshClassicPollMessage(client, closedPoll);
        if (!refreshed) scheduleClosedPollRefresh(client, closedPoll.messageId);
      } catch (error) {
        console.error('[Poll] Erreur reprise fermeture automatique:', error.message);
      }
    } else {
      scheduleClassicPollClose(client, poll);
    }
  }
}

function buildEmbed(poll) {
  const description = poll.options.length
    ? 'Réponses proposées par les membres :'
    : 'Aucune réponse pour l’instant. Clique sur « Ajouter ma réponse » pour commencer.';
  const embed = new EmbedBuilder()
    .setColor(poll.closed ? 0x95a5a6 : 0x5865f2)
    .setTitle(`📊 ${poll.question}`)
    .setDescription(description)
    .setFooter({
      text: poll.closed
        ? `🔒 Sondage clôturé · ${poll.options.length} réponse${poll.options.length !== 1 ? 's' : ''}`
        : `${poll.options.length} réponse${poll.options.length !== 1 ? 's' : ''} · ajoute la tienne avec le bouton`,
    });
  if (poll.options.length) {
    embed.addFields(poll.options.map((option, index) => ({
      name: displayOption(option, index),
      value: `Proposée par **${displayVoter(option.addedBy || '?')}**`,
      inline: false,
    })));
  }
  return embed;
}

function buildComponents(poll) {
  if (poll.closed) return [];
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`poll_add_${poll.messageId}`)
        .setLabel('Ajouter ma réponse')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('➕'),
      new ButtonBuilder()
        .setCustomId(`poll_close_${poll.messageId}`)
        .setLabel('Clore le sondage')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🔒'),
    ),
  ];
}

module.exports = {
  createPoll,
  getPoll,
  savePoll,
  addOption,
  toggleVote,
  closePoll,
  buildEmbed,
  buildComponents,
  createClassicPoll,
  parseClassicAnswers,
  toggleClassicVote,
  closeClassicPoll,
  buildClassicEmbed,
  buildClassicComponents,
  scheduleClassicPollClose,
  initClassicPolls,
};
