// roulette.js
const fs = require("fs");
const path = require("path");
const { chargerInventaire, sauvegarderInventaire, getBalance, setBalance } = require("./inventaire");
const config = require("../config");

const ROULETTE_PATH = path.join(__dirname, "../config/roulette.json");
const RESOLUTION_MS = 30000;
const EMOJI = config.iconMonnaie || "💰";

// Chargement/sauvegarde des paris
function chargerParis() {
  if (!fs.existsSync(ROULETTE_PATH)) return {};
  try {
    const raw = fs.readFileSync(ROULETTE_PATH, "utf8");
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.error("[roulette] erreur lecture paris:", err);
    return {};
  }
}
function sauvegarderParis(data) {
  try {
    fs.writeFileSync(ROULETTE_PATH, JSON.stringify(data, null, 4));
  } catch (err) {
    console.error("[roulette] erreur écriture paris:", err);
  }
}

// Validation choix
function choixValide(choix) {
  if (choix === null || choix === undefined) return false;
  const c = String(choix).toLowerCase().trim();
  if (c === "rouge" || c === "noir") return true;
  const n = parseInt(c, 10);
  return Number.isFinite(n) && n >= 0 && n <= 36;
}

// Normalise userId, mise et choix
function normalizeInputs(rawUserId, rawMise, rawChoix) {
  let userId = "";
  if (rawUserId && typeof rawUserId === "object" && rawUserId.id) {
    userId = String(rawUserId.id);
  } else {
    const asStr = String(rawUserId || "").trim();
    let m = asStr.match(/^<@!?(\d+)>$/);
    if (m && m[1]) userId = m[1];
    else {
      m = asStr.match(/^(\d+)$/);
      if (m && m[1]) userId = m[1];
      else userId = asStr.replace(/[^\d]/g, "");
    }
  }

  let mise;
  if (typeof rawMise === "string") {
    const cleaned = rawMise.replace(/[^\d.-]/g, "");
    mise = Number(cleaned);
  } else {
    mise = Number(rawMise);
  }

  const choix = typeof rawChoix === "string" ? rawChoix.toLowerCase().trim() : String(rawChoix).toLowerCase().trim();
  return { userId, mise, choix };
}

// Ajouter un pari (déduit immédiatement la mise) - retourne Promise<string>
async function ajouterPari(rawUserId, rawMise, rawChoix, options = {}) {
  const { userId, mise, choix } = normalizeInputs(rawUserId, rawMise, rawChoix);

  if (!userId) {
    throw new Error("❌ ID utilisateur invalide.");
  }
  if (!Number.isFinite(mise) || mise <= 0) {
    throw new Error("❌ La mise doit être un nombre positif.");
  }
  if (!choixValide(choix)) {
    throw new Error("❌ Choix invalide. Utilise 'rouge', 'noir' ou un numéro 0-36.");
  }

  const inventaire = chargerInventaire();
  const solde = getBalance(inventaire, userId);

  if (mise > solde) {
    throw new Error(`❌ Solde insuffisant ${EMOJI} ${solde}.`);
  }

  const paris = chargerParis();
  if (paris[userId]) {
    throw new Error("❌ Tu as déjà un pari en attente.");
  }

  paris[userId] = { mise, choix, placedAt: Date.now() };
  sauvegarderParis(paris);

  setTimeout(() => {
    resoudrePari(userId, options).catch(err => {
      console.error("[roulette] erreur dans resoudrePari:", err);
    });
  }, RESOLUTION_MS);

  return `✅ Pari accepté : ${EMOJI} ${mise} sur ${choix}. Résolution dans ${RESOLUTION_MS / 1000}s.`;
}


// Résolution du pari
// options peut contenir { client, channelId, mentionUser: true/false }
async function resoudrePari(rawUserId, options = {}) {
  const userId = String(rawUserId);
  const paris = chargerParis();
  const pari = paris[userId];
  if (!pari) {
    // rien à faire
    return;
  }

  const inventaire = chargerInventaire();
  const tirage = Math.floor(Math.random() * 37);
  const couleur = tirage === 0 ? "vert" : (tirage % 2 === 0 ? "noir" : "rouge");

  let gain = 0;
  let message = `🎲 Résultat : ${tirage} (${couleur})\n`;

  const choix = String(pari.choix).toLowerCase();

  if (choix === "rouge" || choix === "noir") {
    if (choix === couleur) {
      gain = pari.mise * 2;
      message += `✅ Tu as misé sur **${pari.choix}** et tu gagnes ${EMOJI} ${gain} !`;
    } else {
      message += `❌ Tu as perdu ta mise de ${EMOJI} ${pari.mise}.`;
    }
  } else {
    const numero = parseInt(choix, 10);
    if (!Number.isNaN(numero) && numero === tirage) {
      gain = pari.mise * 36;
      message += `🎉 Numéro exact ! Tu gagnes ${EMOJI} ${gain} !`;
    } else {
      message += `❌ Tu as perdu ta mise de ${EMOJI} ${pari.mise}.`;
    }
  }

  if (gain > 0) {
    try {
      const current = getBalance(inventaire, userId);
      setBalance(inventaire, userId, current + gain);
      sauvegarderInventaire(inventaire);
    } catch (err) {
      console.error("[roulette] erreur sauvegarde inventaire lors du gain :", err);
      message += `\n⚠️ Erreur interne, le gain n'a pas pu être correctement crédité. Contacte un administrateur.`;
    }
  }

  // retirer pari et sauvegarder
  delete paris[userId];
  sauvegarderParis(paris);

  // envoi du message si client et channelId fournis
  const client = options.client;
  const channelId = options.channelId || options.channel?.id;
  const mentionUser = options.mentionUser ?? true;

  const finalMessage = mentionUser ? `<@${userId}> — ${message}` : message;

  if (client && channelId) {
    try {
      const channel = client.channels.cache.get(channelId);
      if (channel && typeof channel.send === "function") {
        await channel.send({ content: finalMessage });
        return;
      }
    } catch (err) {
      console.error("[roulette] impossible d'envoyer le message via client:", err);
    }
  }

  // fallback : log si on n'a pas pu envoyer
  console.log("[roulette debug] résultat non envoyé (aucun client/channel). message:", finalMessage);
}

module.exports = {
  ajouterPari,
  resoudrePari,
  chargerParis,
  sauvegarderParis
};
