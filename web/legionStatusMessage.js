'use strict';

const pgStore = require('../pgStore');
const legion = require('./legionManager');
const { getSettings } = require('../settingsManager');

const STORAGE_KEY = 'legion_public_status_message';
const INTERVAL_MS = 60_000;
let updating = false;
let timer = null;

function authorized(interaction) {
  const roleIds = getSettings().serverPanel?.adminRoleIds || [];
  return interaction.member?.permissions?.has('Administrator') ||
    interaction.member?.roles?.cache?.some(role => roleIds.includes(role.id)) || false;
}

function status(state) {
  switch (state) {
    case 'running': return { icon: '🟢', label: 'En ligne' };
    case 'starting': return { icon: '🟠', label: 'Démarrage' };
    case 'stopping': return { icon: '🟠', label: 'Arrêt en cours' };
    case 'restarting': return { icon: '🟠', label: 'Redémarrage' };
    case 'offline': return { icon: '🔴', label: 'Hors ligne' };
    case 'suspended': return { icon: '🔴', label: 'Suspendue' };
    default: return { icon: '⚪', label: 'État indisponible' };
  }
}

function render(servers, checkedAt = new Date()) {
  const byId = new Map(servers.map(server => [server.id, server]));
  const rows = legion.MAPS.map(map => {
    const server = byId.get(map.id);
    const { icon, label } = status(server?.state);
    const players = server?.state === 'running' ? ' · Joueurs : indisponible' : '';
    return `${icon} **${map.name.toUpperCase()}** — ${label}${players}`;
  });
  return [
    '## État des cartes ARK',
    ...rows,
    '',
    'Les joueurs connectés ne sont pas encore disponibles via GPanel. Aucun compteur estimé.',
    `Dernier relevé : <t:${Math.floor(checkedAt.getTime() / 1000)}:R>`,
  ].join('\n');
}

async function readConfig() {
  if (!pgStore.isPostgres()) throw new Error('PostgreSQL requis pour conserver le message Discord');
  return pgStore.getData(STORAGE_KEY, null, { throwOnError: true });
}

async function saveConfig(config) {
  if (!await pgStore.setData(STORAGE_KEY, config)) {
    throw new Error('Impossible de sauvegarder la configuration Discord');
  }
}

async function content() {
  try {
    return render(await legion.getServers());
  } catch (error) {
    console.error('[Legion] État public indisponible :', error.message);
    return render([]);
  }
}

async function fetchChannel(client, channelId) {
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased() || !channel.send || !channel.messages?.fetch) {
    throw new Error('Choisis un salon textuel où le bot peut écrire');
  }
  return channel;
}

async function refresh(client) {
  if (updating) return;
  updating = true;
  try {
    const config = await readConfig();
    if (!config?.channelId || !config.messageId) return;
    const channel = await fetchChannel(client, config.channelId);
    const text = await content();
    let message;
    try {
      message = await channel.messages.fetch(config.messageId);
    } catch (error) {
      if (error.code !== 10008) throw error;
    }
    if (message) {
      await message.edit({ content: text, allowedMentions: { parse: [] } });
    } else {
      const created = await channel.send({ content: text, allowedMentions: { parse: [] } });
      try {
        await saveConfig({ channelId: channel.id, messageId: created.id });
      } catch (error) {
        await created.delete().catch(() => {});
        throw error;
      }
    }
  } finally {
    updating = false;
  }
}

async function publish(interaction) {
  if (!authorized(interaction)) {
    return interaction.reply({ content: '❌ Réservé aux administrateurs.', ephemeral: true });
  }
  if (!interaction.guildId) {
    return interaction.reply({ content: '❌ Utilise cette commande dans un salon du serveur.', ephemeral: true });
  }
  await interaction.deferReply({ ephemeral: true });
  try {
    if (updating) throw new Error('Une mise à jour est déjà en cours. Réessaie dans quelques secondes.');
    updating = true;
    const channel = await fetchChannel(interaction.client, interaction.channelId);
    const previous = await readConfig();
    const text = await content();
    let message = null;
    if (previous?.channelId === channel.id && previous.messageId) {
      try {
        message = await channel.messages.fetch(previous.messageId);
      } catch (error) {
        if (error.code !== 10008) throw error;
      }
    }
    if (message) {
      await message.edit({ content: text, allowedMentions: { parse: [] } });
    } else {
      message = await channel.send({ content: text, allowedMentions: { parse: [] } });
      try {
        await saveConfig({ channelId: channel.id, messageId: message.id });
      } catch (error) {
        await message.delete().catch(() => {});
        throw error;
      }
      let oldMessageWarning = '';
      if (previous?.messageId && previous.channelId !== channel.id) {
        try {
          const oldChannel = await fetchChannel(interaction.client, previous.channelId);
          const oldMessage = await oldChannel.messages.fetch(previous.messageId);
          await oldMessage.delete();
        } catch (error) {
          if (error.code !== 10008) {
            console.error('[Legion] Ancien message à retirer :', error.message);
            oldMessageWarning = ' ⚠️ Ancien message impossible à supprimer : retire-le manuellement.';
          }
        }
      }
      return interaction.editReply(`✅ État des 12 cartes publié dans <#${channel.id}>. Actualisation chaque minute.${oldMessageWarning}`);
    }
    return interaction.editReply(`✅ État des 12 cartes publié dans <#${channel.id}>. Actualisation chaque minute.`);
  } catch (error) {
    console.error('[Legion] Publication état :', error.message);
    return interaction.editReply(`❌ Publication impossible : ${error.message}`);
  } finally {
    updating = false;
  }
}

function start(client) {
  if (timer) return;
  refresh(client).catch(error => console.error('[Legion] Actualisation état :', error.message));
  timer = setInterval(() => {
    refresh(client).catch(error => console.error('[Legion] Actualisation état :', error.message));
  }, INTERVAL_MS);
}

module.exports = { status, render, refresh, publish, start };