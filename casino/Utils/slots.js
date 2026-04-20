const { chargerInventaire, sauvegarderInventaire } = require("./inventaire");
const { getMonnaie } = require("./money");
const config = require("../config");
const symboles = ["🍒", "🍋", "💎", "🔔", "7️⃣"];
const gains = {
  "🍒🍒🍒": 5,
  "🍋🍋🍋": 10,
  "💎💎💎": 20,
  "🔔🔔🔔": 50,
  "7️⃣7️⃣7️⃣": 100
};

function tirerSymbole() {
  return symboles[Math.floor(Math.random() * symboles.length)];
  
}

function jouerSlotsProgressif(userId, mise) {
  // Tirage des 3 rouleaux
  const rouleaux = [
    tirerSymbole(),
    tirerSymbole(),
    tirerSymbole()
  ];

  // Combinaison brute pour affichage
  const combinaison = rouleaux.join("");

  // On ne paye que si les 3 symboles sont identiques
  let multiplicateur = 0;
  if (
    rouleaux[0] === rouleaux[1] && rouleaux[1] === rouleaux[2]
  ) {
    multiplicateur = gains[combinaison] || 0;
  }

  const gain = multiplicateur * mise;
  const emoji = config.iconMonnaie;
  const inventaire = chargerInventaire();

  if (gain > 0) {
    if (!inventaire[userId]) {
      inventaire[userId] = [];
    }

    const idx = inventaire[userId].findIndex(
      obj => obj.name === "argent"
    );

    if (idx === -1) {
      inventaire[userId].push({ emoji, quantite: gain });
    } else {
      inventaire[userId][idx].quantite += gain;
    }

    sauvegarderInventaire(inventaire);
  }

  return { rouleaux, gain, combinaison, multiplicateur };


}

module.exports = {
  jouerSlotsProgressif,
  tirerSymbole
};
