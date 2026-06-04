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

// ── Countdown actif en mémoire ─────────────────────────────────────────────
// channelId → { timeout, current }
const activeCountdowns = new Map();

// ── Settings ──────────────────────────────────────────────────────────────────

function getDefaultSettings() {
  return {
    enabled:                false,
    channelId:              '',
    malusRoleId:            '',
    malusRoleDurationHours: 1,
    diamondsPer100:         200,
    strawberryChancePct:    5,
    strawberryChanceAmount: 50,
    countdownChancePct:     10,
    // Messages personnalisables
    breakMsg:      '💥 **{user}** a cassé la route au nombre **{count}** ! On repart de **0**... 😤',
    milestoneMsg:  '🎉 **{count}** atteint par **{user}** ! Incroyable ! 🏆',
    countdownMsg:  '⏳ Alerte ! Personne ne construit la route ! **60 secondes** pour poster **{next}** sinon on recule de 100 !',
    countdownFailMsg: '😬 Temps écoulé ! La route recule de **100** et tombe à **{count}**.',
    luckyMsg:      '🍀 **{user}** a eu la main chanceuse sur le **{count}** et remporte **{amount} fraises** ! 🍓',
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
  if (activeCountdowns.has(channel.id)) return; // déjà actif

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
    embeds.push(new EmbedBuilder()
      .setColor(0xf1c40f)
      .setTitle(`🏆 Palier ${n.toLocaleString('fr-FR')} atteint !`)
      .setDescription(formatMsg(settings.milestoneMsg, { count: n.toLocaleString('fr-FR'), user: `<@${member.id}>` }))
      .setFooter({ text: isRecord ? '🌟 Nouveau record du serveur !' : `Bien joué ${member.displayName || member.user.username} !` }));
  }

  // ── Multiples de 100 → diamants
  if (n % 100 === 0 && settings.diamondsPer100 > 0) {
    await addToInventory(member.id, 'diamants', settings.diamondsPer100, 'route-infini', `🛣️ Route de l'infini — palier ${n}`).catch(() => {});
    if (!isMilestone(n)) {
      embeds.push(new EmbedBuilder()
        .setColor(0x3498db)
        .setDescription(`💎 **${member.displayName || member.user.username}** reçoit **${settings.diamondsPer100} diamants** pour le palier ${n} ! 🎉`));
    } else {
      // Ajouter info diamants au milestone embed déjà créé
      const last = embeds[embeds.length - 1];
      if (last) last.setDescription((last.data.description || '') + `\n💎 +**${settings.diamondsPer100} diamants** crédités !`);
    }
  }

  // ── Chance aléatoire → fraises
  const chancePct = settings.strawberryChancePct || 0;
  const chargeAmt = settings.strawberryChanceAmount || 50;
  if (chancePct > 0 && chargeAmt > 0 && Math.random() * 100 < chancePct) {
    await addToInventory(member.id, 'fraises', chargeAmt, 'route-infini', `🛣️ Route de l'infini — coup de chance sur ${n}`).catch(() => {});
    const luckyText = formatMsg(settings.luckyMsg, {
      user: `<@${member.id}>`, count: n, amount: chargeAmt,
    });
    embeds.push(new EmbedBuilder().setColor(0xe91e8c).setDescription(luckyText));
  }

  // ── Multiple de 13 → malédiction cosmétique
  if (n % 13 === 0 && n % 100 !== 0) {
    embeds.push(new EmbedBuilder()
      .setColor(0x2c3e50)
      .setDescription(`💀 **${n}** — Multiple de 13 ! La malédiction plane sur la route... Le prochain joueur doit être courageux !`));
  }

  // ── Nombre premier → cosmétique
  if (n >= 10 && n <= 500 && isPrime(n) && n % 100 !== 0) {
    embeds.push(new EmbedBuilder()
      .setColor(0x1abc9c)
      .setDescription(`🧠 **${n}** est un nombre premier ! Chapeau l'intellectuel !`));
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
      setTimeout(() => triggerCountdown(channel, n, settings), 3000);
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

    // Rôle malus
    const member = message.member || await message.guild.members.fetch(userId).catch(() => null);
    if (member && settings.malusRoleId) {
      try {
        await member.roles.add(settings.malusRoleId);
        const durationMs = (settings.malusRoleDurationHours || 1) * 3_600_000;
        setTimeout(async () => {
          try { await member.roles.remove(settings.malusRoleId); } catch {}
        }, durationMs);
      } catch {}
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

// ── Réinitialiser la partie ───────────────────────────────────────────────────

async function resetGame(resetStats = false) {
  await pgStore.saveInfinityRoadState({ current_count: 0, record: 0, last_user_id: null, last_user_name: null });
  if (resetStats) await pgStore.resetInfinityRoadStats();
  // Annuler tous les countdowns
  for (const [, cd] of activeCountdowns) clearTimeout(cd.timeout);
  activeCountdowns.clear();
}

module.exports = {
  getIRSettings,
  saveIRSettings,
  handleMessage,
  resetGame,
  getDefaultSettings,
};
