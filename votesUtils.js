const { MONTHS_FR, ALIASES } = require('./votesConfig');

function normalizeName(s) {
  if (!s) return '';
  let normalized = s.toLowerCase().trim();
  normalized = normalized.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  normalized = normalized.replace(/[^0-9a-z ]+/g, '');
  normalized = normalized.replace(/\s+/g, ' ');
  return normalized.trim();
}

function fuzzyMatch(playerName, memberName) {
  const pNorm = normalizeName(playerName);
  const mNorm = normalizeName(memberName);
  
  if (!pNorm || !mNorm) return false;
  if (pNorm === mNorm) return true;
  if (mNorm.includes(pNorm) || pNorm.includes(mNorm)) return true;
  
  const pWords = pNorm.split(' ').filter(w => w.length > 2);
  const mWords = mNorm.split(' ').filter(w => w.length > 2);
  for (const pw of pWords) {
    for (const mw of mWords) {
      if (pw === mw) return true;
      if (pw.startsWith(mw) || mw.startsWith(pw)) return true;
    }
  }
  
  if (pNorm.length >= 3 && mNorm.startsWith(pNorm)) return true;
  if (mNorm.length >= 3 && pNorm.startsWith(mNorm)) return true;
  
  return false;
}

function monthNameFr(monthIndex) {
  return MONTHS_FR[monthIndex] || 'INCONNU';
}

async function buildMemberIndex(guild) {
  const index = {};
  const membersList = [];
  const members = await guild.members.fetch();

  members.forEach((member) => {
    const names = [
      member.displayName,
      member.user.username,
      member.user.globalName,
      member.nickname
    ].filter(n => n);
    
    membersList.push({ id: member.id, names: names });
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

  index._membersList = membersList;
  return index;
}

function resolvePlayer(index, playername) {
  const aliasedName = ALIASES[playername] || playername;
  const key = normalizeName(aliasedName);
  
  const ids = index[key] || [];
  if (ids.length === 1) {
    return ids[0];
  }
  
  const membersList = index._membersList || [];
  for (const member of membersList) {
    for (const name of member.names) {
      if (fuzzyMatch(aliasedName, name)) {
        return member.id;
      }
    }
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
  fuzzyMatch,
  monthNameFr,
  buildMemberIndex,
  resolvePlayer,
  formatRewards,
};
