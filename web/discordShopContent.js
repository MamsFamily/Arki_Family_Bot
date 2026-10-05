'use strict';

const { REST, Routes, PermissionFlagsBits } = require('discord.js');
const { DISCORD_ID } = require('./shopDirectory');

const ASSET_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net',
  'images-ext-1.discordapp.net', 'images-ext-2.discordapp.net']);

function safeAssetUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ASSET_HOSTS.has(url.hostname) &&
      !url.username && !url.password && (!url.port || url.port === '443') ? url.href : null;
  } catch { return null; }
}

function isoDate(value) {
  if (!value || typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizeMessage(message, guildId, channelId) {
  if (!message || typeof message.id !== 'string' || !DISCORD_ID.test(message.id)) return null;
  const parts = [typeof message.content === 'string' ? message.content : ''];
  const images = [];
  const files = [];
  function image(value, alt) {
    const url = safeAssetUrl(value);
    if (url && !images.some(i => i.url === url)) images.push({ url, alt: String(alt || 'Image du salon Discord').slice(0, 256) });
  }
  for (const embed of (message.embeds || []).slice(0, 10)) {
    if (typeof embed.title === 'string') parts.push(embed.title);
    if (typeof embed.description === 'string') parts.push(embed.description);
    for (const field of (embed.fields || []).slice(0, 25)) {
      if (typeof field.name === 'string') parts.push(field.name);
      if (typeof field.value === 'string') parts.push(field.value);
    }
    image(embed.image?.proxy_url || embed.image?.url, embed.title);
    image(embed.thumbnail?.proxy_url || embed.thumbnail?.url, embed.title);
  }
  for (const attachment of (message.attachments || []).slice(0, 10)) {
    const url = safeAssetUrl(attachment.url);
    if (!url) continue;
    const name = String(attachment.filename || 'Fichier Discord').slice(0, 256);
    if (/^image\/(png|jpe?g|gif|webp|avif)$/i.test(attachment.content_type || '') ||
        /\.(png|jpe?g|gif|webp|avif)$/i.test(name)) {
      image(attachment.proxy_url || url, name);
    } else {
      files.push({ url, name });
    }
  }
  const text = parts.filter(Boolean).join('\n\n').slice(0, 12000);
  if (!text && !images.length && !files.length) return null;
  return {
    id: message.id, url: `https://discord.com/channels/${guildId}/${channelId}/${message.id}`,
    text, images, files, postedAt: isoDate(message.timestamp), editedAt: isoDate(message.edited_timestamp),
  };
}

function canReadChannel(channel, guild, member, roles) {
  if (!channel || channel.guild_id !== guild.id || ![0, 5].includes(channel.type) ||
      !member?.user?.id || !Array.isArray(member.roles) || !Array.isArray(roles)) return false;
  if (member.user.id === guild.owner_id) return true;
  const roleIds = new Set([guild.id, ...member.roles]);
  let permissions = 0n;
  for (const role of roles) if (roleIds.has(role.id)) permissions |= BigInt(role.permissions);
  if (permissions & PermissionFlagsBits.Administrator) return true;
  if (!Array.isArray(channel.permission_overwrites)) return false;
  const everyone = channel.permission_overwrites.find(o => o.type === 0 && o.id === guild.id);
  if (everyone) permissions = (permissions & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
  let deny = 0n;
  let allow = 0n;
  for (const overwrite of channel.permission_overwrites) {
    if (overwrite.type === 0 && overwrite.id !== guild.id && roleIds.has(overwrite.id)) {
      deny |= BigInt(overwrite.deny);
      allow |= BigInt(overwrite.allow);
    }
  }
  permissions = (permissions & ~deny) | allow;
  const personal = channel.permission_overwrites.find(o => o.type === 1 && o.id === member.user.id);
  if (personal) permissions = (permissions & ~BigInt(personal.deny)) | BigInt(personal.allow);
  const required = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory;
  return (permissions & required) === required;
}

class DiscordShopContentApi {
  constructor() { this.rest = null; }
  getRest() {
    if (!this.rest) {
      if (!process.env.DISCORD_TOKEN) throw new Error('Bot indisponible');
      this.rest = new REST({ version: '10', timeout: 15000, retries: 1 }).setToken(process.env.DISCORD_TOKEN);
    }
    return this.rest;
  }
  getCurrentUser() { return this.getRest().get(Routes.user('@me')); }
  getGuild(id) { return this.getRest().get(Routes.guild(id)); }
  getRoles(id) { return this.getRest().get(Routes.guildRoles(id)); }
  getMember(guildId, id) { return this.getRest().get(Routes.guildMember(guildId, id)); }
  getChannel(id) { return this.getRest().get(Routes.channel(id)); }
  getMessages(id, before, limit = 100) {
    return this.getRest().get(Routes.channelMessages(id), {
      query: new URLSearchParams({ limit: String(limit), ...(before ? { before } : {}) }),
    });
  }
}

module.exports = { DiscordShopContentApi, normalizeMessage, canReadChannel, safeAssetUrl, isoDate };
