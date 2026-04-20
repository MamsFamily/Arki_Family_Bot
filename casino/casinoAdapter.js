const { chargerInventaire, sauvegarderInventaire, getBalance, setBalance } = require('./Utils/inventaire');

let _inventoryManager = null;

function init(inventoryManager) {
  _inventoryManager = inventoryManager;
}

async function syncLocalFromDB(userId) {
  if (!_inventoryManager) return 0;
  const playerInv = _inventoryManager.getPlayerInventory(userId);
  const diamonds = playerInv['diamants'] || 0;
  const inv = chargerInventaire();
  setBalance(inv, userId, diamonds);
  sauvegarderInventaire(inv);
  return diamonds;
}

async function syncDBFromLocal(userId, oldBalance) {
  if (!_inventoryManager) return;
  const inv = chargerInventaire();
  const newBalance = getBalance(inv, userId);
  const diff = newBalance - oldBalance;
  if (diff > 0) {
    await _inventoryManager.addToInventory(userId, 'diamants', diff, 'Casino', 'Gain casino');
  } else if (diff < 0) {
    await _inventoryManager.removeFromInventory(userId, 'diamants', Math.abs(diff), 'Casino', 'Mise casino');
  }
  return newBalance;
}

module.exports = { init, syncLocalFromDB, syncDBFromLocal };
