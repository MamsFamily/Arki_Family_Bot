// utils/deck.js

/**
 * Génère un jeu de 52 cartes standard.
 * Les codes de cartes correspondent au nom de tes fichiers PNG,
 * par exemple "AH.png", "10D.png", "KS.png", etc.
 */
function createDeck() {
  const suits = ['C', 'D', 'H', 'S']    // Clubs, Diamonds, Hearts, Spades
  const ranks = [
    '2', '3', '4', '5', '6', '7', '8', '9', '10',
    'J', 'Q', 'K', 'A'
  ]

  const deck = []
  for (const r of ranks) {
    for (const s of suits) {
      deck.push(`${r}${s}`)
    }
  }
  return deck
}

/**
 * Mélange un tableau en place selon l’algorithme de Fisher-Yates.
 * @param {string[]} deck
 * @returns {string[]} le même tableau mélangé
 */
function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[deck[i], deck[j]] = [deck[j], deck[i]]
  }
  return deck
}

/**
 * Distribue les cartes :
 * - 2 cartes (hole cards) par joueur
 * - 5 cartes communautaires (flop/turn/river) au centre
 * @param {number} numPlayers
 * @returns {{
 *   holeCards: string[][],
 *   communityCards: string[],
 *   deck: string[]
 * }}
 */
function deal(numPlayers) {
  if (numPlayers < 2 || numPlayers > 10) {
    throw new Error('Nombre de joueurs invalide, doit être entre 2 et 10')
  }

  // 1) création + mélange
  const deck = shuffleDeck(createDeck())

  // 2) distribution des hole cards
  const holeCards = []
  for (let p = 0; p < numPlayers; p++) {
    holeCards.push([
      deck.shift(), // première carte
      deck.shift()  // deuxième carte
    ])
  }

  // 3) cartes communautaires
  const communityCards = [
    deck.shift(), // flop 1
    deck.shift(), // flop 2
    deck.shift(), // flop 3
    deck.shift(), // turn
    deck.shift()  // river
  ]

  return { holeCards, communityCards, deck }
}

module.exports = {
  createDeck,
  shuffleDeck,
  deal
}