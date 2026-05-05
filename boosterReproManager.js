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
    iniBackup:  iniBackup  || {},   // { key1: valeurNormale1, key2: valeurNormale2 }
    iniConfig:  iniConfig  || {},   // { key1Name: 'MatingIntervalMultiplier', key2Name: '...' }
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
// itemConfig = { iniKey1: { key, boostValue }, iniKey2: { key, boostValue } }

async function applyBoostIni(serviceId, itemConfig) {
  const { iniKey1, iniKey2 } = itemConfig;
  const errors = [];

  if (iniKey1 && iniKey1.key) {
    try {
      await updateIniKeyMapped(serviceId, iniKey1.key, String(iniKey1.boostValue));
      console.log(`[BoosterRepro] ✅ ${iniKey1.key}=${iniKey1.boostValue} appliqué sur ${serviceId}`);
    } catch (e) {
      console.error(`[BoosterRepro] Erreur ${iniKey1.key}:`, e.message);
      errors.push(`${iniKey1.key}: ${e.message}`);
    }
  }

  if (iniKey2 && iniKey2.key) {
    try {
      await updateIniKeyMapped(serviceId, iniKey2.key, String(iniKey2.boostValue));
      console.log(`[BoosterRepro] ✅ ${iniKey2.key}=${iniKey2.boostValue} appliqué sur ${serviceId}`);
    } catch (e) {
      console.error(`[BoosterRepro] Erreur ${iniKey2.key}:`, e.message);
      errors.push(`${iniKey2.key}: ${e.message}`);
    }
  }

  if (errors.length) throw new Error(errors.join(' | '));
}

// Restaure les valeurs normales à partir des données stockées dans la session
// session.iniConfig = { key1Name, key2Name }
// session.iniBackup = { key1, key2 }
async function restoreNormalIni(serviceId, session, fallbackItemConfig) {
  // Priorité : infos stockées dans la session → fallback sur itemConfig
  const key1Name = session.iniConfig?.key1Name || fallbackItemConfig?.iniKey1?.key;
  const key2Name = session.iniConfig?.key2Name || fallbackItemConfig?.iniKey2?.key;
  const val1     = session.iniBackup?.key1     || fallbackItemConfig?.iniKey1?.normalValue || '1.0';
  const val2     = session.iniBackup?.key2     || fallbackItemConfig?.iniKey2?.normalValue || '1.0';

  if (key1Name) {
    try {
      await updateIniKeyMapped(serviceId, key1Name, String(val1));
      console.log(`[BoosterRepro] ✅ ${key1Name}=${val1} restauré sur ${serviceId}`);
    } catch (e) {
      console.error(`[BoosterRepro] Erreur restauration ${key1Name}:`, e.message);
    }
  }

  if (key2Name) {
    try {
      await updateIniKeyMapped(serviceId, key2Name, String(val2));
      console.log(`[BoosterRepro] ✅ ${key2Name}=${val2} restauré sur ${serviceId}`);
    } catch (e) {
      console.error(`[BoosterRepro] Erreur restauration ${key2Name}:`, e.message);
    }
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

    // Retrouver la config de l'item pour avoir le fallback INI
    const itemConfig = (settings.items || []).find(i => i.itemName === session.itemName) || null;

    try {
      await restoreNormalIni(session.serviceId, session, itemConfig);
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
