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

// ── Revenus de rôles ─────────────────────────────────────────────────────────
// Structure : { roleId: { name, income, shopDiscount } }
async function getRoleIncomes() {
  return await loadRoles();
}

async function setRoleIncome(roleId, name, income, shopDiscount) {
  const roles = await loadRoles();
  roles[roleId] = { name, income: parseInt(income) || 0, shopDiscount: parseFloat(shopDiscount) || 0 };
  await saveRoles(roles);
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
      matched.push({ roleId, name: cfg.name, income: cfg.income, shopDiscount: cfg.shopDiscount || 0 });
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
  getRoleIncomes, setRoleIncome, deleteRoleIncome, calcPlayerRevenue,
  BONUS_COOLDOWN_MS, REVENU_COOLDOWN_MS,
  WELCOME_DIAMONDS, BONUS_MIN, BONUS_MAX, randBonus,
};
