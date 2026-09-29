'use strict';

const cron = require('node-cron');
const pgStore = require('./pgStore');
const { getSettings } = require('./settingsManager');
const legion = require('./web/legionManager');
const { EmbedBuilder } = require('discord.js');

const SESSIONS_KEY = 'booster_sessions';
const COOLDOWN_DAYS = 7;
const RESTART_DELAY_MIN = 15;
const GAME_INI_PATH = '/ShooterGame/Saved/Config/WindowsServer/Game.ini';
const BREEDING_KEYS = new Set([
  'MatingIntervalMultiplier',
  'MatingSpeedMultiplier',
  'EggHatchSpeedMultiplier',
  'BabyMatureSpeedMultiplier',
  'BabyFoodConsumptionSpeedMultiplier',
  'BabyImprintAmountMultiplier',
  'BabyImprintingStatScaleMultiplier',
  'BabyCuddleIntervalMultiplier',
  'BabyCuddleGracePeriodMultiplier',
  'BabyCuddleLoseImprintQualitySpeedMultiplier',
  'LayEggIntervalMultiplier',
]);
const BREEDING_SECTION = '/Script/ShooterGame.ShooterGameMode';

function assertLegionMap(id) {
  legion.assertMap(String(id || ''));
}

function assertIniFileApi() {
  if (typeof legion.readFile !== 'function' || typeof legion.writeFile !== 'function') {
    throw new Error('API fichiers Legion manquante : legionManager doit exposer readFile(id, path) et writeFile(id, path, content)');
  }
}

function validateBreedingKey(key) {
  if (!BREEDING_KEYS.has(key)) throw new Error(`Clé INI de reproduction non autorisée : ${key}`);
}

function validateFiniteValue(value, label) {
  const text = String(value ?? '').trim();
  const number = Number(text);
  if (!text || !Number.isFinite(number)) throw new Error(`Valeur numérique invalide pour ${label}`);
  return text;
}

function setIniKey(content, key, value) {
  validateBreedingKey(key);
  const hasBom = content.startsWith('\uFEFF');
  const body = hasBom ? content.slice(1) : content;
  const newline = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.split(/\r?\n/);
  const sectionHeader = `[${BREEDING_SECTION}]`;
  let inSection = false;
  let lastSection = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      inSection = trimmed.toLowerCase() === sectionHeader.toLowerCase();
      if (inSection) lastSection = i;
    } else if (inSection && trimmed.slice(0, trimmed.indexOf('=')).trim().toLowerCase() === key.toLowerCase() && trimmed.includes('=')) {
      lines[i] = `${key}=${String(value)}`;
      return `${hasBom ? '\uFEFF' : ''}${lines.join(newline)}`;
    }
  }
  if (lastSection === -1) {
    if (lines[lines.length - 1] !== '') lines.push('');
    lines.push(sectionHeader, `${key}=${String(value)}`);
  } else {
    let insertAt = lastSection + 1;
    while (insertAt < lines.length && !/^\s*\[.*\]\s*$/.test(lines[insertAt])) insertAt++;
    lines.splice(insertAt, 0, `${key}=${String(value)}`);
  }
  return `${hasBom ? '\uFEFF' : ''}${lines.join(newline)}`;
}

function readIniValue(content, key) {
  validateBreedingKey(key);
  const lines = String(content).replace(/^\uFEFF/, '').split(/\r?\n/);
  const sectionHeader = `[${BREEDING_SECTION}]`;
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      inSection = trimmed.toLowerCase() === sectionHeader.toLowerCase();
      continue;
    }
    const equals = trimmed.indexOf('=');
    if (inSection && equals > 0 && trimmed.slice(0, equals).trim().toLowerCase() === key.toLowerCase()) {
      const value = trimmed.slice(equals + 1).trim();
      return validateFiniteValue(value, key);
    }
  }
  throw new Error(`Clé ${key} introuvable dans ${GAME_INI_PATH}; activation refusée`);
}

async function readGameIni(mapId) {
  assertLegionMap(mapId);
  assertIniFileApi();
  const current = await legion.readFile(mapId, GAME_INI_PATH);
  if (typeof current !== 'string') throw new Error('Contenu Game.ini Legion invalide');
  return current;
}

function sessionOnApprovedMap(session) {
  try {
    assertLegionMap(session.serviceId);
    return true;
  } catch (error) {
    console.error(`[BoosterRepro] Session legacy ignorée (${session.id}) : ${error.message}`);
    return false;
  }
}

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
  assertLegionMap(serviceId);
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
    // Never trust configured "normal values" as the backup; applyBoostIni fills
    // this from the live Game.ini before writing any boost values.
    iniBackup:  {},
    iniConfig:  iniConfig || {},
    iniApplied: false,
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
  assertLegionMap(serviceId);
  const sessions = await loadSessions();
  const now = Date.now();
  return sessions.find(
    s => s.serviceId === serviceId &&
         s.status === 'active' &&
         new Date(s.expiresAt).getTime() > now,
  ) || null;
}

async function getLastSessionForMap(serviceId) {
  assertLegionMap(serviceId);
  const sessions = await loadSessions();
  const all = sessions.filter(s => s.serviceId === serviceId);
  if (!all.length) return null;
  return all.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))[0];
}

async function getAllActiveSessions() {
  const sessions = await loadSessions();
  const now = Date.now();
  return sessions.filter(s => s.status === 'active' && new Date(s.expiresAt).getTime() > now && sessionOnApprovedMap(s));
}

async function endSession(sessionId) {
  return updateSession(sessionId, { status: 'ended' });
}

async function cancelSession(sessionId) {
  const sessions = await loadSessions();
  const session = sessions.find(s => s.id === sessionId);
  if (!session) throw new Error('Session de booster introuvable');
  if (session.iniApplied) {
    throw new Error('Annulation refusée : Game.ini contient déjà le boost. Attendez la restauration automatique pour éviter de laisser la carte boostée.');
  }
  if (session.status !== 'active') throw new Error('Cette session n’est plus active');
  return updateSession(sessionId, { status: 'cancelled' });
}

// ── Cooldown hebdomadaire ─────────────────────────────────────────────────────

async function getCooldownInfo(serviceId) {
  assertLegionMap(serviceId);
  const last = await getLastSessionForMap(serviceId);
  if (!last) return { onCooldown: false };
  const cooldownUntil = new Date(last.startedAt).getTime() + COOLDOWN_DAYS * 24 * 3600 * 1000;
  if (Date.now() < cooldownUntil) {
    return { onCooldown: true, cooldownUntil, last };
  }
  return { onCooldown: false };
}

// ── INI Apply / Restore ───────────────────────────────────────────────────────

async function findActivationSessionId(serviceId, itemConfig, sessionId) {
  const sessions = await loadSessions();
  const eligible = sessions.filter(session =>
    session.serviceId === serviceId &&
    session.status === 'active' &&
    (!itemConfig.itemName || session.itemName === itemConfig.itemName),
  );
  if (sessionId) {
    if (!eligible.some(session => session.id === sessionId)) {
      throw new Error('Session de booster active introuvable pour cette carte; application INI refusée');
    }
    return sessionId;
  }
  if (eligible.length !== 1) {
    throw new Error('ID de session requis ou session active ambiguë; application INI refusée');
  }
  return eligible[0].id;
}

async function applyBoostIni(serviceId, itemConfig, sessionId) {
  assertLegionMap(serviceId);
  if (!itemConfig || typeof itemConfig !== 'object') throw new Error('Configuration INI booster manquante');
  const { iniKey1, iniKey2 } = itemConfig;
  const configured = [iniKey1, iniKey2].filter(entry => entry?.key);
  if (!configured.length) throw new Error('Aucune clé INI de reproduction configurée; activation refusée');
  for (const entry of configured) {
    validateBreedingKey(entry.key);
    validateFiniteValue(entry.boostValue, `${entry.key} boost`);
  }
  if (new Set(configured.map(entry => entry.key.toLowerCase())).size !== configured.length) {
    throw new Error('Les deux clés INI doivent être différentes');
  }

  const targetSessionId = await findActivationSessionId(serviceId, itemConfig, sessionId);
  const originalContent = await readGameIni(serviceId);
  const iniBackup = {};
  let updatedContent = originalContent;
  for (let i = 0; i < configured.length; i++) {
    const entry = configured[i];
    iniBackup[`key${i + 1}`] = readIniValue(originalContent, entry.key);
    updatedContent = setIniKey(updatedContent, entry.key, validateFiniteValue(entry.boostValue, `${entry.key} boost`));
  }

  // One INI write contains all configured boost values. Roll back the complete
  // source file if the GPanel write or session persistence reports a failure.
  try {
    await legion.writeFile(serviceId, GAME_INI_PATH, updatedContent);
  } catch (error) {
    try {
      await legion.writeFile(serviceId, GAME_INI_PATH, originalContent);
    } catch (rollbackError) {
      throw new Error(`Écriture du boost INI échouée (${error.message}) et rollback Game.ini échoué (${rollbackError.message})`);
    }
    throw new Error(`Écriture du boost INI échouée; Game.ini original réécrit : ${error.message}`);
  }
  try {
    const updatedSession = await updateSession(targetSessionId, {
      iniBackup,
      iniConfig: {
        key1Name: iniKey1?.key || '',
        key2Name: iniKey2?.key || '',
      },
      iniApplied: true,
      lastError: null,
    });
    if (!updatedSession) throw new Error('Session introuvable lors de la sauvegarde des valeurs INI');
  } catch (error) {
    try {
      await legion.writeFile(serviceId, GAME_INI_PATH, originalContent);
    } catch (rollbackError) {
      throw new Error(`Sauvegarde de session impossible (${error.message}) et restauration du Game.ini échouée (${rollbackError.message})`);
    }
    throw new Error(`Sauvegarde des valeurs INI impossible; Game.ini original restauré : ${error.message}`);
  }
  return { iniBackup };
}

async function restoreNormalIni(serviceId, session, fallbackItemConfig) {
  assertLegionMap(serviceId);
  const key1Name = session.iniConfig?.key1Name || fallbackItemConfig?.iniKey1?.key;
  const key2Name = session.iniConfig?.key2Name || fallbackItemConfig?.iniKey2?.key;
  const keys = [key1Name, key2Name].filter(Boolean);
  if (!keys.length) throw new Error('Aucune clé de restauration enregistrée');
  if (new Set(keys.map(key => key.toLowerCase())).size !== keys.length) {
    throw new Error('Clés de restauration dupliquées');
  }

  const originalContent = await readGameIni(serviceId);
  let updatedContent = originalContent;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    validateBreedingKey(key);
    if (!Object.prototype.hasOwnProperty.call(session.iniBackup || {}, `key${i + 1}`)) {
      throw new Error(`Valeur pré-boost réelle manquante pour ${key}; restauration refusée`);
    }
    const value = validateFiniteValue(session.iniBackup[`key${i + 1}`], `${key} restauration`);
    updatedContent = setIniKey(updatedContent, key, value);
  }
  await legion.writeFile(serviceId, GAME_INI_PATH, updatedContent);
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
    // Sessions persisted with Nitrado service IDs are intentionally left untouched.
    if (!sessionOnApprovedMap(session)) continue;
    // A session is rebootable only once its live INI was written and its
    // pre-boost values were durably stored.
    if (session.iniApplied !== true) continue;

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
          await legion.power(session.serviceId, 'restart');
          console.log(`[BoosterRepro] ✅ Redémarrage activation effectué pour ${session.mapDisplayName}`);
          patch.warns.startReboot = true;
          patch.lastError = null;
          dirty = true;
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
          patch.lastError = { phase: 'activation_restart', message: e.message, at: new Date().toISOString() };
          patch.retryCounts = { ...(session.retryCounts || {}), activationRestart: (session.retryCounts?.activationRestart || 0) + 1 };
          dirty = true;
        }
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
          const restoreRebootAt = new Date(now + RESTART_DELAY_MIN * 60 * 1000).toISOString();
          patch.restoreRebootAt = restoreRebootAt;
          patch.lastError = null;
          dirty = true;
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
        } catch (e) {
          console.error(`[BoosterRepro] Erreur restauration INI:`, e.message);
          patch.lastError = { phase: 'ini_restore', message: e.message, at: new Date().toISOString() };
          patch.retryCounts = { ...(session.retryCounts || {}), iniRestore: (session.retryCounts?.iniRestore || 0) + 1 };
          dirty = true;
        }
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
            await legion.power(session.serviceId, 'restart');
            console.log(`[BoosterRepro] ✅ Redémarrage restauration pour ${session.mapDisplayName}`);
            patch.warns.restoreReboot = true;
            patch.status = 'ended';
            patch.lastError = null;
            dirty = true;
            sendNotif(discordClient, channelId, {
              title: '✅ Serveur redémarré — Paramètres normaux restaurés',
              color: 0x95a5a6,
              description: `🗺️ **${session.mapDisplayName}** redémarre maintenant.\nLes paramètres de reproduction sont revenus à la normale.`,
              timestamp: new Date().toISOString(),
            });
          } catch (e) {
            console.error('[BoosterRepro] Erreur redémarrage restauration:', e.message);
            patch.lastError = { phase: 'restore_restart', message: e.message, at: new Date().toISOString() };
            patch.retryCounts = { ...(session.retryCounts || {}), restoreRestart: (session.retryCounts?.restoreRestart || 0) + 1 };
            dirty = true;
          }
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
