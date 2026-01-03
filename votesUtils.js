const { MONTHS_FR, ALIASES } = require('./votesConfig');

function normalizeName(s) {
  if (!s) return '';
  let normalized = s.toLowerCase().trim();
  normalized = normalized.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  normalized = normalized.replace(/[^0-9a-z ]+/g, '');
  normalized = normalized.replace(/\s+/g, ' ');
  return normalized.trim();
}

function monthNameFr(monthIndex) {
  return MONTHS_FR[monthIndex] || 'INCONNU';
}

async function buildMemberIndex(guild) {
  const index = {};
  const members = await guild.members.fetch();

  members.forEach((member) => {
    const names = [member.displayName, member.user.username];
    for (const name of names) {
      const key = normalizeName(name);
      if (!index[key]) {
        index[key] = [];
      }
      if (!index[key].includes(member.id)) {
        index[key].push(member.id);
      }
    }
  });

  return index;
}

function resolvePlayer(index, playername) {
  const key = normalizeName(ALIASES[playername] || playername);
  const ids = index[key] || [];
  if (ids.length === 1) {
    return ids[0];
  }
  return null;
}

function formatRewards(rewards) {
  return Object.entries(rewards)
    .map(([item, qty]) => `${item} x${qty}`)
    .join(', ');
}

module.exports = {
  normalizeName,
  monthNameFr,
  buildMemberIndex,
  resolvePlayer,
  formatRewards,
};
