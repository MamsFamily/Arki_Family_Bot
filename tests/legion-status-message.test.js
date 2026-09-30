'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pgStore = require('../pgStore');
const legion = require('../web/legionManager');
const board = require('../web/legionStatusMessage');

test('affiche les 12 cartes avec états distincts sans inventer des joueurs', () => {
  const servers = legion.MAPS.map((map, index) => ({
    ...map, state: ['running', 'restarting', 'offline', 'unknown'][index % 4],
  }));
  const text = board.render(servers, new Date('2026-09-30T10:00:00Z'));
  assert.equal(text.split('\n').filter(row => /^(🟢|🟠|🔴|⚪)/u.test(row)).length, 12);
  assert.match(text, /🟢 \*\*VALGUERO\*\* — En ligne · Joueurs : indisponible/);
  assert.match(text, /🟠 \*\*GENESIS\*\* — Redémarrage/);
  assert.match(text, /🔴 \*\*ASTRAEOS\*\* — Hors ligne/);
  assert.match(text, /⚪ \*\*THE ISLAND\*\* — État indisponible/);
  assert.doesNotMatch(text, /(?:0\/25|2\/25)/);
  assert.match(text, /Dernier relevé : <t:1790762400:R>/);
});

test('actualise le même message et ne le recrée que si Discord confirme sa suppression', async () => {
  const original = {
    isPostgres: pgStore.isPostgres, getData: pgStore.getData, setData: pgStore.setData,
    getServers: legion.getServers,
  };
  let saved = { channelId: '123', messageId: '456' };
  let edits = 0;
  let sends = 0;
  let missing = false;
  let failed = false;
  const message = { edit: async () => { edits++; } };
  const channel = {
    id: '123', isTextBased: () => true,
    messages: { fetch: async () => {
      if (failed) throw new Error('Discord indisponible');
      if (missing) throw { code: 10008 };
      return message;
    } },
    send: async () => { sends++; return { id: '789', delete: async () => {} }; },
  };
  pgStore.isPostgres = () => true;
  pgStore.getData = async () => saved;
  pgStore.setData = async (_key, config) => { saved = config; return true; };
  legion.getServers = async () => legion.MAPS.map(map => ({ ...map, state: 'running' }));
  try {
    const client = { channels: { fetch: async () => channel } };
    await board.refresh(client);
    await board.refresh(client);
    assert.equal(edits, 2);
    assert.equal(sends, 0);
    failed = true;
    await assert.rejects(() => board.refresh(client), /Discord indisponible/);
    assert.equal(sends, 0);
    failed = false;
    missing = true;
    await board.refresh(client);
    assert.equal(sends, 1);
    assert.deepEqual(saved, { channelId: '123', messageId: '789' });
  } finally {
    Object.assign(pgStore, {
      isPostgres: original.isPostgres, getData: original.getData, setData: original.setData,
    });
    legion.getServers = original.getServers;
  }
});

test('une panne GPanel affiche un état indisponible, jamais hors ligne', async () => {
  const original = {
    isPostgres: pgStore.isPostgres, getData: pgStore.getData, getServers: legion.getServers,
  };
  let text;
  pgStore.isPostgres = () => true;
  pgStore.getData = async () => ({ channelId: '123', messageId: '456' });
  legion.getServers = async () => { throw new Error('GPanel indisponible'); };
  try {
    await board.refresh({ channels: { fetch: async () => ({
      id: '123', isTextBased: () => true,
      messages: { fetch: async () => ({ edit: async payload => { text = payload.content; } }) },
      send: async () => assert.fail('Ne doit pas créer un nouveau message'),
    }) } });
    assert.equal((text.match(/⚪/gu) || []).length, 12);
    assert.doesNotMatch(text, /🔴|0\/25/);
  } finally {
    pgStore.isPostgres = original.isPostgres;
    pgStore.getData = original.getData;
    legion.getServers = original.getServers;
  }
});

test('la commande admin configure un seul message dans le salon choisi, puis le réutilise', async () => {
  const original = {
    isPostgres: pgStore.isPostgres, getData: pgStore.getData, setData: pgStore.setData,
    getServers: legion.getServers,
  };
  let saved = null;
  let sends = 0;
  let edits = 0;
  let reply = '';
  pgStore.isPostgres = () => true;
  pgStore.getData = async () => saved;
  pgStore.setData = async (_key, config) => { saved = config; return true; };
  legion.getServers = async () => [];
  const message = { edit: async () => { edits++; } };
  const channel = {
    id: '123', isTextBased: () => true,
    send: async () => { sends++; return { id: '456', delete: async () => {} }; },
    messages: { fetch: async () => message },
  };
  const interaction = {
    member: { permissions: { has: () => true } },
    guildId: 'guild', channelId: '123',
    client: { channels: { fetch: async () => channel } },
    deferReply: async () => {},
    editReply: async text => { reply = text; },
  };
  try {
    await board.publish(interaction);
    assert.deepEqual(saved, { channelId: '123', messageId: '456' });
    await board.publish(interaction);
    assert.equal(sends, 1);
    assert.equal(edits, 1);
    assert.match(reply, /Actualisation chaque minute/);
    let rejected;
    await board.publish({
      ...interaction, member: { permissions: { has: () => false }, roles: { cache: { some: () => false } } },
      reply: async payload => { rejected = payload; },
    });
    assert.match(rejected.content, /Réservé aux administrateurs/);
    assert.equal(rejected.ephemeral, true);
    assert.equal(sends, 1);
  } finally {
    Object.assign(pgStore, {
      isPostgres: original.isPostgres, getData: original.getData, setData: original.setData,
    });
    legion.getServers = original.getServers;
  }
});