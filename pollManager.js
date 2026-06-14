const pgStore = require('./pgStore');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const LETTERS = ['🇦','🇧','🇨','🇩','🇪','🇫','🇬','🇭','🇮','🇯','🇰','🇱','🇲','🇳','🇴','🇵','🇶','🇷','🇸','🇹'];
const MAX_OPTIONS = 20;

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

async function addOption(messageId, text, userId) {
  const poll = await getPoll(messageId);
  if (!poll) throw new Error('Sondage introuvable.');
  if (poll.closed) throw new Error('Ce sondage est clôturé.');
  if (poll.options.length >= MAX_OPTIONS) throw new Error(`Maximum ${MAX_OPTIONS} réponses atteint.`);
  const dup = poll.options.find(o => o.text.toLowerCase().trim() === text.toLowerCase().trim());
  if (dup) throw new Error('Cette réponse existe déjà dans le sondage.');
  poll.options.push({ id: poll.options.length, text: text.trim(), voters: [userId] });
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

function buildEmbed(poll) {
  const totalVotes = poll.options.reduce((sum, o) => sum + o.voters.length, 0);

  let desc = '';
  for (let i = 0; i < poll.options.length; i++) {
    const opt = poll.options[i];
    const count = opt.voters.length;
    const filled = totalVotes > 0 ? Math.round((count / totalVotes) * 10) : 0;
    const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
    desc += `${LETTERS[i]} **${opt.text}**\n${bar} **${count}** vote${count !== 1 ? 's' : ''}\n\n`;
  }

  if (!desc) desc = '*Aucune réponse pour l\'instant — soyez le premier à en ajouter une !*';

  return new EmbedBuilder()
    .setColor(poll.closed ? 0x95a5a6 : 0x5865f2)
    .setTitle(`📊 ${poll.question}`)
    .setDescription(desc.trimEnd())
    .setFooter({ text: poll.closed
      ? `🔒 Sondage clôturé · ${totalVotes} vote${totalVotes !== 1 ? 's' : ''} au total`
      : `Cliquez sur une lettre pour voter · ➕ pour ajouter votre propre réponse`,
    });
}

function buildComponents(poll) {
  const rows = [];

  if (!poll.closed && poll.options.length > 0) {
    const voteBtns = poll.options.slice(0, MAX_OPTIONS).map((_, i) =>
      new ButtonBuilder()
        .setCustomId(`poll_vote_${poll.messageId}_${i}`)
        .setLabel(String.fromCharCode(65 + i))
        .setEmoji(LETTERS[i])
        .setStyle(ButtonStyle.Secondary)
    );
    for (let i = 0; i < voteBtns.length; i += 4) {
      rows.push(new ActionRowBuilder().addComponents(voteBtns.slice(i, i + 4)));
    }
  }

  if (!poll.closed) {
    rows.push(new ActionRowBuilder().addComponents(
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
    ));
  }

  return rows;
}

module.exports = { createPoll, getPoll, savePoll, addOption, toggleVote, closePoll, buildEmbed, buildComponents };
