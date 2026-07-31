/**
 * lockdownManager.js — Mode verrouillage d'urgence.
 *
 * Quand actif, à chaque tentative de commande staff/admin/modo :
 *  1. Répondre à l'interaction (Discord exige une réponse dans les 3s)
 *  2. Escalade de sanctions : BAN → KICK → TIMEOUT 28j → SUPPRESSION TOUS RÔLES
 *  3. Notification immédiate dans le salon admin avec ping
 *  4. Log dans pgStore
 */
const pgStore = require('./pgStore');

const STORE_KEY_STATE = 'lockdown_state';
const STORE_KEY_LOGS  = 'lockdown_kick_logs';
const MAX_LOGS = 1000;

// ── Configuration ─────────────────────────────────────────────────────────────
const REAL_OWNER_ID    = '1056004606867546132'; // seule personne totalement exemptée
const ALERT_CHANNEL_ID = '1516804527536210031'; // salon de notification admin
const ADMIN_ROLE_ID    = '1157044417526509578'; // rôle admin à ping

// ── Liste complète des commandes restreintes (admin / staff / modo) ───────────
const RESTRICTED_COMMANDS = new Set([
  'restart-programmer',
  'inventaire-ajouter', 'inventaire-retirer', 'inventaire-transferer',
  'inventaire-admin', 'inventaire-distribuer-item', 'attribuer-pack',
  'creer-giveway', 'giveway-participants', 'giveaway-forcer-resultat',
  'giveaway-republier', 'giveway-retirer', 'relancer-giveway',
  'votes', 'annuler-votes-mois', 'publish-votes', 'test-votes',
  'distribution_recompenses', 'vote-rapport', 'pay-votes', 'set-choices',
  'xp-donner', 'xp-retirer', 'xp-forcer-niveau',
  'serveur-panel', 'spawn-panel', 'ticket-shop-panel',
  'reclamation-panel', 'event-panel', 'blindtest',
  'roulette', 'dino-roulette', 'aide-admin',
  'migrer-ub', 'casino-debloquer', 'amende',
  'sondage_autonome', 'pari-créer', 'pari-résoudre', 'pari-fermer',
]);

// ── État en mémoire ───────────────────────────────────────────────────────────
let _enabled   = false;
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
  await pgStore.setData(STORE_KEY_STATE, { enabled: _enabled, enabledBy: _enabledBy, enabledAt: _enabledAt });
  return { enabled: _enabled, enabledBy: _enabledBy, enabledAt: _enabledAt };
}

function isEnabled() { return _enabled; }
function getState()  { return { enabled: _enabled, enabledBy: _enabledBy, enabledAt: _enabledAt }; }

// ── Logging ───────────────────────────────────────────────────────────────────
async function logAttempt(entry) {
  try {
    const raw  = await pgStore.getData(STORE_KEY_LOGS, null);
    const logs = Array.isArray(raw) ? raw : (raw ? JSON.parse(raw) : []);
    logs.push(entry);
    if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
    await pgStore.setData(STORE_KEY_LOGS, logs);
  } catch (e) { console.error('[Lockdown] logAttempt:', e.message); }
}

async function getLogs() {
  const raw = await pgStore.getData(STORE_KEY_LOGS, null);
  const logs = Array.isArray(raw) ? raw : (raw ? JSON.parse(raw) : []);
  return logs.slice().reverse();
}

// ── Escalade de sanctions ─────────────────────────────────────────────────────
/**
 * Tente toutes les actions dans l'ordre jusqu'à ce qu'une réussisse.
 * Retourne un objet { action, success, error }[]
 */
async function escalate(guild, member, user, reason) {
  const steps = [];

  // 1. BAN (permanent, ignore le statut propriétaire)
  try {
    await guild.members.ban(user.id, { reason, deleteMessageSeconds: 0 });
    steps.push({ action: 'BAN', success: true });
    console.log(`[Lockdown] 🔨 BAN — ${user.username} (${user.id})`);
    return steps; // ban réussi, on s'arrête là
  } catch (e) {
    steps.push({ action: 'BAN', success: false, error: e.message });
    console.warn(`[Lockdown] BAN échoué pour ${user.username}: ${e.message}`);
  }

  // 2. KICK
  try {
    await guild.members.kick(user.id, reason);
    steps.push({ action: 'KICK', success: true });
    console.log(`[Lockdown] 🚫 KICK — ${user.username} (${user.id})`);
    return steps;
  } catch (e) {
    steps.push({ action: 'KICK', success: false, error: e.message });
    console.warn(`[Lockdown] KICK échoué pour ${user.username}: ${e.message}`);
  }

  // 3. TIMEOUT 28 jours (maximum Discord)
  try {
    const until = new Date(Date.now() + 28 * 24 * 60 * 60 * 1000);
    await member.disableCommunicationUntil(until, reason);
    steps.push({ action: 'TIMEOUT_28J', success: true });
    console.log(`[Lockdown] 🔇 TIMEOUT 28j — ${user.username} (${user.id})`);
  } catch (e) {
    steps.push({ action: 'TIMEOUT_28J', success: false, error: e.message });
    console.warn(`[Lockdown] TIMEOUT échoué pour ${user.username}: ${e.message}`);
  }

  // 4. SUPPRESSION DE TOUS LES RÔLES (sauf @everyone)
  try {
    const roles = member.roles.cache.filter(r => r.id !== guild.id);
    if (roles.size > 0) {
      await member.roles.remove(roles, reason);
      steps.push({ action: `RETRAIT_RÔLES (${roles.size})`, success: true });
      console.log(`[Lockdown] 🗑️ RÔLES SUPPRIMÉS — ${user.username}: ${roles.map(r => r.name).join(', ')}`);
    } else {
      steps.push({ action: 'RETRAIT_RÔLES', success: false, error: 'Aucun rôle à retirer' });
    }
  } catch (e) {
    steps.push({ action: 'RETRAIT_RÔLES', success: false, error: e.message });
    console.warn(`[Lockdown] RETRAIT RÔLES échoué pour ${user.username}: ${e.message}`);
  }

  return steps;
}

// ── Notification salon admin ──────────────────────────────────────────────────
async function notifyAdminChannel(client, { user, member, command, channelName, steps }) {
  try {
    const channel = await client.channels.fetch(ALERT_CHANNEL_ID);
    if (!channel?.isTextBased()) return;

    const now = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });

    // Résumé des actions
    const actionsLines = steps.map(s =>
      s.success
        ? `✅ **${s.action}** → réussi`
        : `❌ **${s.action}** → échoué (\`${s.error}\`)`
    ).join('\n');

    const topAction = steps.find(s => s.success);
    const statusLine = topAction
      ? `🔴 **Action appliquée : ${topAction.action}**`
      : `⚠️ **Aucune action n'a pu être appliquée — intervention manuelle requise !**`;

    const embed = {
      color: 0xc62828,
      title: '🚨 TENTATIVE DE COMMANDE VERROUILLÉE',
      description:
        `<@&${ADMIN_ROLE_ID}> — Alerte de sécurité ! Un membre a tenté une commande restreinte.`,
      fields: [
        {
          name: '👤 Utilisateur',
          value: `**${member?.displayName || user.globalName || user.username}**\n@${user.username} • \`${user.id}\``,
          inline: true,
        },
        {
          name: '⌨️ Commande tentée',
          value: `\`/${command}\`${channelName ? `\nSalon : #${channelName}` : ''}`,
          inline: true,
        },
        {
          name: '🕐 Heure',
          value: now,
          inline: true,
        },
        {
          name: '⚡ Actions exécutées',
          value: actionsLines || '—',
        },
        {
          name: '📊 Résultat',
          value: statusLine,
        },
      ],
      footer: { text: 'Arki Family — Système de verrouillage d\'urgence' },
      timestamp: new Date().toISOString(),
    };

    await channel.send({
      content: `<@&${ADMIN_ROLE_ID}>`,
      embeds: [embed],
    });
  } catch (e) {
    console.error('[Lockdown] notifyAdminChannel:', e.message);
  }
}

// ── Intercepteur principal ────────────────────────────────────────────────────
async function intercept(interaction) {
  if (!_enabled) return false;
  if (!interaction.isChatInputCommand()) return false;

  const cmd = interaction.commandName;
  if (!RESTRICTED_COMMANDS.has(cmd)) return false;

  const member = interaction.member;
  const guild  = interaction.guild;
  const user   = interaction.user;
  const client = interaction.client;

  // Seul le vrai propriétaire hardcodé est exempt
  if (user.id === REAL_OWNER_ID) return false;

  // ① Répondre IMMÉDIATEMENT à Discord (délai max 3s)
  try {
    await interaction.reply({
      content: '🔒 Cette commande est verrouillée. Des mesures de sécurité ont été déclenchées.',
      ephemeral: true,
    });
  } catch {}

  // ② DM à l'utilisateur
  user.send(
    '🔒 **Arki Family — Verrouillage de sécurité**\n' +
    'Tu as tenté d\'utiliser une commande restreinte pendant une période de verrouillage.\n' +
    'Des sanctions ont été automatiquement appliquées sur ton compte.'
  ).catch(() => {});

  // ③ Escalade des sanctions (ban → kick → timeout → retrait rôles)
  let steps = [];
  const reason = `🔒 Lockdown Arki : tentative de /${cmd}`;
  if (guild && member) {
    steps = await escalate(guild, member, user, reason);
  } else {
    steps = [{ action: 'AUCUNE', success: false, error: 'guild ou member non disponible' }];
  }

  // ④ Notification salon admin
  notifyAdminChannel(client, {
    user, member,
    command: cmd,
    channelName: interaction.channel?.name || null,
    steps,
  }).catch(() => {});

  // ⑤ Log en base
  const topAction = steps.find(s => s.success);
  await logAttempt({
    timestamp:   new Date().toISOString(),
    userId:      user.id,
    username:    user.username,
    displayName: member?.displayName || user.globalName || user.username,
    command:     cmd,
    channelName: interaction.channel?.name || null,
    kicked:      steps.some(s => s.action === 'BAN' && s.success) || steps.some(s => s.action === 'KICK' && s.success),
    banned:      steps.some(s => s.action === 'BAN' && s.success),
    actionApplied: topAction?.action || null,
    steps,
  });

  return true;
}

module.exports = { loadState, setLockdown, isEnabled, getState, intercept, getLogs, RESTRICTED_COMMANDS };
