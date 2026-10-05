'use strict';

const SHOP_CHANNELS = Object.freeze([
  { key: 'infos', title: 'Côté infos shop', description: 'Les informations utiles avant de passer commande.', id: '1485051049654878379' },
  { key: 'petit-shop', title: 'Le p’tit shop', description: 'Découvre les articles du p’tit shop.', id: '1485051177845657771' },
  { key: 'packs', title: 'Les packs', description: 'Consulte les packs disponibles sur Discord.', id: '1485051269977739334' },
  { key: 'dinos', title: 'Dino shop', description: 'Retrouve les dinos proposés au shop.', id: '1485051399589855382' },
]);
const DONATION_INFO_CHANNEL = '1160538476224196628';
const SOURCE_CHANNELS = Object.freeze([...SHOP_CHANNELS, {
  key: 'donations', title: 'Dons', id: DONATION_INFO_CHANNEL,
}]);
const DISCORD_ID = /^\d{17,20}$/;

function buildShopDirectory(guildId) {
  if (typeof guildId !== 'string' || !DISCORD_ID.test(guildId)) {
    throw new Error('Identifiant du serveur Discord non configuré.');
  }
  const channelUrl = id => `https://discord.com/channels/${guildId}/${id}`;
  return {
    categories: SHOP_CHANNELS.map(({ id, ...category }) => ({ ...category, url: channelUrl(id) })),
    orderUrl: channelUrl('1156938232244752494'),
    donations: {
      infoUrl: channelUrl(DONATION_INFO_CHANNEL),
      ticketUrl: channelUrl('1156938293586427934'),
    },
  };
}

module.exports = { buildShopDirectory, SOURCE_CHANNELS, DISCORD_ID };
