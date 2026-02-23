const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { getSettings, updateSection } = require('../settingsManager');
const { getShop, addPack, updatePack, deletePack, getPack, updateShopChannel, buildPackEmbed, DEFAULT_CATEGORIES } = require('../shopManager');
const { getDinoData, addDino, updateDino, deleteDino, getDino, updateDinoChannel, updateLetterMessage, getLetterMessages, updateLetterColor, getLetterColor, getLetterColors, getDinosByLetter, getModdedDinos, getShoulderDinos, buildLetterEmbed, buildLetterEmbeds, buildModdedEmbed, buildShoulderEmbed, buildSaleEmbed, getAllLetters, updateNavMessage, getNavMessage, saveDinos, DEFAULT_LETTER_COLORS } = require('../dinoManager');

const { getConfig: readConfig, saveConfig } = require('../configManager');

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
    if (req.session && req.session.authenticated) {
      return next();
    }
    res.redirect('/login');
  }

  function requireAdmin(req, res, next) {
    if (req.session && req.session.authenticated && req.session.role === 'admin') {
      return next();
    }
    if (req.session && req.session.authenticated) {
      return res.redirect('/shop');
    }
    res.redirect('/login');
  }

  app.use((req, res, next) => {
    res.locals.botUser = discordClient.user;
    res.locals.path = req.path;
    res.locals.role = req.session?.role || null;
    next();
  });

  app.get('/login', (req, res) => {
    if (req.session && req.session.authenticated) {
      return res.redirect(req.session.role === 'admin' ? '/' : '/shop');
    }
    res.render('login', { error: null });
  });

  app.post('/login', (req, res) => {
    const { password } = req.body;
    const passwords = getPasswords();
    if (password === passwords.admin) {
      req.session.authenticated = true;
      req.session.role = 'admin';
      return res.redirect('/');
    }
    if (password === passwords.staff) {
      req.session.authenticated = true;
      req.session.role = 'staff';
      return res.redirect('/shop');
    }
    res.render('login', { error: 'Mot de passe incorrect' });
  });

  app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
  });

  app.get('/', requireAdmin, async (req, res) => {
    const config = await readConfig();
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
      guildId, resultsChannelId, adminLogChannelId, topVoterRoleId, modoRoleId,
      logo, fireworks, sparkly, animeArrow, arrow, memoUrl,
      topserveursRankingUrl, timezone, aliases
    } = req.body;

    await updateSection('guild', {
      guildId: guildId || '',
      resultsChannelId: resultsChannelId || '',
      adminLogChannelId: adminLogChannelId || '',
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
    const guild = configuredGuildId ? discordClient.guilds.cache.get(configuredGuildId) : discordClient.guilds.cache.first();
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
    res.render('shop', { shop, categories: DEFAULT_CATEGORIES, channels, success: req.query.success || null, error: req.query.error || null });
  });

  app.post('/shop/settings', requireAuth, async (req, res) => {
    const { shopChannelId } = req.body;
    await updateShopChannel(shopChannelId || '');
    res.redirect('/shop?success=Salon+sauvegard%C3%A9+!');
  });

  app.post('/shop/pack', requireAuth, async (req, res) => {
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
      await updatePack(packId, packData);
      res.redirect('/shop?success=Pack+modifi%C3%A9+!');
    } else {
      await addPack(packData);
      res.redirect('/shop?success=Pack+cr%C3%A9%C3%A9+!');
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
          await updatePack(pack.id, { messageId: newMsg.id, channelId: channelId });
          res.redirect('/shop?success=Embed+republié+!');
        }
      } else {
        const newMsg = await channel.send({ embeds: [embed] });
        await updatePack(pack.id, { messageId: newMsg.id, channelId: channelId });
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
              await updatePack(pack.id, { messageId: newMsg.id, channelId: shop.shopChannelId });
            }
          } else {
            const newMsg = await channel.send({ embeds: [embed] });
            await updatePack(pack.id, { messageId: newMsg.id, channelId: shop.shopChannelId });
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
    const { dinoId, name, priceDiamonds, priceStrawberries, uniquePerTribe, noReduction, coupleInventaire, notAvailableDona, notAvailableShop, isModded, isShoulder } = req.body;

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
      embeds = [buildModdedEmbed(moddedDinos)];
    } else if (letter === 'SHOULDER') {
      const shoulderDinos = getShoulderDinos();
      if (shoulderDinos.length === 0) return res.redirect('/dinos?error=Aucun+dino+d\'%C3%A9paule');
      embeds = [require('../dinoManager').buildShoulderEmbed(shoulderDinos)];
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

    try {
      const channel = await discordClient.channels.fetch(channelId);
      if (!channel) return res.redirect('/dinos?error=Salon+introuvable');

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
      }

      if (moddedDinos.length > 0) {
        const storedIds = letterMsgs['MODDED']?.messageIds || (letterMsgs['MODDED']?.messageId ? [letterMsgs['MODDED'].messageId] : []);
        for (const oldId of storedIds) {
          try { const msg = await channel.messages.fetch(oldId); await msg.delete(); } catch {}
        }
        const embed = buildModdedEmbed(moddedDinos);
        const msg = await channel.send({ embeds: [embed] });
        await updateLetterMessage('MODDED', msg.id, channelId, [msg.id]);
        totalMessages++;
      }

      res.redirect('/dinos?success=Tout+publi%C3%A9+!+(' + totalMessages + '+messages)');
    } catch (err) {
      console.error('Erreur publication tout dinos:', err);
      res.redirect('/dinos?error=Erreur+de+publication:+' + encodeURIComponent(err.message));
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
    if (letters.length === 0 && moddedDinos.length === 0) return res.redirect('/dinos?error=Aucun+dino+enregistr%C3%A9');

    try {
      const channel = await discordClient.channels.fetch(channelId);
      if (!channel) return res.redirect('/dinos?error=Salon+introuvable');

      const firstLetter = letters.length > 0 ? letters[0] : null;
      const embed = firstLetter ? buildLetterEmbed(firstLetter, grouped[firstLetter]) : buildModdedEmbed(moddedDinos);

      const totalDinos = letters.reduce((sum, l) => sum + grouped[l].length, 0) + moddedDinos.length;
      const menuOptions = [
        { label: 'Tout afficher', description: `${totalDinos} dinos au total`, value: 'ALL', emoji: '📋' },
        ...letters.map(l => ({
          label: `Lettre ${l}`,
          description: `${grouped[l].length} dino${grouped[l].length > 1 ? 's' : ''}`,
          value: l,
          emoji: '📖',
          default: l === firstLetter,
        })),
      ];
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

  const PORT = 5000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Dashboard disponible sur le port ${PORT}`);
  });

  return app;
}

module.exports = { createWebServer };
