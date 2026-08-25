import {
  Interaction,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
} from "discord.js";
import { db } from "../db/database";
import { DateTime } from "luxon";
import { economyService } from "../economy/EconomyService";
import { logger } from "../core/logger";
import { getChannelId } from "../core/config-db";
import { revealMapAfterCompletion } from "./day-opening";
import { storeCompletionLink } from "./construction-done";
import { setEventsEnabled } from "../core/config-db";
import { forceStopRiddle } from "../events/riddles";
import { forceStopSurf } from "../events/surf";
import { forceStopWater } from "../events/water-battle";
import { forceStopEmoji } from "../events/emoji-challenge";
import path from "path";
import fs from "fs";

const TZ = "Europe/Paris";
const SETTLEMENT_CLOSURE_ID = "arki-summer-day14";

/**
 * Envoie le snapshot final des Soleils à Arki Family.
 *
 * Configuration du bot d'été :
 * - SUMMER_EVENT_SETTLEMENT_URL : URL complète de /api/summer-event/settle
 * - SUMMER_EVENT_SETTLEMENT_API_KEY : clé API d'inventaire, dans les secrets
 *
 * L'envoi est volontairement effectué avant le flag de clôture Discord :
 * une erreur réseau ou une conversion partielle pourra ainsi être retentée
 * par le prochain appel de clôture.
 */
async function settleFinalWallets(): Promise<boolean> {
  const url = process.env.SUMMER_EVENT_SETTLEMENT_URL?.trim();
  const apiKey = process.env.SUMMER_EVENT_SETTLEMENT_API_KEY?.trim();

  if (!url || !apiKey) {
    logger.error(
      "[Completion] Règlement impossible : SUMMER_EVENT_SETTLEMENT_URL ou SUMMER_EVENT_SETTLEMENT_API_KEY manque"
    );
    return false;
  }

  const wallets = await db.query<{ user_id: string; balance: number }>(
    "SELECT user_id, balance FROM wallets ORDER BY user_id"
  );

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        closureId: SETTLEMENT_CLOSURE_ID,
        wallets: wallets.map(({ user_id, balance }) => ({
          user_id,
          balance,
        })),
      }),
    });

    const rawBody = await response.text();
    let body: {
      success?: boolean;
      credited?: unknown[];
      skipped?: unknown[];
      unknownUsers?: unknown[];
      errors?: unknown[];
      duplicate?: boolean;
      error?: string;
    };
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = { error: rawBody.slice(0, 500) };
    }

    if (!response.ok || body.success !== true) {
      logger.error(
        {
          status: response.status,
          error: body.error,
          unknownUsers: body.unknownUsers?.length ?? 0,
          errors: body.errors?.length ?? 0,
        },
        "[Completion] Échec du règlement des Soleils"
      );
      return false;
    }

    logger.info(
      {
        closureId: SETTLEMENT_CLOSURE_ID,
        credited: body.credited?.length ?? 0,
        skipped: body.skipped?.length ?? 0,
        duplicate: body.duplicate === true,
      },
      "[Completion] Conversion des Soleils terminée"
    );
    return true;
  } catch (err) {
    logger.error({ err }, "[Completion] API de règlement inaccessible");
    return false;
  }
}

/**
 * Texte de clôture affiché quand la construction du jour est terminée.
 * PATCH NARRATIF — L'HÉRITAGE DE L'ÎLE (version cohérence renforcée)
 * J1–J9  → "📖 Extrait du journal de bord" (auteur inconnu)
 * J10–J14 → "📖 Journal d'Arkian" (révélation J10)
 * Arkideal → J14 uniquement. Aucun autre nom de personnage.
 */
export const JOURNALS: Record<number, string> = {
  // ── J1–J9 : auteur inconnu ───────────────────────────────────────────────
  1:
    "📖 Extrait du journal de bord\n" +
    "Le feu brûle de nouveau au centre du camp. En déplaçant les derniers débris, vous découvrez une petite marque gravée dans le bois, comme l'indication d'un chemin.\n" +
    "Ce camp n'était probablement pas une installation isolée.",

  2:
    "📖 Extrait du journal de bord\n" +
    "Le pont relie de nouveau les deux rives. Sous une traverse :\n" +
    "> « Une route n'a d'intérêt que si quelqu'un peut l'emprunter après vous. »\n" +
    "Le même symbole est gravé à côté. Ce n'est plus une coïncidence.",

  3:
    "📖 Extrait du journal de bord\n" +
    "La roue tourne de nouveau. Des marques de comptage révèlent outils distribués, poutres préparées et équipes affectées.\n" +
    "Les habitants étaient organisés. Et surtout, ils étaient nombreux.",

  4:
    "📖 Extrait du journal de bord\n" +
    "L'accès à la baie est rétabli. Plusieurs plaques portent le même emblème.\n" +
    "Une certitude s'impose : ceux qui vivaient ici formaient une véritable communauté.",

  5:
    "📖 Extrait du journal de bord\n" +
    "La serre respire de nouveau. Une phrase demeure sur le mur :\n" +
    "> « Ce que nous faisons pousser ici ne nous appartient pas vraiment. »\n" +
    "Vous découvrez peu à peu les principes sur lesquels ce village avait été construit.",

  6:
    "📖 Extrait du journal de bord\n" +
    "Une caisse contient plusieurs objets personnels : gourde, couteau usé, petit jouet sculpté, médaille.\n" +
    "Ils ne construisaient pas seulement pour survivre. Des familles ont vécu ici.",

  7:
    "📖 Extrait du journal de bord\n" +
    "Le mot **Idealis** apparaît sur des caisses, registres et outils.\n" +
    "Village ? Tribu ? Projet ? Impossible encore de le savoir, mais les ruines ont enfin une identité.",

  8:
    "📖 Extrait du journal de bord\n" +
    "Sous une dalle : jetons, dessins, listes de repas, résultats de jeux et petits messages.\n" +
    "Idealis n'était pas seulement un chantier. C'était un lieu de vie.",

  9:
    "📖 Extrait du journal de bord\n" +
    "Depuis la tour, tous les lieux restaurés semblent former un ensemble.\n" +
    "Dans le pupitre : une clé et deux mots, **« Archives — Idealis »**.",

  // ── J10 : révélation du nom Arkian ──────────────────────────────────────
  10:
    "📖 Journal d'Arkian\n" +
    "Les fragments peuvent enfin être rapprochés. Arkian semble avoir documenté la vie d'Idealis pendant des années.\n" +
    "> « Un jour, quelqu'un marchera peut-être de nouveau sur ces chemins. »\n" +
    "Vous êtes précisément en train de le faire.",

  11:
    "📖 Journal d'Arkian\n" +
    "Une note d'Arkian :\n" +
    "> « Idealis n'a jamais été l'œuvre d'un chef.\n" +
    "> C'était notre manière de nous rappeler que chacun pouvait apporter quelque chose. »\n" +
    "Une page mentionne un **Veilleur**, chargé de conserver certains documents.",

  12:
    "📖 Journal d'Arkian\n" +
    "Un compartiment dissimulé contient les dernières pages. Elles évoquent une grande salle où la communauté se réunissait.\n" +
    "> « Là-bas sont conservés les noms de ceux qui ont choisi de rester, d'aider et de transmettre. »\n" +
    "Le chemin mène au Grand Hall d'Idealis.",

  // ── J13 : révélation des Survivants d'Idealis ────────────────────────────
  13:
    "📖 Journal d'Arkian\n" +
    "Derrière une plaque, une dernière carte apparaît.\n" +
    "> « Le nom que nous avons donné à notre foyer est resté là-bas.\n" +
    "> S'il doit être prononcé de nouveau, que ce soit par ceux qui auront compris pourquoi nous l'avons choisi. »\n" +
    "Le dernier secret attend derrière le brouillard.",

  // ── J14 : révélation d'ARKIDEAL ─────────────────────────────────────────
  14:
    "📖 Journal d'Arkian — Dernier jour\n\n" +
    "**ARKIDEAL**\n\n" +
    "Le nom du foyer des Survivants d'Idealis apparaît enfin.\n\n" +
    "> « Si vous lisez ces lignes aujourd'hui…\n" +
    "> alors cela signifie que quelqu'un est revenu.\n" +
    ">\n" +
    "> Peut-être que nos visages se sont effacés avec le temps.\n" +
    "> Peut-être que nos noms ne sont plus que des souvenirs.\n" +
    ">\n" +
    "> Mais si vous êtes ici…\n" +
    "> alors l'esprit d'Arkideal a traversé les années.\n" +
    ">\n" +
    "> Un foyer n'est pas fait de pierre ou de bois.\n" +
    "> Il existe grâce à celles et ceux qui choisissent de bâtir, de s'entraider et de partager.\n" +
    ">\n" +
    "> Peu importe le nom que vous portez aujourd'hui.\n" +
    "> Si vous veillez les uns sur les autres, alors vous faites désormais partie de cette histoire.\n" +
    ">\n" +
    "> Prenez soin de ce lieu.\n" +
    "> Faites-le vivre.\n" +
    "> Et, à votre tour… laissez quelque chose derrière vous. »\n" +
    ">\n" +
    "> — **Arkian**\n\n" +
    "**Si vous êtes là… l'esprit d'Arkideal vit encore et a perduré.**\n\n" +
    "**L'Héritage de l'Île est désormais le vôtre.**",
};

/**
 * Publie la clôture globale d'Arki' Summer une fois la dernière construction
 * terminée. Le flag est écrit uniquement après le règlement des Soleils et
 * l'envoi Discord afin qu'un tick ultérieur puisse rattraper un échec.
 */
export async function announceFinalEventClosure(client: Client): Promise<boolean> {
  const finalDay = await db.queryOne<{ status: string; title: string }>(
    "SELECT status, title FROM community_days WHERE day = 14"
  );
  if (!finalDay || finalDay.status !== "COMPLETED") return false;

  const closureKey = "event_global_closure_sent";
  const alreadySent = await db.queryOne<{ value_json: string }>(
    "SELECT value_json FROM bot_config WHERE key = ?",
    [closureKey]
  );
  if (alreadySent) return false;

   const channelId = await getChannelId("sun_farm");
  if (!channelId) return false;

  const embed = new EmbedBuilder()
    .setColor(0x8e44ad)
    .setTitle("🏝️ ARKI' SUMMER — L'AVENTURE EST TERMINÉE !")
    .setDescription(
      "Après toutes ces journées d'exploration, de récolte, de chantiers et de défis, " +
      "l'aventure communautaire **L'Héritage de l'Île** arrive à son terme.\n\n" +
      "🎉 **Grâce à la mobilisation de toute la communauté, la dernière construction est achevée !**\n\n" +
      "Chaque exploration, chaque ressource déposée, chaque chantier rejoint, chaque défi relevé et " +
      "chaque moment partagé a contribué à faire avancer cette aventure.\n\n" +
      "💜 Merci à toutes et tous pour votre participation, votre bonne humeur, votre entraide, " +
      "vos encouragements et vos partages tout au long de cet événement.\n\n" +
      "Ce qui a traversé toutes ces journées, ce n'est pas seulement un héritage retrouvé. " +
      "C'est **l'esprit d'Arki' Family** : l'entraide, le partage, les rires et l'envie de construire " +
      "quelque chose ensemble. Grâce à vous, cet esprit est toujours là.\n\n" +
      "📚 Les cartes, les constructions terminées et les souvenirs de chaque étape restent consultables " +
      "depuis le bouton **Voir l'histoire de l'île** dans `/exploration`.\n\n" +
      "**Arki' Summer se termine ici, mais l'esprit d'Arki' Family continue.** 🌅"
    )
    .addFields({
      name: "🏗️ Dernière étape",
      value: `**Jour 14 — ${finalDay.title}**`,
    })
    .setFooter({ text: "Merci à toute la communauté Arki' Family · Fin de l'événement" })
    .setTimestamp();

  const historyRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("exploration_history:page:0")
      .setLabel("📚 Revoir l'histoire de l'île")
      .setStyle(ButtonStyle.Secondary)
  );

  try {
    const settlementOk = await settleFinalWallets();
    if (!settlementOk) return false;

    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isSendable()) return false;
    await channel.send({ embeds: [embed], components: [historyRow] });
    await db.execute(
      `INSERT INTO bot_config (key, value_json, updated_at)
       VALUES (?, 'true', datetime('now'))
       ON CONFLICT(key) DO NOTHING`,
      [closureKey]
    );
    await setEventsEnabled(false);
    forceStopRiddle();
    forceStopSurf();
    forceStopWater();
    forceStopEmoji();
    return true;
  } catch (err) {
    logger.error({ err }, "[Completion] Échec de publication de la clôture globale");
    return false;
  }
}

export async function triggerBuildingComplete(day: number, interaction: Interaction): Promise<void> {
  const dayRow = await db.queryOne<{ status: string }>(
    "SELECT status FROM community_days WHERE day = ?",
    [day]
  );
  if (!dayRow || dayRow.status === "COMPLETED") return;

  const now = DateTime.now().setZone(TZ);

  // Lire le reward_tier existant : s'il est déjà 'late' (marqué à minuit), on garde 150☀️
  const existingTier = await db.queryOne<{ reward_tier: string | null }>(
    "SELECT reward_tier FROM community_days WHERE day = ?",
    [day]
  );
  const rewardTier = existingTier?.reward_tier === "late" ? "late" : "on_time";
  const rewardAmount = rewardTier === "late" ? 150 : 400;

  await db.execute(
    "UPDATE community_days SET status = 'COMPLETED', completed_at = ?, reward_tier = ? WHERE day = ?",
    [now.toISO(), rewardTier, day]
  );

  const contributors = await db.query<{ user_id: string }>(
    "SELECT DISTINCT user_id FROM community_contributions WHERE day = ?",
    [day]
  );

  for (const { user_id } of contributors) {
    const key = `community-reward:day${day}:${user_id}`;
    try {
      await economyService.credit(user_id, rewardAmount, `construction-day${day}`, key);
    } catch (err) {
      logger.error({ err, user_id, day }, "Failed to credit construction reward");
    }
  }

  const dayInfo = await db.queryOne<{ title: string }>(
    "SELECT title FROM community_days WHERE day = ?",
    [day]
  );

  const embed = new EmbedBuilder()
    .setColor(0xffd700)
    .setTitle("🏗️ CONSTRUCTION TERMINÉE !")
    .setDescription(
      `**JOUR ${day} — ${dayInfo?.title ?? ""}**\n\n` +
      `${JOURNALS[day] ?? ""}\n\n` +
      `🎁 **Récompense :** ${rewardAmount} ☀️ par participant`
    )
    .addFields({ name: "Participants récompensés", value: `${contributors.length} joueur${contributors.length !== 1 ? "s" : ""}` })
    .setFooter({ text: "✅ Construction terminée !" });

  const files: AttachmentBuilder[] = [];
  const assetsDir = path.join(process.cwd(), "assets", "constructions");
  if (fs.existsSync(assetsDir)) {
    const imgs = fs.readdirSync(assetsDir).filter((f) => f.startsWith(`jour_${String(day).padStart(2, "0")}_`));
    if (imgs.length > 0) {
      files.push(new AttachmentBuilder(path.join(assetsDir, imgs[0])));
    }
  }

  const channelId = await getChannelId("expedition");
  const client = interaction.client;

  try {
    const targetChannel = channelId
      ? await client.channels.fetch(channelId)
      : interaction.channel;

    if (targetChannel && targetChannel.isSendable()) {
      const sentMsg = await targetChannel.send({ embeds: [embed], files });

      // Stocker le lien vers ce message de clôture pour les commandes /exploration, /tandem, /chantier
      const guildId = "guildId" in targetChannel
        ? (targetChannel as { guildId: string }).guildId
        : (interaction as { guildId?: string }).guildId ?? null;
      if (guildId) {
        const date = now.toISODate()!;
        const link = `https://discord.com/channels/${guildId}/${targetChannel.id}/${sentMsg.id}`;
        await storeCompletionLink(date, link);
      }
    }
  } catch (err) {
    logger.error({ err }, "Failed to announce building complete");
  }

  if (day >= 14) {
    await announceFinalEventClosure(interaction.client);
  }

  // Unlock next day (activated at 00:01 by scheduler)
  if (day < 14) {
    const nextDay = await db.queryOne<{ status: string }>(
      "SELECT status FROM community_days WHERE day = ?",
      [day + 1]
    );
    if (nextDay && nextDay.status === "LOCKED") {
      logger.info({ nextDay: day + 1 }, "Next day ready to be activated by scheduler");
    }

    // Si le jour suivant est déjà ACTIVE mais avait ouvert sans carte
    // (construction précédente en retard), révéler sa carte maintenant
    if (nextDay && nextDay.status === "ACTIVE") {
      try {
        await revealMapAfterCompletion(day, interaction.client);
      } catch (e) {
        logger.error({ err: e }, "[Completion] Erreur révélation carte tardive");
      }
    }
  }
}
