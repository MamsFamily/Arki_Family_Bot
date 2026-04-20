const fs = require("fs");
const path = require("path");
const config = require("../config");


const inventairePath = path.join(__dirname, "../config/inventaire.json");

function chargerInventaire() {
  if (!fs.existsSync(inventairePath)) return {};
  return JSON.parse(fs.readFileSync(inventairePath, "utf8"));
}

function sauvegarderInventaire(data) {
  fs.writeFileSync(inventairePath, JSON.stringify(data, null, 4));
}
function getBalance(inv, userId) {
  const items = inv[userId] || [];
  const entry = items.find(i => i.name === "argent");
  return entry ? entry.quantite : 0;
}


function setBalance(inv, userId, newQty) {
  const items = inv[userId] || [];
  const idx = items.findIndex(i => i.name === "argent");

  if (idx >= 0) {
    // Mise à jour de l’entrée existante
    items[idx].quantite = newQty;
  } else {
    // Création d’une nouvelle entrée si jamais le joueur n’avait pas d’argent
    items.push({ name: "argent", quantite: newQty });
  }

  inv[userId] = items;
}
module.exports = {
  chargerInventaire,
  sauvegarderInventaire,
  setBalance,
  getBalance
};
