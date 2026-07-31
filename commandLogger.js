/**
 * commandLogger.js — Enregistre chaque commande slash Discord utilisée.
 * Stocke dans pgStore (clé : discord_command_logs), max 2000 entrées.
 */
const pgStore = require('./pgStore');

const STORE_KEY = 'discord_command_logs';
const MAX_ENTRIES = 2000;

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function logCommand(interaction) {
  try {
    const sub  = safeGetSubcommand(interaction);
    const sub2 = safeGetSubcommandGroup(interaction);

    const fullCmd = [
      '/' + interaction.commandName,
      sub2 || null,
      sub  || null,
    ].filter(Boolean).join(' ');

    const entry = {
      timestamp:   new Date().toISOString(),
      userId:      interaction.user.id,
      username:    interaction.user.username,
      displayName: interaction.member?.displayName || interaction.user.globalName || interaction.user.username,
      command:     interaction.commandName,
      subgroup:    sub2 || null,
      subcommand:  sub  || null,
      fullCmd,
      channelId:   interaction.channelId,
      channelName: interaction.channel?.name || null,
      guildId:     interaction.guildId,
    };

    const raw = await pgStore.getData(STORE_KEY, null);
    const logs = Array.isArray(raw) ? raw : (raw ? JSON.parse(raw) : []);
    logs.push(entry);
    if (logs.length > MAX_ENTRIES) logs.splice(0, logs.length - MAX_ENTRIES);
    await pgStore.setData(STORE_KEY, logs);
  } catch (e) {
    console.error('[CommandLogger]', e.message);
  }
}

function safeGetSubcommand(interaction) {
  try { return interaction.options.getSubcommand(false); } catch { return null; }
}
function safeGetSubcommandGroup(interaction) {
  try { return interaction.options.getSubcommandGroup(false); } catch { return null; }
}

/**
 * Récupère les logs, optionnellement filtrés sur les N dernières heures.
 * @param {number} hours
 */
async function getLogs(hours = 24) {
  const raw = await pgStore.getData(STORE_KEY, null);
  const logs = Array.isArray(raw) ? raw : (raw ? JSON.parse(raw) : []);
  if (!hours) return logs.slice().reverse();
  const since = Date.now() - hours * 3_600_000;
  return logs.filter(l => new Date(l.timestamp).getTime() >= since).reverse();
}

module.exports = { logCommand, getLogs };
