'use strict';

/**
 * serverPanelCommand.js — Panneau de contrôle des maps de jeu (Discord)
 *
 * Slash command : /serveur-panel
 *   → Publie un embed par map (statut, joueurs, boutons) + un embed global
 *
 * Boutons (prefix srvp_) :
 *   srvp_restart::{serviceId}  — Redémarre une map
 *   srvp_stop::{serviceId}     — Éteint une map
 *   srvp_start::{serviceId}    — Allume une map
 *   srvp_destroy::{serviceId}  — DestroyWildDinos sur une map
 *   srvp_refresh::{serviceId}  — Actualise le statut d'une map
 *   srvp_restart_all           — Redémarre toutes les maps
 *   srvp_destroy_all           — DestroyWildDinos sur toutes les maps
 *   srvp_refresh_all           — Actualise tous les embeds
 *
 * Config (settings.serverPanel) :
 *   adminRoleIds  — IDs rôles autorisés (vide = Administrator uniquement)
 *   maps          — [{ id, serviceId, displayName, emoji }]
 */

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');

const { getSettings } = require('./settingsManager');
const {
  getServerDetails,
  restartServer,
  stopServer,
  startServer,
  sendRcon,
  restartAll,
  sendRconToMany,
} = require('./web/nitradoManager');

const PREFIX = 'srvp';

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS SETTINGS
// ══════════════════════════════════════════════════════════════════════════════

function getPanelSettings() {
  return getSettings().serverPanel || {};
}

function getMaps() {
  // Réutilise la liste de maps configurée dans Dashboard → 🧬 Booster Repro
  return (getSettings().boosterRepro || {}).maps || [];
}

function isAuthorized(interaction) {
  const s = getPanelSettings();
  const adminRoleIds = s.adminRoleIds || [];
  if (!adminRoleIds.length) {
    return interaction.member?.permissions?.has('Administrator') ?? false;
  }
  return interaction.member?.roles?.cache?.some(r => adminRoleIds.includes(r.id)) ?? false;
}

// ══════════════════════════════════════════════════════════════════════════════
// STATUS HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function statusInfo(status) {
  switch (status) {
    case 'started':    return { label: '🟢 En ligne',       color: 0x2ecc71 };
    case 'stopped':    return { label: '🔴 Éteint',         color: 0xe74c3c };
    case 'restarting': return { label: '🟡 En redémarrage', color: 0xf39c12 };
    default:           return { label: '⚫ Inconnu',         color: 0x95a5a6 };
  }
}

async function fetchMapStatus(serviceId) {
  try {
    const gs = await getServerDetails(serviceId);
    if (!gs) return { status: 'unknown', playersOnline: 0, playersMax: 0, mapName: '' };
    const mapRaw = gs.query?.map || gs.settings?.general?.map || gs.settings?.map || '';
    const mapName = mapRaw
      .replace(/_WP$/i, '').replace(/_P$/i, '')
      .replace(/^Athena$/i, 'Lost Island').trim();
    return {
      status:        gs.status || 'unknown',
      playersOnline: gs.query?.player_current ?? 0,
      playersMax:    gs.query?.player_max     ?? 0,
      mapName,
    };
  } catch (e) {
    console.error(`[ServerPanel] fetchMapStatus ${serviceId}:`, e.message);
    return { status: 'unknown', playersOnline: 0, playersMax: 0, mapName: '' };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// EMBED BUILDERS
// ══════════════════════════════════════════════════════════════════════════════

function buildMapEmbed(map, detail) {
  const { status, playersOnline, playersMax, mapName } = detail;
  const si = statusInfo(status);
  const em = map.emoji || '🗺️';

  return new EmbedBuilder()
    .setColor(si.color)
    .setTitle(`${em} ${map.displayName}`)
    .addFields(
      { name: '📡 État',     value: si.label,                                 inline: true },
      { name: '👥 Joueurs',  value: `**${playersOnline}** / ${playersMax || '?'}`, inline: true },
      { name: '🗺️ Carte',   value: mapName || '*N/A*',                       inline: true },
    )
    .setFooter({ text: `Service ID : ${map.serviceId}` })
    .setTimestamp();
}

function buildMapButtons(serviceId, status) {
  const isOnline     = status === 'started';
  const isOff        = status === 'stopped';
  const isRestarting = status === 'restarting';

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}_restart::${serviceId}`)
      .setLabel('🔄 Redémarrer')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(isRestarting),

    isOnline
      ? new ButtonBuilder()
          .setCustomId(`${PREFIX}_stop::${serviceId}`)
          .setLabel('🔴 Éteindre')
          .setStyle(ButtonStyle.Danger)
      : new ButtonBuilder()
          .setCustomId(`${PREFIX}_start::${serviceId}`)
          .setLabel('🟢 Allumer')
          .setStyle(ButtonStyle.Success)
          .setDisabled(!isOff),

    new ButtonBuilder()
      .setCustomId(`${PREFIX}_destroy::${serviceId}`)
      .setLabel('☠️ Destroy Dinos')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!isOnline),

    new ButtonBuilder()
      .setCustomId(`${PREFIX}_refresh::${serviceId}`)
      .setLabel('🔃 Actualiser')
      .setStyle(ButtonStyle.Secondary),
  );

  return [row];
}

function buildGlobalEmbed(maps) {
  const mapList = maps.map(m => `${m.emoji || '🗺️'} **${m.displayName}**`).join('\n');
  return new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('🖥️ Contrôles Globaux')
    .setDescription(
      `Gérer **${maps.length} map(s)** simultanément :\n${mapList}\n\n` +
      `⚠️ Les actions ci-dessous s'appliquent à **toutes** les maps listées.`,
    )
    .setTimestamp();
}

function buildGlobalButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${PREFIX}_restart_all`)
        .setLabel('🔄 Redémarrer toutes les maps')
        .setStyle(ButtonStyle.Primary),

      new ButtonBuilder()
        .setCustomId(`${PREFIX}_destroy_all`)
        .setLabel('☠️ Destroy Dinos (toutes maps)')
        .setStyle(ButtonStyle.Danger),

      new ButtonBuilder()
        .setCustomId(`${PREFIX}_refresh_all`)
        .setLabel('🔃 Tout actualiser')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ══════════════════════════════════════════════════════════════════════════════
// SLASH COMMAND : /serveur-panel
// ══════════════════════════════════════════════════════════════════════════════

async function handleServerPanelCommand(interaction) {
  if (!isAuthorized(interaction)) {
    return interaction.reply({ content: '❌ Accès refusé — réservé aux administrateurs.', ephemeral: true });
  }

  const maps = getMaps();
  if (!maps.length) {
    return interaction.reply({
      content: [
        '❌ Aucune map configurée.',
        'Configure les maps dans le Dashboard → **🖥️ Panneau Serveurs** → Maps.',
      ].join('\n'),
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  // Publier un embed par map
  for (const map of maps) {
    try {
      const detail = await fetchMapStatus(map.serviceId);
      await interaction.channel.send({
        embeds: [buildMapEmbed(map, detail)],
        components: buildMapButtons(map.serviceId, detail.status),
      });
    } catch (e) {
      console.error(`[ServerPanel] Erreur post map ${map.serviceId}:`, e.message);
      await interaction.channel.send({
        content: `⚠️ Impossible de récupérer le statut de **${map.displayName}** (service \`${map.serviceId}\`) : ${e.message}`,
      });
    }
  }

  // Publier les contrôles globaux
  await interaction.channel.send({
    embeds: [buildGlobalEmbed(maps)],
    components: buildGlobalButtons(),
  });

  await interaction.editReply('✅ Panneau publié !');
}

// ══════════════════════════════════════════════════════════════════════════════
// INTERACTION HANDLERS (boutons srvp_)
// ══════════════════════════════════════════════════════════════════════════════

async function handleServerPanelInteraction(interaction) {
  if (!isAuthorized(interaction)) {
    return interaction.reply({ content: '❌ Accès refusé — réservé aux administrateurs.', ephemeral: true });
  }

  const id = interaction.customId;

  // ── Restart All ──────────────────────────────────────────────────────────
  if (id === `${PREFIX}_restart_all`) {
    await interaction.deferReply({ ephemeral: true });
    const maps = getMaps();
    if (!maps.length) return interaction.editReply('❌ Aucune map configurée.');

    const serviceIds = maps.map(m => m.serviceId);
    const results = await restartAll(serviceIds, 'Redémarrage global depuis le panneau Discord');

    const lines = maps.map(map => {
      const r = results.find(r => r.id === map.serviceId);
      return r?.ok
        ? `✅ **${map.displayName}** — redémarrage lancé`
        : `❌ **${map.displayName}** — ${r?.error || 'Erreur inconnue'}`;
    });
    return interaction.editReply(`🔄 **Redémarrage global lancé**\n\n${lines.join('\n')}`);
  }

  // ── Destroy All ──────────────────────────────────────────────────────────
  if (id === `${PREFIX}_destroy_all`) {
    await interaction.deferReply({ ephemeral: true });
    const maps = getMaps();
    if (!maps.length) return interaction.editReply('❌ Aucune map configurée.');

    const serviceIds = maps.map(m => m.serviceId);
    const rconResults = await sendRconToMany(serviceIds, 'DestroyWildDinos');

    const lines = maps.map(map => {
      const r = rconResults.find(r => r.id === map.serviceId);
      return r?.ok
        ? `✅ **${map.displayName}** — commande envoyée`
        : `❌ **${map.displayName}** — ${r?.error || 'Erreur RCON'}`;
    });
    return interaction.editReply(`☠️ **Destroy Dinos Sauvages — toutes maps**\n\n${lines.join('\n')}`);
  }

  // ── Refresh All ──────────────────────────────────────────────────────────
  if (id === `${PREFIX}_refresh_all`) {
    await interaction.deferReply({ ephemeral: true });
    return interaction.editReply('ℹ️ Pour actualiser tous les panneaux, relance `/serveur-panel` dans le salon souhaité.');
  }

  // ── Actions par map ──────────────────────────────────────────────────────
  const withoutPrefix = id.slice(`${PREFIX}_`.length);        // e.g. "restart::12345"
  const sep = withoutPrefix.indexOf('::');
  if (sep === -1) return interaction.reply({ content: '❌ Action inconnue.', ephemeral: true });

  const action    = withoutPrefix.slice(0, sep);              // "restart"
  const serviceId = withoutPrefix.slice(sep + 2);             // "12345"

  const maps  = getMaps();
  const map   = maps.find(m => m.serviceId === serviceId) || { displayName: serviceId, serviceId, emoji: '🗺️' };

  // Helper : rafraîchir l'embed après une action
  const refreshEmbed = async () => {
    try {
      await new Promise(r => setTimeout(r, 3000));
      const detail = await fetchMapStatus(serviceId);
      await interaction.message.edit({
        embeds:     [buildMapEmbed(map, detail)],
        components: buildMapButtons(serviceId, detail.status),
      });
    } catch (e) {
      console.warn(`[ServerPanel] refreshEmbed ${serviceId}:`, e.message);
    }
  };

  // ── Restart ──────────────────────────────────────────────────────────────
  if (action === 'restart') {
    await interaction.deferReply({ ephemeral: true });
    try {
      await restartServer(serviceId, 'Redémarrage depuis le panneau Discord');
      await interaction.editReply(`✅ **${map.displayName}** — redémarrage lancé.`);
      await refreshEmbed();
    } catch (e) {
      await interaction.editReply(`❌ Erreur : ${e.message}`);
    }
    return;
  }

  // ── Stop ─────────────────────────────────────────────────────────────────
  if (action === 'stop') {
    await interaction.deferReply({ ephemeral: true });
    try {
      await stopServer(serviceId);
      await interaction.editReply(`✅ **${map.displayName}** — extinction lancée.`);
      await refreshEmbed();
    } catch (e) {
      await interaction.editReply(`❌ Erreur : ${e.message}`);
    }
    return;
  }

  // ── Start ─────────────────────────────────────────────────────────────────
  if (action === 'start') {
    await interaction.deferReply({ ephemeral: true });
    try {
      await startServer(serviceId);
      await interaction.editReply(`✅ **${map.displayName}** — démarrage lancé.`);
      await refreshEmbed();
    } catch (e) {
      await interaction.editReply(`❌ Erreur : ${e.message}`);
    }
    return;
  }

  // ── Destroy Dinos ─────────────────────────────────────────────────────────
  if (action === 'destroy') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const result = await sendRcon(serviceId, 'DestroyWildDinos');
      const rconMsg = result?.data?.message || result?.message || 'Commande exécutée';
      await interaction.editReply(`☠️ **${map.displayName}** — Destroy Dinos Sauvages lancé.\n-# ${rconMsg}`);
    } catch (e) {
      await interaction.editReply(`❌ Erreur RCON : ${e.message}`);
    }
    return;
  }

  // ── Refresh ──────────────────────────────────────────────────────────────
  if (action === 'refresh') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const detail = await fetchMapStatus(serviceId);
      await interaction.message.edit({
        embeds:     [buildMapEmbed(map, detail)],
        components: buildMapButtons(serviceId, detail.status),
      });
      await interaction.editReply(`✅ **${map.displayName}** — statut actualisé.`);
    } catch (e) {
      await interaction.editReply(`❌ Erreur actualisation : ${e.message}`);
    }
    return;
  }

  return interaction.reply({ content: '❌ Action inconnue.', ephemeral: true });
}

module.exports = {
  handleServerPanelCommand,
  handleServerPanelInteraction,
};
