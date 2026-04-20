// utils/pokerHandEvaluator.js

// Valeurs et catégories
const RANKS = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
                '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12,
                'K': 13, 'A': 14 };

const HAND_RANK = {
  HIGH_CARD:        0,
  ONE_PAIR:         1,
  TWO_PAIRS:        2,
  THREE_OF_A_KIND:  3,
  STRAIGHT:         4,
  FLUSH:            5,
  FULL_HOUSE:       6,
  FOUR_OF_A_KIND:   7,
  STRAIGHT_FLUSH:   8,
  ROYAL_FLUSH:      9
};

// 1) Parse un code carte en { value, suit }
function parseCard(code) {
  const suit  = code.slice(-1);
  const rank  = code.slice(0, code.length - 1);
  return { value: RANKS[rank], suit };
}

// 2) Générateur de combinaisons (nCk)
function combinations(arr, k) {
  const res = [];
  (function backtrack(start, comb) {
    if (comb.length === k) {
      res.push(comb.slice());
      return;
    }
    for (let i = start; i < arr.length; i++) {
      comb.push(arr[i]);
      backtrack(i + 1, comb);
      comb.pop();
    }
  })(0, []);
  return res;
}

// 3) Évalue une main de 5 cartes et renvoie [catégorie, tiebreakers...]
function evaluate5(cards) {
  const parsed = cards.map(parseCard).sort((a, b) => b.value - a.value);
  const counts = {};           // { value: count }
  const suits  = {};           // { suit: [values] }
  const vals   = parsed.map(c => c.value);

  for (const c of parsed) {
    counts[c.value] = (counts[c.value] || 0) + 1;
    suits[c.suit]   = suits[c.suit] ? [...suits[c.suit], c.value] : [c.value];
  }

  // Helper: check flush
  const flushSuit = Object.entries(suits).find(([, arr]) => arr.length >= 5)?.[0];
  const isFlush   = !!flushSuit;

  // Helper: check straight (incl. wheel A-2-3-4-5)
  let isStraight = false;
  let topStraight = 0;
  const uniqVals = [...new Set(vals)];
  for (let i = 0; i <= uniqVals.length - 5; i++) {
    const slice = uniqVals.slice(i, i + 5);
    if (slice[0] - slice[4] === 4) {
      isStraight    = true;
      topStraight   = slice[0];
      break;
    }
  }
  // Cas wheel
  if (!isStraight && uniqVals.includes(14) &&
      uniqVals.slice(-4).join() === '5,4,3,2') {
    isStraight  = true;
    topStraight = 5;
  }

  // Straight flush / Royal
  if (isFlush) {
    const flushCards = parsed.filter(c => c.suit === flushSuit)
                              .map(c => c.value);
    const uniqF = [...new Set(flushCards)];
    for (let i = 0; i <= uniqF.length - 5; i++) {
      const slice = uniqF.slice(i, i + 5);
      if (slice[0] - slice[4] === 4) {
        const top = slice[0] === 14 && slice[4] === 10 ? 14 : slice[0];
        return [
          top === 14 ? HAND_RANK.ROYAL_FLUSH : HAND_RANK.STRAIGHT_FLUSH,
          top
        ];
      }
    }
  }

  // Comptages pour paires, brelans, carrés
  const groups = Object.entries(counts)
    .map(([v, c]) => ({ value: +v, count: c }))
    .sort((a, b) => b.count - a.count || b.value - a.value);

  // Carré
  if (groups[0].count === 4) {
    return [HAND_RANK.FOUR_OF_A_KIND, groups[0].value,
            groups[1].value];  // kicker
  }

  // Full house
  if (groups[0].count === 3 && groups[1].count >= 2) {
    return [HAND_RANK.FULL_HOUSE, groups[0].value, groups[1].value];
  }

  if (isFlush) {
    // flush kickers
    const top5 = suits[flushSuit].sort((a,b)=>b-a).slice(0,5);
    return [HAND_RANK.FLUSH, ...top5];
  }

  if (isStraight) {
    return [HAND_RANK.STRAIGHT, topStraight];
  }

  // Brelan
  if (groups[0].count === 3) {
    const kickers = parsed
      .map(c => c.value)
      .filter(v => v !== groups[0].value)
      .slice(0, 2);
    return [HAND_RANK.THREE_OF_A_KIND,
            groups[0].value, ...kickers];
  }

  // Deux paires
  if (groups[0].count === 2 && groups[1].count === 2) {
    const kicker = parsed
      .map(c => c.value)
      .filter(v => v !== groups[0].value && v !== groups[1].value)[0];
    return [HAND_RANK.TWO_PAIRS,
            groups[0].value, groups[1].value, kicker];
  }

  // Paire
  if (groups[0].count === 2) {
    const kickers = parsed
      .map(c => c.value)
      .filter(v => v !== groups[0].value)
      .slice(0, 3);
    return [HAND_RANK.ONE_PAIR,
            groups[0].value, ...kickers];
  }

  // Carte haute
  return [HAND_RANK.HIGH_CARD, ...parsed.map(c=>c.value).slice(0,5)];
}

// 4) Compare deux évaluations : return 1 si a > b, -1 si a < b, 0 si égal
function compareEval(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

// 5) Pour un joueur, trouve la meilleure éval sur ses 7 cartes
function bestEvalForPlayer(hole, community) {
  const pool  = [...hole, ...community];
  const hands = combinations(pool, 5);
  let best   = null;
  let bestE  = null;
  for (const h of hands) {
    const e = evaluate5(h);
    if (!bestE || compareEval(e, bestE) > 0) {
      bestE = e;
      best  = h;
    }
  }
  return bestE;
}

// 6) Détermine le(s) meilleur(s) joueur(s)
function determineWinners(table) {
  const community = table.communityCards;      // ['AH','10S',...]
  const inGame    = table.dansLaPartie
    .filter(id => table.statuses[id] !== 'folded');

  let winners = [];
  let bestE   = null;

  for (const id of inGame) {
    const hole   = table.holeCards[id];        // ['KH','3D']
    const thisE  = bestEvalForPlayer(hole, community);

    if (!bestE || compareEval(thisE, bestE) > 0) {
      bestE   = thisE;
      winners = [id];
    } else if (compareEval(thisE, bestE) === 0) {
      winners.push(id);
    }
  }

  return winners;
}

module.exports = { determineWinners };
