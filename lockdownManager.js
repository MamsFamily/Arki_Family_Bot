/**
 * lockdownManager.js — Mode verrouillage d'urgence.
 *
 * Quand actif :
 *  - Toute commande staff/admin/modo est interceptée AVANT exécution
 *  - L'auteur est exclu du serveur (sauf propriétaire du serveur)
 *  - La tentative est loggée dans pgStore (clé : lockdown_kick_logs)
 */
const pgStore = require('./pgStore');

const STORE_KEY_STATE = 'lockdown_state';
const STORE_KEY_LOGS  = 'lockdown_kick_logs';
const MAX_LOGS = 1000;

// ── Liste complète des commandes restreintes (admin / staff / modo) ──────────
const RESTRICTED_COMMANDS = new Set([
  // Redémarrages
  'restart-programmer',
  // Inventaire / économie admin
  'inventaire-ajouter', 'inventaire-retirer', 'inventaire-transferer',
  'inventaire-admin', 'inventaire-distribuer-item', 'attribuer-pack',
  // Giveaways
  'creer-giveway', 'giveway-participants', 'giveaway-forcer-resultat',
  'giveaway-republier', 'giveway-retirer', 'relancer-giveway',
  // Votes
  'votes', 'annuler-votes-mois', 'publish-votes', 'test-votes',
  'distribution_recompenses', 'vote-rapport', 'pay-votes', 'set-choices',
  // XP
  'xp-donner', 'xp-retirer', 'xp-forcer-niveau',
  // Panneaux admin
  'serveur-panel', 'spawn-panel', 'ticket-shop-panel',
  'reclamation-panel', 'event-panel', 'blindtest',
  // Divers admin/modo
  'roulette', 'dino-roulette', 'aide-admin',
  'migrer-ub', 'casino-debloquer', 'amende',
  'sondage_autonome', 'pari-créer', 'pari-résoudre', 'pari-fermer',
]);

// ── Propriétaire légitime du serveur (jamais kické, jamais bloqué) ──────────
const REAL_OWNER_ID = '1056004606867546132';

// ── État en mémoire (cache, évite un aller-retour DB à chaque interaction) ──
let _enabled = false;
let _enabledBy = null;
let _enabledAt = null;

async function loadState() {
  try {
    const s = await pgStore.getData(STORE_KEY_STATE, null);
    if (s && typeof s === 'object') {
      _enabled   = !!s.enabled;
      _enabledBy = s.enabledBy || null;
      _enabledAt = s.enabledAt || null;
    }
  } catch {}
}

async function setLockdown(enabled, adminName = 'Dashboard') {
  _enabled   = enabled;
  _enabledBy = adminName;
  _enabledAt = enabled ? new Date().toISOString() : null;
  await pgStore.setData(STORE_KEY_STATE, {
    enabled: _enabled,
    enabledBy: _enabledBy,
    enabledAt: _enabledAt,
  });
  return { enabled: _enabled, enabledBy: _enabledBy, enabledAt: _enabledAt };
}

function isEnabled() { return _enabled; }
function getState()  { return { enabled: _enabled, enabledBy: _enabledBy, enabledAt: _enabledAt }; }

// ── Logging ──────────────────────────────────────────────────────────────────
async function logAttempt({ userId, username, displayName, command, channelName, kicked, kickError }) {
  try {
    const raw  = await pgStore.getData(STORE_KEY_LOGS, null);
    const logs = Array.isArray(raw) ? raw : (raw ? JSON.parse(raw) : []);
    logs.push({
      timestamp: new Date().toISOString(),
      userId, username, displayName,
      command, channelName,
      kicked, kickError: kickError || null,
    });
    if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
    await pgStore.setData(STORE_KEY_LOGS, logs);
  } catch (e) { console.error('[Lockdown] logAttempt:', e.message); }
}

async function getLogs() {
  const raw = await pgStore.getData(STORE_KEY_LOGS, null);
  const logs = Array.isArray(raw) ? raw : (raw ? JSON.parse(raw) : []);
  return logs.slice().reverse();
}

// ── Intercepteur principal ────────────────────────────────────────────────────
/**
 * Appeler au début de interactionCreate, AVANT tout traitement.
 * Retourne true si la commande a été bloquée (stopper le traitement).
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function intercept(interaction) {
  if (!_enabled) return false;
  if (!interaction.isChatInputCommand()) return false;

  const cmd = interaction.commandName;
  if (!RESTRICTED_COMMANDS.has(cmd)) return false;

  const member = interaction.member;
  const guild  = interaction.guild;
  const user   = interaction.user;
  // Seul le vrai propriétaire hardcodé est exempt
  const isRealOwner = user.id === REAL_OWNER_ID;
  if (isRealOwner) return false; // laisse passer sans log

  let kicked = false;
  let kickError = null;

  if (guild && member) {
    try {
      // DM d'avertissement avant l'exclusion
      await user.send(
        '🔒 **Arki Family** — Les commandes staff/admin/modo sont temporairement désactivées.\n' +
        'Tu as été exclu(e) automatiquement suite à une tentative d\'utilisation pendant le verrouillage d\'urgence.'
      ).catch(() => {});

      await guild.members.kick(user.id, 'Lockdown : tentative de commande restreinte pendant le verrouillage');
      kicked = true;
      console.log(`[Lockdown] 🚫 KICK — ${member.displayName || user.username} (${user.id}) a tenté /${cmd}`);
    } catch (e) {
      kickError = e.message;
      console.warn(`[Lockdown] ⚠️ Kick impossible pour ${user.username} : ${e.message}`);
    }
  }

  // Log de la tentative
  await logAttempt({
    userId:      user.id,
    username:    user.username,
    displayName: member?.displayName || user.globalName || user.username,
    command:     cmd,
    channelName: interaction.channel?.name || null,
    kicked,
    kickError,
  });

  // Répondre à l'interaction (Discord exige une réponse dans les 3s)
  try {
    await interaction.reply({
      content: kicked
        ? '🔒 Les commandes staff/admin/modo sont verrouillées. Tu as été exclu(e) du serveur.'
        : '🔒 Les commandes staff/admin/modo sont temporairement verrouillées.',
      ephemeral: true,
    });
  } catch {}

  return true; // commande bloquée
}

module.exports = { loadState, setLockdown, isEnabled, getState, intercept, getLogs, RESTRICTED_COMMANDS };
