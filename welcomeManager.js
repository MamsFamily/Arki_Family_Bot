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

  // Texte principal
  const TEXT_X = 255;
  const name = member.displayName || member.user.username;

  // Titre (Bienvenue / Bon retour)
  ctx.fillStyle = accentColor;
  ctx.font = 'bold 22px DejaVu Sans';
  ctx.fillText(isNew ? '✦ Nouveau membre ✦' : '✦ De retour parmi nous ✦', TEXT_X, H / 2 - 55);

  // Nom du membre
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 38px DejaVu Sans';
  const nameMax = W - TEXT_X - 30;
  let nameText = name;
  while (ctx.measureText(nameText).width > nameMax && nameText.length > 3) {
    nameText = nameText.slice(0, -2) + '…';
  }
  ctx.fillText(nameText, TEXT_X, H / 2);

  // Sous-texte
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = '18px DejaVu Sans';
  ctx.fillText(overlayText, TEXT_X, H / 2 + 40);

  // Nombre de membres
  const memberCount = guild.memberCount;
  ctx.fillStyle = accentColor;
  ctx.font = 'bold 16px DejaVu Sans';
  ctx.fillText(`👥 ${memberCount.toLocaleString('fr-FR')} membres`, TEXT_X, H / 2 + 75);

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

async function buildWelcomeEmbed(member, guild, client) {
  const settings = getSettings();
  const ws = settings.welcome || {};
  const visits = await getMemberVisits(member.id, guild.id);
  const visitCount = visits.length;
  const isNew = visitCount <= 1;

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

  const description = isNew
    ? applyVariables(ws.newMessage || 'Bienvenue {userMention} ! Tu es notre **{memberCount}ème** membre ! 🎉', vars)
    : applyVariables(ws.returnMessage || 'Ravi de te revoir {userMention} ! Tu es notre **{memberCount}ème** membre actuel 🎉', vars);

  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setTitle(baseTitle)
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

  return { embed, attachment };
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
};
