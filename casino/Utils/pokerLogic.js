// utils/pokerLogic.js
const fs = require('fs').promises;
const path = require('path');
const { deal } = require('./deck');
const { generateTableImage } = require('./canvasTable');
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder
} = require('discord.js');

const TABLES_PATH = path.join(__dirname, '..', 'data', 'tables.json');
const INVENTAIRE_PATH = path.join(__dirname, '..', 'config', 'inventaire.json');
const { determineWinners } = require('./pokerHandEvaluator')
const {
    chargerInventaire,
    sauvegarderInventaire
} = require('./inventaire');
const tablesFile = path.join(__dirname, '..', 'data', 'tables.json')

// Valeur max de raise (modifiable plus tard)
const MAX_RAISE = 1000;
const config = require("../config");


async function loadTables() {
    try {
        const raw = await fs.readFile(TABLES_PATH, 'utf8');
        return JSON.parse(raw) || [];
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
}
async function saveTables(tables) {
    await fs.writeFile(TABLES_PATH, JSON.stringify(tables, null, 2), 'utf8');
}
async function loadInventaire() {
    try {
        const raw = await fs.readFile(INVENTAIRE_PATH, 'utf8');
        return JSON.parse(raw) || {};
    } catch (err) {
        if (err.code === 'ENOENT') return {};
        throw err;
    }
}
async function saveInventaire(inv) {
    await fs.writeFile(INVENTAIRE_PATH, JSON.stringify(inv, null, 2), 'utf8');
}
function getBalance(inv, userId) {
    const items = inv[userId] || [];
    const entry = items.find(i => i.name === "argent");
    return entry ? entry.quantite : 0;
}
function setBalance(inv, userId, newQty) {
    const items = inv[userId] || [];
    const idx = items.findIndex(i => i.name === "argent");
    if (idx >= 0) items[idx].quantite = newQty;
    else items.push({ name: "argent", quantite: newQty });
    inv[userId] = items;
}
function initGame(table, sbAmt = 10, bbAmt = 20) {
    const N = table.dansLaPartie.length;
    table.dealerIndex = Math.floor(Math.random() * N);
    table.smallBlindIndex = (table.dealerIndex + 1) % N;
    table.bigBlindIndex = (table.dealerIndex + 2) % N;
    table.statuses = {};
    table.bets = {};
    table.pot = 0;
    table.sidePots = [];
    table.phase = 'preflop';
    table.firstToAct = null;
    table.acted = [];
    table.dansLaPartie.forEach(id => {
        table.statuses[id] = 'active';
        table.bets[id] = 0;
    });
    postBlinds(table, sbAmt, bbAmt);
}
function dealCards(table) {
    const { holeCards, deck } = deal(table.dansLaPartie.length);
    table.holeCards = {};
    table.dansLaPartie.forEach((id, i) => { table.holeCards[id] = holeCards[i]; });
    table.communityCards = [];
    table._deck = deck;
}
function postBlinds(table, sbAmt, bbAmt) {
    const sb = table.dansLaPartie[table.smallBlindIndex];
    const bb = table.dansLaPartie[table.bigBlindIndex];
    table.bets[sb] = sbAmt;
    table.bets[bb] = bbAmt;
    table.pot = sbAmt + bbAmt;
}
function startBettingRound(table) {
    if (table.phase !== 'preflop') {
        Object.keys(table.bets).forEach(id => table.bets[id] = 0);
    }
    const N = table.dansLaPartie.length;
    let idx = (table.dealerIndex + 1) % N;
    while (table.statuses[table.dansLaPartie[idx]] !== 'active') {
        idx = (idx + 1) % N;
    }
    table.currentPlayerIndex = idx;
    table.firstToAct = idx;
    table.acted = [];
}
async function handleAction(table, playerId, action, amount = 0, thread) {
  // 1) Validation du tour
  const curIdx    = table.currentPlayerIndex
  const curPlayer = table.dansLaPartie[curIdx]
  if (playerId !== curPlayer) throw new Error('Ce n’est pas ton tour')
  if (table.statuses[playerId] !== 'active')
    throw new Error('Tu ne peux pas agir')

  // 2) Snapshot des “actifs” AVANT l’action (hors folded/all-in)
  const beforeActive = table.dansLaPartie.filter(
    id => table.statuses[id] === 'active'
  )
  const previousMax = beforeActive.length
    ? Math.max(...beforeActive.map(id => table.bets[id]))
    : 0

  // 3) Appliquer fold/check/call/raise/allin
  switch (action) {
    case 'fold':
      table.statuses[playerId] = 'folded'
      break

    case 'check':
      if (table.bets[playerId] !== previousMax)
        throw new Error('Tu dois égaler la mise pour check')
      break

    case 'call':
    case 'raise':
    case 'allin':
      table.bets[playerId] += amount
      table.pot           += amount
      if (action === 'allin') {
        table.statuses[playerId] = 'allin'
      }
      break

    default:
      throw new Error('Action inconnue')
  }

  // 4) Nouveau cycle si raise/all-in augmente la mise
  const newMax       = beforeActive.length
    ? Math.max(...beforeActive.map(id => table.bets[id]))
    : 0
  const isAggressive = (action === 'raise' || action === 'allin')
    && newMax > previousMax

  if (isAggressive) {
    table.firstToAct = curIdx
    table.acted      = [playerId]
  } else {
    table.acted.push(playerId)
  }

  // 5) Filtrer les “actifs” APRÈS l’action (hors folded/all-in)
  const remainingActive = table.dansLaPartie.filter(
    id => table.statuses[id] === 'active'
  )

  // 6) Détecter une win immédiate si un seul reste
  const survivors = table.dansLaPartie.filter(
    id => table.statuses[id] !== 'folded'
  )
  if (survivors.length === 1) {
    await finalizePartie(thread, table)
    return
  }

  // 7) Déterminer nextPlayerId s’il y a encore >1 “active”
  let nextPlayerId = null
  if (remainingActive.length > 0) {
    let idx = curIdx
    // on tourne autour de la table jusqu’à trouver un “active”
    for (let i = 0; i < table.dansLaPartie.length; i++) {
      idx = (idx + 1) % table.dansLaPartie.length
      if (table.statuses[table.dansLaPartie[idx]] === 'active') {
        nextPlayerId = table.dansLaPartie[idx]
        table.currentPlayerIndex = idx
        break
      }
    }
  }

  // 8) Calcul du roundComplete
  //    vrai si plus qu’un seul “active” OU
  //    tous les “actifs” ont agi ET c’est de nouveau au premier
  const actedActive = table.acted.filter(
    id => table.statuses[id] === 'active'
  )
  const roundComplete = remainingActive.length <= 1
    ? true
    : (actedActive.length === remainingActive.length
       && nextPlayerId === table.dansLaPartie[table.firstToAct])

  // 9) Si showdown (river + 5 cards)
  if (
    roundComplete
    && table.phase === 'river'
    && Array.isArray(table.communityCards)
    && table.communityCards.length >= 5
  ) {
    await finalizePartie(thread, table)
    return
  }

  // 10) Sinon on continue
  return { nextPlayerId, roundComplete, amount, action }
}
function advancePhase(table) {
    switch (table.phase) {
        case 'preflop':
            table.communityCards.push(...table._deck.splice(0, 3));
            table.phase = 'flop';
            break;
        case 'flop':
            table.communityCards.push(table._deck.shift());
            table.phase = 'turn';
            break;
        case 'turn':
            table.communityCards.push(table._deck.shift());
            table.phase = 'river';
            break;
        default:
            throw new Error('Phase non supportée');
    }
    startBettingRound(table);
}
function getCommunityReveal(table) {
    const cc = table.communityCards || [];
    switch (table.phase) {
        case 'flop': return cc.map((c, i) => i < 3 ? c : 'back');
        case 'turn': return cc.map((c, i) => i < 4 ? c : 'back');
        case 'river': return cc.slice(0, 5);
        default: return Array(5).fill('back');
    }
}
function buildActionRow(table, balanceSolde) {
    const activeIds = table.dansLaPartie.filter(id => table.statuses[id] === 'active');
    const maxBet = Math.max(...activeIds.map(id => table.bets[id]));

    const checkBtn = new ButtonBuilder()
        .setCustomId('poker_check')
        .setLabel('Check')
        .setStyle(ButtonStyle.Secondary);

    const callBtn = new ButtonBuilder()
        .setCustomId('poker_call')
        .setLabel(`Suivre (${maxBet})`)
        .setStyle(ButtonStyle.Primary);

    const raiseBtn = new ButtonBuilder()
        .setCustomId('poker_raise')
        .setLabel('Relancer')
        .setStyle(ButtonStyle.Success);

    const foldBtn = new ButtonBuilder()
        .setCustomId('poker_fold')
        .setLabel('Se coucher')
        .setStyle(ButtonStyle.Danger);

    // const allinBtn = new ButtonBuilder()
    //     .setCustomId('poker_allin')
    //     .setLabel('Tapis')
    //     .setStyle(ButtonStyle.Danger)
    //     .setDisabled(balanceSolde > MAX_RAISE);

    return new ActionRowBuilder().addComponents(
        checkBtn,
        callBtn,
        raiseBtn,
        foldBtn
        // allinBtn
    );
}
async function executerAction(interaction, rawAction, rawAmount = 0) {
  await interaction.deferReply({ ephemeral: true })

  // 1) Charger table + valider participation
  const userId = interaction.user.id
  const thread = interaction.channel
  const tables = await loadTables()
  const table  = tables.find(t => t.threadId === thread.id)
  if (!table || !table.dansLaPartie.includes(userId)) {
    return interaction.followUp({
      content: '❌ Tu n’es pas dans cette partie.',
      ephemeral: true
    })
  }

  // 2) Charger inventaire + solde
  const inv   = await loadInventaire()
  let balance = getBalance(inv, userId)
  if (balance <= 0) {
    table.statuses[userId] = 'folded'
    await saveTables(tables)
    return interaction.followUp({
      content: '❌ Plus de jetons : tu couches automatiquement.',
      ephemeral: true
    })
  }

  // 3) Empêcher all-in si au dessus de la limite
  if (rawAction === 'allin' && balance > MAX_RAISE) {
    return interaction.followUp({
      content: `❌ All-in non dispo : tu as plus de **${MAX_RAISE}💎**.`,
      ephemeral: true
    })
  }

  // 4) Calculer currentMax / toCall
  const activeIds  = table.dansLaPartie.filter(
    id => table.statuses[id] === 'active'
  )
  const currentMax = activeIds.length
    ? Math.max(...activeIds.map(id => table.bets[id]))
    : 0
  const toCall = currentMax - table.bets[userId]

  // 5) Déterminer action & amount réels
  let action = rawAction
  let amount = 0
  if (action === 'call') {
    amount = Math.min(balance, toCall)
    if (amount === balance) action = 'allin'
  } else if (action === 'raise') {
    if (rawAmount < currentMax) {
      return interaction.followUp({
        content: `❌ Ta relance doit être ≥ **${currentMax}💎**.`,
        ephemeral: true
      })
    }
    const needed = rawAmount - table.bets[userId]
    amount = Math.min(balance, needed)
    if (amount === balance) action = 'allin'
  } else if (action === 'allin') {
    amount = balance
  }

  // 6) Appliquer l’action
  let result
  try {
    result = await handleAction(table, userId, action, amount, thread)
  } catch (err) {
    return interaction.followUp({
      content: `❌ ${err.message}`,
      ephemeral: true
    })
  }
  if (!result) return // finalizePartie a tourné

  const { nextPlayerId, roundComplete, amount: realAmount, action: realAction } = result

  // 7) Si cycle clos → nouvelle phase + reset betting
  if (roundComplete) {
    advancePhase(table)
    startBettingRound(table)
  }

  // 8) Débiter le joueur + sauvegarder
  balance -= realAmount
  setBalance(inv, userId, balance)
  await saveInventaire(inv)
  await saveTables(tables)

  // 9) Générer vue publique (toutes les hole cards masquées)
  const playersPublic = await Promise.all(
    table.dansLaPartie.map(async id => {
      const member = await interaction.guild.members.fetch(id).catch(() => null)
      return {
        name:      member?.displayName || `<@${id}>`,
        money:     getBalance(inv, id),
        holeCards: ['back', 'back']
      }
    })
  )
  const buffer = await generateTableImage(
    playersPublic,
    table.pot,
    getCommunityReveal(table)
  )

  // 10) Envoyer image + bouton “Voir mes cartes”
  const viewBtn = new ButtonBuilder()
    .setCustomId('poker_voir_cartes')
    .setLabel('Voir mes cartes')
    .setStyle(ButtonStyle.Secondary)

  await thread.send({
    files:      [{ attachment: buffer, name: 'table.png' }],
    components: [ new ActionRowBuilder().addComponents(viewBtn) ]
  })

  // 11) Mention & boutons pour nextPlayerId S’IL EST encore “active”
  if (nextPlayerId) {
    await thread.send({
      content: `<@${nextPlayerId}> c'est à toi de jouer`,
      components: [ buildActionRow(table, getBalance(inv, nextPlayerId)) ]
    })
  }

  // 12) Confirmation privée
  return interaction.followUp({
    content: `✅ Action **${realAction}** (${realAmount}💎) enregistrée.`,
    ephemeral: true
  })
}
function getCommunityReveal(table) {
    const revealed = table.communityCards || [];
    const hiddenCount = 5 - revealed.length;
    return [
        ...revealed,
        ...Array(hiddenCount).fill('back')
    ];
}
async function finalizePartie(thread, table) {
  // 1) Qui gagne et partage du pot
  const winners = determineWinners(table)    // array d’IDs
  const pot     = table.pot
  const share   = Math.floor(pot / winners.length)

  // 2) Mise à jour de l’inventaire
  const inv = await chargerInventaire()
  for (const id of winners) {
    const oldBal = getBalance(inv, id)
    setBalance(inv, id, oldBal + share)
  }
  await sauvegarderInventaire(inv)

  // 3) Construction de l’embed récapitulatif des mains
  //    On affiche chaque joueur et ses cartes fermées,
  //    en mettant 🏆 devant les gagnants.
  const fields = await Promise.all(
    table.dansLaPartie.map(async id => {
      const member = await thread.guild.members.fetch(id).catch(() => null)
      const label  = member?.displayName || `<@${id}>`
      const isWinner = winners.includes(id)
      const hole = table.holeCards[id] || []
      const cardsDisplay = hole.length
        ? hole.join(' ')
        : '–'
      return {
        name:   `${isWinner ? '🏆 ' : ''}${label}`,
        value:  cardsDisplay,
        inline: true
      }
    })
  )

  const title = winners.length > 1
    ? '🤝 Égalité et partage du pot'
    : '🏆 Victoire et pot entier !'
  const description = winners.length > 1
    ? `${winners.map(id => `<@${id}>`).join(' et ')} remportent chacun **${share} ${config.iconMonnaie}** !`
    : `<@${winners[0]}> remporte **${pot} ${config.iconMonnaie}** !`

  const resultEmbed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(config.color)
    .addFields(fields)

  // 4) Boutons « Quitter la table » et « Relancer »
  const quitterBtn = new ButtonBuilder()
    .setCustomId('poker_quitter_table')
    .setLabel('Quitter la table')
    .setStyle(ButtonStyle.Danger)

  const relaunchBtn = new ButtonBuilder()
    .setCustomId('poker_relaunch')
    .setLabel('Relancer la partie')
    .setStyle(ButtonStyle.Success)

  const row = new ActionRowBuilder().addComponents(quitterBtn, relaunchBtn)

  // 5) Envoi de l’embed + row
  await thread.send({
    embeds:     [resultEmbed],
    components: [row]
  })
}

async function executerCheck(interaction) { return executerAction(interaction, 'check'); }
async function executerCall(interaction) { return executerAction(interaction, 'call'); }
async function executerRaise(interaction, amt = 0) { return executerAction(interaction, 'raise', amt); }
async function executerFold(interaction) { return executerAction(interaction, 'fold'); }
async function executerAllIn(interaction) { return executerAction(interaction, 'allin'); }

module.exports = {
    MAX_RAISE,
    dealCards,
    startBettingRound,
    handleAction,
    advancePhase,
    initGame,

    executerCheck,
    executerCall,
    executerRaise,
    executerFold,
    executerAllIn
};
