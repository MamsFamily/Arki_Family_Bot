const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { getSettings, updateSection } = require('../settingsManager');
const { getShop, addPack, updatePack, deletePack, getPack, updateShopChannel, buildPackEmbed, DEFAULT_CATEGORIES } = require('../shopManager');
const { getDinoData, addDino, updateDino, deleteDino, getDino, updateDinoChannel, updateLetterMessage, getLetterMessages, updateLetterColor, getLetterColor, getLetterColors, getDinosByLetter, buildLetterEmbed, getAllLetters, DEFAULT_LETTER_COLORS } = require('../dinoManager');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (err) {
    console.error('Erreur lecture config.json:', err);
    return { rouletteChoices: [], rouletteTitle: 'ARKI' };
  }
}

function saveConfig(updates) {
  const current = readConfig();
  const merged = { ...current, ...updates };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

function createWebServer(discordClient) {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.use(express.static(path.join(__dirname, 'public')));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  const dashPassword = process.env.DASHBOARD_PASSWORD;
  if (!dashPassword) {
    console.warn('⚠️ DASHBOARD_PASSWORD non défini ! Dashboard désactivé pour sécurité.');
    return null;
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
    if (req.session && req.session.authenticated) {
      return next();
    }
    res.redirect('/login');
  }

  app.use((req, res, next) => {
    res.locals.botUser = discordClient.user;
    res.locals.path = req.path;
    next();
  });

  app.get('/login', (req, res) => {
    if (req.session && req.session.authenticated) {
      return res.redirect('/');
    }
    res.render('login', { error: null });
  });

  app.post('/login', (req, res) => {
    const { password } = req.body;
    if (password === dashPassword) {
      req.session.authenticated = true;
      return res.redirect('/');
    }
    res.render('login', { error: 'Mot de passe incorrect' });
  });

  app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
  });

  app.get('/', requireAuth, (req, res) => {
    const config = readConfig();
    const { getVotesConfig } = require('../votesConfig');
    const votesConfig = getVotesConfig();

    const guildCount = discordClient.guilds.cache.size;
    const memberCount = discordClient.guilds.cache.reduce((acc, g) => acc + g.memberCount, 0);

    res.render('dashboard', {
      config,
      votesConfig,
      guildCount,
      memberCount,
      uptime: process.uptime(),
    });
  });

  app.get('/roulette', requireAuth, (req, res) => {
    const config = readConfig();
    res.render('roulette', { config, success: null, error: null });
  });

  app.post('/roulette', requireAuth, (req, res) => {
    const { title, choices } = req.body;

    if (!title || title.trim().length === 0) {
      return res.render('roulette', { config: readConfig(), success: null, error: 'Le titre ne peut pas être vide.' });
    }
    if (title.trim().length > 20) {
      return res.render('roulette', { config: readConfig(), success: null, error: 'Le titre ne doit pas dépasser 20 caractères.' });
    }

    const choicesArray = choices.split('\n').map(c => c.trim()).filter(c => c.length > 0);

    if (choicesArray.length < 2) {
      return res.render('roulette', { config: readConfig(), success: null, error: 'Minimum 2 choix requis.' });
    }
    if (choicesArray.length > 12) {
      return res.render('roulette', { config: readConfig(), success: null, error: 'Maximum 12 choix autorisés.' });
    }

    const config = saveConfig({
      rouletteTitle: title.trim(),
      rouletteChoices: choicesArray,
    });

    res.render('roulette', { config, success: 'Configuration sauvegardée !', error: null });
  });

  app.get('/votes', requireAuth, async (req, res) => {
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

  app.get('/rewards', requireAuth, (req, res) => {
    const settings = getSettings();
    res.render('rewards', { settings, success: null, error: null });
  });

  app.post('/rewards', requireAuth, (req, res) => {
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

    updateSection('rewards', {
      diamondsPerVote: parseInt(diamondsPerVote) || 100,
      topDiamonds,
      topLots,
    });

    const settings = getSettings();
    res.render('rewards', { settings, success: 'Récompenses sauvegardées !', error: null });
  });

  app.get('/message', requireAuth, (req, res) => {
    const settings = getSettings();
    res.render('message', { settings, success: null, error: null });
  });

  app.post('/message', requireAuth, (req, res) => {
    const { introText, creditText, pack1Text, pack2Text, pack3Text, memoText, dinoShinyText, dinoTitle, dinoWinText } = req.body;

    updateSection('message', {
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

  app.get('/settings', requireAuth, (req, res) => {
    const settings = getSettings();
    res.render('settings', { settings, success: null, error: null });
  });

  app.post('/settings', requireAuth, (req, res) => {
    const {
      guildId, resultsChannelId, adminLogChannelId, topVoterRoleId, modoRoleId,
      logo, fireworks, sparkly, animeArrow, arrow, memoUrl,
      topserveursRankingUrl, timezone, aliases
    } = req.body;

    updateSection('guild', {
      guildId: guildId || '',
      resultsChannelId: resultsChannelId || '',
      adminLogChannelId: adminLogChannelId || '',
      topVoterRoleId: topVoterRoleId || '',
      modoRoleId: modoRoleId || '',
    });

    updateSection('style', {
      everyonePing: req.body.everyonePing === 'true',
      logo: logo || '',
      fireworks: fireworks || '',
      sparkly: sparkly || '',
      animeArrow: animeArrow || '',
      arrow: arrow || '',
      memoUrl: memoUrl || '',
    });

    updateSection('api', {
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
    updateSection('aliases', aliasesObj, true);

    const settings = getSettings();
    res.render('settings', { settings, success: 'Paramètres sauvegardés !', error: null });
  });

  app.get('/shop', requireAuth, (req, res) => {
    const shop = getShop();
    const settings = getSettings();
    const configuredGuildId = settings.guild.guildId;
    const guild = configuredGuildId ? discordClient.guilds.cache.get(configuredGuildId) : discordClient.guilds.cache.first();
    let channels = [];
    if (guild) {
      channels = guild.channels.cache
        .filter(ch => ch.type === 0)
        .sort((a, b) => a.position - b.position)
        .map(ch => ({ id: ch.id, name: ch.name }));
    }
    res.render('shop', { shop, categories: DEFAULT_CATEGORIES, channels, success: req.query.success || null, error: req.query.error || null });
  });

  app.post('/shop/settings', requireAuth, (req, res) => {
    const { shopChannelId } = req.body;
    updateShopChannel(shopChannelId || '');
    res.redirect('/shop?success=Salon+sauvegard%C3%A9+!');
  });

  app.post('/shop/pack', requireAuth, (req, res) => {
    const { packId, name, category, priceDiamonds, priceStrawberries, content, note, color, donationAvailable, notCompatible, unavailable, noReduction } = req.body;

    const packData = {
      name: name || 'Pack sans nom',
      category: category || 'packs',
      priceDiamonds: parseInt(priceDiamonds) || 0,
      priceStrawberries: parseInt(priceStrawberries) || 0,
      content: content || '',
      note: note || '',
      color: color || '#e74c3c',
      donationAvailable: donationAvailable === 'true',
      notCompatible: notCompatible === 'true',
      available: unavailable !== 'true',
      noReduction: noReduction === 'true',
    };

    if (packId) {
      updatePack(packId, packData);
      res.redirect('/shop?success=Pack+modifi%C3%A9+!');
    } else {
      addPack(packData);
      res.redirect('/shop?success=Pack+cr%C3%A9%C3%A9+!');
    }
  });

  app.post('/shop/delete/:id', requireAuth, (req, res) => {
    const pack = getPack(req.params.id);
    if (pack && pack.messageId && pack.channelId) {
      try {
        const channel = discordClient.channels.cache.get(pack.channelId);
        if (channel) {
          channel.messages.fetch(pack.messageId).then(msg => msg.delete()).catch(() => {});
        }
      } catch (e) {}
    }
    deletePack(req.params.id);
    res.redirect('/shop?success=Pack+supprim%C3%A9+!');
  });

  app.post('/shop/publish/:id', requireAuth, async (req, res) => {
    const shop = getShop();
    const pack = getPack(req.params.id);
    if (!pack) return res.redirect('/shop?error=Pack+introuvable');

    const channelId = shop.shopChannelId;
    if (!channelId) return res.redirect('/shop?error=Aucun+salon+configur%C3%A9');

    try {
      const channel = await discordClient.channels.fetch(channelId);
      if (!channel) return res.redirect('/shop?error=Salon+introuvable');

      const embed = buildPackEmbed(pack);

      if (pack.messageId) {
        try {
          const existingMsg = await channel.messages.fetch(pack.messageId);
          await existingMsg.edit({ embeds: [embed] });
          res.redirect('/shop?success=Embed+mis+%C3%A0+jour+!');
        } catch (e) {
          const newMsg = await channel.send({ embeds: [embed] });
          updatePack(pack.id, { messageId: newMsg.id, channelId: channelId });
          res.redirect('/shop?success=Embed+republié+!');
        }
      } else {
        const newMsg = await channel.send({ embeds: [embed] });
        updatePack(pack.id, { messageId: newMsg.id, channelId: channelId });
        res.redirect('/shop?success=Embed+publi%C3%A9+!');
      }
    } catch (err) {
      console.error('Erreur publication shop:', err);
      res.redirect('/shop?error=Erreur+de+publication');
    }
  });

  app.post('/shop/publish-all', requireAuth, async (req, res) => {
    const shop = getShop();
    if (!shop.shopChannelId) return res.redirect('/shop?error=Aucun+salon+configur%C3%A9');

    try {
      const channel = await discordClient.channels.fetch(shop.shopChannelId);
      if (!channel) return res.redirect('/shop?error=Salon+introuvable');

      let published = 0;
      for (const pack of shop.packs) {
        const embed = buildPackEmbed(pack);
        try {
          if (pack.messageId) {
            try {
              const existingMsg = await channel.messages.fetch(pack.messageId);
              await existingMsg.edit({ embeds: [embed] });
            } catch (e) {
              const newMsg = await channel.send({ embeds: [embed] });
              updatePack(pack.id, { messageId: newMsg.id, channelId: shop.shopChannelId });
            }
          } else {
            const newMsg = await channel.send({ embeds: [embed] });
            updatePack(pack.id, { messageId: newMsg.id, channelId: shop.shopChannelId });
          }
          published++;
        } catch (err) {
          console.error(`Erreur publication pack ${pack.name}:`, err);
        }
      }

      res.redirect(`/shop?success=${published}+packs+publiés+!`);
    } catch (err) {
      console.error('Erreur publication shop:', err);
      res.redirect('/shop?error=Erreur+de+publication');
    }
  });

  app.get('/dinos', requireAuth, (req, res) => {
    const dinoData = getDinoData();
    const grouped = getDinosByLetter();
    const letterMessages = getLetterMessages();
    const settings = getSettings();
    const configuredGuildId = settings.guild.guildId;
    const guild = configuredGuildId ? discordClient.guilds.cache.get(configuredGuildId) : discordClient.guilds.cache.first();
    let channels = [];
    if (guild) {
      channels = guild.channels.cache
        .filter(ch => ch.type === 0)
        .sort((a, b) => a.position - b.position)
        .map(ch => ({ id: ch.id, name: ch.name }));
    }
    const letterColors = getLetterColors();
    res.render('dinos', { dinoData, grouped, letterMessages, letterColors, defaultColors: DEFAULT_LETTER_COLORS, channels, success: req.query.success || null, error: req.query.error || null });
  });

  app.post('/dinos/settings', requireAuth, (req, res) => {
    updateDinoChannel(req.body.dinoChannelId || '');
    res.redirect('/dinos?success=Salon+sauvegard%C3%A9+!');
  });

  app.post('/dinos/letter-color', requireAuth, (req, res) => {
    const { letter, color } = req.body;
    if (letter && color) {
      updateLetterColor(letter.toUpperCase(), color);
    }
    res.redirect('/dinos?success=Couleur+mise+%C3%A0+jour+!');
  });

  app.post('/dinos/save', requireAuth, (req, res) => {
    const { dinoId, name, priceDiamonds, priceStrawberries, uniquePerTribe, noReduction, doubleInventaire, coupleInventaire, notAvailableDona, notAvailableShop } = req.body;

    const variants = [];
    for (let i = 1; i <= 20; i++) {
      const label = req.body[`variant_label_${i}`];
      const vd = req.body[`variant_diamonds_${i}`];
      const vs = req.body[`variant_strawberries_${i}`];
      if (label !== undefined && label.trim()) {
        variants.push({
          label: label.trim(),
          priceDiamonds: parseInt(vd) || 0,
          priceStrawberries: parseInt(vs) || 0,
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
      doubleInventaire: doubleInventaire === 'true',
      coupleInventaire: coupleInventaire === 'true',
      notAvailableDona: notAvailableDona === 'true',
      notAvailableShop: notAvailableShop === 'true',
    };

    if (dinoId) {
      updateDino(dinoId, dinoData);
      res.redirect('/dinos?success=Dino+modifi%C3%A9+!');
    } else {
      addDino(dinoData);
      res.redirect('/dinos?success=Dino+ajout%C3%A9+!');
    }
  });

  app.post('/dinos/delete/:id', requireAuth, (req, res) => {
    deleteDino(req.params.id);
    res.redirect('/dinos?success=Dino+supprim%C3%A9+!');
  });

  app.post('/dinos/publish-letter/:letter', requireAuth, async (req, res) => {
    const letter = req.params.letter.toUpperCase();
    const dinoData = getDinoData();
    const channelId = dinoData.dinoChannelId;
    if (!channelId) return res.redirect('/dinos?error=Aucun+salon+configur%C3%A9');

    const grouped = getDinosByLetter();
    const dinos = grouped[letter];
    if (!dinos || dinos.length === 0) return res.redirect('/dinos?error=Aucun+dino+pour+cette+lettre');

    try {
      const channel = await discordClient.channels.fetch(channelId);
      if (!channel) return res.redirect('/dinos?error=Salon+introuvable');

      const embed = buildLetterEmbed(letter, dinos);
      const letterMsgs = getLetterMessages();

      if (letterMsgs[letter] && letterMsgs[letter].messageId) {
        try {
          const existingMsg = await channel.messages.fetch(letterMsgs[letter].messageId);
          await existingMsg.edit({ embeds: [embed] });
          res.redirect('/dinos?success=Lettre+' + letter + '+mise+%C3%A0+jour+!');
        } catch (e) {
          const newMsg = await channel.send({ embeds: [embed] });
          updateLetterMessage(letter, newMsg.id, channelId);
          res.redirect('/dinos?success=Lettre+' + letter + '+republié+!');
        }
      } else {
        const newMsg = await channel.send({ embeds: [embed] });
        updateLetterMessage(letter, newMsg.id, channelId);
        res.redirect('/dinos?success=Lettre+' + letter + '+publi%C3%A9e+!');
      }
    } catch (err) {
      console.error('Erreur publication dino:', err);
      res.redirect('/dinos?error=Erreur+de+publication');
    }
  });

  app.post('/dinos/publish-all', requireAuth, async (req, res) => {
    const dinoData = getDinoData();
    if (!dinoData.dinoChannelId) return res.redirect('/dinos?error=Aucun+salon+configur%C3%A9');

    try {
      const channel = await discordClient.channels.fetch(dinoData.dinoChannelId);
      if (!channel) return res.redirect('/dinos?error=Salon+introuvable');

      const grouped = getDinosByLetter();
      const letters = Object.keys(grouped).sort();
      let published = 0;
      const letterMsgs = getLetterMessages();

      for (const letter of letters) {
        const embed = buildLetterEmbed(letter, grouped[letter]);
        try {
          if (letterMsgs[letter] && letterMsgs[letter].messageId) {
            try {
              const existingMsg = await channel.messages.fetch(letterMsgs[letter].messageId);
              await existingMsg.edit({ embeds: [embed] });
            } catch (e) {
              const newMsg = await channel.send({ embeds: [embed] });
              updateLetterMessage(letter, newMsg.id, dinoData.dinoChannelId);
            }
          } else {
            const newMsg = await channel.send({ embeds: [embed] });
            updateLetterMessage(letter, newMsg.id, dinoData.dinoChannelId);
          }
          published++;
        } catch (err) {
          console.error(`Erreur publication lettre ${letter}:`, err);
        }
      }

      res.redirect(`/dinos?success=${published}+lettres+publi%C3%A9es+!`);
    } catch (err) {
      console.error('Erreur publication dinos:', err);
      res.redirect('/dinos?error=Erreur+de+publication');
    }
  });

  const PORT = 5000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Dashboard disponible sur le port ${PORT}`);
  });

  return app;
}

module.exports = { createWebServer };
