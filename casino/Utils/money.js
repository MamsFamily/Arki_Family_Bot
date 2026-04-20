const path = require("path");
const fs = require("fs");

function getMonnaie() {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "../config/money.json"), "utf8"));
  return {
    nom: config.name,
    // emoji: config.icon,
    format: amount => config.format.replace("{amount}", amount),
    color: config.color || "#FFFFFF"
  };
}

module.exports = { getMonnaie };
