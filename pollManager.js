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

async function addOption(messageId, text, userId, username) {
  const poll = await getPoll(messageId);
  if (!poll) throw new Error('Sondage introuvable.');
  if (poll.closed) throw new Error('Ce sondage est clôturé.');
  if (poll.options.length >= MAX_OPTIONS) throw new Error(`Maximum ${MAX_OPTIONS} réponses atteint.`);
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

function buildEmbed(poll) {
  let desc = '';
  for (let i = 0; i < poll.options.length; i++) {
    const opt = poll.options[i];
    desc += `${LETTERS[i]} **${opt.text}** — *ajouté par ${opt.addedBy || '?'}*\n`;
  }
  if (!desc) desc = '*Aucune réponse pour l\'instant — soyez le premier à en ajouter une !*';

  return new EmbedBuilder()
    .setColor(poll.closed ? 0x95a5a6 : 0x5865f2)
    .setTitle(`📊 ${poll.question}`)
    .setDescription(desc.trimEnd())
    .setFooter({ text: poll.closed
      ? `🔒 Sondage clôturé · ${poll.options.length} réponse${poll.options.length !== 1 ? 's' : ''}`
      : `Cliquez sur ➕ pour ajouter votre propre réponse`,
    });
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

module.exports = { createPoll, getPoll, savePoll, addOption, toggleVote, closePoll, buildEmbed, buildComponents };
