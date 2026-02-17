const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

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
    const votesConfig = require('../votesConfig');

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
      const config = readConfig();
      return res.render('roulette', { config, success: null, error: 'Le titre ne peut pas être vide.' });
    }
    if (title.trim().length > 20) {
      const config = readConfig();
      return res.render('roulette', { config, success: null, error: 'Le titre ne doit pas dépasser 20 caractères.' });
    }

    const choicesArray = choices.split('\n').map(c => c.trim()).filter(c => c.length > 0);

    if (choicesArray.length < 2) {
      const config = readConfig();
      return res.render('roulette', { config, success: null, error: 'Minimum 2 choix requis.' });
    }
    if (choicesArray.length > 12) {
      const config = readConfig();
      return res.render('roulette', { config, success: null, error: 'Maximum 12 choix autorisés.' });
    }

    const config = saveConfig({
      rouletteTitle: title.trim(),
      rouletteChoices: choicesArray,
    });

    res.render('roulette', { config, success: 'Configuration sauvegardée !', error: null });
  });

  app.get('/votes', requireAuth, async (req, res) => {
    const { fetchTopserveursRanking } = require('../topserveursService');
    const votesConfig = require('../votesConfig');
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

  app.get('/config', requireAuth, (req, res) => {
    const votesConfig = require('../votesConfig');
    res.render('config', { votesConfig, success: null });
  });

  const PORT = 5000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Dashboard disponible sur le port ${PORT}`);
  });

  return app;
}

module.exports = { createWebServer };
