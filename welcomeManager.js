const { createCanvas, loadImage } = require('canvas');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { getDatabase } = require('./database');
const { getSettings } = require('./settingsManager');
const pgStore = require('./pgStore');
const axios = require('axios');
const path = require('path');

let sqliteReady = false;

function initSqliteDb() {
  if (sqliteReady) return;
  try {
    const db = getDatabase();
    db.exec(`
      CREATE TABLE IF NOT EXISTS member_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        joined_at INTEGER NOT NULL,
        left_at INTEGER DEFAULT NULL
      )
    `);
    sqliteReady = true;
  } catch (e) {
    console.warn('[Welcome] SQLite init:', e.message);
  }
}

async function recordJoin(userId, guildId) {
  const pool = pgStore.getPool();
  if (pool) {
    try {
      await pool.query(
        'INSERT INTO member_history (user_id, guild_id, joined_at) VALUES ($1, $2, $3)',
        [String(userId), String(guildId), Date.now()]
      );
      return;
    } catch (e) { console.warn('[Welcome] PG recordJoin:', e.message); }
  }
  initSqliteDb();
  const db = getDatabase();
  db.prepare('INSERT INTO member_history (user_id, guild_id, joined_at) VALUES (?, ?, ?)').run(String(userId), String(guildId), Date.now());
}

async function recordLeave(userId, guildId) {
  const pool = pgStore.getPool();
  if (pool) {
    try {
      await pool.query(
        `UPDATE member_history SET left_at = $1 WHERE id = (
           SELECT id FROM member_history WHERE user_id = $2 AND guild_id = $3 AND left_at IS NULL ORDER BY joined_at DESC LIMIT 1
         )`,
        [Date.now(), String(userId), String(guildId)]
      );
      return;
    } catch (e) { console.warn('[Welcome] PG recordLeave:', e.message); }
  }
  initSqliteDb();
  const db = getDatabase();
  const row = db.prepare('SELECT id FROM member_history WHERE user_id = ? AND guild_id = ? AND left_at IS NULL ORDER BY joined_at DESC LIMIT 1').get(String(userId), String(guildId));
  if (row) db.prepare('UPDATE member_history SET left_at = ? WHERE id = ?').run(Date.now(), row.id);
}

async function getMemberVisits(userId, guildId) {
  const pool = pgStore.getPool();
  if (pool) {
    try {
      const res = await pool.query(
        'SELECT * FROM member_history WHERE user_id = $1 AND guild_id = $2 ORDER BY joined_at ASC',
        [String(userId), String(guildId)]
      );
      return res.rows;
    } catch (e) { console.warn('[Welcome] PG getMemberVisits:', e.message); }
  }
  initSqliteDb();
  const db = getDatabase();
  return db.prepare('SELECT * FROM member_history WHERE user_id = ? AND guild_id = ? ORDER BY joined_at ASC').all(String(userId), String(guildId));
}

async function insertMemberHistory(userId, guildId, joinedAt, leftAt) {
  const pool = pgStore.getPool();
  if (pool) {
    try {
      await pool.query(
        'INSERT INTO member_history (user_id, guild_id, joined_at, left_at) VALUES ($1, $2, $3, $4)',
        [String(userId), String(guildId), joinedAt, leftAt ?? null]
      );
      return;
    } catch (e) { console.warn('[Welcome] PG insertMemberHistory:', e.message); }
  }
  initSqliteDb();
  const db = getDatabase();
  db.prepare('INSERT OR IGNORE INTO member_history (user_id, guild_id, joined_at, left_at) VALUES (?, ?, ?, ?)').run(String(userId), String(guildId), joinedAt, leftAt ?? null);
}

function formatDuration(ms) {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);
  if (years >= 1) return years === 1 ? '1 an' : `${years} ans`;
  if (months >= 1) return months === 1 ? '1 mois' : `${months} mois`;
  if (weeks >= 1) return weeks === 1 ? '1 semaine' : `${weeks} semaines`;
  if (days >= 1) return days === 1 ? '1 jour' : `${days} jours`;
  if (hours >= 1) return hours === 1 ? '1 heure' : `${hours} heures`;
  return 'quelques minutes';
}

function ordinalFr(n) {
  if (n === 1) return '1ère';
  return `${n}ème`;
}

function applyVariables(text, vars) {
  if (!text) return '';
  let result = text;
  for (const [k, v] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${k}\\}`, 'g'), v ?? '');
  }
  return result;
}

async function loadImageSafe(url) {
  try {
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 6000 });
    return await loadImage(Buffer.from(res.data));
  } catch {
    return null;
  }
}

// Supprime les emojis et caractères non supportés par DejaVu Sans (canvas)
function stripForCanvas(text) {
  if (!text) return '';
  text = text.replace(/<a?:\w+:\d+>/g, '');           // Emojis custom Discord
  text = text.replace(/[\u{1F000}-\u{1FFFF}]/gu, ''); // Emoji principaux (🐶🏰👥…)
  text = text.replace(/[\u{2600}-\u{26FF}]/gu, '');   // Divers symboles (☀☂…)
  text = text.replace(/[\u{2700}-\u{27BF}]/gu, '');   // Dingbats (✦✂…)
  text = text.replace(/[\u{1F900}-\u{1F9FF}]/gu, ''); // Symboles supplémentaires
  text = text.replace(/[\u{FE00}-\u{FEFF}]/gu, '');   // Variation selectors
  text = text.replace(/[\u200B-\u200D\uFEFF\uFE0E\uFE0F]/g, ''); // Zero-width + VS
  return text.trim();
}

async function generateWelcomeBanner(member, guild, isNew, settings) {
  const W = 900, H = 280;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const newColor = settings.welcome?.newColor || '#1de9b6';
  const returnColor = settings.welcome?.returnColor || '#ffc107';
  const accentColor = isNew ? newColor : returnColor;
  const overlayText = settings.welcome?.bannerOverlayText || "Bienvenue sur Arki' Family";

  // Fond : banner du serveur ou dégradé
  const bannerUrl = guild.bannerURL({ size: 1024, extension: 'png' });
  const customBannerUrl = settings.welcome?.bannerUrl;
  let bgImg = null;
  if (customBannerUrl) bgImg = await loadImageSafe(customBannerUrl);
  if (!bgImg && bannerUrl) bgImg = await loadImageSafe(bannerUrl);

  if (bgImg) {
    // Scale to fill, centered
    const scale = Math.max(W / bgImg.width, H / bgImg.height);
    const sw = bgImg.width * scale, sh = bgImg.height * scale;
    const sx = (W - sw) / 2, sy = (H - sh) / 2;
    ctx.drawImage(bgImg, sx, sy, sw, sh);
  } else {
    // Dégradé de fond
    const grad = ctx.createLinearGradient(0, 0, W, H);
    if (isNew) { grad.addColorStop(0, '#0a1628'); grad.addColorStop(1, '#0d3d3d'); }
    else { grad.addColorStop(0, '#1a1200'); grad.addColorStop(1, '#3d2e00'); }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }

  // Overlay sombre
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, W, H);

  // Bordure colorée en bas
  ctx.fillStyle = accentColor;
  ctx.fillRect(0, H - 6, W, 6);

  // Avatar (cercle)
  const avatarUrl = member.user.displayAvatarURL({ extension: 'png', size: 256 });
  const avatarImg = await loadImageSafe(avatarUrl);
  const AVATAR_R = 90;
  const AVATAR_X = 120;
  const AVATAR_Y = H / 2;
  if (avatarImg) {
    // Glow
    ctx.save();
    ctx.shadowColor = accentColor;
    ctx.shadowBlur = 24;
    ctx.beginPath();
    ctx.arc(AVATAR_X, AVATAR_Y, AVATAR_R + 4, 0, Math.PI * 2);
    ctx.fillStyle = accentColor;
    ctx.fill();
    ctx.restore();
    // Clip circle
    ctx.save();
    ctx.beginPath();
    ctx.arc(AVATAR_X, AVATAR_Y, AVATAR_R, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(avatarImg, AVATAR_X - AVATAR_R, AVATAR_Y - AVATAR_R, AVATAR_R * 2, AVATAR_R * 2);
    ctx.restore();
  }

  // Ligne verticale séparatrice
  ctx.fillStyle = accentColor;
  ctx.globalAlpha = 0.5;
  ctx.fillRect(230, 30, 3, H - 60);
  ctx.globalAlpha = 1;

  // ── Zone texte ──────────────────────────────────────────────────────────────
  const TEXT_X = 258;
  const textMax = W - TEXT_X - 24;

  // Helper : texte avec ombre forte + contour blanc fin pour lisibilité maximale
  function drawStrongText(text, x, y, fontSize, weight = 'bold', color = '#ffffff') {
    ctx.save();
    ctx.font = `${weight} ${fontSize}px DejaVu Sans`;

    // Ombre portée profonde
    ctx.shadowColor = 'rgba(0,0,0,0.95)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 3;

    // Contour noir épais (lisibilité sur fond clair et foncé)
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.lineWidth = fontSize > 40 ? 8 : 5;
    ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y);

    // Remplissage principal
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  // Helper : auto-réduit la taille de police pour tenir dans textMax
  function fitFontSize(text, maxSize, minSize = 16) {
    ctx.font = `bold ${maxSize}px DejaVu Sans`;
    let size = maxSize;
    while (ctx.measureText(text).width > textMax && size > minSize) {
      size -= 2;
      ctx.font = `bold ${size}px DejaVu Sans`;
    }
    return size;
  }

  // ── Ligne 1 : "Bienvenue" / "Bon retour" ── grand, blanc, gras ─────────────
  const mainWord = isNew ? 'Bienvenue' : 'Bon retour';
  const mainSize = fitFontSize(mainWord, 68, 28);
  drawStrongText(mainWord, TEXT_X, H / 2 - 16, mainSize, 'bold', '#ffffff');

  // ── Ligne 2 : "sur le serveur Discord," ── moyen, légèrement teinté ─────────
  const midLine = 'sur le serveur Discord,';
  const midSize = fitFontSize(midLine, 22, 14);
  drawStrongText(midLine, TEXT_X, H / 2 + 18, midSize, 'normal', 'rgba(255,255,255,0.88)');

  // ── Ligne 3 : "Arki'Family" ── grand, couleur accent, gras ─────────────────
  const serverLine = "Arki'Family";
  const serverSize = fitFontSize(serverLine, 46, 22);
  drawStrongText(serverLine, TEXT_X, H / 2 + 68, serverSize, 'bold', accentColor);

  // ── Ligne 4 : nombre de membres ── petit, discret ────────────────────────────
  const memberCount = guild.memberCount;
  ctx.save();
  ctx.font = '15px DejaVu Sans';
  ctx.shadowColor = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur = 10;
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillText(`${memberCount.toLocaleString('fr-FR')} membres`, TEXT_X, H / 2 + 96);
  ctx.restore();

  return canvas.toBuffer('image/png');
}

// Détection palier remarquable (100, 250, 500, 1000, 1500...)
function isMilestone(n) {
  if (n < 100) return false;
  if ([100, 250, 500].includes(n)) return true;
  if (n >= 1000 && n % 500 === 0) return true;
  return false;
}

// Obtenir les stats du mois courant (arrivées / départs)
async function getWelcomeStats(guildId) {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999).getTime();
  const month = now.toLocaleString('fr-FR', { month: 'long', year: 'numeric' });

  const pool = pgStore.getPool();
  if (pool) {
    try {
      const jRes = await pool.query(
        'SELECT COUNT(*) AS cnt FROM member_history WHERE guild_id = $1 AND joined_at >= $2 AND joined_at <= $3',
        [String(guildId), startOfMonth, endOfMonth]
      );
      const lRes = await pool.query(
        'SELECT COUNT(*) AS cnt FROM member_history WHERE guild_id = $1 AND left_at >= $2 AND left_at <= $3',
        [String(guildId), startOfMonth, endOfMonth]
      );
      const j = parseInt(jRes.rows[0]?.cnt || 0);
      const l = parseInt(lRes.rows[0]?.cnt || 0);
      return { joins: j, leaves: l, net: j - l, month };
    } catch (e) { console.warn('[Welcome] PG getWelcomeStats:', e.message); }
  }

  initSqliteDb();
  const db = getDatabase();
  const joins = db.prepare('SELECT COUNT(*) as cnt FROM member_history WHERE guild_id = ? AND joined_at >= ? AND joined_at <= ?').get(String(guildId), startOfMonth, endOfMonth);
  const leaves = db.prepare('SELECT COUNT(*) as cnt FROM member_history WHERE guild_id = ? AND left_at >= ? AND left_at <= ?').get(String(guildId), startOfMonth, endOfMonth);
  return {
    joins: joins?.cnt || 0,
    leaves: leaves?.cnt || 0,
    net: (joins?.cnt || 0) - (leaves?.cnt || 0),
    month,
  };
}

// ─── Phrases d'accueil — lues depuis les settings (éditables via dashboard) ─
const DEFAULT_ARRIVAL_NEW = [
  "C'est un plaisir de t'accueillir, **{name}** ! 🎉",
  "Bienvenue parmi nous, **{name}** ! 😊",
  "On est vraiment ravis de t'avoir avec nous, **{name}** ! 🌟",
  "Oh ! Un nouveau visage ! Bienvenue **{name}** ! 👋",
  "**{name}** vient de débarquer ! Soyez sympas ! 🎊",
  "Heyy **{name}** ! Bienvenue dans la famille ! 🥳",
];
const DEFAULT_ARRIVAL_RETURN = [
  "Oh mais c'est **{name}** qui revient ! 😄",
  "Que c'est bon de te revoir, **{name}** ! 🤗",
  "**{name}** est de retour ! L'aventure continue ! ⚡",
  "Tiens tiens, **{name}** ! On ne t'avait pas oublié ! 😉",
  "**{name}** revient parmi nous ! Bienvenue à nouveau ! 🎊",
];
const DEFAULT_GREET_NEW = [
  "Bienvenue **{mention}** ! Super content(e) de t'avoir parmi nous ! 🎉",
  "Heyy **{mention}** ! Bienvenue dans la famille ! 🥳",
  "Bienvenue **{mention}** ! N'hésite pas si tu as des questions ! 😊",
  "Coucou **{mention}** ! Content(e) de te voir rejoindre l'aventure ! ⚡",
  "Oh une nouvelle tête ! Bienvenue **{mention}**, on espère que tu t'y plairas ! 🌟",
  "**{mention}** est parmi nous ! Bienvenue et bonne aventure ! 🏹",
];
const DEFAULT_GREET_RETURN = [
  "Bon retour **{mention}** ! On t'attendait ! 🤗",
  "Enfin de retour **{mention}** ! La famille est au complet ! 🎊",
  "Bon retour parmi nous **{mention}** ! Content(e) de te revoir ! 😄",
  "Heyy **{mention}** ! Tu nous avais manqué ! 🥳",
  "**{mention}** est de retour ! L'aventure reprend ! ⚡",
];
const DEFAULT_GREET_GONE = [
  "Euh... {mention} est déjà reparti(e) 💨 T'as voulu souhaiter la bienvenue à un fantôme ?",
  "Trop tard ! {mention} a fait le tour du propriétaire et s'est barré en vitesse 🚪💨",
  "{mention} ? Connais pas. Il/Elle est passé(e) en coup de vent et a disparu avant même qu'on puisse dire \"bienvenue\" 😅",
  "Bonne nouvelle : {mention} a rejoint le serveur. Mauvaise nouvelle : il/elle est déjà parti(e) 👋 Belle visite éclair !",
  "Rip {mention} 🪦 A vécu sur ce serveur environ 3 secondes. Une belle carrière.",
  "{mention} a jeté un œil, n'a pas aimé ce qu'il/elle a vu, et s'est évaporé(e) 🌫️ Brutal.",
  "Ah... {mention} voulait juste vérifier que le serveur existait. Mission accomplie, au revoir 🕵️",
  "Trop tard pour {mention} 💀 Il/Elle court encore. Bonne chance pour le rattraper.",
];

function getWelcomePhrases() {
  const ws = getSettings().welcome || {};
  return {
    arrivalNew:    (ws.arrivalPhrasesNew    && ws.arrivalPhrasesNew.length)    ? ws.arrivalPhrasesNew    : DEFAULT_ARRIVAL_NEW,
    arrivalReturn: (ws.arrivalPhrasesReturn && ws.arrivalPhrasesReturn.length) ? ws.arrivalPhrasesReturn : DEFAULT_ARRIVAL_RETURN,
    greetNew:      (ws.greetPhrasesNew      && ws.greetPhrasesNew.length)      ? ws.greetPhrasesNew      : DEFAULT_GREET_NEW,
    greetReturn:   (ws.greetPhrasesReturn   && ws.greetPhrasesReturn.length)   ? ws.greetPhrasesReturn   : DEFAULT_GREET_RETURN,
    greetGone:     (ws.greetPhrasesGone     && ws.greetPhrasesGone.length)     ? ws.greetPhrasesGone     : DEFAULT_GREET_GONE,
  };
}

function getRandomArrivalPhrase(name, isNew) {
  const phrases = getWelcomePhrases();
  const list = isNew ? phrases.arrivalNew : phrases.arrivalReturn;
  return list[Math.floor(Math.random() * list.length)].replace(/{name}/g, name);
}
function getRandomGreetPhrase(mention, isNew) {
  const phrases = getWelcomePhrases();
  const list = isNew ? phrases.greetNew : phrases.greetReturn;
  return list[Math.floor(Math.random() * list.length)].replace(/{mention}/g, mention);
}
function getRandomGreetGonePhrase(mention) {
  const phrases = getWelcomePhrases();
  const list = phrases.greetGone;
  return list[Math.floor(Math.random() * list.length)].replace(/{mention}/g, mention);
}

// ─── Embed de bienvenue ────────────────────────────────────────────────────
async function buildWelcomeEmbed(member, guild, client, forceIsNew = null) {
  const settings = getSettings();
  const ws = settings.welcome || {};
  const visits = await getMemberVisits(member.id, guild.id);
  const visitCount = visits.length;
  const isNew = forceIsNew !== null ? forceIsNew : visitCount <= 1;

  const newColor = parseInt((ws.newColor || '#1de9b6').replace('#', ''), 16);
  const returnColor = parseInt((ws.returnColor || '#ffc107').replace('#', ''), 16);
  const embedColor = isNew ? newColor : returnColor;

  const memberCount = guild.memberCount;
  const name = member.displayName || member.user.username;

  // Variables pour le message
  const vars = {
    user: name,
    userMention: `<@${member.id}>`,
    memberCount: memberCount.toLocaleString('fr-FR'),
    server: guild.name,
    visitCount: String(visitCount),
    visitOrdinal: ordinalFr(visitCount),
  };

  // Infos retour
  let lastLeftStr = '';
  let lastDurationStr = '';
  let absenceDays = 0;
  if (!isNew && visits.length >= 2) {
    const prevVisit = visits[visits.length - 2];
    if (prevVisit.left_at) {
      absenceDays = Math.floor((Date.now() - prevVisit.left_at) / (1000 * 60 * 60 * 24));
      lastLeftStr = `il y a ${formatDuration(Date.now() - prevVisit.left_at)}`;
      lastDurationStr = formatDuration(prevVisit.left_at - prevVisit.joined_at);
    }
    vars.lastLeft = lastLeftStr || '—';
    vars.lastDuration = lastDurationStr || '—';
  } else {
    vars.lastLeft = '—';
    vars.lastDuration = '—';
  }

  // Titre avec milestone éventuel
  let baseTitle = isNew
    ? applyVariables(ws.newTitle || '🎉 Bienvenue sur {server} !', vars)
    : applyVariables(ws.returnTitle || '👋 Bon retour parmi nous, {user} !', vars);

  if (isNew && isMilestone(memberCount)) {
    baseTitle = `🎊 ${baseTitle} — **${memberCount.toLocaleString('fr-FR')}ème membre !**`;
  }

  const bodyText = isNew
    ? applyVariables(ws.newMessage || 'Bienvenue {userMention} ! Tu es notre **{memberCount}ème** membre ! 🎉', vars)
    : applyVariables(ws.returnMessage || 'Ravi de te revoir {userMention} ! Tu es notre **{memberCount}ème** membre actuel 🎉', vars);

  const description = `# ${baseTitle}\n${bodyText}`;

  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setDescription(description)
    .setThumbnail(member.user.displayAvatarURL({ extension: 'png', size: 256 }));

  // Champs retour
  if (!isNew) {
    embed.addFields({ name: '🔁 Visite', value: ordinalFr(visitCount) + ' fois ici', inline: true });
    if (lastLeftStr) embed.addFields({ name: '📅 Absent depuis', value: lastLeftStr, inline: true });
    if (lastDurationStr) embed.addFields({ name: '⏱️ Séjour précédent', value: lastDurationStr, inline: true });
    // Longue absence (> 365 jours = "fantôme")
    if (absenceDays >= 365) {
      embed.addFields({ name: '👻 Vrai fantôme !', value: `Absent plus d'un an… mais de retour !`, inline: false });
    }
  }

  // Membre milestone → champ spécial
  if (isNew && isMilestone(memberCount)) {
    embed.addFields({ name: '🎊 Palier atteint !', value: `Vous êtes **${memberCount.toLocaleString('fr-FR')} membres** sur le serveur !`, inline: false });
  }

  // Génération de la bannière
  let bannerBuffer = null;
  try {
    bannerBuffer = await generateWelcomeBanner(member, guild, isNew, settings);
  } catch (err) {
    console.error('[Welcome] Erreur génération bannière:', err.message);
  }

  let attachment = null;
  if (bannerBuffer) {
    attachment = new AttachmentBuilder(bannerBuffer, { name: 'welcome.png' });
    embed.setImage('attachment://welcome.png');
  }

  return { embed, attachment, isNew };
}

// DM au membre à l'arrivée
async function sendWelcomeDM(member, guild) {
  const settings = getSettings();
  const ws = settings.welcome || {};
  if (!ws.dmEnabled || !ws.dmMessage) return;

  const visits = await getMemberVisits(member.id, guild.id);
  const visitCount = visits.length;
  const name = member.displayName || member.user.username;

  const vars = {
    user: name,
    userMention: `<@${member.id}>`,
    memberCount: guild.memberCount.toLocaleString('fr-FR'),
    server: guild.name,
    visitCount: String(visitCount),
    visitOrdinal: ordinalFr(visitCount),
    lastLeft: '—',
    lastDuration: '—',
  };

  const text = applyVariables(ws.dmMessage, vars);
  try {
    await member.send(text);
  } catch (err) {
    console.warn(`[Welcome] DM impossible à ${member.user.tag} :`, err.message);
  }
}

module.exports = {
  recordJoin,
  recordLeave,
  getMemberVisits,
  insertMemberHistory,
  buildWelcomeEmbed,
  sendWelcomeDM,
  getWelcomeStats,
  applyVariables,
  formatDuration,
  isMilestone,
  getRandomArrivalPhrase,
  getRandomGreetPhrase,
  getRandomGreetGonePhrase,
  getWelcomePhrases,
};
