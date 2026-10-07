'use strict';
const express = require('express');
const { createHash, timingSafeEqual } = require('node:crypto');
const { withVariantPrices } = require('../dinoPricing');
const legion = require('../web/legionManager');

class BridgeError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const snowflake = value => typeof value === 'string' && /^\d{17,20}$/.test(value);
const text = value => typeof value === 'string' ? value.slice(0, 500) : '';
const amount = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const list = value => Array.isArray(value) ? value : [];
const price = value => ({ diamonds: amount(value.priceDiamonds), strawberries: amount(value.priceStrawberries) });
const PUBLIC_MAP_STATUS_SLUGS = Object.freeze({
  '9e151580': 'valguero',
  '7c110bf0': 'genesis',
  '27d0aeff': 'astraeos',
  'd8d6185e': 'the-island',
  '8efe82b3': 'ragnarok',
  '8e262f7c': 'lost-colony',
  '686c087f': 'aberration',
  '988af27d': 'scorched-earth',
  'e4d5b19e': 'extinction',
  'b59b0253': 'ragnarok-event',
  '6c0e3a89': 'svartalfheim',
  'cf79fe13': 'the-center',
});

function publicMapState(state) {
  switch (String(state || '').toLowerCase()) {
    case 'running': return 'running';
    case 'restarting': return 'restarting';
    case 'starting': return 'starting';
    case 'stopping': return 'stopping';
    case 'offline':
    case 'stopped': return 'offline';
    case 'suspended': return 'suspended';
    default: return 'unknown';
  }
}

function product(value, type) {
  if (type === 'dino') value = withVariantPrices(value);
  return {
    id: text(value.id), name: text(value.name), type, description: text(value.description),
    category: text(value.category) || type, prices: [{ label: 'Standard', ...price(value) },
      ...list(value.variants).filter(v => !v.hidden && !v.notAvailableShop).map(v => ({ label: text(v.label), ...price(v) })),
      ...list(value.options).map(v => ({ label: text(v.label || v.name), ...price(v) }))],
    noReduction: !!value.noReduction,
  };
}
function order(row, guildId, staff = false) {
  const data = row.data || {};
  return {
    id: String(row.order_id), status: text(row.status), createdAt: Number(row.created_at),
    discountPercent: amount(data.discount),
    items: list(data.cart?.items).map(i => ({
      name: text(i.name), type: text(i.type), quantity: amount(i.quantity || 1),
      variant: text(i.variantLabel), sex: text(i.sexe), stat: text(i.stat), ...price(i),
    })),
    ticketUrl: snowflake(row.channel_id) ? `https://discord.com/channels/${guildId}/${row.channel_id}` : null,
    ...(staff ? { discordUserId: String(row.user_id), customerName: text(row.username) } : {}),
  };
}

function createBridgeRouter({
  store = require('../pgStore'),
  settings = require('../settingsManager'),
  legionApi = legion,
  fetchImpl = fetch,
  config = () => ({ token: process.env.NEXUS_BRIDGE_TOKEN, enabled: process.env.NEXUS_BRIDGE_ENABLED === 'true',
    discordToken: process.env.DISCORD_TOKEN }),
} = {}) {
  const router = express.Router();
  const buckets = new Map();
  let mapStatusCache = null;
  let mapStatusCacheUntil = 0;
  let mapStatusInFlight = null;
  const readPublicMapStatus = async () => {
    if (mapStatusCache && Date.now() < mapStatusCacheUntil) return mapStatusCache;
    if (!mapStatusInFlight) {
      mapStatusInFlight = (async () => {
        const servers = await legionApi.getServers();
        if (!Array.isArray(servers)) throw new Error('Invalid GPanel server list');
        const byId = new Map(servers.filter(server => server && typeof server.id === 'string').map(server => [server.id, server]));
        const maps = Object.entries(PUBLIC_MAP_STATUS_SLUGS).map(([id, slug]) => ({
          slug,
          state: publicMapState(byId.get(id)?.state),
        }));
        const snapshot = { schemaVersion: 1, checkedAt: new Date().toISOString(), maps };
        mapStatusCache = snapshot;
        mapStatusCacheUntil = Date.now() + 20000;
        return snapshot;
      })();
    }
    try { return await mapStatusInFlight; }
    finally { mapStatusInFlight = null; }
  };
  router.use(async (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    try {
      if (req.method !== 'GET') throw new BridgeError(405, 'Liaison en lecture seule.');
      const cfg = config();
      if (!cfg.enabled || !cfg.token || cfg.token.length < 32) throw new BridgeError(503, 'Liaison Lenexus non configurée.');
      const supplied = /^Bearer ([^\s]+)$/i.exec(req.get('authorization') || '')?.[1] || '';
      const hash = v => createHash('sha256').update(v).digest();
      if (!timingSafeEqual(hash(supplied), hash(cfg.token))) throw new BridgeError(401, 'Accès refusé.');
      // Public website status is read-only and intentionally returns only the
      // twelve approved map slugs and normalized state; no actor or DB is needed.
      if (req.path === '/map-status') {
        req.bridge = { publicMapStatus: true };
        return next();
      }
      const actor = req.get('X-Arki-Actor-Id');
      const guild = req.get('X-Arki-Guild-Id');
      const configuredGuild = settings.getSettings().guild?.guildId;
      if (!snowflake(actor) || !snowflake(guild)) throw new BridgeError(400, 'Identité Discord invalide.');
      if (!snowflake(configuredGuild) || guild !== configuredGuild) throw new BridgeError(403, 'Serveur Discord non autorisé.');
      if (!cfg.discordToken || !store.isPostgres()) throw new BridgeError(503, 'Source ArkiFamily indisponible.');
      const now = Date.now();
      for (const [key, bucket] of buckets) if (now >= bucket.until) buckets.delete(key);
      const bucket = buckets.get(actor) || { count: 0, until: now + 60000 };
      if (buckets.size >= 10000 || ++bucket.count > 60) throw new BridgeError(429, 'Trop de demandes. Réessayez dans une minute.');
      buckets.set(actor, bucket);
      async function discord(path) {
        const response = await fetchImpl(`https://discord.com/api/v10${path}`, {
          headers: { Authorization: `Bot ${cfg.discordToken}` }, signal: AbortSignal.timeout(8000),
          redirect: 'error',
        });
        if (response.status === 404) throw new BridgeError(403, 'Accès réservé aux membres du serveur.');
        if (!response.ok) throw new BridgeError(503, 'Vérification Discord indisponible.');
        return response.json();
      }
      const member = await discord(`/guilds/${guild}/members/${actor}`);
      if (member.user?.id !== actor || member.user?.bot) throw new BridgeError(403, 'Compte joueur non autorisé.');
      req.bridge = { actor, guild, member, discord };
      next();
    } catch (error) { next(error); }
  });
  const read = key => store.getData(key, undefined, { throwOnError: true });
  const metadata = guild => ({ schemaVersion: 1, guildId: guild, fetchedAt: new Date().toISOString() });

  router.get('/map-status', async (_req, res, next) => {
    try { res.json(await readPublicMapStatus()); }
    catch (error) { next(error); }
  });
  router.get('/account', async (req, res, next) => {
    try {
      const { actor, guild } = req.bridge;
      // Always derive the subject from the trusted server assertion; ignore query IDs.
      const [inventories, types, transactions, orders, spawn, reclaim] = await Promise.all([
        read('inventory_data'), read('inventory_item_types'), read('inventory_transactions'),
        store.getPool().query('SELECT order_id,user_id,username,channel_id,status,created_at,data FROM shop_orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [actor]),
        store.getPool().query('SELECT ticket_id,channel_id,status,created_at FROM spawn_tickets WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [actor]),
        store.getPool().query('SELECT ticket_id,channel_id,status,created_at FROM reclaim_tickets WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [actor]),
      ]);
      if (!inventories || !Array.isArray(types)) throw new BridgeError(503, 'Inventaire non initialisé.');
      const own = inventories[actor] || {};
      const inventory = Object.entries(own).map(([id, quantity]) => {
        const type = types.find(t => t.id === id);
        return { id, name: text(type?.name) || id, category: text(type?.category), quantity: amount(quantity) };
      });
      const tickets = [ ...orders.rows.map(r => ({ ...r, ticket_id: r.order_id, kind: 'shop' })),
        ...spawn.rows.map(r => ({ ...r, kind: 'spawn' })), ...reclaim.rows.map(r => ({ ...r, kind: 'reclaim' })) ]
        .map(r => ({ id: String(r.ticket_id), kind: r.kind, status: text(r.status), createdAt: Number(r.created_at),
          url: snowflake(r.channel_id) ? `https://discord.com/channels/${guild}/${r.channel_id}` : null }));
      const activity = list(transactions).filter(t => t.playerId === actor).slice(-30).reverse()
        .map(t => ({ action: text(t.type || t.action), itemId: text(t.itemTypeId), quantity: amount(t.quantity), timestamp: text(t.timestamp) }));
      res.json({ ...metadata(guild), discordUserId: actor, inventory, orders: orders.rows.map(r => order(r, guild)), tickets, activity });
    } catch (error) { next(error); }
  });
  router.get('/catalog', async (req, res, next) => {
    try {
      const [shop, dinos] = await Promise.all([read('shop'), read('dinos')]);
      if (!shop || !dinos) throw new BridgeError(503, 'Catalogue non initialisé.');
      res.json({ ...metadata(req.bridge.guild),
        pricingNotice: 'Prix de base et variantes. Les réductions et promotions sont calculées dans le ticket Discord.',
        products: [...list(shop.packs).filter(p => !p.hidden && !p.notAvailableShop).map(p => product(p, 'pack')),
          ...list(dinos.dinos).filter(d => !d.hidden && !d.notAvailableShop).map(d => product(d, 'dino'))] });
    } catch (error) { next(error); }
  });
  router.get('/staff', async (req, res, next) => {
    try {
      const { actor, guild, member, discord } = req.bridge;
      const [shop, guildInfo, roles] = await Promise.all([read('shop'), discord(`/guilds/${guild}`), discord(`/guilds/${guild}/roles`)]);
      const allowed = list(shop?.shopTicketAdminRoleIds);
      const admin = guildInfo.owner_id === actor || roles.some(r =>
        (r.id === guild || list(member.roles).includes(r.id)) && (BigInt(r.permissions || '0') & 8n) !== 0n);
      if (!admin && !list(member.roles).some(r => allowed.includes(r))) throw new BridgeError(403, 'Accès réservé au staff shop autorisé.');
      const page = req.query.page === undefined ? 1 : Number(req.query.page);
      if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw new BridgeError(400, 'Page invalide.');
      const result = await store.getPool().query(
        'SELECT order_id,user_id,username,channel_id,status,created_at,data FROM shop_orders ORDER BY created_at DESC LIMIT 51 OFFSET $1',
        [(page - 1) * 50]);
      res.json({ ...metadata(guild), page, hasMore: result.rows.length > 50, orders: result.rows.slice(0, 50).map(r => order(r, guild, true)) });
    } catch (error) { next(error); }
  });
  router.use((error, _req, res, _next) => {
    const status = error instanceof BridgeError ? error.status : 503;
    if (status === 405) res.set('Allow', 'GET');
    res.status(status).json({ error: error instanceof BridgeError ? error.message : 'Source ArkiFamily momentanément indisponible.' });
  });
  return router;
}
module.exports = { createBridgeRouter, BridgeError, product, order };
