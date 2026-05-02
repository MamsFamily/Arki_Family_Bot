'use strict';

const cron = require('node-cron');
const pgStore = require('./pgStore');
const { getSettings } = require('./settingsManager');
const { updateIniKeyMapped, restartServer } = require('./web/nitradoManager');
const { EmbedBuilder } = require('discord.js');

const SESSIONS_KEY = 'booster_sessions';

// ── Persistence (stocké dans app_data) ───────────────────────────────────────

async function loadSessions() {
  const data = await pgStore.getData(SESSIONS_KEY);
  return Array.isArray(data) ? data : [];
}

async function saveSessions(sessions) {
  await pgStore.setData(SESSIONS_KEY, sessions);
}

async function createSession({ userId, username, serviceId, mapDisplayName, itemName, durationHours, expiresAt, iniBackup }) {
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
  const ended = sessions.filter(s => s.serviceId === serviceId && s.status !== 'active');
  if (!ended.length) return null;
  return ended.sort((a, b) => new Date(b.expiresAt) - new Date(a.expiresAt))[0];
}

async function getAllActiveSessions() {
  const sessions = await loadSessions();
  const now = Date.now();
  return sessions.filter(s => s.status === 'active' && new Date(s.expiresAt).getTime() > now);
}

async function endSession(sessionId) {
  const sessions = await loadSessions();
  const idx = sessions.findIndex(s => s.id === sessionId);
  if (idx === -1) return;
  sessions[idx].status = 'ended';
  await saveSessions(sessions);
}

async function cancelSession(sessionId) {
  const sessions = await loadSessions();
  const idx = sessions.findIndex(s => s.id === sessionId);
  if (idx === -1) return;
  sessions[idx].status = 'cancelled';
  await saveSessions(sessions);
}

// ── INI Apply / Restore ───────────────────────────────────────────────────────

async function applyBoostIni(serviceId, boosterSettings) {
  const { iniKey1, iniKey2 } = boosterSettings;
  const errors = [];

  try {
    await updateIniKeyMapped(serviceId, iniKey1.key, String(iniKey1.boostValue));
    console.log(`[BoosterRepro] ✅ ${iniKey1.key}=${iniKey1.boostValue} appliqué sur ${serviceId}`);
  } catch (e) {
    console.error(`[BoosterRepro] Erreur ${iniKey1.key}:`, e.message);
    errors.push(`${iniKey1.key}: ${e.message}`);
  }

  try {
    await updateIniKeyMapped(serviceId, iniKey2.key, String(iniKey2.boostValue));
    console.log(`[BoosterRepro] ✅ ${iniKey2.key}=${iniKey2.boostValue} appliqué sur ${serviceId}`);
  } catch (e) {
    console.error(`[BoosterRepro] Erreur ${iniKey2.key}:`, e.message);
    errors.push(`${iniKey2.key}: ${e.message}`);
  }

  if (errors.length) throw new Error(errors.join(' | '));
}

async function restoreNormalIni(serviceId, iniBackup, boosterSettings) {
  const { iniKey1, iniKey2 } = boosterSettings;
  const val1 = iniBackup?.key1 || iniKey1.normalValue;
  const val2 = iniBackup?.key2 || iniKey2.normalValue;

  try {
    await updateIniKeyMapped(serviceId, iniKey1.key, String(val1));
    console.log(`[BoosterRepro] ✅ ${iniKey1.key}=${val1} restauré sur ${serviceId}`);
  } catch (e) {
    console.error(`[BoosterRepro] Erreur restauration ${iniKey1.key}:`, e.message);
  }

  try {
    await updateIniKeyMapped(serviceId, iniKey2.key, String(val2));
    console.log(`[BoosterRepro] ✅ ${iniKey2.key}=${val2} restauré sur ${serviceId}`);
  } catch (e) {
    console.error(`[BoosterRepro] Erreur restauration ${iniKey2.key}:`, e.message);
  }
}

// ── Vérification des sessions expirées (cron) ─────────────────────────────────

async function checkExpiredSessions(discordClient) {
  const sessions = await loadSessions();
  const now = Date.now();
  const settings = (getSettings().boosterRepro) || {};

  const expired = sessions.filter(
    s => s.status === 'active' && new Date(s.expiresAt).getTime() <= now,
  );
  if (!expired.length) return;

  for (const session of expired) {
    console.log(`[BoosterRepro] Session expirée détectée: ${session.id} (${session.mapDisplayName})`);

    try {
      await restoreNormalIni(session.serviceId, session.iniBackup, settings);
    } catch (e) {
      console.error(`[BoosterRepro] Erreur restauration INI session ${session.id}:`, e.message);
    }

    try {
      await restartServer(session.serviceId, 'Fin du booster de reproduction — restauration des paramètres');
      console.log(`[BoosterRepro] Redémarrage lancé pour ${session.mapDisplayName}`);
    } catch (e) {
      console.error(`[BoosterRepro] Erreur redémarrage session ${session.id}:`, e.message);
    }

    await endSession(session.id);

    if (discordClient && settings.notifChannelId) {
      try {
        const ch = discordClient.channels.cache.get(settings.notifChannelId);
        if (ch) {
          const expiresTs = Math.floor(new Date(session.expiresAt).getTime() / 1000);
          await ch.send({
            embeds: [new EmbedBuilder()
              .setTitle('🔴 Booster Repro terminé')
              .setColor(0xe74c3c)
              .setDescription(
                `Le booster de reproduction sur **${session.mapDisplayName}** est terminé.\n` +
                `Activé par <@${session.userId}> · Durée : **${session.durationHours}h**\n\n` +
                `La map redémarre pour restaurer les paramètres normaux.`,
              )
              .setTimestamp()
            ],
          });
        }
      } catch (e) {
        console.error('[BoosterRepro] Erreur notification fin:', e.message);
      }
    }
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

let _client = null;

function init(discordClient) {
  _client = discordClient;

  cron.schedule('* * * * *', async () => {
    try {
      await checkExpiredSessions(_client);
    } catch (e) {
      console.error('[BoosterRepro] Erreur cron:', e.message);
    }
  });

  console.log('[BoosterRepro] ✅ Système initialisé (cron actif)');
}

module.exports = {
  init,
  createSession,
  getActiveSessionForMap,
  getLastSessionForMap,
  getAllActiveSessions,
  endSession,
  cancelSession,
  applyBoostIni,
  restoreNormalIni,
  loadSessions,
};
