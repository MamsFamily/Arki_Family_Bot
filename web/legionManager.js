const axios = require('axios');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getSettings } = require('../settingsManager');

const BASE_URL = 'https://gpanel.legionhosting.net/api/client';

// Liste approuvée après comparaison avec les 12 cartes GPanel. Le serveur d'essai
// (et tout futur serveur du compte) ne doit jamais recevoir d'action groupée.
const MAPS = Object.freeze([
  { id: '9e151580', name: 'Valguero' },
  { id: '7c110bf0', name: 'Genesis' },
  { id: '27d0aeff', name: 'Astraeos' },
  { id: 'd8d6185e', name: 'The Island' },
  { id: '8efe82b3', name: 'Ragnarok' },
  { id: '8e262f7c', name: 'Lost Colony' },
  { id: '686c087f', name: 'Aberration' },
  { id: '988af27d', name: 'Scorched Earth' },
  { id: 'e4d5b19e', name: 'Extinction' },
  { id: 'b59b0253', name: 'Map Event' },
  { id: '6c0e3a89', name: 'Svartalfheim' },
  { id: 'cf79fe13', name: 'The Center' },
]);
const MAP_IDS = new Set(MAPS.map(map => map.id));
const GAME_INI = '/ShooterGame/Saved/Config/WindowsServer/Game.ini';
const USER_INI = '/ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini';

function client() {
  if (!process.env.LEGION_CLIENT_API_KEY) throw new Error('Clé API client Legion non configurée');
  return axios.create({
    baseURL: BASE_URL,
    timeout: 15000,
    headers: {
      Authorization: `Bearer ${process.env.LEGION_CLIENT_API_KEY}`,
      Accept: 'application/json',
    },
  });
}

function assertMap(id) {
  if (!MAP_IDS.has(id)) throw new Error('Cette carte ne fait pas partie des 12 serveurs Legion autorisés');
}

function apiError(error) {
  if (error.response?.status === 401) return new Error('Clé API Legion refusée (401)');
  if (error.response?.status === 403) return new Error('Permission API Legion insuffisante (403)');
  return new Error(`GPanel : ${error.response?.status || error.message}`);
}

async function getServers() {
  try {
    const api = client();
    let page = 1;
    const all = [];
    do {
      const { data } = await api.get('/', { params: { page } });
      if (!Array.isArray(data.data)) throw new Error('Format de réponse GPanel inattendu');
      all.push(...data.data.map(item => item.attributes));
      if (page >= (data.meta?.pagination?.total_pages || 1)) break;
      page++;
    } while (page <= 20);

    const byId = new Map(all.map(server => [server.identifier, server]));
    const missing = MAPS.filter(map => !byId.has(map.id));
    if (missing.length) throw new Error(`Cartes Legion introuvables : ${missing.map(map => map.name).join(', ')}`);

    return Promise.all(MAPS.map(async map => {
      const server = byId.get(map.id);
      try {
        const { data } = await api.get(`/servers/${map.id}/resources`);
        const attributes = data.attributes || {};
        return {
          ...map,
          state: attributes.is_suspended ? 'suspended' : (attributes.current_state || 'unknown'),
          cpu: attributes.resources?.cpu_absolute ?? null,
          memory: attributes.resources?.memory_bytes ?? null,
          disk: attributes.resources?.disk_bytes ?? null,
          uptime: attributes.resources?.uptime ?? null,
          memoryLimit: server.limits?.memory ?? null,
          resourceError: null,
        };
      } catch (error) {
        return { ...map, state: 'unknown', cpu: null, memory: null, disk: null, uptime: null,
          memoryLimit: server.limits?.memory ?? null, resourceError: apiError(error).message };
      }
    }));
  } catch (error) {
    if (error.response) throw apiError(error);
    throw error;
  }
}

// Read only: manual INI safety checks must never infer that a server is offline
// from an API failure or from a missing/unrecognized resource field.
async function getMapState(id) {
  assertMap(id);
  try {
    const { data } = await client().get(`/servers/${id}/resources`);
    const attributes = data?.attributes || {};
    if (attributes.is_suspended) return 'suspended';
    return ['offline', 'running', 'starting', 'stopping', 'restarting'].includes(attributes.current_state)
      ? attributes.current_state
      : 'unknown';
  } catch (error) {
    throw apiError(error);
  }
}

async function power(id, signal) {
  assertMap(id);
  if (!['start', 'stop', 'restart'].includes(signal)) throw new Error('Action non autorisée');
  try {
    await client().post(`/servers/${id}/power`, { signal });
  } catch (error) {
    throw apiError(error);
  }
}

async function wipeWildDinos(id) {
  assertMap(id);
  try {
    // La console GPanel exécute les commandes administrateur ARK. Une réponse
    // 204 signifie que la commande a été acceptée, pas que le wipe est terminé.
    await client().post(`/servers/${id}/command`, { command: 'cheat DestroyWildDinos' });
  } catch (error) {
    throw apiError(error);
  }
}

async function sendCommand(id, command) {
  assertMap(id);
  if (typeof command !== 'string' || command.length > 180 ||
      /[\u0000-\u001F\u007F-\u009F]/.test(command) ||
      !(command === 'SaveWorld' || command === 'ListPlayers' || /^Broadcast .+$/.test(command))) {
    throw new Error('Commande Legion non autorisée');
  }
  try {
    await client().post(`/servers/${id}/command`, { command });
  } catch (error) {
    throw apiError(error);
  }
}

// Only the two known ARK configuration files can be accessed. Never accept
// an arbitrary user-supplied file path or return their raw contents via HTTP.
async function readFile(id, path) {
  assertMap(id);
  if (path !== GAME_INI && path !== USER_INI) throw new Error('Fichier Legion non autorisé');
  try {
    const response = await client().get(`/servers/${id}/files/contents`, {
      params: { file: path }, responseType: 'text',
    });
    if (typeof response.data !== 'string') throw new Error('Contenu INI invalide');
    return response.data;
  } catch (error) {
    if (error.response) throw apiError(error);
    throw error;
  }
}

async function writeFile(id, path, content) {
  assertMap(id);
  if ((path !== GAME_INI && path !== USER_INI) || typeof content !== 'string' || content.length > 2_000_000) {
    throw new Error('Écriture INI Legion non autorisée');
  }
  try {
    await client().post(`/servers/${id}/files/write`, content, {
      params: { file: path },
      headers: { 'Content-Type': 'text/plain' },
    });
  } catch (error) {
    throw apiError(error);
  }
}

async function getRconConfig(id) {
  assertMap(id);
  try {
    const api = client();
    const [detail, file] = await Promise.all([
      api.get(`/servers/${id}`),
      api.get(`/servers/${id}/files/contents`, {
        params: { file: '/ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini' },
        responseType: 'text',
      }),
    ]);
    const content = typeof file.data === 'string' ? file.data : '';
    const port = Number(content.match(/^\s*RCONPort\s*=\s*(\d+)\s*$/im)?.[1]);
    const enabled = /^\s*RCONEnabled\s*=\s*True\s*$/im.test(content);
    const allocations = detail.data?.attributes?.relationships?.allocations?.data || [];
    return {
      id, enabled, port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : null,
      allocated: allocations.some(a => Number(a.attributes?.port) === port),
      method: 'console GPanel (RCON direct non authentifié)',
    };
  } catch (error) {
    throw apiError(error);
  }
}

async function getActivity(id) {
  assertMap(id);
  try {
    const api = client();
    const first = (await api.get(`/servers/${id}/activity`)).data;
    const lastPage = first.meta?.pagination?.total_pages || 1;
    const last = lastPage > 1 ? (await api.get(`/servers/${id}/activity`, { params: { page: lastPage } })).data : first;
    return (last.data || []).map(item => {
      const a = item.attributes || {};
      return { id: a.id, event: a.event, timestamp: a.timestamp,
        // Ne jamais renvoyer les autres commandes console ni leurs paramètres.
        isWildWipe: a.event === 'server:console.command' &&
          /^(?:cheat |admincheat )?DestroyWildDinos$/i.test(String(a.properties?.command || '').trim()) };
    }).filter(a => /^server:power\.(restart|stop|start)$/.test(a.event) || a.isWildWipe);
  } catch (error) {
    throw apiError(error);
  }
}

function panelStatus(state) {
  switch (state) {
    case 'running': return { label: '🟢 En ligne', color: 0x2ecc71 };
    case 'offline': return { label: '🔴 Éteint', color: 0xe74c3c };
    case 'starting':
    case 'stopping':
    case 'restarting': return { label: '🟡 En transition', color: 0xf39c12 };
    case 'suspended': return { label: '⛔ Suspendu', color: 0xe74c3c };
    default: return { label: '⚫ Inconnu', color: 0x95a5a6 };
  }
}

function buildPanelEmbed(map, server) {
  const status = panelStatus(server.state);
  return new EmbedBuilder()
    .setColor(status.color)
    .setTitle(`🗺️ ${map.name}`)
    .addFields(
      { name: '📡 État', value: status.label, inline: true },
      { name: '👥 Joueurs', value: 'Liste indisponible via GPanel', inline: true },
    )
    .setFooter({ text: `Serveur Legion : ${map.id}` })
    .setTimestamp();
}

function buildPanelButtons(mapId, state) {
  assertMap(mapId);
  const row = new ActionRowBuilder().addComponents(
    state === 'running'
      ? new ButtonBuilder().setCustomId(`srvp_stop::${mapId}`).setLabel('🔴 Éteindre').setStyle(ButtonStyle.Danger)
      : new ButtonBuilder().setCustomId(`srvp_start::${mapId}`).setLabel('🟢 Allumer').setStyle(ButtonStyle.Success)
          .setDisabled(state !== 'offline'),
    new ButtonBuilder().setCustomId(`srvp_restart::${mapId}`).setLabel('🔄 Redémarrer').setStyle(ButtonStyle.Primary)
      .setDisabled(!['running', 'offline'].includes(state)),
    new ButtonBuilder().setCustomId(`srvp_destroy::${mapId}`).setLabel('☠️ Destroy Dinos')
      .setStyle(ButtonStyle.Danger).setDisabled(state !== 'running'),
    new ButtonBuilder().setCustomId(`srvp_players::${mapId}`).setLabel('👥 Joueurs')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`srvp_refresh::${mapId}`).setLabel('🔃 Actualiser')
      .setStyle(ButtonStyle.Secondary),
  );
  return [row];
}

function buildGlobalPanel() {
  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('srvp_restart_all').setLabel('🔄 Redémarrer toutes les maps')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('srvp_destroy_all').setLabel('☠️ Destroy Dinos (toutes maps)')
        .setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('srvp_players_all').setLabel('👥 Toutes les listes de joueurs')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('srvp_refresh_all').setLabel('🔃 Tout actualiser')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
  const mapList = MAPS.map(map => `🗺️ **${map.name}**`).join('\n');
  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('🖥️ Contrôles Globaux')
    .setDescription(`Gérer **${MAPS.length} maps** simultanément :\n${mapList}\n\n⚠️ Les actions globales visent uniquement ces 12 maps.`)
    .setTimestamp();
  return { embed, components: rows };
}

function panelAuthorized(interaction) {
  const settings = getSettings().serverPanel || {};
  const roleIds = settings.adminRoleIds || [];
  if (!roleIds.length) return interaction.member?.permissions?.has('Administrator') ?? false;
  return interaction.member?.roles?.cache?.some(role => roleIds.includes(role.id)) ?? false;
}

function panelJournal() {
  return require('./legionJournal');
}

async function handleServerPanelCommand(interaction) {
  if (!panelAuthorized(interaction)) {
    return interaction.reply({ content: '❌ Accès refusé — réservé aux administrateurs.', ephemeral: true });
  }
  await interaction.deferReply({ ephemeral: true });
  try {
    const servers = await getServers();
    for (const map of MAPS) {
      const server = servers.find(item => item.id === map.id);
      if (!server) throw new Error(`Serveur Legion introuvable : ${map.name}`);
      await interaction.channel.send({
        embeds: [buildPanelEmbed(map, server)],
        components: buildPanelButtons(map.id, server.state),
      });
    }
    const global = buildGlobalPanel();
    await interaction.channel.send({ embeds: [global.embed], components: global.components });
    return interaction.editReply('✅ Panneau Legion publié (12 maps autorisées).');
  } catch (error) {
    return interaction.editReply(`❌ Impossible de publier le panneau Legion : ${error.message}`);
  }
}

function parsePanelButton(customId) {
  const globalActions = new Set(['restart_all', 'destroy_all', 'players_all', 'refresh_all']);
  if (typeof customId === 'string' && customId.startsWith('srvp_') &&
      globalActions.has(customId.slice('srvp_'.length))) {
    return { action: customId.slice('srvp_'.length), global: true };
  }
  const match = /^srvp_(restart|start|stop|destroy|players|refresh)::([a-f0-9]{8})$/.exec(customId);
  if (!match) throw new Error('Bouton ou action invalide');
  assertMap(match[2]);
  return { action: match[1], mapId: match[2], global: false };
}

async function getPlayerList(mapId) {
  assertMap(mapId);
  // GPanel may acknowledge ListPlayers without returning console output. Only
  // display names actually present in a text response; never infer a list.
  try {
    const response = await client().post(`/servers/${mapId}/command`, { command: 'ListPlayers' });
    const payload = response.data;
    const raw = typeof payload === 'string' ? payload
      : typeof payload?.message === 'string' ? payload.message
        : typeof payload?.output === 'string' ? payload.output : '';
    const lines = raw.split(/\r?\n/).map(line => line.trim())
      .filter(line => /^\d+\./.test(line))
      .map(line => `• **${line.replace(/^\d+\.\s*/, '').split(',')[0].trim()}**`)
      .filter(line => line !== '• ****');
    if (lines.length) return lines;
    if (/no players connected/i.test(raw)) return ['*Aucun joueur connecté.*'];
    return ['*Liste nominative indisponible : GPanel n’a pas renvoyé de texte exploitable pour ListPlayers.*'];
  } catch (error) {
    throw apiError(error);
  }
}

async function handleServerPanelInteraction(interaction) {
  if (!panelAuthorized(interaction)) {
    return interaction.reply({ content: '❌ Accès refusé — réservé aux administrateurs.', ephemeral: true });
  }
  let parsed;
  try {
    parsed = parsePanelButton(interaction.customId);
  } catch (error) {
    return interaction.reply({ content: `❌ ${error.message}.`, ephemeral: true });
  }

  const { action, mapId, global } = parsed;
  if (global && action === 'refresh_all') {
    await interaction.deferReply({ ephemeral: true });
    return interaction.editReply('ℹ️ Pour actualiser tous les panneaux, relancez la commande du panneau dans le salon souhaité.');
  }

  await interaction.deferReply({ ephemeral: true });
  const journal = panelJournal();
  const actor = interaction.member?.displayName || interaction.user.username;
  const ids = global ? MAPS.map(map => map.id) : [mapId];
  // Validate the complete target list before any API request/action.
  try {
    journal.validateIds(ids);
  } catch (error) {
    return interaction.editReply(`❌ ${error.message}`);
  }

  if (action === 'refresh') {
    try {
      const server = (await getServers()).find(item => item.id === mapId);
      if (!server) throw new Error('Serveur Legion introuvable');
      const map = MAPS.find(item => item.id === mapId);
      await interaction.message.edit({
        embeds: [buildPanelEmbed(map, server)],
        components: buildPanelButtons(mapId, server.state),
      });
      return interaction.editReply(`✅ **${map.name}** — statut actualisé.`);
    } catch (error) {
      return interaction.editReply(`❌ Erreur actualisation : ${error.message}`);
    }
  }

  if (action === 'players' || action === 'players_all') {
    try {
      const lists = await Promise.all(ids.map(async id => {
        const map = MAPS.find(item => item.id === id);
        return { map, lines: await getPlayerList(id) };
      }));
      let text = lists.map(({ map, lines }) => `### ${map.name}\n${lines.join('\n')}`).join('\n\n');
      if (text.length > 1950) text = `${text.slice(0, 1947)}…`;
      return interaction.editReply(`## 👥 ${global ? 'Joueurs — toutes les maps' : MAPS.find(map => map.id === mapId).name}\n\n${text}`);
    } catch (error) {
      return interaction.editReply(`❌ Liste des joueurs indisponible : ${error.message}`);
    }
  }

  const eventType = action === 'destroy' || action === 'destroy_all' ? 'wild_dinos' : action.replace('_all', '');
  if (!['restart', 'start', 'stop', 'wild_dinos'].includes(eventType)) {
    return interaction.editReply('❌ Action inconnue.');
  }
  let results;
  try {
    results = await journal.executeMany(ids, eventType, 'discord_panel', actor);
  } catch (error) {
    return interaction.editReply(`❌ Action Legion impossible : ${error.message}`);
  }
  const lines = results.map(result => {
    const map = MAPS.find(item => item.id === result.id);
    return result.ok
      ? `✅ **${map.name}** — ${eventType === 'wild_dinos' ? 'commande envoyée' : `${eventType} lancé`}`
      : `❌ **${map.name}** — ${result.error || 'Erreur'}`;
  });

  if (!global && action !== 'destroy') {
    try {
      await new Promise(resolve => setTimeout(resolve, 3000));
      const server = (await getServers()).find(item => item.id === mapId);
      if (server) {
        const map = MAPS.find(item => item.id === mapId);
        await interaction.message.edit({
          embeds: [buildPanelEmbed(map, server)],
          components: buildPanelButtons(mapId, server.state),
        });
      }
    } catch { /* L'action est déjà reportée ; le panneau reste inchangé si le statut échoue. */ }
  }
  return interaction.editReply(lines.join('\n'));
}

module.exports = {
  MAPS, getServers, getMapState, power, wipeWildDinos, getActivity, assertMap, readFile, writeFile, getRconConfig, sendCommand,
  handleServerPanelCommand, handleServerPanelInteraction,
};