const { createHash, randomUUID } = require('node:crypto');
const { trimHistory } = require('./inventoryPersistence');

const MONTHS = ['JANVIER', 'FEVRIER', 'MARS', 'AVRIL', 'MAI', 'JUIN',
  'JUILLET', 'AOUT', 'SEPTEMBRE', 'OCTOBRE', 'NOVEMBRE', 'DECEMBRE'];
const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
const planKey = id => `vote-rollback-plan:${id}`;
const reversalKey = id => `vote-rollback-tx:${id}`;

function voteMonth(tx) {
  if (tx.type !== 'add') return null;
  const month = normalize(tx.reason).match(/\bVOTES\s+([A-Z]+)\b/)?.[1];
  return MONTHS.includes(month) ? month : null;
}

function fingerprint(transactions) {
  return createHash('sha256').update(JSON.stringify([...transactions].sort((a, b) => a.id.localeCompare(b.id)))).digest('hex');
}

function selectLatestVoteBatch(transactions, { month, since } = {}) {
  const normalizedMonth = month ? normalize(month) : null;
  if (normalizedMonth && !MONTHS.includes(normalizedMonth)) throw new Error('Nom de mois invalide.');
  if (since && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(since) ||
      !Number.isFinite(Date.parse(since)))) {
    throw new Error('Indique une date avec son fuseau : 2026-11-06T10:15:00+01:00.');
  }
  if (since) {
    const [year, monthNumber, day] = since.slice(0, 10).split('-').map(Number);
    if (day < 1 || day > new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()) {
      throw new Error('Date de début invalide.');
    }
  }
  const candidates = transactions.filter(tx => voteMonth(tx) &&
    (!normalizedMonth || voteMonth(tx) === normalizedMonth));
  if (!candidates.length) throw new Error('Aucun versement de votes trouvé.');
  for (const tx of candidates) {
    if (typeof tx.id !== 'string' || !tx.id || !Number.isFinite(Date.parse(tx.timestamp)) ||
        typeof tx.playerId !== 'string' || !tx.playerId || typeof tx.itemTypeId !== 'string' ||
        !tx.itemTypeId || !Number.isSafeInteger(tx.quantity) || tx.quantity < 0) {
      throw new Error('Historique des votes invalide : annulation bloquée.');
    }
  }
  candidates.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const newest = candidates[0];
  let selected;
  if (newest.voteBatchId) {
    // A complete run includes diamonds, pack contents and the Shiny draw.
    selected = candidates.filter(tx => tx.voteBatchId === newest.voteBatchId);
  } else {
    if (!since) {
      throw new Error('Ce versement ancien n’a pas d’identifiant de lot. Relance avec l’option depuis et l’heure du début du dernier versement (ex. 2026-11-06T10:15:00+01:00). Aucun retrait effectué.');
    }
    // Explicit operator boundary for historical credits; never guess by a time gap.
    selected = candidates.filter(tx => !tx.voteBatchId && voteMonth(tx) === voteMonth(newest) &&
      Date.parse(tx.timestamp) >= Date.parse(since));
    if (!selected.length) throw new Error('Aucun crédit de votes depuis cette date.');
  }
  if (new Set(selected.map(tx => tx.id)).size !== selected.length) {
    throw new Error('Identifiants de transactions ambigus : annulation bloquée.');
  }
  return { transactions: selected, batchId: newest.voteBatchId || null, legacy: !newest.voteBatchId };
}

function summarize(transactions) {
  const players = new Map();
  for (const tx of transactions) {
    const items = players.get(tx.playerId) || {};
    items[tx.itemTypeId] = (items[tx.itemTypeId] || 0) + tx.quantity;
    if (!Number.isSafeInteger(items[tx.itemTypeId])) throw new Error('Montant cumulé invalide.');
    players.set(tx.playerId, items);
  }
  return Object.fromEntries(players);
}

function createVoteRollbackService({ persistence, now = () => Date.now() }) {
  async function prepare({ actorId, guildId, month, since }) {
    if (!actorId || !guildId) throw new Error('Annulation réservée au serveur Discord.');
    return persistence.mutateInventory(state => {
      for (const [key, receipt] of Object.entries(state.receipts)) {
        if (key.startsWith('vote-rollback-plan:') && !receipt.completedAt && receipt.expiresAt < now()) {
          delete state.receipts[key];
        }
      }
      const selection = selectLatestVoteBatch(state.transactions, { month, since });
      // Do not skip a cancelled latest batch and silently select an older payment.
      if (selection.transactions.some(tx => state.receipts[reversalKey(tx.id)])) {
        throw new Error('Le dernier versement a déjà été annulé, en tout ou partie. Aucun versement plus ancien ne sera sélectionné.');
      }
      const id = randomUUID();
      const plan = {
        id, actorId, guildId, month, since, batchId: selection.batchId, legacy: selection.legacy,
        transactions: selection.transactions, fingerprint: fingerprint(selection.transactions),
        createdAt: now(), expiresAt: now() + 15 * 60 * 1000,
        summary: summarize(selection.transactions),
        startedAt: selection.transactions.reduce((min, tx) => Date.parse(tx.timestamp) < Date.parse(min) ? tx.timestamp : min, selection.transactions[0].timestamp),
        endedAt: selection.transactions[0].timestamp,
      };
      state.receipts[planKey(id)] = plan;
      return plan;
    });
  }

  async function confirm({ planId, actorId, guildId }) {
    return persistence.mutateInventory(state => {
      const plan = state.receipts[planKey(planId)];
      if (!plan) throw new Error('Aperçu introuvable. Relance la commande.');
      if (plan.actorId !== actorId || plan.guildId !== guildId) throw new Error('Seul l’auteur de cet aperçu peut le confirmer, sur le même serveur.');
      if (plan.completedAt) return { ...plan.result, alreadyApplied: true };
      if (now() > plan.expiresAt) throw new Error('Aperçu expiré après 15 minutes. Relance la commande.');
      const selection = selectLatestVoteBatch(state.transactions, plan);
      if (fingerprint(selection.transactions) !== plan.fingerprint) {
        throw new Error('Le versement a changé depuis l’aperçu. Relance la commande : aucun retrait effectué.');
      }
      if (plan.transactions.some(tx => state.receipts[reversalKey(tx.id)])) {
        throw new Error('Ces transactions ont déjà été annulées : aucun nouveau retrait.');
      }
      // Validate every balance before changing any. Never silently clamp a debit.
      for (const [playerId, items] of Object.entries(plan.summary)) {
        for (const [itemId, quantity] of Object.entries(items)) {
          const balance = state.inventories[playerId]?.[itemId] ?? 0;
          if (!Number.isSafeInteger(balance) || balance < quantity) {
            throw new Error(`Solde insuffisant ou invalide pour <@${playerId}> (${itemId}, ${quantity} nécessaires). Aucune récompense retirée.`);
          }
        }
      }
      const timestamp = new Date(now()).toISOString();
      for (const tx of plan.transactions) {
        const inventory = state.inventories[tx.playerId];
        if (tx.quantity > 0) {
          inventory[tx.itemTypeId] -= tx.quantity;
          if (inventory[tx.itemTypeId] === 0) delete inventory[tx.itemTypeId];
        }
        const reversal = {
          id: randomUUID(), type: 'remove', playerId: tx.playerId, itemTypeId: tx.itemTypeId,
          quantity: -tx.quantity, timestamp, adminId: actorId,
          reason: 'Annulation du dernier versement de votes',
          reversalOf: tx.id, voteRollbackPlanId: plan.id,
        };
        state.transactions.push(reversal);
        state.receipts[reversalKey(tx.id)] = { reversalId: reversal.id, planId: plan.id, timestamp };
      }
      trimHistory(state.transactions);
      // Original credits and their idempotency receipts remain intact.
      plan.completedAt = now();
      plan.result = { count: plan.transactions.length, players: Object.keys(plan.summary).length, alreadyApplied: false };
      // Keep compact durable audit/confirmation receipts, not duplicate history.
      delete plan.transactions;
      delete plan.summary;
      return plan.result;
    });
  }
  return { prepare, confirm };
}

module.exports = { createVoteRollbackService, selectLatestVoteBatch };
