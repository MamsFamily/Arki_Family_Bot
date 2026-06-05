'use strict';

/**
 * infinityRoadManager.js — Route de l'Infini
 *
 * Règles :
 * - Salon dédié : seuls les nombres sont acceptés, tout texte est supprimé
 * - Les joueurs postent les nombres dans l'ordre (1, 2, 3…)
 * - Interdit de poster deux fois de suite
 * - Mauvais nombre → reset à 0, rôle malus temporaire
 * - Événements turbo sur certains nombres spéciaux
 * - Compte à rebours aléatoire (60s) : si personne ne répond → -100 (min 0)
 * - Paliers de célébration + récompenses inventaire
 * - Classement des contributeurs
 */

const { EmbedBuilder } = require('discord.js');
const pgStore           = require('./pgStore');
const { getSettings, saveSettings } = require('./settingsManager');
const { addToInventory } = require('./inventoryManager');

// ── Countdown en mémoire ───────────────────────────────────────────────────
// pendingCountdowns : délai de 3s avant le vrai lancement (annulable si un nombre arrive)
// activeCountdowns  : compte à rebours de 60s en cours
const pendingCountdowns = new Map();
const activeCountdowns  = new Map();

// ── Fautif actuel (un seul à la fois) ──────────────────────────────────────
// Stocké en base PostgreSQL pour survivre aux redémarrages.
// En mémoire : le timeout actif pour l'annuler si quelqu'un d'autre casse la route.
let currentMalusTimeout = null;

// ── Settings ──────────────────────────────────────────────────────────────────

function getDefaultSettings() {
  return {
    enabled:                false,
    channelId:              '',
    malusRoleId:            '',
    malusRoleDurationHours: 48,
    diamondsPer100:         0,
    diamondsPerMilestoneLow:  0,
    diamondsPerMilestoneHigh: 0,
    // Récompenses aléatoires : montant entre 1 et (palier+1)×100
    chanceDiamondPct:        5,
    strawberryChancePct:     5,
    countdownChancePct:     10,
    // Messages personnalisables
    breakMsg:           '💥 **{user}** a cassé la route au nombre **{count}** ! On repart de **0**... 😤',
    milestoneMsg:       '🎉 **{count}** atteint par **{user}** ! Incroyable ! 🏆',
    countdownMsg:       '⏳ Alerte ! Personne ne construit la route ! **60 secondes** pour poster **{next}** sinon on recule de 100 !',
    countdownFailMsg:   '😬 Temps écoulé ! La route recule de **100** et tombe à **{count}**.',
    luckyMsg:           '🍀 **{user}** a eu la main chanceuse sur le **{count}** et remporte **{amount} fraises** ! 🍓',
    luckyDiamondMsg:    '💎 **{user}** décroche un coup de chance sur le **{count}** et remporte **{amount} diamants** ! ✨',
    tierUpMsg:          '📈 La route atteint **{count}** ! Le gain par coup de chance monte à **{tier}** 💎/🍓 !',
  };
}

function getIRSettings() {
  const s = getSettings();
  return { ...getDefaultSettings(), ...(s.infinityRoad || {}) };
}

async function saveIRSettings(partial) {
  const s = getSettings();
  s.infinityRoad = { ...getDefaultSettings(), ...(s.infinityRoad || {}), ...partial };
  await saveSettings(s);
  return s.infinityRoad;
}

// ── Helpers math ──────────────────────────────────────────────────────────────

function isPrime(n) {
  if (n < 2) return false;
  if (n === 2) return true;
  if (n % 2 === 0) return false;
  for (let i = 3; i <= Math.sqrt(n); i += 2) if (n % i === 0) return false;
  return true;
}

function formatMsg(template, vars) {
  return template
    .replace(/{user}/g,   vars.user   || '')
    .replace(/{count}/g,  vars.count  !== undefined ? String(vars.count)  : '')
    .replace(/{next}/g,   vars.next   !== undefined ? String(vars.next)   : '')
    .replace(/{record}/g, vars.record !== undefined ? String(vars.record) : '')
    .replace(/{amount}/g, vars.amount !== undefined ? String(vars.amount) : '');
}

// ── Paliers de célébration ────────────────────────────────────────────────────

const MILESTONE_THRESHOLDS = [50, 100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10000];
function isMilestone(n) { return MILESTONE_THRESHOLDS.includes(n) || (n > 1000 && n % 1000 === 0); }

// Numéros spéciaux avec messages humoristiques
const SPECIAL_NUMBERS = {
  69:   '😏 *Hm hm...* 69 hein ? On ne dit rien.',
  420:  '🌿 420 ! *Sniff...* est-ce que ça sent la fumée ici ?',
  666:  '😈 **666 — Le nombre de la bête !** Que quelqu\'un appelle un exorciste.',
  1337: '👾 **1337** — L33t hax0r ! Le serveur Arki est un repaire de geeks confirmés.',
  1000: null, // géré par milestones
  1111: '✨ **1111** — Fais un vœu ! 🌟',
  2222: '✨ **2222** — Double double ! Bonne chance à tous ! 🍀',
  3333: '✨ **3333** — Triple triple ! La route est magique ! 🎩',
  4444: '😬 **4444** — Nombre de la mort en culture asiatique... on continue quand même !',
  9999: '🔥 **9999** — On frôle les 10 000 ! Le record est à portée de main !',
};

// ── Countdown aléatoire ───────────────────────────────────────────────────────

async function triggerCountdown(channel, currentCount, settings) {
  pendingCountdowns.delete(channel.id); // on sort du délai d'attente
  if (activeCountdowns.has(channel.id)) return; // déjà un vrai countdown actif

  const next = currentCount + 1;
  const msg = formatMsg(settings.countdownMsg, { next, count: currentCount });

  const embed = new EmbedBuilder()
    .setColor(0xff9900)
    .setDescription(`⏳ ${msg}`)
    .setFooter({ text: '60 secondes pour continuer la route !' });

  const sentMsg = await channel.send({ embeds: [embed] }).catch(() => null);

  const timeout = setTimeout(async () => {
    activeCountdowns.delete(channel.id);
    if (sentMsg) sentMsg.delete().catch(() => {});

    // Reculer de 100
    const state = await pgStore.getInfinityRoadState();
    const newCount = Math.max(0, Number(state.current_count) - 100);
    await pgStore.saveInfinityRoadState({
      current_count: newCount,
      record: state.record,
      last_user_id: state.last_user_id,
      last_user_name: state.last_user_name,
    });

    const failMsg = formatMsg(settings.countdownFailMsg, { count: newCount });
    const failEmbed = new EmbedBuilder()
      .setColor(0xe74c3c)
      .setDescription(`😬 ${failMsg}`)
      .setFooter({ text: `Prochain nombre attendu : ${newCount + 1}` });

    await channel.send({ embeds: [failEmbed] }).catch(() => {});
  }, 60_000);

  activeCountdowns.set(channel.id, { timeout, expectedNext: next });
}

function cancelCountdown(channelId) {
  // Annuler le délai de 3s (pas encore lancé)
  const pending = pendingCountdowns.get(channelId);
  if (pending) {
    clearTimeout(pending);
    pendingCountdowns.delete(channelId);
  }
  // Annuler le vrai countdown de 60s
  const cd = activeCountdowns.get(channelId);
  if (cd) {
    clearTimeout(cd.timeout);
    activeCountdowns.delete(channelId);
  }
}

// ── Événements turbo ──────────────────────────────────────────────────────────

async function processTurboEvents(n, member, channel, settings) {
  const embeds = [];

  // ── Palier de célébration
  if (isMilestone(n)) {
    const isRecord = n === Number((await pgStore.getInfinityRoadState()).record);
    const milestoneEmbed = new EmbedBuilder()
      .setColor(0xf1c40f)
      .setTitle(`🏆 Palier ${n.toLocaleString('fr-FR')} atteint !`)
      .setDescription(formatMsg(settings.milestoneMsg, { count: n.toLocaleString('fr-FR'), user: `<@${member.id}>` }))
      .setFooter({ text: isRecord ? '🌟 Nouveau record du serveur !' : `Bien joué ${member.displayName || member.user.username} !` });

    // Diamants spécifiques aux paliers de célébration (montant selon seuil 1000)
    const milestoneReward = n < 1000
      ? (settings.diamondsPerMilestoneLow  || 0)
      : (settings.diamondsPerMilestoneHigh || 0);
    if (milestoneReward > 0) {
      await addToInventory(member.id, 'diamants', milestoneReward, 'route-infini', `🛣️ Route de l'infini — palier célébration ${n}`).catch(() => {});
      milestoneEmbed.setDescription((milestoneEmbed.data.description || '') + `\n💎 +**${milestoneReward} diamants** crédités !`);
    }
    embeds.push(milestoneEmbed);
  }

  // ── Multiples de 100 → diamants (uniquement si pas déjà un palier célébration qui a donné des diamants)
  if (n % 100 === 0 && settings.diamondsPer100 > 0) {
    await addToInventory(member.id, 'diamants', settings.diamondsPer100, 'route-infini', `🛣️ Route de l'infini — ×100 au ${n}`).catch(() => {});
    if (!isMilestone(n)) {
      embeds.push(new EmbedBuilder()
        .setColor(0x3498db)
        .setDescription(`💎 **${member.displayName || member.user.username}** reçoit **${settings.diamondsPer100} diamants** pour le palier ${n} ! 🎉`));
    } else {
      // Ajouter info diamants ×100 au milestone embed déjà créé
      const last = embeds[embeds.length - 1];
      if (last) last.setDescription((last.data.description || '') + `\n💎 +**${settings.diamondsPer100} diamants** (bonus ×100) !`);
    }
  }

  // ── Montant fixe par palier : (floor(n/100) + 1) × 100
  //    0–99 → 100 / 100–199 → 200 / 200–299 → 300 …
  const tierAmount = (Math.floor(n / 100) + 1) * 100;

  // ── Annonce de montée de palier (à chaque multiple de 100, sauf 0)
  if (n > 0 && n % 100 === 0) {
    const nextTier = (Math.floor(n / 100) + 1) * 100;
    const anyActive = (settings.chanceDiamondPct || 0) > 0 || (settings.strawberryChancePct || 0) > 0;
    if (anyActive) {
      const tierText = formatMsg(
        settings.tierUpMsg || '📈 La route atteint **{count}** ! Le gain par coup de chance monte à **{tier}** 💎/🍓 !',
        { count: n, tier: nextTier },
      );
      embeds.push(new EmbedBuilder().setColor(0xf39c12).setDescription(tierText));
    }
  }

  // ── Chance aléatoire → 💎 diamants (montant fixe selon palier)
  const cdPct = settings.chanceDiamondPct || 0;
  if (cdPct > 0 && Math.random() * 100 < cdPct) {
    await addToInventory(member.id, 'diamants', tierAmount, 'route-infini', `🛣️ Route de l'infini — chance sur ${n}`).catch(() => {});
    const cdText = formatMsg(settings.luckyDiamondMsg || '💎 **{user}** décroche un coup de chance sur le **{count}** et remporte **{amount} diamants** ! ✨', {
      user: `<@${member.id}>`, count: n, amount: tierAmount,
    });
    embeds.push(new EmbedBuilder().setColor(0x5865f2).setDescription(cdText));
  }

  // ── Chance aléatoire → 🍓 fraises (montant fixe selon palier)
  const chancePct = settings.strawberryChancePct || 0;
  if (chancePct > 0 && Math.random() * 100 < chancePct) {
    await addToInventory(member.id, 'fraises', tierAmount, 'route-infini', `🛣️ Route de l'infini — coup de chance sur ${n}`).catch(() => {});
    const luckyText = formatMsg(settings.luckyMsg, {
      user: `<@${member.id}>`, count: n, amount: tierAmount,
    });
    embeds.push(new EmbedBuilder().setColor(0xe91e8c).setDescription(luckyText));
  }

  // ── Nombre spécial
  if (SPECIAL_NUMBERS[n]) {
    embeds.push(new EmbedBuilder()
      .setColor(0xe67e22)
      .setDescription(SPECIAL_NUMBERS[n]));
  }

  if (embeds.length > 0) {
    await channel.send({ embeds }).catch(() => {});
  }

  // ── Compte à rebours aléatoire (pas sur les paliers pour ne pas parasiter)
  if (!isMilestone(n) && !activeCountdowns.has(channel.id)) {
    const chance = (settings.countdownChancePct || 10) / 100;
    if (Math.random() < chance) {
      // On stocke dans pendingCountdowns pour pouvoir l'annuler si un nombre
      // est posté dans les 3s avant que le vrai countdown ne démarre
      const pendingTimeout = setTimeout(() => triggerCountdown(channel, n, settings), 3000);
      pendingCountdowns.set(channel.id, pendingTimeout);
    }
  }
}

// ── Handler principal : appelé pour chaque message dans le salon ──────────────

async function handleMessage(message) {
  const settings = getIRSettings();
  if (!settings.enabled || !settings.channelId) return false;
  if (message.channelId !== settings.channelId) return false;

  // Supprimer les messages de bots (sauf le nôtre qui est déjà filtré en amont)
  const raw = message.content.trim();

  // Tenter de parser comme nombre entier positif
  const num = parseInt(raw, 10);
  const isValidNumber = !isNaN(num) && num > 0 && String(num) === raw;

  if (!isValidNumber) {
    // Supprimer le message non-numérique
    try { await message.delete(); } catch {}
    return true; // on a traité ce message
  }

  // ── Lecture état actuel ───────────────────────────────────────────────────
  const state = await pgStore.getInfinityRoadState();
  const current  = Number(state.current_count);
  const expected = current + 1;
  const userId   = message.author.id;
  const username = message.member?.displayName || message.author.username;

  // ── Vérification double post ──────────────────────────────────────────────
  if (state.last_user_id && state.last_user_id === userId) {
    try { await message.delete(); } catch {}
    const warn = await message.channel.send({
      embeds: [new EmbedBuilder()
        .setColor(0xe67e22)
        .setDescription(`⚠️ <@${userId}> tu ne peux pas poster deux fois de suite ! Attends qu'un autre joueur continue.`)],
    });
    setTimeout(() => warn.delete().catch(() => {}), 8000);
    return true;
  }

  // ── Vérification nombre attendu ───────────────────────────────────────────
  if (num !== expected) {
    // Mauvais nombre → reset
    cancelCountdown(message.channelId);

    // Rôle Fautif (un seul à la fois — transférable si quelqu'un d'autre casse ensuite)
    try {
      await assignMalusRole(message.guild, userId, username, settings);
    } catch {
      message.channel.send({
        embeds: [new EmbedBuilder()
          .setColor(0xe67e22)
          .setDescription(`⚠️ Impossible d'attribuer le rôle **Fautif** à <@${userId}> — vérifie que le bot a la permission **Gérer les rôles** et que le rôle est **en dessous** du rôle du bot dans la hiérarchie.`)],
      }).catch(() => {});
    }

    // Stats
    await pgStore.upsertInfinityRoadStat(userId, username, 'break');

    // Sauvegarde état reset
    await pgStore.saveInfinityRoadState({ current_count: 0, record: state.record, last_user_id: null, last_user_name: null });

    const embed = new EmbedBuilder()
      .setColor(0xe74c3c)
      .setDescription(formatMsg(settings.breakMsg, { user: `<@${userId}>`, count: current }))
      .setFooter({ text: `Le compteur était à ${current} — prochain attendu : 1` });

    await message.channel.send({ embeds: [embed] }).catch(() => {});
    return true;
  }

  // ── Nombre correct ! ──────────────────────────────────────────────────────
  cancelCountdown(message.channelId);

  const newRecord = Math.max(Number(state.record), num);
  await pgStore.saveInfinityRoadState({
    current_count: num,
    record: newRecord,
    last_user_id: userId,
    last_user_name: username,
  });

  await pgStore.upsertInfinityRoadStat(userId, username, 'contribution');

  // Événements turbo (milestone, paliers, palindromes, etc.)
  const member = message.member || await message.guild.members.fetch(userId).catch(() => null);
  if (member) await processTurboEvents(num, member, message.channel, settings);

  return true;
}

// ── Gestion du rôle Fautif (un seul à la fois, 48h, transférable) ─────────────

/**
 * Attribue le rôle malus au nouveau casseur.
 * Si un ancien Fautif existe encore (timer non expiré), on lui retire le rôle d'abord.
 * @param {Guild}  guild       - guilde Discord
 * @param {string} newUserId   - ID du nouveau casseur
 * @param {string} newUsername - Nom du nouveau casseur
 * @param {object} settings    - settings infinityRoad (malusRoleId, malusRoleDurationHours)
 */
async function assignMalusRole(guild, newUserId, newUsername, settings) {
  if (!settings.malusRoleId) {
    console.warn('[Fautif] malusRoleId non configuré — attribution ignorée.');
    return;
  }

  const durationMs = (settings.malusRoleDurationHours || 48) * 3_600_000;
  const expiresAt  = Date.now() + durationMs;

  // 1. Annuler le timer en mémoire quoi qu'il arrive
  if (currentMalusTimeout) {
    clearTimeout(currentMalusTimeout);
    currentMalusTimeout = null;
    console.log('[Fautif] Timer précédent annulé.');
  }

  // 2. Retirer le rôle à l'ancien Fautif (s'il en existe un en base)
  const state = await pgStore.getInfinityRoadState();
  console.log(`[Fautif] État DB — malus_user_id=${state.malus_user_id} expires=${state.malus_expires_at} now=${Date.now()}`);

  if (state.malus_user_id) {
    // On retire le rôle même si expiré (au cas où le timer n'aurait pas pu tourner)
    try {
      const oldMember = await guild.members.fetch(state.malus_user_id).catch(e => {
        console.warn(`[Fautif] fetch ancien membre ${state.malus_user_id} échoué : ${e.message}`);
        return null;
      });
      if (oldMember) {
        await oldMember.roles.remove(settings.malusRoleId);
        console.log(`[Fautif] ✅ Rôle retiré à l'ancien Fautif ${state.malus_user_name} → transfert vers ${newUsername}`);
      } else {
        console.warn(`[Fautif] Ancien Fautif ${state.malus_user_name} introuvable sur le serveur (parti ?).`);
      }
    } catch (e) {
      console.error(`[Fautif] ❌ Erreur retrait rôle de ${state.malus_user_name} : ${e.message}`);
    }
  }

  // 3. Attribuer le rôle au nouveau casseur
  let newMember = null;
  try {
    newMember = await guild.members.fetch(newUserId).catch(e => {
      console.warn(`[Fautif] fetch nouveau membre ${newUserId} échoué : ${e.message}`);
      return null;
    });
  } catch (e) {
    console.error(`[Fautif] ❌ Impossible de récupérer le membre ${newUsername} : ${e.message}`);
  }

  if (!newMember) {
    console.warn(`[Fautif] Membre ${newUsername} introuvable — rôle non attribué.`);
    await pgStore.clearMalusState();
    return;
  }

  try {
    await newMember.roles.add(settings.malusRoleId);
    console.log(`[Fautif] ✅ Rôle attribué à ${newUsername} pour ${settings.malusRoleDurationHours || 48}h.`);
  } catch (e) {
    console.error(`[Fautif] ❌ Échec attribution rôle à ${newUsername} : ${e.message} — vérifie hiérarchie et permission Gérer les rôles.`);
    await pgStore.clearMalusState();
    throw e;
  }

  // 4. Sauvegarder en base
  await pgStore.saveMalusState(newUserId, newUsername, expiresAt);
  console.log(`[Fautif] État sauvegardé en base (expire le ${new Date(expiresAt).toLocaleString('fr-FR')}).`);

  // 5. Timer de retrait automatique
  currentMalusTimeout = setTimeout(async () => {
    try {
      const m = await guild.members.fetch(newUserId).catch(() => null);
      if (m) await m.roles.remove(settings.malusRoleId).catch(e => console.error(`[Fautif] Échec retrait auto ${newUsername} : ${e.message}`));
    } catch (e) {
      console.error(`[Fautif] Échec retrait automatique rôle pour ${newUsername} : ${e.message}`);
    }
    await pgStore.clearMalusState();
    currentMalusTimeout = null;
    console.log(`[Fautif] ✅ Rôle retiré automatiquement après ${settings.malusRoleDurationHours || 48}h (${newUsername}).`);
  }, durationMs);
}

/**
 * À appeler au démarrage du bot : remet en place le timer si un Fautif est encore actif en base.
 * @param {Guild} guild
 */
async function initMalusOnStartup(guild) {
  try {
    const state    = await pgStore.getInfinityRoadState();
    const settings = getIRSettings();

    if (!state.malus_user_id || !state.malus_expires_at || !settings.malusRoleId) return;

    const remaining = Number(state.malus_expires_at) - Date.now();
    if (remaining <= 0) {
      // Déjà expiré pendant l'absence du bot → retirer le rôle et nettoyer
      const m = await guild.members.fetch(state.malus_user_id).catch(() => null);
      if (m) await m.roles.remove(settings.malusRoleId).catch(() => {});
      await pgStore.clearMalusState();
      console.log(`[Route Infini] Rôle Fautif expiré pendant le downtime — retiré à ${state.malus_user_name}.`);
      return;
    }

    // Timer restant à remettre en place
    console.log(`[Route Infini] Reprise : ${state.malus_user_name} est encore Fautif (${Math.round(remaining / 3_600_000 * 10) / 10}h restantes).`);
    currentMalusTimeout = setTimeout(async () => {
      try {
        const m = await guild.members.fetch(state.malus_user_id).catch(() => null);
        if (m) await m.roles.remove(settings.malusRoleId);
      } catch (e) {
        console.error(`[Route Infini] Échec retrait rôle Fautif au redémarrage pour ${state.malus_user_name}:`, e.message);
      }
      await pgStore.clearMalusState();
      currentMalusTimeout = null;
      console.log(`[Route Infini] Rôle Fautif retiré après reprise (${state.malus_user_name}).`);
    }, remaining);

  } catch (e) {
    console.error('[Route Infini] initMalusOnStartup error:', e.message);
  }
}

// ── Réinitialiser la partie ───────────────────────────────────────────────────

async function resetGame(resetStats = false) {
  await pgStore.saveInfinityRoadState({ current_count: 0, record: 0, last_user_id: null, last_user_name: null });
  if (resetStats) await pgStore.resetInfinityRoadStats();
  // Annuler tous les countdowns (pending + actifs)
  for (const t of pendingCountdowns.values()) clearTimeout(t);
  pendingCountdowns.clear();
  for (const [, cd] of activeCountdowns) clearTimeout(cd.timeout);
  activeCountdowns.clear();
}

module.exports = {
  getIRSettings,
  saveIRSettings,
  handleMessage,
  resetGame,
  getDefaultSettings,
  initMalusOnStartup,
};
