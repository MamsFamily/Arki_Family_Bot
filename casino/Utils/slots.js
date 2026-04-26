const { chargerInventaire, sauvegarderInventaire } = require("./inventaire");
const { getMonnaie } = require("./money");
const config = require("../config");
const symboles = ["\uD83C\uDF52", "\uD83C\uDF40", "\uD83C\uDF4B", "\uD83D\uDC8E", "\uD83D\uDD14", "7\uFE0F\u20E3"];
const gains = {
  "\uD83C\uDF52\uD83C\uDF52\uD83C\uDF52": 2,
  "\uD83C\uDF40\uD83C\uDF40\uD83C\uDF40": 3,
  "\uD83C\uDF4B\uD83C\uDF4B\uD83C\uDF4B": 5,
  "\uD83D\uDC8E\uD83D\uDC8E\uD83D\uDC8E": 10,
  "\uD83D\uDD14\uD83D\uDD14\uD83D\uDD14": 25,
  "7\uFE0F\u20E37\uFE0F\u20E37\uFE0F\u20E3": 65,
};

function tirerSymbole() {
  return symboles[Math.floor(Math.random() * symboles.length)];
}

function jouerSlotsProgressif(userId, mise) {
  const rouleaux = [
    tirerSymbole(),
    tirerSymbole(),
    tirerSymbole()
  ];

  const combinaison = rouleaux.join("");

  let multiplicateur = 0;
  if (rouleaux[0] === rouleaux[1] && rouleaux[1] === rouleaux[2]) {
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
