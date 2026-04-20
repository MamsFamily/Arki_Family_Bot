const fs = require("fs");
const path = require("path");
const { chargerInventaire, sauvegarderInventaire } = require("./inventaire");
const { getMonnaie } = require("./money");
const config = require("../config");

const filePath = path.join(__dirname, "../config/rouletterusse.json");

function chargerPartie() {
  if (!fs.existsSync(filePath)) {
    return { mise: null, participants: [], enCours: false };
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.error("Erreur parsing rouletterusse.json:", err);
    return { mise: null, participants: [], enCours: false };
  }
}

function sauvegarderPartie(data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 4));
  } catch (err) {
    console.error("Erreur sauvegarderPartie:", err);
    throw err;
  }
}

function initPartie(userId, username, mise) {
  const partie = {
    mise,
    participants: [{ id: String(userId), nom: username }],
    enCours: false
  };
  sauvegarderPartie(partie);
}

function ajouterParticipant(userId, username) {
  const partie = chargerPartie();
  if (partie.enCours) return false;
  const uid = String(userId);
  if (partie.participants.find(p => String(p.id) === uid)) return false;
  if (partie.participants.length >= 6) return false;

  partie.participants.push({ id: uid, nom: username });
  sauvegarderPartie(partie);
  return true;
}

function resetPartie() {
  sauvegarderPartie({ mise: null, participants: [], enCours: false });
}

/* Helpers */
function normaliserInventaire(inv) {
  if (!inv || typeof inv !== "object" || Array.isArray(inv)) return {};
  Object.keys(inv).forEach(k => {
    if (!Array.isArray(inv[k])) inv[k] = [];
  });
  return inv;
}

function findArgentIndex(arr) {
  return arr.findIndex(o => o && o.name === "argent");
}

/*
  lancerPartie (CORRIGÉ)
  Hypothèse de fonctionnement: l'argent a déjà été retiré lors du clic "Rejoindre".
  Ne débite donc PAS de nouveau. Vérifie simplement la validité de la partie,
  calcule le pot total = mise * participants.length, partage entre survivants,
  gère le reste et sauvegarde l'inventaire.
*/
function lancerPartie() {
  const partie = chargerPartie();
  if (!partie || !Array.isArray(partie.participants) || partie.participants.length < 2) return null;

  const mise = Number(partie.mise);
  if (!Number.isFinite(mise) || mise <= 0) {
    console.error("Mise invalide:", partie.mise);
    return null;
  }

  // Charger inventaire (normalisé) - on ne déduit plus ici
  let inventaire = normaliserInventaire(chargerInventaire());

  // Vérification optionnelle : s'assurer que chaque participant a déjà payé (s'il est important)
  // Si vous voulez forcer la vérification que le retrait a bien eu lieu au join, activez ces lignes.
  for (const p of partie.participants) {
    const id = String(p.id);
    const arr = inventaire[id] || [];
    const idx = findArgentIndex(arr);
    const current = idx >= 0 ? Number(arr[idx].quantite) || 0 : 0;
    // On ne refuse plus la partie si current < 0; simplement log
    if (current < 0) console.warn(`Inventaire négatif pour ${id}: ${current}`);
  }

  // Choisir le perdant et survivants
  const indexMort = Math.floor(Math.random() * partie.participants.length);
  const victime = partie.participants[indexMort];
  const survivants = partie.participants.filter((_, i) => i !== indexMort);

  // Calculer pot total (tous les mises déjà retirées au join)
  const potTotal = mise * partie.participants.length;
  const perSurvivant = Math.floor(potTotal / survivants.length);
  const reste = potTotal % survivants.length;

  // Créditer chaque survivant avec sa part du pot
  for (const p of survivants) {
    const id = String(p.id);
    if (!inventaire[id]) inventaire[id] = [];
    const arr = inventaire[id];
    const idx = findArgentIndex(arr);
    if (idx === -1) arr.push({ name: "argent", quantite: perSurvivant });
    else arr[idx].quantite = (Number(arr[idx].quantite) || 0) + perSurvivant;
  }

  // Reste vers le bot
  if (reste > 0) {
    const botId = "bot";
    if (!inventaire[botId]) inventaire[botId] = [];
    const idxBot = findArgentIndex(inventaire[botId]);
    if (idxBot === -1) inventaire[botId].push({ name: "argent", quantite: reste });
    else inventaire[botId][idxBot].quantite = (Number(inventaire[botId][idxBot].quantite) || 0) + reste;
  }

  // Sauvegarde et reset
  try {
    sauvegarderInventaire(inventaire);
  } catch (err) {
    console.error("Échec sauvegarde inventaire:", err);
    return null;
  }

  resetPartie();
  return { victime, survivants, gainParSurvivant: perSurvivant };
}

/*
  executerRouletteRusse (async) — gère l'interaction Discord proprement
*/
async function executerRouletteRusse(interaction) {
  const { format } = getMonnaie();

  try {
    await interaction.deferUpdate();
  } catch (err) {
    console.warn("deferUpdate failed:", err);
  }

  let resultat;
  try {
    resultat = lancerPartie();
  } catch (err) {
    console.error("Erreur lancerPartie:", err);
    try { await interaction.editReply({ content: "❌ Erreur interne lors du lancement de la partie." }); } catch (_) {}
    return;
  }

  if (!resultat) {
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: "❌ Pas assez de participants, mise invalide ou joueurs sans fonds.", embeds: [], components: [] });
      } else {
        await interaction.reply({ content: "❌ Pas assez de participants, mise invalide ou joueurs sans fonds.", ephemeral: true });
      }
    } catch (err) {
      console.error("Erreur réponse pas de résultat:", err);
    }
    return;
  }

  const { victime, survivants, gainParSurvivant } = resultat;

  try { await interaction.editReply({ content: "🔫 Le barillet tourne...", embeds: [], components: [] }); } catch (err) { console.warn("editReply 1 failed:", err); }

  setTimeout(async () => {
    try { await interaction.editReply({ content: "😰 Suspense... *clic*..." }); } catch (err) { console.warn("editReply 2 failed:", err); }
  }, 2000);

  setTimeout(async () => {
    try {
      const texteSurvivants = survivants.map(p => `• ${p.nom} (+${format(gainParSurvivant)})`).join("\n");
      await interaction.editReply({
        content: `💥 *BANG!* ${victime.nom} a été éliminé.\n\n😅 Survivants :\n${texteSurvivants}`
      });
    } catch (err) {
      console.warn("editReply 3 failed:", err);
    }
  }, 4000);
}

module.exports = {
  chargerPartie,
  sauvegarderPartie,
  initPartie,
  ajouterParticipant,
  lancerPartie,
  resetPartie,
  executerRouletteRusse
};
