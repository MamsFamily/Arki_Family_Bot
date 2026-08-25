import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
} from "discord.js";
import { economyService } from "../economy/EconomyService";
import { getTodayWeather, getWeatherEmoji } from "../sun/weather";
import { getCooldown, setCooldown, formatCooldown } from "../sun/cooldown";
import { requireChannel } from "../core/channel-guard";
import { getChannelId } from "../core/config-db";
import { v4 as uuidv4 } from "uuid";
import { DateTime } from "luxon";

const TZ = "Europe/Paris";

export const data = new SlashCommandBuilder()
  .setName("soleil-duo")
  .setDescription("☀️ Soleils — Offre des Soleils à un autre joueur")
  .addUserOption((opt) =>
    opt.setName("joueur").setDescription("Le joueur à arroser de Soleils").setRequired(true)
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (await requireChannel(interaction, "sun_farm")) return;

  // Vérifier le salon dédié si configuré
  const sunFarmChannelId = await getChannelId("sun_farm");
  if (sunFarmChannelId && interaction.channelId !== sunFarmChannelId) {
    await interaction.editReply({
      content: `☀️ Les échanges de Soleils se font dans <#${sunFarmChannelId}> !`,
    });
    return;
  }

  const initiatorId = interaction.user.id;
  const target = interaction.options.getUser("joueur", true);

  if (target.id === initiatorId) {
    await interaction.editReply({ content: "❌ Tu ne peux pas te donner des Soleils à toi-même !" });
    return;
  }
  if (target.bot) {
    await interaction.editReply({ content: "❌ Tu ne peux pas offrir des Soleils à un bot !" });
    return;
  }

  // ── Vérification cooldowns (lecture seule, rien posé en base) ───────────
  const initiatorCooldown = await getCooldown(initiatorId, "soleil-duo-initiator");
  if (initiatorCooldown) {
    await interaction.editReply({
      content: `⏳ Tu dois attendre encore **${formatCooldown(initiatorCooldown)}** avant d'offrir à nouveau !`,
    });
    return;
  }

  const recipientCooldown = await getCooldown(target.id, "soleil-duo-recipient");
  if (recipientCooldown) {
    await interaction.editReply({
      content: `⏳ ${target.displayName} ne peut pas encore recevoir de duo (encore **${formatCooldown(recipientCooldown)}**) !`,
    });
    return;
  }

  const weather = await getTodayWeather();
  const totalInitiator = Math.floor((Math.floor(Math.random() * 6) + 5) * weather.multiplier);
  const totalTarget = Math.floor((Math.floor(Math.random() * 6) + 5) * weather.multiplier);

  const eventId = uuidv4();
  await economyService.credit(initiatorId, totalInitiator, "soleil-duo", `sun-duo:${eventId}:${initiatorId}`);
  await economyService.credit(target.id, totalTarget, "soleil-duo", `sun-duo:${eventId}:${target.id}`);

  // Cooldowns posés ICI, uniquement après que les deux crédits ont réussi
  await setCooldown(initiatorId, "soleil-duo-initiator", 180);
  await setCooldown(target.id, "soleil-duo-recipient", 30);

  const weatherEmoji = getWeatherEmoji(weather.weather);
  const balInitiator = await economyService.getBalance(initiatorId);
  const balTarget = await economyService.getBalance(target.id);

  const embed = new EmbedBuilder()
    .setColor(0xffcc00)
    .setTitle("☀️☀️ Soleil-Duo !")
    .setDescription(`${interaction.user} et ${target} s'échangent de la lumière !`)
    .addFields(
      { name: interaction.user.displayName, value: `+${totalInitiator} ☀️ (total: ${balInitiator})`, inline: true },
      { name: target.displayName, value: `+${totalTarget} ☀️ (total: ${balTarget})`, inline: true },
      { name: "Météo", value: `${weatherEmoji} ×${weather.multiplier}`, inline: true }
    );

  // Si dans le salon dédié : confirmation éphémère + message public
  if (sunFarmChannelId) {
    await interaction.editReply({ content: "✅ Duo envoyé !" });
    const channel = interaction.channel;
    if (channel && channel.isSendable()) {
      await channel.send({ embeds: [embed] });
    }
  } else {
    // Pas de salon configuré : réponse éphémère + post public dans le canal actuel
    await interaction.editReply({ content: "✅ Duo envoyé !", embeds: [embed] });
    const channel = interaction.channel;
    if (channel && channel.isSendable()) {
      await channel.send({ embeds: [embed] });
    }
  }
}
