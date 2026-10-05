'use strict';

const cron = require('node-cron');
const pgStore = require('../pgStore');
const { SOURCE_CHANNELS, DISCORD_ID } = require('./shopDirectory');
const { DiscordShopContentApi, normalizeMessage, canReadChannel } = require('./discordShopContent');

const SCHEDULE_LABEL = 'Tous les jours à 06h00 (heure de Paris)';
const MAX_MESSAGES = 500;
const RETRY_MS = 60 * 60 * 1000;

function dailySlot(timestamp) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestamp)).map(p => [p.type, p.value]));
  const date = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  if (Number(parts.hour) < 6) date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

async function withPgLock(key, work) {
  const pool = pgStore.getPool();
  if (!pool) throw new Error('Stockage de synchronisation indisponible');
  const client = await pool.connect();
  let locked = false;
  let releaseError;
  try {
    const result = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [key]);
    locked = result.rows[0]?.locked === true;
    if (!locked) return { status: 'busy' };
    return await work();
  } finally {
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
    } catch (err) { releaseError = err; }
    client.release(releaseError);
  }
}

function createShopContentSync({
  getGuildId, store = pgStore, api = new DiscordShopContentApi(),
  now = Date.now, withLock = withPgLock,
}) {
  let inFlight = null;
  let failureCooldownUntil = 0;
  const keyFor = guildId => `member_shop_discord_snapshot:v1:${guildId}`;
  function guildId() {
    const value = getGuildId();
    if (typeof value !== 'string' || !DISCORD_ID.test(value)) throw new Error('Serveur Discord non configuré');
    return value;
  }
  async function read(id) {
    const value = await store.getData(keyFor(id), null, { throwOnError: true });
    return value?.version === 1 && value.guildId === id ? value : {
      version: 1, guildId: id, channels: {}, completedSlot: null, lastAttemptSlot: null, retryAt: 0,
    };
  }
  async function save(snapshot) {
    if (!await store.setData(keyFor(snapshot.guildId), snapshot)) throw new Error('Sauvegarde de synchronisation refusée');
  }
  function due(snapshot) {
    const slot = dailySlot(now());
    return snapshot.completedSlot !== slot &&
      !(snapshot.lastAttemptSlot === slot && snapshot.retryAt > now());
  }

  async function fetchChannel(source, guild, roles, botMember) {
    const channel = await api.getChannel(source.id);
    if (!canReadChannel(channel, guild, botMember, roles)) throw new Error('Lecture du salon refusée');
    const collected = [];
    const seen = new Set();
    let before;
    let truncated = false;
    for (;;) {
      const batch = await api.getMessages(source.id, before);
      if (!Array.isArray(batch)) throw new Error('Historique invalide');
      for (const message of batch) {
        if (!DISCORD_ID.test(message.id) || seen.has(message.id)) continue;
        seen.add(message.id);
        const normalized = normalizeMessage(message, guild.id, source.id);
        if (normalized) collected.push(normalized);
      }
      if (batch.length < 100) break;
      const cursor = batch[batch.length - 1]?.id;
      if (typeof cursor !== 'string' || !DISCORD_ID.test(cursor) ||
          (before && BigInt(cursor) >= BigInt(before))) throw new Error('Pagination bloquée');
      if (seen.size >= MAX_MESSAGES) {
        const older = await api.getMessages(source.id, cursor, 1);
        if (!Array.isArray(older)) throw new Error('Historique invalide');
        truncated = older.length > 0;
        break;
      }
      before = cursor;
    }
    collected.sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : BigInt(a.id) < BigInt(b.id) ? 1 : 0);
    return { name: String(channel.name || source.title).slice(0, 100),
      messages: collected.slice(0, MAX_MESSAGES), truncated, syncedAt: new Date(now()).toISOString(), error: null };
  }

  async function performSync() {
    const id = guildId();
    if (!due(await read(id))) return { status: 'fresh' };
    return withLock(keyFor(id), async () => {
      const snapshot = await read(id); // Recheck after acquiring the cross-process lock.
      if (!due(snapshot)) return { status: 'fresh' };
      const slot = dailySlot(now());
      snapshot.lastAttemptSlot = slot;
      snapshot.lastAttemptAt = new Date(now()).toISOString();
      snapshot.retryAt = now() + RETRY_MS;
      await save(snapshot);
      let guild, roles, botMember;
      try {
        const bot = await api.getCurrentUser();
        [guild, roles, botMember] = await Promise.all([api.getGuild(id), api.getRoles(id), api.getMember(id, bot.id)]);
        if (guild.id !== id) throw new Error('Serveur incohérent');
      } catch {
        for (const source of SOURCE_CHANNELS) {
          snapshot.channels[source.key] = { ...snapshot.channels[source.key], error: 'discord_unavailable' };
        }
        await save(snapshot);
        return { status: 'failed', successful: 0, failed: SOURCE_CHANNELS.length };
      }
      let successful = 0;
      for (const source of SOURCE_CHANNELS) {
        if (snapshot.channels[source.key]?.syncedSlot === slot && !snapshot.channels[source.key]?.error) {
          successful++;
          continue;
        }
        try {
          snapshot.channels[source.key] = await fetchChannel(source, guild, roles, botMember);
          snapshot.channels[source.key].syncedSlot = slot;
          successful++;
        } catch {
          // Never replace a last good publication with an error or a fake empty list.
          snapshot.channels[source.key] = { ...snapshot.channels[source.key], error: 'channel_unavailable' };
        }
      }
      if (successful === SOURCE_CHANNELS.length) snapshot.completedSlot = slot;
      await save(snapshot);
      return { status: successful === SOURCE_CHANNELS.length ? 'updated' : 'partial',
        successful, failed: SOURCE_CHANNELS.length - successful };
    });
  }

  function refreshIfDue() {
    if (now() < failureCooldownUntil) return Promise.resolve({ status: 'cooldown' });
    if (!inFlight) inFlight = performSync().catch(err => {
      failureCooldownUntil = now() + 5 * 60 * 1000;
      throw err;
    }).finally(() => { inFlight = null; });
    return inFlight;
  }
  const safeLogFailure = () => console.warn('[MemberShop] Synchronisation indisponible ; les dernières publications sont conservées.');

  async function getForMember(userId) {
    const result = { scheduleLabel: SCHEDULE_LABEL, lastUpdatedAt: null,
      lastAttemptAt: null, warning: null, channels: {} };
    try {
      const id = guildId();
      const snapshot = await read(id);
      if (due(snapshot)) refreshIfDue().catch(safeLogFailure); // Catch up if a sleeping instance missed 06h.
      result.lastAttemptAt = snapshot.lastAttemptAt || null;
      // A bot can read more than a player. Never republish its cache to a player
      // without verifying that player's CURRENT guild and channel permissions.
      const [guild, roles, member] = await Promise.all([api.getGuild(id), api.getRoles(id), api.getMember(id, userId)]);
      if (guild.id !== id || member.user?.id !== userId) throw new Error('Membre non vérifié');
      for (const source of SOURCE_CHANNELS) {
        let allowed = false;
        try { allowed = canReadChannel(await api.getChannel(source.id), guild, member, roles); } catch {}
        const cached = snapshot.channels[source.key];
        result.channels[source.key] = !allowed
          ? { status: 'forbidden', messages: [], truncated: false }
          : cached?.syncedAt ? { ...cached, status: cached.error ? 'stale' : 'ok' }
            : { status: cached?.error ? 'unavailable' : 'pending', messages: [], truncated: false };
        if (allowed && cached?.syncedAt &&
            (!result.lastUpdatedAt || cached.syncedAt < result.lastUpdatedAt)) result.lastUpdatedAt = cached.syncedAt;
      }
      if (Object.values(result.channels).some(c => ['stale', 'unavailable'].includes(c.status))) {
        result.warning = 'Certains salons n’ont pas pu être actualisés. Les dernières publications disponibles sont signalées ci-dessous.';
      }
    } catch {
      result.warning = 'Le contenu Discord est momentanément inaccessible pour ce compte. Les liens vers Discord restent disponibles.';
    }
    return result;
  }

  function start({ ready = Promise.resolve() } = {}) {
    // Poll hourly for retries/missed slots, but a successful synchronization occurs
    // only once per Paris day (06h). PostgreSQL arbitrates Replit/Railway instances.
    const task = cron.schedule('0 * * * *', () => refreshIfDue().catch(safeLogFailure), { timezone: 'Europe/Paris' });
    ready.then(() => refreshIfDue()).catch(safeLogFailure);
    return task;
  }
  return { refreshIfDue, getForMember, start };
}

module.exports = { createShopContentSync, dailySlot, withPgLock, MAX_MESSAGES, SCHEDULE_LABEL };
