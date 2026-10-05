'use strict';

const express = require('express');
const crypto = require('node:crypto');
const axios = require('axios');

const SHOP_CHANNELS = Object.freeze([
  { key: 'infos', title: 'Côté infos shop', description: 'Les informations utiles avant de passer commande.', id: '1485051049654878379' },
  { key: 'petit-shop', title: 'Le p’tit shop', description: 'Découvre les articles du p’tit shop.', id: '1485051177845657771' },
  { key: 'packs', title: 'Les packs', description: 'Consulte les packs disponibles sur Discord.', id: '1485051269977739334' },
  { key: 'dinos', title: 'Dino shop', description: 'Retrouve les dinos proposés au shop.', id: '1485051399589855382' },
]);
const ORDER_CHANNEL = '1156938232244752494';
const DONATION_INFO_CHANNEL = '1160538476224196628';
const DONATION_TICKET_CHANNEL = '1156938293586427934';
const DISCORD_ID = /^\d{17,20}$/;

function buildShopDirectory(guildId) {
  if (typeof guildId !== 'string' || !DISCORD_ID.test(guildId)) {
    throw new Error('Identifiant du serveur Discord non configuré.');
  }
  const channelUrl = id => `https://discord.com/channels/${guildId}/${id}`;
  return {
    categories: SHOP_CHANNELS.map(({ id, ...category }) => ({ ...category, url: channelUrl(id) })),
    orderUrl: channelUrl(ORDER_CHANNEL),
    donations: {
      infoUrl: channelUrl(DONATION_INFO_CHANNEL),
      ticketUrl: channelUrl(DONATION_TICKET_CHANNEL),
    },
  };
}

function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !a.length || a.length > 256) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function getMember(session) {
  const candidate = session?.shopDiscordUser ||
    (session?.authenticated ? session.discordUser : null);
  return candidate && typeof candidate.id === 'string' && DISCORD_ID.test(candidate.id)
    ? candidate : null;
}

const saveSession = req => new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
const regenerateSession = req => new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));

function createMemberShop({
  getGuildId,
  getBaseUrl,
  getSessionGeneration,
  axiosClient = axios,
  now = Date.now,
  getOAuthConfig = () => ({
    clientId: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
  }),
}) {
  const router = express.Router();
  const loginError = (res, message) => res.redirect('/boutique/connexion?error=' + encodeURIComponent(message));

  async function requireMember(req, res, next) {
    const member = getMember(req.session);
    if (!member) return res.redirect('/boutique/connexion');
    if (req.session.shopDiscordUser) {
      const generation = await getSessionGeneration();
      if (req.session.shopSessionGen !== generation) {
        delete req.session.shopDiscordUser;
        delete req.session.shopSessionGen;
        delete req.session.shopCsrfToken;
        return loginError(res, 'Ta session a été révoquée. Reconnecte-toi avec Discord.');
      }
    }
    res.locals.member = member;
    next();
  }

  router.get('/connexion', (req, res) => {
    // Recheck generation on the protected page rather than bypassing revocation here.
    if (getMember(req.session) && !req.query.error) return res.redirect('/boutique');
    res.render('member-shop-login', {
      error: typeof req.query.error === 'string' ? req.query.error.slice(0, 300) : null,
    });
  });

  router.get('/auth/discord', async (req, res) => {
    if (getMember(req.session)) return res.redirect('/boutique');
    const { clientId, clientSecret } = getOAuthConfig();
    if (!clientId || !clientSecret) return loginError(res, 'La connexion Discord est momentanément indisponible.');
    const state = crypto.randomBytes(24).toString('hex');
    const redirectUri = `${getBaseUrl(req)}/auth/discord/callback`;
    req.session.shopOAuth = { state, redirectUri, expiresAt: now() + 10 * 60 * 1000 };
    await saveSession(req);
    const params = new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'identify', state,
    });
    return res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
  });

  router.get('/', requireMember, (req, res) => {
    if (!req.session.shopCsrfToken) req.session.shopCsrfToken = crypto.randomBytes(32).toString('hex');
    let directory = null;
    let error = null;
    try {
      directory = buildShopDirectory(getGuildId());
    } catch {
      error = 'Les liens Discord ne sont pas encore configurés. Contacte un administrateur.';
      res.status(503);
    }
    res.render('member-shop', { directory, error, csrfToken: req.session.shopCsrfToken });
  });

  router.post('/deconnexion', (req, res, next) => {
    if (!sameToken(req.body?.csrfToken, req.session?.shopCsrfToken)) {
      return res.status(403).send('Déconnexion refusée. Recharge la page et réessaie.');
    }
    req.session.destroy(err => {
      if (err) return next(err);
      res.redirect('/boutique/connexion');
    });
  });

  async function handleOAuthCallback(req, res, next) {
    const pending = req.session?.shopOAuth;
    // Keep the existing staff/admin password + OAuth flow separate and unchanged.
    if (!pending || sameToken(req.query.state, req.session.oauthState)) return next();
    const { code, state } = req.query;
    if (typeof code !== 'string' || !code || code.length > 2048 ||
        !sameToken(state, pending.state) || !(pending.expiresAt > now())) {
      delete req.session.shopOAuth;
      return loginError(res, 'Authentification Discord échouée. Réessaie.');
    }
    // Consume the state before network I/O: it may not be reused.
    delete req.session.shopOAuth;
    try {
      await saveSession(req);
      const { clientId, clientSecret } = getOAuthConfig();
      if (!clientId || !clientSecret) throw new Error('OAuth non configuré');
      const token = await axiosClient.post('https://discord.com/api/oauth2/token', new URLSearchParams({
        client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code',
        code, redirect_uri: pending.redirectUri,
      }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 });
      if (typeof token.data?.access_token !== 'string' || !token.data.access_token) throw new Error('Token absent');
      const response = await axiosClient.get('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${token.data.access_token}` }, timeout: 10000,
      });
      const user = response.data;
      if (!user || typeof user.id !== 'string' || !DISCORD_ID.test(user.id) || typeof user.username !== 'string') {
        throw new Error('Identité Discord invalide');
      }
      const member = {
        id: user.id,
        username: user.username,
        displayName: (user.global_name || user.username).slice(0, 100),
        avatar: typeof user.avatar === 'string' && /^(a_)?[a-f0-9]{32}$/.test(user.avatar)
          ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64` : null,
      };
      // Rotate the session ID. Preserve only pre-existing server-granted dashboard
      // access; member sign-in itself never sets authenticated, discordUser or role.
      const retained = {};
      for (const key of ['authenticated', 'discordUser', 'role', 'sessionGen', 'pendingRole', 'pendingLola', 'oauthState']) {
        if (req.session[key] !== undefined) retained[key] = req.session[key];
      }
      const generation = await getSessionGeneration();
      await regenerateSession(req);
      Object.assign(req.session, retained, {
        shopDiscordUser: member,
        shopSessionGen: generation,
        shopCsrfToken: crypto.randomBytes(32).toString('hex'),
      });
      await saveSession(req);
      return res.redirect('/boutique');
    } catch (err) {
      // Never log OAuth request bodies, headers, codes, tokens or Discord PII.
      console.warn('[MemberShop] Connexion Discord échouée', err.response?.status || 'auth');
      return loginError(res, 'La connexion Discord a échoué. Réessaie dans un instant.');
    }
  }

  return { router, handleOAuthCallback };
}

module.exports = { createMemberShop, buildShopDirectory, getMember, sameToken };
