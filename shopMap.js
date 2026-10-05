'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');

const SHOP_MAP_BUTTON_ID = 'st_view_shop_map';
const SHOP_MAP_FILENAME = 'shop-map-valguero.jpeg';
const SHOP_MAP_PATH = path.join(__dirname, 'web', 'public', 'images', SHOP_MAP_FILENAME);

function buildShopMapButton() {
  return new ButtonBuilder()
    .setCustomId(SHOP_MAP_BUTTON_ID)
    .setLabel('Voir la carte du shop')
    .setStyle(ButtonStyle.Secondary);
}

function buildShopMapRow() {
  return new ActionRowBuilder().addComponents(buildShopMapButton());
}

async function showShopMap(interaction, { access = fs.access } = {}) {
  // Acknowledge before file I/O. The response belongs only to the person clicking.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    await access(SHOP_MAP_PATH);
  } catch {
    return interaction.editReply({
      content: 'La carte du shop est momentanément indisponible. Contacte un administrateur.',
    });
  }
  return interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('Carte du shop — Valguero')
      .setDescription('Repère indiqué sur la carte : **60 / 92**.\nClique sur l’image pour l’agrandir.')
      .setImage(`attachment://${SHOP_MAP_FILENAME}`)],
    files: [{ attachment: SHOP_MAP_PATH, name: SHOP_MAP_FILENAME }],
  });
}

module.exports = { SHOP_MAP_BUTTON_ID, SHOP_MAP_FILENAME, SHOP_MAP_PATH,
  buildShopMapButton, buildShopMapRow, showShopMap };
