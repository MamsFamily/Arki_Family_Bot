const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const multer = require('multer');

const uploadStorage = multer.diskStorage({
  destination: path.join(__dirname, 'public/uploads'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    cb(null, `shop_${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Fichier non supporté'));
  },
});
const { getSettings, updateSection } = require('../settingsManager');
const { getShop, addPack, updatePack, deletePack, reorderPacks, getPack, updateShopChannel, updateShopChannels, saveShopIndexMessage, addCategory, updateCategory, deleteCategory, getCategories, buildPackEmbed, DEFAULT_CATEGORIES } = require('../shopManager');
const { getDinoData, addDino, updateDino, deleteDino, getDino, updateDinoChannel, updateLetterMessage, getLetterMessages, updateLetterColor, getLetterColor, getLetterColors, getDinosByLetter, getModdedDinos, getShoulderDinos, getPaidDLCDinos, buildLetterEmbed, buildLetterEmbeds, buildModdedEmbed, buildModdedEmbeds, buildShoulderEmbed, buildPaidDLCEmbeds, buildVariantEmbeds, buildSaleEmbed, getVisibleVariantLabels, getDinosByVariant, buildVariantEmbed, getAllLetters, updateNavMessage, getNavMessage, updateDinoIndexChannel, updateDinoIndexMessage, getDinoIndexInfo, saveDinos, DEFAULT_LETTER_COLORS, getActiveFlashSale, setFlashSale, clearFlashSale } = require('../dinoManager');
// Variantes publiables comme catégories dédiées dans l'index
const VARIANT_KEYS = { VARIANT_A: 'A', VARIANT_TEK: 'Tek' };

const { getConfig: readConfig, saveConfig } = require('../configManager');
const inventoryManager = require('../inventoryManager');
const { getSpecialPacks, getSpecialPack, addSpecialPack, updateSpecialPack, deleteSpecialPack } = require('../specialPacksManager');
const giveawayManager = require('../giveawayManager');
const economyManager = require('../economyManager');
const xpManager = require('../xpManager');

const pgStore = require('../pgStore');

function createWebServer(discordClient) {
  const app = express();

  // Init PostgreSQL si disponible (partagé avec Railway)
  pgStore.initPool();
  pgStore.initTables().catch(() => {});

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.use(express.static(path.join(__dirname, 'public')));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  function getPasswords() {
    const settings = getSettings();
    return {
      admin: settings.auth?.adminPassword || process.env.DASHBOARD_PASSWORD || 'arki2024',
      staff: settings.auth?.staffPassword || 'arkistaff',
    };
  }

  const pgPool = pgStore.getPool();
  const isProduction = !!(process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL);
  if (isProduction) app.set('trust proxy', 1);
  app.use(session({
    store: pgPool ? new PgSession({ pool: pgPool, tableName: 'session', createTableIfMissing: false }) : undefined,
    secret: process.env.SESSION_SECRET || require('crypto').randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax',
      secure: isProduction,
    }
  }));

  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    next();
  });

  function isApiRequest(req) {
    return req.path.startsWith('/api/') || req.path.startsWith('/nitrado/api/') || req.headers['content-type'] === 'application/json' || req.xhr;
  }

  function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated && req.session.discordUser) {
      return next();
    }
    if (isApiRequest(req)) return res.status(401).json({ ok: false, error: 'Session expirée — recharge la page et reconnecte-toi.' });
    res.redirect('/login');
  }

  function requireAdmin(req, res, next) {
    if (req.session && req.session.authenticated && req.session.discordUser && req.session.role === 'admin') {
      return next();
    }
    if (isApiRequest(req)) {
      if (req.session && req.session.authenticated && req.session.discordUser) {
        return res.status(403).json({ ok: false, error: 'Accès réservé aux administrateurs.' });
      }
      return res.status(401).json({ ok: false, error: 'Session expirée — recharge la page et reconnecte-toi.' });
    }
    if (req.session && req.session.authenticated && req.session.discordUser) {
      return res.redirect('/');
    }
    res.redirect('/login');
  }

  // ─── API PUBLIQUE INVENTAIRE ────────────────────────────────────────────────
  function validateApiKey(req) {
    const settings = getSettings();
    const key = settings.api?.inventoryApiKey;
    if (!key) return false;
    const header = req.headers['authorization'];
    if (header && header.startsWith('Bearer ')) return header.slice(7) === key;
    if (req.body?.apiKey === key) return true;
    if (req.query?.apiKey === key) return true;
    return false;
  }

  app.post('/api/inventory/add', async (req, res) => {
    if (!validateApiKey(req)) {
      return res.status(401).json({ error: 'Clé API invalide ou manquante' });
    }
    const { playerId, itemId, quantity, reason } = req.body;
    if (!playerId || !itemId || !quantity) {
      return res.status(400).json({ error: 'Champs requis : playerId, itemId, quantity' });
    }
    const qty = Math.max(1, parseInt(quantity) || 1);
    try {
      const result = await inventoryManager.addToInventory(playerId, itemId, qty, 'api', reason || '');
      return res.json({ success: true, playerId, itemId, newQuantity: result.newQuantity });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/inventory/player/:playerId', async (req, res) => {
    if (!validateApiKey(req)) {
      return res.status(401).json({ error: 'Clé API invalide ou manquante' });
    }
    const inventory = inventoryManager.getPlayerInventory(req.params.playerId);
    return res.json({ playerId: req.params.playerId, inventory });
  });

  app.post('/api/inventory/regenerate-key', requireAdmin, async (req, res) => {
    const key = require('crypto').randomBytes(24).toString('hex');
    await updateSection('api', { inventoryApiKey: key });
    res.json({ success: true, key });
  });

  // ─── Endpoint adaptateur pour bots externes (format flexible) ───────────────
  // Accepte le format : { discord_user_id, amount, currency, source, apiKey }
  app.post('/api/quizz/reward', async (req, res) => {
    if (!validateApiKey(req)) {
      return res.status(401).json({ error: 'Clé API invalide ou manquante' });
    }

    // Mapping des champs entrants vers notre format interne
    const playerId   = req.body.discord_user_id || req.body.user_id || req.body.playerId;
    const quantity   = parseInt(req.body.amount  || req.body.quantity) || 0;
    const reason     = req.body.source || req.body.reason || 'quizz';

    // Normalisation de la devise : "fraise" → "fraises", etc.
    const currencyRaw = (req.body.currency || req.body.itemId || '').toLowerCase().trim();
    const currencyMap = { fraise: 'fraises', fraises: 'fraises', diamant: 'diamants', diamants: 'diamants' };
    const itemId = currencyMap[currencyRaw] || currencyRaw;

    if (!playerId || !itemId || quantity < 1) {
      return res.status(400).json({ error: 'Champs requis : discord_user_id, amount (>0), currency' });
    }

    try {
      const result = await inventoryManager.addToInventory(playerId, itemId, quantity, 'api-quizz', reason);
      return res.json({ success: true, playerId, itemId, quantity, newQuantity: result.newQuantity });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });
  // ────────────────────────────────────────────────────────────────────────────

  function getBaseUrl(req) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${proto}://${host}`;
  }

  function getDiscordOAuthUrl(req, state) {
    const clientId = process.env.DISCORD_CLIENT_ID;
    const redirectUri = encodeURIComponent(`${getBaseUrl(req)}/auth/discord/callback`);
    return `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=identify&state=${state}`;
  }

  function renderEmoji(emoji) {
    if (!emoji) return '';
    const match = emoji.match(/^<(a?):(\w+):(\d+)>$/);
    if (match) {
      const animated = match[1] === 'a';
      const name = match[2];
      const id = match[3];
      const ext = animated ? 'gif' : 'png';
      return `<img src="https://cdn.discordapp.com/emojis/${id}.${ext}" alt="${name}" class="discord-emoji">`;
    }
    return emoji.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function plainEmoji(emoji) {
    if (!emoji) return '';
    const match = emoji.match(/^<a?:(\w+):\d+>$/);
    if (match) return ':' + match[1] + ':';
    return emoji;
  }

  app.use((req, res, next) => {
    res.locals.botUser = discordClient?.user || null;
    res.locals.path = req.path;
    res.locals.role = req.session?.role || null;
    res.locals.discordUser = req.session?.discordUser || null;
    res.locals.renderEmoji = renderEmoji;
    res.locals.plainEmoji = plainEmoji;
    next();
  });

  app.get('/login', (req, res) => {
    if (req.session && req.session.authenticated && req.session.discordUser) {
      return res.redirect('/');
    }
    res.render('login', { error: req.query.error || null });
  });

  app.post('/login', (req, res) => {
    const { password } = req.body;
    const passwords = getPasswords();
    const directPassword = 'Lola6';
    if (password === directPassword) {
      req.session.authenticated = true;
      req.session.role = 'admin';
      req.session.discordUser = {
        id: '0',
        username: 'Admin',
        displayName: 'Admin',
        avatar: 'https://cdn.discordapp.com/embed/avatars/0.png',
      };
      return res.redirect('/');
    }
    let role = null;
    if (password === passwords.admin) {
      role = 'admin';
    } else if (password === passwords.staff) {
      role = 'staff';
    }
    if (!role) {
      return res.render('login', { error: 'Mot de passe incorrect' });
    }
    req.session.pendingRole = role;
    const state = require('crypto').randomBytes(16).toString('hex');
    req.session.oauthState = state;
    res.redirect(getDiscordOAuthUrl(req, state));
  });

  app.get('/auth/discord/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state || state !== req.session?.oauthState) {
      return res.redirect('/login?error=' + encodeURIComponent('Authentification Discord échouée'));
    }
    try {
      const redirectUri = `${getBaseUrl(req)}/auth/discord/callback`;
      const tokenRes = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

      const userRes = await axios.get('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }
      });

      const discordUser = userRes.data;
      let displayName = discordUser.global_name || discordUser.username;
      if (discordClient) {
        try {
          const settings = getSettings();
          const guildId = settings.guild.guildId;
          const guild = guildId ? discordClient.guilds.cache.get(guildId) : discordClient.guilds.cache.first();
          if (guild) {
            const member = await guild.members.fetch(discordUser.id).catch(() => null);
            if (member && member.displayName) {
              displayName = member.displayName;
            }
          }
        } catch (e) {}
      }

      req.session.authenticated = true;
      req.session.role = req.session.pendingRole || 'staff';
      req.session.discordUser = {
        id: discordUser.id,
        username: discordUser.username,
        displayName,
        avatar: discordUser.avatar
          ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png?size=64`
          : `https://cdn.discordapp.com/embed/avatars/${(BigInt(discordUser.id) >> 22n) % 6n}.png`,
      };
      delete req.session.pendingRole;
      delete req.session.oauthState;

      res.redirect('/');
    } catch (err) {
      console.error('Erreur OAuth Discord:', err.response?.data || err.message);
      delete req.session.pendingRole;
      delete req.session.oauthState;
      res.redirect('/login?error=' + encodeURIComponent('Erreur lors de la connexion Discord'));
    }
  });

  app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
  });

  app.get('/', requireAuth, async (req, res) => {
    const { getVotesConfig } = require('../votesConfig');
    const { fetchTopserveursRanking } = require('../topserveursService');
    const { fetchNitradoServers } = require('../nitradoService');
    const votesConfig = getVotesConfig();

    const memberCount = discordClient?.guilds?.cache?.reduce((acc, g) => acc + g.memberCount, 0) || 0;

    const [top5Result, nitradoResult] = await Promise.allSettled([
      (async () => {
        const baseUrl = (votesConfig.TOPSERVEURS_RANKING_URL || 'https://api.top-serveurs.net/v1/servers/4ROMAU33GJTY/players-ranking')
          .replace('?type=lastMonth', '').replace('&type=lastMonth', '')
          .replace('?type=currentMonth', '').replace('&type=currentMonth', '');
        const currentUrl = baseUrl + (baseUrl.includes('?') ? '&' : '?') + 'type=currentMonth';
        const all = await fetchTopserveursRanking(currentUrl);
        return all.slice(0, 5);
      })(),
      fetchNitradoServers(),
    ]);

    const top5 = top5Result.status === 'fulfilled' ? top5Result.value : [];
    const nitradoServers = nitradoResult.status === 'fulfilled' ? nitradoResult.value : [];

    // Stats welcome (arrivées/départs mois courant)
    let welcomeStats = { joins: 0, leaves: 0, net: 0, month: '' };
    try {
      const { getWelcomeStats } = require('../welcomeManager');
      const settings = getSettings();
      const guildId = discordClient?.guilds?.cache?.first()?.id || settings.guild?.guildId || '';
      if (guildId) welcomeStats = await getWelcomeStats(guildId);
    } catch {}

    res.render('dashboard', {
      memberCount,
      uptime: process.uptime(),
      top5,
      nitradoServers,
      welcomeStats,
    });
  });

  app.get('/api/top5', requireAuth, async (req, res) => {
    const { getVotesConfig } = require('../votesConfig');
    const { fetchTopserveursRanking } = require('../topserveursService');
    const votesConfig = getVotesConfig();
    const baseUrl = (votesConfig.TOPSERVEURS_RANKING_URL || 'https://api.top-serveurs.net/v1/servers/4ROMAU33GJTY/players-ranking')
      .replace('?type=lastMonth', '')
      .replace('&type=lastMonth', '')
      .replace('?type=currentMonth', '')
      .replace('&type=currentMonth', '');
    const currentUrl = baseUrl + (baseUrl.includes('?') ? '&' : '?') + 'type=currentMonth';
    try {
      const all = await fetchTopserveursRanking(currentUrl);
      res.json({ ok: true, top5: all.slice(0, 5), updatedAt: Date.now() });
    } catch (err) {
      res.json({ ok: false, top5: [], updatedAt: Date.now() });
    }
  });

  app.get('/api/nitrado', requireAuth, async (req, res) => {
    const { fetchNitradoServers } = require('../nitradoService');
    try {
      const servers = await fetchNitradoServers();
      res.json({ ok: true, servers, updatedAt: Date.now() });
    } catch (err) {
      res.json({ ok: false, servers: [], updatedAt: Date.now() });
    }
  });

  // ─── WELCOME ──────────────────────────────────────────────────────────────
  app.get('/welcome', requireAdmin, async (req, res) => {
    const settings = getSettings();
    const welcome = settings.welcome || {};
    let channels = [];
    if (discordClient) {
      try {
        const guild = discordClient.guilds.cache.first();
        if (guild) {
          channels = guild.channels.cache
            .filter(ch => ch.type === 0)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(ch => ({ id: ch.id, name: ch.name }));
        }
      } catch {}
    }
    res.render('welcome', { welcome, channels, success: req.query.success || null, error: null,
      botUser: discordClient?.user || null, discordUser: req.session?.discordUser || null, role: req.session?.role || 'admin' });
  });

  app.post('/welcome', requireAdmin, async (req, res) => {
    try {
      const settings = getSettings();
      const existing = settings.welcome || {};
      await updateSection('welcome', {
        enabled: req.body.enabled === '1',
        channelId: req.body.channelId || '',
        pingDelay: parseInt(req.body.pingDelay) || 10,
        newColor: req.body.newColor || '#1de9b6',
        returnColor: req.body.returnColor || '#ffc107',
        bannerUrl: req.body.bannerUrl || '',
        bannerOverlayText: req.body.bannerOverlayText || "Bienvenue sur Arki' Family",
        newTitle: req.body.newTitle || '🎉 Bienvenue sur {server} !',
        returnTitle: req.body.returnTitle || '👋 Bon retour parmi nous, {user} !',
        newMessage: req.body.newMessage || '',
        returnMessage: req.body.returnMessage || '',
        dmEnabled: req.body.dmEnabled === '1',
        dmMessage: req.body.dmMessage || '',
        autoRolesNew: existing.autoRolesNew || [],
        autoRolesReturn: existing.autoRolesReturn || [],
        arrivalPhrasesNew: existing.arrivalPhrasesNew,
        arrivalPhrasesReturn: existing.arrivalPhrasesReturn,
        greetPhrasesNew: existing.greetPhrasesNew,
        greetPhrasesReturn: existing.greetPhrasesReturn,
      });
      res.redirect('/welcome?success=Paramètres+de+bienvenue+enregistrés');
    } catch (err) {
      const settings = getSettings();
      res.render('welcome', { welcome: settings.welcome || {}, channels: [], success: null, error: 'Erreur : ' + err.message,
        botUser: discordClient?.user || null, discordUser: req.session?.discordUser || null, role: req.session?.role || 'admin' });
    }
  });

  app.post('/welcome/test', requireAdmin, async (req, res) => {
    try {
      const settings = getSettings();
      const ws = settings.welcome || {};
      const type = req.body.type || 'new';
      // Priorité : userId fourni dans le body, sinon session Discord, sinon propriétaire du serveur
      const userId = req.body.userId || req.session?.discordUser?.id;
      const guildId = settings.guild?.guildId || '';

      const { buildWelcomeEmbed, insertMemberHistory, getMemberVisits, getRandomArrivalPhrase, getRandomGreetPhrase } = require('../welcomeManager');
      const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

      if (type === 'return') {
        // Injecter un séjour passé en base (PostgreSQL ou SQLite selon l'env)
        const now = Date.now();
        const joined = now - 90 * 24 * 3600 * 1000;
        const left   = now - 30 * 24 * 3600 * 1000;
        await insertMemberHistory(userId, guildId, joined, left);
      }

      // Forcer le type pour contourner l'historique réel en base
      const forceIsNew = type === 'new' ? true : type === 'return' ? false : null;

      // Si le bot est connecté, envoyer le message Discord
      if (discordClient) {
        if (!ws.channelId) return res.json({ error: 'Aucun salon de bienvenue configuré' });
        const guild = discordClient.guilds.cache.first();
        if (!guild) return res.json({ error: 'Aucun serveur Discord trouvé' });
        const channel = guild.channels.cache.get(ws.channelId);
        if (!channel) return res.json({ error: 'Salon introuvable (ID invalide ?)' });
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) return res.json({ error: `Membre <@${userId}> introuvable sur le serveur. Il doit être présent pour que le test envoie le message Discord.` });

        const { embed, attachment } = await buildWelcomeEmbed(member, guild, discordClient, forceIsNew);
        const files = attachment ? [attachment] : [];
        const label = type === 'return' ? 'revenant' : 'nouveau membre';
        const isNew = forceIsNew !== false;

        // Message 1 : embed (original) + bouton admission spawn (si configuré)
        const spawnSettings = getSettings().spawnTicket || {};
        const embedComponents = [];
        if (spawnSettings.ticketCategoryId || spawnSettings.adminRoleIds?.length) {
          embedComponents.push(
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId('spwn_open')
                .setLabel('🐣 Commencer l\'admission')
                .setStyle(ButtonStyle.Secondary)
            )
          );
        }
        await channel.send({ content: `🧪 **Test** (${label})`, embeds: [embed], files, components: embedComponents });

        // Message 2 : phrase aléatoire avec ping + bouton "Souhaiter la bienvenue"
        const displayName = member.displayName || member.user.username;
        const arrivalPhrase = getRandomArrivalPhrase(displayName, isNew);
        const btnLabel = isNew ? '🎉 Souhaiter la bienvenue' : '🤗 Souhaiter un bon retour';
        const greetRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`welcome_greet:${member.id}:${isNew ? 'new' : 'return'}`)
            .setLabel(btnLabel)
            .setStyle(ButtonStyle.Primary)
        );
        await channel.send({ content: arrivalPhrase, components: [greetRow] });

        // Ping auto-supprimé après 5s
        const delay = Math.max(0, parseInt(ws.pingDelay) || 5) * 1000;
        setTimeout(async () => {
          try {
            const pingMsg = await channel.send({ content: `<@${member.id}>` });
            setTimeout(() => pingMsg.delete().catch(() => {}), 5000);
          } catch {}
        }, delay);

        return res.json({ message: `✅ Message de test envoyé dans #${channel.name}` });
      }

      // Mode dashboard seul (Replit) : les données ont été insérées en base
      const visits = await getMemberVisits(userId, guildId);
      if (type === 'return') {
        return res.json({ message: `📝 Séjour précédent enregistré pour \`${userId}\` (${visits.length} visite(s) en base). Quand il rejoindra le serveur sur Railway, il sera reconnu comme revenant.` });
      }
      return res.json({ message: `📝 ID \`${userId}\` prêt comme nouveau membre (${visits.length} visite(s) en base). Le message Discord ne peut être envoyé que depuis Railway.` });

    } catch (err) {
      console.error('[Welcome test]', err);
      res.json({ error: err.message });
    }
  });

  // ─── Rôles automatiques bienvenue ────────────────────────────────────────
  app.get('/api/guild-roles', requireAdmin, async (req, res) => {
    try {
      const guildId = getSettings().guild?.guildId;
      const token = process.env.DISCORD_TOKEN;
      if (!token || !guildId) return res.json({ roles: [] });
      const resp = await axios.get(`https://discord.com/api/v10/guilds/${guildId}/roles`, {
        headers: { Authorization: `Bot ${token}` },
      });
      const roles = resp.data
        .filter(r => r.name !== '@everyone')
        .sort((a, b) => b.position - a.position)
        .map(r => ({ id: r.id, name: r.name, color: r.color ? '#' + r.color.toString(16).padStart(6, '0') : null }));
      res.json({ roles });
    } catch (e) {
      res.json({ roles: [], error: e.message });
    }
  });

  app.post('/welcome/roles/add', requireAdmin, async (req, res) => {
    try {
      const { roleId, roleName, type } = req.body;
      const key = type === 'return' ? 'autoRolesReturn' : 'autoRolesNew';
      if (!roleId || !roleName) return res.json({ ok: false, error: 'Données manquantes' });
      const settings = getSettings();
      const ws = settings.welcome || {};
      const list = Array.isArray(ws[key]) ? [...ws[key]] : [];
      if (!list.find(r => r.id === roleId)) {
        list.push({ id: roleId, name: roleName });
        await updateSection('welcome', { ...ws, [key]: list });
      }
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  app.post('/welcome/roles/delete', requireAdmin, async (req, res) => {
    try {
      const { roleId, type } = req.body;
      const key = type === 'return' ? 'autoRolesReturn' : 'autoRolesNew';
      const settings = getSettings();
      const ws = settings.welcome || {};
      const list = (ws[key] || []).filter(r => r.id !== roleId);
      await updateSection('welcome', { ...ws, [key]: list });
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ─── Phrases d'accueil ────────────────────────────────────────────────────
  app.get('/welcome/phrases', requireAdmin, (req, res) => {
    const { getWelcomePhrases } = require('../welcomeManager');
    const phrases = getWelcomePhrases();
    res.render('welcome-phrases', { phrases, botUser: discordClient?.user || null, discordUser: req.session?.discordUser || null, role: req.session?.role || 'admin', success: req.query.success, error: req.query.error });
  });

  app.post('/welcome/phrases/add', requireAdmin, async (req, res) => {
    try {
      const { category, phrase } = req.body;
      const keyMap = { arrivalNew: 'arrivalPhrasesNew', arrivalReturn: 'arrivalPhrasesReturn', greetNew: 'greetPhrasesNew', greetReturn: 'greetPhrasesReturn', greetGone: 'greetPhrasesGone' };
      const key = keyMap[category];
      if (!key || !phrase?.trim()) return res.redirect('/welcome/phrases?error=Phrase+vide+ou+catégorie+invalide');
      const settings = getSettings();
      const ws = settings.welcome || {};
      const list = Array.isArray(ws[key]) ? [...ws[key]] : [];
      list.push(phrase.trim());
      await updateSection('welcome', { ...ws, [key]: list });
      res.redirect('/welcome/phrases?success=Phrase+ajoutée');
    } catch (e) {
      res.redirect('/welcome/phrases?error=' + encodeURIComponent(e.message));
    }
  });

  app.post('/welcome/phrases/delete', requireAdmin, async (req, res) => {
    try {
      const { category, index } = req.body;
      const keyMap = { arrivalNew: 'arrivalPhrasesNew', arrivalReturn: 'arrivalPhrasesReturn', greetNew: 'greetPhrasesNew', greetReturn: 'greetPhrasesReturn', greetGone: 'greetPhrasesGone' };
      const key = keyMap[category];
      if (!key) return res.redirect('/welcome/phrases?error=Catégorie+invalide');
      const settings = getSettings();
      const ws = settings.welcome || {};
      const list = Array.isArray(ws[key]) ? [...ws[key]] : [];
      const idx = parseInt(index);
      if (isNaN(idx) || idx < 0 || idx >= list.length) return res.redirect('/welcome/phrases?error=Index+invalide');
      if (list.length <= 1) return res.redirect('/welcome/phrases?error=Impossible+de+supprimer+la+dernière+phrase');
      list.splice(idx, 1);
      await updateSection('welcome', { ...ws, [key]: list });
      res.redirect('/welcome/phrases?success=Phrase+supprimée');
    } catch (e) {
      res.redirect('/welcome/phrases?error=' + encodeURIComponent(e.message));
    }
  });

  app.get('/discord-ref', requireAdmin, (req, res) => {
    res.render('discord-ref');
  });

  app.get('/roulette', requireAdmin, async (req, res) => {
    const config = await readConfig();
    res.render('roulette', { config, success: null, error: null });
  });

  app.post('/roulette', requireAdmin, async (req, res) => {
    const { title, choices } = req.body;

    if (!title || title.trim().length === 0) {
      return res.render('roulette', { config: await readConfig(), success: null, error: 'Le titre ne peut pas être vide.' });
    }
    if (title.trim().length > 20) {
      return res.render('roulette', { config: await readConfig(), success: null, error: 'Le titre ne doit pas dépasser 20 caractères.' });
    }

    const choicesArray = choices.split('\n').map(c => c.trim()).filter(c => c.length > 0);

    if (choicesArray.length < 2) {
      return res.render('roulette', { config: await readConfig(), success: null, error: 'Minimum 2 choix requis.' });
    }
    if (choicesArray.length > 12) {
      return res.render('roulette', { config: await readConfig(), success: null, error: 'Maximum 12 choix autorisés.' });
    }

    const config = await saveConfig({
      rouletteTitle: title.trim(),
      rouletteChoices: choicesArray,
    });

    res.render('roulette', { config, success: 'Configuration sauvegardée !', error: null });
  });

  app.get('/votes', requireAdmin, async (req, res) => {
    const { fetchTopserveursRanking } = require('../topserveursService');
    const { getVotesConfig } = require('../votesConfig');
    const votesConfig = getVotesConfig();
    const { monthNameFr } = require('../votesUtils');

    let ranking = [];
    let error = null;
    let monthName = '';

    try {
      ranking = await fetchTopserveursRanking(votesConfig.TOPSERVEURS_RANKING_URL);
      const now = new Date();
      const lastMonth = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
      monthName = monthNameFr(lastMonth);
    } catch (err) {
      error = 'Impossible de récupérer les votes depuis TopServeurs.';
      console.error('Dashboard - Erreur votes:', err);
    }

    res.render('votes', { ranking, monthName, votesConfig, error });
  });

  app.get('/votes/test-unb', requireAdmin, async (req, res) => {
    const { testConnection } = require('../unbelievaboatService');
    const result = await testConnection();
    res.json(result);
  });

  app.get('/rewards', requireAdmin, (req, res) => {
    const settings = getSettings();
    const { getSpecialPacks } = require('../specialPacksManager');
    const specialPacks = getSpecialPacks().packs || [];
    res.render('rewards', { settings, specialPacks, success: null, error: null });
  });

  app.post('/rewards', requireAdmin, async (req, res) => {
    const { diamondsPerVote, dinoShinyItemId } = req.body;

    const votePackIds = {
      1: req.body.votePackId1 || '',
      2: req.body.votePackId2 || '',
      3: req.body.votePackId3 || '',
      4: req.body.votePackId4 || '',
      5: req.body.votePackId5 || '',
    };

    await updateSection('rewards', {
      diamondsPerVote: parseInt(diamondsPerVote) || 100,
      votePackIds,
      dinoShinyItemId: dinoShinyItemId || '',
    });

    const settings = getSettings();
    const { getSpecialPacks } = require('../specialPacksManager');
    const specialPacks = getSpecialPacks().packs || [];
    res.render('rewards', { settings, specialPacks, success: 'Récompenses sauvegardées !', error: null });
  });

  app.get('/message', requireAdmin, (req, res) => {
    const settings = getSettings();
    res.render('message', { settings, success: null, error: null });
  });

  app.post('/message', requireAdmin, async (req, res) => {
    const { introText, creditText, pack1Text, pack2Text, pack3Text, memoText, dinoShinyText, dinoTitle, dinoWinText } = req.body;

    await updateSection('message', {
      introText: introText || '',
      creditText: creditText || '',
      pack1Text: pack1Text || '',
      pack2Text: pack2Text || '',
      pack3Text: pack3Text || '',
      memoText: memoText || '',
      dinoShinyText: dinoShinyText || '',
      dinoTitle: (dinoTitle || 'DINO').slice(0, 20),
      dinoWinText: dinoWinText || '',
    });

    const settings = getSettings();
    res.render('message', { settings, success: 'Message sauvegardé !', error: null });
  });

  app.get('/settings', requireAdmin, (req, res) => {
    const settings = getSettings();
    res.render('settings', { settings, success: null, error: null });
  });

  app.post('/settings', requireAdmin, async (req, res) => {
    const {
      guildId, resultsChannelId, adminLogChannelId, inventoryLogChannelId, topVoterRoleId, modoRoleId,
      logo, fireworks, sparkly, animeArrow, arrow, memoUrl,
      topserveursRankingUrl, timezone, aliases
    } = req.body;

    await updateSection('guild', {
      guildId: guildId || '',
      resultsChannelId: resultsChannelId || '',
      adminLogChannelId: adminLogChannelId || '',
      inventoryLogChannelId: inventoryLogChannelId || '',
      topVoterRoleId: topVoterRoleId || '',
      modoRoleId: modoRoleId || '',
    });

    await updateSection('style', {
      everyonePing: req.body.everyonePing === 'true',
      logo: logo || '',
      fireworks: fireworks || '',
      sparkly: sparkly || '',
      animeArrow: animeArrow || '',
      arrow: arrow || '',
      memoUrl: memoUrl || '',
    });

    await updateSection('api', {
      topserveursRankingUrl: topserveursRankingUrl || '',
      timezone: timezone || 'Europe/Paris',
    });

    const aliasesObj = {};
    if (aliases && aliases.trim()) {
      aliases.split('\n').forEach(line => {
        const parts = line.trim().split('=');
        if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
          aliasesObj[parts[0].trim()] = parts[1].trim();
        }
      });
    }
    await updateSection('aliases', aliasesObj, true);

    const settings = getSettings();
    res.render('settings', { settings, success: 'Paramètres sauvegardés !', error: null });
  });

  app.get('/shop', requireAuth, (req, res) => {
    const shop = getShop();
    const settings = getSettings();
    const configuredGuildId = settings.guild.guildId;
    const guild = discordClient ? (configuredGuildId ? discordClient.guilds.cache.get(configuredGuildId) : discordClient.guilds.cache.first()) : null;
    let channels = [];
    if (guild) {
      const categories = guild.channels.cache
        .filter(ch => ch.type === 4)
        .sort((a, b) => a.position - b.position);
      const textChannels = guild.channels.cache
        .filter(ch => ch.type === 0)
        .sort((a, b) => {
          const catA = a.parentId ? (categories.get(a.parentId)?.position ?? 999) : -1;
          const catB = b.parentId ? (categories.get(b.parentId)?.position ?? 999) : -1;
          if (catA !== catB) return catA - catB;
          return a.position - b.position;
        });
      channels = textChannels.map(ch => ({
        id: ch.id,
        name: ch.name,
        category: ch.parentId ? (categories.get(ch.parentId)?.name || '') : '',
      }));
    }
    const shopCategories = getCategories();
    const discordCategories = guild ? [...guild.channels.cache.values()]
      .filter(ch => ch.type === 4)
      .sort((a, b) => a.position - b.position)
      .map(ch => ({ id: ch.id, name: ch.name })) : [];
    const shopItemTypes = inventoryManager.getItemTypes().filter(t => t.category !== 'currency').sort((a, b) => a.order - b.order);
    res.render('shop', { shop, categories: shopCategories, channels, discordCategories, itemTypes: shopItemTypes, success: req.query.success || null, error: req.query.error || null });
  });

  app.post('/shop/settings', requireAuth, async (req, res) => {
    const { shopChannelId, shopUnitaireChannelId, shopIndexChannelId } = req.body;
    const existing = getShop();
    await updateShopChannels({
      shopChannelId: shopChannelId || '',
      shopUnitaireChannelId: shopUnitaireChannelId || '',
      shopIndexChannelId: shopIndexChannelId || '',
      shopTicketChannelId: existing.shopTicketChannelId || '',
      shopTicketCategoryId: existing.shopTicketCategoryId || '',
      shopTicketAdminRoleIds: existing.shopTicketAdminRoleIds || [],
    });
    res.redirect('/shop?success=Param%C3%A8tres+sauvegard%C3%A9s+!');
  });

  // ── Tickets ────────────────────────────────────────────────────────────────
  app.get('/tickets', requireAdmin, (req, res) => {
    const shop = getShop();
    const settings = getSettings();
    const configuredGuildId = settings.guild.guildId;
    const guild = discordClient ? (configuredGuildId ? discordClient.guilds.cache.get(configuredGuildId) : discordClient.guilds.cache.first()) : null;
    let channels = [];
    let discordCategories = [];
    let discordRoles = [];
    if (guild) {
      const categories = guild.channels.cache
        .filter(ch => ch.type === 4)
        .sort((a, b) => a.position - b.position);
      const textChannels = guild.channels.cache
        .filter(ch => ch.type === 0)
        .sort((a, b) => {
          const catA = a.parentId ? (categories.get(a.parentId)?.position ?? 999) : -1;
          const catB = b.parentId ? (categories.get(b.parentId)?.position ?? 999) : -1;
          if (catA !== catB) return catA - catB;
          return a.position - b.position;
        });
      channels = textChannels.map(ch => ({
        id: ch.id,
        name: ch.name,
        category: ch.parentId ? (categories.get(ch.parentId)?.name || '') : '',
      }));
      discordCategories = [...guild.channels.cache.values()]
        .filter(ch => ch.type === 4)
        .sort((a, b) => a.position - b.position)
        .map(ch => ({ id: ch.id, name: ch.name }));
      discordRoles = [...guild.roles.cache.values()]
        .filter(r => r.name !== '@everyone')
        .sort((a, b) => b.position - a.position)
        .map(r => ({ id: r.id, name: r.name, color: r.color ? '#' + r.color.toString(16).padStart(6, '0') : null }));
    }
    const spawnTicket = settings.spawnTicket || {};
    res.render('tickets', { shop, channels, discordCategories, discordRoles, spawnTicket, success: req.query.success || null, error: req.query.error || null });
  });

  const spawnImageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (file.mimetype.startsWith('image/')) cb(null, true);
      else cb(new Error('Fichier non supporté'));
    },
  });

  // Sert l'image du message automatique stockée dans pgStore (persistante entre redéploiements)
  app.get('/tickets/spawn/image', requireAdmin, async (req, res) => {
    try {
      const stored = await pgStore.getData('spawn_ticket_image', null);
      if (!stored || !stored.data) return res.status(404).send('Aucune image');
      const buf = Buffer.from(stored.data, 'base64');
      res.set('Content-Type', stored.mime || 'image/png');
      res.set('Cache-Control', 'no-store');
      res.send(buf);
    } catch (err) {
      res.status(500).send('Erreur');
    }
  });

  app.post('/tickets/spawn', requireAdmin, spawnImageUpload.single('spawnAutoMessageImage'), async (req, res) => {
    try {
      const {
        spawnTicketCategoryId, spawnWelcomeChannelId, spawnLogChannelId,
        spawnMemberRoleId, spawnMapPassword, spawnAdminRoleIds,
        spawnNotifChannelId, spawnNotifText, spawnAutoMessageText,
      } = req.body;
      const rawRoles = spawnAdminRoleIds || [];
      const adminRoleIds = (Array.isArray(rawRoles) ? rawRoles : [rawRoles]).filter(s => /^\d+$/.test(s));

      // Image : si un fichier est uploadé, on le stocke en base64 dans pgStore (résiste aux redéploiements)
      let autoMessageImageUrl = getSettings().spawnTicket?.autoMessageImageUrl || '';
      if (req.file) {
        await pgStore.setData('spawn_ticket_image', {
          data: req.file.buffer.toString('base64'),
          mime: req.file.mimetype,
          name: req.file.originalname,
        });
        autoMessageImageUrl = 'pgstore';
      }

      await updateSection('spawnTicket', {
        ticketCategoryId: spawnTicketCategoryId || '',
        adminRoleIds,
        memberRoleId: spawnMemberRoleId || '',
        welcomeChannelId: spawnWelcomeChannelId || '',
        logChannelId: spawnLogChannelId || '',
        notifChannelId: spawnNotifChannelId || '',
        notifText: spawnNotifText || '',
        autoMessageText: spawnAutoMessageText || '',
        autoMessageImageUrl,
        mapPassword: spawnMapPassword || '',
      });
      res.redirect('/tickets?success=Param%C3%A8tres+Spawn+Joueur+sauvegard%C3%A9s+!');
    } catch (err) {
      console.error('[SpawnTicket] Erreur sauvegarde settings:', err);
      res.redirect('/tickets?error=Erreur+lors+de+la+sauvegarde+des+r%C3%A9glages');
    }
  });

  app.post('/tickets/shop', requireAdmin, async (req, res) => {
    const { shopTicketChannelId, shopTicketCategoryId, shopTicketAdminRoleIds, shopTicketNotifChannelId } = req.body;
    const raw = shopTicketAdminRoleIds || [];
    const adminRoleIdsRaw = (Array.isArray(raw) ? raw : [raw]).filter(s => /^\d+$/.test(s));
    const shop = getShop();
    await updateShopChannels({
      shopChannelId: shop.shopChannelId || '',
      shopUnitaireChannelId: shop.shopUnitaireChannelId || '',
      shopIndexChannelId: shop.shopIndexChannelId || '',
      shopTicketChannelId: shopTicketChannelId || '',
      shopTicketCategoryId: shopTicketCategoryId || '',
      shopTicketAdminRoleIds: adminRoleIdsRaw.filter(Boolean),
      shopTicketNotifChannelId: shopTicketNotifChannelId || '',
    });
    res.redirect('/tickets?success=Param%C3%A8tres+tickets+shop+sauvegard%C3%A9s+!');
  });

  app.post('/shop/categories', requireAuth, async (req, res) => {
    const { catId, name, emoji, color } = req.body;
    if (!name || !name.trim()) return res.redirect('/shop?error=Nom+de+cat%C3%A9gorie+requis');
    if (catId) {
      await updateCategory(catId, { name: name.trim(), emoji: emoji || '📦', color: color || '#7c5cfc' });
      return res.redirect('/shop?success=Cat%C3%A9gorie+modifi%C3%A9e+!');
    } else {
      await addCategory({ name: name.trim(), emoji: emoji || '📦', color: color || '#7c5cfc' });
      return res.redirect('/shop?success=Cat%C3%A9gorie+ajout%C3%A9e+!');
    }
  });

  app.post('/shop/categories/delete/:id', requireAuth, async (req, res) => {
    await deleteCategory(req.params.id);
    res.redirect('/shop?success=Cat%C3%A9gorie+supprim%C3%A9e+!');
  });

  app.post('/shop/pack', requireAuth, async (req, res) => {
    const { packId, name, category, priceDiamonds, priceStrawberries, content, note, color, donationAvailable, notCompatible, unavailable, noReduction, optionsJson, type, imageUrl } = req.body;

    // inventoryItemIds : multi-select → peut être string, array ou undefined
    const rawInvIds = req.body.inventoryItemIds;
    const inventoryItemIds = Array.isArray(rawInvIds)
      ? rawInvIds.filter(Boolean)
      : (rawInvIds ? [rawInvIds] : []);

    let options = [];
    if (optionsJson) {
      try {
        const parsed = JSON.parse(optionsJson);
        if (Array.isArray(parsed)) {
          options = parsed.filter(o => o.name && o.name.trim()).map(o => ({
            name: o.name.trim(),
            priceDiamonds: parseInt(o.priceDiamonds) || 0,
            priceStrawberries: parseInt(o.priceStrawberries) || 0,
            inventoryItemIds: Array.isArray(o.inventoryItemIds) ? o.inventoryItemIds.filter(Boolean) : [],
          }));
        }
      } catch (e) {}
    }

    const packData = {
      name: name || 'Pack sans nom',
      type: type === 'unitaire' ? 'unitaire' : 'pack',
      category: category || 'packs',
      priceDiamonds: options.length > 0 ? 0 : (parseInt(priceDiamonds) || 0),
      priceStrawberries: options.length > 0 ? 0 : (parseInt(priceStrawberries) || 0),
      options,
      imageUrl: imageUrl || '',
      content: content || '',
      note: note || '',
      color: color || '#e74c3c',
      donationAvailable: donationAvailable === 'true',
      notCompatible: notCompatible === 'true',
      available: unavailable !== 'true',
      noReduction: noReduction === 'true',
      inventoryItemIds: inventoryItemIds.length > 0 ? inventoryItemIds : null,
    };

    if (packId) {
      await updatePack(packId, packData);
      res.redirect('/shop?success=Pack+modifi%C3%A9+!');
    } else {
      await addPack(packData);
      res.redirect('/shop?success=Pack+cr%C3%A9%C3%A9+!');
    }
  });

  app.post('/shop/reorder', requireAuth, async (req, res) => {
    try {
      const { order } = req.body;
      if (!Array.isArray(order)) return res.status(400).json({ error: 'Format invalide' });
      await reorderPacks(order);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/shop/delete/:id', requireAuth, async (req, res) => {
    const pack = getPack(req.params.id);
    if (pack && pack.messageId && pack.channelId) {
      try {
        const channel = discordClient.channels.cache.get(pack.channelId);
        if (channel) {
          channel.messages.fetch(pack.messageId).then(msg => msg.delete()).catch(() => {});
        }
      } catch (e) {}
    }
    await deletePack(req.params.id);
    res.redirect('/shop?success=Pack+supprim%C3%A9+!');
  });

  function getPublishChannelId(shop, pack) {
    if ((pack.type || 'pack') === 'unitaire' && shop.shopUnitaireChannelId) {
      return shop.shopUnitaireChannelId;
    }
    return shop.shopChannelId;
  }

  function resolveAbsoluteUrl(url, req) {
    if (!url || url.startsWith('http://') || url.startsWith('https://')) return url || null;
    const proto = (req && (req.headers['x-forwarded-proto'] || req.protocol)) || 'https';
    const host = req && (req.headers['x-forwarded-host'] || req.headers.host);
    if (!host) return null;
    return `${proto}://${host}${url.startsWith('/') ? '' : '/'}${url}`;
  }

  // ── Helper : édite les messages existants, ajoute/supprime si le nombre change ──
  async function editOrRepost(channel, oldIds, newEmbeds) {
    const safeOld = Array.isArray(oldIds) ? oldIds.filter(Boolean) : [];
    const min = Math.min(safeOld.length, newEmbeds.length);
    const newIds = [];

    // Tente d'éditer jusqu'au min(old, new)
    for (let i = 0; i < min; i++) {
      try {
        const msg = await channel.messages.fetch(safeOld[i]);
        await msg.edit({ embeds: [newEmbeds[i]] });
        newIds.push(safeOld[i]);
      } catch {
        // Un message introuvable/éditable → bascule en delete+send complet
        newIds.length = 0;
        for (const oid of safeOld) { try { const m = await channel.messages.fetch(oid); await m.delete(); } catch {} }
        for (const embed of newEmbeds) { const m = await channel.send({ embeds: [embed] }); newIds.push(m.id); }
        return { ids: newIds, reposted: true };
      }
    }
    // Envoie les embeds supplémentaires si new > old
    for (let i = min; i < newEmbeds.length; i++) {
      const m = await channel.send({ embeds: [newEmbeds[i]] });
      newIds.push(m.id);
    }
    // Supprime les messages en surplus si old > new
    for (let i = min; i < safeOld.length; i++) {
      try { const m = await channel.messages.fetch(safeOld[i]); await m.delete(); } catch {}
    }
    return { ids: newIds, reposted: false };
  }

  async function publishOrUpdatePack(pack, discordClient, shop, req) {
    const channelId = getPublishChannelId(shop, pack);
    if (!channelId) throw new Error('Aucun salon configuré pour ce type de produit');
    const channel = await discordClient.channels.fetch(channelId);
    if (!channel) throw new Error('Salon introuvable');
    const raw = buildPackEmbed(pack);
    const { EmbedBuilder } = require('discord.js');
    const embed = new EmbedBuilder()
      .setTitle(raw.title)
      .setDescription(raw.description)
      .setColor(raw.color);
    if (raw.thumbnail) {
      const thumbUrl = resolveAbsoluteUrl(raw.thumbnail.url, req);
      if (thumbUrl) embed.setThumbnail(thumbUrl);
    }
    if (pack.messageId) {
      try {
        const existingMsg = await channel.messages.fetch(pack.messageId);
        await existingMsg.edit({ embeds: [embed] });
        return { updated: true, channelId };
      } catch (e) {
        const newMsg = await channel.send({ embeds: [embed] });
        await updatePack(pack.id, { messageId: newMsg.id, channelId });
        return { updated: false, channelId };
      }
    } else {
      const newMsg = await channel.send({ embeds: [embed] });
      await updatePack(pack.id, { messageId: newMsg.id, channelId });
      return { updated: false, channelId };
    }
  }

  app.post('/shop/publish/:id', requireAuth, async (req, res) => {
    if (!discordClient) return res.redirect('/shop?error=Bot+non+connect%C3%A9');
    const shop = getShop();
    const pack = getPack(req.params.id);
    if (!pack) return res.redirect('/shop?error=Pack+introuvable');
    try {
      const { updated } = await publishOrUpdatePack(pack, discordClient, shop, req);
      res.redirect(`/shop?success=${updated ? 'Embed+mis+%C3%A0+jour' : 'Embed+publi%C3%A9'}+!`);
    } catch (err) {
      console.error('Erreur publication shop:', err);
      res.redirect('/shop?error=' + encodeURIComponent(err.message || 'Erreur de publication'));
    }
  });

  app.post('/shop/publish-all', requireAuth, async (req, res) => {
    if (!discordClient) return res.redirect('/shop?error=Bot+non+connect%C3%A9');
    const shop = getShop();
    let published = 0, failed = 0;
    const failedNames = [];
    for (const pack of [...shop.packs]) {
      try {
        await publishOrUpdatePack(pack, discordClient, shop, req);
        published++;
      } catch (err) {
        failed++;
        failedNames.push(pack.name);
        console.error(`Erreur publication pack ${pack.name}:`, err.message || err);
      }
    }
    if (failed > 0) {
      res.redirect(`/shop?success=${published}+publi%C3%A9s&error=${failed}+%C3%A9chec(s):+${encodeURIComponent(failedNames.join(', '))}`);
    } else {
      res.redirect(`/shop?success=${published}+produits+publi%C3%A9s+!`);
    }
  });

  app.post('/shop/publish-index', requireAuth, async (req, res) => {
    if (!discordClient) return res.redirect('/shop?error=Bot+non+connect%C3%A9');
    const shop = getShop();
    if (!shop.shopIndexChannelId) return res.redirect('/shop?error=Salon+accueil+shop+non+configur%C3%A9');
    try {
      const channel = await discordClient.channels.fetch(shop.shopIndexChannelId);
      if (!channel) return res.redirect('/shop?error=Salon+accueil+introuvable');

      const { EmbedBuilder } = require('discord.js');
      const packs = shop.packs.filter(p => p.available !== false);
      const unitItems = packs.filter(p => p.type === 'unitaire');
      const packItems = packs.filter(p => (p.type || 'pack') === 'pack' && !p.donationAvailable);
      const inventoryItems = packs.filter(p => (p.type || 'pack') === 'pack' && p.donationAvailable);
      const cats = getCategories();
      const settings = getSettings();
      const guildId = settings.guild?.guildId || discordClient.guilds.cache.first()?.id || '';

      function packLine(p) {
        const cat = cats.find(c => c.id === p.category);
        const emoji = cat?.emoji || '🛒';
        if (p.messageId && p.channelId) {
          return `${emoji} [${p.name}](https://discord.com/channels/${guildId}/${p.channelId}/${p.messageId})`;
        }
        return `${emoji} ${p.name}`;
      }

      // Découpe une liste de lignes en champs Discord (max 1024 chars chacun)
      function toFields(items, sectionEmoji, sectionName) {
        if (items.length === 0) {
          return [{ name: `${sectionEmoji} ${sectionName}`, value: '*Aucun produit pour le moment*' }];
        }
        const lines = items.map(packLine);
        const fields = [];
        let current = '';
        for (const line of lines) {
          const sep = current ? '\n' : '';
          if (current.length + sep.length + line.length > 1020) {
            fields.push({
              name: fields.length === 0 ? `${sectionEmoji} ${sectionName}` : '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯',
              value: current,
            });
            current = line;
          } else {
            current += sep + line;
          }
        }
        if (current) {
          fields.push({
            name: fields.length === 0 ? `${sectionEmoji} ${sectionName}` : '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯',
            value: current,
          });
        }
        return fields;
      }

      const alpha = arr => [...arr].sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
      const unitFields = unitItems.length > 0 ? toFields(alpha(unitItems), '💎', 'Produits à l\'unité') : [];
      const packFields = packItems.length > 0 ? toFields(alpha(packItems), '📦', 'Packs') : [];
      const inventoryFields = inventoryItems.length > 0 ? toFields(alpha(inventoryItems), '✅', 'Packs compatibles inventaire') : [];
      const allFields = [...unitFields, ...packFields, ...inventoryFields];
      if (allFields.length === 0) allFields.push({ name: '🛒 Shop', value: '*Aucun produit disponible pour le moment*' });

      // Discord limite à 25 champs et ~6000 chars par embed — on découpe en plusieurs embeds si besoin
      function chunkFields(fields, maxFields = 25, maxChars = 5800) {
        const chunks = [];
        let chunk = [];
        let chars = 0;
        for (const f of fields) {
          const fChars = f.name.length + f.value.length;
          if (chunk.length >= maxFields || (chunk.length > 0 && chars + fChars > maxChars)) {
            chunks.push(chunk);
            chunk = [];
            chars = 0;
          }
          chunk.push(f);
          chars += fChars;
        }
        if (chunk.length > 0) chunks.push(chunk);
        return chunks.length > 0 ? chunks : [[]];
      }

      const fieldChunks = chunkFields(allFields);
      const embeds = fieldChunks.map((fields, i) => {
        const e = new EmbedBuilder().setColor(0x7c5cfc);
        if (i === 0) {
          e.setTitle('🛒 Arki\'s Family Shop — Index')
           .setDescription('Retrouvez ci-dessous tous nos produits disponibles avec des liens directs.\nUtilise `/shop` pour naviguer et commander directement !');
        }
        if (fields.length > 0) e.addFields(fields);
        if (i === fieldChunks.length - 1) {
          e.setFooter({ text: `${shop.packs.length} produit(s) au total • Arki's Family Shop` }).setTimestamp();
        }
        return e;
      });

      // Édite les messages existants ou recrée si nécessaire
      const oldIndexIds = shop.shopIndexMessageIds || (shop.shopIndexMessageId ? [shop.shopIndexMessageId] : []);
      const { ids: newIndexIds, reposted } = await editOrRepost(channel, oldIndexIds, embeds);
      await saveShopIndexMessage(newIndexIds[0] || null, newIndexIds);
      res.redirect('/shop?success=' + encodeURIComponent(reposted ? 'Index republié !' : 'Index mis à jour !'));
    } catch (err) {
      console.error('Erreur publication index:', err);
      res.redirect('/shop?error=' + encodeURIComponent(err.message || 'Erreur de publication'));
    }
  });

  app.post('/shop/upload-image', requireAuth, upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const baseUrl = `${proto}://${host}`;
    const url = `${baseUrl}/uploads/${req.file.filename}`;
    res.json({ url });
  });

  app.get('/dinos', requireAuth, (req, res) => {
    const dinoData = getDinoData();
    const grouped = getDinosByLetter();
    const letterMessages = getLetterMessages();
    const settings = getSettings();
    const configuredGuildId = settings.guild.guildId;
    const guild = discordClient ? (configuredGuildId ? discordClient.guilds.cache.get(configuredGuildId) : discordClient.guilds.cache.first()) : null;
    let channels = [];
    if (guild) {
      const categories = guild.channels.cache
        .filter(ch => ch.type === 4)
        .sort((a, b) => a.position - b.position);
      const textChannels = guild.channels.cache
        .filter(ch => ch.type === 0)
        .sort((a, b) => {
          const catA = a.parentId ? (categories.get(a.parentId)?.position ?? 999) : -1;
          const catB = b.parentId ? (categories.get(b.parentId)?.position ?? 999) : -1;
          if (catA !== catB) return catA - catB;
          return a.position - b.position;
        });
      channels = textChannels.map(ch => ({
        id: ch.id,
        name: ch.name,
        category: ch.parentId ? (categories.get(ch.parentId)?.name || '') : '',
      }));
    }
    const letterColors = getLetterColors();
    const moddedDinos = getModdedDinos();
    const variantLabels = {};
    dinoData.dinos.forEach(d => {
      if (d.variants && d.variants.length > 0) {
        d.variants.forEach(v => {
          const label = (v.label || '').toUpperCase();
          if (!variantLabels[label]) variantLabels[label] = { count: 0, hidden: true };
          variantLabels[label].count++;
          if (!v.hidden) variantLabels[label].hidden = false;
        });
      }
    });
    const hasAnyVariant = Object.keys(variantLabels).length > 0;
    const dinoIndexInfo = getDinoIndexInfo();
    const shoulderDinos = getShoulderDinos();
    const paidDLCDinos = getPaidDLCDinos();
    const variantADinos = getDinosByVariant('A');
    const variantTekDinos = getDinosByVariant('Tek');
    const activeFlashSale = getActiveFlashSale();
    res.render('dinos', { dinoData, grouped, moddedDinos, shoulderDinos, paidDLCDinos, variantADinos, variantTekDinos, letterMessages, letterColors, defaultColors: DEFAULT_LETTER_COLORS, channels, variantLabels, hasAnyVariant, dinoIndexInfo, activeFlashSale, success: req.query.success || null, error: req.query.error || null });
  });

  app.post('/dinos/settings', requireAuth, async (req, res) => {
    await updateDinoChannel(req.body.dinoChannelId || '');
    res.redirect('/dinos?success=Salon+sauvegard%C3%A9+!');
  });

  app.post('/dinos/index-channel', requireAuth, async (req, res) => {
    await updateDinoIndexChannel(req.body.dinoIndexChannelId || '');
    res.redirect('/dinos?success=Salon+index+sauvegard%C3%A9+!');
  });

  app.post('/dinos/publish-index', requireAuth, async (req, res) => {
    if (!discordClient) return res.redirect('/dinos?error=Bot+non+connect%C3%A9');
    const { channelId: indexChannelId } = getDinoIndexInfo();
    if (!indexChannelId) return res.redirect('/dinos?error=Salon+index+dinos+non+configur%C3%A9');
    try {
      const { EmbedBuilder } = require('discord.js');
      const channel = await discordClient.channels.fetch(indexChannelId);
      if (!channel) return res.redirect('/dinos?error=Salon+index+introuvable');

      const settings = getSettings();
      const guildId = settings.guild?.guildId || discordClient.guilds.cache.first()?.id || '';
      const letterMessages = getLetterMessages();
      const allDinosData = getDinoData();
      // On force le channelId des liens à utiliser le salon dinos configuré actuellement,
      // pour éviter les liens vers un ancien salon si le channelId stocké est obsolète.
      const dinoChannelForLinks = allDinosData.dinoChannelId || '';

      // Construit une ligne par dino avec lien vers l'embed de sa lettre/catégorie
      function dinoLine(dino, letterKey) {
        const lm = letterMessages[letterKey];
        if (lm && lm.messageId && dinoChannelForLinks) {
          return `[${dino.name}](https://discord.com/channels/${guildId}/${dinoChannelForLinks}/${lm.messageId})`;
        }
        return dino.name;
      }

      // Découpe une liste de lignes en champs Discord (max 1024 chars)
      function toFields(lines, sectionTitle) {
        if (lines.length === 0) return [];
        const fields = [];
        let current = '';
        for (const line of lines) {
          const sep = current ? '\n' : '';
          if (current.length + sep.length + line.length > 1020) {
            fields.push({ name: fields.length === 0 ? sectionTitle : '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯', value: current });
            current = line;
          } else {
            current += sep + line;
          }
        }
        if (current) fields.push({ name: fields.length === 0 ? sectionTitle : '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯', value: current });
        return fields;
      }

      // Dinos normaux (hors épaule et DLC) triés alphabétiquement
      const regularDinos = [...allDinosData.dinos]
        .filter(d => !d.isShoulder && !d.isPaidDLC)
        .sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));

      const shoulderDinosIdx = [...allDinosData.dinos]
        .filter(d => d.isShoulder)
        .sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));

      const paidDLCDinosIdx = [...allDinosData.dinos]
        .filter(d => d.isPaidDLC)
        .sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));

      const regularLines = regularDinos.map(d => dinoLine(d, (d.name || '?')[0].toUpperCase()));
      const shoulderLines = shoulderDinosIdx.map(d => {
        const lm = letterMessages['SHOULDER'];
        if (lm && lm.messageId && dinoChannelForLinks) {
          return `[${d.name}](https://discord.com/channels/${guildId}/${dinoChannelForLinks}/${lm.messageId})`;
        }
        return dinoLine(d, (d.name || '?')[0].toUpperCase());
      });
      const paidDLCLines = paidDLCDinosIdx.map(d => {
        const lm = letterMessages['PAIDDLC'];
        if (lm && lm.messageId && dinoChannelForLinks) {
          return `[${d.name}](https://discord.com/channels/${guildId}/${dinoChannelForLinks}/${lm.messageId})`;
        }
        return dinoLine(d, (d.name || '?')[0].toUpperCase());
      });

      // Dinos avec variant Alpha
      const alphaVariants = getDinosByVariant('A');
      const alphaLines = alphaVariants.map(({ dino }) => {
        const lm = letterMessages['VARIANT_A'];
        if (lm && lm.messageId && dinoChannelForLinks) {
          return `[${dino.name}](https://discord.com/channels/${guildId}/${dinoChannelForLinks}/${lm.messageId})`;
        }
        return dinoLine(dino, (dino.name || '?')[0].toUpperCase());
      });
      // Dinos avec variant Tek
      const tekVariants = getDinosByVariant('Tek');
      const tekLines = tekVariants.map(({ dino }) => {
        const lm = letterMessages['VARIANT_TEK'];
        if (lm && lm.messageId && dinoChannelForLinks) {
          return `[${dino.name}](https://discord.com/channels/${guildId}/${dinoChannelForLinks}/${lm.messageId})`;
        }
        return dinoLine(dino, (dino.name || '?')[0].toUpperCase());
      });

      const regularFields = regularLines.length > 0 ? toFields(regularLines, '🦕 Dinos disponibles') : [];
      const shoulderFields = shoulderLines.length > 0 ? toFields(shoulderLines, '🦜 Dinos d\'épaule') : [];
      const paidDLCFields = paidDLCLines.length > 0 ? toFields(paidDLCLines, '💰 Dinos DLC Payant') : [];
      const alphaFields = alphaLines.length > 0 ? toFields(alphaLines, '🅰️ Variants Alpha') : [];
      const tekFields = tekLines.length > 0 ? toFields(tekLines, '⚙️ Variants Tek') : [];

      const allFields = [...regularFields, ...shoulderFields, ...paidDLCFields, ...alphaFields, ...tekFields];
      if (allFields.length === 0) allFields.push({ name: '🦕 Dinos', value: '*Aucun dino pour le moment*' });

      // Découpe en plusieurs embeds si > 25 champs ou > 5800 chars
      function chunkFields(fields, maxFields = 25, maxChars = 5800) {
        const chunks = [];
        let chunk = [], chars = 0;
        for (const f of fields) {
          const fChars = f.name.length + f.value.length;
          if (chunk.length >= maxFields || (chunk.length > 0 && chars + fChars > maxChars)) {
            chunks.push(chunk); chunk = []; chars = 0;
          }
          chunk.push(f); chars += fChars;
        }
        if (chunk.length > 0) chunks.push(chunk);
        return chunks.length > 0 ? chunks : [[]];
      }

      const totalDinos = allDinosData.dinos.length;
      const fieldChunks = chunkFields(allFields);
      const embeds = fieldChunks.map((fields, i) => {
        const e = new EmbedBuilder().setColor(0x7c5cfc);
        if (i === 0) {
          e.setTitle('🦕 Dino Shop - Index')
           .setDescription('Retrouvez ci-dessous tous nos dinos disponibles.\nCliquez sur un nom pour accéder directement à sa fiche de prix !');
        }
        if (fields.length > 0) e.addFields(fields);
        if (i === fieldChunks.length - 1) {
          e.setFooter({ text: `${totalDinos} dino(s) au total • Arki's Family` }).setTimestamp();
        }
        return e;
      });

      // Édite les messages existants ou recrée si nécessaire
      const { messageIds: oldIndexIds } = getDinoIndexInfo();
      const { ids: newIndexIds, reposted } = await editOrRepost(channel, oldIndexIds, embeds);
      await updateDinoIndexMessage(newIndexIds[0] || null, newIndexIds);
      res.redirect('/dinos?success=' + encodeURIComponent(reposted ? 'Index republié !' : 'Index mis à jour !'));
    } catch (err) {
      console.error('Erreur publication index dinos:', err);
      res.redirect('/dinos?error=' + encodeURIComponent(err.message || 'Erreur de publication'));
    }
  });

  app.post('/dinos/letter-color', requireAuth, async (req, res) => {
    const { letter, color } = req.body;
    if (letter && color) {
      await updateLetterColor(letter.toUpperCase(), color);
    }
    res.redirect('/dinos?success=Couleur+mise+%C3%A0+jour+!');
  });

  app.post('/dinos/toggle-variants', requireAuth, async (req, res) => {
    const data = getDinoData();
    const visibleLabels = [];
    Object.keys(req.body).forEach(key => {
      if (key.startsWith('variant_visible_')) {
        visibleLabels.push(key.replace('variant_visible_', '').toUpperCase());
      }
    });
    data.dinos.forEach(d => {
      if (d.variants && d.variants.length > 0) {
        d.variants.forEach(v => {
          v.hidden = !visibleLabels.includes((v.label || '').toUpperCase());
        });
      }
    });
    await saveDinos(data);
    res.redirect('/dinos?success=Variants+mis+%C3%A0+jour+!');
  });

  app.post('/dinos/save', requireAuth, async (req, res) => {
    const { dinoId, name, priceDiamonds, priceStrawberries, uniquePerTribe, noReduction, coupleInventaire, notAvailableDona, notAvailableShop, isModded, isShoulder, isPaidDLC, note } = req.body;

    const variants = [];
    for (let i = 1; i <= 20; i++) {
      const label = req.body[`variant_label_${i}`];
      const vd = req.body[`variant_diamonds_${i}`];
      const vs = req.body[`variant_strawberries_${i}`];
      if (label !== undefined && label.trim()) {
        const vNotShop = req.body[`variant_notshop_${i}`];
        const vHidden = req.body[`variant_hidden_${i}`];
        variants.push({
          label: label.trim(),
          priceDiamonds: parseInt(vd) || 0,
          priceStrawberries: parseInt(vs) || 0,
          notAvailableShop: vNotShop === 'true',
          hidden: vHidden === 'true',
        });
      }
    }

    const dinoData = {
      name: name || 'Dino sans nom',
      priceDiamonds: parseInt(priceDiamonds) || 0,
      priceStrawberries: parseInt(priceStrawberries) || 0,
      variants,
      uniquePerTribe: uniquePerTribe === 'true',
      noReduction: noReduction === 'true',
      coupleInventaire: coupleInventaire === 'true',
      notAvailableDona: notAvailableDona === 'true',
      notAvailableShop: notAvailableShop === 'true',
      isModded: isModded === 'true',
      isShoulder: isShoulder === 'true',
      isPaidDLC: isPaidDLC === 'true',
      note: (note || '').trim(),
    };

    if (dinoId) {
      await updateDino(dinoId, dinoData);
      res.redirect('/dinos?success=Dino+modifi%C3%A9+!');
    } else {
      await addDino(dinoData);
      res.redirect('/dinos?success=Dino+ajout%C3%A9+!');
    }
  });

  app.post('/dinos/delete/:id', requireAuth, async (req, res) => {
    await deleteDino(req.params.id);
    res.redirect('/dinos?success=Dino+supprim%C3%A9+!');
  });

  app.post('/dinos/publish-letter/:letter', requireAuth, async (req, res) => {
    const letter = req.params.letter.toUpperCase();
    const dinoData = getDinoData();
    const channelId = dinoData.dinoChannelId;
    if (!channelId) return res.redirect('/dinos?error=Aucun+salon+configur%C3%A9');

    let embeds;
    if (letter === 'MODDED') {
      const moddedDinos = getModdedDinos();
      if (moddedDinos.length === 0) return res.redirect('/dinos?error=Aucun+dino+modd%C3%A9');
      embeds = buildModdedEmbeds(moddedDinos);
    } else if (letter === 'SHOULDER') {
      const shoulderDinos = getShoulderDinos();
      if (shoulderDinos.length === 0) return res.redirect('/dinos?error=Aucun+dino+d\'%C3%A9paule');
      embeds = [buildShoulderEmbed(shoulderDinos)];
    } else if (letter === 'PAIDDLC') {
      const dlcDinos = getPaidDLCDinos();
      if (dlcDinos.length === 0) return res.redirect('/dinos?error=Aucun+dino+DLC+payant');
      embeds = buildPaidDLCEmbeds(dlcDinos);
    } else if (VARIANT_KEYS[letter]) {
      const variantLabel = VARIANT_KEYS[letter];
      const variantDinos = getDinosByVariant(variantLabel);
      if (variantDinos.length === 0) return res.redirect('/dinos?error=Aucun+dino+avec+ce+variant');
      embeds = buildVariantEmbeds(variantLabel, variantDinos);
    } else {
      const grouped = getDinosByLetter();
      const dinos = grouped[letter];
      if (!dinos || dinos.length === 0) return res.redirect('/dinos?error=Aucun+dino+pour+cette+lettre');
      embeds = buildLetterEmbeds(letter, dinos);
    }

    try {
      const channel = await discordClient.channels.fetch(channelId);
      if (!channel) return res.redirect('/dinos?error=Salon+introuvable');

      const letterMsgs = getLetterMessages();
      const storedIds = letterMsgs[letter]?.messageIds || (letterMsgs[letter]?.messageId ? [letterMsgs[letter].messageId] : []);
      const { ids: newIds, reposted } = await editOrRepost(channel, storedIds, embeds);
      await updateLetterMessage(letter, newIds[0], channelId, newIds);
      const action = reposted ? 'republié' : 'mis à jour';
      res.redirect('/dinos?success=' + encodeURIComponent(`Lettre ${letter} ${action} (${newIds.length} message${newIds.length > 1 ? 's' : ''}) !`));
    } catch (err) {
      console.error('Erreur publication dino:', err);
      res.redirect('/dinos?error=Erreur+de+publication:+' + encodeURIComponent(err.message));
    }
  });

  app.post('/dinos/publish-all', requireAuth, async (req, res) => {
    const dinoData = getDinoData();
    const channelId = dinoData.dinoChannelId;
    if (!channelId) return res.redirect('/dinos?error=Aucun+salon+configur%C3%A9');

    res.redirect('/dinos?success=Publication+en+cours...+Les+messages+arrivent+sur+Discord');

    try {
      const channel = await discordClient.channels.fetch(channelId);
      if (!channel) {
        console.error('Erreur publish-all: salon introuvable', channelId);
        return;
      }

      const grouped = getDinosByLetter();
      const letters = Object.keys(grouped).sort();
      const moddedDinos = getModdedDinos();
      const letterMsgs = getLetterMessages();
      let totalMessages = 0;

      for (const letter of letters) {
        const embeds = buildLetterEmbeds(letter, grouped[letter]);
        const storedIds = letterMsgs[letter]?.messageIds || (letterMsgs[letter]?.messageId ? [letterMsgs[letter].messageId] : []);
        const { ids: newIds } = await editOrRepost(channel, storedIds, embeds);
        await updateLetterMessage(letter, newIds[0], channelId, newIds);
        totalMessages += newIds.length;
        await new Promise(r => setTimeout(r, 400));
      }

      if (moddedDinos.length > 0) {
        const storedIds = letterMsgs['MODDED']?.messageIds || (letterMsgs['MODDED']?.messageId ? [letterMsgs['MODDED'].messageId] : []);
        const { ids: newIds } = await editOrRepost(channel, storedIds, buildModdedEmbeds(moddedDinos));
        await updateLetterMessage('MODDED', newIds[0], channelId, newIds);
        totalMessages += newIds.length;
        await new Promise(r => setTimeout(r, 400));
      }

      const shoulderDinosAll = getShoulderDinos();
      if (shoulderDinosAll.length > 0) {
        const storedIds = letterMsgs['SHOULDER']?.messageIds || (letterMsgs['SHOULDER']?.messageId ? [letterMsgs['SHOULDER'].messageId] : []);
        const { ids: newIds } = await editOrRepost(channel, storedIds, [buildShoulderEmbed(shoulderDinosAll)]);
        await updateLetterMessage('SHOULDER', newIds[0], channelId, newIds);
        totalMessages += newIds.length;
        await new Promise(r => setTimeout(r, 400));
      }

      const dlcDinos = getPaidDLCDinos();
      if (dlcDinos.length > 0) {
        const storedIds = letterMsgs['PAIDDLC']?.messageIds || (letterMsgs['PAIDDLC']?.messageId ? [letterMsgs['PAIDDLC'].messageId] : []);
        const { ids: newIds } = await editOrRepost(channel, storedIds, buildPaidDLCEmbeds(dlcDinos));
        await updateLetterMessage('PAIDDLC', newIds[0], channelId, newIds);
        totalMessages += newIds.length;
        await new Promise(r => setTimeout(r, 400));
      }

      console.log(`✅ Publication complète terminée: ${totalMessages} messages mis à jour/publiés`);
    } catch (err) {
      console.error('Erreur publication tout dinos:', err);
    }
  });

  // Route combinée : publie tous les embeds puis l'index en séquence
  app.post('/dinos/publish-all-and-index', requireAuth, async (req, res) => {
    if (!discordClient) return res.redirect('/dinos?error=Bot+non+connect%C3%A9');
    const dinoData = getDinoData();
    const channelId = dinoData.dinoChannelId;
    if (!channelId) return res.redirect('/dinos?error=Aucun+salon+dinos+configur%C3%A9');
    const { channelId: indexChannelId } = getDinoIndexInfo();
    if (!indexChannelId) return res.redirect('/dinos?error=Salon+index+dinos+non+configur%C3%A9');

    res.redirect('/dinos?success=Publication+en+cours...+Embeds+puis+index+seront+mis+%C3%A0+jour');

    try {
      const { EmbedBuilder } = require('discord.js');
      const channel = await discordClient.channels.fetch(channelId);
      if (!channel) { console.error('publish-all-and-index: salon dinos introuvable'); return; }

      // ── 1. Publier toutes les lettres ──
      const grouped = getDinosByLetter();
      const letters = Object.keys(grouped).sort();
      const moddedDinos = getModdedDinos();
      const letterMsgs = getLetterMessages();

      for (const letter of letters) {
        const embeds = buildLetterEmbeds(letter, grouped[letter]);
        const storedIds = letterMsgs[letter]?.messageIds || (letterMsgs[letter]?.messageId ? [letterMsgs[letter].messageId] : []);
        const { ids: newIds } = await editOrRepost(channel, storedIds, embeds);
        await updateLetterMessage(letter, newIds[0], channelId, newIds);
        await new Promise(r => setTimeout(r, 400));
      }
      if (moddedDinos.length > 0) {
        const storedIds = letterMsgs['MODDED']?.messageIds || (letterMsgs['MODDED']?.messageId ? [letterMsgs['MODDED'].messageId] : []);
        const moddedEmbeds = buildModdedEmbeds(moddedDinos);
        const { ids: newIds } = await editOrRepost(channel, storedIds, moddedEmbeds);
        await updateLetterMessage('MODDED', newIds[0], channelId, newIds);
        await new Promise(r => setTimeout(r, 400));
      }
      const shoulderDinosAll = getShoulderDinos();
      if (shoulderDinosAll.length > 0) {
        const storedIds = letterMsgs['SHOULDER']?.messageIds || (letterMsgs['SHOULDER']?.messageId ? [letterMsgs['SHOULDER'].messageId] : []);
        const { ids: newIds } = await editOrRepost(channel, storedIds, [buildShoulderEmbed(shoulderDinosAll)]);
        await updateLetterMessage('SHOULDER', newIds[0], channelId, newIds);
        await new Promise(r => setTimeout(r, 400));
      }
      const dlcDinos = getPaidDLCDinos();
      if (dlcDinos.length > 0) {
        const storedIds = letterMsgs['PAIDDLC']?.messageIds || (letterMsgs['PAIDDLC']?.messageId ? [letterMsgs['PAIDDLC'].messageId] : []);
        const { ids: newIds } = await editOrRepost(channel, storedIds, buildPaidDLCEmbeds(dlcDinos));
        await updateLetterMessage('PAIDDLC', newIds[0], channelId, newIds);
        await new Promise(r => setTimeout(r, 400));
      }
      // Variant Alpha (A)
      const alphaVariantDinos = getDinosByVariant('A');
      if (alphaVariantDinos.length > 0) {
        const storedIds = letterMsgs['VARIANT_A']?.messageIds || (letterMsgs['VARIANT_A']?.messageId ? [letterMsgs['VARIANT_A'].messageId] : []);
        const { ids: newIds } = await editOrRepost(channel, storedIds, buildVariantEmbeds('A', alphaVariantDinos));
        await updateLetterMessage('VARIANT_A', newIds[0], channelId, newIds);
        await new Promise(r => setTimeout(r, 400));
      }
      // Variant Tek
      const tekVariantDinos = getDinosByVariant('Tek');
      if (tekVariantDinos.length > 0) {
        const storedIds = letterMsgs['VARIANT_TEK']?.messageIds || (letterMsgs['VARIANT_TEK']?.messageId ? [letterMsgs['VARIANT_TEK'].messageId] : []);
        const { ids: newIds } = await editOrRepost(channel, storedIds, buildVariantEmbeds('Tek', tekVariantDinos));
        await updateLetterMessage('VARIANT_TEK', newIds[0], channelId, newIds);
        await new Promise(r => setTimeout(r, 400));
      }

      // ── 2. Publier l'index avec les IDs frais ──
      const freshLetterMessages = getLetterMessages();
      const allDinosData = getDinoData();
      const settings = getSettings();
      const guildId = settings.guild?.guildId || discordClient.guilds.cache.first()?.id || '';
      const dinoChannelForLinks = channelId;

      function dinoLineLocal(dino, letterKey) {
        const lm = freshLetterMessages[letterKey];
        if (lm && lm.messageId && dinoChannelForLinks) {
          return `[${dino.name}](https://discord.com/channels/${guildId}/${dinoChannelForLinks}/${lm.messageId})`;
        }
        return dino.name;
      }
      function toFieldsLocal(lines, sectionTitle) {
        if (lines.length === 0) return [];
        const fields = [];
        let current = '';
        for (const line of lines) {
          const sep = current ? '\n' : '';
          if (current.length + sep.length + line.length > 1020) {
            fields.push({ name: fields.length === 0 ? sectionTitle : '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯', value: current });
            current = line;
          } else { current += sep + line; }
        }
        if (current) fields.push({ name: fields.length === 0 ? sectionTitle : '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯', value: current });
        return fields;
      }

      const regularDinos2 = [...allDinosData.dinos].filter(d => !d.isShoulder && !d.isPaidDLC).sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
      const shoulderDinos2 = [...allDinosData.dinos].filter(d => d.isShoulder).sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
      const dlcDinos2 = [...allDinosData.dinos].filter(d => d.isPaidDLC).sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));

      const regLines = regularDinos2.map(d => dinoLineLocal(d, (d.name || '?')[0].toUpperCase()));
      const shLines = shoulderDinos2.map(d => {
        const lm = freshLetterMessages['SHOULDER'];
        return lm?.messageId ? `[${d.name}](https://discord.com/channels/${guildId}/${dinoChannelForLinks}/${lm.messageId})` : dinoLineLocal(d, (d.name || '?')[0].toUpperCase());
      });
      const dlcLines2 = dlcDinos2.map(d => {
        const lm = freshLetterMessages['PAIDDLC'];
        return lm?.messageId ? `[${d.name}](https://discord.com/channels/${guildId}/${dinoChannelForLinks}/${lm.messageId})` : dinoLineLocal(d, (d.name || '?')[0].toUpperCase());
      });

      const alphaVariantDinos2 = getDinosByVariant('A');
      const tekVariantDinos2 = getDinosByVariant('Tek');
      const alphaLines2 = alphaVariantDinos2.map(({ dino }) => {
        const lm = freshLetterMessages['VARIANT_A'];
        return lm?.messageId ? `[${dino.name}](https://discord.com/channels/${guildId}/${dinoChannelForLinks}/${lm.messageId})` : dino.name;
      });
      const tekLines2 = tekVariantDinos2.map(({ dino }) => {
        const lm = freshLetterMessages['VARIANT_TEK'];
        return lm?.messageId ? `[${dino.name}](https://discord.com/channels/${guildId}/${dinoChannelForLinks}/${lm.messageId})` : dino.name;
      });

      const allFields2 = [
        ...toFieldsLocal(regLines, '🦕 Dinos disponibles'),
        ...toFieldsLocal(shLines, '🦜 Dinos d\'épaule'),
        ...toFieldsLocal(dlcLines2, '💰 Dinos DLC Payant'),
        ...toFieldsLocal(alphaLines2, '🅰️ Variants Alpha'),
        ...toFieldsLocal(tekLines2, '⚙️ Variants Tek'),
      ];
      if (allFields2.length === 0) allFields2.push({ name: '🦕 Dinos', value: '*Aucun dino pour le moment*' });

      function chunkFields2(fields, maxFields = 25, maxChars = 5800) {
        const chunks = [];
        let chunk = [], chars = 0;
        for (const f of fields) {
          const fChars = f.name.length + f.value.length;
          if (chunk.length >= maxFields || (chunk.length > 0 && chars + fChars > maxChars)) { chunks.push(chunk); chunk = []; chars = 0; }
          chunk.push(f); chars += fChars;
        }
        if (chunk.length > 0) chunks.push(chunk);
        return chunks.length > 0 ? chunks : [[]];
      }

      const indexChannel = await discordClient.channels.fetch(indexChannelId);
      if (!indexChannel) { console.error('publish-all-and-index: salon index introuvable'); return; }

      const totalDinos2 = allDinosData.dinos.length;
      const fieldChunks2 = chunkFields2(allFields2);
      const indexEmbeds = fieldChunks2.map((fields, i) => {
        const e = new EmbedBuilder().setColor(0x7c5cfc);
        if (i === 0) e.setTitle('🦕 Dino Shop - Index').setDescription('Retrouvez ci-dessous tous nos dinos disponibles.\nCliquez sur un nom pour accéder directement à sa fiche de prix !');
        if (fields.length > 0) e.addFields(fields);
        if (i === fieldChunks2.length - 1) e.setFooter({ text: `${totalDinos2} dino(s) au total • Arki\'s Family` }).setTimestamp();
        return e;
      });

      const { messageIds: oldIndexIds2 } = getDinoIndexInfo();
      const { ids: newIndexIds2 } = await editOrRepost(indexChannel, oldIndexIds2, indexEmbeds);
      await updateDinoIndexMessage(newIndexIds2[0] || null, newIndexIds2);
      console.log('✅ Publish-all-and-index terminé — embeds édités/mis à jour en place');
    } catch (err) {
      console.error('Erreur publish-all-and-index:', err);
    }
  });

  app.post('/dinos/publish-nav', requireAuth, async (req, res) => {
    const { ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
    const dinoData = getDinoData();
    const channelId = dinoData.dinoChannelId;
    if (!channelId) return res.redirect('/dinos?error=Aucun+salon+configur%C3%A9');

    const grouped = getDinosByLetter();
    const letters = Object.keys(grouped).sort();
    const moddedDinos = getModdedDinos();
    const shoulderDinos = getShoulderDinos();
    const paidDLCDinos = getPaidDLCDinos();
    if (letters.length === 0 && moddedDinos.length === 0) return res.redirect('/dinos?error=Aucun+dino+enregistr%C3%A9');

    try {
      const channel = await discordClient.channels.fetch(channelId);
      if (!channel) return res.redirect('/dinos?error=Salon+introuvable');

      const firstLetter = letters.length > 0 ? letters[0] : null;
      const embed = firstLetter ? buildLetterEmbed(firstLetter, grouped[firstLetter]) : buildModdedEmbed(moddedDinos);

      const totalDinos = letters.reduce((sum, l) => sum + grouped[l].length, 0) + moddedDinos.length;

      const visibleVariants = getVisibleVariantLabels();

      let specialCount = 0;
      if (shoulderDinos.length > 0) specialCount++;
      if (moddedDinos.length > 0) specialCount++;
      if (paidDLCDinos.length > 0) specialCount++;
      specialCount += visibleVariants.length;
      const maxLetters = 25 - specialCount;

      const menuOptions = [];

      if (letters.length <= maxLetters) {
        letters.forEach(l => {
          menuOptions.push({
            label: `Lettre ${l}`,
            description: `${grouped[l].length} dino${grouped[l].length > 1 ? 's' : ''}`,
            value: l,
            emoji: '📖',
            default: l === firstLetter,
          });
        });
      } else {
        const half = Math.floor(maxLetters / 2);
        for (let i = 0; i < letters.length; i += 2) {
          if (menuOptions.length >= 25 - specialCount) break;
          const l1 = letters[i];
          const l2 = letters[i + 1];
          if (l2) {
            const count = grouped[l1].length + grouped[l2].length;
            menuOptions.push({
              label: `Lettres ${l1}-${l2}`,
              description: `${count} dino${count > 1 ? 's' : ''}`,
              value: `${l1}-${l2}`,
              emoji: '📖',
              default: l1 === firstLetter || l2 === firstLetter,
            });
          } else {
            menuOptions.push({
              label: `Lettre ${l1}`,
              description: `${grouped[l1].length} dino${grouped[l1].length > 1 ? 's' : ''}`,
              value: l1,
              emoji: '📖',
              default: l1 === firstLetter,
            });
          }
        }
      }

      if (shoulderDinos.length > 0) {
        menuOptions.push({
          label: 'Dinos d\'épaule',
          description: `${shoulderDinos.length} dino${shoulderDinos.length > 1 ? 's' : ''} d'épaule`,
          value: 'SHOULDER',
          emoji: '🦜',
        });
      }
      if (moddedDinos.length > 0) {
        menuOptions.push({
          label: 'Dinos Moddés',
          description: `${moddedDinos.length} dino${moddedDinos.length > 1 ? 's' : ''} moddé${moddedDinos.length > 1 ? 's' : ''}`,
          value: 'MODDED',
          emoji: '🔧',
        });
      }
      if (paidDLCDinos.length > 0) {
        menuOptions.push({
          label: 'DLC Payant',
          description: `${paidDLCDinos.length} dino${paidDLCDinos.length > 1 ? 's' : ''} DLC payant`,
          value: 'PAIDDLC',
          emoji: '💲',
        });
      }

      for (const vl of visibleVariants) {
        if (menuOptions.length >= 25) break;
        menuOptions.push({
          label: `Variant ${vl.label}`,
          description: `${vl.count} dino${vl.count > 1 ? 's' : ''}`,
          value: `VAR_${vl.label}`,
          emoji: '🧬',
        });
      }

      if (menuOptions.length > 25) menuOptions.length = 25;

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('dino_letter_select')
        .setPlaceholder('🦖 Choisir une lettre...')
        .addOptions(menuOptions);

      const row = new ActionRowBuilder().addComponents(selectMenu);

      const navInfo = getNavMessage();
      if (navInfo && navInfo.messageId) {
        try {
          const existingMsg = await channel.messages.fetch(navInfo.messageId);
          await existingMsg.edit({ embeds: [embed], components: [row] });
          res.redirect('/dinos?success=Menu+navigable+mis+%C3%A0+jour+!');
        } catch (e) {
          const newMsg = await channel.send({ embeds: [embed], components: [row] });
          await updateNavMessage(newMsg.id, channelId);
          res.redirect('/dinos?success=Menu+navigable+republié+!');
        }
      } else {
        const newMsg = await channel.send({ embeds: [embed], components: [row] });
        await updateNavMessage(newMsg.id, channelId);
        res.redirect('/dinos?success=Menu+navigable+publi%C3%A9+!');
      }
    } catch (err) {
      console.error('Erreur publication menu dino:', err);
      res.redirect('/dinos?error=Erreur+de+publication');
    }
  });


  app.post('/dinos/publish-sale', requireAuth, async (req, res) => {
    const { saleDinoId, salePercent, saleChannelId, saleDurationHours } = req.body;
    if (!saleDinoId || !salePercent) return res.redirect('/dinos?error=Dino+et+pourcentage+requis');

    const dino = getDino(saleDinoId);
    if (!dino) return res.redirect('/dinos?error=Dino+introuvable');

    const percent = parseInt(salePercent);
    if (percent <= 0 || percent >= 100) return res.redirect('/dinos?error=Pourcentage+invalide');

    const durationHours = Math.max(1, parseInt(saleDurationHours) || 24);
    const dinoData = getDinoData();
    const channelId = saleChannelId || dinoData.dinoChannelId;
    if (!channelId) return res.redirect('/dinos?error=Aucun+salon+configur%C3%A9');

    try {
      const channel = await discordClient.channels.fetch(channelId);
      if (!channel) return res.redirect('/dinos?error=Salon+introuvable');

      const expiresAt = Date.now() + durationHours * 3600 * 1000;
      const embed = buildSaleEmbed(dino, percent, durationHours, expiresAt);
      await channel.send({ embeds: [embed] });

      await setFlashSale(saleDinoId, percent, durationHours);

      res.redirect('/dinos?success=Promo+publi%C3%A9e+!');
    } catch (err) {
      console.error('Erreur publication promo dino:', err);
      res.redirect('/dinos?error=Erreur+de+publication');
    }
  });

  app.post('/dinos/clear-sale', requireAuth, async (req, res) => {
    try {
      await clearFlashSale();
      res.redirect('/dinos?success=Promo+stopp%C3%A9e');
    } catch (err) {
      console.error('Erreur arrêt promo:', err);
      res.redirect('/dinos?error=Erreur+arr%C3%AAt+promo');
    }
  });

  app.get('/inventory/api/members/search', requireAuth, async (req, res) => {
    const query = (req.query.q || '').toLowerCase().trim();
    if (!query || query.length < 2) {
      return res.json([]);
    }
    if (!discordClient) {
      return res.json([]);
    }
    try {
      const settings = getSettings();
      const guildId = settings.guild.guildId;
      const guild = guildId ? discordClient.guilds.cache.get(guildId) : discordClient.guilds.cache.first();
      if (!guild) return res.json([]);

      const members = await guild.members.fetch({ query, limit: 15 });
      const results = members.map(m => ({
        id: m.user.id,
        username: m.user.username,
        displayName: m.displayName,
        avatar: m.user.displayAvatarURL({ size: 32 }),
      }));
      res.json(results);
    } catch (e) {
      console.error('Erreur recherche membres:', e.message);
      res.json([]);
    }
  });

  // ── Packs Spéciaux ──────────────────────────────────────────────────────
  app.get('/special-packs', requireAuth, (req, res) => {
    const data = getSpecialPacks();
    const itemTypes = inventoryManager.getItemTypes();
    res.render('special-packs', {
      path: '/special-packs',
      packs: data.packs || [],
      itemTypes,
      success: req.query.success || null,
      error: req.query.error || null,
      botUser: discordClient?.user || null,
      discordUser: req.session.discordUser || null,
      role: req.session.role || 'staff',
    });
  });

  app.post('/special-packs/save', requireAuth, async (req, res) => {
    const { packId, packType, name, color, note, itemsJson } = req.body;
    let items = [];
    try { items = JSON.parse(itemsJson || '[]'); } catch (e) {}
    items = items.filter(i => i.itemId && i.quantity > 0);
    const packData = {
      type: packType || 'donation',
      name: name || 'Pack sans nom',
      color: color || '#7c5cfc',
      note: note || '',
      items,
    };
    if (packId) {
      await updateSpecialPack(packId, packData);
      res.redirect('/special-packs?success=Pack+modifié+!');
    } else {
      await addSpecialPack(packData);
      res.redirect('/special-packs?success=Pack+créé+!');
    }
  });

  app.post('/special-packs/delete/:id', requireAuth, async (req, res) => {
    await deleteSpecialPack(req.params.id);
    res.redirect('/special-packs?success=Pack+supprimé+!');
  });

  // ── Inventaires ──────────────────────────────────────────────────────────
  app.get('/inventory', requireAuth, (req, res) => {
    const itemTypes = inventoryManager.getItemTypes();
    const categories = inventoryManager.getCategories();
    res.render('inventory', {
      itemTypes,
      categories,
      userRole: req.session.role,
      success: req.query.success || null,
      error: req.query.error || null,
    });
  });

  app.post('/inventory/item-types', requireAdmin, async (req, res) => {
    const { itemId, name, emoji, category, order } = req.body;
    if (!name || !name.trim()) {
      return res.redirect('/inventory?error=Le+nom+est+requis');
    }
    if (itemId) {
      await inventoryManager.updateItemType(itemId, {
        name: name.trim(),
        emoji: emoji || '📦',
        category: category || 'other',
        order: parseInt(order) || 1,
      });
      res.redirect('/inventory?success=Type+modifi%C3%A9+!');
    } else {
      await inventoryManager.addItemType({
        name: name.trim(),
        emoji: emoji || '📦',
        category: category || 'other',
        order: parseInt(order) || 1,
      });
      res.redirect('/inventory?success=Type+cr%C3%A9%C3%A9+!');
    }
  });

  app.post('/inventory/item-types/delete/:id', requireAdmin, async (req, res) => {
    const deleted = await inventoryManager.deleteItemType(req.params.id);
    if (deleted) {
      res.redirect('/inventory?success=Type+supprim%C3%A9+!');
    } else {
      res.redirect('/inventory?error=Type+introuvable');
    }
  });

  app.post('/inventory/categories', requireAdmin, async (req, res) => {
    const { catId, name, emoji, order } = req.body;
    if (!name || !name.trim()) {
      return res.redirect('/inventory?error=Le+nom+est+requis');
    }
    if (catId) {
      await inventoryManager.updateCategory(catId, {
        name: name.trim(),
        emoji: emoji || '📦',
        order: parseInt(order) || 1,
      });
      res.redirect('/inventory?success=Cat%C3%A9gorie+modifi%C3%A9e+!');
    } else {
      await inventoryManager.addCategory({
        name: name.trim(),
        emoji: emoji || '📦',
        order: parseInt(order) || 1,
      });
      res.redirect('/inventory?success=Cat%C3%A9gorie+cr%C3%A9%C3%A9e+!');
    }
  });

  app.post('/inventory/categories/delete/:id', requireAdmin, async (req, res) => {
    const deleted = await inventoryManager.deleteCategory(req.params.id);
    if (deleted) {
      res.redirect('/inventory?success=Cat%C3%A9gorie+supprim%C3%A9e+!');
    } else {
      res.redirect('/inventory?error=Cat%C3%A9gorie+introuvable');
    }
  });

  async function resolvePlayerName(playerId) {
    try {
      if (!discordClient || !/^\d{17,20}$/.test(playerId)) return playerId;
      const settings = getSettings();
      const guildId = settings.guild.guildId;
      const guild = guildId ? discordClient.guilds.cache.get(guildId) : discordClient.guilds.cache.first();
      if (!guild) return playerId;
      const member = await guild.members.fetch(playerId).catch(() => null);
      return member ? (member.displayName || member.user.username) : playerId;
    } catch (e) { return playerId; }
  }

  async function sendInventoryLog(action, adminName, itemType, quantity, playerId) {
    try {
      const settings = getSettings();
      const channelId = settings.guild.inventoryLogChannelId;
      if (!channelId || !discordClient) return;
      const channel = await discordClient.channels.fetch(channelId);
      if (!channel) return;
      const verb = action === 'add' ? 'a ajouté' : 'a retiré';
      const prep = action === 'add' ? 'à l\'inventaire de' : 'de l\'inventaire de';
      const playerName = await resolvePlayerName(playerId);
      await channel.send(`${itemType.emoji} **${adminName}** ${verb} **${quantity} ${itemType.name}** ${prep} **${playerName}**`);
    } catch (e) {
      console.error('Erreur log inventaire Discord:', e.message);
    }
  }

  app.post('/inventory/player/:playerId/add', requireAuth, async (req, res) => {
    const { playerId } = req.params;
    const { itemTypeId, libreItemName, quantity, reason } = req.body;
    if (!itemTypeId || !quantity) {
      return res.json({ error: 'Item et quantité requis' });
    }
    const adminName = req.session.discordUser?.displayName || (req.session.role === 'admin' ? 'Admin' : 'Staff');

    // Item temporaire (libre)
    if (itemTypeId === '__libre__') {
      const name = (libreItemName || '').trim();
      if (!name) return res.json({ error: 'Nom de l\'item temporaire requis' });
      const libreKey = `[libre] ${name}`;
      const result = await inventoryManager.addToInventory(playerId, libreKey, parseInt(quantity) || 1, adminName, reason || '');
      return res.json({ success: true, newQuantity: result.newQuantity });
    }

    const itemType = inventoryManager.getItemTypeById(itemTypeId);
    if (!itemType) return res.json({ error: 'Type d\'item introuvable' });
    const result = await inventoryManager.addToInventory(playerId, itemTypeId, parseInt(quantity) || 1, adminName, reason || '');
    sendInventoryLog('add', adminName, itemType, parseInt(quantity) || 1, playerId);
    res.json({ success: true, newQuantity: result.newQuantity });
  });

  app.post('/inventory/player/:playerId/remove', requireAuth, async (req, res) => {
    const { playerId } = req.params;
    const { itemTypeId, quantity, reason } = req.body;
    if (!itemTypeId || !quantity) {
      return res.json({ error: 'Item et quantité requis' });
    }
    const adminName = req.session.discordUser?.displayName || (req.session.role === 'admin' ? 'Admin' : 'Staff');

    // Item libre : retrait direct sans vérification de type
    if (itemTypeId.startsWith('[libre] ')) {
      const result = await inventoryManager.removeFromInventory(playerId, itemTypeId, parseInt(quantity) || 1, adminName, reason || '');
      return res.json({ success: true, newQuantity: result.newQuantity });
    }

    const itemType = inventoryManager.getItemTypeById(itemTypeId);
    if (!itemType) return res.json({ error: 'Type d\'item introuvable' });
    const result = await inventoryManager.removeFromInventory(playerId, itemTypeId, parseInt(quantity) || 1, adminName, reason || '');
    sendInventoryLog('remove', adminName, itemType, parseInt(quantity) || 1, playerId);
    res.json({ success: true, newQuantity: result.newQuantity });
  });

  app.post('/inventory/player/:playerId/set', requireAuth, async (req, res) => {
    const { playerId } = req.params;
    const { itemTypeId, quantity, reason } = req.body;
    if (!itemTypeId || quantity === undefined || quantity === null) {
      return res.json({ error: 'Item et quantité requis' });
    }
    const adminName = req.session.discordUser?.username || req.session.discordUser?.displayName || 'Dashboard';
    const qty = Math.max(0, parseInt(quantity) || 0);
    await inventoryManager.setInventoryItem(playerId, itemTypeId, qty, adminName, reason || '');
    try {
      const settings = getSettings();
      const channelId = settings.guild.inventoryLogChannelId;
      if (channelId && discordClient) {
        const channel = await discordClient.channels.fetch(channelId);
        if (channel) {
          const itemType = inventoryManager.getItemTypeById(itemTypeId);
          const label = itemType ? `${itemType.emoji} ${itemType.name}` : itemTypeId;
          const playerName = await resolvePlayerName(playerId);
          await channel.send(`✏️ **${adminName}** a défini **${label}** à **${qty}** pour **${playerName}**`);
        }
      }
    } catch (e) {}
    res.json({ success: true, newQuantity: qty });
  });

  app.get('/inventory/api/player/:playerId', requireAuth, async (req, res) => {
    const { playerId } = req.params;
    const inventory = inventoryManager.getPlayerInventory(playerId);
    let player = {};
    if (discordClient) {
      try {
        const settings = getSettings();
        const configuredGuildId = settings.guild.guildId;
        const guild = configuredGuildId ? discordClient.guilds.cache.get(configuredGuildId) : discordClient.guilds.cache.first();
        if (guild) {
          const member = await guild.members.fetch(playerId).catch(() => null);
          if (member) {
            player = {
              username: member.user.username,
              displayName: member.displayName,
              avatar: member.user.displayAvatarURL({ size: 64 }),
            };
          }
        }
      } catch (e) {}
    }
    res.json({ playerId, inventory, player });
  });

  app.get('/inventory/api/transactions', requireAuth, async (req, res) => {
    const filters = {};
    if (req.query.playerId) filters.playerId = req.query.playerId;
    if (req.query.itemTypeId) filters.itemTypeId = req.query.itemTypeId;
    if (req.query.type) filters.type = req.query.type;
    if (req.query.limit) filters.limit = parseInt(req.query.limit);
    if (!filters.limit) filters.limit = 100;
    const result = inventoryManager.getTransactions(filters);

    // Enrichissement : résoudre les noms Discord des joueurs
    try {
      if (discordClient && result.transactions && result.transactions.length > 0) {
        const settings = getSettings();
        const guildId = settings.guild.guildId;
        const guild = guildId ? discordClient.guilds.cache.get(guildId) : discordClient.guilds.cache.first();
        if (guild) {
          // Collecter les IDs uniques (seulement vrais IDs Discord : ~18 chiffres)
          const uniqueIds = [...new Set(result.transactions.map(t => t.playerId))]
            .filter(id => /^\d{17,20}$/.test(id));
          if (uniqueIds.length > 0) {
            const fetched = await guild.members.fetch({ user: uniqueIds }).catch(() => null);
            const nameMap = {};
            if (fetched) {
              fetched.forEach(m => {
                nameMap[m.user.id] = m.displayName || m.user.username;
              });
            }
            result.transactions = result.transactions.map(tx => ({
              ...tx,
              playerName: nameMap[tx.playerId] || null,
            }));
          }
        }
      }
    } catch (e) { /* silencieux — on retourne les IDs bruts si échec */ }

    res.json(result);
  });

  app.post('/inventory/batch-distribute', requireAuth, express.json(), async (req, res) => {
    const { itemId, quantity, playerIds, note } = req.body;
    const itemType = inventoryManager.getItemTypeById(itemId);
    if (!itemType) return res.json({ error: 'Item introuvable.' });
    const qty = parseInt(quantity) || 1;
    if (!playerIds || !Array.isArray(playerIds) || playerIds.length === 0) {
      return res.json({ error: 'Aucun joueur spécifié.' });
    }
    const adminName = req.session.discordUser?.displayName || (req.session.role === 'admin' ? 'Admin' : 'Staff');
    const txNote = note?.trim() || `Distribution depuis dashboard par ${adminName}`;
    const results = [];
    for (const pid of playerIds) {
      const id = pid?.trim();
      if (!id) continue;
      try {
        await inventoryManager.addToInventory(id, itemId, qty, adminName, txNote);
        results.push({ id, success: true });
      } catch (e) {
        results.push({ id, success: false, error: e.message });
      }
    }
    res.json({ ok: true, results });
  });

  // ─── GIVEAWAYS ──────────────────────────────────────────────────────────────
  const giveawayUpload = multer({
    storage: multer.diskStorage({
      destination: path.join(__dirname, 'public/uploads'),
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase() || '.png';
        cb(null, `giveway_${Date.now()}${ext}`);
      },
    }),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (file.mimetype.startsWith('image/')) cb(null, true);
      else cb(new Error('Fichier non supporté'));
    },
  });

  // ── Revenus de rôles ───────────────────────────────────────────────────────
  app.get('/economy', requireAdmin, async (req, res) => {
    const roles = await economyManager.getRoleIncomes();
    const discordRoles = [];
    try {
      const settings = getSettings();
      const guildId = settings.guild?.guildId;
      if (discordClient && guildId) {
        const guild = discordClient.guilds.cache.get(guildId) || discordClient.guilds.cache.first();
        if (guild) {
          const allRoles = [...guild.roles.cache.values()]
            .filter(r => r.name !== '@everyone')
            .sort((a, b) => b.position - a.position);
          allRoles.forEach(r => discordRoles.push({ id: r.id, name: r.name }));
        }
      }
    } catch (e) {}
    res.render('economy', {
      path: '/economy',
      roles,
      discordRoles,
      botUser: discordClient?.user || null,
      discordUser: req.session.discordUser || null,
      role: req.session.role || 'admin',
      success: req.query.success || null,
      error: req.query.error || null,
    });
  });

  app.post('/economy/roles/add', requireAdmin, express.json(), async (req, res) => {
    const { roleId, roleName, income, shopDiscount } = req.body;
    if (!roleId) return res.json({ error: 'Rôle manquant' });
    await economyManager.setRoleIncome(roleId, roleName || roleId, income || 0, shopDiscount || 0);
    res.json({ ok: true });
  });

  app.post('/economy/roles/delete', requireAdmin, express.json(), async (req, res) => {
    const { roleId } = req.body;
    if (!roleId) return res.json({ error: 'roleId manquant' });
    await economyManager.deleteRoleIncome(roleId);
    res.json({ ok: true });
  });

  app.get('/economy/api/roles', requireAdmin, async (req, res) => {
    const roles = await economyManager.getRoleIncomes();
    res.json(roles);
  });

  // ── Niveaux & XP ────────────────────────────────────────────────────────────
  app.get('/xp', requireAdmin, async (req, res) => {
    const config = await xpManager.loadXpConfig();
    const discordRoles = [];
    const discordChannels = [];
    try {
      const guild = discordClient?.guilds.cache.first();
      if (guild) {
        [...guild.roles.cache.values()]
          .filter(r => r.name !== '@everyone')
          .sort((a, b) => b.position - a.position)
          .forEach(r => discordRoles.push({ id: r.id, name: r.name }));
        [...guild.channels.cache.values()]
          .filter(c => c.type === 0)
          .sort((a, b) => a.name.localeCompare(b.name))
          .forEach(c => discordChannels.push({ id: c.id, name: c.name }));
      }
    } catch (e) {}
    res.render('xp', {
      path: '/xp',
      config,
      discordRoles,
      discordChannels,
      botUser: discordClient?.user || null,
      discordUser: req.session.discordUser || null,
      role: req.session.role || 'admin',
    });
  });

  app.post('/xp/config', requireAdmin, express.json(), async (req, res) => {
    const config = await xpManager.loadXpConfig();
    const { roleId, channelId, minXp, maxXp, cooldownMs, rewardMultiplier, excludedChannels } = req.body;
    if (roleId !== undefined)         config.roleId           = roleId;
    if (channelId !== undefined)      config.channelId        = channelId || null;
    if (minXp !== undefined)          config.minXp            = parseInt(minXp) || 3;
    if (maxXp !== undefined)          config.maxXp            = parseInt(maxXp) || 10;
    if (cooldownMs !== undefined)     config.cooldownMs       = parseInt(cooldownMs) || 60000;
    if (rewardMultiplier !== undefined) config.rewardMultiplier = parseInt(rewardMultiplier) || 1000;
    if (excludedChannels !== undefined) config.excludedChannels = excludedChannels;
    await xpManager.saveXpConfig(config);
    res.json({ ok: true });
  });

  app.post('/xp/rewards/set', requireAdmin, express.json(), async (req, res) => {
    const { level, diamonds } = req.body;
    if (!level || diamonds === undefined) return res.json({ error: 'Données manquantes' });
    const config = await xpManager.loadXpConfig();
    config.customRewards[level] = parseInt(diamonds) || 0;
    await xpManager.saveXpConfig(config);
    res.json({ ok: true });
  });

  app.post('/xp/rewards/delete', requireAdmin, express.json(), async (req, res) => {
    const { level } = req.body;
    if (!level) return res.json({ error: 'level manquant' });
    const config = await xpManager.loadXpConfig();
    delete config.customRewards[level];
    await xpManager.saveXpConfig(config);
    res.json({ ok: true });
  });

  app.get('/xp/api/config', requireAdmin, async (req, res) => {
    res.json(await xpManager.loadXpConfig());
  });

  app.get('/giveaways', requireAuth, (req, res) => {
    const giveaways = giveawayManager.getAllGiveaways();
    const itemTypes = inventoryManager.getItemTypes();
    const settings = getSettings();
    let channels = [];
    if (discordClient) {
      const guild = discordClient.guilds.cache.first();
      if (guild) {
        const textChannels = guild.channels.cache
          .filter(ch => ch.type === 0)
          .sort((a, b) => a.name.localeCompare(b.name));
        channels = [...textChannels.values()].map(ch => ({ id: ch.id, name: ch.name }));
      }
    }
    res.render('giveaways', {
      path: '/giveaways',
      role: req.session.role,
      discordUser: req.session.discordUser,
      botUser: discordClient ? discordClient.user : null,
      giveaways,
      itemTypes,
      channels,
      formatTimeLeft: giveawayManager.formatTimeLeft,
      defaultImageUrl: settings.giveaway?.defaultImageUrl || '',
    });
  });

  app.post('/giveaways/create', requireAuth, giveawayUpload.none(), async (req, res) => {
    const { title, description, conditions, prizeType, prizeItemId, prizeItemName, prizeQuantity, winnerCount, endDate, endTime, channelId, roleId, imageUrl: imageUrlInput, pingEveryone } = req.body;
    const settings = getSettings();
    const targetChannelId = channelId || settings.guild?.giveawayChannelId || settings.guild?.resultsChannelId;
    if (!targetChannelId) return res.json({ error: 'Aucun salon Discord (ID) requis. Saisissez l\'ID du salon ou configurez un salon par défaut dans les Paramètres.' });

    let prize;
    const itemTypes = inventoryManager.getItemTypes();
    if (prizeType === 'libre') {
      prize = { type: 'libre', name: prizeItemName || 'Item', quantity: parseInt(prizeQuantity) || 1 };
    } else {
      const foundItem = itemTypes.find(i => i.id === prizeItemId);
      prize = { type: 'item', itemId: prizeItemId, name: foundItem ? `${foundItem.emoji} ${foundItem.name}` : prizeItemId, quantity: parseInt(prizeQuantity) || 1 };
    }

    // Calculer l'heure de fin (date + heure ou juste heure aujourd'hui/demain)
    let endDateTime;
    if (endDate) {
      endDateTime = new Date(`${endDate}T${endTime || '23:59'}:00`);
    } else if (endTime) {
      const [h, m] = endTime.split(':').map(Number);
      const now = new Date();
      endDateTime = new Date();
      endDateTime.setHours(h, m, 0, 0);
      if (endDateTime <= now) endDateTime.setDate(endDateTime.getDate() + 1);
    } else {
      return res.json({ error: 'Heure de fin requise.' });
    }

    const imageUrl = imageUrlInput?.trim() || settings.giveaway?.defaultImageUrl || '';

    const giveaway = await giveawayManager.createGiveaway({
      title, description, conditions, prize,
      winnerCount: parseInt(winnerCount) || 1,
      endTime: endDateTime.toISOString(),
      channelId: targetChannelId,
      guildId: settings.guild?.guildId || '',
      createdBy: req.session.discordUser?.id || 'dashboard',
      createdByName: req.session.discordUser?.displayName || 'Admin',
      imageUrl,
      roleId: roleId || '',
      pingEveryone: pingEveryone === 'on' || pingEveryone === 'true',
    });

    // Publier l'embed sur Discord
    if (discordClient) {
      try {
        const channel = await discordClient.channels.fetch(targetChannelId);
        if (channel) {
          const embed = buildGiveawayEmbed(giveaway, discordClient);
          const row = buildGiveawayButton(giveaway.id);
          const msg = await channel.send({ embeds: [embed], components: [row] });
          await giveawayManager.updateMessageId(giveaway.id, msg.id);
          if (giveaway.pingEveryone) {
            await channel.send('@everyone 🎉 Un nouveau giveaway vient d\'être lancé ! Cliquez sur **Je participe** pour tenter votre chance !');
          }
        }
      } catch (e) {
        console.error('[Giveaway] Erreur publication Discord:', e);
      }
    }

    res.json({ success: true, id: giveaway.id });
  });

  app.post('/giveaways/:id/update-image', requireAdmin, giveawayUpload.none(), async (req, res) => {
    const { id } = req.params;
    const { imageUrl: imageUrlInput } = req.body;
    const g = giveawayManager.getGiveaway(id);
    if (!g) return res.json({ error: 'Giveaway introuvable.' });
    const imageUrl = imageUrlInput?.trim() || '';
    if (!imageUrl) return res.json({ error: 'URL d\'image requise.' });
    await giveawayManager.updateImageUrl(id, imageUrl);
    if (discordClient && g.messageId && g.channelId) {
      try {
        const channel = await discordClient.channels.fetch(g.channelId);
        const msg = await channel.messages.fetch(g.messageId);
        const updated = giveawayManager.getGiveaway(id);
        updated.imageUrl = imageUrl;
        await msg.edit({ embeds: [buildGiveawayEmbed(updated, discordClient)] });
      } catch (e) {}
    }
    res.json({ success: true, imageUrl });
  });

  app.post('/giveaways/:id/delete', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const g = giveawayManager.getGiveaway(id);
    if (g && g.messageId && g.channelId && discordClient) {
      try {
        const channel = await discordClient.channels.fetch(g.channelId);
        const msg = await channel.messages.fetch(g.messageId).catch(() => null);
        if (msg) await msg.delete();
      } catch (e) {}
    }
    await giveawayManager.deleteGiveaway(id);
    res.json({ success: true });
  });

  app.post('/giveaways/:id/end', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const g = giveawayManager.getGiveaway(id);
    if (!g) return res.json({ error: 'Giveaway introuvable.' });
    if (discordClient) {
      await endGiveawayNow(id, discordClient);
    }
    res.json({ success: true });
  });

  // ── Ré-annoncer les gagnants existants sans re-tirer ─────────────────────────
  app.post('/giveaways/:id/announce', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const g = giveawayManager.getGiveaway(id);
    if (!g) return res.json({ error: 'Giveaway introuvable.' });
    if (!discordClient) return res.json({ error: 'Bot Discord non connecté.' });
    if (!g.winners || g.winners.length === 0) return res.json({ error: 'Aucun gagnant enregistré pour ce giveaway.' });

    try {
      const channel = await discordClient.channels.fetch(g.channelId);
      const prizeLabel = buildPrizeLabelServer(g.prize);
      const winnerMentions = g.winners.map(uid => `<@${uid}>`).join(', ');
      await channel.send(`🎉 **Résultats du Giveaway "${g.title}" !**\n\n🏆 Félicitations ${winnerMentions} ! Vous remportez **${prizeLabel}** !\n\n> *(Annonce re-publiée depuis le dashboard)*`);

      // DM gagnants
      for (const uid of g.winners) {
        try {
          const user = await discordClient.users.fetch(uid);
          await user.send(`🎉 Félicitations ! Tu as gagné le giveaway **${g.title}** sur Arki Family !\nTu remportes : **${prizeLabel}**\nContacte un administrateur pour recevoir ton gain.`);
        } catch (e) {}
      }
      res.json({ success: true });
    } catch (e) {
      console.error('[Giveaway] Erreur ré-annonce:', e);
      res.json({ error: e.message });
    }
  });

  function buildPrizeLabelServer(prize) {
    const cleanName = (str) => (str || '').replace(/^[🎁📦🎀🎊🎉\s]+/, '').trim() || (str || '');
    if (prize.itemId && prize.itemId !== '__libre__') {
      const itemTypes = inventoryManager.getItemTypes();
      const found = itemTypes.find(i => i.id === prize.itemId);
      if (found) {
        const isCustomEmoji = /^<a?:\w+:\d+>$/.test(found.emoji);
        const displayName = isCustomEmoji ? found.name : `${found.emoji} ${found.name}`;
        return `${displayName} ×${prize.quantity}`;
      }
      return `${cleanName(prize.name) || prize.itemId} ×${prize.quantity}`;
    }
    return `${cleanName(prize.name) || prize.itemId || '—'} ×${prize.quantity}`;
  }

  function buildGiveawayEmbed(g, client) {
    const { EmbedBuilder } = require('discord.js');
    const timeLeft = giveawayManager.formatTimeLeft(g.endTime);
    const parisOpts = { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' };
    const parisDateOpts = { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit' };
    const endStr = new Date(g.endTime).toLocaleTimeString('fr-FR', parisOpts);
    const endDateStr = new Date(g.endTime).toLocaleDateString('fr-FR', parisDateOpts);
    const prizeLabel = buildPrizeLabelServer(g.prize);

    const embed = new EmbedBuilder()
      .setColor('#FF6B6B')
      .setAuthor({ name: '🎉 Giveaway Arki Family' })
      .setTimestamp(new Date(g.endTime));

    if (g.imageUrl) {
      try {
        const imgUrl = (g.imageUrl.startsWith('http://') || g.imageUrl.startsWith('https://'))
          ? g.imageUrl
          : (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}${g.imageUrl}` : null);
        if (imgUrl) embed.setImage(imgUrl);
      } catch (e) {}
    }

    let desc = `# ${g.title}\n`;
    if (g.description) desc += `\n${g.description}\n`;
    desc += `\n🏆 **Gain :** ${prizeLabel}\n`;
    desc += `👥 **Gagnant(s) :** ${g.winnerCount}\n`;
    desc += `👤 **Participants :** ${g.participants.length}\n\n`;
    desc += g.status === 'ended'
      ? `✅ **Terminé**`
      : `⏰ **Fin dans :** ${timeLeft} | le ${endDateStr} à ${endStr} *(Paris)*`;
    if (g.conditions) desc += `\n\n📋 **Conditions :** ${g.conditions}`;

    embed.setDescription(desc);
    embed.setFooter({ text: `ID: ${g.id} • Lancé par ${g.createdByName || g.createdBy}` });
    return embed;
  }

  function buildGiveawayButton(id) {
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`giveway_join_${id}`)
        .setLabel('🎉 Je participe')
        .setStyle(ButtonStyle.Primary)
    );
  }

  // endGiveawayNow : utilisé pour la terminaison manuelle depuis le dashboard
  // Les timers automatiques sont gérés exclusivement par le bot (index.js)
  async function endGiveawayNow(id, client) {
    const g = giveawayManager.getGiveaway(id);
    if (!g || g.status !== 'active') return;
    const winners = await giveawayManager.drawWinners(id);
    const updated = giveawayManager.getGiveaway(id);
    try {
      const channel = await client.channels.fetch(g.channelId);
      if (g.messageId) {
        const msg = await channel.messages.fetch(g.messageId).catch(() => null);
        if (msg) {
          const endEmbed = buildGiveawayEmbed(updated, client);
          endEmbed.setColor('#95a5a6');
          const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
          const disabledRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`giveway_join_${id}`).setLabel('🎉 Je participe').setStyle(ButtonStyle.Primary).setDisabled(true)
          );
          await msg.edit({ embeds: [endEmbed], components: [disabledRow] });
        }
      }
      const prizeLabel = buildPrizeLabelServer(g.prize);
      if (winners && winners.length > 0) {
        const winnerMentions = winners.map(uid => `<@${uid}>`).join(', ');
        await channel.send(`🎉 **Fin du Giveaway !**\n\n🏆 Félicitations ${winnerMentions} ! Vous remportez **${prizeLabel}** !\n\n> Contactez un administrateur pour recevoir votre gain.`);
        for (const uid of winners) {
          try {
            const user = await client.users.fetch(uid);
            await user.send(`🎉 Félicitations ! Tu as gagné le giveaway **${g.title}** sur Arki Family !\nTu remportes : **${prizeLabel}**\nContacte un administrateur pour recevoir ton gain.`);
          } catch (e) {}
        }
        if (g.prize.type === 'item') {
          const { addToInventory } = require('../inventoryManager');
          for (const uid of winners) {
            try { await addToInventory(uid, g.prize.itemId, g.prize.quantity, 'giveaway', g.title); } catch (e) {}
          }
        }
      } else {
        await channel.send(`😔 **Fin du Giveaway "${g.title}"** — Aucun participant éligible pour le tirage.`);
      }
    } catch (e) {
      console.error('[Giveaway] Erreur fin giveaway (dashboard):', e);
    }
  }

  app.post('/giveaways/set-default-image', requireAdmin, giveawayUpload.none(), async (req, res) => {
    const { imageUrl } = req.body;
    await updateSection('giveaway', { defaultImageUrl: imageUrl?.trim() || '' });
    res.json({ success: true });
  });

  app.post('/giveaways/clear-default-image', requireAdmin, async (req, res) => {
    await updateSection('giveaway', { defaultImageUrl: '' });
    res.json({ success: true });
  });

  app.get('/giveaways/:id/participants', requireAuth, (req, res) => {
    const g = giveawayManager.getGiveaway(req.params.id);
    if (!g) return res.json({ error: 'Giveaway introuvable.' });
    res.json({ participants: g.participants, winners: g.winners, status: g.status });
  });

  app.delete('/giveaways/:id/participants/:userId', requireAuth, async (req, res) => {
    const removed = await giveawayManager.removeParticipant(req.params.id, req.params.userId);
    if (!removed) return res.json({ error: 'Participant introuvable.' });
    const g = giveawayManager.getGiveaway(req.params.id);
    if (discordClient && g && g.messageId && g.channelId) {
      try {
        const channel = await discordClient.channels.fetch(g.channelId);
        const msg = await channel.messages.fetch(g.messageId).catch(() => null);
        if (msg) await msg.edit({ embeds: [buildGiveawayEmbed(g, discordClient)] });
      } catch (e) {}
    }
    res.json({ success: true });
  });

  // ─── NITRADO ──────────────────────────────────────────────────────────────────
  const nitrado = require('./nitradoManager');

  // Page principale
  app.get('/nitrado', requireAdmin, async (req, res) => {
    const hasToken = !!nitrado.getToken();
    let servers = [];
    let error = null;

    if (hasToken) {
      try {
        const services = await nitrado.getServices();
        const details = await nitrado.getMultipleDetails(services.map(s => s.id));
        servers = services.map(s => {
          const d = details.find(x => x.serviceId === s.id)?.detail || null;
          return {
            id: s.id,
            name: s.details?.name || d?.query?.server_name || `Serveur ${s.id}`,
            status: d?.status || 'unknown',
            map: d?.query?.map || d?.settings?.config?.map || '–',
            players: d?.query?.player_current ?? '–',
            maxPlayers: d?.query?.player_max ?? '–',
            ip: d?.ip || '–',
            port: d?.port || '–',
            game: s.details?.game || 'ark_sa',
          };
        });
      } catch (e) {
        error = e.message;
      }
    }

    res.render('nitrado', {
      path: req.path,
      botUser: discordClient?.user || null,
      discordUser: req.session.discordUser,
      role: req.session.role,
      hasToken,
      servers,
      error,
    });
  });

  // API : statut serveurs (refresh)
  app.get('/nitrado/api/servers', requireAdmin, async (req, res) => {
    try {
      const services = await nitrado.getServices();
      const details = await nitrado.getMultipleDetails(services.map(s => s.id));
      const servers = services.map(s => {
        const d = details.find(x => x.serviceId === s.id)?.detail || null;
        return {
          id: s.id,
          name: s.details?.name || d?.query?.server_name || `Serveur ${s.id}`,
          status: d?.status || 'unknown',
          map: d?.query?.map || '–',
          players: d?.query?.player_current ?? '–',
          maxPlayers: d?.query?.player_max ?? '–',
        };
      });
      res.json({ ok: true, servers });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // API : redémarrer un serveur
  app.post('/nitrado/api/restart/:id', requireAdmin, async (req, res) => {
    try {
      await nitrado.restartServer(req.params.id, req.body.message || '');
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // API : redémarrer des serveurs (tous ou sélection)
  app.post('/nitrado/api/restart-all', requireAdmin, async (req, res) => {
    try {
      let ids = req.body.serviceIds;
      if (!ids || !ids.length) {
        const services = await nitrado.getServices();
        ids = services.map(s => s.id);
      }
      const results = await nitrado.restartAll(ids, req.body.message || '');
      res.json({ ok: true, results });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // API : stopper un serveur
  app.post('/nitrado/api/stop/:id', requireAdmin, async (req, res) => {
    try {
      await nitrado.stopServer(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // API : démarrer un serveur
  app.post('/nitrado/api/start/:id', requireAdmin, async (req, res) => {
    try {
      await nitrado.startServer(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // API debug : structure brute des settings Nitrado (pour identifier la clé mods)
  app.get('/nitrado/api/settings-raw/:id', requireAdmin, async (req, res) => {
    try {
      const settings = await nitrado.getSettings(req.params.id);
      const summary = {};
      for (const [cat, val] of Object.entries(settings)) {
        if (typeof val === 'object' && val !== null) {
          summary[cat] = Object.keys(val);
        } else {
          summary[cat] = val;
        }
      }
      res.json({ ok: true, categories: summary, raw: settings });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // API : liste des mods d'un serveur
  app.get('/nitrado/api/mods/:id', requireAdmin, async (req, res) => {
    try {
      const mods = await nitrado.getMods(req.params.id);
      res.json({ ok: true, mods });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // API : ajouter un mod (tous ou sélection)
  app.post('/nitrado/api/mods/add-all', requireAdmin, async (req, res) => {
    try {
      const { modId } = req.body;
      if (!modId) return res.json({ ok: false, error: 'modId manquant' });
      let ids = req.body.serviceIds;
      if (!ids || !ids.length) {
        const services = await nitrado.getServices();
        ids = services.map(s => s.id);
      }
      const results = await nitrado.addModToAll(ids, modId.trim());
      res.json({ ok: true, results });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // API : supprimer un mod (tous ou sélection)
  app.post('/nitrado/api/mods/remove-all', requireAdmin, async (req, res) => {
    try {
      const { modId } = req.body;
      if (!modId) return res.json({ ok: false, error: 'modId manquant' });
      let ids = req.body.serviceIds;
      if (!ids || !ids.length) {
        const services = await nitrado.getServices();
        ids = services.map(s => s.id);
      }
      const results = await nitrado.removeModFromAll(ids, modId.trim());
      res.json({ ok: true, results });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // API : ajouter un mod à un seul serveur
  app.post('/nitrado/api/mods/add/:id', requireAdmin, async (req, res) => {
    try {
      const { modId } = req.body;
      if (!modId) return res.json({ ok: false, error: 'modId manquant' });
      await nitrado.addMod(req.params.id, modId.trim());
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // API : supprimer un mod d'un seul serveur
  app.post('/nitrado/api/mods/remove/:id', requireAdmin, async (req, res) => {
    try {
      const { modId } = req.body;
      if (!modId) return res.json({ ok: false, error: 'modId manquant' });
      await nitrado.removeMod(req.params.id, modId.trim());
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // API : paramètres d'un serveur
  app.get('/nitrado/api/settings/:id', requireAdmin, async (req, res) => {
    try {
      const settings = await nitrado.getSettings(req.params.id);
      res.json({ ok: true, settings });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // API : modifier un paramètre (tous ou sélection)
  app.post('/nitrado/api/settings/update-all', requireAdmin, async (req, res) => {
    try {
      const { category, key, value } = req.body;
      if (!key || value === undefined) return res.json({ ok: false, error: 'Paramètres manquants' });
      let ids = req.body.serviceIds;
      if (!ids || !ids.length) {
        const services = await nitrado.getServices();
        ids = services.map(s => s.id);
      }
      // category est passé en hint — la catégorie réelle est détectée automatiquement si le hint est faux
      const results = await nitrado.updateSettingOnAll(ids, key, value, category || null);
      const detectedCats = results.filter(r => r.ok).map(r => r.category).filter(Boolean);
      res.json({ ok: true, results, detectedCategories: [...new Set(detectedCats)] });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // API : modifier un paramètre sur un serveur
  app.post('/nitrado/api/settings/update/:id', requireAdmin, async (req, res) => {
    try {
      const { category, key, value } = req.body;
      if (!key || value === undefined) return res.json({ ok: false, error: 'Paramètres manquants' });
      await nitrado.smartUpdateSetting(req.params.id, key, value, category || null);
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ── Éditeur INI direct ───────────────────────────────────────────────────────

  // Lit un fichier INI sur un serveur (pour debug)
  app.get('/nitrado/api/ini/read', requireAdmin, async (req, res) => {
    try {
      const { serviceId, file } = req.query;
      if (!serviceId || !file) return res.json({ ok: false, error: 'serviceId et file requis' });
      const filePath = nitrado.ARK_PATHS[file] || file;
      const content = await nitrado.readFile(serviceId, filePath);
      res.json({ ok: true, content, filePath });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // Test mkdir pas à pas — affiche la vraie réponse Nitrado pour chaque niveau
  app.get('/nitrado/api/ini/test-mkdir', requireAdmin, async (req, res) => {
    try {
      const { serviceId, path: testPath } = req.query;
      if (!serviceId) return res.json({ ok: false, error: 'serviceId requis' });
      const fullPath = testPath || '/ShooterGame/Saved/Config/WindowsServer';
      const result = await nitrado.mkdirRecursive(serviceId, fullPath);
      res.json({ ok: result.allOk, path: fullPath, results: result.results });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // Découvre le répertoire config ARK SA sur un serveur (version verbose pour diagnostic)
  app.get('/nitrado/api/ini/discover', requireAdmin, async (req, res) => {
    try {
      const { serviceId } = req.query;
      if (!serviceId) return res.json({ ok: false, error: 'serviceId requis' });
      const result = await nitrado.discoverConfigDirVerbose(serviceId);
      if (result.found) {
        res.json({ ok: true, dir: result.found, entries: result.entries || [], attempts: result.attempts, candidates: nitrado.CONFIG_PATH_CANDIDATES });
      } else {
        res.json({ ok: false, error: 'Aucun répertoire config trouvé', attempts: result.attempts, rootEntries: result.rootEntries || [], rootError: result.rootError, candidates: nitrado.CONFIG_PATH_CANDIDATES });
      }
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // Liste les fichiers d'un répertoire Nitrado (diagnostic)
  app.get('/nitrado/api/ini/list', requireAdmin, async (req, res) => {
    try {
      const { serviceId, dir } = req.query;
      if (!serviceId) return res.json({ ok: false, error: 'serviceId requis' });
      const entries = await nitrado.listFiles(serviceId, dir || '/');
      res.json({ ok: true, entries, dir: dir || '/' });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // Diagnostic download : tente de télécharger Game.ini depuis plusieurs chemins possibles
  app.get('/nitrado/api/debug/find-gameini', requireAdmin, async (req, res) => {
    try {
      const { serviceId } = req.query;
      if (!serviceId) return res.json({ ok: false, error: 'serviceId requis' });
      const axios = require('axios');
      const tok = nitrado.getToken();
      const candidatePaths = [
        '/ShooterGame/Saved/Config/WindowsServer/Game.ini',
        '/ShooterGame/Saved/Config/LinuxServer/Game.ini',
        '/ShooterGame/Saved/Config/WinServer/Game.ini',
        '/ShooterGame/Saved/Config/WindowsNoEditor/Game.ini',
        '/ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini',
        '/Game.ini',
        '/Config/Game.ini',
      ];
      const results = [];
      for (const filePath of candidatePaths) {
        try {
          const r = await axios.get(
            `https://api.nitrado.net/services/${serviceId}/gameservers/file_server/download`,
            { params: { file: filePath }, headers: { Authorization: `Bearer ${tok}` }, timeout: 10000, responseType: 'text' }
          );
          results.push({ path: filePath, status: 'found', httpStatus: r.status, size: r.data?.length, preview: String(r.data).slice(0, 200) });
        } catch (e) {
          results.push({ path: filePath, status: 'error', httpStatus: e.response?.status, error: e.response?.data ? JSON.stringify(e.response.data) : e.message });
        }
      }
      res.json({ ok: true, results });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // Diagnostic mkdir : tente de créer WindowsServer à différents endroits
  app.get('/nitrado/api/debug/test-mkdir-paths', requireAdmin, async (req, res) => {
    try {
      const { serviceId } = req.query;
      if (!serviceId) return res.json({ ok: false, error: 'serviceId requis' });
      const axios = require('axios');
      const tok = nitrado.getToken();
      const parentCandidates = [
        '/ShooterGame/Saved/Config',
        '/arksa/ShooterGame/Saved/Config',
        '/games/ni9697515_2/ftproot/arksa/ShooterGame/Saved/Config',
      ];
      const results = [];
      for (const parent of parentCandidates) {
        try {
          const r = await axios.post(
            `https://api.nitrado.net/services/${serviceId}/gameservers/file_server/mkdir`,
            { path: parent, name: 'TestDir_DELETE_ME' },
            { headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, timeout: 10000 }
          );
          results.push({ parent, status: 'mkdir_ok', httpStatus: r.status, body: r.data });
        } catch (e) {
          results.push({ parent, status: 'mkdir_error', httpStatus: e.response?.status, error: e.response?.data ? JSON.stringify(e.response.data) : e.message });
        }
      }
      res.json({ ok: true, results });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // Test upload étendu : teste TOUS les formats possibles + upload vers racine FTP
  app.get('/nitrado/api/debug/test-upload', requireAdmin, async (req, res) => {
    try {
      const { serviceId } = req.query;
      if (!serviceId) return res.json({ ok: false, error: 'serviceId requis' });
      const axios = require('axios');
      const FormData = require('form-data');
      const tok = nitrado.getToken();

      // Découvre le basePath et gameDir depuis les entrées racine
      const rootEntries = await nitrado.listFiles(serviceId, '/').catch(() => []);
      let basePath = null;
      let gameDir = null;
      for (const e of rootEntries) {
        if (e.path && e.name) {
          const idx = e.path.lastIndexOf('/' + e.name);
          if (idx >= 0) { basePath = e.path.slice(0, idx) || '/'; }
          if (e.type === 'dir') gameDir = e.name;
        }
      }

      const dummyContent = '; test_upload_arki\n';
      const testFilename = 'test_arki_DELETE_ME.txt';

      // ── ÉTAPE 1 : mkdir explicite de Config/WindowsServer (format prouvé) ─────
      let mkdirWsResult = null;
      if (basePath && gameDir) {
        const configSysPath = `${basePath}/${gameDir}/ShooterGame/Saved/Config`;
        try {
          const r = await axios.post(
            `https://api.nitrado.net/services/${serviceId}/gameservers/file_server/mkdir`,
            { path: configSysPath, name: 'WindowsServer' },
            { headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, timeout: 10000 }
          );
          mkdirWsResult = { ok: true, parent: configSysPath, status: r.status, body: r.data };
        } catch (e) {
          mkdirWsResult = { ok: false, parent: configSysPath, status: e.response?.status, error: e.response?.data ? JSON.stringify(e.response.data) : e.message };
        }
        await new Promise(r => setTimeout(r, 1500)); // Délai pour laisser le FS se mettre à jour
      }

      // ── ÉTAPE 2 : Tests upload — 9 combinaisons de formats ───────────────────
      // Format A : path=dir (répertoire seulement), filename dans multipart
      // Format B : path=fullpath (chemin complet avec filename), pas de filename dans multipart
      const candidates = [];

      if (basePath && gameDir) {
        const sysBase = `${basePath}/${gameDir}`;
        const ftpBase = `/${gameDir}`;

        candidates.push(
          // ── Tests vers la RACINE FTP (vérification API upload fonctionnelle) ──
          { label: 'ROOT-dir-sys',   path: basePath,           filename: testFilename, format: 'dir' },
          { label: 'ROOT-dir-ftp',   path: '/',                filename: testFilename, format: 'dir' },

          // ── Tests vers arksa/ (dossier connu existant) ───────────────────────
          { label: 'GAME-dir-sys',   path: `${sysBase}`,            filename: testFilename, format: 'dir' },
          { label: 'GAME-dir-ftp',   path: ftpBase,                 filename: testFilename, format: 'dir' },
          // Sans slash initial (ex: "arksa/ShooterGame/...") — certaines API ignorent le slash
          { label: 'GAME-dir-noslash', path: gameDir,               filename: testFilename, format: 'dir' },

          // ── Tests vers Config/ ────────────────────────────────────────────────
          { label: 'CFG-dir-sys',    path: `${sysBase}/ShooterGame/Saved/Config`,                  filename: testFilename, format: 'dir' },
          { label: 'CFG-dir-ftp',    path: `${ftpBase}/ShooterGame/Saved/Config`,                  filename: testFilename, format: 'dir' },

          // ── Tests vers WindowsServer/ (après mkdir) ────────────────────────
          { label: 'WS-dir-sys',     path: `${sysBase}/ShooterGame/Saved/Config/WindowsServer`,                        filename: testFilename, format: 'dir' },
          { label: 'WS-dir-ftp',     path: `${ftpBase}/ShooterGame/Saved/Config/WindowsServer`,                        filename: testFilename, format: 'dir' },
          // Sans slash initial
          { label: 'WS-dir-noslash', path: `${gameDir}/ShooterGame/Saved/Config/WindowsServer`,                        filename: testFilename, format: 'dir' },
          { label: 'WS-full-sys',    path: `${sysBase}/ShooterGame/Saved/Config/WindowsServer/${testFilename}`,         filename: null,         format: 'full' },
          { label: 'WS-full-ftp',    path: `${ftpBase}/ShooterGame/Saved/Config/WindowsServer/${testFilename}`,         filename: null,         format: 'full' },
          { label: 'WS-full-noslash',path: `${gameDir}/ShooterGame/Saved/Config/WindowsServer/${testFilename}`,         filename: null,         format: 'full' },
        );
      } else {
        // Fallback si pas de basePath
        candidates.push(
          { label: 'ROOT-dir', path: '/', filename: testFilename, format: 'dir' },
          { label: 'WS-dir',   path: '/ShooterGame/Saved/Config/WindowsServer', filename: testFilename, format: 'dir' },
        );
      }

      const results = [];
      for (const c of candidates) {
        const form = new FormData();
        form.append('path', c.path);
        if (c.filename) {
          form.append('file', Buffer.from(dummyContent, 'utf8'), { filename: c.filename });
        } else {
          form.append('file', Buffer.from(dummyContent, 'utf8'));
        }
        try {
          const r = await axios.post(
            `https://api.nitrado.net/services/${serviceId}/gameservers/file_server/upload`,
            form,
            { headers: { Authorization: `Bearer ${tok}`, ...form.getHeaders() }, timeout: 15000 }
          );
          results.push({ label: c.label, format: c.format, path: c.path, status: 'ok', httpStatus: r.status, body: r.data });
        } catch (e) {
          const errBody = e.response?.data;
          results.push({ label: c.label, format: c.format, path: c.path, status: 'error', httpStatus: e.response?.status, error: errBody ? JSON.stringify(errBody) : e.message });
        }
      }

      const firstOk = results.find(r => r.status === 'ok');
      res.json({ ok: true, basePath, gameDir, mkdirWsResult, firstOk: firstOk || null, results });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // Debug brut : retourne la réponse RAW de l'API Nitrado file_server/list
  // Permet de voir si le problème vient du paramètre ou du parsing de la réponse
  app.get('/nitrado/api/debug/raw-list', requireAdmin, async (req, res) => {
    try {
      const { serviceId, dir } = req.query;
      if (!serviceId) return res.json({ ok: false, error: 'serviceId requis' });
      const axios = require('axios');
      const tok = nitrado.getToken();
      const doRawList = async (path) => {
        try {
          const r = await axios.get(`https://api.nitrado.net/services/${serviceId}/gameservers/file_server/list`,
            { params: { path }, headers: { Authorization: `Bearer ${tok}` }, timeout: 15000 });
          return { httpStatus: r.status, body: r.data };
        } catch (e) {
          return { httpStatus: e.response?.status, body: e.response?.data, error: e.message };
        }
      };
      const targetDir = dir || '/';
      // Test 1 : chemin demandé avec param "path"
      const withPathParam = await doRawList(targetDir);
      // Test 2 : si on liste la racine, aussi tester le chemin COMPLET de la première entrée
      let withFullEntryPath = null;
      if (targetDir === '/' && withPathParam?.body?.data?.entries?.length > 0) {
        const firstEntry = withPathParam.body.data.entries.find(e => e.type === 'dir');
        if (firstEntry?.path) {
          withFullEntryPath = await doRawList(firstEntry.path);
          withFullEntryPath._testedPath = firstEntry.path;
        }
      }
      // Test 3 : le même chemin avec param "dir" (pour comparaison)
      let withDirParam = null;
      try {
        const r = await axios.get(`https://api.nitrado.net/services/${serviceId}/gameservers/file_server/list`,
          { params: { dir: targetDir }, headers: { Authorization: `Bearer ${tok}` }, timeout: 15000 });
        withDirParam = { httpStatus: r.status, body: r.data };
      } catch (e) {
        withDirParam = { httpStatus: e.response?.status, body: e.response?.data, error: e.message };
      }
      res.json({ ok: true, dir: targetDir, withPathParam, withDirParam, withFullEntryPath });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // Debug : liste les permissions (grants/scopes) du token NITRADO_TOKEN actuel
  // Utile pour diagnostiquer "Permission denied" persistant même serveur stoppé
  // → vérifie que le token a le scope "Fileserver" (écriture fichiers INI)
  app.get('/nitrado/api/debug/check-token-scopes', requireAdmin, async (req, res) => {
    try {
      const result = await nitrado.checkTokenScopes();
      if (!result.ok) {
        return res.json({
          ok: false,
          error: result.error,
          httpStatus: result.httpStatus,
          hint: 'Vérifiez que NITRADO_TOKEN est configuré et valide sur panel.nitrado.net → API-Tokens.',
        });
      }

      const hints = [];
      if (!result.hasFileserver) {
        hints.push('⚠️  Scope "Fileserver" ABSENT — le token ne peut pas écrire de fichiers .ini. Régénérez le token avec tous les droits sur panel.nitrado.net → API-Tokens, puis mettez à jour NITRADO_TOKEN dans les secrets Railway.');
      } else {
        hints.push('✅ Scope "Fileserver" présent — le token a bien accès en écriture aux fichiers.');
      }
      if (!result.hasGameserver) {
        hints.push('⚠️  Scope "Gameserver" ABSENT — le token ne peut pas contrôler les serveurs (stop/start/restart).');
      } else {
        hints.push('✅ Scope "Gameserver" présent.');
      }
      if (result.hasFileserver && result.hasGameserver) {
        hints.push('ℹ️  Si "Permission denied" persiste malgré les scopes présents, le problème vient probablement du chemin FTP (découverte du répertoire config) ou du serveur encore en train de s\'arrêter.');
      }

      res.json({
        ok: true,
        grants: result.grants,
        hasFileserver: result.hasFileserver,
        hasGameserver: result.hasGameserver,
        tokenExpiry: result.tokenInfo?.expires_at || result.tokenInfo?.expiry || null,
        serviceCount: Array.isArray(result.services) ? result.services.length : null,
        hints,
      });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // Scanne les répertoires parents pour confirmer si le chemin config existe réellement
  // Découvre d'abord le dossier racine du jeu (ex: /arksa) puis scanne en profondeur
  // Vide le cache de découverte de répertoire config (force re-détection)
  app.post('/nitrado/api/ini/clear-cache', requireAdmin, async (req, res) => {
    const { serviceId } = req.body;
    nitrado.clearConfigDirCache(serviceId || null);
    res.json({ ok: true, msg: serviceId ? `Cache vidé pour ${serviceId}` : 'Cache global vidé' });
  });

  app.get('/nitrado/api/ini/scan-parents', requireAdmin, async (req, res) => {
    try {
      const { serviceId } = req.query;
      if (!serviceId) return res.json({ ok: false, error: 'serviceId requis' });

      const scanResults = {};
      // Liste la racine pour obtenir le basePath système (ex: /games/ni9697515_2/ftproot)
      const rootEntries = await nitrado.listFiles(serviceId, '/').catch(() => []);
      scanResults['/'] = { ok: true, count: rootEntries.length, entries: rootEntries.map(e => ({ name: e.name, type: e.type })) };

      // Extrait le basePath depuis les .path des entrées
      let basePath = null;
      for (const e of rootEntries) {
        if (e.path && e.name) {
          const idx = e.path.lastIndexOf('/' + e.name);
          if (idx >= 0) { basePath = e.path.slice(0, idx) || '/'; break; }
        }
      }

      const gameDirs = rootEntries.filter(e => e.type === 'dir');
      let gameRoot = gameDirs.map(d => d.name);

      // Construit les chemins SYSTÈME COMPLETS pour la navigation (pas des chemins relatifs)
      const pathsToScan = gameDirs.length > 0 && basePath
        ? gameDirs.flatMap(d => {
            const base = d.path || `${basePath}/${d.name}`;
            return [
              base,
              `${base}/ShooterGame`,
              `${base}/ShooterGame/Saved`,
              `${base}/ShooterGame/Saved/Config`,
              `${base}/ShooterGame/Saved/Config/WindowsServer`,
            ];
          })
        : [];

      for (const p of pathsToScan) {
        try {
          const entries = await nitrado.listFiles(serviceId, p);
          // Détecte si le résultat est un faux-positif (même que root → navigation ignorée)
          const isFake = entries.length === rootEntries.length &&
            entries.every((e, i) => rootEntries[i] && e.name === rootEntries[i].name);
          scanResults[p] = { ok: true, count: entries.length, isFake, entries: entries.map(e => ({ name: e.name, type: e.type })) };
        } catch (e) {
          const status = e.response?.status;
          const msg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
          scanResults[p] = { ok: false, status, error: msg };
        }
      }
      res.json({ ok: true, scan: scanResults, gameRoot, basePath });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // Met à jour une clé dans un .ini sur tous les serveurs sélectionnés (méthode directe)
  app.post('/nitrado/api/ini/update-all', requireAdmin, async (req, res) => {
    try {
      const { key, value } = req.body;
      if (!key || value === undefined) return res.json({ ok: false, error: 'key et value requis' });
      const normalizedValue = String(value).replace(',', '.');

      // Vérifie que la clé est mappée
      const map = nitrado.INI_KEY_MAP[key];
      if (!map) {
        return res.json({ ok: false, error: `Clé "${key}" non supportée en mode INI direct. Clés disponibles : ${Object.keys(nitrado.INI_KEY_MAP).join(', ')}` });
      }

      let ids = req.body.serviceIds;
      if (!ids || !ids.length) {
        const services = await nitrado.getServices();
        ids = services.map(s => s.id);
      }

      const results = await nitrado.updateIniKeyOnAll(ids, key, normalizedValue);
      const okCount = results.filter(r => r.ok).length;
      const failCount = results.length - okCount;
      console.log(`[INI update-all] ${key}=${normalizedValue} — ${okCount} OK, ${failCount} erreurs`);
      res.json({ ok: true, results, file: nitrado.ARK_PATHS[map.file], section: map.section });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // Sonde d'écriture : valide que le token a le scope Fileserver sans modifier aucun contenu.
  // POST { serviceId } → { ok, phase, details[] }
  // Résultat attendu si le token est correctement configuré (scopes Fileserver + Gameserver) :
  //   { ok: true, phase: "read_ok" | "write_ok", details: [...] }
  // Si "Permission denied" → token manque le scope Fileserver.
  app.post('/nitrado/api/ini/probe-write', requireAdmin, async (req, res) => {
    try {
      const { serviceId } = req.body;
      if (!serviceId) return res.json({ ok: false, error: 'serviceId requis' });

      const details = [];
      const log = (msg) => { console.log('[INI probe-write]', msg); details.push(msg); };

      // 1. Découverte du répertoire config
      log(`Découverte du répertoire config pour ${serviceId}…`);
      let configDir = null;
      try {
        configDir = await nitrado.discoverConfigDir(serviceId);
        if (configDir) {
          log(`✅ Répertoire config trouvé : ${configDir}`);
        } else {
          log('❌ Répertoire config introuvable.');
          return res.json({ ok: false, phase: 'discover_failed', details });
        }
      } catch (e) {
        log(`❌ Erreur découverte : ${e.message}`);
        return res.json({ ok: false, phase: 'discover_error', error: e.message, details });
      }

      // 2. Lecture d'un fichier INI existant (GameUserSettings.ini en premier)
      const candidateFiles = ['GameUserSettings.ini', 'Game.ini'];
      let filePath = null;
      let originalContent = null;
      for (const fname of candidateFiles) {
        const fp = `${configDir}/${fname}`;
        try {
          originalContent = await nitrado.readFile(serviceId, fp);
          filePath = fp;
          log(`✅ Lecture OK : ${fname} (${originalContent.length} octets)`);
          break;
        } catch (e) {
          log(`⚠️ Lecture ${fname} échouée : ${e.message}`);
        }
      }

      if (!filePath || originalContent === null) {
        log('❌ Aucun fichier INI lisible trouvé — impossible de tester l\'écriture.');
        return res.json({ ok: false, phase: 'read_failed', details });
      }

      // 3. Écriture du même contenu (aucun changement réel)
      log(`Test d'écriture sur ${filePath.split('/').pop()} (contenu inchangé)…`);
      const writeResult = await nitrado.writeFileSysFullOnce(serviceId, filePath, originalContent);
      if (writeResult.ok) {
        log(`✅ Écriture OK — le token a bien le scope Fileserver.`);
        return res.json({ ok: true, phase: 'write_ok', filePath, details });
      } else {
        const err = writeResult.error || '';
        if (err.includes('Permission denied') || writeResult.status === 403 || writeResult.status === 401) {
          log(`❌ Écriture refusée (Permission denied) — scope Fileserver absent OU fichier verrouillé par le serveur.`);
          log('  → Si le serveur est en marche, l\'arrêter et réessayer confirme si c\'est un verrou.');
          log('  → Vérifier aussi sur panel.nitrado.net → API-Tokens → scope "Fileserver" activé.');
        } else if (err.includes('Just a moment') || err.includes('DOCTYPE')) {
          log('❌ Réponse Cloudflare — rate-limiting. Réessaie dans quelques minutes.');
        } else {
          log(`❌ Écriture échouée (HTTP ${writeResult.status}) : ${err.slice(0, 120)}`);
        }
        return res.json({ ok: false, phase: 'write_failed', httpStatus: writeResult.status, error: writeResult.error, details });
      }
    } catch (e) {
      console.error('[INI probe-write] Erreur inattendue:', e.message);
      res.json({ ok: false, error: e.message });
    }
  });

  // Retourne le dernier apply-with-restart réussi (telemetry persisté en DB).
  // GET → { ok, last: { at, phase, serviceIds, keys, filesWritten?, elapsedSec?, restartDone } }
  app.get('/nitrado/api/ini/last-apply', requireAdmin, async (req, res) => {
    try {
      const last = await pgStore.getData('nitrado_last_ini_apply', null);
      res.json({ ok: true, last: last || null });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // Applique des paramètres ini avec streaming SSE pour éviter les timeouts longue durée
  // POST { settings: [{key, value}], serviceIds?: [] } → text/event-stream
  app.post('/nitrado/api/ini/apply-with-restart', requireAdmin, async (req, res) => {
    const { settings, serviceIds } = req.body;
    if (!settings || !settings.length) return res.json({ ok: false, error: 'settings[] requis' });

    let ids = serviceIds;
    if (!ids || !ids.length) {
      const services = await nitrado.getServices();
      ids = services.map(s => s.id);
    }

    // SSE streaming pour éviter les timeouts Railway (opération peut durer 2-3 min)
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no'); // désactive le buffering Nginx/Railway
    res.flushHeaders();

    const send = (type, data) => {
      try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch {}
    };
    const log = (msg) => { console.log('[INI apply-restart]', msg); send('log', { msg }); };
    const done = (ok, extra = {}) => { send('done', { ok, ...extra }); res.end(); };

    // Keep-alive ping toutes les 20s pour empêcher Railway de couper la connexion
    const pingInterval = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
    res.on('close', () => clearInterval(pingInterval));

    const editAll = async (label) => {
      let allOk = true;
      const editResults = {};
      for (const { key, value } of settings) {
        const normalized = String(value).replace(',', '.');
        const results = await nitrado.updateIniKeyOnAll(ids, key, normalized);
        editResults[key] = results;
        const ok = results.filter(r => r.ok).length;
        log(`  [${label}] ${key}=${normalized} — ${ok}/${ids.length} OK`);
        results.filter(r => !r.ok).forEach(r => log(`    ❌ Serveur ${r.id}: ${r.error}`));
        if (ok < ids.length) allOk = false;
      }
      return { allOk, editResults };
    };

    try {
      // ── PHASE 1 : Écriture directe (serveur EN MARCHE, 4 formats) ──────────
      // sys-full = chemin système absolu complet → trouve les fichiers ini existants.
      // Si "Permission denied" → ARK verrouille les fichiers → passer en Phase 2.
      log('Phase 1 : Tentative d\'écriture directe (serveur en marche)…');
      const phase1 = await editAll('live');

      if (phase1.allOk) {
        log('✅ Phase 1 réussie — Redémarrage pour appliquer…');
        await Promise.all(ids.map(id => nitrado.restartServer(id).catch(e => log(`  WARN restart ${id}: ${e.message}`))));
        log('Redémarrage lancé.');
        // Telemetry : enregistre le dernier apply réussi pour traçabilité
        await pgStore.setData('nitrado_last_ini_apply', {
          at: new Date().toISOString(), phase: 1, serviceIds: ids,
          keys: settings.map(s => s.key), restartDone: true,
        }).catch(() => {});
        clearInterval(pingInterval);
        return done(true, { editResults: phase1.editResults, restartDone: true, phase: 1 });
      }

      log('Phase 1 échouée (Nitrado bloque les écritures serveur en marche).');
      log('');

      // ── PRÉ-VÉRIFICATION : Scope Fileserver avant d'arrêter les serveurs ─────
      // Si Phase 1 a échoué exclusivement avec "Permission denied", vérifie via l'API
      // de token Nitrado si le scope "Fileserver" est absent. Si oui, on échoue
      // immédiatement SANS arrêter les serveurs (aucun effet de bord).
      log('Vérification scope token Fileserver avant arrêt des serveurs…');
      try {
        const allErrors = Object.values(phase1.editResults)
          .flat()
          .filter(r => !r.ok)
          .map(r => String(r.error || ''));
        const allPermDenied = allErrors.length > 0 && allErrors.every(e => e.includes('Permission denied'));

        if (allPermDenied) {
          // Vérifie les scopes du token sans aucune mutation côté serveur
          const scopeCheck = await nitrado.checkTokenScopes();
          if (scopeCheck.ok && scopeCheck.hasFileserver === false) {
            log('❌ PRÉ-VÉRIFICATION ÉCHOUÉE : le token Nitrado manque le scope "Fileserver".');
            log(`  → Scopes actuels du token : ${(scopeCheck.grants || []).join(', ') || '(aucun)'}`);
            log('  → Sur panel.nitrado.net → API-Tokens → activer le scope "Fileserver".');
            log('  → Aucun serveur n\'a été arrêté.');
            clearInterval(pingInterval);
            return done(false, {
              error: 'Token Nitrado manque le scope Fileserver — aucun serveur arrêté',
              diagnostic: 'missing_fileserver_scope',
              currentGrants: scopeCheck.grants || [],
            });
          }
          if (!scopeCheck.ok) {
            log(`  → Impossible de vérifier le scope (${scopeCheck.error || 'API token indisponible'}) — passage Phase 2.`);
          } else {
            log(`  → Scope Fileserver confirmé (grants: ${(scopeCheck.grants || []).join(', ')}) — passage Phase 2.`);
          }
        }
      } catch (preCheckErr) {
        log(`  ⚠️ Pré-vérification scope ignorée (${preCheckErr.message}) — passage Phase 2.`);
      }

      // ── PHASE 2 : Stop → attendre statut "stopped" → écrire → Start ────────
      // Nitrado bloque les écritures tant que le serveur est "running" ou "restarting".
      // Il faut attendre que le statut passe à "stopped" avant d'écrire.
      // Intervalles de 5s pour éviter le rate-limiting Cloudflare de l'API Nitrado.

      // 2a — Préparation des contenus en mémoire (sans écrire)
      log('Phase 2 : Préparation des fichiers ini en mémoire…');
      const kvPairs = settings.map(({ key, value }) => ({ key, value: String(value).replace(',', '.') }));
      let pendingWrites;
      try {
        const prep = await nitrado.prepareIniWrites(ids, kvPairs);
        pendingWrites = prep.writes;
        // Log des éléments ignorés (clé non mappée, configDir manquant, etc.)
        if (prep.skipped.length > 0) {
          log(`  ⚠️ ${prep.skipped.length} élément(s) ignoré(s) :`);
          prep.skipped.forEach(s => log(`    - ${s.key ? `clé "${s.key}"` : `serveur ${s.serviceId}`}: ${s.reason}`));
        }
        // GARDE-FOU : si aucun fichier à écrire, échec immédiat avec diagnostic
        if (pendingWrites.length === 0) {
          log('❌ Aucun fichier ini à écrire — impossible de continuer.');
          if (prep.skipped.length > 0) {
            log('  Causes identifiées ci-dessus. Vérifier INI_KEY_MAP et la découverte du répertoire config.');
          }
          clearInterval(pingInterval);
          return done(false, { error: 'prepareIniWrites: 0 fichier préparé', skipped: prep.skipped });
        }
        log(`  ${pendingWrites.length} fichier(s) à écrire : ${[...new Set(pendingWrites.map(w => w.filePath.split('/').pop()))].join(', ')}`);
      } catch (e) {
        log(`❌ Erreur préparation: ${e.message}`);
        clearInterval(pingInterval);
        return done(false, { error: e.message });
      }

      // 2b — Arrêt des serveurs
      log(`Phase 2 : Arrêt de ${ids.length} serveur(s)…`);
      await Promise.all(ids.map(id => nitrado.stopServer(id).catch(e => log(`  WARN stop ${id}: ${e.message}`))));

      // 2c — Attente du statut "stopped" pour chaque serveur (max 3 min, poll 5s)
      const STOP_TIMEOUT  = 180000; // 3 minutes max pour l'arrêt
      const STOP_POLL     = 5000;   // 5s entre chaque vérification statut
      const stopStart = Date.now();
      const stoppedIds = new Set();

      log('Phase 2 : Attente arrêt complet…');
      while (stoppedIds.size < ids.length && Date.now() - stopStart < STOP_TIMEOUT) {
        await new Promise(r => setTimeout(r, STOP_POLL));
        const elapsed = Math.round((Date.now() - stopStart) / 1000);
        for (const id of ids) {
          if (stoppedIds.has(id)) continue;
          try {
            const d = await nitrado.getServerDetails(id);
            const status = d?.status || d?.gameserver?.status || '?';
            log(`  [${elapsed}s] Serveur ${id} : ${status}`);
            if (['stopped', 'offline', 'halted'].includes(String(status).toLowerCase())) {
              stoppedIds.add(id);
              log(`  ✅ Serveur ${id} arrêté.`);
            }
          } catch (e) { log(`  WARN statut ${id}: ${e.message}`); }
        }
      }

      if (stoppedIds.size < ids.length) {
        log(`⚠️ ${ids.length - stoppedIds.size} serveur(s) pas encore stoppé(s) après ${Math.round(STOP_TIMEOUT/1000)}s — tentative d'écriture quand même…`);
      }

      // 2d — Écriture (serveur stoppé, fichiers déverrouillés, 3 tentatives × 5s)
      log('Phase 2 : Écriture des fichiers ini…');
      const writeResults = pendingWrites.map(w => ({ filePath: w.filePath, serviceId: w.serviceId, ok: false, error: null, attempt: 0 }));
      const remaining = new Set(pendingWrites.map((_, i) => i));

      for (let attempt = 1; attempt <= 3 && remaining.size > 0; attempt++) {
        if (attempt > 1) await new Promise(r => setTimeout(r, 5000));
        log(`  Tentative d'écriture ${attempt}/3…`);
        const results = await Promise.all([...remaining].map(async idx => {
          const { serviceId, filePath, content } = pendingWrites[idx];
          writeResults[idx].attempt = attempt;
          const r = await nitrado.writeFileSysFullOnce(serviceId, filePath, content);
          return { idx, ...r };
        }));
        for (const a of results) {
          if (a.ok) {
            remaining.delete(a.idx);
            writeResults[a.idx].ok = true;
            log(`    ✅ ${pendingWrites[a.idx].filePath.split('/').pop()} (${pendingWrites[a.idx].serviceId})`);
          } else {
            writeResults[a.idx].error = a.error;
            log(`    ❌ ${pendingWrites[a.idx].filePath.split('/').pop()} (${pendingWrites[a.idx].serviceId}): ${a.error?.slice(0, 80)}`);
          }
        }
      }

      // 2e — Redémarrage des serveurs (qu'il y ait eu succès ou non)
      log('Phase 2 : Redémarrage…');
      await Promise.all(ids.map(id => nitrado.startServer(id).catch(e => log(`  WARN start ${id}: ${e.message}`))));
      log('Redémarrage lancé.');

      const phase2Ok = remaining.size === 0;
      const elapsed = Math.round((Date.now() - stopStart) / 1000);

      if (phase2Ok) {
        log(`✅ Phase 2 réussie (${elapsed}s). Les changements seront actifs au prochain démarrage.`);
        // Telemetry : enregistre le dernier apply réussi pour traçabilité
        await pgStore.setData('nitrado_last_ini_apply', {
          at: new Date().toISOString(), phase: 2, serviceIds: ids, elapsedSec: elapsed,
          keys: settings.map(s => s.key), filesWritten: writeResults.map(r => r.filePath.split('/').pop()),
          restartDone: true,
        }).catch(() => {});
        clearInterval(pingInterval);
        return done(true, { writeResults, restartDone: true, phase: 2, elapsedSec: elapsed });
      } else {
        log(`❌ Phase 2 échouée après ${elapsed}s.`);
        log('');
        log('Erreurs détaillées :');
        writeResults.filter(r => !r.ok).forEach(r => log(`  - ${r.filePath.split('/').pop()} (${r.serviceId}): ${r.error?.slice(0, 100)}`));
        log('');
        const lastErr = writeResults.find(r => !r.ok)?.error || '';
        if (lastErr.includes('Permission denied')) {
          log('DIAGNOSTIC : "Permission denied" persistant même serveur stoppé.');
          log('  → Le token Nitrado n\'a probablement pas le scope "gameserver_write".');
          log('  → Sur panel.nitrado.net → API-Tokens → vérifie que le token a accès "Fileserver".');
          log('  → Si OK, essaie de regénérer un token avec tous les droits activés.');
        } else if (lastErr.includes('Just a moment') || lastErr.includes('DOCTYPE')) {
          log('DIAGNOSTIC : Rate-limiting Cloudflare (trop de requêtes API).');
          log('  → Relance l\'opération dans quelques minutes.');
        }
        clearInterval(pingInterval);
        done(false, { writeResults, phase: 2, elapsedSec: elapsed });
      }

    } catch (e) {
      log(`ERREUR: ${e.message}`);
      clearInterval(pingInterval);
      done(false, { error: e.message });
    }
  });

  // ── RCON temps réel ──────────────────────────────────────────────────────────

  // Diagnostic : lit une valeur, l'écrit, la relit pour confirmer le changement réel
  app.post('/nitrado/api/settings/diagnose', requireAdmin, async (req, res) => {
    try {
      const { serviceId, key, value } = req.body;
      if (!serviceId || !key || value === undefined) return res.json({ ok: false, error: 'serviceId, key, value requis' });

      // 1. Lire la valeur actuelle
      const settingsBefore = await nitrado.getSettings(serviceId);
      let foundCat = null, valueBefore = null;
      for (const [cat, catVal] of Object.entries(settingsBefore)) {
        if (typeof catVal === 'object' && catVal && key in catVal) {
          foundCat = cat;
          valueBefore = catVal[key]?.value ?? catVal[key];
          break;
        }
      }

      if (!foundCat) {
        // Lister toutes les clés disponibles pour aider au debug
        const allKeys = [];
        for (const [cat, catVal] of Object.entries(settingsBefore)) {
          if (typeof catVal === 'object' && catVal) Object.keys(catVal).forEach(k => allKeys.push(`${cat}/${k}`));
        }
        return res.json({ ok: false, error: `Clé "${key}" introuvable`, availableKeys: allKeys });
      }

      // 2. Appliquer la valeur (avec normalisation virgule→point)
      const normalizedValue = String(value).replace(',', '.');
      await nitrado.updateSettings(serviceId, { [foundCat]: { [key]: normalizedValue } });

      // 3. Relire après 1s
      await new Promise(r => setTimeout(r, 1000));
      const settingsAfter = await nitrado.getSettings(serviceId);
      const valueAfter = String(settingsAfter[foundCat]?.[key]?.value ?? settingsAfter[foundCat]?.[key] ?? '');
      const valueBeforeNorm = String(valueBefore).replace(',', '.');

      // Vrai changement : la valeur après est différente de ce qu'il y avait avant
      const apiChanged = valueAfter !== String(valueBefore) && valueAfter !== valueBeforeNorm;
      // OU la valeur après correspond à ce qu'on a demandé (et c'était différent d'avant)
      const appliedCorrectly = (valueAfter === normalizedValue || valueAfter === value) && normalizedValue !== valueBeforeNorm;

      console.log(`[Nitrado diagnose] ${serviceId} ${foundCat}/${key}: "${valueBefore}" → "${valueAfter}" (demandé: "${normalizedValue}", changé: ${apiChanged}, appliqué: ${appliedCorrectly})`);
      res.json({ ok: true, category: foundCat, key, valueBefore, valueAfter, valueRequested: normalizedValue, changed: appliedCorrectly, apiChanged });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // Envoyer une commande RCON à un seul serveur
  app.post('/nitrado/api/rcon/:id', requireAdmin, async (req, res) => {
    try {
      const { command } = req.body;
      if (!command) return res.json({ ok: false, error: 'Commande manquante' });
      const data = await nitrado.sendRcon(req.params.id, command.trim());
      res.json({ ok: true, response: data?.data?.message || '' });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // Config RCON direct par serveur
  async function getRconDirectCfg() {
    const raw = await pgStore.getData('nitrado_rcon_direct', null);
    if (!raw) return {};
    return (typeof raw === 'object' && !Array.isArray(raw)) ? raw : JSON.parse(raw);
  }
  async function saveRconDirectCfg(cfg) {
    await pgStore.setData('nitrado_rcon_direct', cfg);
  }

  app.get('/nitrado/api/rcon-direct-cfg', requireAdmin, async (req, res) => {
    try { res.json({ ok: true, cfg: await getRconDirectCfg() }); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.post('/nitrado/api/rcon-direct-cfg', requireAdmin, async (req, res) => {
    try {
      const { serviceId, ip, rconPort, rconPassword } = req.body;
      if (!serviceId) return res.json({ ok: false, error: 'serviceId manquant' });
      const cfg = await getRconDirectCfg();
      if (ip) {
        cfg[serviceId] = { ip: ip.trim(), rconPort: parseInt(rconPort) || 11190, rconPassword: rconPassword || '' };
      } else {
        delete cfg[serviceId];
      }
      await saveRconDirectCfg(cfg);
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // Auto-détection IP + port RCON depuis la config Nitrado
  app.get('/nitrado/api/rcon-autodetect/:id', requireAdmin, async (req, res) => {
    try {
      const serviceId = req.params.id;
      // IP depuis les détails du serveur
      const detail = await nitrado.getServerDetails(serviceId);
      const ip = detail?.ip || null;
      // Port RCON depuis GameUserSettings.ini
      let rconPort = null;
      try {
        const content = await nitrado.readFile(serviceId, 'GameUserSettings.ini');
        const match = content.match(/RCONPort\s*=\s*(\d+)/i);
        if (match) rconPort = parseInt(match[1]);
      } catch {}
      res.json({ ok: true, ip, rconPort });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  app.post('/nitrado/api/rcon-direct-test', requireAdmin, async (req, res) => {
    try {
      const { ip, rconPort, rconPassword } = req.body;
      if (!ip || !rconPort) return res.json({ ok: false, error: 'IP et port obligatoires' });
      const response = await nitrado.sendRconDirect(ip, parseInt(rconPort), rconPassword || '', 'listplayers');
      res.json({ ok: true, response: response || '(pas de réponse — normal pour ARK SA)' });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // Envoyer une commande RCON à plusieurs serveurs (sélection ou tous)
  app.post('/nitrado/api/rcon-many', requireAdmin, async (req, res) => {
    try {
      const { command } = req.body;
      if (!command) return res.json({ ok: false, error: 'Commande manquante' });
      let ids = req.body.serviceIds;
      if (!ids || !ids.length) {
        const services = await nitrado.getServices();
        ids = services.map(s => s.id);
      }
      const directCfg = await getRconDirectCfg();
      const results = await nitrado.sendRconToMany(ids, command.trim(), directCfg);
      res.json({ ok: true, results });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ── Commandes RCON programmées ────────────────────────────────────────────────

  const cron = require('node-cron');
  const scheduledJobs = {};   // id → cron.Task

  async function getScheduledCmds() {
    const raw = await pgStore.getData('nitrado_scheduled_cmds', null);
    if (!raw) return [];
    return Array.isArray(raw) ? raw : JSON.parse(raw);
  }
  async function saveScheduledCmds(cmds) {
    await pgStore.setData('nitrado_scheduled_cmds', cmds);
  }

  function startJob(cmd) {
    if (scheduledJobs[cmd.id]) { scheduledJobs[cmd.id].stop(); delete scheduledJobs[cmd.id]; }
    if (!cmd.active) return;
    if (!cron.validate(cmd.schedule)) return;
    scheduledJobs[cmd.id] = cron.schedule(cmd.schedule, async () => {
      try {
        const services = await nitrado.getServices();
        const ids = cmd.serverIds && cmd.serverIds.length
          ? cmd.serverIds
          : services.map(s => s.id);
        await nitrado.sendRconToMany(ids, cmd.command);
        // Enregistrer la dernière exécution
        const cmds = await getScheduledCmds();
        const idx = cmds.findIndex(c => c.id === cmd.id);
        if (idx >= 0) { cmds[idx].lastRun = new Date().toISOString(); await saveScheduledCmds(cmds); }
      } catch {}
    }, { timezone: 'Europe/Paris' });
  }

  // Initialiser les jobs au démarrage
  getScheduledCmds().then(cmds => cmds.forEach(startJob)).catch(() => {});

  // Lister les commandes programmées
  app.get('/nitrado/api/scheduled', requireAdmin, async (req, res) => {
    try {
      res.json({ ok: true, cmds: await getScheduledCmds() });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // Ajouter une commande programmée
  app.post('/nitrado/api/scheduled', requireAdmin, async (req, res) => {
    try {
      const { name, command, schedule, serverIds } = req.body;
      if (!name || !command || !schedule) return res.json({ ok: false, error: 'Champs manquants' });
      if (!cron.validate(schedule)) return res.json({ ok: false, error: 'Expression cron invalide' });
      const cmds = await getScheduledCmds();
      const newCmd = {
        id: Date.now().toString(),
        name: name.trim(),
        command: command.trim(),
        schedule,
        serverIds: serverIds || [],
        active: true,
        lastRun: null,
        createdAt: new Date().toISOString(),
      };
      cmds.push(newCmd);
      await saveScheduledCmds(cmds);
      startJob(newCmd);
      res.json({ ok: true, cmd: newCmd });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // Activer / désactiver une commande programmée
  app.patch('/nitrado/api/scheduled/:id/toggle', requireAdmin, async (req, res) => {
    try {
      const cmds = await getScheduledCmds();
      const cmd = cmds.find(c => c.id === req.params.id);
      if (!cmd) return res.json({ ok: false, error: 'Commande introuvable' });
      cmd.active = !cmd.active;
      await saveScheduledCmds(cmds);
      startJob(cmd);
      res.json({ ok: true, active: cmd.active });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // Supprimer une commande programmée
  app.delete('/nitrado/api/scheduled/:id', requireAdmin, async (req, res) => {
    try {
      let cmds = await getScheduledCmds();
      const id = req.params.id;
      if (scheduledJobs[id]) { scheduledJobs[id].stop(); delete scheduledJobs[id]; }
      cmds = cmds.filter(c => c.id !== id);
      await saveScheduledCmds(cmds);
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // Exécuter immédiatement une commande programmée
  app.post('/nitrado/api/scheduled/:id/run-now', requireAdmin, async (req, res) => {
    try {
      const cmds = await getScheduledCmds();
      const cmd = cmds.find(c => c.id === req.params.id);
      if (!cmd) return res.json({ ok: false, error: 'Commande introuvable' });
      const services = await nitrado.getServices();
      const ids = cmd.serverIds && cmd.serverIds.length ? cmd.serverIds : services.map(s => s.id);
      const results = await nitrado.sendRconToMany(ids, cmd.command);
      cmd.lastRun = new Date().toISOString();
      await saveScheduledCmds(cmds);
      res.json({ ok: true, results });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ── Redémarrages automatiques (lecture/écriture pgStore, jobs gérés par le bot) ──

  async function getRestartSchedules() {
    const raw = await pgStore.getData('nitrado_restart_schedules', null);
    if (!raw) return [];
    return Array.isArray(raw) ? raw : JSON.parse(raw);
  }
  async function saveRestartSchedules(list) {
    await pgStore.setData('nitrado_restart_schedules', list);
  }

  app.get('/nitrado/api/restart-schedules', requireAdmin, async (req, res) => {
    try { res.json({ ok: true, schedules: await getRestartSchedules() }); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });

  app.post('/nitrado/api/restart-schedules', requireAdmin, async (req, res) => {
    try {
      const { nom, heure, avertissements, serverIds } = req.body;
      if (!nom || !heure) return res.json({ ok: false, error: 'Nom et heure requis' });
      if (!/^\d{2}:\d{2}$/.test(heure)) return res.json({ ok: false, error: 'Format heure invalide (HH:MM)' });
      const [h, m] = heure.split(':').map(Number);
      if (h > 23 || m > 59) return res.json({ ok: false, error: 'Heure invalide' });
      const s = {
        id: Date.now().toString(),
        nom: nom.trim(),
        heure,
        avertissements: avertissements !== false,
        serverIds: serverIds || [],
        active: true,
        dernierRedemarrage: null,
        createdAt: new Date().toISOString(),
      };
      const list = await getRestartSchedules();
      list.push(s);
      await saveRestartSchedules(list);
      res.json({ ok: true, schedule: s });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  app.patch('/nitrado/api/restart-schedules/:id/toggle', requireAdmin, async (req, res) => {
    try {
      const list = await getRestartSchedules();
      const s = list.find(x => x.id === req.params.id);
      if (!s) return res.json({ ok: false, error: 'Planning introuvable' });
      s.active = !s.active;
      await saveRestartSchedules(list);
      res.json({ ok: true, active: s.active });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  app.delete('/nitrado/api/restart-schedules/:id', requireAdmin, async (req, res) => {
    try {
      let list = await getRestartSchedules();
      const before = list.length;
      list = list.filter(s => s.id !== req.params.id);
      if (list.length === before) return res.json({ ok: false, error: 'Planning introuvable' });
      await saveRestartSchedules(list);
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  app.post('/nitrado/api/restart-schedules/:id/run-now', requireAdmin, async (req, res) => {
    try {
      const list = await getRestartSchedules();
      const s = list.find(x => x.id === req.params.id);
      if (!s) return res.json({ ok: false, error: 'Planning introuvable' });
      const services = await nitrado.getServices();
      const ids = s.serverIds && s.serverIds.length ? s.serverIds : services.map(sv => sv.id);
      await nitrado.sendRconToMany(ids, 'SaveWorld');
      await new Promise(r => setTimeout(r, 4000));
      const results = await nitrado.restartAll(ids, 'Redémarrage manuel depuis le dashboard');
      s.dernierRedemarrage = new Date().toISOString();
      await saveRestartSchedules(list);
      res.json({ ok: true, results });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ═══════════════════════════ CASINO ════════════════════════════════════════

  app.get('/casino', requireAdmin, async (req, res) => {
    try {
    const config = (await pgStore.getData('casino_config')) || {};
    let channels = [];
    if (discordClient) {
      try {
        const guild = discordClient.guilds.cache.first();
        if (guild) {
          channels = guild.channels.cache
            .filter(ch => ch.type === 0)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(ch => ({ id: ch.id, name: ch.name }));
        }
      } catch {}
    }

    const casinoSources = ['Casino', 'Gain slots', 'Mise slots', 'Gain blackjack', 'Mise blackjack',
      'Gain roulette casino', 'Mise roulette casino', 'Gain roulette russe', 'Mise roulette russe'];
    const gameMap = {
      'Gain slots': 'Slots', 'Mise slots': 'Slots',
      'Gain blackjack': 'Blackjack', 'Mise blackjack': 'Blackjack',
      'Gain roulette casino': 'Roulette', 'Mise roulette casino': 'Roulette',
      'Gain roulette russe': 'Roulette Russe', 'Mise roulette russe': 'Roulette Russe',
    };

    const { transactions } = inventoryManager.getTransactions({ limit: 100000 });
    const casinoTxs = transactions
      .filter(tx => casinoSources.includes(tx.adminId) || casinoSources.includes(tx.reason))
      .map(tx => ({
        ...tx,
        game: gameMap[tx.reason] || gameMap[tx.adminId] || tx.reason || 'Casino',
        playerName: tx.playerId,
      }));

    const byGame = {};
    const byPlayer = {};
    let totalWagered = 0, totalWon = 0;

    casinoTxs.forEach(tx => {
      const g = tx.game;
      if (!byGame[g]) byGame[g] = { sessions: 0, wagered: 0, won: 0 };
      byGame[g].sessions++;
      if (tx.quantity < 0) { byGame[g].wagered += Math.abs(tx.quantity); totalWagered += Math.abs(tx.quantity); }
      else { byGame[g].won += tx.quantity; totalWon += tx.quantity; }
      if (!byPlayer[tx.playerId]) byPlayer[tx.playerId] = 0;
      byPlayer[tx.playerId] += tx.quantity;
    });

    const popularGame = Object.entries(byGame).sort((a, b) => b[1].sessions - a[1].sessions)[0]?.[0] || '—';
    const uniquePlayers = Object.keys(byPlayer).length;
    const houseProfit = totalWagered - totalWon;

    const playerEntries = Object.entries(byPlayer);
    const topWinners = playerEntries.filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, net]) => ({ name: id, net }));
    const topLosers = playerEntries.filter(([, n]) => n < 0).sort((a, b) => a[1] - b[1]).slice(0, 5).map(([id, net]) => ({ name: id, net }));

    if (discordClient) {
      try {
        const guild = discordClient.guilds.cache.first();
        if (guild) {
          for (const p of [...topWinners, ...topLosers]) {
            const m = await guild.members.fetch(p.name).catch(() => null);
            if (m) p.name = m.displayName || m.user.username;
          }
        }
      } catch {}
    }

    const history = casinoTxs.slice(0, 100);
    if (discordClient) {
      try {
        const guild = discordClient.guilds.cache.first();
        if (guild) {
          const ids = [...new Set(history.map(tx => tx.playerId))];
          const memberMap = {};
          for (const id of ids) {
            const m = await guild.members.fetch(id).catch(() => null);
            if (m) memberMap[id] = m.displayName || m.user.username;
          }
          history.forEach(tx => { if (memberMap[tx.playerId]) tx.playerName = memberMap[tx.playerId]; });
        }
      } catch {}
    }

    res.render('casino', {
      config,
      channels,
      stats: { totalSessions: casinoTxs.length, totalWagered, totalWon, houseProfit, popularGame, uniquePlayers, byGame },
      topWinners,
      topLosers,
      history,
      success: req.query.success || null,
      error: req.query.error || null,
      botUser: discordClient?.user || null,
      discordUser: req.session?.discordUser || null,
      role: req.session?.role || 'admin',
      path: '/casino',
    });
    } catch (e) {
      console.error('[Dashboard /casino] Erreur :', e);
      res.status(500).send(`<pre>Erreur Casino : ${e.message}\n\n${e.stack}</pre>`);
    }
  });

  app.post('/casino/config', requireAdmin, async (req, res) => {
    try {
      const existing = (await pgStore.getData('casino_config')) || {};
      await pgStore.setData('casino_config', { ...existing, channelId: req.body.channelId || '' });
      res.redirect('/casino?success=Salon+casino+enregistré+!');
    } catch (e) {
      res.redirect('/casino?error=' + encodeURIComponent(e.message));
    }
  });

  app.post('/casino/maxbets', requireAdmin, async (req, res) => {
    try {
      const existing = (await pgStore.getData('casino_config')) || {};
      const keys = ['maxBetSlots', 'maxBetBlackjack', 'maxBetRoulette', 'maxBetRR'];
      const updates = {};
      for (const k of keys) {
        const v = parseInt(req.body[k], 10);
        updates[k] = (!isNaN(v) && v > 0) ? v : null;
      }
      await pgStore.setData('casino_config', { ...existing, ...updates });
      res.redirect('/casino?success=Mises+maximales+enregistrées+!');
    } catch (e) {
      res.redirect('/casino?error=' + encodeURIComponent(e.message));
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────

  // Les timers et la publication Discord des giveaways sont gérés
  // exclusivement par le bot (index.js via publishAndScheduleGiveaways)
  // ────────────────────────────────────────────────────────────────────────────

  const PORT = 5000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Dashboard disponible sur le port ${PORT}`);
  });

  return app;
}

module.exports = { createWebServer };
