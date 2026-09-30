const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createVoteRewardsService, getPreviousVotePeriod, buildCreditSummary, createPendingId,
  assertVoteRewardPeriod,
} = require('../voteRewards');

function fixture() {
  const balances = {};
  const receipts = {};
  const rows = {};
  let writes = 0;
  let failItem = null;
  const config = {
    DIAMONDS_PER_VOTE: 100, TOP_DIAMONDS: { 4: 4000, 5: 3000 },
    VOTE_PACK_IDS: {}, DINO_SHINY_ITEM_ID: 'shiny',
  };
  const packList = [
    { id: 'p1', name: 'Pack 1ère place vote', items: [{ itemId: 'fraises', quantity: 15000 }, { itemId: 'peinture', quantity: 6 }] },
    { id: 'p2', name: 'Pack 2ème place vote', items: [{ itemId: 'fraises', quantity: 10000 }] },
    { id: 'p3', name: 'Pack 3ème place vote', items: [{ itemId: 'fraises', quantity: 5000 }] },
  ];
  const inventory = {
    getItemTypes: () => ['diamants', 'fraises', 'peinture', 'shiny'].map(id => ({ id })),
    refreshInventoryCache: async () => {},
    getInventoryCreditReceipt: async key => receipts[key] || null,
    applyInventoryCredits: async (playerId, credits, adminId, reason, options) => {
      const keys = options.idempotencyKeys;
      const existing = keys.filter(key => receipts[key]);
      if (existing.length && existing.length !== keys.length) throw new Error('Conflit de crédits partiels');
      if (existing.length) {
        if (existing.some(key => receipts[key].playerId !== playerId)) throw new Error('Déjà attribué à un autre membre');
        if (options.idempotencyFingerprint && existing.some(key => receipts[key].fingerprint !== options.idempotencyFingerprint)) {
          throw new Error('Une autre décision a déjà été enregistrée');
        }
        return { ...receipts[existing[0]].result, alreadyApplied: true };
      }
      if (credits.some(item => item.itemTypeId === failItem)) throw new Error('Écriture base refusée');
      const player = balances[playerId] || (balances[playerId] = {});
      for (const item of credits) player[item.itemTypeId] = (player[item.itemTypeId] || 0) + item.quantity;
      writes++;
      const result = {
        transactions: credits.map(item => ({ ...item, playerId, adminId, reason })), alreadyApplied: false,
      };
      for (const key of keys) receipts[key] = { playerId, result, fingerprint: options.idempotencyFingerprint };
      return result;
    },
  };
  const pgStore = {
    isPostgres: () => true,
    getPool: () => ({ query: async (sql, params) => {
      if (!rows[params[0]]) rows[params[0]] = JSON.parse(params[1]);
      return { rowCount: 1 };
    } }),
    getData: async (key, fallback) => key === 'inventory_item_types' ? inventory.getItemTypes() : rows[key] || fallback,
  };
  const service = createVoteRewardsService({
    minimumRewardPeriod: '2026-09', // Isolated fixtures exercise the initial design, never live data.
    inventory, pgStore, settings: { refreshSettings: async () => {} },
    specialPacks: { getSpecialPacks: () => ({ packs: packList }), refreshSpecialPacks: async () => {} },
    getVotesConfig: () => config,
  });
  const input = {
    memberId: 'winner', playername: 'Test Winner', votes: 12, rankIdx: 1,
    votesConfig: config, monthName: 'SEPTEMBRE', periodKey: '2026-09',
  };
  return { service, config, balances, receipts, packList, input, rows,
    get writes() { return writes; }, fail: item => { failItem = item; } };
}

test('la période bascule à minuit Paris, pas à minuit UTC', () => {
  assert.equal(getPreviousVotePeriod(new Date('2026-09-30T21:59:59Z')).key, '2026-08');
  assert.equal(getPreviousVotePeriod(new Date('2026-09-30T22:00:00Z')).key, '2026-09');
  assert.equal(getPreviousVotePeriod(new Date('2026-12-31T23:00:00Z')).key, '2026-12');
  assert.equal(getPreviousVotePeriod(new Date('2027-01-31T23:00:00Z')).key, '2027-01');
});

test('activation après minuit : septembre est bloqué, octobre éligible', () => {
  assert.throws(() => assertVoteRewardPeriod('2026-09'), /ancien système/);
  assert.throws(() => assertVoteRewardPeriod('2026-00'), /invalide/);
  assert.doesNotThrow(() => assertVoteRewardPeriod('2026-10'));
  assert.equal(getPreviousVotePeriod(new Date('2026-10-31T23:00:00Z')).key, '2026-10');
});

test('les quatre chemins de crédit refusent un cycle historique sans accès aux données', async () => {
  let touched = false;
  const forbidden = () => { touched = true; throw new Error('Ne doit pas accéder à la base'); };
  const service = createVoteRewardsService({
    inventory: { applyInventoryCredits: forbidden, getInventoryCreditReceipt: forbidden },
    pgStore: { getPool: forbidden, getData: forbidden, isPostgres: forbidden },
  });
  await assert.rejects(service.creditVotePlayer({ periodKey: '2026-09' }), /ancien système/);
  await assert.rejects(service.creditPendingVote({ periodKey: '2026-09' }, 'winner', 'assign'), /ancien système/);
  await assert.rejects(service.creditShiny({ periodKey: '2026-09' }), /ancien système/);
  await assert.rejects(service.getOrCreateShinyWinner('2026-09', [{ playername: 'A' }]), /ancien système/);
  assert.equal(touched, false);
});

test('recherche par nom sans ID configuré : diamants et contenu du pack', async () => {
  const f = fixture();
  const result = await f.service.creditVotePlayer(f.input);
  assert.equal(result.status, 'success');
  assert.deepEqual(f.balances.winner, { diamants: 1200, fraises: 15000, peinture: 6 });
});

test('deux relances du même mois ne doublent aucun crédit', async () => {
  const f = fixture();
  await f.service.creditVotePlayer(f.input);
  const retry = await f.service.creditVotePlayer(f.input);
  assert.equal(retry.status, 'success');
  assert.equal(retry.alreadyApplied, true);
  assert.equal(f.writes, 2);
  assert.deepEqual(f.balances.winner, { diamants: 1200, fraises: 15000, peinture: 6 });
});

test('le mois suivant peut créditer le même joueur normalement', async () => {
  const f = fixture();
  await f.service.creditVotePlayer(f.input);
  await f.service.creditVotePlayer({ ...f.input, periodKey: '2026-10' });
  assert.equal(f.balances.winner.diamants, 2400);
  assert.equal(f.balances.winner.fraises, 30000);
});

test('pack absent : attribution partielle signalée, réparation sans doubler les diamants', async () => {
  const f = fixture();
  const pack = f.packList.shift();
  const first = await f.service.creditVotePlayer(f.input);
  assert.equal(first.status, 'partial');
  assert.match(first.errors[0], /Pack/);
  assert.deepEqual(f.balances.winner, { diamants: 1200 });
  f.packList.push(pack);
  const retry = await f.service.creditVotePlayer(f.input);
  assert.equal(retry.status, 'success');
  assert.deepEqual(f.balances.winner, { diamants: 1200, fraises: 15000, peinture: 6 });
});

test('un objet inconnu dans un pack ne devient pas un crédit invisible', async () => {
  const f = fixture();
  f.packList[0].items[1].itemId = 'objet-supprime';
  const result = await f.service.creditVotePlayer(f.input);
  assert.equal(result.status, 'partial');
  assert.deepEqual(f.balances.winner, { diamants: 1200 });
  assert.match(result.errors[0], /inconnu/);
});

test('échec pack : aucun contenu du pack partiellement écrit', async () => {
  const f = fixture();
  f.fail('peinture');
  const result = await f.service.creditVotePlayer(f.input);
  assert.equal(result.status, 'partial');
  assert.deepEqual(f.balances.winner, { diamants: 1200 });
  f.fail(null);
  await f.service.creditVotePlayer(f.input);
  assert.deepEqual(f.balances.winner, { diamants: 1200, fraises: 15000, peinture: 6 });
});

test('les bonus des places 4 et 5 restent appliqués sans pack facultatif', async () => {
  const f = fixture();
  const result = await f.service.creditVotePlayer({ ...f.input, rankIdx: 4 });
  assert.equal(result.status, 'success');
  assert.equal(f.balances.winner.diamants, 5200);
});

test('un joueur attribué manuellement reçoit aussi son pack', async () => {
  const f = fixture();
  const result = await f.service.creditPendingVote({
    ...f.input, type: 'notfound', votesConfig: f.config,
  }, 'winner', 'assign');
  assert.equal(result.status, 'success');
  assert.deepEqual(f.balances.winner, { diamants: 1200, fraises: 15000, peinture: 6 });
});

test('fusion des doublons : un pack au meilleur rang et une décision unique', async () => {
  const f = fixture();
  const pending = {
    type: 'duplicate', periodKey: '2026-09', monthName: 'SEPTEMBRE', votesConfig: f.config,
    entries: [
      { playername: 'Test Winner', votes: 12, rankIdx: 1 },
      { playername: 'Autre pseudo', votes: 8, rankIdx: 2 },
    ],
  };
  const first = await f.service.creditPendingVote(pending, 'winner', 'merge');
  assert.equal(first.status, 'success');
  assert.deepEqual(f.balances.winner, { diamants: 2000, fraises: 15000, peinture: 6 });
  const retry = await f.service.creditPendingVote(pending, 'winner', 'merge');
  assert.equal(retry.alreadyApplied, true);
  const conflict = await f.service.creditPendingVote(pending, 'winner', 'all');
  assert.equal(conflict.status, 'failed');
  assert.match(conflict.errors[0], /autre décision/);
  assert.equal(f.balances.winner.diamants, 2000);
  await f.service.creditVotePlayer(f.input);
  assert.equal(f.balances.winner.diamants, 2000);
});

test('un reçu ne permet pas de recréditer la récompense à un autre membre', async () => {
  const f = fixture();
  await f.service.creditVotePlayer(f.input);
  const result = await f.service.creditVotePlayer({ ...f.input, memberId: 'other' });
  assert.equal(result.status, 'failed');
  assert.equal(f.balances.other, undefined);
});

test('un ancien bouton doublon ne peut pas créditer une entrée ignorée ensuite', async () => {
  const f = fixture();
  const entries = [
    { playername: 'Test Winner', votes: 12, rankIdx: 1 },
    { playername: 'Autre pseudo', votes: 8, rankIdx: 2 },
  ];
  f.rows.vote_pending_distributions = {
    [createPendingId('notfound', '2026-09', ['Test Winner'])]: {
      resolved: true, decision: 'ignore', creditResult: { status: 'ignored' },
    },
  };
  const pending = { type: 'duplicate', periodKey: '2026-09', monthName: 'SEPTEMBRE', votesConfig: f.config, entries };
  for (const mode of ['merge', 'all', 'keep']) {
    const result = await f.service.creditPendingVote(pending, 'winner', mode, 0);
    assert.equal(result.status, 'failed');
    assert.match(result.errors[0], /déjà une décision admin/);
  }
  assert.equal(f.writes, 0);
});

test('tirage Shiny persistant et crédit unique même après relance', async () => {
  const f = fixture();
  const participants = [{ playername: 'A' }, { playername: 'B' }];
  const winner = await f.service.getOrCreateShinyWinner('2026-09', participants);
  assert.deepEqual(await f.service.getOrCreateShinyWinner('2026-09', participants), winner);
  const input = { periodKey: '2026-09', memberId: 'winner', itemId: 'shiny', monthName: 'SEPTEMBRE' };
  await f.service.creditShiny(input);
  const retry = await f.service.creditShiny(input);
  assert.equal(retry.alreadyApplied, true);
  assert.equal(f.balances.winner.shiny, 1);
  const changedConfig = await f.service.creditShiny({ ...input, itemId: 'item-deleted' });
  assert.deepEqual(changedConfig.credits, [{ itemTypeId: 'shiny', quantity: 1 }]);
});

test('Shiny mal configuré ou gagnant inconnu : échec explicite, aucun crédit', async () => {
  const f = fixture();
  await assert.rejects(f.service.creditShiny({ ...f.input, itemId: '' }), /configuré/);
  await assert.rejects(f.service.creditShiny({ ...f.input, itemId: 'shiny', memberId: null }), /identifié/);
  assert.equal(f.writes, 0);
});

test('la simulation ne crée ni crédit ni reçu ni tirage', () => {
  const f = fixture();
  const result = f.service.simulateVoteDistribution(
    [{ playername: 'A', votes: 12 }, { playername: 'B', votes: 10 }, { playername: 'C', votes: 8 }],
    {}, f.config, (_, name) => name === 'C' ? null : 'duplicate'
  );
  assert.equal(result.players.length, 3);
  assert.equal(result.players[0].status, 'pending');
  assert.equal(result.players[2].memberId, null);
  assert.equal(f.writes, 0);
  assert.deepEqual(f.receipts, {});
  assert.deepEqual(f.rows, {});
});

test('un état de décisions corrompu bloque la restauration au lieu de paraître vide', async () => {
  const f = fixture();
  f.rows.vote_pending_distributions = [];
  await assert.rejects(f.service.loadPending(), /distribution bloquée/);
  assert.equal(f.writes, 0);
});

test('le résumé public distingue succès, échecs et attente', () => {
  const summary = buildCreditSummary({ success: 3, partial: 1, failed: 2, pendingNotFound: 4, pendingDuplicates: 1 });
  assert.match(summary, /3 joueur/);
  assert.match(summary, /1 attribution.*partielle/);
  assert.match(summary, /2 échec/);
  assert.match(summary, /5 demande/);
});