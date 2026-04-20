const fs = require("fs");
const path = require("path");
const { getMonnaie } = require("./money");
const { chargerInventaire, sauvegarderInventaire } = require("./inventaire");
const config = require("../config");


const blackjackPath = path.join(__dirname, "../config/blackjack.json");

// 🔧 Charger les parties en cours
function chargerParties() {
  if (!fs.existsSync(blackjackPath)) return {};
  return JSON.parse(fs.readFileSync(blackjackPath, "utf8"));
}


function sauvegarderParties(data) {
  fs.writeFileSync(blackjackPath, JSON.stringify(data, null, 4));
}

function tirerCarte() {
  const valeurs = [2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10, 10, 11]; // 10 = J/Q/K, 11 = As
  return valeurs[Math.floor(Math.random() * valeurs.length)];
}

function calculerScore(cartes) {
  let total = cartes.reduce((a, b) => a + b, 0);
  let nbAs = cartes.filter(c => c === 11).length;

  while (total > 21 && nbAs > 0) {
    total -= 10;
    nbAs--;
  }

  return total;
}

// 🎯 Initialisation de la partie
function jouerBlackjack(userId, mise) {
  const parties = chargerParties();
  const cartes = [tirerCarte(), tirerCarte()];
  const score = calculerScore(cartes);

  parties[userId] = {
    mise,
    cartes,
    etat: "en cours"
  };

  sauvegarderParties(parties);
}

// 🎯 Tirer une carte
function tirer(userId) {
  const parties = chargerParties();
  const partie = parties[userId];
  if (!partie || partie.etat !== "en cours") return null;

  partie.cartes.push(tirerCarte());
  const score = calculerScore(partie.cartes);

  if (score > 21) {
    partie.etat = "perdu";
  }

  sauvegarderParties(parties);
  return { cartes: partie.cartes, score, etat: partie.etat };
}

// 🎯 Rester et résoudre
function rester(userId) {
  const parties = chargerParties();
  const partie = parties[userId];
  if (!partie || partie.etat !== "en cours") return null;

  const joueurScore = calculerScore(partie.cartes);
  const croupierCartes = [tirerCarte(), tirerCarte()];
  let croupierScore = calculerScore(croupierCartes);

  while (croupierScore < 17) {
    croupierCartes.push(tirerCarte());
    croupierScore = calculerScore(croupierCartes);
  }

  let gain = 0;
  let resultat = "";

  if (joueurScore > 21) {
    resultat = "❌ Tu as dépassé 21.";
  } else if (croupierScore > 21 || joueurScore > croupierScore) {
    gain = partie.mise * 2;
    resultat = `✅ Tu gagnes ! Tu remportes ${gain} ${config.iconMonnaie}.`;
  } else if (joueurScore === croupierScore) {
    gain = partie.mise;
    resultat = `➖ Égalité. Ta mise t'est rendue.`;
  } else {
    resultat = "❌ Le croupier gagne.";
  }

  partie.etat = "terminee";
  sauvegarderParties(parties);

  // 💰 Créditer les gains
  if (gain > 0) {
    const { emoji } = getMonnaie();
    const inventaire = chargerInventaire();
    if (!inventaire[userId]) inventaire[userId] = [];

    const idx = inventaire[userId].findIndex(obj => obj.name === "argent");
    if (idx === -1) {
      inventaire[userId].push({ emoji, quantite: gain });
    } else {
      inventaire[userId][idx].quantite += gain;
    }

    sauvegarderInventaire(inventaire);
  }

  return {
    joueur: partie.cartes,
    joueurScore,
    croupier: croupierCartes,
    croupierScore,
    resultat
  };
}

module.exports = {
  jouerBlackjack,
  tirer,
  rester,
  chargerParties,
  calculerScore
};
