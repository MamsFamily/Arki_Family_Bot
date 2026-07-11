'use strict';

const cron = require('node-cron');
const pgStore = require('./pgStore');
const { getSettings } = require('./settingsManager');
const { updateIniKeyMapped, restartServer } = require('./web/nitradoManager');
const { EmbedBuilder } = require('discord.js');

const SESSIONS_KEY = 'booster_sessions';
const COOLDOWN_DAYS = 7;
const RESTART_DELAY_MIN = 15;

// ── Persistence ───────────────────────────────────────────────────────────────

async function loadSessions() {
  const data = await pgStore.getData(SESSIONS_KEY);
  return Array.isArray(data) ? data : [];
}

async function saveSessions(sessions) {
  await pgStore.setData(SESSIONS_KEY, sessions);
}

async function updateSession(sessionId, patch) {
  const sessions = await loadSessions();
  const idx = sessions.findIndex(s => s.id === sessionId);
  if (idx === -1) return;
  sessions[idx] = { ...sessions[idx], ...patch };
  await saveSessions(sessions);
  return sessions[idx];
}

async function createSession({ userId, username, serviceId, mapDisplayName, itemName, durationHours, expiresAt, iniBackup, iniConfig }) {
  const sessions = await loadSessions();
  const session = {
    id: `${Date.now()}_${userId}`,
    userId,
    username,
    serviceId,
    mapDisplayName,
    itemName,
    durationHours,
    startedAt:  new Date().toISOString(),
    expiresAt:  new Date(expiresAt).toISOString(),
    status:     'active',
    iniBackup:  iniBackup || {},
    iniConfig:  iniConfig || {},
    // Flags de warnings pour ne pas renvoyer deux fois le même message
    warns: {
      // Activation : notif redémarrage imminent
      startWarn10: false,
      startWarn5:  false,
      startReboot: false,  // redémarrage d'activation effectué
      // Fin de boost : alertes pre-fin
      endWarn15:   false,
      endWarn10:   false,
      endWarn5:    false,
      // Restauration : notif redémarrage de fin
      restoreWarn10: false,
      restoreWarn5:  false,
      restoreReboot: false, // redémarrage de restauration effectué
    },
    // Timestamp prévu du redémarrage d'activation (startedAt + 15 min)
    activationRebootAt: new Date(Date.now() + RESTART_DELAY_MIN * 60 * 1000).toISOString(),
    // Timestamp prévu du redémarrage de restauration (expiresAt + 15 min)
    restoreRebootAt: null,
  };
  sessions.push(session);
  await saveSessions(sessions);
  return session;
}

async function getActiveSessionForMap(serviceId) {
  const sessions = await loadSessions();
  const now = Date.now();
  return sessions.find(
    s => s.serviceId === serviceId &&
         s.status === 'active' &&
         new Date(s.expiresAt).getTime() > now,
  ) || null;
}

async function getLastSessionForMap(serviceId) {
  const sessions = await loadSessions();
  const all = sessions.filter(s => s.serviceId === serviceId);
  if (!all.length) return null;
  return all.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))[0];
}

async function getAllActiveSessions() {
  const sessions = await loadSessions();
  const now = Date.now();
  return sessions.filter(s => s.status === 'active' && new Date(s.expiresAt).getTime() > now);
}

async function endSession(sessionId) {
  return updateSession(sessionId, { status: 'ended' });
}

async function cancelSession(sessionId) {
  return updateSession(sessionId, { status: 'cancelled' });
}

// ── Cooldown hebdomadaire ─────────────────────────────────────────────────────

async function getCooldownInfo(serviceId) {
  const last = await getLastSessionForMap(serviceId);
  if (!last) return { onCooldown: false };
  const cooldownUntil = new Date(last.startedAt).getTime() + COOLDOWN_DAYS * 24 * 3600 * 1000;
  if (Date.now() < cooldownUntil) {
    return { onCooldown: true, cooldownUntil, last };
  }
  return { onCooldown: false };
}

// ── INI Apply / Restore ───────────────────────────────────────────────────────

async function applyBoostIni(serviceId, itemConfig) {
  const { iniKey1, iniKey2 } = itemConfig;
  const errors = [];
  if (iniKey1?.key) {
    try {
      await updateIniKeyMapped(serviceId, iniKey1.key, String(iniKey1.boostValue));
    } catch (e) { errors.push(`${iniKey1.key}: ${e.message}`); }
  }
  if (iniKey2?.key) {
    try {
      await updateIniKeyMapped(serviceId, iniKey2.key, String(iniKey2.boostValue));
    } catch (e) { errors.push(`${iniKey2.key}: ${e.message}`); }
  }
  if (errors.length) throw new Error(errors.join(' | '));
}

async function restoreNormalIni(serviceId, session, fallbackItemConfig) {
  const key1Name = session.iniConfig?.key1Name || fallbackItemConfig?.iniKey1?.key;
  const key2Name = session.iniConfig?.key2Name || fallbackItemConfig?.iniKey2?.key;
  const val1     = session.iniBackup?.key1     || fallbackItemConfig?.iniKey1?.normalValue || '1.0';
  const val2     = session.iniBackup?.key2     || fallbackItemConfig?.iniKey2?.normalValue || '1.0';

  if (key1Name) {
    try { await updateIniKeyMapped(serviceId, key1Name, String(val1)); }
    catch (e) { console.error(`[BoosterRepro] Erreur restauration ${key1Name}:`, e.message); }
  }
  if (key2Name) {
    try { await updateIniKeyMapped(serviceId, key2Name, String(val2)); }
    catch (e) { console.error(`[BoosterRepro] Erreur restauration ${key2Name}:`, e.message); }
  }
}

// ── Helpers notification ──────────────────────────────────────────────────────

function sendNotif(discordClient, channelId, embedData) {
  if (!discordClient || !channelId) return;
  const ch = discordClient.channels.cache.get(channelId);
  if (!ch) return;
  ch.send({ embeds: [new EmbedBuilder(embedData)] }).catch(() => {});
}

function fmtTs(date) {
  return Math.floor(new Date(date).getTime() / 1000);
}

// ── Cron principal ────────────────────────────────────────────────────────────

async function tick(discordClient) {
  const sessions = await loadSessions();
  const now = Date.now();
  const settings = getSettings().boosterRepro || {};
  const channelId = settings.notifChannelId;

  for (const session of sessions) {
    if (session.status !== 'active') continue;

    const expiresAt       = new Date(session.expiresAt).getTime();
    const activationReboot = new Date(session.activationRebootAt).getTime();
    const warns           = session.warns || {};
    let dirty             = false;
    const patch           = { warns: { ...warns } };

    // ── Phase 1 : Redémarrage d'activation (15 min après activation) ──────────

    if (!warns.startReboot) {
      const minLeft = Math.round((activationReboot - now) / 60000);

      // Alerte -10 min avant redémarrage activation
      if (!warns.startWarn10 && minLeft <= 10 && minLeft > 5) {
        sendNotif(discordClient, channelId, {
          title: '⚠️ Redémarrage dans 10 minutes',
          color: 0xe67e22,
          description:
            `🗺️ **${session.mapDisplayName}** va redémarrer dans **10 minutes** pour appliquer le boost repro.\n` +
            `Déconnectez-vous avant le redémarrage !`,
          timestamp: new Date().toISOString(),
        });
        patch.warns.startWarn10 = true;
        dirty = true;
      }

      // Alerte -5 min avant redémarrage activation
      if (!warns.startWarn5 && minLeft <= 5 && minLeft > 0) {
        sendNotif(discordClient, channelId, {
          title: '🔴 Redémarrage dans 5 minutes !',
          color: 0xe74c3c,
          description:
            `🗺️ **${session.mapDisplayName}** redémarre dans **5 minutes** !\n` +
            `Dernière chance de vous déconnecter !`,
          timestamp: new Date().toISOString(),
        });
        patch.warns.startWarn5 = true;
        dirty = true;
      }

      // Redémarrage d'activation
      if (now >= activationReboot) {
        try {
          await restartServer(session.serviceId, 'Activation booster de reproduction');
          console.log(`[BoosterRepro] ✅ Redémarrage activation effectué pour ${session.mapDisplayName}`);
          sendNotif(discordClient, channelId, {
            title: '🟢 Boost Repro — Serveur redémarré !',
            color: 0x2ecc71,
            description:
              `🗺️ **${session.mapDisplayName}** redémarre maintenant !\n` +
              `Le boost de reproduction est actif. Bonne session !\n\n` +
              `🔴 Fin du boost : <t:${fmtTs(session.expiresAt)}:F> (<t:${fmtTs(session.expiresAt)}:R>)`,
            timestamp: new Date().toISOString(),
          });
        } catch (e) {
          console.error('[BoosterRepro] Erreur redémarrage activation:', e.message);
        }
        patch.warns.startReboot = true;
        dirty = true;
      }
    }

    // ── Phase 2 : Alertes avant fin de boost ─────────────────────────────────
    // Seulement après que le redémarrage d'activation a eu lieu

    if (warns.startReboot) {
      const minToExpiry = Math.round((expiresAt - now) / 60000);

      if (!warns.endWarn15 && minToExpiry <= 15 && minToExpiry > 10) {
        sendNotif(discordClient, channelId, {
          title: '⏳ Boost Repro — Fin dans 15 minutes',
          color: 0xe67e22,
          description:
            `🗺️ Le boost de reproduction sur **${session.mapDisplayName}** se termine dans **15 minutes**.\n` +
            `La map redémarrera ensuite pour restaurer les paramètres normaux.`,
          timestamp: new Date().toISOString(),
        });
        patch.warns.endWarn15 = true;
        dirty = true;
      }

      if (!warns.endWarn10 && minToExpiry <= 10 && minToExpiry > 5) {
        sendNotif(discordClient, channelId, {
          title: '⏳ Boost Repro — Fin dans 10 minutes',
          color: 0xe67e22,
          description:
            `🗺️ **${session.mapDisplayName}** — boost repro terminé dans **10 minutes**.\n` +
            `Préparez-vous, un redémarrage suivra.`,
          timestamp: new Date().toISOString(),
        });
        patch.warns.endWarn10 = true;
        dirty = true;
      }

      if (!warns.endWarn5 && minToExpiry <= 5 && minToExpiry > 0) {
        sendNotif(discordClient, channelId, {
          title: '🔴 Boost Repro — Fin dans 5 minutes !',
          color: 0xe74c3c,
          description:
            `🗺️ **${session.mapDisplayName}** — boost repro terminé dans **5 minutes** !\n` +
            `La map redémarrera juste après pour remettre les valeurs normales.`,
          timestamp: new Date().toISOString(),
        });
        patch.warns.endWarn5 = true;
        dirty = true;
      }

      // ── Phase 3 : Expiration → restauration INI + délai redémarrage ──────────
      if (now >= expiresAt && !session.restoreRebootAt) {
        const itemConfig = (settings.items || []).find(i => i.itemName === session.itemName) || null;
        try {
          await restoreNormalIni(session.serviceId, session, itemConfig);
          console.log(`[BoosterRepro] ✅ INI restauré pour ${session.mapDisplayName}`);
        } catch (e) {
          console.error(`[BoosterRepro] Erreur restauration INI:`, e.message);
        }

        const restoreRebootAt = new Date(now + RESTART_DELAY_MIN * 60 * 1000).toISOString();
        sendNotif(discordClient, channelId, {
          title: '🔴 Boost Repro terminé — Redémarrage dans 15 min',
          color: 0xe74c3c,
          description:
            `🗺️ Le boost de reproduction sur **${session.mapDisplayName}** est terminé.\n` +
            `Activé par <@${session.userId}> · Durée : **${session.durationHours}h**\n\n` +
            `La map redémarrera dans **15 minutes** pour restaurer les paramètres normaux.\n` +
            `Déconnectez-vous avant le redémarrage !`,
          timestamp: new Date().toISOString(),
        });

        patch.restoreRebootAt = restoreRebootAt;
        dirty = true;
      }

      // ── Phase 4 : Alertes + redémarrage de restauration ──────────────────────
      if (session.restoreRebootAt || patch.restoreRebootAt) {
        const restoreReboot = new Date(session.restoreRebootAt || patch.restoreRebootAt).getTime();
        const minToRestore  = Math.round((restoreReboot - now) / 60000);

        if (!warns.restoreWarn10 && minToRestore <= 10 && minToRestore > 5) {
          sendNotif(discordClient, channelId, {
            title: '⚠️ Redémarrage restauration dans 10 minutes',
            color: 0xe67e22,
            description: `🗺️ **${session.mapDisplayName}** redémarre dans **10 minutes** pour restaurer les paramètres normaux.`,
            timestamp: new Date().toISOString(),
          });
          patch.warns.restoreWarn10 = true;
          dirty = true;
        }

        if (!warns.restoreWarn5 && minToRestore <= 5 && minToRestore > 0) {
          sendNotif(discordClient, channelId, {
            title: '🔴 Redémarrage restauration dans 5 minutes !',
            color: 0xe74c3c,
            description: `🗺️ **${session.mapDisplayName}** — redémarrage dans **5 minutes** !`,
            timestamp: new Date().toISOString(),
          });
          patch.warns.restoreWarn5 = true;
          dirty = true;
        }

        if (!warns.restoreReboot && now >= restoreReboot) {
          try {
            await restartServer(session.serviceId, 'Fin du booster de reproduction — restauration des paramètres');
            console.log(`[BoosterRepro] ✅ Redémarrage restauration pour ${session.mapDisplayName}`);
            sendNotif(discordClient, channelId, {
              title: '✅ Serveur redémarré — Paramètres normaux restaurés',
              color: 0x95a5a6,
              description: `🗺️ **${session.mapDisplayName}** redémarre maintenant.\nLes paramètres de reproduction sont revenus à la normale.`,
              timestamp: new Date().toISOString(),
            });
          } catch (e) {
            console.error('[BoosterRepro] Erreur redémarrage restauration:', e.message);
          }
          patch.warns.restoreReboot = true;
          patch.status = 'ended';
          dirty = true;
        }
      }
    }

    if (dirty) {
      await updateSession(session.id, patch);
    }
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

let _client = null;

function init(discordClient) {
  _client = discordClient;
  cron.schedule('* * * * *', async () => {
    try { await tick(_client); }
    catch (e) { console.error('[BoosterRepro] Erreur cron:', e.message); }
  });
  console.log('[BoosterRepro] ✅ Système initialisé (cron actif)');
}

module.exports = {
  init,
  createSession,
  getActiveSessionForMap,
  getLastSessionForMap,
  getAllActiveSessions,
  getCooldownInfo,
  endSession,
  cancelSession,
  applyBoostIni,
  restoreNormalIni,
  loadSessions,
};
