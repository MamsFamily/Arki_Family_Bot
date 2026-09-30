const crypto = require('crypto');
const pgStore = require('./pgStore');
const inventory = require('./inventoryManager');
const settings = require('./settingsManager');
const specialPacks = require('./specialPacksManager');
const { getVotesConfig } = require('./votesConfig');

function normalize(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function getPreviousVotePeriod(date = new Date()) {
  const parts = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', year: 'numeric', month: 'numeric',
  }).formatToParts(date);
  const currentMonth = Number(parts.find(p => p.type === 'month').value);
  const currentYear = Number(parts.find(p => p.type === 'year').value);
  const month = currentMonth === 1 ? 12 : currentMonth - 1;
  const year = currentMonth === 1 ? currentYear - 1 : currentYear;
  return { year, month, monthIndex: month - 1, key: `${year}-${String(month).padStart(2, '0')}` };
}

function playerKey(periodKey, playername) {
  if (!/^\d{4}-\d{2}$/.test(periodKey || '')) throw new Error('Période de votes invalide.');
  // Preserve distinct TopServeurs entries (punctuation/case can be meaningful).
  const digest = crypto.createHash('sha256').update(String(playername)).digest('hex');
  return `votes:${periodKey}:${digest}`;
}

function createPendingId(type, periodKey, names) {
  const digest = crypto.createHash('sha256').update(JSON.stringify([...names].sort())).digest('hex').slice(0, 24);
  return `${type}_${periodKey}_${digest}`;
}

function createVoteRewardsService(dependencies = {}) {
  const store = dependencies.pgStore || pgStore;
  const inv = dependencies.inventory || inventory;
  const packs = dependencies.specialPacks || specialPacks;
  const configSource = dependencies.getVotesConfig || getVotesConfig;
  const settingsSource = dependencies.settings || settings;

  async function refreshVoteSources() {
    if (!store.isPostgres()) throw new Error('La distribution mensuelle nécessite la base PostgreSQL du bot.');
    await settingsSource.refreshSettings();
    await packs.refreshSpecialPacks();
    // Validate reads explicitly; no stale/local fallback for a monthly distribution.
    const types = await store.getData('inventory_item_types', null, { throwOnError: true });
    if (!Array.isArray(types)) throw new Error('Catalogue des objets inventaire indisponible.');
    await inv.refreshInventoryCache({ throwOnError: true });
  }

  function validateItems(credits) {
    const ids = new Set(inv.getItemTypes().map(item => item.id));
    for (const credit of credits) {
      if (!ids.has(credit.itemTypeId)) throw new Error(`Objet inventaire inconnu : ${credit.itemTypeId}`);
      if (!Number.isSafeInteger(credit.quantity) || credit.quantity < 0) {
        throw new Error(`Quantité invalide pour ${credit.itemTypeId}`);
      }
    }
    return credits;
  }

  function findPack(rankIdx, config) {
    const list = packs.getSpecialPacks().packs || [];
    const configuredId = (config.VOTE_PACK_IDS || {})[rankIdx];
    const configured = configuredId && list.find(pack => pack.id === configuredId);
    if (configured) return configured;
    const ordinal = rankIdx === 1 ? '1ere' : `${rankIdx}eme`;
    const names = new Set([
      `pack ${ordinal} place vote`, `pack vote ${ordinal} place`,
      `pack vote ${ordinal}`, ...(rankIdx === 1 ? ['pack 1er place vote', 'pack vote premiere place'] : []),
    ]);
    const matches = list.filter(pack => names.has(normalize(pack.name)));
    if (matches.length > 1) throw new Error(`Plusieurs packs correspondent à la place ${rankIdx}. Sélectionnez un ID.`);
    if (matches.length === 1) return matches[0];
    if (configuredId || rankIdx <= 3) throw new Error(`Pack vote de la place ${rankIdx} introuvable ou non configuré.`);
    return null;
  }

  function packCredits(rankIdx, config) {
    if (rankIdx < 1 || rankIdx > 5) return [];
    const pack = findPack(rankIdx, config);
    if (!pack) return [];
    if (!Array.isArray(pack.items) || pack.items.length === 0) {
      // Raw pack IDs may only be credited if they are visible inventory objects.
      return validateItems([{ itemTypeId: pack.id, quantity: 1 }]);
    }
    return validateItems(pack.items.map(item => ({
      itemTypeId: item.itemId, quantity: Number(item.quantity),
    })));
  }

  function baseCredits(votes, rankIdx, config) {
    const perVote = Number(config.DIAMONDS_PER_VOTE);
    const bonus = Number((config.TOP_DIAMONDS || {})[rankIdx] || 0);
    if (!Number.isSafeInteger(votes) || votes < 0 || !Number.isSafeInteger(perVote) || perVote <= 0 ||
        !Number.isSafeInteger(bonus) || bonus < 0) throw new Error('Montant de récompense votes invalide.');
    return validateItems([{ itemTypeId: 'diamants', quantity: votes * perVote + bonus }]);
  }

  async function applyComponent(memberId, credits, keys, reason, idempotencyFingerprint) {
    const result = await inv.applyInventoryCredits(memberId, credits, 'system', reason, {
      idempotencyKeys: keys, ...(idempotencyFingerprint ? { idempotencyFingerprint } : {}),
    });
    return {
      credits: result.transactions.map(tx => ({ itemTypeId: tx.itemTypeId, quantity: tx.quantity })),
      alreadyApplied: result.alreadyApplied,
    };
  }

  async function creditVotePlayer({ memberId, playername, votes, rankIdx, votesConfig, monthName, periodKey }) {
    const key = playerKey(periodKey, playername);
    const credits = [];
    const errors = [];
    let anySucceeded = false;
    let alreadyApplied = true;
    try {
      const result = await applyComponent(memberId, baseCredits(votes, rankIdx, votesConfig), [`${key}:base`], `Votes ${monthName}`);
      credits.push(...result.credits);
      anySucceeded = true;
      alreadyApplied &&= result.alreadyApplied;
    } catch (error) {
      errors.push(`Diamants : ${error.message}`);
    }
    try {
      // A persisted receipt is authoritative if the pack changed since the first credit.
      const receipt = await inv.getInventoryCreditReceipt(`${key}:pack`);
      if (receipt) {
        if (receipt.playerId !== memberId) throw new Error('Ce pack a déjà été attribué à un autre membre.');
        credits.push(...receipt.result.transactions.map(tx => ({ itemTypeId: tx.itemTypeId, quantity: tx.quantity })));
        anySucceeded = true;
      } else {
        const items = packCredits(rankIdx, votesConfig);
        if (items.length) {
          const result = await applyComponent(memberId, items, [`${key}:pack`], `Pack vote place ${rankIdx} — Votes ${monthName}`);
          credits.push(...result.credits);
          anySucceeded = true;
          alreadyApplied &&= result.alreadyApplied;
        }
      }
    } catch (error) {
      errors.push(`Pack : ${error.message}`);
    }
    return { status: errors.length ? (anySucceeded ? 'partial' : 'failed') : 'success', credits, errors, alreadyApplied };
  }

  async function creditPendingVote(pending, memberId, mode, choiceIdx) {
    const config = pending.votesConfig || configSource();
    const entries = pending.type === 'duplicate' ? pending.entries : [{
      playername: pending.playername, votes: pending.votes, rankIdx: pending.rankIdx,
    }];
    if (!entries?.length) throw new Error('Demande de votes invalide.');
    let chosen;
    if (mode === 'keep') {
      if (!Number.isInteger(choiceIdx) || !entries[choiceIdx]) throw new Error('Entrée choisie invalide.');
      chosen = [entries[choiceIdx]];
    } else if (mode === 'merge') {
      const best = entries.reduce((a, b) => a.rankIdx < b.rankIdx ? a : b);
      chosen = [{ ...best, votes: entries.reduce((sum, entry) => sum + entry.votes, 0) }];
    } else if (mode === 'all' || mode === 'assign') {
      chosen = entries;
    } else {
      throw new Error('Décision de votes invalide.');
    }
    const keys = entries.flatMap(entry => {
      const key = playerKey(pending.periodKey, entry.playername);
      return [`${key}:base`, `${key}:pack`];
    });
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
      mode, choiceIdx: mode === 'keep' ? choiceIdx : null, memberId,
      entries: entries.map(entry => entry.playername),
    })).digest('hex');
    try {
      const existing = await Promise.all(keys.map(key => inv.getInventoryCreditReceipt(key)));
      if (existing.every(Boolean)) {
        if (existing.some(receipt => receipt.playerId !== memberId || receipt.fingerprint !== fingerprint)) {
          throw new Error('Une autre décision a déjà été enregistrée pour ces récompenses.');
        }
        return {
          status: 'success', alreadyApplied: true, errors: [],
          credits: existing[0].result.transactions.map(tx => ({ itemTypeId: tx.itemTypeId, quantity: tx.quantity })),
        };
      }
      if (pending.type === 'duplicate') {
        const decisions = await loadPending();
        for (const entry of entries) {
          const prior = decisions[createPendingId('notfound', pending.periodKey, [entry.playername])];
          if (prior && (prior.resolved || prior.creditResult?.status === 'success' || prior.creditResult?.status === 'ignored')) {
            throw new Error(`L’entrée "${entry.playername}" a déjà une décision admin. Ce doublon doit être réexaminé.`);
          }
        }
      }
      const credits = chosen.flatMap(entry => [
        ...baseCredits(entry.votes, entry.rankIdx, config), ...packCredits(entry.rankIdx, config),
      ]);
      const result = await applyComponent(memberId, credits, keys, `Votes ${pending.monthName} (${mode})`, fingerprint);
      return { ...result, errors: [], status: 'success' };
    } catch (error) {
      return { status: 'failed', credits: [], errors: [error.message], alreadyApplied: false };
    }
  }

  async function getOrCreateShinyWinner(periodKey, top10) {
    playerKey(periodKey, 'shiny');
    if (!store.isPostgres()) throw new Error('Le tirage persistant nécessite PostgreSQL.');
    if (!top10.length) throw new Error('Aucun participant au tirage.');
    const selected = Math.floor(Math.random() * top10.length);
    const candidate = { playername: top10[selected].playername, index: selected };
    const key = `vote_shiny_winner:${periodKey}`;
    await store.getPool().query(
      'INSERT INTO app_data (key, value, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (key) DO NOTHING',
      [key, JSON.stringify(candidate)]
    );
    const winner = await store.getData(key, null, { throwOnError: true });
    if (!winner?.playername) throw new Error('Tirage non enregistré en base.');
    const index = top10.findIndex(player => player.playername === winner.playername);
    if (index < 0) throw new Error('Le gagnant enregistré ne figure plus dans le classement : contrôle admin nécessaire.');
    return { playername: winner.playername, index };
  }

  async function creditShiny({ periodKey, memberId, itemId, monthName }) {
    playerKey(periodKey, 'shiny');
    if (!memberId) throw new Error('Le gagnant Shiny n’est pas identifié sur Discord.');
    const receipt = await inv.getInventoryCreditReceipt(`votes:${periodKey}:shiny`);
    if (receipt) {
      if (receipt.playerId !== memberId) throw new Error('Le Dino Shiny a déjà été crédité à un autre gagnant.');
      return {
        alreadyApplied: true,
        credits: receipt.result.transactions.map(tx => ({ itemTypeId: tx.itemTypeId, quantity: tx.quantity })),
      };
    }
    if (!itemId) throw new Error('Aucun objet Dino Shiny configuré.');
    return applyComponent(memberId, validateItems([{ itemTypeId: itemId, quantity: 1 }]),
      [`votes:${periodKey}:shiny`], `Dino Shiny — Tirage votes ${monthName}`);
  }

  async function persistPending(id, pending) {
    if (!store.isPostgres()) throw new Error('Les demandes votes nécessitent PostgreSQL.');
    await store.getPool().query(
      `INSERT INTO app_data (key, value, updated_at) VALUES ('vote_pending_distributions', jsonb_build_object($1::text, $2::jsonb), NOW())
       ON CONFLICT (key) DO UPDATE SET value =
         CASE WHEN (app_data.value -> $1::text ->> 'resolved') = 'true'
           THEN app_data.value
           ELSE jsonb_set(app_data.value, ARRAY[$1::text], $2::jsonb) END,
         updated_at = NOW()`,
      [id, JSON.stringify({ ...pending, resolving: false, distributing: false })]
    );
  }

  async function loadPending() {
    if (!store.isPostgres()) return {};
    const pending = await store.getData('vote_pending_distributions', {}, { throwOnError: true }) ?? {};
    if (typeof pending !== 'object' || Array.isArray(pending) ||
        Object.values(pending).some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
      throw new Error('État des décisions votes invalide : distribution bloquée.');
    }
    return Object.fromEntries(Object.entries(pending).map(([id, entry]) => [
      id, { ...entry, resolving: false, distributing: false },
    ]));
  }

  function simulateVoteDistribution(ranking, memberIndex, config, resolvePlayer) {
    const resolver = resolvePlayer || require('./votesUtils').resolvePlayer;
    const resolved = ranking.map(player => resolver(memberIndex, player.playername));
    const errors = [];
    const players = ranking.map((player, index) => {
      const memberId = resolved[index];
      const rankIdx = index + 1;
      const issues = [];
      let credits = [];
      if (!memberId) issues.push('Membre Discord non identifié.');
      else if (resolved.filter(id => id === memberId).length > 1) issues.push('Doublon : validation admin nécessaire.');
      try { credits.push(...baseCredits(player.votes, rankIdx, config)); } catch (error) { issues.push(error.message); }
      try { credits.push(...packCredits(rankIdx, config)); } catch (error) { issues.push(error.message); }
      return { playername: player.playername, rankIdx, memberId, credits, status: issues.length ? 'pending' : 'ready', errors: issues };
    });
    if (!config.DINO_SHINY_ITEM_ID) errors.push('Aucun objet Dino Shiny configuré.');
    else {
      try { validateItems([{ itemTypeId: config.DINO_SHINY_ITEM_ID, quantity: 1 }]); } catch (error) { errors.push(error.message); }
    }
    return { players, errors };
  }

  return { refreshVoteSources, creditVotePlayer, creditPendingVote, getOrCreateShinyWinner,
    creditShiny, persistPending, loadPending, simulateVoteDistribution };
}

function buildCreditSummary(results) {
  const pending = (results.pendingDuplicates || 0) + (results.pendingNotFound || 0);
  let text = `${results.success || 0} joueur(s) : récompenses enregistrées en inventaire.`;
  if (results.partial) text += ` ${results.partial} attribution(s) partielle(s).`;
  if (results.failed) text += ` ${results.failed} échec(s).`;
  if (results.ignored) text += ` ${results.ignored} entrée(s) ignorée(s) par décision admin.`;
  if (pending) text += ` ${pending} demande(s) attendent une validation admin.`;
  return text;
}

module.exports = { ...createVoteRewardsService(), createVoteRewardsService, getPreviousVotePeriod,
  createPendingId, playerKey, buildCreditSummary };