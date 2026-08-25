import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder, MessageFlags} from "discord.js";
import { economyService } from "../economy/EconomyService";
import { getTodayWeather, getWeatherEmoji } from "../sun/weather";
import { getCooldown, setCooldown, formatCooldown } from "../sun/cooldown";
import { db } from "../db/database";
import { getMessages, getRandomMessage } from "../data/loader";
import { requireChannel } from "../core/channel-guard";
import { getChannelId } from "../core/config-db";
import { v4 as uuidv4 } from "uuid";
import { DateTime } from "luxon";

const TZ = "Europe/Paris";
const COOLDOWN_MINUTES = 60;

export const data = new SlashCommandBuilder()
  .setName("soleil")
  .setDescription("☀️ Soleils — Récolte tes Soleils quotidiens (cooldown 1h)");

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (await requireChannel(interaction, "sun_farm")) return;

  const userId = interaction.user.id;

  // ── Vérification cooldown (lecture seule) ───────────────────────────────
  let cooldownDt = await getCooldown(userId, "soleil");
  if (cooldownDt) {
    const now = DateTime.now().setZone(TZ);
    const maxExpiry = now.plus({ minutes: COOLDOWN_MINUTES });
    // Si le cooldown stocké dépasse la limite actuelle (ancien cooldown 3h), on le rogne
    if (cooldownDt > maxExpiry) {
      const capped = maxExpiry.toISO()!;
      await db.execute(
        "UPDATE cooldowns SET available_at = ? WHERE key = ?",
        [capped, `${userId}:soleil`]
      );
      cooldownDt = maxExpiry;
    }
    await interaction.editReply({
      content: `⏳ Tu dois attendre encore **${formatCooldown(cooldownDt)}** avant de récolter à nouveau !`,
    });
    return;
  }

  const weather = await getTodayWeather();
  const weatherEmoji = getWeatherEmoji(weather.weather);

  let base = Math.floor(Math.random() * 8) + 8; // 8-15
  const isExceptional = Math.random() * 100 < 2;
  if (isExceptional) base += 5;
  const total = Math.floor(base * weather.multiplier);

  await economyService.credit(userId, total, "soleil-farm", `sun-solo:${uuidv4()}:${userId}`);

  // Cooldown posé ICI, uniquement après que le crédit a réussi
  await setCooldown(userId, "soleil", COOLDOWN_MINUTES);

  const messages = getMessages();
  const farmMsg = isExceptional
    ? getRandomMessage(messages.farm.exceptional)
    : getRandomMessage(messages.farm.normal);

  const newBalance = await economyService.getBalance(userId);

  const embed = new EmbedBuilder()
    .setColor(isExceptional ? 0xffd700 : 0xffa500)
    .setTitle(isExceptional ? "✨ SOLEIL EXCEPTIONNEL !" : "🌻 Récolte de Soleils")
    .setDescription(farmMsg)
    .addFields(
      { name: "Récolte", value: `**+${total} ☀️**${isExceptional ? " (Bonus exceptionnel !)" : ""}`, inline: true },
      { name: "Météo", value: `${weatherEmoji} ×${weather.multiplier}`, inline: true },
      { name: "Total ☀️", value: `${newBalance}`, inline: true }
    )
    .setFooter({ text: `Prochain /soleil dans ${COOLDOWN_MINUTES / 60}h` });

  // Si dans le salon dédié : réponse publique visible de tous
  const sunFarmChannelId = await getChannelId("sun_farm");
  if (sunFarmChannelId) {
    await interaction.editReply({ content: "✅" });
    const channel = interaction.channel;
    if (channel && channel.isSendable()) {
      await channel.send({ content: `${interaction.user}`, embeds: [embed] });
    }
  } else {
    // Pas de salon configuré : réponse éphémère classique
    await interaction.editReply({ embeds: [embed] });
  }
}
