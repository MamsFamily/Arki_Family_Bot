const pgStore = require('./pgStore');

const KEY_COOLDOWNS  = 'economy_cooldowns';
const KEY_ROLES      = 'economy_roles';
const KEY_FINES      = 'economy_fines';

let cooldownCache = null;
let roleCache     = null;

// ── Persistance ─────────────────────────────────────────────────────────────
async function loadCooldowns() {
  if (cooldownCache) return cooldownCache;
  const data = await pgStore.getData(KEY_COOLDOWNS);
  cooldownCache = data || {};
  return cooldownCache;
}

async function saveCooldowns(data) {
  cooldownCache = data;
  await pgStore.setData(KEY_COOLDOWNS, data);
}

async function loadRoles() {
  if (roleCache) return roleCache;
  const data = await pgStore.getData(KEY_ROLES);
  roleCache = data || {};
  return roleCache;
}

async function saveRoles(data) {
  roleCache = data;
  await pgStore.setData(KEY_ROLES, data);
}

// ── Cooldowns ────────────────────────────────────────────────────────────────
// key = 'bonus' | 'revenu'
async function getCooldown(userId, key) {
  const all = await loadCooldowns();
  const user = all[userId] || {};
  return user[key] || 0;
}

async function setCooldown(userId, key, ts) {
  const all = await loadCooldowns();
  if (!all[userId]) all[userId] = {};
  all[userId][key] = ts;
  await saveCooldowns(all);
}

// Rôles déjà inclus dans le dernier paiement /revenus du joueur
async function getClaimedRoles(userId) {
  const all = await loadCooldowns();
  return (all[userId] || {}).revenuRoles || null; // null = jamais stocké (legacy)
}

async function setClaimedRoles(userId, roleIds) {
  const all = await loadCooldowns();
  if (!all[userId]) all[userId] = {};
  all[userId].revenuRoles = roleIds;
  await saveCooldowns(all);
}

// ── Revenus de rôles ─────────────────────────────────────────────────────────
// Structure : { roleId: { name, income, shopDiscount } }
async function getRoleIncomes() {
  return await loadRoles();
}

async function setRoleIncome(roleId, name, income, shopDiscount) {
  const roles = await loadRoles();
  // Conserver addedAt si le rôle existe déjà, sinon horodater maintenant
  const existing = roles[roleId] || {};
  roles[roleId] = {
    name,
    income: parseInt(income) || 0,
    shopDiscount: parseFloat(shopDiscount) || 0,
    addedAt: existing.addedAt || Date.now(),
  };
  await saveRoles(roles);
  roleCache = roles;
  return roles;
}

async function deleteRoleIncome(roleId) {
  const roles = await loadRoles();
  delete roles[roleId];
  await saveRoles(roles);
  return roles;
}

// ── Calcul revenu joueur ─────────────────────────────────────────────────────
async function calcPlayerRevenue(memberRoleIds) {
  const roles = await loadRoles();
  const matched = [];
  for (const [roleId, cfg] of Object.entries(roles)) {
    if (memberRoleIds.includes(roleId) && cfg.income > 0) {
      matched.push({ roleId, name: cfg.name, income: cfg.income, shopDiscount: cfg.shopDiscount || 0, addedAt: cfg.addedAt || 0 });
    }
  }
  const total = matched.reduce((s, r) => s + r.income, 0);
  return { lines: matched, total };
}

// ── Constantes ───────────────────────────────────────────────────────────────
const BONUS_COOLDOWN_MS  = 4 * 60 * 60 * 1000;   // 4h
const REVENU_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours
const WELCOME_DIAMONDS   = 3000;
const BONUS_MIN          = 50;
const BONUS_MAX          = 250;

function randBonus() {
  return Math.floor(Math.random() * (BONUS_MAX - BONUS_MIN + 1)) + BONUS_MIN;
}

module.exports = {
  getCooldown, setCooldown,
  getClaimedRoles, setClaimedRoles,
  getRoleIncomes, setRoleIncome, deleteRoleIncome, calcPlayerRevenue,
  BONUS_COOLDOWN_MS, REVENU_COOLDOWN_MS,
  WELCOME_DIAMONDS, BONUS_MIN, BONUS_MAX, randBonus,
};
