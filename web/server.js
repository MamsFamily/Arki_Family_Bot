const express = require('express');
const session = require('express-session');
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
const { getDinoData, addDino, updateDino, deleteDino, getDino, updateDinoChannel, updateLetterMessage, getLetterMessages, updateLetterColor, getLetterColor, getLetterColors, getDinosByLetter, getModdedDinos, getShoulderDinos, getPaidDLCDinos, buildLetterEmbed, buildLetterEmbeds, buildModdedEmbed, buildModdedEmbeds, buildShoulderEmbed, buildSaleEmbed, getVisibleVariantLabels, getDinosByVariant, buildVariantEmbed, getAllLetters, updateNavMessage, getNavMessage, saveDinos, DEFAULT_LETTER_COLORS } = require('../dinoManager');

const { getConfig: readConfig, saveConfig } = require('../configManager');
const inventoryManager = require('../inventoryManager');

function createWebServer(discordClient) {
  const app = express();

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

  app.use(session({
    secret: process.env.SESSION_SECRET || require('crypto').randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax',
    }
  }));

  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    next();
  });

  function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated && req.session.discordUser) {
      return next();
    }
    res.redirect('/login');
  }

  function requireAdmin(req, res, next) {
    if (req.session && req.session.authenticated && req.session.discordUser && req.session.role === 'admin') {
      return next();
    }
    if (req.session && req.session.authenticated && req.session.discordUser) {
      return res.redirect('/shop');
    }
    res.redirect('/login');
  }

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
      return res.redirect(req.session.role === 'admin' ? '/' : '/shop');
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

      res.redirect(req.session.role === 'admin' ? '/' : '/shop');
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

  app.get('/', requireAdmin, async (req, res) => {
    const { getVotesConfig } = require('../votesConfig');
    const { fetchTopserveursRanking } = require('../topserveursService');
    const { fetchNitradoServers } = require('../nitradoService');
    const votesConfig = getVotesConfig();

    const memberCount = discordClient?.guilds?.cache?.reduce((acc, g) => acc + g.memberCount, 0) || 0;

    const [top5Result, nitradoResult] = await Promise.allSettled([
      (async () => {
        const rankingUrl = votesConfig.TOPSERVEURS_RANKING_URL || 'https://api.top-serveurs.net/v1/servers/4ROMAU33GJTY/players-ranking';
        const all = await fetchTopserveursRanking(rankingUrl);
        return all.slice(0, 5);
      })(),
      fetchNitradoServers(),
    ]);

    const top5 = top5Result.status === 'fulfilled' ? top5Result.value : [];
    const nitradoServers = nitradoResult.status === 'fulfilled' ? nitradoResult.value : [];

    res.render('dashboard', {
      memberCount,
      uptime: process.uptime(),
      top5,
      nitradoServers,
    });
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

  app.get('/rewards', requireAdmin, (req, res) => {
    const settings = getSettings();
    res.render('rewards', { settings, success: null, error: null });
  });

  app.post('/rewards', requireAdmin, async (req, res) => {
    const { diamondsPerVote, bonus4, bonus5 } = req.body;

    const topDiamonds = {};
    if (parseInt(bonus4) > 0) topDiamonds[4] = parseInt(bonus4);
    if (parseInt(bonus5) > 0) topDiamonds[5] = parseInt(bonus5);

    const topLots = {};
    for (let place = 1; place <= 3; place++) {
      const lot = {};
      const dino = parseInt(req.body[`lot${place}_dino`]) || 0;
      const art = parseInt(req.body[`lot${place}_art`]) || 0;
      const badge = parseInt(req.body[`lot${place}_badge`]) || 0;
      const fraises = parseInt(req.body[`lot${place}_fraises`]) || 0;
      const diamants = parseInt(req.body[`lot${place}_diamants`]) || 0;

      if (dino > 0) lot['🦖'] = dino;
      if (art > 0) lot['🎨'] = art;
      if (badge > 0) lot[`${place}️⃣`] = badge;
      if (fraises > 0) lot['🍓'] = fraises;
      if (diamants > 0) lot['💎'] = diamants;

      topLots[place] = lot;
    }

    await updateSection('rewards', {
      diamondsPerVote: parseInt(diamondsPerVote) || 100,
      topDiamonds,
      topLots,
    });

    const settings = getSettings();
    res.render('rewards', { settings, success: 'Récompenses sauvegardées !', error: null });
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
    res.render('shop', { shop, categories: shopCategories, channels, success: req.query.success || null, error: req.query.error || null });
  });

  app.post('/shop/settings', requireAuth, async (req, res) => {
    const { shopChannelId, shopUnitaireChannelId, shopIndexChannelId, shopTicketChannelId } = req.body;
    await updateShopChannels({
      shopChannelId: shopChannelId || '',
      shopUnitaireChannelId: shopUnitaireChannelId || '',
      shopIndexChannelId: shopIndexChannelId || '',
      shopTicketChannelId: shopTicketChannelId || '',
    });
    res.redirect('/shop?success=Param%C3%A8tres+sauvegard%C3%A9s+!');
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

    let options = [];
    if (optionsJson) {
      try {
        const parsed = JSON.parse(optionsJson);
        if (Array.isArray(parsed)) {
          options = parsed.filter(o => o.name && o.name.trim()).map(o => ({
            name: o.name.trim(),
            priceDiamonds: parseInt(o.priceDiamonds) || 0,
            priceStrawberries: parseInt(o.priceStrawberries) || 0,
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
      const packItems = packs.filter(p => (p.type || 'pack') === 'pack');
      const unitItems = packs.filter(p => p.type === 'unitaire');
      const cats = getCategories();
      const guildId = discordClient.guilds.cache.first()?.id || '';

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

      const packFields = toFields(packItems, '📦', 'Packs');
      const unitFields = toFields(unitItems, '💎', 'Produits unitaires');
      const allFields = [...packFields, ...unitFields];

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

      // Supprime l'ancien message index s'il existe
      if (shop.shopIndexMessageId) {
        try {
          const oldMsg = await channel.messages.fetch(shop.shopIndexMessageId);
          await oldMsg.delete();
        } catch (e) {}
      }

      // Envoie le ou les nouveaux embeds
      let firstMsgId = null;
      for (let i = 0; i < embeds.length; i++) {
        const msg = await channel.send({ embeds: [embeds[i]] });
        if (i === 0) firstMsgId = msg.id;
      }
      await saveShopIndexMessage(firstMsgId);
      res.redirect('/shop?success=Message+index+publi%C3%A9+!');
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
    res.render('dinos', { dinoData, grouped, moddedDinos, letterMessages, letterColors, defaultColors: DEFAULT_LETTER_COLORS, channels, variantLabels, hasAnyVariant, success: req.query.success || null, error: req.query.error || null });
  });

  app.post('/dinos/settings', requireAuth, async (req, res) => {
    await updateDinoChannel(req.body.dinoChannelId || '');
    res.redirect('/dinos?success=Salon+sauvegard%C3%A9+!');
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

      for (const oldId of storedIds) {
        try { const msg = await channel.messages.fetch(oldId); await msg.delete(); } catch {}
      }

      const newIds = [];
      for (const embed of embeds) {
        const msg = await channel.send({ embeds: [embed] });
        newIds.push(msg.id);
      }

      await updateLetterMessage(letter, newIds[0], channelId, newIds);
      res.redirect('/dinos?success=Lettre+' + letter + '+publi%C3%A9e+!+(' + embeds.length + '+message' + (embeds.length > 1 ? 's' : '') + ')');
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
        for (const oldId of storedIds) {
          try { const msg = await channel.messages.fetch(oldId); await msg.delete(); } catch {}
        }
        const newIds = [];
        for (const embed of embeds) {
          const msg = await channel.send({ embeds: [embed] });
          newIds.push(msg.id);
        }
        await updateLetterMessage(letter, newIds[0], channelId, newIds);
        totalMessages += newIds.length;
        await new Promise(r => setTimeout(r, 500));
      }

      if (moddedDinos.length > 0) {
        const storedIds = letterMsgs['MODDED']?.messageIds || (letterMsgs['MODDED']?.messageId ? [letterMsgs['MODDED'].messageId] : []);
        for (const oldId of storedIds) {
          try { const msg = await channel.messages.fetch(oldId); await msg.delete(); } catch {}
        }
        const moddedEmbeds = buildModdedEmbeds(moddedDinos);
        const newIds = [];
        for (const embed of moddedEmbeds) {
          const msg = await channel.send({ embeds: [embed] });
          newIds.push(msg.id);
        }
        await updateLetterMessage('MODDED', newIds[0], channelId, newIds);
        totalMessages += newIds.length;
      }

      console.log(`✅ Publication complète terminée: ${totalMessages} messages envoyés`);
    } catch (err) {
      console.error('Erreur publication tout dinos:', err);
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
    const { saleDinoId, salePercent, saleChannelId } = req.body;
    if (!saleDinoId || !salePercent) return res.redirect('/dinos?error=Dino+et+pourcentage+requis');

    const dino = getDino(saleDinoId);
    if (!dino) return res.redirect('/dinos?error=Dino+introuvable');

    const percent = parseInt(salePercent);
    if (percent <= 0 || percent >= 100) return res.redirect('/dinos?error=Pourcentage+invalide');

    const dinoData = getDinoData();
    const channelId = saleChannelId || dinoData.dinoChannelId;
    if (!channelId) return res.redirect('/dinos?error=Aucun+salon+configur%C3%A9');

    try {
      const channel = await discordClient.channels.fetch(channelId);
      if (!channel) return res.redirect('/dinos?error=Salon+introuvable');

      const embed = buildSaleEmbed(dino, percent);
      await channel.send({ embeds: [embed] });
      res.redirect('/dinos?success=Promo+publi%C3%A9e+!');
    } catch (err) {
      console.error('Erreur publication promo dino:', err);
      res.redirect('/dinos?error=Erreur+de+publication');
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

  async function sendInventoryLog(action, adminName, itemType, quantity, playerId) {
    try {
      const settings = getSettings();
      const channelId = settings.guild.inventoryLogChannelId;
      if (!channelId || !discordClient) return;
      const channel = await discordClient.channels.fetch(channelId);
      if (!channel) return;
      const verb = action === 'add' ? 'a ajouté' : 'a retiré';
      const prep = action === 'add' ? 'à l\'inventaire de' : 'de l\'inventaire de';
      await channel.send(`${itemType.emoji} **${adminName}** ${verb} **${quantity} ${itemType.name}** ${prep} <@${playerId}>`);
    } catch (e) {
      console.error('Erreur log inventaire Discord:', e.message);
    }
  }

  app.post('/inventory/player/:playerId/add', requireAuth, async (req, res) => {
    const { playerId } = req.params;
    const { itemTypeId, quantity, reason } = req.body;
    if (!itemTypeId || !quantity) {
      return res.json({ error: 'Item et quantité requis' });
    }
    const itemType = inventoryManager.getItemTypeById(itemTypeId);
    if (!itemType) {
      return res.json({ error: 'Type d\'item introuvable' });
    }
    const adminName = req.session.discordUser?.displayName || (req.session.role === 'admin' ? 'Admin' : 'Staff');
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
    const itemType = inventoryManager.getItemTypeById(itemTypeId);
    if (!itemType) {
      return res.json({ error: 'Type d\'item introuvable' });
    }
    const adminName = req.session.discordUser?.displayName || (req.session.role === 'admin' ? 'Admin' : 'Staff');
    const result = await inventoryManager.removeFromInventory(playerId, itemTypeId, parseInt(quantity) || 1, adminName, reason || '');
    sendInventoryLog('remove', adminName, itemType, parseInt(quantity) || 1, playerId);
    res.json({ success: true, newQuantity: result.newQuantity });
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

  app.get('/inventory/api/transactions', requireAuth, (req, res) => {
    const filters = {};
    if (req.query.playerId) filters.playerId = req.query.playerId;
    if (req.query.itemTypeId) filters.itemTypeId = req.query.itemTypeId;
    if (req.query.type) filters.type = req.query.type;
    if (req.query.limit) filters.limit = parseInt(req.query.limit);
    if (!filters.limit) filters.limit = 100;
    const result = inventoryManager.getTransactions(filters);
    res.json(result);
  });

  const PORT = 5000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Dashboard disponible sur le port ${PORT}`);
  });

  return app;
}

module.exports = { createWebServer };
