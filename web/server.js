const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { getSettings, updateSection } = require('../settingsManager');

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

  const PORT = 5000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Dashboard disponible sur le port ${PORT}`);
  });

  return app;
}

module.exports = { createWebServer };
