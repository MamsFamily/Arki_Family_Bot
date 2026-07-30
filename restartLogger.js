'use strict';

/**
 * restartLogger.js — Historique des redémarrages de maps
 *
 * Stocke les 500 derniers redémarrages dans PostgreSQL.
 * Sources : panneau Discord, commande /restart-programmer, dashboard, scheduler automatique.
 */

const pgStore = require('./pgStore');
const STORE_KEY = 'nitrado_restart_logs';
const MAX_ENTRIES = 500;

/**
 * Enregistre un redémarrage.
 * @param {object} entry
 * @param {string} entry.source        - 'discord_panel' | 'discord_command' | 'dashboard' | 'scheduler'
 * @param {string} entry.adminId       - ID Discord ou identifiant (ex: 'scheduler')
 * @param {string} entry.adminName     - Nom lisible
 * @param {string[]} entry.serviceIds  - IDs Nitrado des maps redémarrées
 * @param {string[]} entry.mapNames    - Noms des maps (pour affichage)
 * @param {boolean} entry.ok           - Succès ou non
 * @param {string} [entry.error]       - Message d'erreur si échec
 */
async function logRestart({ source, adminId, adminName, serviceIds, mapNames, ok, error }) {
  try {
    const logs = (await pgStore.getData(STORE_KEY, [])) || [];
    logs.push({
      id:         Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      timestamp:  new Date().toISOString(),
      source:     source || 'unknown',
      adminId:    adminId || '—',
      adminName:  adminName || adminId || '—',
      serviceIds: serviceIds || [],
      mapNames:   mapNames || [],
      ok:         ok !== false,
      error:      error || null,
    });
    // Garder seulement les MAX_ENTRIES dernières entrées
    if (logs.length > MAX_ENTRIES) logs.splice(0, logs.length - MAX_ENTRIES);
    await pgStore.setData(STORE_KEY, logs);
  } catch (e) {
    console.error('[RestartLogger] Erreur log:', e.message);
  }
}

/**
 * Récupère les logs de redémarrage, du plus récent au plus ancien.
 * @param {number} [limit=200]
 * @returns {Promise<object[]>}
 */
async function getLogs(limit = 200) {
  try {
    const logs = (await pgStore.getData(STORE_KEY, [])) || [];
    return logs.slice().reverse().slice(0, limit);
  } catch (e) {
    console.error('[RestartLogger] Erreur getLogs:', e.message);
    return [];
  }
}

module.exports = { logRestart, getLogs };
