'use strict';

/**
 * birthdayManager.js — Système d'anniversaires Arki
 *
 * Fonctionnalités :
 * - /anniversaire : s'enregistrer (jour, mois, année optionnelle)
 * - Cron 00h01 Europe/Paris : détecte les anniversaires du jour, crédite le cadeau,
 *   attribue le rôle, publie le message + GIF aléatoire
 * - Cron 23h50 Europe/Paris : retire le rôle anniversaire
 * - Cron 1er du mois 08h00 : publie le récap des anniversaires du mois
 * - Fonctions utilitaires exportées pour le dashboard
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle } = require('discord.js');
const cron    = require('node-cron');
const pgStore = require('./pgStore');
const { getSettings, saveSettings } = require('./settingsManager');
const { addToInventory } = require('./inventoryManager');

// GIFs "joyeux anniversaire" / "happy birthday" aléatoires (Tenor CDN)
const BIRTHDAY_GIFS = [
  'https://media.tenor.com/jSmXHoChMXAAAAAC/happy-birthday.gif',
  'https://media.tenor.com/ZvFUHwI6VhYAAAAC/joyeux-anniversaire-happy-birthday.gif',
  'https://media.tenor.com/GGRuHJlOPg4AAAAC/happy-birthday-birthday.gif',
  'https://media.tenor.com/1LojsGSV4YIAAAAC/joyeux-anniversaire.gif',
  'https://media.tenor.com/IuVPuPSQdXYAAAAC/happy-birthday-birthday-cake.gif',
  'https://media.tenor.com/SBTl9x57sT8AAAAC/happy-birthday-bonne-fete.gif',
  'https://media.tenor.com/lEWAL0oVdEsAAAAC/joyeux-anniversaire-gateau.gif',
  'https://media.tenor.com/KvRFNY1T8isAAAAC/happy-birthday-feliz-cumpleanos.gif',
];

function randomGif() {
  return BIRTHDAY_GIFS[Math.floor(Math.random() * BIRTHDAY_GIFS.length)];
}

// ── Settings ─────────────────────────────────────────────────────────────────

function getBirthdaySettings() {
  const s = getSettings();
  return s.birthday || {};
}

function getDefaultBirthdaySettings() {
  return {
    enabled:          false,
    channelId:        '',
    roleId:           '',
    dmEnabled:        true,
    // Cadeaux
    giftDiamonds:     500,
    giftStrawberries: 0,
    giftItemId:       '',
    giftItemName:     '',
    giftItemQty:      1,
    // Messages
    publicMessage:    '🎂 Joyeux anniversaire {user} ! Tout le serveur Arki te souhaite une merveilleuse journée ! 🎉',
    dmMessage:        '🎂 Joyeux anniversaire {user} ! Un cadeau a été déposé dans ton inventaire. Profite bien de ta journée ! 🥳',
    monthRecapMessage:'📅 Voici les anniversaires du mois de **{month}** ! N\'oublie pas de souhaiter à ces joueurs un joyeux anniversaire 🎂',
  };
}

async function saveBirthdaySettings(partial) {
  const s = getSettings();
  s.birthday = { ...getDefaultBirthdaySettings(), ...(s.birthday || {}), ...partial };
  await saveSettings(s);
  return s.birthday;
}

// ── Helpers date ──────────────────────────────────────────────────────────────

const MONTH_NAMES_FR = ['Janvier','Février','Mars','Avril','Mai','Juin',
                        'Juillet','Août','Septembre','Octobre','Novembre','Décembre'];

function getParisDayMonth() {
  const parts = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric'
  }).formatToParts(new Date());
  const d = {};
  parts.forEach(p => { d[p.type] = p.value; });
  return {
    day:   parseInt(d.day, 10),
    month: parseInt(d.month, 10),
    year:  parseInt(d.year, 10),
  };
}

function computeAge(birthYear, currentYear) {
  if (!birthYear) return null;
  return currentYear - birthYear;
}

function formatMessage(template, { user, age, month } = {}) {
  return template
    .replace(/{user}/g, user || '')
    .replace(/{age}/g, age !== null && age !== undefined ? `${age} ans` : '')
    .replace(/{month}/g, month || '');
}

// ── Commande /anniversaire ───────────────────────────────────────────────────

async function handleBirthdayCommand(interaction) {
  const settings = getBirthdaySettings();
  if (!settings.enabled) {
    return interaction.reply({
      content: '🎂 Le système d\'anniversaire n\'est pas encore activé.',
      ephemeral: true,
    });
  }

  // showModal() doit être la première réponse dans les 3 secondes —
  // aucun await avant l'appel (sinon Discord rejette le modal)
  const modal = new ModalBuilder()
    .setCustomId('birthday_register_modal')
    .setTitle('🎂 Ton anniversaire');

  const dayInput = new TextInputBuilder()
    .setCustomId('bday_day')
    .setLabel('Jour (1–31)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('ex : 15')
    .setMinLength(1).setMaxLength(2).setRequired(true);

  const monthInput = new TextInputBuilder()
    .setCustomId('bday_month')
    .setLabel('Mois (1–12)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('ex : 6')
    .setMinLength(1).setMaxLength(2).setRequired(true);

  const yearInput = new TextInputBuilder()
    .setCustomId('bday_year')
    .setLabel('Année (optionnelle — pour afficher ton âge)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('ex : 2000  — laisse vide pour garder la date privée')
    .setMinLength(0).setMaxLength(4).setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(dayInput),
    new ActionRowBuilder().addComponents(monthInput),
    new ActionRowBuilder().addComponents(yearInput),
  );

  await interaction.showModal(modal);
}

async function handleBirthdayModalSubmit(interaction) {
  const dayRaw   = interaction.fields.getTextInputValue('bday_day').trim();
  const monthRaw = interaction.fields.getTextInputValue('bday_month').trim();
  const yearRaw  = interaction.fields.getTextInputValue('bday_year').trim();

  const day   = parseInt(dayRaw, 10);
  const month = parseInt(monthRaw, 10);
  const year  = yearRaw ? parseInt(yearRaw, 10) : null;

  // Validations
  if (isNaN(day) || day < 1 || day > 31) {
    return interaction.reply({ content: '❌ Jour invalide (1–31).', ephemeral: true });
  }
  if (isNaN(month) || month < 1 || month > 12) {
    return interaction.reply({ content: '❌ Mois invalide (1–12).', ephemeral: true });
  }
  if (year !== null && (isNaN(year) || year < 1900 || year > new Date().getFullYear() - 5)) {
    return interaction.reply({ content: '❌ Année invalide.', ephemeral: true });
  }

  const username = interaction.member?.displayName || interaction.user.username;

  await pgStore.saveBirthday({ userId: interaction.user.id, username, day, month, year });

  const dateStr = `${String(day).padStart(2,'0')}/${String(month).padStart(2,'0')}${year ? `/${year}` : ''}`;

  const embed = new EmbedBuilder()
    .setColor(0xff6b9d)
    .setTitle('🎂 Anniversaire enregistré !')
    .setDescription(`Ta date d'anniversaire **${dateStr}** a été enregistrée.\nTu recevras un cadeau et un message spécial ce jour-là 🎁`)
    .setFooter({ text: 'Tu peux modifier ta date à tout moment avec /anniversaire' });

  return interaction.reply({ embeds: [embed], ephemeral: true });
}

// ── Célébration du jour ───────────────────────────────────────────────────────

async function celebrateBirthdays(client) {
  const { day, month, year: currentYear } = getParisDayMonth();
  const settings = { ...getDefaultBirthdaySettings(), ...getBirthdaySettings() };

  if (!settings.enabled || !settings.channelId) return;

  const guild = client.guilds.cache.first();
  if (!guild) return;

  const channel = guild.channels.cache.get(settings.channelId);
  if (!channel) return;

  const entries = await pgStore.getBirthdaysOfDay(day, month);
  if (!entries.length) return;

  for (const entry of entries) {
    // Anti-doublon : ne pas célébrer deux fois la même année
    if (entry.last_celebrated === currentYear) continue;

    let member;
    try { member = await guild.members.fetch(entry.user_id); } catch { continue; }

    const age = computeAge(entry.year, currentYear);
    const mention = `<@${entry.user_id}>`;

    // ── Message public + GIF ──
    const publicText = formatMessage(settings.publicMessage, {
      user: mention,
      age,
    });

    const embed = new EmbedBuilder()
      .setColor(0xff6b9d)
      .setDescription(publicText)
      .setImage(randomGif())
      .setTimestamp();

    if (age !== null) embed.setFooter({ text: `🎂 ${age} ans aujourd'hui !` });

    await channel.send({ embeds: [embed] }).catch(() => {});

    // ── Rôle anniversaire ──
    if (settings.roleId) {
      try { await member.roles.add(settings.roleId); } catch {}
    }

    // ── Cadeau inventaire ──
    if (settings.giftDiamonds > 0) {
      await addToInventory(entry.user_id, 'diamants', settings.giftDiamonds, 'system', `🎂 Cadeau anniversaire`).catch(() => {});
    }
    if (settings.giftStrawberries > 0) {
      await addToInventory(entry.user_id, 'fraises', settings.giftStrawberries, 'system', `🎂 Cadeau anniversaire`).catch(() => {});
    }
    if (settings.giftItemId && settings.giftItemQty > 0) {
      let itemKey = settings.giftItemId;
      if (itemKey === '__libre__') {
        const nom = (settings.giftItemName || '').trim();
        if (nom) itemKey = `[libre] ${nom}`;
        else itemKey = null;
      }
      if (itemKey) {
        await addToInventory(entry.user_id, itemKey, settings.giftItemQty, 'system', `🎂 Cadeau anniversaire`).catch(() => {});
      }
    }

    // ── DM privé ──
    if (settings.dmEnabled && settings.dmMessage) {
      const dmText = formatMessage(settings.dmMessage, { user: entry.username, age });
      try {
        const dmEmbed = new EmbedBuilder()
          .setColor(0xff6b9d)
          .setDescription(dmText)
          .setImage(randomGif());
        if (age !== null) dmEmbed.setFooter({ text: `🎂 ${age} ans aujourd'hui !` });
        await member.send({ embeds: [dmEmbed] });
      } catch {}
    }

    // ── Marquer comme célébré ──
    await pgStore.setBirthdayCelebrated(entry.user_id, currentYear);
  }
}

// ── Retrait du rôle ───────────────────────────────────────────────────────────

async function removeBirthdayRoles(client) {
  const settings = { ...getDefaultBirthdaySettings(), ...getBirthdaySettings() };
  if (!settings.enabled || !settings.roleId) return;

  const guild = client.guilds.cache.first();
  if (!guild) return;

  try {
    const role = guild.roles.cache.get(settings.roleId);
    if (!role) return;
    const members = role.members;
    for (const [, member] of members) {
      try { await member.roles.remove(settings.roleId); } catch {}
    }
  } catch {}
}

// ── Récap du mois ─────────────────────────────────────────────────────────────

async function publishMonthRecap(client) {
  const settings = { ...getDefaultBirthdaySettings(), ...getBirthdaySettings() };
  if (!settings.enabled || !settings.channelId) return;

  const guild = client.guilds.cache.first();
  if (!guild) return;
  const channel = guild.channels.cache.get(settings.channelId);
  if (!channel) return;

  // Prochain mois (le récap du 1er du mois N présente le mois N)
  const { month, year } = getParisDayMonth();
  const monthName = MONTH_NAMES_FR[month - 1];

  const entries = await pgStore.getBirthdaysOfMonth(month);

  const introText = formatMessage(settings.monthRecapMessage, { month: monthName });

  if (!entries.length) {
    const embed = new EmbedBuilder()
      .setColor(0xff6b9d)
      .setTitle(`🎂 Anniversaires de ${monthName}`)
      .setDescription(introText + '\n\n*Aucun anniversaire enregistré ce mois-ci.*');
    await channel.send({ embeds: [embed] }).catch(() => {});
    return;
  }

  // Trier par jour
  const sorted = [...entries].sort((a, b) => a.day - b.day);

  const lines = sorted.map(e => {
    const dd = String(e.day).padStart(2, '0');
    const age = e.year ? ` *(${year - e.year} ans)*` : '';
    return `📅 **${dd} ${monthName}** — ${e.username}${age}`;
  });

  const embed = new EmbedBuilder()
    .setColor(0xff6b9d)
    .setTitle(`🎂 Anniversaires de ${monthName}`)
    .setDescription(introText + '\n\n' + lines.join('\n'))
    .setFooter({ text: `${entries.length} anniversaire${entries.length > 1 ? 's' : ''} ce mois-ci` });

  await channel.send({ embeds: [embed] }).catch(() => {});
}

// ── Init cron ─────────────────────────────────────────────────────────────────

function initBirthdayCron(client) {
  // 00h01 Paris : célébration + cadeaux + rôle
  cron.schedule('1 0 * * *', () => {
    celebrateBirthdays(client).catch(e => console.error('[Birthday] celebrateBirthdays:', e.message));
  }, { timezone: 'Europe/Paris' });

  // 23h50 Paris : retrait du rôle anniversaire
  cron.schedule('50 23 * * *', () => {
    removeBirthdayRoles(client).catch(e => console.error('[Birthday] removeBirthdayRoles:', e.message));
  }, { timezone: 'Europe/Paris' });

  // 1er du mois 08h00 Paris : récap des anniversaires du mois
  cron.schedule('0 8 1 * *', () => {
    publishMonthRecap(client).catch(e => console.error('[Birthday] publishMonthRecap:', e.message));
  }, { timezone: 'Europe/Paris' });

  console.log('🎂 Crons anniversaires programmés (00h01 célébration, 23h50 retrait rôle, 1er/mois 08h00 récap)');
}

module.exports = {
  handleBirthdayCommand,
  handleBirthdayModalSubmit,
  celebrateBirthdays,
  removeBirthdayRoles,
  publishMonthRecap,
  initBirthdayCron,
  getBirthdaySettings,
  getDefaultBirthdaySettings,
  saveBirthdaySettings,
  MONTH_NAMES_FR,
};
