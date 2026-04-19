// File: main.js



// const fetch = require("node-fetch"); // ou global.fetch si vous l'avez polyfillé

/**
 * Traduit un texte de l'anglais vers le français en utilisant LibreTranslate.
 * Logs la réponse brute pour faciliter le debug.
 * @param {string} text
 * @returns {Promise<string>}
 */


const LIBRE_URL = "https://libretranslate.de/translate";
// ou
// const LIBRE_URL = "https://libretranslate.com/translate";
async function translateToFrench(text) {
  const primaryUrl = "https://libretranslate.de/translate";
  const payload = {
    q: text,
    source: "en",
    target: "fr",
    format: "text",
    api_key: ""  // laissez vide si non nécessaire
  };

  try {
    // Appel principal
    const res = await fetch(primaryUrl, {
      method: "POST",
      redirect: "follow",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(payload),
    });

    console.log("☁️ Statut principal:", res.status, res.headers.get("content-type"));
    const json = await res.json();

    // Extraction
    if (typeof json.translatedText === "string") {
      return json.translatedText;
    }
    if (json.data?.translations?.[0]?.translatedText) {
      return json.data.translations[0].translatedText;
    }

    throw new Error("Format inattendu : " + JSON.stringify(json));
  }
  catch (primaryErr) {
    console.warn("⚠️ Primary failed:", primaryErr.message);

    // Fallback sur MyMemory (gratuit, pas de clé)
    try {
      const fallbackRes = await fetch(
        `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|fr`
      );
      const fallbackJson = await fallbackRes.json();
      console.log("🌀 Fallback statut:", fallbackRes.status);
      return fallbackJson.responseData.translatedText;
    }
    catch (fallbackErr) {
      console.error("❌ Fallback failed:", fallbackErr.message);
      throw new Error("Toutes les API de traduction ont échoué.");
    }
  }
}



/**
 * Coupe un texte en morceaux d'une taille maximale donnée,
 * en essayant de respecter les retours à la ligne ou les espaces.
 */
function chunkText(text, maxLen = 500) {
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + maxLen, text.length);

    // Chercher un dernier espace avant la coupure pour ne pas briser un mot
    if (end < text.length) {
      const lastSpace = text.lastIndexOf(" ", end);
      if (lastSpace > start) end = lastSpace;
    }

    chunks.push(text.slice(start, end).trim());
    start = end;
  }

  return chunks;
}

/**
 * Traduit de longs textes en appelant translateToFrench sur chaque chunk,
 * puis réunit toutes les traductions.
 */
async function translateLongText(text) {
  const chunks = chunkText(text, 500);
  const results = [];

  for (const piece of chunks) {
    const part = await translateToFrench(piece);
    results.push(part);
    // Facultatif : pause pour respecter un rate limit éventuel
    await new Promise(res => setTimeout(res, 200));
  }

  return results.join("\n\n");
}




const {
  Client,
  GatewayIntentBits,
  Collection,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ChannelType,
  PermissionFlagsBits,
  AttachmentBuilder
} = require("discord.js");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const Canvas = require("canvas");
const dayjs = require("dayjs");
const relativeTime = require("dayjs/plugin/relativeTime");

const config = require("./config");
const loadSlashCommands = require("./Loaders/loadSlashCommands");
const loadCommands = require("./Loaders/loadCommands");
const loadEvents = require("./Loaders/loadEvents");
const dbDepart = require("./Utils/dbDepart");
const {
  getParis,
  resetParis,
  chargerInventaire,
  sauvegarderInventaire
} = require("./Utils/rouletteManager");
const { MONNAIE_EMOJI } = require("./Utils/constants");
const { getCasinoChannel } = require("./Utils/getCasinoChannel");
const dbTrad = require("./Utils/dbTrad");

require("dayjs/locale/fr");
dayjs.extend(relativeTime);
dayjs.locale("fr");

// Chemins vers vos fichiers JSON
const salonVotesPath = path.join(__dirname, "salon.json");
const rappelPath = path.join(__dirname, "config", "rappel.json");

// ─── Instanciation du client Discord ────────────────────────────────
const bot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});
bot.commands = new Collection();

// ─── Gestion des erreurs globales ───────────────────────────────────
bot.on("error", console.error);
process.on("unhandledRejection", console.error);

// ─── Chargement des commandes & événements ──────────────────────────
loadCommands(bot);
loadEvents(bot);

// ─── Connexion du bot ───────────────────────────────────────────────
bot.login(config.token);








bot.on("interactionCreate", async interaction => {
  const passCommand = require("./Commandes/pass.js");

  if (interaction.isCommand() && interaction.commandName === "pass") {
    return passCommand.run(bot, interaction);
  }

  await passCommand.handleInteraction(interaction);
});







// ─── MessageCreate : (traduction auto) + commande !work ────────────
bot.on("messageCreate", async message => {
  if (message.author.bot || !message.guild) return;














  // Traduction automatique si salon configuré
  const tradChannels = dbTrad.get(message.guild.id) || [];
  if (!tradChannels.includes(message.channel.id)) return;

  const text = message.content.trim();
  if (!text) return;                        // rien à faire sur un message vide

  try {
    // on ne fait qu’un seul appel, translateLongText gère court et long
    const french = await translateLongText(text);
    console.log("⤷ Traduction obtenue :", JSON.stringify(french));
    await message.reply({ content: french });
    console.log("✅ Réponse envoyée");
  } catch (err) {
    console.error("❌ Erreur de traduction longue :", err);
    await message.reply({ content: "❌ Impossible de traduire pour le moment." });
  }


});




bot.on("messageCreate", async message => {
  if (message.author.bot) return;
  if (message.content.toLowerCase() !== "!work") return;

  const cooldownPath = path.join(__dirname, "config", "workCooldowns.json");
  const now = Date.now();
  const userId = message.author.id;

  let cooldowns = {};
  if (fs.existsSync(cooldownPath)) {
    try {
      cooldowns = JSON.parse(fs.readFileSync(cooldownPath, "utf8"));
    } catch {
      console.warn("⚠️ workCooldowns.json corrompu");
    }
  }

  const last = cooldowns[userId] || 0;
  const delay = 4 * 60 * 60 * 1000;
  if (now - last < delay) {
    const rem = delay - (now - last);
    const hrs = Math.floor(rem / 1000 / 60 / 60);
    const mins = Math.floor((rem / 1000 / 60) % 60);
    return message.reply(`❌ Reviens dans **${hrs}h ${mins}min** pour retravailler.`);
  }

  const gain = Math.floor(Math.random() * 201) + 50;
  const MONNAIE_EMOJI = "💰";
  const inv = chargerInventaire();
  if (!inv[userId]) inv[userId] = [];
  const idx = inv[userId].findIndex(o => o.emoji === MONNAIE_EMOJI && !o.nom);
  if (idx !== -1) inv[userId][idx].quantite += gain;
  else inv[userId].push({ emoji: MONNAIE_EMOJI, nom: null, quantite: gain });

  sauvegarderInventaire(inv);
  cooldowns[userId] = now;
  fs.writeFileSync(cooldownPath, JSON.stringify(cooldowns, null, 2), "utf8");

  return message.reply(`💼 Tu as gagné **${gain} ${MONNAIE_EMOJI}** !`);
});









// ─── GuildMemberRemove : message de départ personnalisé ─────────────
bot.on("guildMemberRemove", async member => {
  const cfg = dbDepart.get(member.guild.id);
  if (!cfg) return;

  // Récupère le salon texte configuré
  const channel = await member.guild.channels
    .fetch(cfg.salonId)
    .catch(() => null);
  if (!channel?.isTextBased()) return;

  // Prépare le Canvas
  const width = 800;
  const height = 300;
  const canvas = Canvas.createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // Fond personnalisé
  const bg = await Canvas.loadImage(cfg.fondURL);
  ctx.drawImage(bg, 0, 0, width, height);

  // Avatar en cercle
  const avatar = await Canvas.loadImage(
    member.user.displayAvatarURL({ extension: "png" })
  );
  const r = 80;
  const x = 100, y = height / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(avatar, x - r, y - r, r * 2, r * 2);
  ctx.restore();

  // Pseudo du membre
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 36px sans-serif";
  ctx.fillText(member.user.username, x + r + 20, y - 10);

  // Date d’arrivée relative (en français)
  const since = dayjs(member.joinedAt);
  const rel = since.fromNow(); // "il y a quelques secondes", "il y a 2 jours", etc.
  ctx.font = "24px sans-serif";
  ctx.fillText(`Avait rejoint ${rel}`, x + r + 20, y + 30);

  // Phrase drôle aléatoire
  const templates = [
    "A plus dans le bus, {user} !",
    "T’es viré comme une fusée, bye {user} !",
    "Cap sur Mars, {user} !",
    "Rendez-vous sur Vénus, {user} 🚀",
    "Le pot de départ était meilleur sans toi, {user}.",
    "Bon vent, {user}, et n’oublie pas ta combinaison spatiale !",
    "Ton vaisseau décolle sans toi, à bientôt {user} !",
    "Le taxi martien n’attendra pas, salut {user} !",
    "Direction Pluton : fais-nous rêver {user} !",
    "Le compte à rebours est lancé, bye {user} !",
    "On t’a viré jusqu’à la fin de l’univers, ciao {user} !",
    "Tu quittes le navire, mais pas nos souvenirs {user} !",
    "A+ dans la galaxie, {user} !",
    "Ta fusée part maintenant, accroche-toi {user} !",
    "Promo spéciale départ : 100% de vide, salut {user} !",
    "{user}, tu viens de débloquer le mode solo : bonne chance !",
    "Le bar interstellaire t’attend, santé {user} !",
    "On garde ta place… enfin, pas vraiment. Bye {user} !",
    "Porte de sortie activée, à la prochaine {user} !",
    "Mission accomplie : tu es parti ! À plus {user} !"
  ];
  const phrase = templates[
    Math.floor(Math.random() * templates.length)
  ].replace("{user}", member.user.username);

  ctx.fillText(phrase, 50, height - 40);

  // Envoi de l'image
  const buffer = canvas.toBuffer();
  const attachment = new AttachmentBuilder(buffer, { name: "depart.png" });
  channel.send({ files: [attachment] });
});


// ─── Ready : enregistrement slashs, votes, roulette, rappels ───────
bot.once("ready", async () => {
  console.log(`✅ ${bot.user.tag} est prêt.`);

  // Enregistrement des slash commands
  loadSlashCommands(bot);

  // Votes Top-Serveur (20s)
  let lastVoteId = null;
  setInterval(async () => {
    let cfg;
    try {
      cfg = JSON.parse(fs.readFileSync(salonVotesPath, "utf8"));
    } catch {
      return console.warn("⚠️ salon.json introuvable ou invalide");
    }

    const ch = bot.channels.cache.get(cfg.channelId)
      || await bot.channels.fetch(cfg.channelId).catch(() => null);
    if (!ch) return;

    try {
      const { data } = await axios.get(
        "https://api.top-serveurs.net/v1/votes/last?server_token=4ROMAU33GJTY"
      );
      const votes = data.votes;
      if (!Array.isArray(votes) || !votes.length) return;

      const latest = votes[votes.length - 1];
      const id = `${latest.ip}-${latest.datetime}`;
      if (id === lastVoteId) return;
      lastVoteId = id;

      const name = latest.playername?.trim() || "Un joueur";
      const embed = new EmbedBuilder()
        .setTitle("Nouveau vote Top-Serveur !")
        .setDescription(`**${name}** a voté.`)
        .setColor("#030070")
        .setTimestamp();

      ch.send({ embeds: [embed] });
    } catch (err) {
      console.error("❌ Erreur API Top-Serveurs :", err.message);
    }
  }, 20_000);

  // Roulette automatique (30s)
  setInterval(async () => {
    const paris = getParis();
    if (!paris.length) return;

    const tirage = Math.floor(Math.random() * 37);
    const couleur =
      tirage === 0 ? "vert" :
        tirage % 2 === 0 ? "noir" : "rouge";

    const inv = chargerInventaire();
    const resultats = [];
    for (const { userId, mise, choix } of paris) {
      if (!inv[userId]) continue;
      const idx = inv[userId].findIndex(o => o.emoji === MONNAIE_EMOJI && !o.nom);
      if (idx === -1) continue;

      let gain = 0;
      if (choix === couleur) gain = mise * 2;
      else if (!isNaN(parseInt(choix)) && parseInt(choix) === tirage) {
        gain = mise * 36;
      }
      inv[userId][idx].quantite += gain;
      resultats.push({ userId, mise, choix, gain });
    }
    sauvegarderInventaire(inv);

    const embed = new EmbedBuilder()
      .setTitle("🎰 Résultat de la roulette")
      .setDescription(
        `🎯 Numéro tiré : **${tirage}**\n` +
        `Couleur gagnante : **${couleur.toUpperCase()}**\n\n` +
        resultats.map(r =>
          `<@${r.userId}> a misé ${r.mise} ${MONNAIE_EMOJI} sur **${r.choix}** → ` +
          (r.gain > 0 ? `gagne ${r.gain} ${MONNAIE_EMOJI}` : "perd sa mise")
        ).join("\n")
      )
      .setColor("#FFD700")
      .setTimestamp();

    const casinoCh = getCasinoChannel(bot);
    if (!casinoCh) return resetParis();

    casinoCh.send({ embeds: [embed] });
    resetParis();
  }, 30_000);

  // Rappels (/rappel)
  console.log("🔔 Planification des rappels…");
  let raw = "{}";
  if (fs.existsSync(rappelPath)) {
    try { raw = fs.readFileSync(rappelPath, "utf8"); }
    catch { console.warn("⚠️ Impossible de lire rappel.json"); }
  }

  let loaded = {};
  try { loaded = JSON.parse(raw); }
  catch { console.warn("⚠️ rappel.json invalide"); }

  for (const [guildId, data] of Object.entries(loaded)) {
    const reminders = Array.isArray(data) ? data : [data];
    for (const cfg of reminders) {
      (async () => {
        let ch = bot.channels.cache.get(cfg.channelId);
        if (!ch) {
          try { ch = await bot.channels.fetch(cfg.channelId); }
          catch { return; }
        }
        if (ch.type !== ChannelType.GuildText) return;

        const sendEmbed = () => {
          const em = new EmbedBuilder()
            .setTitle(cfg.embed.titre)
            .setDescription(cfg.embed.description)
            .setColor("#030070")
            .setTimestamp();

          const comps = [];
          if (cfg.embed.btnLabel && cfg.embed.btnUrl) {
            comps.push(new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setLabel(cfg.embed.btnLabel)
                .setStyle(ButtonStyle.Link)
                .setURL(cfg.embed.btnUrl)
            ));
          }

          ch.send({ embeds: [em], components: comps.length ? comps : undefined })
            .catch(console.error);
        };

        sendEmbed();
        setInterval(sendEmbed, cfg.interval * 60 * 1000);
      })();
    }
  }
});
